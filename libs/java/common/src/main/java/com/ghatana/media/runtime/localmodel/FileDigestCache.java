package com.ghatana.media.runtime.localmodel;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * Digest cache for large model files, keyed by absolute path plus the file's size, modification time (nanosecond
 * resolution) and file key (device and inode). A cached digest is reused only while all three still match what the
 * file system reports now; any change, including a replaced inode, re-hashes the file, so verification semantics are
 * unchanged: a digest is always either freshly computed or provably computed from the same unmodified file.
 *
 * <p>Two safeguards keep the stat key honest. A file modified within {@link #RACY_WINDOW_MILLIS} of the moment it
 * was hashed is never cached (the modification time cannot yet distinguish a later same-tick rewrite), and a file
 * whose stat key changed while it was being hashed is not cached either.</p>
 *
 * <p>The cache is in memory. When a persistence file is configured (system property
 * {@value #PROPERTY_FILE} or environment variable {@value #ENV_FILE}) it is also loaded from and saved to that
 * owner-only JSON file so a restarted process does not re-hash unchanged weights; the same stat key applies, so
 * trust in a persisted entry is exactly trust that the file system reports the same device, inode, size and mtime.
 * Persistence is opt-in and a read or write problem silently falls back to hashing.</p>
 */
public final class FileDigestCache {
    public static final String PROPERTY_FILE = "ghatana.media.localModel.digestCacheFile";
    public static final String ENV_FILE = "MEDIA_LOCAL_MODEL_DIGEST_CACHE";
    public static final long RACY_WINDOW_MILLIS = 2_000;
    private static final long MAX_CACHE_BYTES = 4L * 1024 * 1024;
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final FileDigestCache SHARED = new FileDigestCache(configuredFile());

    /** The stat identity a digest was computed under. */
    record Stamp(long size, long mtimeNanos, String fileKey) { }

    private record Entry(Stamp stamp, String sha256) { }

    private final ConcurrentHashMap<String, Entry> entries = new ConcurrentHashMap<>();
    private final Path persistence;
    private final java.util.concurrent.atomic.AtomicLong hashed = new java.util.concurrent.atomic.AtomicLong();
    private final java.util.concurrent.atomic.AtomicLong reused = new java.util.concurrent.atomic.AtomicLong();

    public FileDigestCache(Path persistence) {
        this.persistence = persistence == null ? null : persistence.toAbsolutePath().normalize();
        load();
    }

    /** Process-wide cache used by manifest verification. */
    public static FileDigestCache shared() { return SHARED; }

    private static Path configuredFile() {
        String configured = System.getProperty(PROPERTY_FILE);
        if (configured == null || configured.isBlank()) configured = System.getenv(ENV_FILE);
        return configured == null || configured.isBlank() ? null : Path.of(configured);
    }

    /** Number of files hashed from content (cache misses) since this cache was created. */
    public long hashedCount() { return hashed.get(); }

    /** Number of digests served from the cache since this cache was created. */
    public long reusedCount() { return reused.get(); }

    public void clearMemory() { entries.clear(); }

    /** SHA-256 of {@code file}: reused when the stat key is unchanged, otherwise freshly computed. */
    public String sha256(Path file) throws IOException {
        Path key = file.toAbsolutePath().normalize();
        Stamp before = stamp(key);
        Entry known = entries.get(key.toString());
        if (known != null && known.stamp().equals(before)) {
            reused.incrementAndGet();
            return known.sha256();
        }
        long hashStarted = System.currentTimeMillis();
        String digest = hash(key);
        hashed.incrementAndGet();
        Stamp after = stamp(key);
        boolean racy = TimeUnit.NANOSECONDS.toMillis(after.mtimeNanos()) > hashStarted - RACY_WINDOW_MILLIS;
        if (before.equals(after) && !racy) {
            entries.put(key.toString(), new Entry(after, digest));
            save();
        } else {
            entries.remove(key.toString());
        }
        return digest;
    }

    /** The current stat key of a regular, non-symlink file; throws when it is not one. */
    static Stamp stamp(Path file) throws IOException {
        BasicFileAttributes attributes = Files.readAttributes(file, BasicFileAttributes.class,
                LinkOption.NOFOLLOW_LINKS);
        if (!attributes.isRegularFile()) throw new IOException("not a regular file");
        Object key = attributes.fileKey();
        return new Stamp(attributes.size(), attributes.lastModifiedTime().to(TimeUnit.NANOSECONDS),
                key == null ? "" : key.toString());
    }

    static String hash(Path file) throws IOException {
        MessageDigest digest = newDigest();
        try (InputStream in = Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS)) {
            byte[] buffer = new byte[1 << 20];
            int read;
            while ((read = in.read(buffer)) >= 0) digest.update(buffer, 0, read);
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    private static MessageDigest newDigest() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    private void load() {
        if (persistence == null) return;
        try {
            if (!Files.isRegularFile(persistence, LinkOption.NOFOLLOW_LINKS)
                    || Files.size(persistence) > MAX_CACHE_BYTES) return;
            JsonNode root = JSON.readTree(Files.readAllBytes(persistence));
            JsonNode list = root == null ? null : root.get("entries");
            if (list == null || !list.isObject()) return;
            for (Map.Entry<String, JsonNode> item : list.properties()) {
                JsonNode value = item.getValue();
                String sha = value.path("sha256").asString("");
                if (!sha.matches("[0-9a-f]{64}") || !value.has("size") || !value.has("mtimeNanos")) continue;
                entries.put(item.getKey(), new Entry(new Stamp(value.path("size").asLong(-1),
                        value.path("mtimeNanos").asLong(-1), value.path("fileKey").asString("")), sha));
            }
        } catch (IOException | RuntimeException unreadable) {
            entries.clear();
        }
    }

    private synchronized void save() {
        if (persistence == null) return;
        try {
            Map<String, Object> list = new TreeMap<>();
            entries.forEach((path, entry) -> list.put(path, Map.of("size", entry.stamp().size(),
                    "mtimeNanos", entry.stamp().mtimeNanos(), "fileKey", entry.stamp().fileKey(),
                    "sha256", entry.sha256())));
            byte[] bytes = JSON.writeValueAsString(Map.of("schema", "ghatana.media.digest-cache.v1",
                    "entries", list)).getBytes(StandardCharsets.UTF_8);
            Path parent = persistence.getParent();
            if (parent != null) Files.createDirectories(parent);
            Path temp = Files.createTempFile(parent, ".digest-cache-", ".tmp",
                    java.nio.file.attribute.PosixFilePermissions.asFileAttribute(
                            PosixFilePermissions.fromString("rw-------")));
            Files.write(temp, bytes);
            Files.move(temp, persistence, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException | RuntimeException ignored) {
            // persistence is an optimisation only
        }
    }
}
