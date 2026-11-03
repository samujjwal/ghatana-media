package com.ghatana.audio.video.vision.video;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Durable bounded replay state for authenticated Media OCI broker requests.
 * The journal stores nonce digests, request timestamps and an authenticated wall-clock
 * high-water mark. It never evicts a nonce that can still pass the broker timestamp check.
 */
final class MediaOciBrokerNonceJournal implements AutoCloseable {

    private static final byte[] MAGIC = "GHMNONC1".getBytes(StandardCharsets.US_ASCII);
    private static final int VERSION = 2;
    private static final int HEADER_PREFIX_BYTES = MAGIC.length + Integer.BYTES + Long.BYTES;
    private static final int HEADER_BYTES = HEADER_PREFIX_BYTES + 32;
    private static final int RECORD_PREFIX_CHARS = 16 + 16 + 64;
    private static final int RECORD_BYTES = RECORD_PREFIX_CHARS + 64 + 1;
    private static final String DATA_FILE_NAME = "media-oci-nonce-replay.v1";
    private static final String LOCK_FILE_NAME = "media-oci-nonce-replay.lock";
    private static final Set<PosixFilePermission> DIRECTORY_PERMISSIONS =
            PosixFilePermissions.fromString("rwx------");
    private static final Set<PosixFilePermission> FILE_PERMISSIONS =
            PosixFilePermissions.fromString("rw-------");

    private final Path stateDirectory;
    private final Path dataFile;
    private final Path lockFile;
    private final byte[] key;
    private final String owner;
    private final int maxEntries;
    private final int compactAtRecords;
    private final long maxFileBytes;
    private final LinkedHashMap<String, Entry> seen = new LinkedHashMap<>();
    private final Set<String> activeDigests = new HashSet<>();
    private final Set<String> expiredPending = new HashSet<>();
    private final PriorityQueue<Entry> expiryQueue = new PriorityQueue<>(
            java.util.Comparator.comparingLong(entry -> expiry(entry.timestampMs())));

    private FileChannel lockChannel;
    private FileLock fileLock;
    private FileChannel journalChannel;
    private long recordCount;
    private long clockHighWaterMs;
    private boolean closed;
    private boolean failed;

    private MediaOciBrokerNonceJournal(
            Path stateDirectory, String token, int maxEntries, int compactAtRecords) throws IOException {
        this.stateDirectory = stateDirectory;
        this.dataFile = stateDirectory.resolve(DATA_FILE_NAME);
        this.lockFile = stateDirectory.resolve(LOCK_FILE_NAME);
        this.key = token.getBytes(StandardCharsets.UTF_8);
        this.owner = Files.getOwner(stateDirectory, LinkOption.NOFOLLOW_LINKS).getName();
        this.maxEntries = maxEntries;
        this.compactAtRecords = compactAtRecords;
        this.maxFileBytes = HEADER_BYTES + (long) (compactAtRecords + 1) * RECORD_BYTES;
        try {
            acquireLock();
            openJournal();
            loadJournal();
            long now = System.currentTimeMillis();
            ensureClockNotRegressed(now);
            clockHighWaterMs = Math.max(clockHighWaterMs, now);
            expireActive(now);
        } catch (IOException | RuntimeException failureDuringOpen) {
            closeQuietly();
            if (failureDuringOpen instanceof IOException ioFailure) throw ioFailure;
            throw new IOException("Broker nonce replay journal is invalid", failureDuringOpen);
        }
    }

