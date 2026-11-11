package com.ghatana.media.launcher;

import static org.assertj.core.api.Assertions.assertThat;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;

/**
 * Test-only local dispatch profile through the canonical MediaRuntime job lifecycle.
 *
 * <p>The provider is a deterministic local completion stub. This measures runtime admission,
 * worker scheduling, provider dispatch, terminal persistence and readback; it does not qualify a
 * media model, codec, production host, provider, or production resource budget.
 */
class MediaRuntimeCapacityProfileTest {
    private static final String TENANT = "media-capacity-test-tenant";
    private static final String PRINCIPAL = "media-capacity-test-principal";
    private static final int OPERATIONS = 96;
    private static final Duration PROFILE_BUDGET = Duration.ofSeconds(30);
    private static final int[] CONCURRENCY_LEVELS = {1, 16, 64};

    @Test
    void profilesCanonicalLocalJobLifecycleAtOneSixteenAndSixtyFourConcurrentWorkers() throws Exception {
        List<Profile> profiles = new ArrayList<>();
        for (int concurrency : CONCURRENCY_LEVELS) {
            profiles.add(profile(concurrency));
        }

        for (Profile profile : profiles) {
            assertThat(profile.concurrency()).isIn(1, 16, 64);
            assertThat(profile.requested()).isEqualTo(OPERATIONS);
            assertThat(profile.completed()).isEqualTo(OPERATIONS);
            assertThat(profile.failed()).isZero();
            assertThat(profile.providerCalls()).isEqualTo(OPERATIONS);
            assertThat(profile.workerPoolTerminated()).isTrue();
            assertThat(profile.elapsed()).isPositive().isLessThanOrEqualTo(PROFILE_BUDGET);
            assertThat(profile.throughputPerSecond()).isPositive();
            assertThat(profile.p50Millis()).isPositive();
            assertThat(profile.p95Millis()).isGreaterThanOrEqualTo(profile.p50Millis());
            assertThat(profile.p99Millis()).isGreaterThanOrEqualTo(profile.p95Millis());
            assertThat(profile.processCpuNanos()).isGreaterThanOrEqualTo(0);
            assertThat(profile.heapSampledPeakBytes()).isPositive();
            assertThat(profile.threadSampledPeak()).isPositive();
        }

        String artifactPath = System.getenv("MEDIA_RUNTIME_CAPACITY_PROFILE_OUTPUT");
        if (artifactPath != null && !artifactPath.isBlank()) {
            var output = java.nio.file.Path.of(artifactPath).toAbsolutePath();
            if (output.getParent() != null) Files.createDirectories(output.getParent());
            Files.writeString(output, "profile\tconcurrency\trequested\tcompleted\tfailed\t"
                    + "elapsed_ms\tthroughput_ops_s\tp50_ms\tp95_ms\tp99_ms\tprocess_cpu_ms\t"
                    + "heap_sampled_peak_bytes\tthread_sampled_peak\n"
                    + profiles.stream().map(Profile::toTsv).collect(Collectors.joining("\n")) + "\n");
        }
    }

