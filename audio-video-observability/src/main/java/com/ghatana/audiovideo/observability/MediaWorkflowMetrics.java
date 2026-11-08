package com.ghatana.audiovideo.observability;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.ThreadMXBean;
import java.util.EnumMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.DoubleSupplier;
import java.time.Instant;

/**
 * Bounded-cardinality metrics for Media job processing and delivery.
 *
 * <p>No tenant, request, job, attempt, provider credential, or content value is accepted as a
 * metric tag. Use traces with access controls for per-operation diagnosis; these metrics remain
 * aggregate and tenant-safe.
 */
public final class MediaWorkflowMetrics {
    public static final String CONTRACT_VERSION = "v1";
    private static final Set<String> SERVICES = Set.of(
            "launcher", "stt", "tts", "vision", "multimodal", "ai-voice", "unknown");
    private static final MemoryMXBean MEMORY = ManagementFactory.getMemoryMXBean();
    private static final ThreadMXBean THREADS = ManagementFactory.getThreadMXBean();
    private static final Runtime JVM_RUNTIME = Runtime.getRuntime();
    private static final com.sun.management.OperatingSystemMXBean PROCESS =
            ManagementFactory.getOperatingSystemMXBean() instanceof com.sun.management.OperatingSystemMXBean bean
                    ? bean : null;

    public enum Event {
        UNKNOWN,
        RETRY,
        FENCED,
        DENIED,
        PUBLICATION_AMBIGUOUS
    }

    public enum Stage {
        REQUEST,
        POLICY,
        JOB,
        ATTEMPT,
        OUTBOX,
        PROVIDER,
        CONSUMER
    }

    /** Bounded modality labels used by the modality instrumentation added in Wave 2. */
    public enum Modality {
        STT("stt"),
        TTS("tts"),
        VISION("vision"),
        MULTIMODAL("multimodal");

        private final String label;

        Modality(String label) {
            this.label = label;
        }
    }

    /** Actual service boundaries; execution class is derived and cannot be supplied by callers. */
    public enum Boundary {
        ADMISSION("admission", "control"),
        QUEUE_WAIT("queue_wait", "control"),
        PROVIDER("provider", "model"),
        DECODE("decode", "model"),
        RESPONSE("response", "control");

        private final String label;
        private final String executionClass;

        Boundary(String label, String executionClass) {
            this.label = label;
            this.executionClass = executionClass;
        }
    }

    /** Outcome for a measured boundary; UNKNOWN is deliberately distinct from success. */
    public enum Outcome {
        SUCCESS("success"),
        UNKNOWN("unknown"),
        FAILURE("failure");

        private final String label;

        Outcome(String label) {
            this.label = label;
        }
    }

    /** Fixed capture source-kind labels; never accepts session or source identifiers. */
    public enum CaptureKind {
        AUDIO("audio"),
        VIDEO("video"),
        MULTIMODAL("multimodal");

        private final String label;

        CaptureKind(String label) {
            this.label = label;
        }
    }

    /** Provider readiness vocabulary exported without tenant or request identity. */
    public enum ProviderReadiness {
        HEALTHY,
        DEGRADED,
        UNAVAILABLE
    }

    /**
     * Source-owned provider/profile observation. Quality freshness is NaN when no real quality
     * observation exists; a readiness check alone never fabricates model quality.
     */
    public record ProviderProfileObservation(
            String providerId,
            String providerVersion,
            String modelProfile,
            String modelRevision,
            ProviderReadiness readiness,
            Instant checkedAt,
            Instant qualityObservedAt) {
        public ProviderProfileObservation {
            providerId = metricIdentity(providerId, "providerId");
            providerVersion = metricIdentity(providerVersion, "providerVersion");
            modelProfile = metricIdentity(modelProfile, "modelProfile");
            modelRevision = metricIdentity(modelRevision, "modelRevision");
            java.util.Objects.requireNonNull(readiness, "readiness");
            java.util.Objects.requireNonNull(checkedAt, "checkedAt");
            if (qualityObservedAt != null && qualityObservedAt.isAfter(checkedAt)) {
                throw new IllegalArgumentException("quality observation cannot be newer than the profile check");
            }
        }
    }

