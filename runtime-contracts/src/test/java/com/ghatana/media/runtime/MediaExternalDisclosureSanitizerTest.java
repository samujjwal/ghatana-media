package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.AutomationRisk;
import com.ghatana.media.runtime.MediaRuntimeContracts.BiometricSensitivity;
import com.ghatana.media.runtime.MediaRuntimeContracts.DataClassification;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaExternalDisclosureSanitizerTest {

    @Test
    void requestDisclosureKeepsOnlyOperationParametersAndTypedGovernance() {
        ProcessingJobRequest request = new ProcessingJobRequest(
                "request-a", "tenant-a", "principal-a", "correlation-a", "artifact-a",
                JobType.VISION, "provider-a",
                Map.of(
                        "language", "en",
                        "faceDetection", true,
                        "authorization", "Bearer must-not-cross",
                        "rawTranscript", "private words",
                        "providerParameters", Map.of("apiKey", "must-not-cross")),
                new MediaGovernanceContext(
                        "consent-a", "vision", DataClassification.RESTRICTED, "us", Set.of("us"),
                        true, "biometric-derived-24h/v1", false, true, "explicit-consent",
                        BiometricSensitivity.DERIVED, AutomationRisk.ASSISTIVE));

        Map<String, Object> disclosed = MediaExternalDisclosureSanitizer.request(request);

        assertThat(disclosed).containsOnlyKeys(
                "requestId", "artifactId", "jobType", "parameters", "governance");
        @SuppressWarnings("unchecked")
        Map<String, Object> parameters = (Map<String, Object>) disclosed.get("parameters");
        assertThat(parameters).containsEntry("language", "en").containsEntry("faceDetection", true)
                .doesNotContainKeys("authorization", "rawTranscript", "providerParameters");
        assertThat(disclosed.toString()).doesNotContain("tenant-a", "principal-a", "correlation-a",
                "must-not-cross", "private words", "provider-a");
    }

    @Test
    void artifactDisclosureOmitsFilenamePrincipalAndUnsafeMetadata() {
        MediaArtifact artifact = new MediaArtifact(
                "tenant-a", "principal-a", "artifact-a", "sam-private-name.jpg", "image/jpeg",
                12L, "a".repeat(64), "s3://opaque/artifact-a", "CONFIDENTIAL",
                Instant.now(), Instant.now().plusSeconds(60),
                Map.of(
                        "width", 640,
                        "height", 480,
                        "gps", "private-location",
                        "deviceId", "private-device",
                        "token", "must-not-cross"));

        Map<String, Object> disclosed = MediaExternalDisclosureSanitizer.artifact(artifact);

        assertThat(disclosed).containsOnlyKeys(
                "artifactId", "contentType", "sizeBytes", "sha256", "objectReference",
                "classification", "metadata");
        @SuppressWarnings("unchecked")
        Map<String, Object> metadata = (Map<String, Object>) disclosed.get("metadata");
        assertThat(metadata).containsEntry("width", 640).containsEntry("height", 480)
                .doesNotContainKeys("gps", "deviceId", "token");
        assertThat(disclosed.toString()).doesNotContain(
                "tenant-a", "principal-a", "sam-private-name", "private-location",
                "private-device", "must-not-cross");
    }

    @Test
    void allowlistedValuesRemainBoundedAndJsonCompatible() {
        ProcessingJobRequest oversized = new ProcessingJobRequest(
                "request-a", "tenant-a", "principal-a", "correlation-a", "artifact-a",
                JobType.SPEECH_TO_TEXT, "", Map.of("language", "x".repeat(65_537)),
                MediaGovernanceContext.compatibilityDefault());

        assertThatThrownBy(() -> MediaExternalDisclosureSanitizer.request(oversized))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("string bound")
                .hasMessageNotContaining("x".repeat(32));
    }
}
