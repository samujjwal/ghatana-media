package com.ghatana.audiovideo.observability.performance;

import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.ThreadMXBean;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.OptionalLong;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Bounded test-only profiler for repeatable local Media workload fixtures.
 *
 * <p>This harness measures the current JVM process and caller-supplied operation timings. It does
 * not infer model quality or claim that a synthetic fixture measures any modality provider. GPU,
 * native allocator, connection-pool, network, FFmpeg child-process, and model-specific measures
 * remain explicitly unavailable until an owning adapter supplies those observations.
 */
public final class MediaResourceProfileHarness {
    public static final int[] REQUIRED_CONCURRENCY_LEVELS = {1, 16, 64};
    public static final int MAX_OPERATIONS = 512;
    public static final Duration MAX_BUDGET = Duration.ofSeconds(30);

    private static final long SAMPLE_PERIOD_NANOS = TimeUnit.MILLISECONDS.toNanos(10);
    private static final long TERMINATION_GRACE_MILLIS = 500;
    private static final AtomicInteger THREAD_SEQUENCE = new AtomicInteger();
    private static final MemoryMXBean MEMORY = ManagementFactory.getMemoryMXBean();
    private static final ThreadMXBean THREADS = ManagementFactory.getThreadMXBean();
    private static final com.sun.management.OperatingSystemMXBean PROCESS =
            ManagementFactory.getOperatingSystemMXBean() instanceof com.sun.management.OperatingSystemMXBean bean
                    ? bean
                    : null;

    public enum Resource {
        PROCESS_CPU_TIME_NANOS,
        HEAP_PEAK_BYTES,
        THREAD_PEAK,
        GPU_MEMORY_BYTES,
        NATIVE_MEMORY_BYTES,
        CONNECTION_POOL_SIZE,
        NETWORK_BYTES,
        FFMPEG_CHILD_PROCESSES,
        MODEL_REAL_TIME_FACTOR,
        VIDEO_FRAMES_PER_SECOND,
        CONTAINER_MEMORY_LIMIT_BYTES,
        CONTAINER_CPU_LIMIT_CORES,
        CONTAINER_PROCESS_LIMIT
    }

    public enum State {
        MEASURED,
        NOT_MEASURED
    }

    public enum Outcome {
        COMPLETED,
        FAILED,
        ABORTED
    }

    public record Reading(State state, double value, String unit, String reason) {
        public Reading {
            Objects.requireNonNull(state, "state");
            Objects.requireNonNull(unit, "unit");
            Objects.requireNonNull(reason, "reason");
            if (state == State.MEASURED && !Double.isFinite(value)) {
                throw new IllegalArgumentException("measured resource value must be finite");
            }
            if (state == State.NOT_MEASURED && !Double.isNaN(value)) {
                throw new IllegalArgumentException("unmeasured resource value must be NaN");
            }
        }

        static Reading measured(double value, String unit) {
            return new Reading(State.MEASURED, value, unit, "");
        }

        static Reading notMeasured(String unit, String reason) {
            return new Reading(State.NOT_MEASURED, Double.NaN, unit, reason);
        }
    }

    public record Environment(String javaVersion, String javaVendor, String runtimeName,
                              String operatingSystem, String operatingSystemVersion, String architecture,
                              int availableProcessors, String modelProfile, String corpusProfile) {}