    /**
     * One bounded measured-quality sample row for a provider model revision,
     * sourced only from a verified source-linked evaluation report. Labels use a
     * fixed vocabulary: {@code aggregate} or a bounded lowercase locale token, a
     * registered metric name, and a provenance scope. No tenant, clip, speaker,
     * transcript, report path or free-form value is exported. A {@code
     * reference_only} row is a development measurement, never a qualified-model
     * or production-SLO series.
     */
    public record ProviderQualitySeriesSample(
            String locale,
            String metric,
            double value,
            Instant measuredAt,
            String scope) {
        public ProviderQualitySeriesSample {
            locale = locale == null ? "" : locale.trim();
            // Preserve the active Common Voice v27 locale spellings. Runtime metric
            // labels are normalized to lowercase before they reach this type; other
            // existing sources use ISO 639-3 tags such as `eng` and `hin`.
            if (!"aggregate".equals(locale) && !locale.matches("[a-z]{3}")
                    && !QUALITY_TWO_LETTER_LOCALES.contains(locale)) {
                throw new IllegalArgumentException(
                        "quality locale must be aggregate or a supported source locale code");
            }
            if (metric == null || !QUALITY_METRICS.contains(metric)) {
                throw new IllegalArgumentException("quality metric is outside the bounded vocabulary");
            }
            if (!Double.isFinite(value) || value < 0) {
                throw new IllegalArgumentException("quality value must be finite and nonnegative");
            }
            java.util.Objects.requireNonNull(measuredAt, "measuredAt");
            if (scope == null || !QUALITY_SCOPES.contains(scope)) {
                throw new IllegalArgumentException("quality scope is outside the bounded vocabulary");
            }
        }
    }

    /** A single-use monotonic timer bound to its bounded modality, boundary, and outcome. */
    public static final class ModalityTimingSample {
        private final Timer.Sample sample;
        private final Modality modality;
        private final Boundary boundary;
        private final AtomicBoolean stopped = new AtomicBoolean();

        private ModalityTimingSample(Timer.Sample sample, Modality modality, Boundary boundary) {
            this.sample = sample;
            this.modality = modality;
            this.boundary = boundary;
        }
    }

    private record ModalityMetricKey(Modality modality, Boundary boundary, Outcome outcome) {}

    private record ProviderProfileKey(Modality modality, String providerId, String providerVersion,
                                      String modelProfile, String modelRevision) {}

    private record ProviderQualityGroupKey(Modality modality, String providerId,
                                           String providerVersion, String modelRevision) {}

    private record ProviderQualityKey(Modality modality, String providerId, String providerVersion,
                                      String modelRevision, String locale, String metric,
                                      String scope) {}

    private record ProviderQualityRefresh(Instant checkedAt,
            Map<ProviderQualityKey, ProviderQualitySeriesSample> samples, boolean conflicted) {}

    private static final int MAX_PROVIDER_PROFILES = 64;
    private static final int MAX_PROVIDER_QUALITY_SERIES = 1024;
    private static final int MAX_QUALITY_SAMPLES_PER_MODEL = 32;
    /** Fixed measured-quality label vocabulary; no free-form or source-derived label. */
    private static final Set<String> QUALITY_METRICS = Set.of(
            "wer", "cer", "map50", "real_time_factor", "intelligibility",
            "wer_ci95_lower", "wer_ci95_upper");
    private static final Set<String> QUALITY_SCOPES = Set.of(
            "reference_only", "independent_qualified");
    private static final Set<String> QUALITY_TWO_LETTER_LOCALES = Set.of("en", "ne-np");

    private final Map<Stage, Timer> stageTimers = new EnumMap<>(Stage.class);
    private final MeterRegistry registry;
    private final ConcurrentMap<ModalityMetricKey, Timer> modalityTimers = new ConcurrentHashMap<>();
    private final ConcurrentMap<ProviderProfileKey, ProviderProfileGauges> providerProfiles =
            new ConcurrentHashMap<>();
    private final Object providerProfileLock = new Object();
    private final ConcurrentMap<ProviderQualityKey, AtomicReference<Double>> providerQualitySeries =
            new ConcurrentHashMap<>();
    private final ConcurrentMap<ProviderQualityGroupKey, ProviderQualityRefresh> providerQualityRefreshes =
            new ConcurrentHashMap<>();
    private final Object providerQualityLock = new Object();
    private final Map<Event, Counter> eventCounters = new EnumMap<>(Event.class);
    private final String safeService;
    private final Counter requests;
    private final AtomicReference<Double> queueDepth = new AtomicReference<>(Double.NaN);
    private final AtomicReference<Double> unknownBacklog = new AtomicReference<>(Double.NaN);
    private final AtomicReference<Double> overdueLeases = new AtomicReference<>(Double.NaN);
    private final AtomicReference<Double> aggregateStoreQueriesSupported = new AtomicReference<>(Double.NaN);
    private final AtomicReference<Double> overdueOutboxClaims = new AtomicReference<>(Double.NaN);
    private final AtomicReference<Double> outboxStoreQueriesSupported = new AtomicReference<>(Double.NaN);

