package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaLifecycleEventPublisher;
import com.ghatana.media.runtime.MediaLifecycleOutboxSource;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/** Verifies that runtime scraping preserves measured and unsupported outbox query states. */
class MediaRuntimeOutboxMetricsTest {

    @Test
    void scrapeReportsMeasuredOutboxLeaseCountFromConfiguredSource() throws Exception {
        var root = Files.createTempDirectory("media-outbox-metrics-measured-");
        var source = new CountingOutboxSource(2, false);
        MediaRuntime runtime = runtime(root, source);
        try {
            String scrape = runtime.prometheusMetrics();

            assertThat(source.countCalls).hasValue(1);
            assertThat(scrape).contains(
                    "media_workflow_outbox_lease_overdue{contract_version=\"v1\",service=\"launcher\"} 2.0",
                    "media_workflow_outbox_aggregate_store_queries_supported"
                            + "{contract_version=\"v1\",service=\"launcher\"} 1.0");
        } finally {
            runtime.close();
        }
    }

    @Test
    void scrapeReportsUnknownOutboxLeaseCountWhenSourceDoesNotSupportQuery() throws Exception {
        var root = Files.createTempDirectory("media-outbox-metrics-unsupported-");
        var source = new CountingOutboxSource(0, true);
        MediaRuntime runtime = runtime(root, source);
        try {
            String scrape = runtime.prometheusMetrics();

            assertThat(source.countCalls).hasValue(1);
            assertThat(scrape).contains(
                    "media_workflow_outbox_lease_overdue{contract_version=\"v1\",service=\"launcher\"} NaN",
                    "media_workflow_outbox_aggregate_store_queries_supported"
                            + "{contract_version=\"v1\",service=\"launcher\"} 0.0");
        } finally {
            runtime.close();
        }
    }

    private static MediaRuntime runtime(
            java.nio.file.Path root, MediaLifecycleOutboxSource source) {
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(false),
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                MediaSemanticRedactionRuntime.disabled(Duration.ofSeconds(2)),
                MediaLifecyclePublisher.disabled(),
                List.of(),
                List.of(),
                List.of(source));
    }

    private static final class CountingOutboxSource implements MediaLifecycleOutboxSource {
        private final long overdue;
        private final boolean unsupported;
        private final AtomicInteger countCalls = new AtomicInteger();

        private CountingOutboxSource(long overdue, boolean unsupported) {
            this.overdue = overdue;
            this.unsupported = unsupported;
        }

        @Override
        public int publishConfirmed(MediaLifecycleEventPublisher publisher, int limit) {
            return 0;
        }

        @Override
        public long countOverdueClaims(Instant now) {
            countCalls.incrementAndGet();
            if (unsupported) {
                throw new UnsupportedOperationException("fixture source does not support aggregate queries");
            }
            return overdue;
        }
    }
}