    public record Report(
            int concurrency,
            int requestedOperations,
            int completedOperations,
            int failedOperations,
            int incompleteOperations,
            Outcome outcome,
            boolean workerPoolTerminated,
            long budgetNanos,
            long elapsedNanos,
            double throughputOperationsPerSecond,
            double p50Millis,
            double p95Millis,
            double p99Millis,
            Environment environment,
            Map<Resource, Reading> resources) {
        public Report {
            Objects.requireNonNull(outcome, "outcome");
            Objects.requireNonNull(environment, "environment");
            resources = Map.copyOf(resources);
        }

        /** Stable tab-separated row suitable for a local benchmark artifact. */
        public String toTsv() {
            return String.join("\t",
                    "local-test-workload-no-provider",
                    "NOT_ADMITTED",
                    Integer.toString(concurrency),
                    Integer.toString(requestedOperations),
                    formatMillis(budgetNanos),
                    Integer.toString(completedOperations),
                    Integer.toString(failedOperations),
                    Integer.toString(incompleteOperations),
                    outcome.name(),
                    Boolean.toString(workerPoolTerminated),
                    formatMillis(elapsedNanos),
                    Double.toString(throughputOperationsPerSecond),
                    Double.toString(p50Millis),
                    Double.toString(p95Millis),
                    Double.toString(p99Millis),
                    render(resources.get(Resource.PROCESS_CPU_TIME_NANOS)),
                    render(resources.get(Resource.HEAP_PEAK_BYTES)),
                    render(resources.get(Resource.THREAD_PEAK)),
                    render(resources.get(Resource.GPU_MEMORY_BYTES)),
                    render(resources.get(Resource.NATIVE_MEMORY_BYTES)),
                    render(resources.get(Resource.CONNECTION_POOL_SIZE)),
                    render(resources.get(Resource.NETWORK_BYTES)),
                    render(resources.get(Resource.FFMPEG_CHILD_PROCESSES)),
                    render(resources.get(Resource.MODEL_REAL_TIME_FACTOR)),
                    render(resources.get(Resource.VIDEO_FRAMES_PER_SECOND)),
                    render(resources.get(Resource.CONTAINER_MEMORY_LIMIT_BYTES)),
                    render(resources.get(Resource.CONTAINER_CPU_LIMIT_CORES)),
                    render(resources.get(Resource.CONTAINER_PROCESS_LIMIT)),
                    tsvField(environment.javaVersion()),
                    tsvField(environment.javaVendor()),
                    tsvField(environment.runtimeName()),
                    tsvField(environment.operatingSystem()),
                    tsvField(environment.operatingSystemVersion()),
                    tsvField(environment.architecture()),
                    Integer.toString(environment.availableProcessors()),
                    tsvField(environment.modelProfile()),
                    tsvField(environment.corpusProfile()));
        }

        public static String tsvHeader() {
            return String.join("\t",
                    "scope", "admission", "concurrency", "requested_operations", "budget_ms", "completed_operations",
                    "failed_operations", "incomplete_operations", "outcome", "worker_pool_terminated",
                    "elapsed_ms", "throughput_ops_s", "p50_ms", "p95_ms", "p99_ms",
                    "process_cpu_time_nanos", "heap_peak_bytes", "thread_peak", "gpu_memory_bytes",
                    "native_memory_bytes", "connection_pool_size", "network_bytes", "ffmpeg_child_processes",
                    "model_real_time_factor", "video_frames_per_second", "container_memory_limit_bytes",
                    "container_cpu_limit_cores", "container_process_limit", "java_version", "java_vendor",
                    "runtime_name", "os", "os_version", "architecture", "available_processors",
                    "model_profile", "corpus_profile");
        }
    }

    @FunctionalInterface
    public interface Operation {
        void run(int operationIndex) throws Exception;
    }

    private record ResourceSnapshot(long heapUsedBytes, int threadCount, OptionalLong processCpuNanos) {}

    private MediaResourceProfileHarness() {}

