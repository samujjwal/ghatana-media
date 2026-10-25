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

    @Test
    void durableBacklogAlertsRequireACompleteStoreSnapshotAndUnavailableIsExplicit() throws IOException {
        Path rulesPath = Path.of("..", "infra", "monitoring", "alerts", "audio-video.yml");
        String rules = Files.readString(rulesPath);
        String knownAvailable = "and on (service, contract_version)\n"
                + "            (media_workflow_aggregate_store_queries_supported{contract_version=\"v1\"} == 1)";

        assertThat(rules).contains(
                "media_workflow_lease_overdue{contract_version=\"v1\"}\n            " + knownAvailable,
                "media_workflow_unknown_backlog{contract_version=\"v1\"}\n            " + knownAvailable,
                "media_workflow_queue_depth{contract_version=\"v1\"}\n            " + knownAvailable,
                "media_workflow_aggregate_store_queries_supported{contract_version=\"v1\"} == 0",
                "Initial NaN/unknown state does not trigger this alert");
        assertThat(rules).doesNotContain(
                "max(media_workflow_lease_overdue{contract_version=\"v1\"})",
                "max(media_workflow_unknown_backlog{contract_version=\"v1\"})",
                "max(media_workflow_queue_depth{contract_version=\"v1\"})");
    }
}
