package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaModalityContracts.ContextReference;
import com.ghatana.media.runtime.MediaRuntimeContracts.AutomationRisk;
import com.ghatana.media.runtime.MediaRuntimeContracts.BiometricSensitivity;
import com.ghatana.media.runtime.MediaRuntimeContracts.ConsentDecision;
import com.ghatana.media.runtime.MediaRuntimeContracts.DataClassification;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaModalityContractsTest {

    @Test
    void speechResultCarriesProviderModelProvenanceClassificationAndRetention() {
        Map<String, Object> result = MediaModalityContracts.governedResult(
                request(JobType.SPEECH_TO_TEXT, governance(false), Map.of()), artifact(),
                "local-stt", "adapter-v2", "whisper-v3", Map.of("text", "hello"),
                ConsentDecision.unverified());

        assertThat(result)
                .containsEntry("language", "undetermined")
                .containsEntry("providerId", "local-stt")
                .containsEntry("providerVersion", "adapter-v2")
                .containsEntry("modelVersion", "whisper-v3")
                .containsEntry("modality", "SPEECH_TO_TEXT")
                .containsEntry("classification", "CONFIDENTIAL")
                .containsEntry("retentionPolicy", "short-lived-media");
        assertThat((List<?>) result.get("provenanceRefs")).hasSize(3);
    }

    @Test
    void eachDeclaredModalityRequiresItsGroundedPayloadShape() {
        assertThat(MediaModalityContracts.governedResult(
                request(JobType.TEXT_TO_SPEECH, governance(false), Map.of("voice", "en-US")), artifact(),
                "tts", "v1", "voice-v1", Map.of("audioArtifactRef", "urn:ghatana:audio:1"),
                ConsentDecision.unverified()))
                .containsEntry("modality", "TEXT_TO_SPEECH");

        assertThat(MediaModalityContracts.governedResult(
                request(JobType.VISION, governance(false), Map.of()), artifact(),
                "vision", "v1", "vision-v1", Map.of("detections", List.of(Map.of("label", "person"))),
                ConsentDecision.unverified()))
                .containsEntry("modality", "VISION");

        assertThat(MediaModalityContracts.governedResult(
                request(JobType.MULTIMODAL, governance(false), Map.of()), artifact(),
                "multimodal", "v1", "multi-v1", Map.of("observations", List.of("audio", "image")),
                ConsentDecision.unverified()))
                .containsEntry("modality", "MULTIMODAL");

        assertThatThrownBy(() -> MediaModalityContracts.governedResult(
                request(JobType.VISION, governance(false), Map.of()), artifact(),
                "vision", "v1", "vision-v1", Map.of("text", "invented detection"),
                ConsentDecision.unverified()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("text completion");
    }

    @Test
    void externalModalityResultRequiresMatchingActiveConsentAndRegion() {
        MediaGovernanceContext governance = new MediaGovernanceContext(
                "consent-1", "media-analysis", DataClassification.CONFIDENTIAL, "us-west-2",
                Set.of("us-west-2"), true, "short-lived-media", true, false, "",
                BiometricSensitivity.NONE, AutomationRisk.ASSISTIVE);
        ConsentDecision consent = new ConsentDecision(
                true, "consent-authority", "consent-1", Instant.now(), Instant.now().plusSeconds(60),
                Set.of("media-analysis"), Set.of("us-west-2"), true, false);

        assertThat(MediaModalityContracts.governedResult(
                request(JobType.SPEECH_TO_TEXT, governance, Map.of()), artifact(),
                "remote-stt", "v2", "whisper-v3", Map.of("text", "grounded"), consent,
                ProcessingBoundary.EXTERNAL, ProviderDataRetention.NONE))
                .containsEntry("modality", "SPEECH_TO_TEXT")
                .containsEntry("providerId", "remote-stt");

        assertThatThrownBy(() -> MediaModalityContracts.governedResult(
                request(JobType.SPEECH_TO_TEXT, governance, Map.of()), artifact(),
                "remote-stt", "v2", "whisper-v3", Map.of("text", "grounded"),
                ConsentDecision.unverified(), ProcessingBoundary.EXTERNAL, ProviderDataRetention.NONE))
                .isInstanceOf(SecurityException.class)
                .hasMessageContaining("active verified consent");
    }

    @Test
    void resultShapeAndProviderIdentityAreBounded() {
        assertThatThrownBy(() -> MediaModalityContracts.governedResult(
                request(JobType.SPEECH_TO_TEXT, governance(false), Map.of()), artifact(),
                "stt", "v1", "model-v1", Map.of("text", "x".repeat(16_385)),
                ConsentDecision.unverified()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("string is too long");

        assertThatThrownBy(() -> new MediaModalityContracts.CapabilityProfile(
                "provider", "v1", JobType.VISION, Set.of("raw"), Set.of("png"), Set.of(),
                1920, 1080, Set.of("vision-v1"), Set.of("us-west-2"), ProcessingBoundary.LOCAL,
                false, true, false,
                new MediaModalityContracts.ProviderHealth(
                        "other-provider", "v1", MediaModalityContracts.ProviderHealthStatus.DEGRADED,
                        MediaModalityContracts.DegradationPolicy.FAIL_CLOSED, "outage", Instant.now()),
                MediaModalityContracts.DegradationPolicy.FAIL_CLOSED,
                MediaModalityContracts.ExecutionBounds.defaults()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("identity");
    }

    @Test
    void biometricVisionOutputRequiresAuthorityOwnedEligibility() {
        assertThatThrownBy(() -> MediaModalityContracts.governedResult(
                request(JobType.VISION, governance(false), Map.of()), artifact(),
                "vision", "v1", "model-v1", Map.of("faceCount", 1),
                ConsentDecision.unverified()))
                .isInstanceOf(SecurityException.class)
                .hasMessageContaining("biometric eligibility");

        MediaGovernanceContext eligible = governance(true);
        ConsentDecision consent = new ConsentDecision(
                true, "consent-authority", "consent-1", Instant.now(), Instant.now().plusSeconds(60),
                Set.of("media-analysis"), Set.of("us-west-2"), true, true);
        assertThat(MediaModalityContracts.governedResult(
                request(JobType.VISION, eligible, Map.of()), artifact(),
                "vision", "v1", "model-v1", Map.of("faceCount", 1), consent))
                .containsEntry("classification", "CONFIDENTIAL");
    }

    @Test
    void multimodalContextIsTypedBoundedAndPurposeLimited() {
        ContextReference wrongPurpose = new ContextReference(
                "urn:ghatana:context:1", "different-purpose", DataClassification.CONFIDENTIAL,
                Instant.now().plusSeconds(60));
        assertThatThrownBy(() -> MediaModalityContracts.governedResult(
                request(JobType.MULTIMODAL, governance(false),
                        Map.of("contextReferences", List.of(wrongPurpose))),
                artifact(), "multi", "v1", "model-v1", Map.of(), ConsentDecision.unverified()))
                .isInstanceOf(SecurityException.class)
                .hasMessageContaining("purpose");
    }

    private static ProcessingJobRequest request(
            JobType type, MediaGovernanceContext governance, Map<String, Object> parameters) {
        return new ProcessingJobRequest(
                "request-1", "tenant-a", "principal-a", "correlation-1", "artifact-1",
                type, "", parameters, governance);
    }

    private static MediaGovernanceContext governance(boolean biometric) {
        return new MediaGovernanceContext(
                biometric ? "consent-1" : "", "media-analysis", DataClassification.CONFIDENTIAL,
                "us-west-2", Set.of("us-west-2"), biometric, "short-lived-media", biometric,
                biometric, biometric ? "explicit-consent" : "",
                biometric ? BiometricSensitivity.DERIVED : BiometricSensitivity.NONE,
                AutomationRisk.ASSISTIVE);
    }

    private static MediaArtifact artifact() {
        return new MediaArtifact(
                "tenant-a", "principal-a", "artifact-1", "clip.wav", "audio/wav", 4,
                "a".repeat(64), "s3://opaque/artifact", "confidential", Instant.now(),
                Instant.now().plusSeconds(600), Map.of());
    }
}
