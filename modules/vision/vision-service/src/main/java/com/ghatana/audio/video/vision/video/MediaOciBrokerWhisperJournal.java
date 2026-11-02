package com.ghatana.audio.video.vision.video;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Durable, bounded identity and result journal for brokered Whisper operations.
 *
 * <p>The journal is opened only after the configured broker instance's labeled
 * worker containers have been swept. Invocation identities cannot be reused,
 * STARTED records recover as UNKNOWN,
 * terminal success is authenticated and its transcript is encrypted at rest,
 * and exhausted storage refuses a new dispatch without evicting old identities.
 */
final class MediaOciBrokerWhisperJournal implements AutoCloseable {
    static final int DEFAULT_MAX_RECORDS = 4096;
    static final int MAX_RECORD_BYTES = 1_048_576;
    static final int MAX_TRANSCRIPT_BYTES = 128 * 1024;
    private static final int MAGIC = 0x574a5231; // WJR1
    private static final int VERSION = 1;
    private static final int NONCE_BYTES = 12;
    private static final int TAG_BITS = 128;
    private static final int HMAC_BYTES = 32;
    private static final String LOCK_FILE = "whisper-invocations.lock";
    private static final String JOURNAL_FILE = "whisper-invocations.log";
    private static final byte[] ENC_DOMAIN = "ghatana-media-whisper-journal/encryption/v1".getBytes(StandardCharsets.UTF_8);
    private static final byte[] MAC_DOMAIN = "ghatana-media-whisper-journal/integrity/v1".getBytes(StandardCharsets.UTF_8);
    private static final Set<PosixFilePermission> DIRECTORY_MODE =
            PosixFilePermissions.fromString("rwx------");
    private static final Set<PosixFilePermission> FILE_MODE =
            PosixFilePermissions.fromString("rw-------");
    private static final SecureRandom RANDOM = new SecureRandom();

    enum Status { STARTED, UNKNOWN_OUTCOME, SUCCESS }
    enum BeginKind { RESERVED, EXISTING, IDENTITY_CONFLICT, CAPACITY }

    record Identity(UUID invocationId, String profileId, String locale, String inputSha256) {
        Identity {
            Objects.requireNonNull(invocationId, "invocationId");
            if (profileId == null || !profileId.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
                throw new IllegalArgumentException("profileId is invalid");
            }
            java.util.Locale parsedLocale = locale == null ? null
                    : new java.util.Locale.Builder().setLanguageTag(locale).build();
            if (locale == null || locale.isBlank() || locale.length() > 35
                    || parsedLocale.getLanguage().isBlank() || "und".equals(parsedLocale.toLanguageTag())
                    || !locale.equals(parsedLocale.toLanguageTag())) {
                throw new IllegalArgumentException("locale is invalid");
            }
            if (inputSha256 == null || !inputSha256.matches("[0-9a-f]{64}")) {
                throw new IllegalArgumentException("inputSha256 is invalid");
            }
        }
    }

    record Entry(Identity identity, Status status, String modelSha256, String transcript) {
        Entry {
            Objects.requireNonNull(identity, "identity");
            Objects.requireNonNull(status, "status");
            transcript = transcript == null ? "" : transcript;
            if (status == Status.SUCCESS) {
                if (modelSha256 == null || !modelSha256.matches("[0-9a-f]{64}")) {
                    throw new IllegalArgumentException("Successful entry requires modelSha256");
                }
                if (transcript.getBytes(StandardCharsets.UTF_8).length > MAX_TRANSCRIPT_BYTES) {
                    throw new IllegalArgumentException("Transcript exceeds journal limit");
                }
            } else if (modelSha256 != null || !transcript.isEmpty()) {
                throw new IllegalArgumentException("Non-success entry cannot contain a result");
            }
        }
    }

    record BeginResult(BeginKind kind, Entry entry) {
        BeginResult {
            Objects.requireNonNull(kind, "kind");
            if ((kind == BeginKind.RESERVED || kind == BeginKind.EXISTING) != (entry != null)) {
                throw new IllegalArgumentException("Begin result shape is invalid");
            }
        }
    }

    private final FileChannel lockChannel;
    private final FileLock processLock;
    private final FileChannel journalChannel;
    private final byte[] encryptionKey;
    private final byte[] integrityKey;
    private final int maxRecords;
    private final Map<UUID, Entry> entries = new HashMap<>();
    private boolean closed;
    private boolean failed;

