package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Packaging rules that need no process: determinism, digests, script-safe embedding and truth/caption classification. */
class MediaDevInteractiveDemoPackageTest {
    private static MediaArtifact artifact(String id, String contentType, String sha, Map<String, Object> metadata) {
        return new MediaArtifact("tenant", "principal", id, "f.bin", contentType, 4, sha, "local://x", "INTERNAL",
                Instant.now(), Instant.now().plusSeconds(60), metadata);
    }

    private static Map<String, byte[]> files() {
        Map<String, byte[]> files = new LinkedHashMap<>();
        files.put("index.html", "<!doctype html>".getBytes(StandardCharsets.UTF_8));
        files.put("assets/" + "a".repeat(64) + ".webm", new byte[] {0x1a, 0x45, (byte) 0xdf, (byte) 0xa3, 0, (byte) 0xff});
        files.put("captions/" + "b".repeat(64) + ".vtt", "WEBVTT\n".getBytes(StandardCharsets.UTF_8));
        return files;
    }

    @Test
    void theZipIsDeterministicAndIndependentOfInsertionOrder() throws Exception {
        Map<String, byte[]> reversed = new java.util.TreeMap<>(java.util.Comparator.reverseOrder());
        reversed.putAll(files());
        assertThat(MediaDevInteractiveDemoRuntime.zip(files())).isEqualTo(MediaDevInteractiveDemoRuntime.zip(reversed));
        try (ZipInputStream in = new ZipInputStream(new java.io.ByteArrayInputStream(MediaDevInteractiveDemoRuntime.zip(files())))) {
            ZipEntry entry = in.getNextEntry();
            assertThat(entry.getName()).isEqualTo("assets/" + "a".repeat(64) + ".webm");
            assertThat(entry.getTimeLocal()).isEqualTo(java.time.LocalDateTime.of(1980, 1, 1, 0, 0, 0));
        }
    }

    @Test
    void theStoredBundleRoundTripsAndATamperedFileIsRefused() {
        byte[] bundle = MediaDevInteractiveDemoRuntime.bundle(files());
        Map<String, byte[]> back = MediaDevInteractiveDemoRuntime.unbundle(bundle);
        assertThat(back.keySet()).containsExactlyElementsOf(new java.util.TreeSet<>(files().keySet()));
        files().forEach((path, bytes) -> assertThat(back.get(path)).isEqualTo(bytes));
        String tampered = new String(bundle, StandardCharsets.UTF_8).replace("<!doctype html>", "<!doctype html><b>");
        assertThatThrownBy(() -> MediaDevInteractiveDemoRuntime.unbundle(tampered.getBytes(StandardCharsets.UTF_8)))
                .isInstanceOfSatisfying(MediaDevVideoRuntime.VideoRefusedException.class,
                        failure -> assertThat(failure.code()).isEqualTo("DEMO_PACKAGE_DIGEST_MISMATCH"));
        assertThatThrownBy(() -> MediaDevInteractiveDemoRuntime.unbundle("{\"schema\":\"other\"}".getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(MediaDevVideoRuntime.VideoRefusedException.class);
    }

    @Test
    void embeddedManifestCannotCloseTheScriptElementOrInjectMarkup() {
        String json = "{\"label\":\"</script><script>alert(1)</script> &  \"}";
        String safe = MediaDevInteractiveDemoRuntime.escapeJsonForScript(json);
        assertThat(safe).doesNotContain("<").doesNotContain(">").doesNotContain("&").doesNotContain(" ");
        assertThat(MediaDevInteractiveDemoRuntime.escapeHtml("<b a=\"x\">&")).isEqualTo("&lt;b a=&quot;x&quot;&gt;&amp;");
    }

    @Test
    void aSceneIsLiveOnlyWhenItIsARegisteredRuntimeOutput() {
        assertThat(MediaDevInteractiveDemoRuntime.isLive(artifact("a", "video/webm", "a".repeat(64),
                Map.of("scope", "DEV_ONLY", "fixture", "synthetic-journey-source")))).isFalse();
        assertThat(MediaDevInteractiveDemoRuntime.isLive(artifact("b", "video/mp4", "b".repeat(64),
                Map.of("scope", "DEV_ONLY", "videoSchema", "media.dev.spatial-export.v1")))).isTrue();
        assertThat(MediaDevInteractiveDemoRuntime.isLive(artifact("c", "video/mp4", "c".repeat(64),
                Map.of("videoSchema", "not-a-runtime-schema")))).isFalse();
    }

    @Test
    void aCaptionWrittenForAnotherVideoVersionIsRefusedAndAnUnboundOneIsNot() {
        MediaArtifact scene = artifact("video-1", "video/webm", "d".repeat(64), Map.of());
        MediaArtifact bound = artifact("cap-1", "text/vtt", "e".repeat(64), Map.of("source",
                Map.of("artifactId", "video-1", "artifactVersionId", scene.version().value())));
        MediaArtifact otherVersion = artifact("cap-2", "text/vtt", "f".repeat(64), Map.of("source",
                Map.of("artifactId", "video-1", "artifactVersionId", "sha256:" + "0".repeat(64))));
        MediaArtifact otherVideo = artifact("cap-3", "text/vtt", "1".repeat(64), Map.of("source",
                Map.of("artifactId", "video-9", "artifactVersionId", scene.version().value())));
        MediaArtifact unbound = artifact("cap-4", "text/vtt", "2".repeat(64), Map.of());
        MediaDevInteractiveDemoRuntime.requireCaptionBinding(bound, scene, "nodes[0].captions");
        MediaDevInteractiveDemoRuntime.requireCaptionBinding(unbound, scene, "nodes[0].captions");
        for (MediaArtifact stale : new MediaArtifact[] {otherVersion, otherVideo}) {
            assertThatThrownBy(() -> MediaDevInteractiveDemoRuntime.requireCaptionBinding(stale, scene, "nodes[2].captions"))
                    .isInstanceOfSatisfying(MediaDevVideoRuntime.VideoRefusedException.class, failure -> {
                        assertThat(failure.status()).isEqualTo(422);
                        assertThat(failure.code()).isEqualTo("CAPTION_VERSION_MISMATCH");
                        assertThat(failure.details()).containsEntry("path", "nodes[2].captions");
                    });
        }
    }
}
