package com.ghatana.audiovideo.observability;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.micrometer.core.instrument.Timer;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import io.micrometer.prometheusmetrics.PrometheusConfig;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import org.junit.jupiter.api.Test;

import java.util.concurrent.TimeUnit;
import java.time.Instant;

class MediaWorkflowMetricsTest {
    @Test
    void captureFrameCountersUseFixedLabelsAndKeepUnknownDistinct() {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        try {
            MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "launcher");
            metrics.recordCaptureFrame(MediaWorkflowMetrics.CaptureKind.AUDIO,
                    MediaWorkflowMetrics.Outcome.SUCCESS);
            metrics.recordCaptureFrame(MediaWorkflowMetrics.CaptureKind.VIDEO,
                    MediaWorkflowMetrics.Outcome.UNKNOWN);

            String scrape = registry.scrape();
            assertThat(scrape).contains(
                    "media_capture_frames_total{contract_version=\"v1\",kind=\"audio\",outcome=\"success\",service=\"launcher\"} 1.0",
                    "media_capture_frames_total{contract_version=\"v1\",kind=\"video\",outcome=\"unknown\",service=\"launcher\"} 1.0");
            assertThat(scrape).doesNotContain("session_id", "source_id", "tenant_id", "provider_id");
        } finally {
            registry.close();
        }
    }

    @Test
    void prometheusScrapePreservesUnknownQualityAsNanWithoutIdentityLabels() {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        try {
            MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "stt");
            Instant checkedAt = Instant.parse("2026-11-05T12:00:00Z");
            assertThat(metrics.recordProviderProfile(MediaWorkflowMetrics.Modality.STT,
                    new MediaWorkflowMetrics.ProviderProfileObservation(
                            "scrape-fixture", "fixture-v1", "unqualified-profile", "fixture-revision",
                            MediaWorkflowMetrics.ProviderReadiness.HEALTHY, checkedAt, null))).isTrue();

            String scrape = registry.scrape();

            assertThat(java.util.regex.Pattern.compile(
                    "(?m)^media_provider_profile_readiness\\{[^}]*provider_id=\"scrape-fixture\"[^}]*} 1\\.0$")
                    .matcher(scrape).find()).isTrue();
            assertThat(scrape).contains("media_provider_quality_observation_timestamp_seconds{");
            assertThat(java.util.regex.Pattern.compile(
                    "(?m)^media_provider_quality_observation_timestamp_seconds\\{[^}]*provider_id=\"scrape-fixture\"[^}]*} NaN$")
                    .matcher(scrape).find()).isTrue();
            assertThat(scrape).doesNotContain(
                    "tenant_id", "principal_id", "request_id", "job_id", "attempt_id",
                    "credential", "password", "bearer", "token");
            assertThat(scrape).doesNotContain("independent_qualified", "reference_only");
        } finally {
            registry.close();
        }
    }

    @Test
    void recordsBoundedWorkflowEventsStagesAndTenantAgnosticGauges() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "launcher");

        metrics.record(MediaWorkflowMetrics.Event.UNKNOWN);
        metrics.record(MediaWorkflowMetrics.Event.RETRY);
        metrics.record(MediaWorkflowMetrics.Event.FENCED);
        metrics.record(MediaWorkflowMetrics.Event.DENIED);
        metrics.record(MediaWorkflowMetrics.Event.PUBLICATION_AMBIGUOUS);
        metrics.recordRequest();
        var sample = metrics.startTimer();
        metrics.stopTimer(sample, MediaWorkflowMetrics.Stage.PROVIDER);
        metrics.setQueueDepth(7);
        metrics.setUnknownBacklog(2);
        metrics.setOverdueLeases(1);
        metrics.setAggregateStoreQueriesSupported(true);

        assertThat(registry.get("media.workflow.events").tag("event", "unknown").counter().count())
                .isEqualTo(1);
        assertThat(registry.get("media.workflow.stage.duration").tag("stage", "provider").timer().count())
                .isEqualTo(1);
        assertThat(registry.get("media.workflow.queue.depth").gauge().value()).isEqualTo(7);
        assertThat(registry.get("media.workflow.unknown.backlog").gauge().value()).isEqualTo(2);
        assertThat(registry.get("media.workflow.lease.overdue").gauge().value()).isEqualTo(1);
        assertThat(registry.get("media.workflow.requests").counter().count()).isEqualTo(1);
        assertThat(registry.get("media.workflow.aggregate_store_queries_supported").gauge().value())
                .isEqualTo(1);
        assertThat(registry.getMeters().stream()
                .flatMap(meter -> meter.getId().getTags().stream())
                .map(tag -> tag.getKey()))
                .doesNotContain("tenant", "tenant_id", "request_id", "job_id", "attempt_id", "provider_id");
    }

    @Test
    void clampsNegativeBacklogsAndRejectsUnboundedServiceTags() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "tenant-42");
        metrics.setQueueDepth(-9);
        metrics.setUnknownBacklog(-2);
        metrics.setOverdueLeases(-1);
        metrics.setAggregateStoreQueriesSupported(true);

        assertThat(registry.get("media.workflow.queue.depth").tag("service", "unknown").gauge().value())
                .isNaN();
        assertThat(registry.get("media.workflow.unknown.backlog").gauge().value()).isNaN();
        assertThat(registry.get("media.workflow.lease.overdue").gauge().value()).isNaN();
        assertThat(registry.get("media.workflow.aggregate_store_queries_supported").gauge().value()).isNaN();
    }

    @Test
    void distinguishesMeasuredZeroFromUnknownAndClearsStaleValuesWhenSourceUnavailable() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "launcher");
        var queueDepth = registry.get("media.workflow.queue.depth").gauge();
        var unknownBacklog = registry.get("media.workflow.unknown.backlog").gauge();
        var overdueLeases = registry.get("media.workflow.lease.overdue").gauge();
        var querySupport = registry.get("media.workflow.aggregate_store_queries_supported").gauge();

        assertThat(queueDepth.value()).isNaN();
        assertThat(unknownBacklog.value()).isNaN();
        assertThat(overdueLeases.value()).isNaN();
        assertThat(querySupport.value()).isNaN();

        metrics.setQueueDepth(0);
        metrics.setUnknownBacklog(0);
        metrics.setOverdueLeases(0);
        metrics.setAggregateStoreQueriesSupported(true);

        assertThat(queueDepth.value()).isZero();
        assertThat(unknownBacklog.value()).isZero();
        assertThat(overdueLeases.value()).isZero();
        assertThat(querySupport.value()).isEqualTo(1.0);

        metrics.setAggregateStoreQueriesSupported(false);
        assertThat(queueDepth.value()).isNaN();
        assertThat(unknownBacklog.value()).isNaN();
        assertThat(overdueLeases.value()).isNaN();
        assertThat(querySupport.value()).isZero();

        // A later complete durable refresh must restore measured values and support without
        // carrying the failed refresh's unknown state forward as zero or remaining unavailable.
        metrics.setQueueDepth(0);
        metrics.setUnknownBacklog(3);
        metrics.setOverdueLeases(1);
        metrics.setAggregateStoreQueriesSupported(true);
        assertThat(queueDepth.value()).isZero();
        assertThat(unknownBacklog.value()).isEqualTo(3);
        assertThat(overdueLeases.value()).isEqualTo(1);
        assertThat(querySupport.value()).isEqualTo(1.0);
    }

    @Test
    void distinguishesMeasuredOutboxLeaseZeroFromUnsupportedSource() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "launcher");
        var overdueClaims = registry.get("media.workflow.outbox.lease.overdue").gauge();
        var querySupport = registry.get("media.workflow.outbox.aggregate_store_queries_supported").gauge();

        assertThat(overdueClaims.value()).isNaN();
        assertThat(querySupport.value()).isNaN();

        metrics.setOverdueOutboxClaims(0);
        metrics.setOutboxStoreQueriesSupported(true);
        assertThat(overdueClaims.value()).isZero();
        assertThat(querySupport.value()).isEqualTo(1.0);

        metrics.setOutboxStoreQueriesSupported(false);
        assertThat(overdueClaims.value()).isNaN();
        assertThat(querySupport.value()).isZero();
    }

    @Test
    void adversarialServiceLabelsCollapseToSingleBoundedVocabularyValue() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        for (int i = 0; i < 500; i++) {
            new MediaWorkflowMetrics(registry, "tenant-" + i + "-request-secret-" + i).recordRequest();
        }

        assertThat(registry.get("media.workflow.requests").meters()).hasSize(1);
        assertThat(registry.get("media.workflow.requests").tag("service", "unknown").counter().count())
                .isEqualTo(500);
        assertThat(registry.getMeters().stream()
                .flatMap(meter -> meter.getId().getTags().stream())
                .map(tag -> tag.getValue()))
                .doesNotContainAnyElementsOf(java.util.stream.IntStream.range(0, 500)
                        .mapToObj(i -> "tenant-" + i + "-request-secret-" + i).toList());
    }

    @Test
    void registersLiveRuntimeResourcesWithOnlyBoundedServiceLabels() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        new MediaWorkflowMetrics(registry, "vision");

        assertThat(registry.get("media.runtime.jvm.heap.used.bytes")
                .tag("service", "vision").gauge().value()).isGreaterThanOrEqualTo(0);
        assertThat(registry.get("media.runtime.jvm.heap.committed.bytes")
                .tag("service", "vision").gauge().value()).isGreaterThan(0);
        assertThat(registry.get("media.runtime.jvm.processors.available")
                .tag("service", "vision").gauge().value())
                .isEqualTo(Runtime.getRuntime().availableProcessors());
        assertThat(registry.get("media.runtime.jvm.threads")
                .tag("service", "vision").gauge().value()).isGreaterThan(0);
        double heapMaximum = registry.get("media.runtime.jvm.heap.max.bytes")
                .tag("service", "vision").gauge().value();
        assertThat(Double.isNaN(heapMaximum) || heapMaximum > 0).isTrue();

        assertThat(registry.getMeters().stream()
                .filter(meter -> meter.getId().getName().startsWith("media.runtime."))
                .flatMap(meter -> meter.getId().getTags().stream())
                .map(tag -> tag.getKey()))
                .containsOnly("service", "contract_version");
    }

    @Test
    void providerCredentialShapedIdentitiesAreRejectedWithoutExportingTheValue() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "stt");
        Instant now = Instant.parse("2026-11-05T12:00:00Z");
        String credential = "sk-secret-provider-credential-123";

        assertThatThrownBy(() -> new MediaWorkflowMetrics.ProviderProfileObservation(
                credential, "v1", "profile", "revision",
                MediaWorkflowMetrics.ProviderReadiness.HEALTHY, now, null))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageNotContaining(credential);
        assertThat(metrics.recordProviderQualitySeries(MediaWorkflowMetrics.Modality.STT,
                credential, "v1", "model", now, java.util.List.of())).isFalse();
        assertThat(registry.getMeters().stream()
                .flatMap(meter -> meter.getId().getTags().stream())
                .map(tag -> tag.getValue()))
                .doesNotContain(credential);
    }

    @Test
    void jwtShapedProviderIdentityIsRejectedWithoutExportingTokenSegments() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "stt");
        String token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature-segment";

        assertThatThrownBy(() -> new MediaWorkflowMetrics.ProviderProfileObservation(
                token, "v1", "profile", "revision",
                MediaWorkflowMetrics.ProviderReadiness.HEALTHY,
                Instant.parse("2026-11-06T12:00:00Z"), null))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageNotContaining(token)
                .hasMessageNotContaining("eyJhbGciOiJIUzI1NiJ9");
        assertThat(metrics.recordProviderQualitySeries(MediaWorkflowMetrics.Modality.STT,
                token, "v1", "model", Instant.parse("2026-11-06T12:00:00Z"),
                java.util.List.of())).isFalse();
        assertThat(registry.getMeters().stream()
                .flatMap(meter -> meter.getId().getTags().stream())
                .map(tag -> tag.getValue()))
                .doesNotContain(token, "eyJhbGciOiJIUzI1NiJ9");
    }

    @Test
    void modalityBoundariesRecordMonotonicDurationsWithBoundedPhaseAndOutcomeTags() throws Exception {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "vision");
        assertThat(registry.find("media.modality.boundary.duration").timers()).isEmpty();

        var provider = metrics.startModalityTimer(
                MediaWorkflowMetrics.Modality.STT,
                MediaWorkflowMetrics.Boundary.PROVIDER);
        assertThat(registry.find("media.modality.boundary.duration").timers()).isEmpty();
        Thread.sleep(15);
        metrics.stopModalityTimer(provider, MediaWorkflowMetrics.Outcome.SUCCESS);
        metrics.stopModalityTimer(provider, MediaWorkflowMetrics.Outcome.FAILURE);

        Timer providerTimer = registry.get("media.modality.boundary.duration")
                .tag("modality", "stt")
                .tag("service", "vision")
                .tag("boundary", "provider")
                .tag("execution_class", "model")
                .tag("outcome", "success")
                .timer();
        assertThat(providerTimer.count()).isEqualTo(1);
        assertThat(providerTimer.baseTimeUnit()).isEqualTo(TimeUnit.SECONDS);
        assertThat(providerTimer.totalTime(TimeUnit.MILLISECONDS)).isGreaterThanOrEqualTo(10);

        var uncertainResponse = metrics.startModalityTimer(
                MediaWorkflowMetrics.Modality.VISION,
                MediaWorkflowMetrics.Boundary.RESPONSE);
        metrics.stopModalityTimer(uncertainResponse, MediaWorkflowMetrics.Outcome.UNKNOWN);
        assertThat(registry.get("media.modality.boundary.duration")
                .tag("modality", "vision")
                .tag("service", "vision")
                .tag("boundary", "response")
                .tag("execution_class", "control")
                .tag("outcome", "unknown")
                .timer().count()).isEqualTo(1);
        assertThat(registry.getMeters().stream()
                .filter(meter -> meter.getId().getName().equals("media.modality.boundary.duration"))
                .flatMap(meter -> meter.getId().getTags().stream())
                .map(tag -> tag.getKey()))
                .doesNotContain("tenant", "request_id", "job_id", "provider_id");
    }

    @Test
    void exportsProviderRevisionReadinessAndQualityFreshnessWithoutInventingQuality() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "vision");
        Instant checkedAt = Instant.parse("2026-10-26T12:00:00Z");
        var observation = new MediaWorkflowMetrics.ProviderProfileObservation(
                "vision-cpu", "2.4.1", "detector-cpu", "sha256-abc123",
                MediaWorkflowMetrics.ProviderReadiness.HEALTHY, checkedAt, null);

        assertThat(metrics.recordProviderProfile(MediaWorkflowMetrics.Modality.VISION, observation)).isTrue();
        assertThat(registry.get("media.provider.profile.readiness")
                .tag("service", "vision").tag("provider_id", "vision-cpu")
                .tag("provider_version", "2.4.1").tag("model_profile", "detector-cpu")
                .tag("model_revision", "sha256-abc123").gauge().value()).isEqualTo(1.0);
        assertThat(registry.get("media.provider.profile.checked_at_seconds")
                .tag("provider_id", "vision-cpu").gauge().value()).isEqualTo(checkedAt.getEpochSecond());
        assertThat(registry.get("media.provider.quality.observation_timestamp_seconds")
                .tag("provider_id", "vision-cpu").gauge().value()).isNaN();

        Instant measuredAt = checkedAt.minusSeconds(60);
        Instant degradedCheckedAt = checkedAt.plusSeconds(1);
        assertThat(metrics.recordProviderProfile(MediaWorkflowMetrics.Modality.VISION,
                new MediaWorkflowMetrics.ProviderProfileObservation(
                        "vision-cpu", "2.4.1", "detector-cpu", "sha256-abc123",
                        MediaWorkflowMetrics.ProviderReadiness.DEGRADED, degradedCheckedAt, measuredAt))).isTrue();
        assertThat(registry.get("media.provider.profile.readiness")
                .tag("provider_id", "vision-cpu").gauge().value()).isZero();
        assertThat(registry.get("media.provider.quality.observation_timestamp_seconds")
                .tag("provider_id", "vision-cpu").gauge().value()).isEqualTo(measuredAt.getEpochSecond());
        assertThat(registry.getMeters().stream()
                .filter(meter -> meter.getId().getName().startsWith("media.provider."))
                .flatMap(meter -> meter.getId().getTags().stream())
                .map(tag -> tag.getKey()))
                .doesNotContain("tenant", "tenant_id", "request_id", "job_id", "attempt_id");
    }

    @Test
    void rejectsOutOfOrderAndConflictingEqualTimeProviderObservationsUntilNewerCheck() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "vision");
        Instant newerCheck = Instant.parse("2026-10-26T12:00:10Z");
        var latest = new MediaWorkflowMetrics.ProviderProfileObservation(
                "vision-cpu", "2.4.1", "detector-cpu", "sha256-abc123",
                MediaWorkflowMetrics.ProviderReadiness.DEGRADED, newerCheck, newerCheck.minusSeconds(5));
        var key = MediaWorkflowMetrics.Modality.VISION;

        assertThat(metrics.recordProviderProfile(key, latest)).isTrue();
        assertThat(metrics.recordProviderProfile(key, latest)).isTrue(); // exact duplicate is idempotent
        assertThat(metrics.recordProviderProfile(key, new MediaWorkflowMetrics.ProviderProfileObservation(
                "vision-cpu", "2.4.1", "detector-cpu", "sha256-abc123",
                MediaWorkflowMetrics.ProviderReadiness.HEALTHY, newerCheck, newerCheck))).isFalse();
        assertThat(metrics.recordProviderProfile(key, new MediaWorkflowMetrics.ProviderProfileObservation(
                "vision-cpu", "2.4.1", "detector-cpu", "sha256-abc123",
                MediaWorkflowMetrics.ProviderReadiness.HEALTHY, newerCheck.minusSeconds(1), null))).isFalse();

        assertThat(registry.get("media.provider.profile.readiness")
                .tag("provider_id", "vision-cpu").gauge().value()).isNaN();
        assertThat(registry.get("media.provider.profile.checked_at_seconds")
                .tag("provider_id", "vision-cpu").gauge().value()).isEqualTo(newerCheck.getEpochSecond());
        assertThat(registry.get("media.provider.quality.observation_timestamp_seconds")
                .tag("provider_id", "vision-cpu").gauge().value()).isNaN();
        assertThat(registry.get("media.provider.profile.observation_conflict")
                .tag("provider_id", "vision-cpu").gauge().value()).isEqualTo(1.0);
        assertThat(registry.get("media.provider.profile.observation.rejected")
                .tag("service", "vision").counter().count()).isEqualTo(2);

        var recovered = new MediaWorkflowMetrics.ProviderProfileObservation(
                "vision-cpu", "2.4.1", "detector-cpu", "sha256-abc123",
                MediaWorkflowMetrics.ProviderReadiness.HEALTHY, newerCheck.plusSeconds(1), newerCheck);
        assertThat(metrics.recordProviderProfile(key, recovered)).isTrue();
        assertProviderProfile(registry, 1.0, newerCheck.plusSeconds(1), newerCheck);
        assertThat(registry.get("media.provider.profile.observation_conflict")
                .tag("provider_id", "vision-cpu").gauge().value()).isZero();
    }

    @Test
    void concurrentOutOfOrderProviderCompletionsKeepTheNewestObservationTuple() throws Exception {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "vision");
        Instant base = Instant.parse("2026-10-26T12:00:00Z");
        int count = 40;
        var ready = new java.util.concurrent.CountDownLatch(1);
        var executor = java.util.concurrent.Executors.newFixedThreadPool(8);
        try {
            var results = new java.util.ArrayList<java.util.concurrent.Future<Boolean>>();
            for (int index = 0; index < count; index++) {
                int sequence = index;
                results.add(executor.submit(() -> {
                    ready.await();
                    Instant checkedAt = base.plusSeconds(sequence);
                    return metrics.recordProviderProfile(MediaWorkflowMetrics.Modality.VISION,
                            new MediaWorkflowMetrics.ProviderProfileObservation(
                                    "vision-cpu", "2.4.1", "detector-cpu", "sha256-abc123",
                                    sequence == count - 1 ? MediaWorkflowMetrics.ProviderReadiness.UNAVAILABLE
                                            : MediaWorkflowMetrics.ProviderReadiness.HEALTHY,
                                    checkedAt, checkedAt.minusSeconds(1)));
                }));
            }
            ready.countDown();
            assertThat(results.stream().map(MediaWorkflowMetricsTest::getUnchecked).toList()).contains(true);
        } finally {
            executor.shutdownNow();
        }

        assertProviderProfile(registry, -1.0, base.plusSeconds(count - 1), base.plusSeconds(count - 2));
    }

    private static void assertProviderProfile(
            SimpleMeterRegistry registry, double readiness, Instant checkedAt, Instant qualityAt) {
        assertThat(registry.get("media.provider.profile.readiness")
                .tag("provider_id", "vision-cpu").gauge().value()).isEqualTo(readiness);
        assertThat(registry.get("media.provider.profile.checked_at_seconds")
                .tag("provider_id", "vision-cpu").gauge().value()).isEqualTo(checkedAt.getEpochSecond());
        assertThat(registry.get("media.provider.quality.observation_timestamp_seconds")
                .tag("provider_id", "vision-cpu").gauge().value()).isEqualTo(qualityAt.getEpochSecond());
    }

    private static boolean getUnchecked(java.util.concurrent.Future<Boolean> result) {
        try {
            return result.get();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError("Interrupted while waiting for provider observation", interrupted);
        } catch (java.util.concurrent.ExecutionException failed) {
            throw new AssertionError("Concurrent provider observation failed", failed.getCause());
        }
    }

    @Test
    void rejectsUnboundedProviderMetricIdentitiesAndFutureQualityReadings() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "vision");
        Instant now = Instant.parse("2026-10-26T12:00:00Z");

        assertThatThrownBy(() -> new MediaWorkflowMetrics.ProviderProfileObservation(
                "provider-valid", "1.0", "profile", "revision",
                MediaWorkflowMetrics.ProviderReadiness.HEALTHY, now, now.plusSeconds(1)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("newer");
        assertThatThrownBy(() -> new MediaWorkflowMetrics.ProviderProfileObservation(
                "provider/tenant-secret", "1.0", "profile", "revision",
                MediaWorkflowMetrics.ProviderReadiness.HEALTHY, now, null))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("metric token");

        for (int index = 0; index < 64; index++) {
            assertThat(metrics.recordProviderProfile(MediaWorkflowMetrics.Modality.STT,
                    new MediaWorkflowMetrics.ProviderProfileObservation(
                            "provider-" + index, "v1", "stt", "rev-1",
                            MediaWorkflowMetrics.ProviderReadiness.HEALTHY, now, null))).isTrue();
        }
        assertThat(metrics.recordProviderProfile(MediaWorkflowMetrics.Modality.STT,
                new MediaWorkflowMetrics.ProviderProfileObservation(
                        "provider-overflow", "v1", "stt", "rev-1",
                        MediaWorkflowMetrics.ProviderReadiness.HEALTHY, now, null))).isFalse();
        assertThat(registry.get("media.provider.profile.observation.rejected")
                .tag("service", "vision").counter().count()).isEqualTo(1);
    }

    @Test
    void measuredQualitySeriesUsesBoundedVocabularyAndHonestAbsence() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "stt");
        Instant now = Instant.parse("2026-10-29T12:00:00Z");

        assertThat(metrics.recordProviderQualitySeries(
                MediaWorkflowMetrics.Modality.STT, "whisper-provider", "whisper-v1",
                "whisper-tiny", now, java.util.List.of(
                        new MediaWorkflowMetrics.ProviderQualitySeriesSample(
                                "aggregate", "wer", 1.096, now.minusSeconds(3600),
                                "reference_only"),
                        new MediaWorkflowMetrics.ProviderQualitySeriesSample(
                                "hin", "wer", 1.096, now.minusSeconds(3600),
                                "reference_only"),
                        new MediaWorkflowMetrics.ProviderQualitySeriesSample(
                                "hin", "wer_ci95_upper", 1.267, now.minusSeconds(3600),
                                "reference_only")))).isTrue();
        assertThat(registry.get("media.provider.quality.measured_value")
                .tag("locale", "hin").tag("metric", "wer").gauge().value()).isEqualTo(1.096);
        assertThat(registry.get("media.provider.quality.measured_value")
                .tag("metric", "wer_ci95_upper").gauge().value()).isEqualTo(1.267);
        assertThat(registry.get("media.provider.quality.measured_value")
                .tag("locale", "aggregate").gauge().value()).isEqualTo(1.096);

        // A later refresh without measured rows leaves NaN, never a phantom value.
        assertThat(metrics.recordProviderQualitySeries(
                MediaWorkflowMetrics.Modality.STT, "whisper-provider", "whisper-v1",
                "whisper-tiny", now.plusSeconds(60), java.util.List.of())).isTrue();
        assertThat(registry.get("media.provider.quality.measured_value")
                .tag("locale", "hin").tag("metric", "wer").gauge().value()).isNaN();

        // An older refresh and out-of-vocabulary labels are rejected.
        assertThat(metrics.recordProviderQualitySeries(
                MediaWorkflowMetrics.Modality.STT, "whisper-provider", "whisper-v1",
                "whisper-tiny", now, java.util.List.of())).isFalse();
        assertThatThrownBy(() -> new MediaWorkflowMetrics.ProviderQualitySeriesSample(
                "tenant-987", "wer", 0.1, now, "reference_only"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MediaWorkflowMetrics.ProviderQualitySeriesSample(
                "eng", "raw_transcript", 0.1, now, "reference_only"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MediaWorkflowMetrics.ProviderQualitySeriesSample(
                "eng", "wer", 0.1, now, "production_admitted"))
                .isInstanceOf(IllegalArgumentException.class);
        // Two rows claiming the same series are ambiguous and dropped together.
        assertThat(metrics.recordProviderQualitySeries(
                MediaWorkflowMetrics.Modality.STT, "whisper-provider", "whisper-v1",
                "whisper-tiny", now.plusSeconds(120), java.util.List.of(
                        new MediaWorkflowMetrics.ProviderQualitySeriesSample(
                                "eng", "wer", 0.1, now, "reference_only"),
                        new MediaWorkflowMetrics.ProviderQualitySeriesSample(
                                "eng", "wer", 0.2, now, "reference_only")))).isFalse();
    }

    @Test
    void measuredQualitySeriesAcceptsSourceLocaleTagsUsedByCommonVoiceV27() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "stt");
        Instant now = Instant.parse("2026-11-03T12:00:00Z");

        assertThat(metrics.recordProviderQualitySeries(
                MediaWorkflowMetrics.Modality.STT, "whisper-provider", "whisper-v1",
                "whisper-tiny", now, java.util.List.of(
                        new MediaWorkflowMetrics.ProviderQualitySeriesSample(
                                "en", "wer", 0.25, now, "reference_only"),
                        new MediaWorkflowMetrics.ProviderQualitySeriesSample(
                                "ne-np", "cer", 0.125, now, "reference_only")))).isTrue();
        assertThat(registry.get("media.provider.quality.measured_value")
                .tag("locale", "en").tag("metric", "wer").gauge().value()).isEqualTo(0.25);
        assertThat(registry.get("media.provider.quality.measured_value")
                .tag("locale", "ne-np").tag("metric", "cer").gauge().value()).isEqualTo(0.125);
    }

    @Test
    void qualityRefreshValidatesAndPublishesOneSnapshotOfMutableInput() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "stt");
        Instant now = Instant.parse("2026-11-03T12:00:00Z");
        var validated = new MediaWorkflowMetrics.ProviderQualitySeriesSample(
                "eng", "wer", 0.25, now, "reference_only");
        var substituted = new MediaWorkflowMetrics.ProviderQualitySeriesSample(
                "hin", "wer", 0.75, now, "reference_only");
        java.util.List<MediaWorkflowMetrics.ProviderQualitySeriesSample> changingInput =
                new java.util.AbstractList<>() {
                    private int traversals;

                    @Override
                    public int size() {
                        return 1;
                    }

                    @Override
                    public MediaWorkflowMetrics.ProviderQualitySeriesSample get(int index) {
                        throw new UnsupportedOperationException("iterator supplies the row");
                    }

                    @Override
                    public java.util.Iterator<MediaWorkflowMetrics.ProviderQualitySeriesSample> iterator() {
                        MediaWorkflowMetrics.ProviderQualitySeriesSample row =
                                traversals++ == 0 ? validated : substituted;
                        return java.util.List.of(row).iterator();
                    }
                };

        assertThat(metrics.recordProviderQualitySeries(MediaWorkflowMetrics.Modality.STT,
                "provider", "v1", "model", now, changingInput)).isTrue();

        assertThat(registry.get("media.provider.quality.measured_value")
                .tag("locale", "eng").tag("metric", "wer").gauge().value()).isEqualTo(0.25);
        assertThat(registry.find("media.provider.quality.measured_value")
                .tag("locale", "hin").meters()).isEmpty();
    }

    @Test
    void qualityRefreshRejectsConflictingEqualTimeAndFutureMeasurements() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "stt");
        Instant now = Instant.parse("2026-10-29T12:00:00Z");
        var measured = new MediaWorkflowMetrics.ProviderQualitySeriesSample(
                "eng", "wer", 0.5, now, "reference_only");
        var conflicting = new MediaWorkflowMetrics.ProviderQualitySeriesSample(
                "eng", "wer", 0.1, now, "reference_only");
        var future = new MediaWorkflowMetrics.ProviderQualitySeriesSample(
                "eng", "wer", 0.2, now.plusSeconds(2), "reference_only");
        assertThat(metrics.recordProviderQualitySeries(MediaWorkflowMetrics.Modality.STT,
                "provider", "v1", "model", now, java.util.List.of(measured))).isTrue();
        assertThat(metrics.recordProviderQualitySeries(MediaWorkflowMetrics.Modality.STT,
                "provider", "v1", "model", now, java.util.List.of(measured))).isTrue();
        assertThat(metrics.recordProviderQualitySeries(MediaWorkflowMetrics.Modality.STT,
                "provider", "v1", "model", now, java.util.List.of(conflicting))).isFalse();
        assertThat(registry.get("media.provider.quality.measured_value")
                .tag("locale", "eng").tag("metric", "wer").gauge().value()).isNaN();
        assertThat(metrics.recordProviderQualitySeries(MediaWorkflowMetrics.Modality.STT,
                "provider", "v1", "model", now, java.util.List.of(measured))).isFalse();
        assertThat(metrics.recordProviderQualitySeries(MediaWorkflowMetrics.Modality.STT,
                "provider", "v1", "model", now.plusSeconds(1), java.util.List.of(future))).isFalse();
        assertThat(registry.get("media.provider.quality.measured_value")
                .tag("locale", "eng").tag("metric", "wer").gauge().value()).isNaN();
        assertThat(metrics.recordProviderQualitySeries(MediaWorkflowMetrics.Modality.STT,
                "provider", "v1", "model", now.plusSeconds(2), java.util.List.of(future))).isTrue();
        assertThat(registry.get("media.provider.quality.measured_value")
                .tag("locale", "eng").tag("metric", "wer").gauge().value()).isEqualTo(0.2);
        assertThat(metrics.recordProviderQualitySeries(MediaWorkflowMetrics.Modality.STT,
                "provider", "v1", "model", now.plusSeconds(3), java.util.List.of())).isTrue();
        assertThat(registry.get("media.provider.quality.measured_value")
                .tag("locale", "eng").tag("metric", "wer").gauge().value()).isNaN();
    }

    @Test
    void unknownProviderPollClearsCurrentValuesButRetainsOrderingTimestamps() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "stt");
        Instant checkedAt = Instant.parse("2026-10-30T12:00:00Z");
        Instant qualityAt = checkedAt.minusSeconds(60);
        assertThat(metrics.recordProviderProfile(MediaWorkflowMetrics.Modality.STT,
                new MediaWorkflowMetrics.ProviderProfileObservation("provider", "v1", "profile",
                        "revision", MediaWorkflowMetrics.ProviderReadiness.HEALTHY,
                        checkedAt, qualityAt))).isTrue();
        assertThat(metrics.recordProviderQualitySeries(MediaWorkflowMetrics.Modality.STT,
                "provider", "v1", "revision", checkedAt, java.util.List.of(
                        new MediaWorkflowMetrics.ProviderQualitySeriesSample(
                                "eng", "wer", 0.2, qualityAt, "reference_only"),
                        new MediaWorkflowMetrics.ProviderQualitySeriesSample(
                                "eng", "cer", 0.1, qualityAt, "reference_only")))).isTrue();

        metrics.markProviderProfileObservationUnknown("provider");

        assertThat(registry.get("media.provider.profile.readiness")
                .tag("provider_id", "provider").gauge().value()).isNaN();
        assertThat(registry.get("media.provider.profile.checked_at_seconds")
                .tag("provider_id", "provider").gauge().value()).isEqualTo(checkedAt.getEpochSecond());
        assertThat(registry.get("media.provider.quality.observation_timestamp_seconds")
                .tag("provider_id", "provider").gauge().value()).isNaN();
        assertThat(registry.get("media.provider.quality.measured_value")
                .tag("provider_id", "provider").tag("metric", "wer").gauge().value()).isNaN();
        assertThat(registry.get("media.provider.quality.measured_value")
                .tag("provider_id", "provider").tag("metric", "cer").gauge().value()).isNaN();

        // The original check/refresh points still fence out late data.
        assertThat(metrics.recordProviderProfile(MediaWorkflowMetrics.Modality.STT,
                new MediaWorkflowMetrics.ProviderProfileObservation("provider", "v1", "profile",
                        "revision", MediaWorkflowMetrics.ProviderReadiness.HEALTHY,
                        checkedAt.minusSeconds(1), qualityAt))).isFalse();
        assertThat(metrics.recordProviderQualitySeries(MediaWorkflowMetrics.Modality.STT,
                "provider", "v1", "revision", checkedAt.minusSeconds(1), java.util.List.of())).isFalse();
    }

    @Test
    void emptyQualityRefreshGroupsAndMetricIdentitiesAreBounded() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "stt");
        Instant now = Instant.parse("2026-10-29T12:00:00Z");
        assertThat(metrics.recordProviderQualitySeries(MediaWorkflowMetrics.Modality.STT,
                "tenant/private", "v1", "model", now, java.util.List.of())).isFalse();
        for (int i = 0; i < 64; i++) {
            assertThat(metrics.recordProviderQualitySeries(MediaWorkflowMetrics.Modality.STT,
                    "provider-" + i, "v1", "model", now, java.util.List.of())).isTrue();
        }
        assertThat(metrics.recordProviderQualitySeries(MediaWorkflowMetrics.Modality.STT,
                "provider-overflow", "v1", "model", now, java.util.List.of())).isFalse();
        assertThat(metrics.recordProviderQualitySeries(MediaWorkflowMetrics.Modality.STT,
                "provider-0", "v1", "model", now.plusSeconds(1), java.util.List.of())).isTrue();
    }
}
