package com.ghatana.media.launcher;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Stream;

/**
 * Bounded, owner-only DEV_ONLY spool of synthesized speech keyed by (tenant, principal, requestId).
 *
 * <p>Local neural synthesis is not byte-stable, so re-running it for the same requestId would produce different
 * audio and an idempotent registration could never replay. The spool keeps the exact bytes and lineage of the first
 * successful synthesis for a requestId (together with the digest of the request that produced it) so a retry, also
 * after a restart or a crash between synthesis and registration, registers the SAME bytes (a replay or a resume)
 * and never runs the model again. A retry with a different request is detected here and refused by the caller. The
 * spool holds user content, is created owner-read-write only, is bounded by entry count (oldest evicted first) and
 * is never an evidence record: the registered artifact is the durable record.</p>
 */
final class MediaDevSpeechSpool {
    static final String ENV_DIR = "MEDIA_DEV_SPEECH_SPOOL_DIR";
    static final int MAX_ENTRIES = 256;
    private static final ObjectMapper JSON = JsonMapper.builder().build();

    record Entry(String fingerprint, byte[] wav, Map<String, Object> lineage) { }

    private final Path directory;
    private final ConcurrentHashMap<String, Object> locks = new ConcurrentHashMap<>();

    MediaDevSpeechSpool(Path directory) {
        this.directory = directory;
    }

    static MediaDevSpeechSpool fromEnvironment(Map<String, String> environment) {
        String configured = environment.get(ENV_DIR);
        Path directory = configured != null && !configured.isBlank() ? Path.of(configured)
                : Path.of(System.getProperty("java.io.tmpdir"), "media-dev-speech-spool-" + System.getProperty("user.name", "user"));
        if (!directory.isAbsolute()) throw new IllegalArgumentException(ENV_DIR + " must be an absolute path");
        return new MediaDevSpeechSpool(directory);
    }

    /** Serializes work for one key so two concurrent retries cannot synthesize twice. */
    Object lockFor(String key) {
        return locks.computeIfAbsent(key, ignored -> new Object());
    }

    Optional<Entry> find(String key) {
        Path meta = directory.resolve(key + ".json");
        Path wav = directory.resolve(key + ".wav");
        if (!Files.isRegularFile(meta) || !Files.isRegularFile(wav)) return Optional.empty();
        try {
            Map<String, Object> document = JSON.readValue(Files.readString(meta, StandardCharsets.UTF_8),
                    new TypeReference<Map<String, Object>>() { });
            Object fingerprint = document.get("fingerprint");
            Object lineage = document.get("lineage");
            if (!(fingerprint instanceof String text) || !(lineage instanceof Map<?, ?>)) return Optional.empty();
            @SuppressWarnings("unchecked") Map<String, Object> typed = (Map<String, Object>) lineage;
            return Optional.of(new Entry(text, Files.readAllBytes(wav), typed));
        } catch (IOException | RuntimeException unreadable) {
            return Optional.empty();
        }
    }

    /** Persists the entry and returns it as it will be read back (JSON-normalised), so first use and replay agree. */
    Entry put(String key, String fingerprint, byte[] wav, Map<String, Object> lineage) {
        try {
            Files.createDirectories(directory);
            try { Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------")); }
            catch (UnsupportedOperationException | IOException ignored) { /* best effort on non-POSIX stores */ }
            Path wavTmp = Files.createTempFile(directory, key, ".wav.tmp");
            Path metaTmp = Files.createTempFile(directory, key, ".json.tmp");
            try {
                Files.write(wavTmp, wav);
                Files.writeString(metaTmp, JSON.writeValueAsString(Map.of("fingerprint", fingerprint, "lineage", lineage)),
                        StandardCharsets.UTF_8);
                for (Path tmp : List.of(wavTmp, metaTmp)) {
                    try { Files.setPosixFilePermissions(tmp, PosixFilePermissions.fromString("rw-------")); }
                    catch (UnsupportedOperationException | IOException ignored) { /* best effort */ }
                }
                // The wav lands first: an entry is visible only once its json exists.
                Files.move(wavTmp, directory.resolve(key + ".wav"), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                Files.move(metaTmp, directory.resolve(key + ".json"), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } finally {
                Files.deleteIfExists(wavTmp);
                Files.deleteIfExists(metaTmp);
            }
            evict();
            return find(key).orElseThrow(() -> new IllegalStateException("speech spool entry was not readable after write"));
        } catch (IOException failure) {
            throw new IllegalStateException("speech spool write failed", failure);
        }
    }

    private void evict() {
        try (Stream<Path> files = Files.list(directory)) {
            List<Path> entries = new ArrayList<>(files.filter(path -> path.getFileName().toString().endsWith(".json"))
                    .sorted(Comparator.comparingLong(MediaDevSpeechSpool::modified)).toList());
            for (int index = 0; index < entries.size() - MAX_ENTRIES; index++) {
                Path json = entries.get(index);
                String name = json.getFileName().toString();
                Files.deleteIfExists(json);
                Files.deleteIfExists(directory.resolve(name.substring(0, name.length() - ".json".length()) + ".wav"));
            }
        } catch (IOException ignored) {
            // eviction is best effort; the bound is re-applied on the next write
        }
    }

    private static long modified(Path path) {
        try { return Files.getLastModifiedTime(path).toMillis(); }
        catch (IOException unreadable) { return 0L; }
    }
}