    private static final class ProviderProfileGauges {
        private final AtomicReference<Double> readiness = new AtomicReference<>(Double.NaN);
        private final AtomicReference<Double> checkedAt = new AtomicReference<>(Double.NaN);
        private final AtomicReference<Double> qualityObservedAt = new AtomicReference<>(Double.NaN);
        private final AtomicReference<Double> observationConflict = new AtomicReference<>(Double.NaN);
        private ProviderProfileObservation latestObservation;
        private boolean latestObservationConflicted;
    }

    public MediaWorkflowMetrics(MeterRegistry registry, String service) {
        this.registry = registry;
        this.safeService = SERVICES.contains(service) ? service : "unknown";
        for (Stage stage : Stage.values()) {
            stageTimers.put(stage, Timer.builder("media.workflow.stage.duration")
                    .description("Duration spent in a Media workflow stage")
                    .publishPercentileHistogram()
                    .tag("stage", stage.name().toLowerCase())
                    .tag("service", safeService)
                    .tag("contract_version", CONTRACT_VERSION)
                    .register(registry));
        }
        for (Event event : Event.values()) {
            eventCounters.put(event, Counter.builder("media.workflow.events")
                    .description("Aggregate Media workflow state and control events")
                    .tag("event", event.name().toLowerCase())
                    .tag("service", safeService)
                    .tag("contract_version", CONTRACT_VERSION)
                    .register(registry));
        }
        requests = Counter.builder("media.workflow.requests")
                .description("Aggregate Media workflow requests")
                .tag("service", safeService)
                .tag("contract_version", CONTRACT_VERSION)
                .register(registry);
        Gauge.builder("media.workflow.queue.depth", queueDepth, AtomicReference::get)
                .description("Aggregate Media work queue depth; NaN until a complete durable-store refresh")
                .tag("service", safeService)
                .tag("contract_version", CONTRACT_VERSION)
                .register(registry);
        Gauge.builder("media.workflow.unknown.backlog", unknownBacklog, AtomicReference::get)
                .description("Media jobs with unknown finality; NaN until a complete durable-store refresh")
                .tag("service", safeService)
                .tag("contract_version", CONTRACT_VERSION)
                .register(registry);
        Gauge.builder("media.workflow.lease.overdue", overdueLeases, AtomicReference::get)
                .description("Expired Media job leases; NaN until a complete durable-store refresh")
                .tag("service", safeService)
                .tag("contract_version", CONTRACT_VERSION)
                .register(registry);
        Gauge.builder("media.workflow.aggregate_store_queries_supported", aggregateStoreQueriesSupported,
                        AtomicReference::get)
                .description("1 for a complete durable-store snapshot, 0 for unsupported or failed queries, NaN before refresh")
                .tag("service", safeService)
                .tag("contract_version", CONTRACT_VERSION)
                .register(registry);
        Gauge.builder("media.workflow.outbox.lease.overdue", overdueOutboxClaims, AtomicReference::get)
                .description("Expired durable Media outbox claim leases; NaN until a complete outbox refresh")
                .tag("service", safeService)
                .tag("contract_version", CONTRACT_VERSION)
                .register(registry);
        Gauge.builder("media.workflow.outbox.aggregate_store_queries_supported", outboxStoreQueriesSupported,
                        AtomicReference::get)
                .description("1 for complete durable outbox lease counts, 0 for unsupported or failed queries, NaN before refresh")
                .tag("service", safeService)
                .tag("contract_version", CONTRACT_VERSION)
                .register(registry);
        registerRuntimeResourceGauges();
    }