    private static Profile profile(int concurrency) throws Exception {
        var root = Files.createTempDirectory("media-runtime-capacity-");
        var provider = new CompletingLocalProvider();
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofMinutes(1), concurrency, "", "", true, false, root, concurrency),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                List.of(provider),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
        try {
            String artifactId = uploadInput(runtime);
            return measure(runtime, provider, artifactId, concurrency);
        } finally {
            runtime.close();
            deleteTree(root);
        }
    }

    private static Profile measure(
            MediaRuntime runtime, CompletingLocalProvider provider, String artifactId, int concurrency)
            throws Exception {
        var cpuBean = java.lang.management.ManagementFactory.getOperatingSystemMXBean()
                instanceof com.sun.management.OperatingSystemMXBean bean ? bean : null;
        long cpuStart = cpuBean == null ? -1 : cpuBean.getProcessCpuTime();
        var heapPeak = new AtomicLong(usedHeapBytes());
        var threadPeak = new AtomicInteger(java.lang.management.ManagementFactory.getThreadMXBean().getThreadCount());
        var sampler = Executors.newSingleThreadScheduledExecutor(task -> {
            Thread thread = new Thread(task, "media-capacity-profile-sampler");
            thread.setDaemon(true);
            return thread;
        });
        sampler.scheduleAtFixedRate(() -> {
            heapPeak.accumulateAndGet(usedHeapBytes(), Math::max);
            threadPeak.accumulateAndGet(java.lang.management.ManagementFactory.getThreadMXBean().getThreadCount(), Math::max);
        }, 0, 10, TimeUnit.MILLISECONDS);

        var worker = Executors.newFixedThreadPool(concurrency);
        long startedAt = System.nanoTime();
        var gate = new CountDownLatch(1);
        var futures = new ArrayList<Future<Long>>(OPERATIONS);
        try {
            for (int i = 0; i < OPERATIONS; i++) {
                final int index = i;
                futures.add(worker.submit(() -> {
                    if (!gate.await(PROFILE_BUDGET.toMillis(), TimeUnit.MILLISECONDS)) {
                        throw new IllegalStateException("profile start gate timed out");
                    }
                    long operationStart = System.nanoTime();
                    ProcessingJobRequest request = new ProcessingJobRequest(
                            "media-capacity-request-" + concurrency + "-" + index,
                            TENANT, PRINCIPAL,
                            "media-capacity-correlation-" + concurrency + "-" + index,
                            artifactId, JobType.VISION, provider.providerId(), Map.of());
                    var accepted = runtime.submit(request,
                            new AuthenticatedPrincipal(TENANT, PRINCIPAL, java.time.Instant.now()));
                    var result = awaitCompleted(runtime, accepted.jobId());
                    if (result.status() != JobStatus.COMPLETED
                            || !"done".equals(result.result().get("caption"))) {
                        throw new IllegalStateException("runtime job did not persist the expected local result");
                    }
                    return System.nanoTime() - operationStart;
                }));
            }
            gate.countDown();
            long deadline = startedAt + PROFILE_BUDGET.toNanos();
            var latencies = new ArrayList<Long>(OPERATIONS);
            for (Future<Long> future : futures) {
                long remaining = deadline - System.nanoTime();
                if (remaining <= 0) throw new java.util.concurrent.TimeoutException("runtime profile exceeded 30 seconds");
                latencies.add(future.get(remaining, TimeUnit.NANOSECONDS));
            }
            long elapsedNanos = System.nanoTime() - startedAt;
            worker.shutdown();
            boolean workerPoolTerminated = worker.awaitTermination(1, TimeUnit.SECONDS);
            long cpuEnd = cpuBean == null ? -1 : cpuBean.getProcessCpuTime();
            double throughput = OPERATIONS / (elapsedNanos / 1_000_000_000.0);
            return new Profile(concurrency, OPERATIONS, latencies.size(), 0, provider.calls(),
                    Duration.ofNanos(elapsedNanos), throughput, percentile(latencies, 0.50),
                    percentile(latencies, 0.95), percentile(latencies, 0.99),
                    cpuStart < 0 || cpuEnd < cpuStart ? 0 : cpuEnd - cpuStart,
                    heapPeak.get(), threadPeak.get(), workerPoolTerminated);
        } finally {
            sampler.shutdownNow();
            sampler.awaitTermination(1, TimeUnit.SECONDS);
            worker.shutdownNow();
            worker.awaitTermination(1, TimeUnit.SECONDS);
        }
    }

    private static String uploadInput(MediaRuntime runtime) throws Exception {
        byte[] payload = "media-runtime-capacity-fixture-v1".getBytes(StandardCharsets.UTF_8);
        var begun = runtime.beginUpload(new UploadRequest(TENANT, PRINCIPAL, "capacity-fixture.bin",
                "application/octet-stream", payload.length, sha256(payload), "INTERNAL",
                Duration.ofMinutes(1), Map.of()), "capacity-profile-upload");
        runtime.appendChunk(TENANT, PRINCIPAL, begun.uploadId(), 0, payload);
        return runtime.completeUpload(TENANT, PRINCIPAL, begun.uploadId()).artifactId();
    }

    private static com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob awaitCompleted(
            MediaRuntime runtime, String jobId) throws Exception {
        long deadline = System.nanoTime() + PROFILE_BUDGET.toNanos();
        while (System.nanoTime() < deadline) {
            var job = runtime.job(TENANT, PRINCIPAL, jobId).orElseThrow();
            if (job.status() == JobStatus.COMPLETED || job.status() == JobStatus.FAILED
                    || job.status() == JobStatus.CANCELLED) return job;
            Thread.sleep(2);
        }
        throw new java.util.concurrent.TimeoutException("runtime job did not reach terminal state: " + jobId);
    }

    private static long usedHeapBytes() {
        var heap = java.lang.management.ManagementFactory.getMemoryMXBean().getHeapMemoryUsage();
        return Math.max(0, heap.getUsed());
    }

    private static double percentile(List<Long> values, double quantile) {
        var sorted = values.stream().sorted().toList();
        int index = (int) Math.ceil(quantile * sorted.size()) - 1;
        return sorted.get(Math.max(0, Math.min(index, sorted.size() - 1))) / 1_000_000.0;
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static void deleteTree(java.nio.file.Path root) throws Exception {
        if (!Files.exists(root)) return;
        try (var paths = Files.walk(root)) {
            for (var path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
        }
    }

    private record Profile(
            int concurrency, int requested, int completed, int failed, int providerCalls,
            Duration elapsed, double throughputPerSecond, double p50Millis, double p95Millis,
            double p99Millis, long processCpuNanos, long heapSampledPeakBytes,
            int threadSampledPeak, boolean workerPoolTerminated) {
        String toTsv() {
            return "local-media-runtime-dev\t" + concurrency + "\t" + requested + "\t" + completed
                    + "\t" + failed + "\t" + elapsed.toNanos() / 1_000_000.0 + "\t"
                    + throughputPerSecond + "\t" + p50Millis + "\t" + p95Millis + "\t"
                    + p99Millis + "\t" + processCpuNanos / 1_000_000.0 + "\t"
                    + heapSampledPeakBytes + "\t" + threadSampledPeak;
        }
    }

    private static final class CompletingLocalProvider implements MediaProcessingProvider {
        private final AtomicInteger calls = new AtomicInteger();

        @Override public String providerId() { return "local-capacity-profile-provider"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 1; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }
        @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            calls.incrementAndGet();
            return CompletableFuture.completedFuture(Map.of("caption", "done"));
        }
        int calls() { return calls.get(); }
    }
}
