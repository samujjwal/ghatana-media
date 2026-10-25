package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaLifecycleEventPublisher;
import com.ghatana.media.runtime.MediaLifecycleOutboxSource;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaJobStore;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
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

    @Test
    void failedRefreshInvalidatesPreviouslyMeasuredJobAndOutboxCounts() throws Exception {
        var root = Files.createTempDirectory("media-aggregate-metrics-refresh-failure-");
        var delegate = new LocalMediaRuntimeSupport.JobStore(false);
        var failJobCounts = new java.util.concurrent.atomic.AtomicBoolean();
        MediaJobStore jobs = (MediaJobStore) Proxy.newProxyInstance(
                MediaJobStore.class.getClassLoader(), new Class<?>[] {MediaJobStore.class},
                (proxy, method, args) -> {
                    if ("countByStatus".equals(method.getName())) {
                        if (failJobCounts.get()) throw new IllegalStateException("fixture read failure");
                        JobStatus status = (JobStatus) args[0];
                        return status == JobStatus.ACCEPTED ? 4L
                                : status == JobStatus.OUTCOME_UNKNOWN ? 3L : 0L;
                    }
                    if ("countOverdueLeases".equals(method.getName())) {
                        if (failJobCounts.get()) throw new IllegalStateException("fixture read failure");
                        return 2L;
                    }
                    try {
                        return method.invoke(delegate, args);
                    } catch (InvocationTargetException wrapped) {
                        throw wrapped.getCause();
                    }
                });
        var source = new CountingOutboxSource(5, false);
        MediaRuntime runtime = runtime(root, jobs, source);
        try {
            String measured = runtime.prometheusMetrics();
            assertThat(measured).contains(
                    "media_workflow_queue_depth{contract_version=\"v1\",service=\"launcher\"} 4.0",
                    "media_workflow_unknown_backlog{contract_version=\"v1\",service=\"launcher\"} 3.0",
                    "media_workflow_lease_overdue{contract_version=\"v1\",service=\"launcher\"} 2.0",
                    "media_workflow_aggregate_store_queries_supported"
                            + "{contract_version=\"v1\",service=\"launcher\"} 1.0",
                    "media_workflow_outbox_lease_overdue{contract_version=\"v1\",service=\"launcher\"} 5.0",
                    "media_workflow_outbox_aggregate_store_queries_supported"
                            + "{contract_version=\"v1\",service=\"launcher\"} 1.0");

            failJobCounts.set(true);
            source.fail.set(true);
            String failed = runtime.prometheusMetrics();
            assertThat(failed).contains(
                    "media_workflow_queue_depth{contract_version=\"v1\",service=\"launcher\"} NaN",
                    "media_workflow_unknown_backlog{contract_version=\"v1\",service=\"launcher\"} NaN",
                    "media_workflow_lease_overdue{contract_version=\"v1\",service=\"launcher\"} NaN",
                    "media_workflow_aggregate_store_queries_supported"
                            + "{contract_version=\"v1\",service=\"launcher\"} 0.0",
                    "media_workflow_outbox_lease_overdue{contract_version=\"v1\",service=\"launcher\"} NaN",
                    "media_workflow_outbox_aggregate_store_queries_supported"
                            + "{contract_version=\"v1\",service=\"launcher\"} 0.0");
        } finally {
            runtime.close();
        }
    }

    private static MediaRuntime runtime(
            java.nio.file.Path root, MediaLifecycleOutboxSource source) {
        return runtime(root, new LocalMediaRuntimeSupport.JobStore(false), source);
    }

    private static MediaRuntime runtime(
            java.nio.file.Path root, MediaJobStore jobs, MediaLifecycleOutboxSource source) {
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                jobs,
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
        private final java.util.concurrent.atomic.AtomicBoolean fail = new java.util.concurrent.atomic.AtomicBoolean();

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
            if (fail.get()) throw new IllegalStateException("fixture read failure");
            if (unsupported) {
                throw new UnsupportedOperationException("fixture source does not support aggregate queries");
            }
            return overdue;
        }
    }
}
