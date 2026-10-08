package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaUploadRequestFingerprintTest {
    @Test
    void canonicalFingerprintIgnoresObjectKeyOrderButBindsEveryRequestField() {
        Map<String, Object> left = new LinkedHashMap<>();
        left.put("z", 1);
        left.put("nested", Map.of("b", List.of(true, "x"), "a", 2.0));
        Map<String, Object> right = new LinkedHashMap<>();
        right.put("nested", Map.of("a", 2, "b", List.of(true, "x")));
        right.put("z", 1L);
        UploadRequest first = request("clip.bin", "principal-a", left);
        UploadRequest reordered = request("clip.bin", "principal-a", right);
        assertThat(MediaUploadRequestFingerprint.compute(first))
                .isEqualTo(MediaUploadRequestFingerprint.compute(reordered));
        assertThat(MediaUploadRequestFingerprint.compute(first))
                .isNotEqualTo(MediaUploadRequestFingerprint.compute(request("other.bin", "principal-a", right)))
                .isNotEqualTo(MediaUploadRequestFingerprint.compute(request("clip.bin", "principal-b", right)));
    }

    @Test
    void nestedMetadataIsFrozenAndAccessorReturnsDefensiveSnapshots() {
        List<Object> nested = new java.util.ArrayList<>(List.of("before"));
        Map<String, Object> metadata = new java.util.LinkedHashMap<>();
        metadata.put("nested", nested);
        UploadRequest upload = request("clip.bin", "principal-a", metadata);
        String digest = MediaUploadRequestFingerprint.compute(upload);
        nested.set(0, "mutated-source");
        assertThat(MediaUploadRequestFingerprint.compute(upload)).isEqualTo(digest);
        @SuppressWarnings("unchecked")
        List<Object> returned = (List<Object>) upload.metadata().get("nested");
        assertThatThrownBy(() -> returned.add("mutated-accessor")).isInstanceOf(UnsupportedOperationException.class);
        assertThat(MediaUploadRequestFingerprint.compute(upload)).isEqualTo(digest);
    }

    @Test
    void unsupportedMetadataTypesFailClosed() {
        assertThatThrownBy(() -> request("clip.bin", "principal-a", Map.of("set", java.util.Set.of("x"))))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void uploadRetentionRejectsPrecisionThatStorageCannotPreserve() {
        assertThatThrownBy(() -> new UploadRequest("tenant-a", "principal-a", "clip.bin",
                "application/octet-stream", 4, "0".repeat(64), "RESTRICTED",
                Duration.ofNanos(1), Map.of()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("millisecond precision");
    }

    @Test
    void uploadClassificationUsesCanonicalValuesAndRejectsUnknownClaims() {
        assertThat(request("clip.bin", "principal-a", Map.of()).classification()).isEqualTo("RESTRICTED");
        assertThatThrownBy(() -> new UploadRequest("tenant-a", "principal-a", "clip.bin",
                "application/octet-stream", 4, "0".repeat(64), "SECRET", Duration.ofMinutes(3), Map.of()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("PUBLIC, INTERNAL, CONFIDENTIAL, or RESTRICTED");
        for (String noncanonical : List.of("restricted", " RESTRICTED")) {
            assertThatThrownBy(() -> new UploadRequest("tenant-a", "principal-a", "clip.bin",
                    "application/octet-stream", 4, "0".repeat(64), noncanonical, Duration.ofMinutes(3), Map.of()))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("classification must be");
        }
    }

    private static UploadRequest request(String fileName, String principalId, Map<String, Object> metadata) {
        return new UploadRequest("tenant-a", principalId, fileName, "application/octet-stream", 4,
                "0".repeat(64), "RESTRICTED", Duration.ofMinutes(3), metadata);
    }
}