    static MediaOciBrokerWhisperJournal open(Path directory, String brokerSecret) throws IOException {
        return open(directory, brokerSecret, DEFAULT_MAX_RECORDS);
    }

    static MediaOciBrokerWhisperJournal open(Path directory, String brokerSecret, int maxRecords)
            throws IOException {
        if (brokerSecret == null || brokerSecret.getBytes(StandardCharsets.UTF_8).length < 32) {
            throw new IOException("Broker journal secret must contain at least 32 UTF-8 bytes");
        }
        if (maxRecords < 1 || maxRecords > 1_000_000) {
            throw new IOException("Broker journal capacity is outside the allowed bound");
        }
        Path realDirectory = validateDirectory(directory);
        Path lockPath = realDirectory.resolve(LOCK_FILE);
        Path journalPath = realDirectory.resolve(JOURNAL_FILE);
        createPrivateFileIfAbsent(lockPath);
        createPrivateFileIfAbsent(journalPath);
        validatePrivateFile(realDirectory, lockPath);
        validatePrivateFile(realDirectory, journalPath);

        FileChannel lockChannel = openPrivateChannel(lockPath, Set.of(StandardOpenOption.READ,
                StandardOpenOption.WRITE));
        FileLock processLock;
        try {
            processLock = lockChannel.tryLock();
        } catch (OverlappingFileLockException alreadyLocked) {
            lockChannel.close();
            throw new IOException("Whisper journal is already open in this process", alreadyLocked);
        }
        if (processLock == null) {
            lockChannel.close();
            throw new IOException("Whisper journal is already locked by another process");
        }

        FileChannel journalChannel = null;
        try {
            journalChannel = openPrivateChannel(journalPath, Set.of(StandardOpenOption.READ,
                    StandardOpenOption.WRITE));
            byte[] master = brokerSecret.getBytes(StandardCharsets.UTF_8);
            byte[] encryptionKey;
            byte[] integrityKey;
            try {
                encryptionKey = derive(master, ENC_DOMAIN);
                integrityKey = derive(master, MAC_DOMAIN);
            } finally {
                Arrays.fill(master, (byte) 0);
            }
            MediaOciBrokerWhisperJournal journal = new MediaOciBrokerWhisperJournal(
                    lockChannel, processLock, journalChannel,
                    encryptionKey, integrityKey, maxRecords);
            journal.recover();
            return journal;
        } catch (IOException | RuntimeException failure) {
            if (journalChannel != null) journalChannel.close();
            processLock.release();
            lockChannel.close();
            throw failure;
        }
    }

    private MediaOciBrokerWhisperJournal(FileChannel lockChannel,
            FileLock processLock, FileChannel journalChannel, byte[] encryptionKey,
            byte[] integrityKey, int maxRecords) {
        this.lockChannel = lockChannel;
        this.processLock = processLock;
        this.journalChannel = journalChannel;
        this.encryptionKey = encryptionKey;
        this.integrityKey = integrityKey;
        this.maxRecords = maxRecords;
    }

    synchronized BeginResult begin(Identity identity) throws IOException {
        ensureOpen();
        Objects.requireNonNull(identity, "identity");
        Entry existing = entries.get(identity.invocationId());
        if (existing != null) {
            return existing.identity().equals(identity)
                    ? new BeginResult(BeginKind.EXISTING, existing)
                    : new BeginResult(BeginKind.IDENTITY_CONFLICT, null);
        }
        if (entries.size() >= maxRecords) return new BeginResult(BeginKind.CAPACITY, null);
        Entry started = new Entry(identity, Status.STARTED, null, "");
        append(started);
        entries.put(identity.invocationId(), started);
        return new BeginResult(BeginKind.RESERVED, started);
    }

    synchronized Entry lookup(Identity identity) throws IOException {
        ensureOpen();
        Objects.requireNonNull(identity, "identity");
        Entry entry = entries.get(identity.invocationId());
        if (entry == null || !entry.identity().equals(identity)) return null;
        return entry;
    }

    synchronized Entry lookup(UUID invocationId) throws IOException {
        ensureOpen();
        return entries.get(Objects.requireNonNull(invocationId, "invocationId"));
    }