    /** Register live JVM/process resource observations on the same registry as the scrape route. */
    private void registerRuntimeResourceGauges() {
        Gauge.builder("media.runtime.jvm.heap.used.bytes", MEMORY,
                        bean -> (double) bean.getHeapMemoryUsage().getUsed())
                .description("Current JVM heap use in bytes")
                .tag("service", safeService).tag("contract_version", CONTRACT_VERSION).register(registry);
        Gauge.builder("media.runtime.jvm.heap.max.bytes", MEMORY, bean -> {
                    long maximum = bean.getHeapMemoryUsage().getMax();
                    return maximum < 0 ? Double.NaN : (double) maximum;
                })
                .description("Configured JVM heap maximum in bytes; NaN when the runtime does not report a limit")
                .tag("service", safeService).tag("contract_version", CONTRACT_VERSION).register(registry);
        Gauge.builder("media.runtime.jvm.heap.committed.bytes", MEMORY,
                        bean -> (double) bean.getHeapMemoryUsage().getCommitted())
                .description("Heap memory committed by the JVM in bytes")
                .tag("service", safeService).tag("contract_version", CONTRACT_VERSION).register(registry);
        Gauge.builder("media.runtime.jvm.threads", THREADS, bean -> (double) bean.getThreadCount())
                .description("Current live JVM thread count")
                .tag("service", safeService).tag("contract_version", CONTRACT_VERSION).register(registry);
        Gauge.builder("media.runtime.jvm.processors.available", JVM_RUNTIME,
                        runtime -> (double) runtime.availableProcessors())
                .description("Processors reported available to this JVM; this is not a provider or container quota qualification")
                .tag("service", safeService).tag("contract_version", CONTRACT_VERSION).register(registry);
        Gauge.builder("media.runtime.process.cpu.utilization", MEMORY,
                        ignored -> processCpuLoad())
                .description("Current process CPU utilization from the JVM operating-system probe; NaN when unsupported")
                .tag("service", safeService).tag("contract_version", CONTRACT_VERSION).register(registry);
    }

    private static double processCpuLoad() {
        return PROCESS == null ? Double.NaN : processCpuLoad(PROCESS::getProcessCpuLoad);
    }

    /** Return UNKNOWN when the JVM's optional process CPU probe is unsupported or fails. */
    static double processCpuLoad(DoubleSupplier probe) {
        try {
            double value = probe.getAsDouble();
            return value < 0 || value > 1 || !Double.isFinite(value) ? Double.NaN : value;
        } catch (RuntimeException unavailable) {
            return Double.NaN;
        }
    }

    public Timer.Sample startTimer() {
        return Timer.start();
    }

    /** Prometheus exposition from this instance's registry, or empty for a non-scrape registry. */
    public String scrape() {
        if (registry instanceof io.micrometer.prometheusmetrics.PrometheusMeterRegistry prometheus) {
            return prometheus.scrape();
        }
        return "";
    }

    public void stopTimer(Timer.Sample sample, Stage stage) {
        if (sample == null || stage == null) return;
        try {
            sample.stop(stageTimers.get(stage));
        } catch (RuntimeException ignored) {
            // Stage timing is observational and must not replace the workflow result it observes.
        }
    }

    /**
     * Start a bounded modality boundary measurement. Micrometer's sample uses its monotonic clock;
     * no proposed latency target or model-quality claim is attached to the observation.
     */
    public ModalityTimingSample startModalityTimer(Modality modality, Boundary boundary) {
        if (modality == null || boundary == null) return null;
        return new ModalityTimingSample(Timer.start(), modality, boundary);
    }

    /** Stop a modality timing sample once with the outcome known at the end of the boundary. */
    public void stopModalityTimer(ModalityTimingSample sample, Outcome outcome) {
        if (sample == null || outcome == null || !sample.stopped.compareAndSet(false, true)) return;
        try {
            ModalityMetricKey key = new ModalityMetricKey(sample.modality, sample.boundary, outcome);
            Timer timer = modalityTimers.computeIfAbsent(key, this::newModalityTimer);
            sample.sample.stop(timer);
        } catch (RuntimeException ignored) {
            // Instrumentation must not replace the RPC/provider outcome it observes.
        }
    }

    private Timer newModalityTimer(ModalityMetricKey key) {
        return Timer.builder("media.modality.boundary.duration")
                .description("Duration measured at a Media modality service boundary")
                .publishPercentiles(0.50, 0.95, 0.99)
                .publishPercentileHistogram()
                .tag("modality", key.modality().label)
                .tag("service", safeService)
                .tag("boundary", key.boundary().label)
                .tag("execution_class", key.boundary().executionClass)
                .tag("outcome", key.outcome().label)
                .tag("contract_version", CONTRACT_VERSION)
                .register(registry);
    }

