package com.ghatana.audiovideo.observability;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
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
        assertThat(rules).doesNotContain(
                "tenant_id", "principal_id", "request_id", "job_id", "attempt_id",
                "provider_id", "model_id", "voice_id", "face_id", "token");
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

    @Test
    void alertLabelsRemainFixedAndCannotContainRequestOrProviderIdentity() throws IOException {
        Path rulesPath = Path.of("..", "infra", "monitoring", "alerts", "audio-video.yml");
        String[] lines = Files.readString(rulesPath).split("\\R");
        Set<String> allowedKeys = Set.of("severity", "product", "component");
        Pattern labelEntry = Pattern.compile("^\\s+([A-Za-z_][A-Za-z0-9_]*):\\s*(.*)$");
        int labelsIndent = -1;
        int labelCount = 0;

        for (String line : lines) {
            int indent = line.length() - line.stripLeading().length();
            if (line.strip().equals("labels:")) {
                labelsIndent = indent;
                continue;
            }
            if (labelsIndent < 0) continue;
            if (!line.isBlank() && indent <= labelsIndent) {
                labelsIndent = -1;
                continue;
            }
            if (line.isBlank()) continue;

            Matcher entry = labelEntry.matcher(line);
            assertThat(entry.matches()).as("alert label line: %s", line).isTrue();
            assertThat(allowedKeys).contains(entry.group(1));
            assertThat(entry.group(2)).doesNotContain("{{", "$", "tenant", "principal", "request", "provider", "model");
            labelCount++;
        }

        assertThat(labelCount).isPositive();
    }

    @Test
    void missingProviderAndQualitySourcesHaveNoAlertRuleOrHealthyZeroFallback() throws IOException {
        Path rulesPath = Path.of("..", "infra", "monitoring", "alerts", "audio-video.yml");
        Path operationsPath = Path.of("..", "docs", "OPERATIONS.md");
        String rules = Files.readString(rulesPath);
        String operations = Files.readString(operationsPath);

        assertThat(rules)
                .contains("Provider readiness and model-quality alert rules are intentionally absent")
                .doesNotContain("alert: MediaProviderUnavailable", "alert: MediaQualityRegression",
                        "media_provider_health", "media_model_quality", "av_health_check");
        assertThat(operations).contains(
                "Provider readiness and model quality are not Prometheus sources",
                "`NOT_ADMITTED` / `NO_DATA`",
                "must not turn that into a zero");
    }
}