    static Path validateStateDirectory(
            Path configured,
            String brokerOsUser,
            String allowedPeerUser,
            Path sourceRoot,
            Path outputRoot,
            Path stageRoot) throws IOException {
        if (configured == null || Files.isSymbolicLink(configured)
                || !Files.isDirectory(configured, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Broker nonce state directory must be an existing non-symlink directory");
        }
        Path state = configured.toRealPath(LinkOption.NOFOLLOW_LINKS);
        String owner = Files.getOwner(state, LinkOption.NOFOLLOW_LINKS).getName();
        if (!owner.equals(brokerOsUser)) {
            throw new IOException("Broker nonce state directory must be owned by the broker OS identity");
        }
        try {
            if (!Files.getPosixFilePermissions(state, LinkOption.NOFOLLOW_LINKS)
                    .equals(DIRECTORY_PERMISSIONS)) {
                throw new IOException("Broker nonce state directory must have 0700 permissions");
            }
        } catch (UnsupportedOperationException unsupported) {
            throw new IOException("Broker nonce state directory requires POSIX owner-only permissions", unsupported);
        }
        if (allowedPeerUser != null && owner.equals(allowedPeerUser)) {
            throw new IOException("Broker nonce state directory must not be writable by the allowed Media peer");
        }
        if (overlaps(state, sourceRoot) || overlaps(state, outputRoot) || overlaps(state, stageRoot)) {
            throw new IOException("Broker nonce state directory must be separate from source, output and stage roots");
        }
        return state;
    }

    static MediaOciBrokerNonceJournal open(Path stateDirectory, String token) throws IOException {
        return open(stateDirectory, token, MediaOciBrokerPolicy.MAX_NONCE_CACHE);
    }

    /** Smaller bounded capacity is used by deterministic package tests. */
    static MediaOciBrokerNonceJournal open(Path stateDirectory, String token, int maxEntries) throws IOException {
        return open(stateDirectory, token, maxEntries, Math.multiplyExact(maxEntries, 2));
    }

    /** Smaller bounds are used by deterministic package tests. */
    static MediaOciBrokerNonceJournal open(
            Path stateDirectory, String token, int maxEntries, int compactAtRecords) throws IOException {
        if (token == null || token.getBytes(StandardCharsets.UTF_8).length < 32) {
            throw new IOException("Broker nonce journal requires at least 32 bytes of token material");
        }
        if (maxEntries < 1 || maxEntries > MediaOciBrokerPolicy.MAX_NONCE_CACHE
                || compactAtRecords < 1 || compactAtRecords > MediaOciBrokerPolicy.MAX_NONCE_CACHE * 2) {
            throw new IOException("Broker nonce journal capacity is outside its configured bound");
        }
        Path canonical = validateStateDirectory(stateDirectory,
                Files.getOwner(stateDirectory, LinkOption.NOFOLLOW_LINKS).getName(), null,
                null, null, null);
        return new MediaOciBrokerNonceJournal(canonical, token, maxEntries, compactAtRecords);
    }

    static MediaOciBrokerNonceJournal open(
            Path stateDirectory, String token, String brokerOsUser, String allowedPeerUser,
            Path sourceRoot, Path outputRoot, Path stageRoot) throws IOException {
        if (token == null || token.getBytes(StandardCharsets.UTF_8).length < 32) {
            throw new IOException("Broker nonce journal requires at least 32 bytes of token material");
        }
        Path canonical = validateStateDirectory(stateDirectory, brokerOsUser, allowedPeerUser,
                sourceRoot, outputRoot, stageRoot);
        return new MediaOciBrokerNonceJournal(canonical, token, MediaOciBrokerPolicy.MAX_NONCE_CACHE,
                MediaOciBrokerPolicy.MAX_NONCE_CACHE * 2);
    }

    synchronized boolean reserve(String nonce, long timestampMs, long now) throws IOException {
        ensureOpen();
        if (nonce == null || nonce.length() < 16 || nonce.length() > 128
                || timestampMs < 0 || now < 0) return false;
        long skew = absoluteDifference(timestampMs, now);
        if (skew > MediaOciBrokerPolicy.MAX_REQUEST_SKEW_MS) return false;
        ensureClockNotRegressed(now);
        clockHighWaterMs = now;
        expireActive(now);

        String digest = nonceDigest(nonce);
        if (seen.containsKey(digest)) return false;
        if (activeDigests.size() >= maxEntries) return false;

        // Compact before appending at the file bound, but retain every digest. A later
        // compaction may prune expired entries only after this request durably advances
        // the authenticated clock floor.
        if (recordCount >= compactAtRecords) compact();
        byte[] record = encodeRecord(timestampMs, now, digest);
        try {
            journalChannel.position(journalChannel.size());
            writeFully(journalChannel, ByteBuffer.wrap(record));
            journalChannel.force(true);
            Entry admitted = new Entry(timestampMs, now, digest);
            seen.put(digest, admitted);
            activeDigests.add(digest);
            expiryQueue.add(admitted);
            recordCount++;
            boolean expiredEntriesRemoved = !expiredPending.isEmpty();
            expiredPending.forEach(seen::remove);
            expiredPending.clear();
            if (expiredEntriesRemoved || recordCount >= compactAtRecords) compact();
            return true;
        } catch (IOException persistenceFailure) {
            failed = true;
            throw new IOException("Broker nonce replay state could not be persisted", persistenceFailure);
        }
    }

    private void acquireLock() throws IOException {
        ensurePrivateFileExists(lockFile);
        lockChannel = FileChannel.open(lockFile, StandardOpenOption.READ, StandardOpenOption.WRITE,
                LinkOption.NOFOLLOW_LINKS);
        try {
            fileLock = lockChannel.tryLock();
        } catch (OverlappingFileLockException alreadyOpen) {
            closeLockChannelQuietly();
            throw new IOException("Another broker process owns the nonce replay journal", alreadyOpen);
        } catch (IOException lockFailure) {
            closeLockChannelQuietly();
            throw lockFailure;
        }
        if (fileLock == null) {
            closeLockChannelQuietly();
            throw new IOException("Another broker process owns the nonce replay journal");
        }
    }

    private void openJournal() throws IOException {
        ensurePrivateFileExists(dataFile);
        journalChannel = FileChannel.open(dataFile, StandardOpenOption.READ, StandardOpenOption.WRITE,
                LinkOption.NOFOLLOW_LINKS);
    }

    private void loadJournal() throws IOException {
        long size = journalChannel.size();
        if (size == 0) {
            writeFully(journalChannel, ByteBuffer.wrap(header(0)));
            journalChannel.force(true);
            forceDirectory();
            return;
        }
        if (size < HEADER_BYTES || size > maxFileBytes) {
            throw new IOException("Broker nonce replay journal is outside its size bound");
        }
        byte[] bytes = Files.readAllBytes(dataFile);
        ByteBuffer input = ByteBuffer.wrap(bytes);
        byte[] headerPrefix = new byte[HEADER_PREFIX_BYTES];
        byte[] storedHeaderMac = new byte[32];
        input.get(headerPrefix);
        input.get(storedHeaderMac);
        ByteBuffer headerFields = ByteBuffer.wrap(headerPrefix);
        byte[] magic = new byte[MAGIC.length];
        headerFields.get(magic);
        long headerClockFloor = headerFields.getLong(MAGIC.length + Integer.BYTES);
        int version = headerFields.getInt(MAGIC.length);
        if (!MessageDigest.isEqual(magic, MAGIC) || version != VERSION || headerClockFloor < 0
                || !MessageDigest.isEqual(storedHeaderMac, hmac(headerPrefix))) {
            throw new IOException("Broker nonce replay journal header integrity check failed");
        }
        clockHighWaterMs = headerClockFloor;

        int completeBytes = input.remaining() - (input.remaining() % RECORD_BYTES);
        int trailingBytes = input.remaining() - completeBytes;
        if (input.remaining() - trailingBytes > maxFileBytes - HEADER_BYTES) {
            throw new IOException("Broker nonce replay journal exceeds its record bound");
        }
        long lastRecordClock = 0;
        while (input.position() < HEADER_BYTES + completeBytes) {
            byte[] record = new byte[RECORD_BYTES];
            input.get(record);
            Entry entry = decodeRecord(record);
            if (entry.observedAtMs() < lastRecordClock) {
                throw new IOException("Broker nonce replay journal clock sequence regressed");
            }
            lastRecordClock = entry.observedAtMs();
            if (seen.putIfAbsent(entry.digestHex(), entry) != null) {
                throw new IOException("Broker nonce replay journal contains a duplicate nonce digest");
            }
            activeDigests.add(entry.digestHex());
            expiryQueue.add(entry);
            clockHighWaterMs = Math.max(clockHighWaterMs, entry.observedAtMs());
            recordCount++;
        }
        if (trailingBytes > 0) {
            // A request is only admitted after a full record has been forced. A torn
            // final append therefore cannot represent an admitted nonce; drop only its
            // incomplete suffix. Complete malformed records remain fatal above.
            journalChannel.truncate(HEADER_BYTES + completeBytes);
            journalChannel.force(true);
        }
        journalChannel.position(journalChannel.size());
    }

    private Entry decodeRecord(byte[] record) throws IOException {
        String line = new String(record, StandardCharsets.US_ASCII);
        if (line.length() != RECORD_BYTES || line.charAt(RECORD_BYTES - 1) != '\n') {
            throw new IOException("Broker nonce replay record framing is invalid");
        }
        String prefix = line.substring(0, RECORD_PREFIX_CHARS);
        String macHex = line.substring(RECORD_PREFIX_CHARS, RECORD_PREFIX_CHARS + 64);
        try {
            long timestamp = Long.parseLong(prefix.substring(0, 16), 16);
            long observedAt = Long.parseLong(prefix.substring(16, 32), 16);
            byte[] digest = HexFormat.of().parseHex(prefix.substring(32));
            byte[] expectedMac = HexFormat.of().parseHex(macHex);
            byte[] actualMac = hmac(prefix.getBytes(StandardCharsets.US_ASCII));
            if (timestamp < 0 || observedAt < 0 || digest.length != 32 || expectedMac.length != 32
                    || absoluteDifference(timestamp, observedAt) > MediaOciBrokerPolicy.MAX_REQUEST_SKEW_MS
                    || !MessageDigest.isEqual(expectedMac, actualMac)) {
                throw new IOException("Broker nonce replay record integrity check failed");
            }
            return new Entry(timestamp, observedAt, HexFormat.of().formatHex(digest));
        } catch (IllegalArgumentException malformed) {
            throw new IOException("Broker nonce replay record is malformed", malformed);
        }
    }

    private byte[] encodeRecord(long timestampMs, long observedAtMs, String digestHex) throws IOException {
        String timestampHex = fixedHex(timestampMs);
        String observedHex = fixedHex(observedAtMs);
        String prefix = timestampHex + observedHex + digestHex;
        byte[] signature = hmac(prefix.getBytes(StandardCharsets.US_ASCII));
        byte[] record = (prefix + HexFormat.of().formatHex(signature) + "\n")
                .getBytes(StandardCharsets.US_ASCII);
        if (record.length != RECORD_BYTES) throw new IOException("Broker nonce record length is invalid");
        return record;
    }

    private void compact() throws IOException {
        ensureOpen();
        Path temporary = null;
        try {
            temporary = Files.createTempFile(stateDirectory, ".media-oci-nonce-replay-", ".tmp",
                    PosixFilePermissions.asFileAttribute(FILE_PERMISSIONS));
            try (FileChannel output = FileChannel.open(temporary,
                    StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING, LinkOption.NOFOLLOW_LINKS)) {
                writeFully(output, ByteBuffer.wrap(header(clockHighWaterMs)));
                for (Entry entry : seen.values()) {
                    writeFully(output, ByteBuffer.wrap(
                            encodeRecord(entry.timestampMs(), entry.observedAtMs(), entry.digestHex())));
                }
                output.force(true);
            }
            journalChannel.close();
            journalChannel = null;
            try {
                Files.move(temporary, dataFile, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException unsupported) {
                throw new IOException("Broker nonce replay journal requires atomic compaction", unsupported);
            }
            temporary = null;
            forceDirectory();
            verifyPrivateFile(dataFile);
            journalChannel = FileChannel.open(dataFile, StandardOpenOption.READ, StandardOpenOption.WRITE,
                    LinkOption.NOFOLLOW_LINKS);
            journalChannel.position(journalChannel.size());
            recordCount = seen.size();
        } catch (IOException compactionFailure) {
            failed = true;
            throw new IOException("Broker nonce replay state could not be compacted", compactionFailure);
        } finally {
            if (temporary != null) Files.deleteIfExists(temporary);
        }
    }

    private byte[] header(long clockFloorMs) throws IOException {
        ByteBuffer prefix = ByteBuffer.allocate(HEADER_PREFIX_BYTES);
        prefix.put(MAGIC).putInt(VERSION).putLong(clockFloorMs);
        byte[] value = prefix.array();
        return ByteBuffer.allocate(HEADER_BYTES).put(value).put(hmac(value)).array();
    }

    private byte[] hmac(byte[] value) throws IOException {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            return mac.doFinal(value);
        } catch (GeneralSecurityException unavailable) {
            throw new IOException("Broker nonce replay integrity mechanism is unavailable", unavailable);
        }
    }

    private static String nonceDigest(String nonce) throws IOException {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(nonce.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException unavailable) {
            throw new IOException("Broker nonce digest mechanism is unavailable", unavailable);
        }
    }

    private void ensurePrivateFileExists(Path path) throws IOException {
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            try {
                Files.createFile(path, PosixFilePermissions.asFileAttribute(FILE_PERMISSIONS));
            } catch (java.nio.file.FileAlreadyExistsException raced) {
                // Verify the winner below.
            }
        }
        verifyPrivateFile(path);
    }

