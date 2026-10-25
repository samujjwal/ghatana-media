package com.ghatana.audiovideo.observability;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.OptionalDouble;
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
                "MediaOutboxClaimLeaseStuck",
                "MediaWorkflowOutboxMetricsUnavailable",
                "media_workflow_lease_overdue",
                "media_workflow_outbox_lease_overdue",
                "media_workflow_unknown_backlog",
                "media_workflow_events_total",
                "media_workflow_requests_total",
                "media_workflow_queue_depth",
                "media_workflow_aggregate_store_queries_supported",
                "media_workflow_outbox_aggregate_store_queries_supported",
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
        assertThat(rules).contains(
                "media_workflow_outbox_lease_overdue{contract_version=\"v1\"}\n            "
                        + "and on (service, contract_version)\n"
                        + "            (media_workflow_outbox_aggregate_store_queries_supported{contract_version=\"v1\"} == 1)",
                "media_workflow_outbox_aggregate_store_queries_supported{contract_version=\"v1\"} == 0");
        assertThat(rules).doesNotContain(
                "max(media_workflow_lease_overdue{contract_version=\"v1\"})",
                "max(media_workflow_outbox_lease_overdue{contract_version=\"v1\"})",
                "max(media_workflow_unknown_backlog{contract_version=\"v1\"})",
                "max(media_workflow_queue_depth{contract_version=\"v1\"})");
    }

    @Test
    void perServiceRateAlertsRetainTheServiceLabelUsedByTheirAnnotations() throws IOException {
        Path rulesPath = Path.of("..", "infra", "monitoring", "alerts", "audio-video.yml");
        String rules = Files.readString(rulesPath);

        assertThat(rules).contains(
                "sum by (service) (rate(media_workflow_events_total{contract_version=\"v1\", event=\"publication_ambiguous\"}[15m])) > 0",
                "sum by (service) (rate(media_workflow_events_total{contract_version=\"v1\", event=\"denied\"}[10m]))",
                "sum by (service) (rate(media_workflow_requests_total{contract_version=\"v1\"}[10m]))",
                "on {{ $labels.service }}");
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
    void providerReadinessAlertsAreModalitySpecificAndQualityHasNoAlertRule() throws IOException {
        Path rulesPath = Path.of("..", "infra", "monitoring", "alerts", "audio-video.yml");
        Path operationsPath = Path.of("..", "docs", "OPERATIONS.md");
        String rules = Files.readString(rulesPath);
        String operations = Files.readString(operationsPath);

        assertThat(rules)
                .contains("alert: SttProviderNotReady", "av_service_readiness{service=\"stt\"} == 0",
                        "component: stt", "alert: TtsProviderNotReady",
                        "av_service_readiness{service=\"tts\"} == 0", "component: tts",
                        "alert: VisionProviderNotReady", "av_service_readiness{service=\"vision\"} == 0",
                        "component: vision", "alert: MultimodalProviderNotReady",
                        "av_service_readiness{service=\"multimodal\"} == 0", "component: multimodal")
                .doesNotContain("alert: MediaQualityRegression", "media_provider_health", "media_model_quality");
        assertThat(operations).contains(
                "`av_service_readiness{service=\"stt|tts|vision|multimodal\"}`",
                "Modality-specific readiness alerts fire only when an observed readiness",
                "`SttProviderNotReady`", "`TtsProviderNotReady`", "`VisionProviderNotReady`",
                "`MultimodalProviderNotReady`",
                "do not alert on an absent or NaN series",
                "`NOT_ADMITTED` / `NO_DATA`",
                "must not turn that into a zero");
    }

    @Test
    void modalityProviderAlertsHaveFixedLabelsAndDoNotFireForMissingOrNanSeries() throws IOException {
        Path rulesPath = Path.of("..", "infra", "monitoring", "alerts", "audio-video.yml");
        String rules = Files.readString(rulesPath);
        Map<String, String> modalities = Map.of("stt", "SttProviderNotReady", "tts", "TtsProviderNotReady",
                "vision", "VisionProviderNotReady", "multimodal", "MultimodalProviderNotReady");

        modalities.forEach((service, alert) -> {
            String expression = "av_service_readiness{service=\"" + service + "\"} == 0";
            assertThat(rules).contains("alert: " + alert, expression,
                    "severity: critical\n          product: audio-video\n          component: " + service);
            assertThat(expression).doesNotContain("or", "absent", "NaN", "vector(0)");
        });
    }

    @Test
    void providerReadinessRuleFixturesOnlyFireForObservedZeroAndExposeNoIdentityLabels() throws IOException {
        Path rulesPath = Path.of("..", "infra", "monitoring", "alerts", "audio-video.yml");
        String rules = Files.readString(rulesPath);
        List<ReadinessFixture> fixtures = List.of(
                new ReadinessFixture("missing", OptionalDouble.empty(), false),
                new ReadinessFixture("unknown", OptionalDouble.of(Double.NaN), false),
                new ReadinessFixture("ready", OptionalDouble.of(1.0), false),
                new ReadinessFixture("not-ready", OptionalDouble.of(0.0), true));

        for (String service : List.of("stt", "tts", "vision", "multimodal")) {
            String expression = "av_service_readiness{service=\"" + service + "\"} == 0";
            assertThat(rules).contains(expression);
            for (ReadinessFixture fixture : fixtures) {
                assertThat(firesObservedZeroRule(fixture.value()))
                        .as("%s readiness fixture: %s", service, fixture.name())
                        .isEqualTo(fixture.shouldFire());
            }
        }
        assertThat(rules).doesNotContain("customer-private-media-marker", "tenant-987", "request-654");
    }

    private static boolean firesObservedZeroRule(OptionalDouble value) {
        return value.isPresent() && Double.isFinite(value.getAsDouble()) && value.getAsDouble() == 0.0;
    }

    private record ReadinessFixture(String name, OptionalDouble value, boolean shouldFire) {}
}
