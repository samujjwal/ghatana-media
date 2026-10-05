package com.ghatana.media.runtime;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaPrivacySanitizersTest {

    @Test
    void biometricGovernanceRequiresExplicitBasisAndRetentionPolicy() {
        assertThatThrownBy(() -> new MediaRuntimeContracts.MediaGovernanceContext(
                "consent-1", "face-match", MediaRuntimeContracts.DataClassification.RESTRICTED,
                "us", Set.of("us-west-2"), true, "service-default", false,
                true, "explicit-consent", MediaRuntimeContracts.BiometricSensitivity.TEMPLATE,
                MediaRuntimeContracts.AutomationRisk.CONSEQUENTIAL))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("biometric retentionPolicy");
    }

    @Test
    void metadataSanitizerStripsLocationDeviceContainerAndCredentialFields() {
        Map<String, Object> sanitized = MediaMetadataSanitizer.sanitize(Map.of(
                "language", "en",
                "GPS", "37.1,-121.6",
                "device_id", "phone-1",
                "authorization", "Bearer secret",
                "nested", Map.of(
                        "EXIF", Map.of("camera", "x"),
                        "safe", "value")));

        assertThat(sanitized).containsEntry("language", "en");
        assertThat(sanitized).doesNotContainKeys("GPS", "device_id", "authorization");
        Map<?, ?> nested = (Map<?, ?>) sanitized.get("nested");
        assertThat(nested.get("safe")).isEqualTo("value");
        assertThat(nested.containsKey("EXIF")).isFalse();
    }

    @Test
    void resultSanitizerRemovesBiometricRawMediaAndCredentialMaterialButKeepsTranscript() {
        Map<String, Object> sanitized = MediaJobResultSanitizer.sanitize(Map.of(
                "transcript", "hello world",
                "speakerEmbedding", List.of(0.1, 0.2, 0.3),
                "nested", Map.of("voicePrint", "raw-template", "confidence", 0.91),
                "authorization", "Bearer token",
                "frame", new byte[] {1, 2, 3}));

        assertThat(sanitized).containsEntry("transcript", "hello world");
        assertThat(sanitized).doesNotContainKeys("speakerEmbedding", "authorization", "frame");
        Map<?, ?> nested = (Map<?, ?>) sanitized.get("nested");
        assertThat(nested.get("confidence")).isEqualTo(0.91);
        assertThat(nested.containsKey("voicePrint")).isFalse();
        assertThat(sanitized).containsEntry("privacyRedacted", true);
        List<String> redactedFields = ((List<?>) sanitized.get("privacyRedactedFields"))
                .stream().map(String::valueOf).toList();
        assertThat(redactedFields)
                .contains("speakerEmbedding", "nested.voicePrint", "authorization", "frame");
    }

    @Test
    void metadataAndResultsAreBoundedAgainstPathologicalNesting() {
        Map<String, Object> value = Map.of("leaf", "x");
        for (int i = 0; i < 12; i++) value = Map.of("nested", value);
        Map<String, Object> deeplyNested = value;

        assertThatThrownBy(() -> MediaMetadataSanitizer.sanitize(deeplyNested))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("nesting");
        assertThatThrownBy(() -> MediaJobResultSanitizer.sanitize(deeplyNested))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("nesting");
    }
}