    public void record(Event event) {
        if (event == null) return;
        try {
            eventCounters.get(event).increment();
        } catch (RuntimeException ignored) {
            // Aggregate event instrumentation must not replace the workflow result it observes.
        }
    }

    /** Count one canonical stream-frame outcome using only fixed-cardinality labels. */
    public void recordCaptureFrame(CaptureKind kind, Outcome outcome) {
        if (kind == null || outcome == null) return;
        try {
            registry.counter("media.capture.frames",
                    "kind", kind.label,
                    "outcome", outcome.label,
                    "service", safeService,
                    "contract_version", CONTRACT_VERSION).increment();
        } catch (RuntimeException ignored) {
            // Metrics are observational. A broken registry must not turn a durable frame ACK
            // into an apparent capture failure after the canonical cursor has already advanced.
        }
    }

    /**
     * Export the latest provider/profile readiness and measured-quality freshness. The registry
     * keeps at most 64 provider profiles per service instance. Older observations and conflicting
     * observations with the same check time are rejected; exact duplicates are idempotent. A
     * profile check with no measured quality timestamp exports NaN, never zero or a healthy quality value.
     *
     * @return false when the bounded profile series capacity has been reached or the observation is stale
     */
    public boolean recordProviderProfile(Modality modality, ProviderProfileObservation observation) {
        if (modality == null || observation == null) return false;
        ProviderProfileKey key = new ProviderProfileKey(modality, observation.providerId(),
                observation.providerVersion(), observation.modelProfile(), observation.modelRevision());
        ProviderProfileGauges gauges;
        synchronized (providerProfileLock) {
            gauges = providerProfiles.get(key);
            if (gauges == null) {
                if (providerProfiles.size() >= MAX_PROVIDER_PROFILES) {
                    recordRejectedObservation("media.provider.profile.observation.rejected");
                    return false;
                }
                gauges = new ProviderProfileGauges();
                registerProviderGauges(key, gauges);
                providerProfiles.put(key, gauges);
            }
        }
        synchronized (gauges) {
            ProviderProfileObservation latest = gauges.latestObservation;
            if (latest != null && observation.checkedAt().isBefore(latest.checkedAt())) {
                recordRejectedObservation("media.provider.profile.observation.rejected");
                return false;
            }
            if (latest != null && observation.checkedAt().equals(latest.checkedAt())) {
                // Exact duplicates are idempotent only while the timestamp is unambiguous.
                // Conflicting outcomes at one check time cannot be ordered, so retain the
                // timestamp but clear the readiness/quality observation until a newer check.
                if (!gauges.latestObservationConflicted && observation.equals(latest)) return true;
                gauges.readiness.set(Double.NaN);
                gauges.qualityObservedAt.set(Double.NaN);
                gauges.observationConflict.set(1.0);
                gauges.latestObservationConflicted = true;
                recordRejectedObservation("media.provider.profile.observation.rejected");
                return false;
            }
            gauges.readiness.set(switch (observation.readiness()) {
                case HEALTHY -> 1.0;
                case DEGRADED -> 0.0;
                case UNAVAILABLE -> -1.0;
            });
            gauges.checkedAt.set(epochSeconds(observation.checkedAt()));
            gauges.qualityObservedAt.set(observation.qualityObservedAt() == null
                    ? Double.NaN : epochSeconds(observation.qualityObservedAt()));
            gauges.observationConflict.set(0.0);
            gauges.latestObservation = observation;
            gauges.latestObservationConflicted = false;
            return true;
        }
    }

    /**
     * Invalidate current provider health and measured-quality values after an
     * inconclusive provider poll, unless a newer poll has already published its
     * observation. The poll-start timestamp keeps a slow failure from erasing a
     * later completed refresh; retained timestamps still fence out stale data.
     */
    public void markProviderProfileObservationUnknown(String providerId, Instant observedAt) {
        if (providerId == null || observedAt == null) return;
        synchronized (providerProfileLock) {
            providerProfiles.forEach((key, gauges) -> {
                if (key.providerId().equals(providerId)) {
                    synchronized (gauges) {
                        // An inconclusive poll may finish after a later poll has already
                        // published a complete observation. Preserve that newer truth.
                        if (gauges.latestObservation != null
                                && gauges.latestObservation.checkedAt().isAfter(observedAt)) return;
                        gauges.readiness.set(Double.NaN);
                        gauges.qualityObservedAt.set(Double.NaN);
                    }
                }
            });
        }
        synchronized (providerQualityLock) {
            providerQualitySeries.forEach((key, value) -> {
                if (!key.providerId().equals(providerId)) return;
                ProviderQualityGroupKey group = new ProviderQualityGroupKey(key.modality(),
                        key.providerId(), key.providerVersion(), key.modelRevision());
                ProviderQualityRefresh refresh = providerQualityRefreshes.get(group);
                if (refresh == null || !refresh.checkedAt().isAfter(observedAt)) value.set(Double.NaN);
            });
        }
    }

