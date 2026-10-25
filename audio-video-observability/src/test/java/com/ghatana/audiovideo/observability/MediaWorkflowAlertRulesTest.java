package com.ghatana.audiovideo.observability;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class MediaWorkflowAlertRulesTest {
    @Test
    void definesAlertsForDurableWorkflowFailureSignalsWithoutIdentityLabels() throws IOException {
        Path rulesPath = Path.of("..", "infra", "monitoring", "alerts", "audio-video.yml");
        String rules = Files.readString(rulesPath);

        assertThat(rules).contains(
                "MediaJobLeaseStuck",
                "MediaUnknownFinalityBacklog",
                "MediaPublicationAmbiguityIncreasing",
                "MediaPolicyDenialRateHigh",
                "MediaQueueCapacityHigh",
                "MediaWorkflowAggregateStoreMetricsUnavailable",
                "media_workflow_lease_overdue",
                "media_workflow_unknown_backlog",
                "media_workflow_events_total",
                "media_workflow_requests_total",
                "media_workflow_queue_depth",
                "media_workflow_aggregate_store_queries_supported",
                "contract_version=\"v1\"");
        assertThat(rules).doesNotContain("tenant_id", "request_id", "job_id", "attempt_id", "provider_id");
    }
}
