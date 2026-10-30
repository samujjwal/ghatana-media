package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaModalityContracts;
import com.ghatana.media.runtime.MediaRuntimeContracts;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

import static org.assertj.core.api.Assertions.assertThat;

/** Production metrics call through the real MediaRuntime to the source-owned provider SPI. */
class MediaRuntimeProviderQualityMetricsTest {

    @Test
    void publishesSourceOwnedMeasuredQualityFreshnessWithoutQualifyingTheProvider() throws Exception {
        Instant checkedAt = Instant.now();
        var provider = new QualityProvider(checkedAt);
        Instant measuredAt = checkedAt.minusSeconds(15);
        provider.source = new MediaModalityContracts.ProviderQualityObservation(
                "quality-test", "quality-test-v1", JobType.SPEECH_TO_TEXT, "model-r1",
                MediaModalityContracts.ProviderQualityObservation.Metric.WER,
                1.0938, measuredAt, "a".repeat(64));
        try (var runtime = runtime(provider)) {
            String scraped = qualityLine(runtime.prometheusMetrics());
            assertThat(scraped).contains("provider_id=\"quality-test\"",
                    "model_revision=\"model-r1\"", Double.toString(measuredAt.getEpochSecond()));
            assertThat(scraped).doesNotContain("NaN");
            assertThat(provider.productionEligible()).isFalse();
            assertThat(provider.source.measuredValue()).isEqualTo(1.0938);
        }
    }

    @Test
    void missingAndMismatchedQualityRemainNanWhileReadinessMayBeHealthy() throws Exception {
        var provider = new QualityProvider(Instant.now());
        try (var runtime = runtime(provider)) {
            assertThat(qualityLine(runtime.prometheusMetrics())).endsWith(" NaN");

            provider.source = new MediaModalityContracts.ProviderQualityObservation(
                    "another-provider", "quality-test-v1", JobType.SPEECH_TO_TEXT, "model-r1",
                    MediaModalityContracts.ProviderQualityObservation.Metric.WER,
                    0.4, provider.checkedAt.minusSeconds(10), "b".repeat(64));
            provider.checkedAt = provider.checkedAt.plusSeconds(1);
            assertThat(qualityLine(runtime.prometheusMetrics())).endsWith(" NaN");
            assertThat(runtime.prometheusMetrics())
                    .contains("media_provider_profile_readiness{");
        }
    }

    private static String qualityLine(String scrape) {
        return scrape.lines()
                .filter(line -> line.startsWith(
                        "media_provider_quality_observation_timestamp_seconds{"))
                .findFirst().orElseThrow();
    }

    private static MediaRuntime runtime(QualityProvider provider) throws Exception {
        var root = Files.createTempDirectory("media-provider-quality-");
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(false),
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                MediaSemanticRedactionRuntime.disabled(Duration.ofSeconds(2)),
                MediaLifecyclePublisher.disabled(),
                List.of(provider),
                List.of(),
                List.of());
    }

    private static final class QualityProvider implements MediaProcessingProvider {
        private volatile Instant checkedAt;
        private volatile MediaModalityContracts.ProviderQualityObservation source;

        private QualityProvider(Instant checkedAt) { this.checkedAt = checkedAt; }

        @Override public String providerId() { return "quality-test"; }
        @Override public String providerVersion() { return "quality-test-v1"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.SPEECH_TO_TEXT); }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 0; }
        @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            return CompletableFuture.completedFuture(Map.of());
        }
        @Override public List<MediaModalityContracts.CapabilityProfile> capabilityProfiles() {
            var health = new MediaModalityContracts.ProviderHealth(
                    providerId(), providerVersion(),
                    MediaModalityContracts.ProviderHealthStatus.HEALTHY,
                    MediaModalityContracts.DegradationPolicy.LOCAL_DIAGNOSTIC_ONLY,
                    "observed test-only readiness", checkedAt);
            return List.of(new MediaModalityContracts.CapabilityProfile(
                    providerId(), providerVersion(), JobType.SPEECH_TO_TEXT,
                    Set.of("pcm_s16le"), Set.of("wav"), Set.of(16_000), 0, 0,
                    Set.of("model-r1"), Set.of("local"), ProcessingBoundary.LOCAL,
                    false, false, false, health,
                    MediaModalityContracts.DegradationPolicy.LOCAL_DIAGNOSTIC_ONLY,
                    MediaModalityContracts.ExecutionBounds.defaults()));
        }
        @Override public Optional<MediaModalityContracts.ProviderQualityObservation> qualityObservation(
                JobType modality, String modelRevision) {
            return Optional.ofNullable(source);
        }
    }
}
