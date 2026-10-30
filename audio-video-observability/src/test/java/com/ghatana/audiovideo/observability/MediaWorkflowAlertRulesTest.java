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
                "model_id", "voice_id", "face_id", "token");
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
            assertThat(entry.group(2)).matches("[a-z][a-z0-9_-]*");
            labelCount++;
        }

        assertThat(labelCount).isPositive();
    }

    @Test
    void providerReadinessAlertsAreModalitySpecificAndQualityRemainsFixtureOnly() throws IOException {
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
                .contains("alert: MediaProviderProfileDegraded", "alert: MediaProviderProfileUnavailable",
                        "alert: MediaProviderProfileStale",
                        "media_provider_profile_readiness{contract_version=\"v1\"}")
                .doesNotContain("alert: MediaQualityRegression", "alert: MediaModelQualityRegression\n");
        assertThat(rules).contains(
                "alert: MediaProviderQualifiedQualityRegression",
                "alert: MediaProviderReferenceQualityBelowThreshold",
                "alert: MediaProviderQualityEvidenceMissing",
                "media_provider_quality_measured_value{contract_version=\"v1\"",
                "scope=\"independent_qualified\"", "scope=\"reference_only\"",
                "metric=\"wer_ci95_upper\"", "locale=\"eng\"", "locale=\"hin\"", "locale=\"npi\"",
                "media_provider_quality_observation_timestamp_seconds{contract_version=\"v1\"}");
        assertThat(operations).contains(
                "`av_service_readiness{service=\"stt|tts|vision|multimodal\"}`",
                "Modality-specific provider-not-ready alerts fire only when an observed readiness",
                "`SttProviderNotReady`", "`TtsProviderNotReady`", "`VisionProviderNotReady`",
                "`MultimodalProviderNotReady`",
                "absent or NaN series does not trigger those alerts",
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
    void readinessTelemetryAlertsRequireReachableTargetAndKeepUnknownDistinctFromUnavailable() throws IOException {
        Path rulesPath = Path.of("..", "infra", "monitoring", "alerts", "audio-video.yml");
        String rules = Files.readString(rulesPath);
        Map<String, String> modalities = Map.of(
                "stt", "SttReadinessTelemetryMissing",
                "tts", "TtsReadinessTelemetryMissing",
                "vision", "VisionReadinessTelemetryMissing",
                "multimodal", "MultimodalReadinessTelemetryMissing");

        modalities.forEach((service, alert) -> {
            String expression = "label_replace(up{job=\"" + service + "-service\"}, \"service\", \""
                    + service + "\", \"job\", \".*\") == 1 unless on (job, instance, service) "
                    + "av_service_readiness{service=\"" + service + "\"}";
            String invalidAlert = switch (service) {
                case "stt" -> "SttReadinessTelemetryInvalid";
                case "tts" -> "TtsReadinessTelemetryInvalid";
                case "vision" -> "VisionReadinessTelemetryInvalid";
                default -> "MultimodalReadinessTelemetryInvalid";
            };
            String invalidExpression = "(label_replace(up{job=\"" + service + "-service\"}, \"service\", \""
                    + service + "\", \"job\", \".*\") == 1) and on (job, instance, service) "
                    + "(av_service_readiness{service=\"" + service + "\"} != "
                    + "av_service_readiness{service=\"" + service + "\"})";
            assertThat(rules).contains("alert: " + alert, expression,
                    "severity: warning\n          product: audio-video\n          component: " + service,
                    "Treat provider state as unknown");
            assertThat(rules).contains("alert: " + invalidAlert, invalidExpression,
                    "severity: warning\n          product: audio-video\n          component: " + service,
                    "readiness gauge is NaN", "Treat provider state as unknown");
        });
        assertThat(rules).doesNotContain("model_id", "tenant_id", "request_id");
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

    @Test
    void checkedInPrometheusFixtureCoversReadinessFiringAndFalseAlarmCases() throws IOException {
        Path fixturePath = Path.of("..", "infra", "monitoring", "tests", "audio-video.rules.test.yml");
        String fixture = Files.readString(fixturePath);

        assertThat(fixture).contains(
                "name: observed-zero-readiness-fires-after-one-minute",
                "name: readiness-one-does-not-fire",
                "name: missing-readiness-is-no-data-not-zero",
                "name: nan-readiness-is-no-data-not-zero",
                "alertname: SttProviderNotReady",
                "alertname: TtsProviderNotReady",
                "alertname: VisionProviderNotReady",
                "alertname: MultimodalProviderNotReady",
                "name: reachable-target-missing-readiness-is-unknown",
                "name: reachable-target-nan-readiness-is-invalid-not-missing-or-unavailable",
                "name: readiness-zero-is-unavailable-not-missing",
                "name: down-target-does-not-report-stale-provider-status",
                "name: provider-profile-health-alerts-fire-and-recover-with-fixed-labels",
                "name: provider-profile-stale-health-check-alerts-and-recovers",
                "alertname: SttReadinessTelemetryMissing",
                "alertname: TtsReadinessTelemetryMissing",
                "alertname: VisionReadinessTelemetryMissing",
                "alertname: MultimodalReadinessTelemetryMissing",
                "alertname: SttReadinessTelemetryInvalid",
                "alertname: TtsReadinessTelemetryInvalid",
                "alertname: VisionReadinessTelemetryInvalid",
                "alertname: MultimodalReadinessTelemetryInvalid",
                "alertname: MediaProviderProfileDegraded",
                "alertname: MediaProviderProfileUnavailable",
                "alertname: MediaProviderProfileStale",
                "values: '0x3'",
                "values: 1x3",
                "values: NaN NaN NaN",
                "exp_alerts: []");
        assertThat(fixture).doesNotContain("tenant-987", "request-654", "private-media-marker");
    }

    @Test
    void qualityAndSourceFreshnessRulesAreFixtureScopedAndRedacted() throws IOException {
        Path rulesPath = Path.of("..", "infra", "monitoring", "alerts", "audio-video.yml");
        Path fixturePath = Path.of("..", "infra", "monitoring", "tests", "audio-video.rules.test.yml");
        String rules = Files.readString(rulesPath);
        String fixture = Files.readString(fixturePath);

        assertThat(rules).contains(
                "alert: MediaProviderProfileDegraded",
                "alert: MediaProviderProfileUnavailable",
                "alert: MediaProviderProfileStale",
                "alert: MediaModelQualityRegressionFixture",
                "av_model_quality_regression{source=\"fixture\"} == 1",
                "alert: MediaProviderSourceStaleFixture",
                "av_provider_source_timestamp_seconds{source=\"fixture\"} > 300",
                "do not infer provider quality or change production traffic",
                "verify real source freshness through its owning system");
        assertThat(fixture).contains(
                "name: fixture-quality-regression-and-stale-source-alerts-fire-redacted",
                "name: fixture-quality-recovered-and-fresh-source-stay-quiet",
                "alertname: MediaModelQualityRegressionFixture",
                "alertname: MediaProviderSourceStaleFixture",
                "values: 1x11",
                "values: 100x11",
                "values: 0x11",
                "values: 590x11");
        assertThat(fixture).contains(
                "name: qualified-quality-regression-fires-and-recovers",
                "name: reference-quality-below-threshold-warns-without-admission",
                "name: quality-thresholds-hold-at-registered-values",
                "name: missing-quality-evidence-alerts-on-observed-profile",
                "name: finite-quality-evidence-and-unknown-profile-stay-quiet",
                "alertname: MediaProviderQualifiedQualityRegression",
                "alertname: MediaProviderReferenceQualityBelowThreshold",
                "alertname: MediaProviderQualityEvidenceMissing",
                "metric=\"wer_ci95_upper\"", "scope=\"independent_qualified\"",
                "scope=\"reference_only\"");
        assertThat(rules).doesNotContain("tenant_id", "principal_id", "request_id", "job_id",
                "attempt_id", "model_id", "voice_id", "face_id", "token");
        assertThat(fixture).doesNotContain("tenant-987", "request-654", "private-media-marker");
    }

    private static boolean firesObservedZeroRule(OptionalDouble value) {
        return value.isPresent() && Double.isFinite(value.getAsDouble()) && value.getAsDouble() == 0.0;
    }

    private record ReadinessFixture(String name, OptionalDouble value, boolean shouldFire) {}
}
