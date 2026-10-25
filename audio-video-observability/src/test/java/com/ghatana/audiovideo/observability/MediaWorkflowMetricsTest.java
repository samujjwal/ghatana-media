package com.ghatana.audiovideo.observability;

import static org.assertj.core.api.Assertions.assertThat;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

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

        assertThat(registry.get("media.workflow.queue.depth").tag("service", "unknown").gauge().value())
                .isZero();
        assertThat(registry.get("media.workflow.unknown.backlog").gauge().value()).isZero();
        assertThat(registry.get("media.workflow.aggregate_store_queries_supported").gauge().value()).isZero();
    }
}