    private void registerProviderGauges(ProviderProfileKey key, ProviderProfileGauges gauges) {
        var tags = io.micrometer.core.instrument.Tags.of(
                "service", safeService,
                "modality", key.modality().label,
                "provider_id", key.providerId(),
                "provider_version", key.providerVersion(),
                "model_profile", key.modelProfile(),
                "model_revision", key.modelRevision(),
                "contract_version", CONTRACT_VERSION);
        Gauge.builder("media.provider.profile.readiness", gauges.readiness, AtomicReference::get)
                .description("Latest provider profile readiness: 1 healthy, 0 degraded, -1 unavailable, NaN if conflicting")
                .tags(tags)
                .register(registry);
        Gauge.builder("media.provider.profile.checked_at_seconds", gauges.checkedAt, AtomicReference::get)
                .description("Unix timestamp of the latest provider profile health check")
                .tags(tags)
                .register(registry);
        Gauge.builder("media.provider.quality.observation_timestamp_seconds",
                        gauges.qualityObservedAt, AtomicReference::get)
                .description("Unix timestamp of the latest measured provider quality observation; NaN if absent")
                .tags(tags)
                .register(registry);
        Gauge.builder("media.provider.profile.observation_conflict", gauges.observationConflict, AtomicReference::get)
                .description("1 when equal-time provider profile observations conflict, 0 after an unambiguous check, NaN before the first check")
                .tags(tags)
                .register(registry);
    }

    private void recordRejectedObservation(String metricName) {
        try {
            registry.counter(metricName, "service", safeService,
                    "contract_version", CONTRACT_VERSION).increment();
        } catch (RuntimeException ignored) {
            // Rejection diagnostics are optional telemetry and must not alter the rejected
            // observation's result or escape into the provider operation being observed.
        }
    }

