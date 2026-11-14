package com.ghatana.media.runtime.localmodel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/**
 * Cold-versus-warm verification of the REAL installed model directories (read-only: nothing is modified). Skipped, with
 * the reason, when the models are not installed under {@code MEDIA_LOCAL_MODEL_ROOT} or
 * {@code ~/.local/share/ghatana-media}. The second verification must hash zero files; the timings are printed as evidence.
 */
class LocalModelDigestCacheRealModelsTest {
    private static Path modelsRoot() {
        String configured = System.getenv("MEDIA_LOCAL_MODEL_ROOT");
        Path root = configured != null && !configured.isBlank() ? Path.of(configured)
                : Path.of(System.getProperty("user.home"), ".local", "share", "ghatana-media");
        return root.resolve("models");
    }

    @Test
    void secondVerificationOfTheRealQwenAndFlorenceTreesRehashesNothing() throws Exception {
        Path florence = modelsRoot().resolve("florence-2-large");
        Path qwen = modelsRoot().resolve("qwen2.5-vl-7b-instruct");
        assumeTrue(Files.isRegularFile(florence.resolve(LocalModelManifest.DIRECTORY_MANIFEST_FILE))
                        && Files.isRegularFile(qwen.resolve(LocalModelManifest.DIRECTORY_MANIFEST_FILE)),
                "SKIPPED: Florence-2 / Qwen2.5-VL manifests are not installed under " + modelsRoot());
        FileDigestCache cache = FileDigestCache.shared();
        cache.clearMemory();
        long hashed0 = cache.hashedCount();
        long cold = verifyBoth(florence, qwen);
        long hashedCold = cache.hashedCount() - hashed0;
        long warm = verifyBoth(florence, qwen);
        long hashedWarm = cache.hashedCount() - hashed0 - hashedCold;
        System.out.println("LOCAL_MODEL_DIGEST_CACHE cold=" + cold + "ms filesHashed=" + hashedCold
                + " warm=" + warm + "ms filesHashed=" + hashedWarm);
        assertThat(hashedCold).isGreaterThan(0);
        assertThat(hashedWarm).as("unchanged installed files must be served from the cache").isZero();
        assertThat(warm).isLessThan(Math.max(2_000, cold / 5));
    }

    private static long verifyBoth(Path florence, Path qwen) throws Exception {
        long started = System.nanoTime();
        for (Path dir : new Path[]{florence, qwen}) {
            LocalModelManifest manifest = LocalModelManifest.readDirectory(dir);
            String manifestSha = LocalModelManifest.manifestSha256(dir.resolve(LocalModelManifest.DIRECTORY_MANIFEST_FILE));
            assertThat(manifest.verify(dir, manifestSha).status()).isEqualTo(LocalModelManifest.Status.VERIFIED);
        }
        return java.time.Duration.ofNanos(System.nanoTime() - started).toMillis();
    }
}