    /**
     * Execute a bounded batch at one of the plan's registered concurrency levels.
     *
     * <p>Timeout cancellation is cooperative. The result reports whether all worker threads
     * stopped within the grace period; the JVM cannot safely force-kill an uncooperative native
     * call. Native/FFmpeg workloads that need hard process termination must be measured by their
     * process-boundary harness.
     */
    public static Report measure(int concurrency, int operations, Duration budget, Operation operation)
            throws InterruptedException {
        Objects.requireNonNull(budget, "budget");
        Objects.requireNonNull(operation, "operation");
        if (!isRequiredConcurrency(concurrency)) {
            throw new IllegalArgumentException("concurrency must be one of 1, 16, or 64");
        }
        if (operations < 1 || operations > MAX_OPERATIONS) {
            throw new IllegalArgumentException("operations must be between 1 and " + MAX_OPERATIONS);
        }
        if (budget.isZero() || budget.isNegative() || budget.compareTo(MAX_BUDGET) > 0) {
            throw new IllegalArgumentException(
                    "budget must be positive and at most " + MAX_BUDGET.toSeconds() + " seconds");
        }

        var latencies = new ConcurrentLinkedQueue<Long>();
        var snapshots = new ConcurrentLinkedQueue<ResourceSnapshot>();
        var failures = new AtomicInteger();
        var completed = new AtomicInteger();
        var workerFactory = daemonFactory("media-profile-worker-");
        var workers = new ThreadPoolExecutor(concurrency, concurrency, 0, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(operations), workerFactory, new ThreadPoolExecutor.AbortPolicy());
        workers.prestartAllCoreThreads();
        ScheduledExecutorService sampler = java.util.concurrent.Executors.newSingleThreadScheduledExecutor(
                daemonFactory("media-profile-sampler-"));
        ResourceSnapshot before = snapshot();
        snapshots.add(before);
        sampler.scheduleAtFixedRate(() -> snapshots.add(snapshot()), 0, SAMPLE_PERIOD_NANOS,
                TimeUnit.NANOSECONDS);

        long started = System.nanoTime();
        long deadline = started + budget.toNanos();
        var futures = new ArrayList<Future<?>>(operations);
        for (int i = 0; i < operations; i++) {
            final int operationIndex = i;
            final long submittedAt = System.nanoTime();
            futures.add(workers.submit(() -> {
                try {
                    operation.run(operationIndex);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    failures.incrementAndGet();
                } catch (Exception failure) {
                    failures.incrementAndGet();
                } finally {
                    // Include bounded-queue wait in observed request latency.
                    latencies.add(System.nanoTime() - submittedAt);
                    completed.incrementAndGet();
                }
            }));
        }

        boolean aborted = false;
        boolean terminated = false;
        try {
            try {
                for (Future<?> future : futures) {
                    long remaining = deadline - System.nanoTime();
                    if (remaining <= 0) {
                        aborted = true;
                        break;
                    }
                    try {
                        future.get(remaining, TimeUnit.NANOSECONDS);
                    } catch (TimeoutException timeout) {
                        aborted = true;
                        break;
                    } catch (java.util.concurrent.ExecutionException unexpected) {
                        failures.incrementAndGet();
                    }
                }
            } catch (InterruptedException interrupted) {
                aborted = true;
                Thread.currentThread().interrupt();
                throw interrupted;
            } finally {
                if (aborted) {
                    futures.forEach(future -> future.cancel(true));
                    workers.shutdownNow();
                } else {
                    workers.shutdown();
                }
            }

            try {
                terminated = workers.awaitTermination(TERMINATION_GRACE_MILLIS, TimeUnit.MILLISECONDS);
                if (!terminated) workers.shutdownNow();
            } catch (InterruptedException interrupted) {
                workers.shutdownNow();
                Thread.currentThread().interrupt();
                throw interrupted;
            }
        } finally {
            sampler.shutdownNow();
        }
        long finished = System.nanoTime();
        ResourceSnapshot after = snapshot();
        snapshots.add(after);

        List<Long> orderedLatencies = new ArrayList<>(latencies);
        orderedLatencies.sort(Comparator.naturalOrder());
        long elapsed = Math.max(1, finished - started);
        int completedCount = completed.get();
        int failedCount = Math.min(failures.get(), completedCount);
        int incompleteCount = Math.max(0, operations - completedCount);
        double throughput = Math.max(0, completedCount - failedCount) / (elapsed / 1_000_000_000.0);
        Map<Resource, Reading> resources = summarizeResources(before, after, snapshots);

        return new Report(concurrency, operations, completedCount, failedCount, incompleteCount,
                aborted ? Outcome.ABORTED : failedCount > 0 ? Outcome.FAILED : Outcome.COMPLETED,
                terminated, budget.toNanos(), elapsed, throughput,
                percentileMillis(orderedLatencies, 0.50), percentileMillis(orderedLatencies, 0.95),
                percentileMillis(orderedLatencies, 0.99), environment(), resources);
    }

