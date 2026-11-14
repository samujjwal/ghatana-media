package com.ghatana.media.launcher;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;

import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

/**
 * Bounded, non-blocking admission control and low-cardinality metrics for the DEV_ONLY render,
 * creative-output and export lanes.
 *
 * <p>The global pool and the per-tenant bound are acquired with {@code tryAcquire} only: an exhausted
 * pool fails immediately with {@link CapacityExhaustedException} before any work, artifact or upload
 * exists, so the rejection has no side effect. Permits are released in a {@code finally} on every path.
 * Metric labels are limited to lane, format and a fixed outcome vocabulary; tenant, principal, project,
 * file and digest values are never labels.
 *
 * @doc.type class
 * @doc.purpose Bound DEV_ONLY render concurrency and expose outcome metrics
 * @doc.layer product
 * @doc.pattern Bulkhead
 */
final class MediaDevRenderAdmission {
    static final String LANE_RENDER = "render";
    static final String LANE_CREATIVE = "creative";
    static final String LANE_EXPORT = "export";
    static final String CAPACITY_CODE = "RENDER_CAPACITY_EXHAUSTED";
    static final String OUTCOME_CAPACITY = "capacity_exhausted";

    /** Typed, retryable refusal raised before any side effect. */
    static final class CapacityExhaustedException extends RuntimeException {
        private final String scope;
        CapacityExhaustedException(String scope) {
            super("DEV_ONLY render capacity is exhausted (" + scope + ")", null, false, false);
            this.scope = scope;
        }
        /** Either {@code global} or {@code tenant}. */
        String scope() { return scope; }
    }

    private final MeterRegistry registry;
    private final Semaphore global;
    private final int perTenantLimit;
    private final ConcurrentHashMap<String, Integer> tenantInFlight = new ConcurrentHashMap<>();
    private final Map<String, AtomicInteger> inFlight = new ConcurrentHashMap<>();

    MediaDevRenderAdmission(MeterRegistry registry, int globalLimit, int perTenantLimit) {
        this.registry = Objects.requireNonNull(registry, "registry");
        this.global = new Semaphore(globalLimit);
        this.perTenantLimit = perTenantLimit;
        for (String lane : new String[] {LANE_RENDER, LANE_CREATIVE}) {
            AtomicInteger value = new AtomicInteger();
            inFlight.put(lane, value);
            Gauge.builder("media.dev.output.in.flight", value, AtomicInteger::get)
                    .description("DEV_ONLY render/creative operations currently holding an admission permit")
                    .tag("lane", lane).register(registry);
        }
    }

    /** Runs {@code work} under a global and per-tenant permit; the format label must be a fixed token. */
    <T> T run(String lane, String format, String tenantId, Supplier<T> work) {
        if (!acquireTenant(tenantId)) {
            count(lane, format, OUTCOME_CAPACITY);
            throw new CapacityExhaustedException("tenant");
        }
        if (!global.tryAcquire()) {
            releaseTenant(tenantId);
            count(lane, format, OUTCOME_CAPACITY);
            throw new CapacityExhaustedException("global");
        }
        AtomicInteger gauge = inFlight.get(lane);
        gauge.incrementAndGet();
        Timer.Sample sample = Timer.start(registry);
        String outcome = "error";
        try {
            T result = work.get();
            outcome = result instanceof ReplayAware aware && aware.replayedResult() ? "replayed" : "success";
            return result;
        } catch (RuntimeException failure) {
            outcome = outcomeOf(failure);
            throw failure;
        } finally {
            sample.stop(Timer.builder("media.dev.output.duration")
                    .description("DEV_ONLY render/creative operation duration while holding a permit")
                    .tag("lane", lane).tag("format", format).tag("outcome", outcome).register(registry));
            gauge.decrementAndGet();
            global.release();
            releaseTenant(tenantId);
            count(lane, format, outcome);
        }
    }

    /** Records one outcome for a lane that is not permit-bounded (for example hosted export). */
    void record(String lane, String format, String outcome) {
        count(lane, format, outcome);
    }

    int availableGlobalPermits() { return global.availablePermits(); }

    int trackedTenants() { return tenantInFlight.size(); }

    private void count(String lane, String format, String outcome) {
        Counter.builder("media.dev.output.requests")
                .description("DEV_ONLY render/creative/export outcomes by lane, format and outcome")
                .tag("lane", lane).tag("format", format).tag("outcome", outcome).register(registry).increment();
    }

    private boolean acquireTenant(String tenantId) {
        if (perTenantLimit <= 0) return true;
        boolean[] admitted = {false};
        tenantInFlight.compute(tenantId, (key, current) -> {
            int value = current == null ? 0 : current;
            if (value >= perTenantLimit) return current;
            admitted[0] = true;
            return value + 1;
        });
        return admitted[0];
    }

    private void releaseTenant(String tenantId) {
        if (perTenantLimit <= 0) return;
        tenantInFlight.compute(tenantId, (key, current) -> current == null || current <= 1 ? null : current - 1);
    }

    /** Fixed outcome vocabulary; never derived from request content. */
    static String outcomeOf(Throwable failure) {
        if (failure instanceof MediaDevProjectRenderRuntime.RenderNotSupportedException
                || failure instanceof MediaDevCreativeOutputRuntime.CreativeUnsupportedException) return "not_supported";
        if (failure instanceof MediaDevProjectRenderRuntime.SourceVersionUnavailableException) return "source_unavailable";
        if (failure instanceof MediaDevProjectRenderRuntime.RenderCodecUnavailableException) return "codec_unavailable";
        if (failure instanceof MediaDevProjectRenderRuntime.RenderExecutionFailedException) return "execution_failed";
        if (failure instanceof MediaDevProjectRenderRuntime.RenderRegistrationFailedException
                || failure instanceof MediaDevCreativeOutputRuntime.CreativeRegistrationFailedException) {
            return "registration_failed";
        }
        if (failure instanceof MediaDevCreativeOutputRuntime.CreativeRequestReusedException) return "request_reused";
        if (failure instanceof SecurityException) return "denied";
        if (failure instanceof IllegalArgumentException) return "invalid_request";
        return failure.getClass().getSimpleName().toLowerCase(Locale.ROOT).contains("notfound") ? "not_found" : "error";
    }

    /** Implemented by results that can report an idempotent replay. */
    interface ReplayAware { boolean replayedResult(); }
}