    private void verifyPrivateFile(Path path) throws IOException {
        if (Files.isSymbolicLink(path) || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Broker nonce replay state files must be regular non-symlink files");
        }
        if (!Files.getOwner(path, LinkOption.NOFOLLOW_LINKS).getName().equals(owner)) {
            throw new IOException("Broker nonce replay state file owner differs from its private directory");
        }
        try {
            if (!Files.getPosixFilePermissions(path, LinkOption.NOFOLLOW_LINKS).equals(FILE_PERMISSIONS)) {
                throw new IOException("Broker nonce replay state files must have 0600 permissions");
            }
        } catch (UnsupportedOperationException unsupported) {
            throw new IOException("Broker nonce replay state requires POSIX owner-only permissions", unsupported);
        }
    }

    private void forceDirectory() throws IOException {
        try (FileChannel directory = FileChannel.open(stateDirectory, StandardOpenOption.READ)) {
            directory.force(true);
        } catch (UnsupportedOperationException unsupported) {
            throw new IOException("Broker nonce replay state requires directory fsync support", unsupported);
        }
    }

    private void ensureClockNotRegressed(long now) throws IOException {
        if (now < clockHighWaterMs) {
            failed = true;
            throw new IOException("Broker wall clock is behind persisted nonce replay state");
        }
    }