    synchronized Entry markUnknown(Identity identity) throws IOException {
        ensureOpen();
        Entry current = requireCurrent(identity);
        if (current.status() != Status.STARTED) return current;
        Entry unknown = new Entry(identity, Status.UNKNOWN_OUTCOME, null, "");
        append(unknown);
        entries.put(identity.invocationId(), unknown);
        return unknown;
    }

    synchronized Entry completeSuccess(Identity identity, String modelSha256, String transcript)
            throws IOException {
        ensureOpen();
        Entry current = requireCurrent(identity);
        if (current.status() != Status.STARTED) {
            throw new IOException("Whisper invocation is not in STARTED state");
        }
        Entry success = new Entry(identity, Status.SUCCESS, modelSha256, transcript);
        append(success);
        entries.put(identity.invocationId(), success);
        return success;
    }

    synchronized int recordCount() throws IOException {
        ensureOpen();
        return entries.size();
    }

    private Entry requireCurrent(Identity identity) throws IOException {
        Objects.requireNonNull(identity, "identity");
        Entry current = entries.get(identity.invocationId());
        if (current == null || !current.identity().equals(identity)) {
            throw new IOException("Whisper invocation identity is absent or mismatched");
        }
        return current;
    }

    private void append(Entry entry) throws IOException {
        byte[] payload = encode(entry);
        if (payload.length > MAX_RECORD_BYTES) throw new IOException("Whisper journal record exceeds its bound");
        byte[] mac = hmac(integrityKey, payload);
        ByteBuffer frame = ByteBuffer.allocate(8 + payload.length + mac.length)
                .putInt(MAGIC).putInt(payload.length).put(payload).put(mac);
        frame.flip();
        try {
            journalChannel.position(journalChannel.size());
            while (frame.hasRemaining()) journalChannel.write(frame);
            journalChannel.force(true);
        } catch (IOException failure) {
            // A partial append makes the tail unusable. Do not permit another write
            // to turn that tail into an ambiguous dispatch history.
            this.failed = true;
            throw failure;
        }
    }

    private byte[] encode(Entry entry) throws IOException {
        try {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (DataOutputStream out = new DataOutputStream(bytes)) {
                out.writeByte(VERSION);
                writeString(out, entry.identity().invocationId().toString(), 36);
                writeString(out, entry.identity().profileId(), 128);
                writeString(out, entry.identity().locale(), 35);
                writeString(out, entry.identity().inputSha256(), 64);
                out.writeByte(entry.status().ordinal());
                if (entry.status() == Status.SUCCESS) {
                    writeString(out, entry.modelSha256(), 64);
                    byte[] nonce = new byte[NONCE_BYTES];
                    RANDOM.nextBytes(nonce);
                    byte[] encrypted = encrypt(entry.identity(), entry.transcript(), nonce);
                    out.write(nonce);
                    out.writeInt(encrypted.length);
                    out.write(encrypted);
                }
            }
            return bytes.toByteArray();
        } catch (GeneralSecurityException failure) {
            throw new IOException("Could not protect Whisper journal result", failure);
        }
    }

    private Entry decode(byte[] payload) throws IOException {
        try (DataInputStream in = new DataInputStream(new ByteArrayInputStream(payload))) {
            if (in.readUnsignedByte() != VERSION) throw new IOException("Unsupported Whisper journal version");
            Identity identity = new Identity(UUID.fromString(readString(in, 36)),
                    readString(in, 128), readString(in, 35), readString(in, 64));
            int statusOrdinal = in.readUnsignedByte();
            if (statusOrdinal >= Status.values().length) throw new IOException("Invalid Whisper journal status");
            Status status = Status.values()[statusOrdinal];
            Entry entry;
            if (status == Status.SUCCESS) {
                String model = readString(in, 64);
                byte[] nonce = in.readNBytes(NONCE_BYTES);
                if (nonce.length != NONCE_BYTES) throw new IOException("Truncated Whisper result nonce");
                int length = in.readInt();
                if (length < 16 || length > MAX_TRANSCRIPT_BYTES + 16) {
                    throw new IOException("Whisper result ciphertext is outside its bound");
                }
                byte[] ciphertext = in.readNBytes(length);
                if (ciphertext.length != length) throw new IOException("Truncated Whisper result ciphertext");
                String transcript = decrypt(identity, nonce, ciphertext);
                entry = new Entry(identity, status, model, transcript);
            } else {
                entry = new Entry(identity, status, null, "");
            }
            if (in.available() != 0) throw new IOException("Trailing bytes in Whisper journal record");
            return entry;
        } catch (GeneralSecurityException | IllegalArgumentException failure) {
            throw new IOException("Whisper journal record is invalid", failure);
        }
    }

