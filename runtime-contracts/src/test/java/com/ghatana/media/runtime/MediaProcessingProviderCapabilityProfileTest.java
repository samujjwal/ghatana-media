package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaProcessingProviderCapabilityProfileTest {

    @Test
    void defaultProfilesDoNotInferFeaturesAndDiagnosticProviderCanStillBeReady() {
        MediaProcessingProvider provider = new TestProvider(false, Set.of(JobType.SPEECH_TO_TEXT));

        assertThat(provider.ready()).isTrue();
        assertThat(provider.productionEligible()).isFalse();
        assertThat(provider.capabilityProfiles()).isEmpty();
        assertThat(provider.health().status()).isEqualTo(MediaModalityContracts.ProviderHealthStatus.DEGRADED);
        assertThat(provider.health().reason()).contains("not an observed modality health report");
        assertThatCode(provider::verifyReady).doesNotThrowAnyException();
    }

    @Test
    void measuredQualityIsOptionalSourceEvidenceNotProviderAdmission() {
        MediaProcessingProvider diagnostic = new TestProvider(false, Set.of(JobType.SPEECH_TO_TEXT));
        assertThat(diagnostic.qualityObservation(JobType.SPEECH_TO_TEXT, "model-v1")).isEmpty();

        Instant observed = Instant.now().minusSeconds(10);
        var evidence = new MediaModalityContracts.ProviderQualityObservation(
                "test-provider", "provider-v1", JobType.SPEECH_TO_TEXT, "model-v1",
                MediaModalityContracts.ProviderQualityObservation.Metric.WER,
                1.0938, observed, "a".repeat(64));
        // WER may exceed one due to insertions: measured failure is not a parsing error.
        assertThat(evidence.measuredValue()).isEqualTo(1.0938);
        assertThat(evidence.reportSha256()).hasSize(64);
        assertThat(diagnostic.productionEligible()).isFalse();

        assertThatThrownBy(() -> new MediaModalityContracts.ProviderQualityObservation(
                "test-provider", "provider-v1", JobType.SPEECH_TO_TEXT, "model-v1",
                MediaModalityContracts.ProviderQualityObservation.Metric.WER,
                Double.NaN, observed, "a".repeat(64)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MediaModalityContracts.ProviderQualityObservation(
                "test-provider", "provider-v1", JobType.SPEECH_TO_TEXT, "model-v1",
                MediaModalityContracts.ProviderQualityObservation.Metric.WER,
                0.4, observed, "not-a-source-digest"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MediaModalityContracts.ProviderQualityObservation(
                "test-provider", "provider-v1", JobType.SPEECH_TO_TEXT, "model-v1",
                MediaModalityContracts.ProviderQualityObservation.Metric.WER,
                0.4, Instant.now().plusSeconds(120), "a".repeat(64)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void productionProviderRequiresExplicitProfilesForEveryDeclaredModality() {
        MediaProcessingProvider missing = new TestProvider(true, Set.of(JobType.SPEECH_TO_TEXT));

        assertThatThrownBy(missing::verifyReady)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("explicit observed capability profiles");

        MediaProcessingProvider partial = new TestProvider(true,
                Set.of(JobType.SPEECH_TO_TEXT, JobType.VISION), List.of(observedSpeechProfile()));
        assertThatThrownBy(partial::verifyReady)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("do not exactly match declared modalities");

        MediaProcessingProvider complete = new TestProvider(true,
                Set.of(JobType.SPEECH_TO_TEXT), List.of(observedSpeechProfile()));
        assertThatCode(complete::verifyReady).doesNotThrowAnyException();
    }

    @Test
    void productionProviderRejectsCompatibilityProfileWithoutObservedHealthyStatus() {
        MediaModalityContracts.CapabilityProfile compatibilityProfile = new MediaModalityContracts.CapabilityProfile(
                "test-provider", "provider-v1", JobType.SPEECH_TO_TEXT,
                Set.of("pcm_s16le"), Set.of("wav"), Set.of(16_000), 0, 0,
                Set.of("model-v1"), Set.of("local"), ProcessingBoundary.LOCAL,
                true, true, false);
        MediaProcessingProvider provider = new TestProvider(true,
                Set.of(JobType.SPEECH_TO_TEXT), List.of(compatibilityProfile));

        assertThat(compatibilityProfile.health().status())
                .isEqualTo(MediaModalityContracts.ProviderHealthStatus.UNAVAILABLE);
        assertThatThrownBy(provider::verifyReady)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("explicitly healthy");
    }

    @Test
    void productionProviderRejectsHealthyProfileFromAnotherProviderIdentity() {
        MediaProcessingProvider provider = new TestProvider(true,
                Set.of(JobType.SPEECH_TO_TEXT), List.of(observedSpeechProfile("other-provider", "other-v2")));

        assertThatThrownBy(provider::verifyReady)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("profile identity does not match provider identity");
    }

    private static MediaModalityContracts.CapabilityProfile observedSpeechProfile() {
        return observedSpeechProfile("test-provider", "provider-v1");
    }

    private static MediaModalityContracts.CapabilityProfile observedSpeechProfile(
            String providerId, String providerVersion) {
        var health = new MediaModalityContracts.ProviderHealth(
                providerId, providerVersion, MediaModalityContracts.ProviderHealthStatus.HEALTHY,
                MediaModalityContracts.DegradationPolicy.FAIL_CLOSED, "observed fixture", Instant.now());
        return new MediaModalityContracts.CapabilityProfile(
                providerId, providerVersion, JobType.SPEECH_TO_TEXT,
                Set.of("pcm_s16le"), Set.of("wav"), Set.of(16_000), 0, 0,
                Set.of("model-v1"), Set.of("local"), ProcessingBoundary.LOCAL,
                true, true, false, health,
                MediaModalityContracts.DegradationPolicy.FAIL_CLOSED,
                MediaModalityContracts.ExecutionBounds.defaults());
    }

    private static final class TestProvider implements MediaProcessingProvider {
        private final boolean productionEligible;
        private final Set<JobType> capabilities;
        private final List<MediaModalityContracts.CapabilityProfile> profiles;

        private TestProvider(boolean productionEligible, Set<JobType> capabilities) {
            this(productionEligible, capabilities, null);
        }

        private TestProvider(boolean productionEligible, Set<JobType> capabilities,
                             List<MediaModalityContracts.CapabilityProfile> profiles) {
            this.productionEligible = productionEligible;
            this.capabilities = capabilities;
            this.profiles = profiles;
        }

        @Override public String providerId() { return "test-provider"; }
        @Override public String providerVersion() { return "provider-v1"; }
        @Override public Set<JobType> capabilities() { return capabilities; }
        @Override public List<MediaModalityContracts.CapabilityProfile> capabilityProfiles() {
            return profiles == null ? MediaProcessingProvider.super.capabilityProfiles() : profiles;
        }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return productionEligible; }
        @Override public int priority() { return 0; }
        @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            return CompletableFuture.completedFuture(Map.of());
        }
    }
}
