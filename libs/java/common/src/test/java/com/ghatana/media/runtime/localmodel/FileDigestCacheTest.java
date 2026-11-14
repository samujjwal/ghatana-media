package com.ghatana.media.runtime.localmodel;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.FileTime;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The digest cache may only ever return a digest for a file whose size, mtime and inode are unchanged. */
class FileDigestCacheTest {
    @TempDir Path dir;

    private static String sha(String text) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(text.getBytes(StandardCharsets.UTF_8)));
    }

    private Path aged(String name, String content) throws Exception {
        Path file = dir.resolve(name);
        Files.write(file, content.getBytes(StandardCharsets.UTF_8));
        Files.setLastModifiedTime(file, FileTime.from(Instant.now().minusSeconds(3600)));
        return file;
    }

    @Test
    void unchangedFileIsHashedOnceAndServedFromTheCacheAfterwards() throws Exception {
        FileDigestCache cache = new FileDigestCache(null);
        Path file = aged("weights.bin", "weights-v1");
        assertThat(cache.sha256(file)).isEqualTo(sha("weights-v1"));
        assertThat(cache.sha256(file)).isEqualTo(sha("weights-v1"));
        assertThat(cache.hashedCount()).isEqualTo(1);
        assertThat(cache.reusedCount()).isEqualTo(1);
    }

    @Test
    void contentChangeWithSameSizeIsRehashedBecauseTheModificationTimeMoved() throws Exception {
        FileDigestCache cache = new FileDigestCache(null);
        Path file = aged("weights.bin", "weights-v1");
        cache.sha256(file);
        Files.write(file, "weights-v2".getBytes(StandardCharsets.UTF_8));
        Files.setLastModifiedTime(file, FileTime.from(Instant.now().minusSeconds(1800)));
        assertThat(cache.sha256(file)).isEqualTo(sha("weights-v2"));
        assertThat(cache.hashedCount()).isEqualTo(2);
    }

    @Test
    void sizeChangeIsRehashed() throws Exception {
        FileDigestCache cache = new FileDigestCache(null);
        Path file = aged("weights.bin", "weights-v1");
        cache.sha256(file);
        Files.write(file, "weights-v1-longer".getBytes(StandardCharsets.UTF_8));
        Files.setLastModifiedTime(file, FileTime.from(Instant.now().minusSeconds(3600)));
        assertThat(cache.sha256(file)).isEqualTo(sha("weights-v1-longer"));
        assertThat(cache.hashedCount()).isEqualTo(2);
    }

    @Test
    void replacedInodeWithIdenticalSizeAndMtimeIsRehashed() throws Exception {
        FileDigestCache cache = new FileDigestCache(null);
        Path file = aged("weights.bin", "weights-v1");
        FileTime mtime = Files.getLastModifiedTime(file);
        cache.sha256(file);
        Path other = dir.resolve("swap.bin");
        Files.write(other, "weights-vX".getBytes(StandardCharsets.UTF_8));
        Files.setLastModifiedTime(other, mtime);
        Files.move(other, file, StandardCopyOption.REPLACE_EXISTING);
        assertThat(cache.sha256(file)).isEqualTo(sha("weights-vX"));
        assertThat(cache.hashedCount()).isEqualTo(2);
    }

    @Test
    void freshlyModifiedFilesAreNeverCached() throws Exception {
        FileDigestCache cache = new FileDigestCache(null);
        Path file = dir.resolve("fresh.bin");
        Files.write(file, "fresh".getBytes(StandardCharsets.UTF_8));
        cache.sha256(file);
        cache.sha256(file);
        assertThat(cache.hashedCount()).isEqualTo(2);
        assertThat(cache.reusedCount()).isZero();
    }

    @Test
    void persistedEntriesSurviveAProcessRestartButNotAFileChange() throws Exception {
        Path store = dir.resolve("cache/digests.json");
        Path file = aged("weights.bin", "weights-v1");
        FileDigestCache first = new FileDigestCache(store);
        first.sha256(file);
        assertThat(Files.getPosixFilePermissions(store)).isEqualTo(PosixFilePermissions.fromString("rw-------"));

        FileDigestCache restarted = new FileDigestCache(store);
        assertThat(restarted.sha256(file)).isEqualTo(sha("weights-v1"));
        assertThat(restarted.hashedCount()).isZero();
        assertThat(restarted.reusedCount()).isEqualTo(1);

        Files.write(file, "weights-v2".getBytes(StandardCharsets.UTF_8));
        Files.setLastModifiedTime(file, FileTime.from(Instant.now().minusSeconds(900)));
        FileDigestCache afterChange = new FileDigestCache(store);
        assertThat(afterChange.sha256(file)).isEqualTo(sha("weights-v2"));
        assertThat(afterChange.hashedCount()).isEqualTo(1);
    }

    @Test
    void corruptPersistedCacheFallsBackToHashing() throws Exception {
        Path store = dir.resolve("digests.json");
        Files.writeString(store, "{not json");
        Path file = aged("weights.bin", "weights-v1");
        FileDigestCache cache = new FileDigestCache(store);
        assertThat(cache.sha256(file)).isEqualTo(sha("weights-v1"));
        assertThat(cache.hashedCount()).isEqualTo(1);
    }
}
