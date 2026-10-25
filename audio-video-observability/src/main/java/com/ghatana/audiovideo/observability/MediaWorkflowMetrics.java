package com.ghatana.audiovideo.observability;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import java.util.EnumMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

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

    private final Map<Stage, Timer> stageTimers = new EnumMap<>(Stage.class);
    private final Map<Event, Counter> eventCounters = new EnumMap<>(Event.class);
    private final Counter requests;
    private final AtomicLong queueDepth = new AtomicLong();
    private final AtomicLong unknownBacklog = new AtomicLong();
    private final AtomicLong overdueLeases = new AtomicLong();
    private final AtomicLong aggregateStoreQueriesSupported = new AtomicLong();

    public MediaWorkflowMetrics(MeterRegistry registry, String service) {
        String safeService = SERVICES.contains(service) ? service : "unknown";
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
        Gauge.builder("media.workflow.queue.depth", queueDepth, AtomicLong::doubleValue)
                .description("Current aggregate Media work queue depth")
                .tag("service", safeService)
                .tag("contract_version", CONTRACT_VERSION)
                .register(registry);
        Gauge.builder("media.workflow.unknown.backlog", unknownBacklog, AtomicLong::doubleValue)
                .description("Current aggregate Media jobs with unknown finality")
                .tag("service", safeService)
                .tag("contract_version", CONTRACT_VERSION)
                .register(registry);
        Gauge.builder("media.workflow.lease.overdue", overdueLeases, AtomicLong::doubleValue)
                .description("Current aggregate count of expired Media job leases")
                .tag("service", safeService)
                .tag("contract_version", CONTRACT_VERSION)
                .register(registry);
        Gauge.builder("media.workflow.aggregate_store_queries_supported", aggregateStoreQueriesSupported,
                        AtomicLong::doubleValue)
                .description("Whether the configured job store supplied all aggregate workflow queries")
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

    public void record(Event event) {
        if (event != null) eventCounters.get(event).increment();
    }

    public void recordRequest() {
        requests.increment();
    }

    public void setQueueDepth(long depth) {
        queueDepth.set(Math.max(0, depth));
    }

    public void setUnknownBacklog(long count) {
        unknownBacklog.set(Math.max(0, count));
    }

    public void setOverdueLeases(long count) {
        overdueLeases.set(Math.max(0, count));
    }

    public void setAggregateStoreQueriesSupported(boolean supported) {
        aggregateStoreQueriesSupported.set(supported ? 1 : 0);
    }
}