    /**
     * Replace the measured-quality series for one provider model revision with the
     * latest verified report rows. Series present in an earlier refresh but absent
     * now are set to NaN — stale evidence never leaves a phantom measured value.
     * Older refreshes and conflicting equal-time refreshes are rejected; a
     * conflict clears the group's measured values until a newer refresh. Exact
     * equal-time duplicates are idempotent. The registry keeps at most
     * {@value MAX_PROVIDER_PROFILES} provider model groups and
     * at most {@value MAX_PROVIDER_QUALITY_SERIES} quality series; label values are
     * restricted to the fixed locale/metric/scope vocabulary.
     *
     * @return false when the refresh is stale, exceeds bounded capacity, or the
     *         sample rows are ambiguous for one series
     */
    public boolean recordProviderQualitySeries(
            Modality modality, String providerId, String providerVersion,
            String modelRevision, Instant checkedAt,
            java.util.List<ProviderQualitySeriesSample> samples) {
        if (modality == null || providerId == null || providerVersion == null
                || modelRevision == null || checkedAt == null) {
            return false;
        }
        try {
            metricIdentity(providerId, "providerId");
            metricIdentity(providerVersion, "providerVersion");
            metricIdentity(modelRevision, "modelRevision");
        } catch (IllegalArgumentException invalidIdentity) {
            return false;
        }
        // Take one bounded defensive snapshot before validation and publication. Callers may
        // supply a mutable collection; iterating it once to validate and again to publish could
        // otherwise validate one set of labels and register another (or partially publish on
        // mutation). Stop after the first excess row so a rejected refresh cannot force an
        // unbounded copy before the per-model row limit is applied.
        java.util.List<ProviderQualitySeriesSample> rows;
        try {
            if (samples == null) {
                rows = java.util.List.of();
            } else {
                java.util.ArrayList<ProviderQualitySeriesSample> snapshot =
                        new java.util.ArrayList<>(MAX_QUALITY_SAMPLES_PER_MODEL);
                java.util.Iterator<ProviderQualitySeriesSample> iterator = samples.iterator();
                while (snapshot.size() <= MAX_QUALITY_SAMPLES_PER_MODEL && iterator.hasNext()) {
                    snapshot.add(iterator.next());
                }
                rows = snapshot;
            }
        } catch (RuntimeException unstableInput) {
            registry.counter("media.provider.quality.series.rejected",
                    "service", safeService, "contract_version", CONTRACT_VERSION).increment();
            return false;
        }
        if (rows.size() > MAX_QUALITY_SAMPLES_PER_MODEL) {
            registry.counter("media.provider.quality.series.rejected",
                    "service", safeService, "contract_version", CONTRACT_VERSION).increment();
            return false;
        }
        ProviderQualityGroupKey group = new ProviderQualityGroupKey(
                modality, providerId, providerVersion, modelRevision);
        synchronized (providerQualityLock) {
            ProviderQualityRefresh previous = providerQualityRefreshes.get(group);
            if (previous != null && checkedAt.isBefore(previous.checkedAt())) {
                registry.counter("media.provider.quality.series.rejected",
                        "service", safeService, "contract_version", CONTRACT_VERSION).increment();
                return false;
            }
            java.util.Map<ProviderQualityKey, ProviderQualitySeriesSample> desired = new java.util.HashMap<>();
            for (ProviderQualitySeriesSample sample : rows) {
                if (sample == null || sample.measuredAt().isAfter(checkedAt)
                        || desired.putIfAbsent(new ProviderQualityKey(modality, providerId,
                        providerVersion, modelRevision, sample.locale(), sample.metric(),
                        sample.scope()), sample) != null) {
                    registry.counter("media.provider.quality.series.rejected",
                            "service", safeService, "contract_version", CONTRACT_VERSION)
                            .increment();
                    return false;
                }
            }
            if (previous != null && checkedAt.equals(previous.checkedAt())) {
                if (!previous.conflicted() && previous.samples().equals(desired)) return true;
                for (var entry : providerQualitySeries.entrySet()) {
                    ProviderQualityKey key = entry.getKey();
                    if (key.modality() == modality && key.providerId().equals(providerId)
                            && key.providerVersion().equals(providerVersion)
                            && key.modelRevision().equals(modelRevision)) {
                        entry.getValue().set(Double.NaN);
                    }
                }
                providerQualityRefreshes.put(group,
                        new ProviderQualityRefresh(checkedAt, previous.samples(), true));
                registry.counter("media.provider.quality.series.rejected",
                        "service", safeService, "contract_version", CONTRACT_VERSION).increment();
                return false;
            }
            if (previous == null && providerQualityRefreshes.size() >= MAX_PROVIDER_PROFILES) {
                registry.counter("media.provider.quality.series.rejected",
                        "service", safeService, "contract_version", CONTRACT_VERSION).increment();
                return false;
            }
            long additional = desired.keySet().stream()
                    .filter(key -> !providerQualitySeries.containsKey(key)).count();
            if (providerQualitySeries.size() + additional > MAX_PROVIDER_QUALITY_SERIES) {
                registry.counter("media.provider.quality.series.rejected",
                        "service", safeService, "contract_version", CONTRACT_VERSION).increment();
                return false;
            }
            for (java.util.Map.Entry<ProviderQualityKey, AtomicReference<Double>> entry
                    : providerQualitySeries.entrySet()) {
                ProviderQualityKey key = entry.getKey();
                if (key.modality() == modality && key.providerId().equals(providerId)
                        && key.providerVersion().equals(providerVersion)
                        && key.modelRevision().equals(modelRevision) && !desired.containsKey(key)) {
                    entry.getValue().set(Double.NaN);
                }
            }
            for (ProviderQualitySeriesSample sample : rows) {
                ProviderQualityKey key = new ProviderQualityKey(modality, providerId,
                        providerVersion, modelRevision, sample.locale(), sample.metric(),
                        sample.scope());
                AtomicReference<Double> value = providerQualitySeries.computeIfAbsent(key,
                        this::registerQualityGauge);
                value.set(sample.value());
            }
            providerQualityRefreshes.put(group, new ProviderQualityRefresh(checkedAt, Map.copyOf(desired), false));
            return true;
        }
    }

