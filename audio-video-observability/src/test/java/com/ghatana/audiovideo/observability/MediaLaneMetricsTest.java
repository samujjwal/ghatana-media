package com.ghatana.audiovideo.observability;

import static org.assertj.core.api.Assertions.assertThat;

import io.micrometer.core.instrument.Meter;
import io.micrometer.core.instrument.Tag;
import io.micrometer.prometheusmetrics.PrometheusConfig;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import org.junit.jupiter.api.Test;

import java.util.Set;
import java.util.stream.Collectors;

/** Lane vocabulary, typed outcomes, bounded codes and honest unknown budgets. */
class MediaLaneMetricsTest {
    @Test
    void laneComesFromTheRouteTemplateAndNeverFromARequestValue() {
        assertThat(MediaLaneMetrics.lane("/dev/v1/live-sessions/abc123/frames")).isEqualTo("dev_live_sessions");
        assertThat(MediaLaneMetrics.lane("/dev/v1/live-sessions")).isEqualTo("dev_live_sessions");
        assertThat(MediaLaneMetrics.lane("/api/v1/artifacts/uploads/u-1/chunks/0")).isEqualTo("api_artifacts");
        assertThat(MediaLaneMetrics.lane("/dev/v1/tenant-secret-9/x")).isEqualTo("other");
        assertThat(MediaLaneMetrics.lane("/api/v1/../etc/passwd")).isEqualTo("other");
        assertThat(MediaLaneMetrics.lane("/anything/else")).isEqualTo("other");
        assertThat(MediaLaneMetrics.lane(null)).isEqualTo("other");
    }

    @Test
    void outcomesAreTypedAndRefusalsAreNotFailures() {
        assertThat(MediaLaneMetrics.outcome(200, null)).isEqualTo(MediaLaneMetrics.Outcome.COMPLETED);
        assertThat(MediaLaneMetrics.outcome(202, null)).isEqualTo(MediaLaneMetrics.Outcome.COMPLETED);
        assertThat(MediaLaneMetrics.outcome(401, "UNAUTHENTICATED")).isEqualTo(MediaLaneMetrics.Outcome.REFUSED);
        assertThat(MediaLaneMetrics.outcome(429, "LIVE_CAPACITY_EXHAUSTED")).isEqualTo(MediaLaneMetrics.Outcome.REFUSED);
        assertThat(MediaLaneMetrics.outcome(503, "RENDER_CAPACITY_EXHAUSTED")).isEqualTo(MediaLaneMetrics.Outcome.REFUSED);
        assertThat(MediaLaneMetrics.outcome(503, "UNKNOWN_OUTCOME")).isEqualTo(MediaLaneMetrics.Outcome.UNKNOWN);
        assertThat(MediaLaneMetrics.outcome(503, "MEDIA_PROVIDER_UNAVAILABLE")).isEqualTo(MediaLaneMetrics.Outcome.FAILED);
        assertThat(MediaLaneMetrics.outcome(500, "INTERNAL_ERROR")).isEqualTo(MediaLaneMetrics.Outcome.FAILED);
        assertThat(MediaLaneMetrics.outcome(-1, null)).isEqualTo(MediaLaneMetrics.Outcome.FAILED);
    }

    @Test
    void codeLabelIsBoundedAndNothingIdentifyingCanReachALabel() {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        MediaLaneMetrics metrics = new MediaLaneMetrics(registry, "launcher");
        metrics.record("dev_live_sessions", 200, null, 1_000_000);
        metrics.record("dev_live_sessions", 403, "tenant-acme/alice@example.com", 1_000_000);
        for (int i = 0; i < 200; i++) metrics.record("dev_live_sessions", 400, "CODE_" + i + "_X", 1_000);
        Set<String> codes = registry.find("media.lane.requests").counters().stream()
                .map(counter -> counter.getId().getTag("code")).collect(Collectors.toSet());
        assertThat(codes).contains("OK", "HTTP_4XX", "OTHER");
        assertThat(codes.size()).isLessThanOrEqualTo(MediaLaneMetrics.MAX_CODES + 3);
        assertThat(codes).noneMatch(code -> code.contains("tenant") || code.contains("@"));
        for (Meter meter : registry.getMeters()) {
            for (Tag tag : meter.getId().getTags()) {
                assertThat(tag.getValue()).doesNotContain("alice").doesNotContain("acme");
            }
        }
        assertThat(registry.scrape()).contains("media_lane_request_duration_seconds_bucket{contract_version=\"v1\",lane=\"dev_live_sessions\"");
    }

    @Test
    void unreadableBudgetsExportNanNeverAFabricatedNumber() {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        MediaLaneMetrics metrics = new MediaLaneMetrics(registry, "launcher");
        metrics.registerBudget(MediaLaneMetrics.Budget.LIVE_SESSIONS, () -> 4, () -> { throw new IllegalStateException("x"); });
        metrics.registerDisk(MediaLaneMetrics.Volume.RENDER_SCRATCH, () -> 1234, () -> 100);
        assertThat(registry.find("media.budget.limit").gauge().value()).isEqualTo(4.0);
        assertThat(registry.find("media.budget.available").gauge().value()).isNaN();
        assertThat(registry.find("media.budget.in_use").gauge().value()).isNaN();
        assertThat(registry.find("media.disk.free.bytes").gauge().value()).isEqualTo(1234.0);
        // Registering twice must not duplicate or replace the series.
        metrics.registerBudget(MediaLaneMetrics.Budget.LIVE_SESSIONS, () -> 99, () -> 99);
        assertThat(registry.find("media.budget.limit").gauge().value()).isEqualTo(4.0);
    }
}
