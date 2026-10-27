package com.ghatana.audiovideo.observability;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.micrometer.core.instrument.Timer;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

import java.util.concurrent.TimeUnit;
import java.time.Instant;

class MediaWorkflowMetricsTest {
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
    void rejectsOutOfOrderAndConflictingEqualTimeProviderObservationsWithoutRegressingGauges() {
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

        assertProviderProfile(registry, 0.0, newerCheck, newerCheck.minusSeconds(5));
        assertThat(registry.get("media.provider.profile.observation.rejected")
                .tag("service", "vision").counter().count()).isEqualTo(2);
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
}