    private AtomicReference<Double> registerQualityGauge(ProviderQualityKey key) {
        AtomicReference<Double> value = new AtomicReference<>(Double.NaN);
        Gauge.builder("media.provider.quality.measured_value", value, AtomicReference::get)
                .description("Latest measured provider quality value from a verified "
                        + "source-linked evaluation report; NaN if absent")
                .tags(io.micrometer.core.instrument.Tags.of(
                        "service", safeService,
                        "modality", key.modality().label,
                        "provider_id", key.providerId(),
                        "provider_version", key.providerVersion(),
                        "model_revision", key.modelRevision(),
                        "locale", key.locale(),
                        "metric", key.metric(),
                        "scope", key.scope(),
                        "contract_version", CONTRACT_VERSION))
                .register(registry);
        return value;
    }

    private static double epochSeconds(Instant instant) {
        return instant.getEpochSecond() + instant.getNano() / 1_000_000_000.0;
    }

    private static String metricIdentity(String value, String name) {
        if (value == null || value.length() > 128
                || !value.matches("[A-Za-z0-9][A-Za-z0-9._:+-]*")
                || looksLikeSecret(value)) {
            throw new IllegalArgumentException(name + " must be a bounded metric token");
        }
        return value;
    }

    /** Reject common credential-shaped identities before they can become metric labels. */
    private static boolean looksLikeSecret(String value) {
        String normalized = value.toLowerCase(java.util.Locale.ROOT);
        return normalized.contains("secret") || normalized.contains("password")
                || normalized.contains("credential") || normalized.contains("bearer")
                || normalized.contains("api-key") || normalized.contains("apikey")
                || normalized.contains("access-token") || normalized.contains("accesstoken")
                || normalized.startsWith("sk-") || normalized.startsWith("ghp_")
                || normalized.startsWith("gho_") || normalized.startsWith("ghu_")
                || normalized.startsWith("ghs_") || normalized.startsWith("ghr_")
                || normalized.startsWith("github_pat_") || normalized.startsWith("akia")
                // Temporary AWS credentials and common hosted-service tokens are valid
                // metric-token characters, so reject their recognizable prefixes explicitly.
                || normalized.startsWith("asia") || normalized.startsWith("ya29.")
                || normalized.startsWith("aiza")
                || normalized.startsWith("glpat-") || normalized.startsWith("xoxb-")
                || normalized.startsWith("xoxp-") || normalized.startsWith("xoxa-")
                || normalized.startsWith("xoxr-") || normalized.startsWith("xoxs-")
                || normalized.startsWith("xapp-")
                || looksLikeJwt(value);
    }

    /** JWTs are not provider identities and must not become metric labels. */
    private static boolean looksLikeJwt(String value) {
        return value.matches("eyJ[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+")
                || value.matches("[A-Za-z0-9_-]+\\.eyJ[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]+");
    }

    public void recordRequest() {
        try {
            requests.increment();
        } catch (RuntimeException ignored) {
            // Aggregate request instrumentation must not replace the request result it observes.
        }
    }

    public void setQueueDepth(long depth) {
        queueDepth.set(measuredCount(depth));
    }

    public void setUnknownBacklog(long count) {
        unknownBacklog.set(measuredCount(count));
    }

    public void setOverdueLeases(long count) {
        overdueLeases.set(measuredCount(count));
    }

    public void setOverdueOutboxClaims(long count) {
        overdueOutboxClaims.set(measuredCount(count));
    }

    public void setOutboxStoreQueriesSupported(boolean supported) {
        if (!supported) {
            outboxStoreQueriesSupported.set(0.0);
            overdueOutboxClaims.set(Double.NaN);
            return;
        }

        outboxStoreQueriesSupported.set(Double.isFinite(overdueOutboxClaims.get()) ? 1.0 : Double.NaN);
    }

    public void setAggregateStoreQueriesSupported(boolean supported) {
        if (!supported) {
            aggregateStoreQueriesSupported.set(0.0);
            queueDepth.set(Double.NaN);
            unknownBacklog.set(Double.NaN);
            overdueLeases.set(Double.NaN);
            return;
        }

        boolean hasCompleteMeasurements = Double.isFinite(queueDepth.get())
                && Double.isFinite(unknownBacklog.get())
                && Double.isFinite(overdueLeases.get());
        aggregateStoreQueriesSupported.set(hasCompleteMeasurements ? 1.0 : Double.NaN);
    }

    private static double measuredCount(long count) {
        return count < 0 ? Double.NaN : count;
    }
}