    private static boolean isExpired(long timestampMs, long now) {
        return now >= timestampMs
                && now - timestampMs > MediaOciBrokerPolicy.MAX_REQUEST_SKEW_MS;
    }

    private void expireActive(long now) {
        while (!expiryQueue.isEmpty() && isExpired(expiryQueue.peek().timestampMs(), now)) {
            Entry expired = expiryQueue.remove();
            activeDigests.remove(expired.digestHex());
            expiredPending.add(expired.digestHex());
        }
    }

    private static long expiry(long timestampMs) {
        return timestampMs > Long.MAX_VALUE - MediaOciBrokerPolicy.MAX_REQUEST_SKEW_MS
                ? Long.MAX_VALUE : timestampMs + MediaOciBrokerPolicy.MAX_REQUEST_SKEW_MS;
    }

    private static long absoluteDifference(long left, long right) {
        return left >= right ? left - right : right - left;
    }

    private static String fixedHex(long value) {
        String digits = Long.toHexString(value);
        return "0".repeat(16 - digits.length()) + digits;
    }

    private static void writeFully(FileChannel channel, ByteBuffer value) throws IOException {
        while (value.hasRemaining()) {
            if (channel.write(value) <= 0) throw new IOException("Broker nonce replay state write made no progress");
        }
    }