    private byte[] encrypt(Identity identity, String transcript, byte[] nonce) throws GeneralSecurityException, IOException {
        byte[] clear = transcript.getBytes(StandardCharsets.UTF_8);
        if (clear.length > MAX_TRANSCRIPT_BYTES) throw new IOException("Transcript exceeds journal limit");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(encryptionKey, "AES"),
                new GCMParameterSpec(TAG_BITS, nonce));
        cipher.updateAAD(identityBytes(identity));
        return cipher.doFinal(clear);
    }

    private String decrypt(Identity identity, byte[] nonce, byte[] ciphertext) throws GeneralSecurityException, IOException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(encryptionKey, "AES"),
                new GCMParameterSpec(TAG_BITS, nonce));
        cipher.updateAAD(identityBytes(identity));
        byte[] clear = cipher.doFinal(ciphertext);
        if (clear.length > MAX_TRANSCRIPT_BYTES) throw new IOException("Transcript exceeds journal limit");
        return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(clear)).toString();
    }

    private static byte[] identityBytes(Identity identity) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (DataOutputStream out = new DataOutputStream(bytes)) {
            writeString(out, identity.invocationId().toString(), 36);
            writeString(out, identity.profileId(), 128);
            writeString(out, identity.locale(), 35);
            writeString(out, identity.inputSha256(), 64);
        }
        return bytes.toByteArray();
    }

    private void recover() throws IOException {
        long size = journalChannel.size();
        if (size > (long) maxRecords * 2L * MAX_RECORD_BYTES) {
            throw new IOException("Whisper journal exceeds configured storage bound");
        }
        journalChannel.position(0);
        ByteBuffer header = ByteBuffer.allocate(8);
        long position = 0;
        Map<UUID, Entry> recovered = new HashMap<>();
        while (position < size) {
            header.clear();
            if (!readFully(journalChannel, header)) throw new IOException("Torn Whisper journal header");
            header.flip();
            int magic = header.getInt();
            int length = header.getInt();
            if (magic != MAGIC || length < 1 || length > MAX_RECORD_BYTES
                    || position + 8L + length + HMAC_BYTES > size) {
                throw new IOException("Torn or malformed Whisper journal frame");
            }
            ByteBuffer record = ByteBuffer.allocate(length + HMAC_BYTES);
            if (!readFully(journalChannel, record)) throw new IOException("Torn Whisper journal record");
            record.flip();
            byte[] payload = new byte[length];
            byte[] actualMac = new byte[HMAC_BYTES];
            record.get(payload).get(actualMac);
            if (!MessageDigest.isEqual(actualMac, hmac(integrityKey, payload))) {
                throw new IOException("Whisper journal integrity check failed");
            }
            Entry decoded = decode(payload);
            Entry previous = recovered.get(decoded.identity().invocationId());
            if (previous == null) {
                if (recovered.size() >= maxRecords) throw new IOException("Whisper journal record capacity exceeded");
                recovered.put(decoded.identity().invocationId(), decoded);
            } else {
                if (!previous.identity().equals(decoded.identity()) || !validTransition(previous, decoded)) {
                    throw new IOException("Whisper journal identity or state transition is invalid");
                }
                recovered.put(decoded.identity().invocationId(), decoded);
            }
            position += 8L + length + HMAC_BYTES;
        }
        for (Map.Entry<UUID, Entry> item : recovered.entrySet()) {
            Entry entry = item.getValue();
            if (entry.status() == Status.STARTED) {
                recovered.put(item.getKey(), new Entry(entry.identity(), Status.UNKNOWN_OUTCOME, null, ""));
            }
        }
        entries.putAll(recovered);
        journalChannel.position(size);
    }

    private static boolean validTransition(Entry previous, Entry next) {
        if (previous.status() != Status.STARTED) return previous.equals(next);
        return next.status() == Status.UNKNOWN_OUTCOME || next.status() == Status.SUCCESS;
    }

    private static boolean readFully(FileChannel channel, ByteBuffer buffer) throws IOException {
        while (buffer.hasRemaining()) {
            int read = channel.read(buffer);
            if (read < 0) return false;
            if (read == 0) Thread.onSpinWait();
        }
        return true;
    }

    private static byte[] derive(byte[] master, byte[] domain) throws IOException {
        return hmac(master, domain);
    }

    private static byte[] hmac(byte[] key, byte[] bytes) throws IOException {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            return mac.doFinal(bytes);
        } catch (GeneralSecurityException failure) {
            throw new IOException("HMAC-SHA256 is unavailable", failure);
        }
    }

    private static void writeString(DataOutputStream out, String value, int maxBytes) throws IOException {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > maxBytes) throw new IOException("Whisper journal string exceeds its bound");
        out.writeInt(bytes.length);
        out.write(bytes);
    }

    private static String readString(DataInputStream in, int maxBytes) throws IOException {
        int length = in.readInt();
        if (length < 0 || length > maxBytes) throw new IOException("Whisper journal string is outside its bound");
        byte[] bytes = in.readNBytes(length);
        if (bytes.length != length) throw new IOException("Truncated Whisper journal string");
        return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes)).toString();
    }

    private static Path validateDirectory(Path path) throws IOException {
        if (path == null || Files.isSymbolicLink(path)
                || !Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Whisper journal directory must be an existing non-symlink directory");
        }
        Path real = path.toRealPath(LinkOption.NOFOLLOW_LINKS);
        try {
            if (!Files.getPosixFilePermissions(real, LinkOption.NOFOLLOW_LINKS).equals(DIRECTORY_MODE)) {
                throw new IOException("Whisper journal directory must have 0700 permissions");
            }
        } catch (UnsupportedOperationException unsupported) {
            throw new IOException("Whisper journal requires POSIX owner-only filesystem permissions", unsupported);
        }
        return real;
    }

    private static void createPrivateFileIfAbsent(Path path) throws IOException {
        if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return;
        try {
            Files.createFile(path, PosixFilePermissions.asFileAttribute(FILE_MODE));
            try (FileChannel directory = FileChannel.open(path.getParent(), StandardOpenOption.READ)) {
                directory.force(true);
            }
        } catch (UnsupportedOperationException unsupported) {
            throw new IOException("Whisper journal requires POSIX owner-only filesystem permissions", unsupported);
        }
    }

    private static void validatePrivateFile(Path directory, Path file) throws IOException {
        if (Files.isSymbolicLink(file) || !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Whisper journal files must be regular non-symlink files");
        }
        if (!Files.getPosixFilePermissions(file, LinkOption.NOFOLLOW_LINKS).equals(FILE_MODE)) {
            throw new IOException("Whisper journal files must have 0600 permissions");
        }
        Object directoryOwner = Files.getOwner(directory, LinkOption.NOFOLLOW_LINKS);
        Object fileOwner = Files.getOwner(file, LinkOption.NOFOLLOW_LINKS);
        if (!directoryOwner.equals(fileOwner)) throw new IOException("Whisper journal file owner differs from directory owner");
    }

    private static FileChannel openPrivateChannel(Path path, Set<? extends OpenOption> options) throws IOException {
        Set<OpenOption> safeOptions = new java.util.HashSet<>(options);
        safeOptions.add(LinkOption.NOFOLLOW_LINKS);
        return FileChannel.open(path, safeOptions);
    }

    private void ensureOpen() throws IOException {
        if (closed) throw new IOException("Whisper journal is closed");
        if (failed) throw new IOException("Whisper journal is unusable after a failed append");
    }

    @Override
    public synchronized void close() throws IOException {
        if (closed) return;
        closed = true;
        Arrays.fill(encryptionKey, (byte) 0);
        Arrays.fill(integrityKey, (byte) 0);
        IOException failure = null;
        try { journalChannel.close(); } catch (IOException closeFailure) { failure = closeFailure; }
        try { processLock.release(); } catch (IOException closeFailure) {
            if (failure == null) failure = closeFailure; else failure.addSuppressed(closeFailure);
        }
        try { lockChannel.close(); } catch (IOException closeFailure) {
            if (failure == null) failure = closeFailure; else failure.addSuppressed(closeFailure);
        }
        if (failure != null) throw failure;
    }
}