    private static Map<Resource, Reading> summarizeResources(
            ResourceSnapshot before, ResourceSnapshot after, ConcurrentLinkedQueue<ResourceSnapshot> samples) {
        var result = new EnumMap<Resource, Reading>(Resource.class);
        if (before.processCpuNanos().isPresent() && after.processCpuNanos().isPresent()) {
            result.put(Resource.PROCESS_CPU_TIME_NANOS, Reading.measured(
                    Math.max(0, after.processCpuNanos().getAsLong() - before.processCpuNanos().getAsLong()), "ns"));
        } else {
            result.put(Resource.PROCESS_CPU_TIME_NANOS,
                    Reading.notMeasured("ns", "The current JVM does not expose process CPU time."));
        }

        int threadPeak = samples.stream().mapToInt(ResourceSnapshot::threadCount).max().orElse(after.threadCount());
        result.put(Resource.HEAP_PEAK_BYTES, summarizeHeapPeak(
                samples.stream().mapToLong(ResourceSnapshot::heapUsedBytes).toArray()));
        result.put(Resource.THREAD_PEAK, Reading.measured(threadPeak, "threads"));
        for (Resource resource : List.of(Resource.GPU_MEMORY_BYTES, Resource.NATIVE_MEMORY_BYTES,
                Resource.CONNECTION_POOL_SIZE, Resource.NETWORK_BYTES, Resource.FFMPEG_CHILD_PROCESSES,
                Resource.MODEL_REAL_TIME_FACTOR, Resource.VIDEO_FRAMES_PER_SECOND)) {
            result.put(resource, Reading.notMeasured(unit(resource),
                    "No owning modality, provider, native-process, or connection-pool probe was registered."));
        }
        result.put(Resource.CONTAINER_MEMORY_LIMIT_BYTES, readCgroupMemoryLimit());
        result.put(Resource.CONTAINER_CPU_LIMIT_CORES, readCgroupCpuLimit());
        result.put(Resource.CONTAINER_PROCESS_LIMIT, readCgroupProcessLimit());
        return result;
    }

    private static ResourceSnapshot snapshot() {
        long heapUsed = MEMORY.getHeapMemoryUsage().getUsed();
        int threadCount = THREADS.getThreadCount();
        OptionalLong processCpu = OptionalLong.empty();
        if (PROCESS != null) {
            long cpuNanos = PROCESS.getProcessCpuTime();
            if (cpuNanos >= 0) processCpu = OptionalLong.of(cpuNanos);
        }
        return new ResourceSnapshot(heapUsed, Math.max(0, threadCount), processCpu);
    }

    /** Preserve the JVM's -1 unknown sentinel instead of reporting an invented zero-byte peak. */
    static Reading summarizeHeapPeak(long... samples) {
        long peak = -1;
        for (long sample : samples) {
            if (sample < 0) {
                return Reading.notMeasured("bytes", "At least one JVM heap sample was unavailable.");
            }
            peak = Math.max(peak, sample);
        }
        return peak < 0
                ? Reading.notMeasured("bytes", "No JVM heap samples were collected.")
                : Reading.measured(peak, "bytes");
    }

    private static Environment environment() {
        return new Environment(Runtime.version().toString(), System.getProperty("java.vendor", "unknown"),
                ManagementFactory.getRuntimeMXBean().getVmName(), System.getProperty("os.name", "unknown"),
                System.getProperty("os.version", "unknown"), System.getProperty("os.arch", "unknown"),
                Runtime.getRuntime().availableProcessors(),
                "NOT_CONFIGURED", "NOT_CONFIGURED");
    }

    /**
     * Read Linux cgroup-v2 limits when exposed to this JVM. Missing, unlimited, or unreadable
     * limits stay NOT_MEASURED; host RSS and availableProcessors are not substituted for them.
     */
    private static Reading readCgroupMemoryLimit() {
        return readCgroupValue(Path.of("/sys/fs/cgroup/memory.max"),
                MediaResourceProfileHarness::parseMemoryLimit);
    }

    private static Reading readCgroupCpuLimit() {
        return readCgroupValue(Path.of("/sys/fs/cgroup/cpu.max"),
                MediaResourceProfileHarness::parseCpuLimit);
    }

    private static Reading readCgroupProcessLimit() {
        return readCgroupValue(Path.of("/sys/fs/cgroup/pids.max"),
                MediaResourceProfileHarness::parseProcessLimit);
    }

    @FunctionalInterface
    private interface CgroupParser {
        Reading parse(String value);
    }

    private static Reading readCgroupValue(Path path, CgroupParser parser) {
        try {
            return parser.parse(Files.readString(path).trim());
        } catch (java.io.IOException | SecurityException unavailable) {
            return Reading.notMeasured(unitForCgroup(path), "Linux cgroup-v2 limit is not exposed to this process.");
        }
    }