    private static boolean overlaps(Path left, Path right) {
        if (left == null || right == null) return false;
        Path a = left.toAbsolutePath().normalize();
        Path b = right.toAbsolutePath().normalize();
        return a.startsWith(b) || b.startsWith(a);
    }

    private void ensureOpen() throws IOException {
        if (closed) throw new IOException("Broker nonce replay journal is closed");
        if (failed) throw new IOException("Broker nonce replay journal is unusable after a persistence failure");
    }

    @Override
    public synchronized void close() throws IOException {
        if (closed) return;
        closed = true;
        IOException failure = null;
        if (journalChannel != null) {
            try { journalChannel.close(); } catch (IOException closeFailure) { failure = closeFailure; }
        }
        if (fileLock != null && fileLock.isValid()) {
            try { fileLock.release(); } catch (IOException closeFailure) {
                if (failure == null) failure = closeFailure; else failure.addSuppressed(closeFailure);
            }
        }
        if (lockChannel != null) {
            try { lockChannel.close(); } catch (IOException closeFailure) {
                if (failure == null) failure = closeFailure; else failure.addSuppressed(closeFailure);
            }
        }
        if (failure != null) throw failure;
    }

    private void closeQuietly() {
        try { close(); } catch (IOException ignored) { }
    }

    private void closeLockChannelQuietly() {
        if (lockChannel == null) return;
        try { lockChannel.close(); } catch (IOException ignored) { }
        lockChannel = null;
    }

    private record Entry(long timestampMs, long observedAtMs, String digestHex) { }
}
