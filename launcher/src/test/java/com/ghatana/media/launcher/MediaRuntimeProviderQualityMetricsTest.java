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
            String scrape = runtime.prometheusMetrics();
            String scraped = qualityLine(scrape);
            assertThat(scraped).contains("provider_id=\"quality-test\"",
                    "model_revision=\"model-r1\"");
            assertThat(scraped).doesNotContain("NaN");
            double exportedTimestamp = Double.parseDouble(scraped.substring(scraped.lastIndexOf(' ') + 1));
            assertThat(exportedTimestamp).isBetween(
                    (double) measuredAt.getEpochSecond(), (double) measuredAt.getEpochSecond() + 1.0);
            String measuredSeries = scrape.lines()
                    .filter(line -> line.startsWith("media_provider_quality_measured_value{"))
                    .findFirst().orElseThrow();
            assertThat(measuredSeries).contains("provider_id=\"quality-test\"",
                    "model_revision=\"model-r1\"", "locale=\"aggregate\"",
                    "metric=\"wer\"", "scope=\"reference_only\"");
            assertThat(measuredSeries).endsWith(" 1.0938");
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

    @Test
    void exportsBoundedPerLocaleQualityRowsAndClearsThemWhenEvidenceDisappears() throws Exception {
        Instant checkedAt = Instant.now();
        var provider = new QualityProvider(checkedAt);
        Instant measuredAt = checkedAt.minusSeconds(15);
        var scope = MediaModalityContracts.ProviderQualityObservation.QualityScope.INDEPENDENT_QUALIFIED;
        provider.rows = List.of(
                qualityRow("eng", MediaModalityContracts.ProviderQualityObservation.Metric.WER,
                        0.21, measuredAt, scope),
                qualityRow("eng", MediaModalityContracts.ProviderQualityObservation.Metric.CER,
                        0.08, measuredAt, scope),
                qualityRow("eng", MediaModalityContracts.ProviderQualityObservation.Metric.WER_CI95_UPPER,
                        0.27, measuredAt, scope),
                qualityRow("hin", MediaModalityContracts.ProviderQualityObservation.Metric.WER,
                        0.38, measuredAt, scope),
                qualityRow("hin", MediaModalityContracts.ProviderQualityObservation.Metric.CER,
                        0.16, measuredAt, scope),
                qualityRow("npi", MediaModalityContracts.ProviderQualityObservation.Metric.WER,
                        0.49, measuredAt, scope),
                qualityRow("npi", MediaModalityContracts.ProviderQualityObservation.Metric.CER,
                        0.19, measuredAt, scope));

        try (var runtime = runtime(provider)) {
            String scrape = runtime.prometheusMetrics();
            assertQualityMetric(scrape, "eng", "wer", "independent_qualified", "0.21");
            assertQualityMetric(scrape, "eng", "cer", "independent_qualified", "0.08");
            assertQualityMetric(scrape, "eng", "wer_ci95_upper", "independent_qualified", "0.27");
            assertQualityMetric(scrape, "hin", "wer", "independent_qualified", "0.38");
            assertQualityMetric(scrape, "hin", "cer", "independent_qualified", "0.16");
            assertQualityMetric(scrape, "npi", "wer", "independent_qualified", "0.49");
            assertQualityMetric(scrape, "npi", "cer", "independent_qualified", "0.19");
            assertThat(scrape).doesNotContain("report_sha256", "transcript", "tenant_id");

            provider.checkedAt = provider.checkedAt.plusSeconds(1);
            provider.rows = List.of();
            String emptyRefresh = runtime.prometheusMetrics();
            assertPreviousQualityRowsAreNaN(scrape, emptyRefresh);

            provider.checkedAt = provider.checkedAt.plusSeconds(1);
            provider.rows = List.of(qualityRow("npi",
                    MediaModalityContracts.ProviderQualityObservation.Metric.WER,
                    0.1, measuredAt, scope, "another-provider"));
            String mismatchedRefresh = runtime.prometheusMetrics();
            assertPreviousQualityRowsAreNaN(scrape, mismatchedRefresh);
        }
    }

    @Test
    void failedProfilePollInvalidatesPriorReadinessAndQualityButKeepsLastCheckTime() throws Exception {
        Instant checkedAt = Instant.now();
        var provider = new QualityProvider(checkedAt);
        Instant measuredAt = checkedAt.minusSeconds(15);
        provider.source = new MediaModalityContracts.ProviderQualityObservation(
                "quality-test", "quality-test-v1", JobType.SPEECH_TO_TEXT, "model-r1",
                MediaModalityContracts.ProviderQualityObservation.Metric.WER,
                0.2, measuredAt, "a".repeat(64));
        provider.rows = List.of(qualityRow("eng",
                MediaModalityContracts.ProviderQualityObservation.Metric.WER,
                0.2, measuredAt,
                MediaModalityContracts.ProviderQualityObservation.QualityScope.REFERENCE_ONLY));

        try (var runtime = runtime(provider)) {
            String before = runtime.prometheusMetrics();
            assertThat(metricLine(before, "media_provider_profile_readiness")).doesNotContain("NaN");
            assertThat(qualityLine(before)).doesNotContain("NaN");
            assertThat(qualityMetricLine(before, "eng", "wer", "reference_only")).endsWith(" 0.2");

            provider.failProfiles = true;
            String after = runtime.prometheusMetrics();

            assertThat(metricLine(after, "media_provider_profile_readiness")).endsWith(" NaN");
            assertThat(qualityLine(after)).endsWith(" NaN");
            assertThat(qualityMetricLine(after, "eng", "wer", "reference_only")).endsWith(" NaN");
            String checkedAtLine = metricLine(after, "media_provider_profile_checked_at_seconds");
            double retainedCheckedAt = Double.parseDouble(
                    checkedAtLine.substring(checkedAtLine.lastIndexOf(' ') + 1));
            assertThat(retainedCheckedAt).isBetween(
                    (double) checkedAt.getEpochSecond(), (double) checkedAt.getEpochSecond() + 1.0);
        }
    }

    @Test
    void emptyProfileSnapshotInvalidatesPriorReadinessAndQuality() throws Exception {
        Instant checkedAt = Instant.now();
        var provider = new QualityProvider(checkedAt);
        Instant measuredAt = checkedAt.minusSeconds(15);
        provider.source = new MediaModalityContracts.ProviderQualityObservation(
                "quality-test", "quality-test-v1", JobType.SPEECH_TO_TEXT, "model-r1",
                MediaModalityContracts.ProviderQualityObservation.Metric.WER,
                0.2, measuredAt, "a".repeat(64));
        provider.rows = List.of(qualityRow("eng",
                MediaModalityContracts.ProviderQualityObservation.Metric.WER,
                0.2, measuredAt,
                MediaModalityContracts.ProviderQualityObservation.QualityScope.REFERENCE_ONLY));

        try (var runtime = runtime(provider)) {
            String before = runtime.prometheusMetrics();
            assertThat(qualityMetricLine(before, "eng", "wer", "reference_only")).endsWith(" 0.2");

            provider.returnEmptyProfiles = true;
            String after = runtime.prometheusMetrics();

            assertThat(metricLine(after, "media_provider_profile_readiness")).endsWith(" NaN");
            assertThat(qualityLine(after)).endsWith(" NaN");
            assertThat(qualityMetricLine(after, "eng", "wer", "reference_only")).endsWith(" NaN");
        }
    }

    private static MediaModalityContracts.ProviderQualityObservation qualityRow(
            String locale, MediaModalityContracts.ProviderQualityObservation.Metric metric,
            double value, Instant measuredAt,
            MediaModalityContracts.ProviderQualityObservation.QualityScope scope) {
        return qualityRow(locale, metric, value, measuredAt, scope, "quality-test");
    }

    private static MediaModalityContracts.ProviderQualityObservation qualityRow(
            String locale, MediaModalityContracts.ProviderQualityObservation.Metric metric,
            double value, Instant measuredAt,
            MediaModalityContracts.ProviderQualityObservation.QualityScope scope,
            String providerId) {
        return new MediaModalityContracts.ProviderQualityObservation(
                providerId, "quality-test-v1", JobType.SPEECH_TO_TEXT, "model-r1",
                metric, value, measuredAt, "a".repeat(64), locale, scope);
    }

    private static void assertQualityMetric(
            String scrape, String locale, String metric, String scope, String value) {
        String line = qualityMetricLine(scrape, locale, metric, scope);
        assertThat(line).endsWith(" " + value);
        assertThat(line).contains("provider_id=\"quality-test\"", "model_revision=\"model-r1\"");
    }

    private static void assertPreviousQualityRowsAreNaN(String originalScrape, String refreshedScrape) {
        List<String> refreshedLines = originalScrape.lines()
                .filter(line -> line.startsWith("media_provider_quality_measured_value{"))
                .map(MediaRuntimeProviderQualityMetricsTest::withoutSampleValue)
                .map(series -> refreshedScrape.lines()
                        .filter(line -> line.startsWith(series + " "))
                        .findFirst().orElseThrow())
                .toList();
        assertThat(refreshedLines).hasSize(7);
        assertThat(refreshedLines).allSatisfy(line -> assertThat(line).endsWith(" NaN"));
    }

    private static String withoutSampleValue(String line) {
        return line.substring(0, line.lastIndexOf(' '));
    }

    private static String qualityMetricLine(String scrape, String locale, String metric, String scope) {
        return scrape.lines()
                .filter(line -> line.startsWith("media_provider_quality_measured_value{"))
                .filter(line -> line.contains("locale=\"" + locale + "\""))
                .filter(line -> line.contains("metric=\"" + metric + "\""))
                .filter(line -> line.contains("scope=\"" + scope + "\""))
                .findFirst().orElseThrow();
    }

    private static String qualityLine(String scrape) {
        return scrape.lines()
                .filter(line -> line.startsWith(
                        "media_provider_quality_observation_timestamp_seconds{"))
                .findFirst().orElseThrow();
    }

    private static String metricLine(String scrape, String metricName) {
        return scrape.lines().filter(line -> line.startsWith(metricName + "{"))
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
        private volatile List<MediaModalityContracts.ProviderQualityObservation> rows = List.of();
        private volatile boolean failProfiles;
        private volatile boolean returnEmptyProfiles;

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
            if (failProfiles) throw new IllegalStateException("source profile poll unavailable");
            if (returnEmptyProfiles) return List.of();
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
        @Override public List<MediaModalityContracts.ProviderQualityObservation> qualityObservations(
                JobType modality, String modelRevision) {
            return rows.isEmpty() ? MediaProcessingProvider.super.qualityObservations(modality, modelRevision)
                    : rows;
        }
    }
}
