package com.ghatana.audiovideo.observability;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import java.util.EnumMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

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

    private final Map<Stage, Timer> stageTimers = new EnumMap<>(Stage.class);
    private final MeterRegistry registry;
    private final ConcurrentMap<ModalityMetricKey, Timer> modalityTimers = new ConcurrentHashMap<>();
    private final Map<Event, Counter> eventCounters = new EnumMap<>(Event.class);
    private final String safeService;
    private final Counter requests;
    private final AtomicReference<Double> queueDepth = new AtomicReference<>(Double.NaN);
    private final AtomicReference<Double> unknownBacklog = new AtomicReference<>(Double.NaN);
    private final AtomicReference<Double> overdueLeases = new AtomicReference<>(Double.NaN);
    private final AtomicReference<Double> aggregateStoreQueriesSupported = new AtomicReference<>(Double.NaN);
    private final AtomicReference<Double> overdueOutboxClaims = new AtomicReference<>(Double.NaN);
    private final AtomicReference<Double> outboxStoreQueriesSupported = new AtomicReference<>(Double.NaN);

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
    }

    public Timer.Sample startTimer() {
        return Timer.start();
    }

    public void stopTimer(Timer.Sample sample, Stage stage) {
        if (sample == null || stage == null) return;
        sample.stop(stageTimers.get(stage));
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
        ModalityMetricKey key = new ModalityMetricKey(sample.modality, sample.boundary, outcome);
        Timer timer = modalityTimers.computeIfAbsent(key, this::newModalityTimer);
        sample.sample.stop(timer);
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
        if (event != null) eventCounters.get(event).increment();
    }

    public void recordRequest() {
        requests.increment();
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