    static Reading parseMemoryLimit(String value) {
        if ("max".equals(value)) return Reading.notMeasured("bytes", "The cgroup memory limit is unlimited.");
        try {
            long bytes = Long.parseLong(value);
            return bytes >= 0 ? Reading.measured(bytes, "bytes")
                    : Reading.notMeasured("bytes", "The cgroup memory limit is invalid.");
        } catch (NumberFormatException invalid) {
            return Reading.notMeasured("bytes", "The cgroup memory limit is invalid.");
        }
    }

    static Reading parseCpuLimit(String value) {
        String[] fields = value.trim().split("\\s+");
        if (fields.length == 2 && "max".equals(fields[0])) {
            return Reading.notMeasured("cores", "The cgroup CPU limit is unlimited.");
        }
        try {
            if (fields.length != 2) throw new NumberFormatException();
            long quota = Long.parseLong(fields[0]);
            long period = Long.parseLong(fields[1]);
            if (quota < 0 || period <= 0) throw new NumberFormatException();
            return Reading.measured((double) quota / period, "cores");
        } catch (NumberFormatException invalid) {
            return Reading.notMeasured("cores", "The cgroup CPU limit is invalid.");
        }
    }

    static Reading parseProcessLimit(String value) {
        if ("max".equals(value)) {
            return Reading.notMeasured("processes", "The cgroup process limit is unlimited.");
        }
        try {
            long processes = Long.parseLong(value);
            return processes >= 0 ? Reading.measured(processes, "processes")
                    : Reading.notMeasured("processes", "The cgroup process limit is invalid.");
        } catch (NumberFormatException invalid) {
            return Reading.notMeasured("processes", "The cgroup process limit is invalid.");
        }
    }

    private static String unitForCgroup(Path path) {
        return switch (path.getFileName().toString()) {
            case "memory.max" -> "bytes";
            case "cpu.max" -> "cores";
            default -> "processes";
        };
    }

    private static double percentileMillis(List<Long> sortedNanos, double percentile) {
        if (sortedNanos.isEmpty()) return Double.NaN;
        int index = Math.max(0, (int) Math.ceil(percentile * sortedNanos.size()) - 1);
        return sortedNanos.get(Math.min(index, sortedNanos.size() - 1)) / 1_000_000.0;
    }

    private static boolean isRequiredConcurrency(int value) {
        for (int concurrency : REQUIRED_CONCURRENCY_LEVELS) {
            if (concurrency == value) return true;
        }
        return false;
    }

    private static String unit(Resource resource) {
        return switch (resource) {
            case GPU_MEMORY_BYTES, NATIVE_MEMORY_BYTES, NETWORK_BYTES, CONTAINER_MEMORY_LIMIT_BYTES -> "bytes";
            case CONNECTION_POOL_SIZE, FFMPEG_CHILD_PROCESSES -> "count";
            case MODEL_REAL_TIME_FACTOR -> "ratio";
            case VIDEO_FRAMES_PER_SECOND -> "frames/s";
            case CONTAINER_CPU_LIMIT_CORES -> "cores";
            case CONTAINER_PROCESS_LIMIT -> "processes";
            case PROCESS_CPU_TIME_NANOS -> "ns";
            case HEAP_PEAK_BYTES -> "bytes";
            case THREAD_PEAK -> "threads";
        };
    }

    private static String render(Reading reading) {
        if (reading == null) return "NOT_MEASURED:not reported";
        if (reading.state() == State.NOT_MEASURED) {
            String reason = reading.reason().replace('\t', ' ').replace('\n', ' ').replace('\r', ' ');
            return "NOT_MEASURED:" + reason;
        }
        return Double.toString(reading.value());
    }

    private static String formatMillis(long nanos) {
        return Double.toString(nanos / 1_000_000.0);
    }

    private static String tsvField(String value) {
        if (value == null) return "";
        StringBuilder sanitized = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char character = value.charAt(i);
            sanitized.append(Character.isISOControl(character) ? ' ' : character);
        }
        return sanitized.toString();
    }

    private static ThreadFactory daemonFactory(String prefix) {
        return runnable -> {
            Thread thread = new Thread(runnable, prefix + THREAD_SEQUENCE.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        };
    }
}
