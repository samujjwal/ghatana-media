package com.ghatana.audiovideo.observability;

import static org.assertj.core.api.Assertions.assertThat;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.Meter;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import io.micrometer.prometheusmetrics.PrometheusConfig;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.function.ToDoubleFunction;

/** DEV local provider readiness and outage metrics: bounded labels, one-hot state, no secret-shaped labels. */
class MediaLocalProviderMetricsTest {
    private static final Instant CHECKED = Instant.parse("2026-11-14T12:00:00Z");

    @Test
    void readinessIsOneHotPerProviderAndReplacedByTheNextObservation() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "launcher");
        metrics.recordLocalProviderState(MediaWorkflowMetrics.LocalProvider.KOKORO,
                MediaWorkflowMetrics.LocalProviderState.READY, CHECKED);
        assertThat(state(registry, "kokoro", "ready")).isEqualTo(1.0);
        assertThat(state(registry, "kokoro", "unavailable")).isEqualTo(0.0);
        metrics.recordLocalProviderState(MediaWorkflowMetrics.LocalProvider.KOKORO,
                MediaWorkflowMetrics.LocalProviderState.UNAVAILABLE, CHECKED.plusSeconds(5));
        assertThat(state(registry, "kokoro", "ready")).isEqualTo(0.0);
        assertThat(state(registry, "kokoro", "unavailable")).isEqualTo(1.0);
        assertThat(registry.find("media.dev.provider.checked_at_seconds").tag("provider", "kokoro").gauge().value())
                .isEqualTo((double) CHECKED.plusSeconds(5).getEpochSecond());
        // Five states for the one observed provider; nothing is exported for a provider never probed.
        assertThat(registry.find("media.dev.provider.state").gauges()).hasSize(5);
        assertThat(registry.find("media.dev.provider.state").tag("provider", "whisper").gauges()).isEmpty();
    }

    @Test
    void outageCountersUseOnlyTheFixedLaneAndOutcomeVocabulary() {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "launcher");
        metrics.recordLocalProviderOutage(MediaWorkflowMetrics.OutageLane.SPEECH_SYNTHESIZE,
                MediaWorkflowMetrics.OutageOutcome.UNKNOWN);
        metrics.recordLocalProviderOutage(MediaWorkflowMetrics.OutageLane.SPEECH_SYNTHESIZE,
                MediaWorkflowMetrics.OutageOutcome.UNKNOWN);
        metrics.recordLocalProviderOutage(MediaWorkflowMetrics.OutageLane.RENDER,
                MediaWorkflowMetrics.OutageOutcome.UNAVAILABLE);
        metrics.recordLocalProviderOutage(null, MediaWorkflowMetrics.OutageOutcome.UNAVAILABLE);
        assertThat(registry.find("media.dev.provider.outages").tag("lane", "speech_synthesize")
                .tag("outcome", "unknown").counter().count()).isEqualTo(2.0);
        assertThat(registry.find("media.dev.provider.outages").counters()).hasSize(2);
        for (Meter meter : registry.getMeters()) {
            if (!meter.getId().getName().startsWith("media.dev.provider")) continue;
            meter.getId().getTags().forEach(tag -> assertThat(tag.getValue().toLowerCase())
                    .doesNotContain("secret", "token", "password", "/", "http"));
        }
        assertThat(registry.scrape()).contains("media_dev_provider_outages_total")
                .contains("lane=\"speech_synthesize\"");
    }

    @Test
    void registryFailureNeverEscapesIntoTheObservedOperation() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry() {
            @Override
            protected <T> Gauge newGauge(Meter.Id id, T obj, ToDoubleFunction<T> valueFunction) {
                if (id.getName().startsWith("media.dev.provider")) throw new IllegalStateException("fixture failure");
                return super.newGauge(id, obj, valueFunction);
            }
        };
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "launcher");
        metrics.recordLocalProviderState(MediaWorkflowMetrics.LocalProvider.FFMPEG,
                MediaWorkflowMetrics.LocalProviderState.READY, CHECKED);
        assertThat(registry.find("media.dev.provider.state").gauges()).isEmpty();
    }

    private static double state(SimpleMeterRegistry registry, String provider, String state) {
        return registry.find("media.dev.provider.state").tag("provider", provider).tag("state", state).gauge().value();
    }
}
