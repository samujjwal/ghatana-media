package com.ghatana.audiovideo.observability;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;

import java.time.Duration;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.function.DoubleSupplier;
import java.util.regex.Pattern;

/**
 * Bounded-cardinality per-lane request outcomes, latency histograms and resource budgets for the Media launcher
 * (journey {@code media.dev.service-observability}).
 *
 * <p>Truthfulness rules:
 * <ul>
 *   <li>A lane is a fixed vocabulary derived from the route <em>template</em> (the first path segment after the API
 *       prefix), never from a request value. Anything not on the allow-list is {@code other}.</li>
 *   <li>The outcome is exactly one of {@code completed}, {@code failed}, {@code unknown} or {@code refused}. A refusal
 *       (denied, invalid, over capacity, conflict) is never counted as a failure of the service and a failure is never
 *       counted as completed. {@code unknown} is an outcome the service cannot vouch for.</li>
 *   <li>The {@code code} label is a server-defined error code ({@code OK} on success) that must look like an upper-case
 *       token and is capped at {@value #MAX_CODES} distinct values; later codes fold into {@code OTHER}. No tenant,
 *       principal, artifact, request id, path or file name can reach a label.</li>
 *   <li>A budget or disk probe that throws exports NaN (unknown), never a made-up number.</li>
 * </ul>
 */
public final class MediaLaneMetrics {
    public static final String CONTRACT_VERSION = "v1";
    static final int MAX_CODES = 48;
    private static final Pattern CODE = Pattern.compile("^[A-Z][A-Z0-9_]{2,47}$");
    private static final Duration[] BUCKETS = {
            Duration.ofMillis(5), Duration.ofMillis(10), Duration.ofMillis(25), Duration.ofMillis(50),
            Duration.ofMillis(100), Duration.ofMillis(250), Duration.ofMillis(500), Duration.ofSeconds(1),
            Duration.ofMillis(2_500), Duration.ofSeconds(5), Duration.ofSeconds(10), Duration.ofSeconds(30),
            Duration.ofSeconds(60), Duration.ofSeconds(120)};
    private static final Set<String> DEV_SEGMENTS = Set.of(
            "animations", "artifacts", "artifact-upload-policy", "audio", "captions", "composite-renders", "context",
            "creative-outputs", "dubs", "erasure-plans", "erasures", "exports", "grounded-answers", "intakes",
            "interactive-demos", "legal-holds", "live-sessions", "masters", "projects", "providers", "quality",
            "reference-scenes", "region-edits", "request-outcomes", "review-lineages", "reviews", "rights", "rigs",
            "simulations", "spatial", "speech", "storyboards", "translations", "video", "vision");
    private static final Set<String> API_SEGMENTS = Set.of(
            "artifacts", "caption-versions", "consents", "jobs", "providers", "streams");

    /** What a request ended as. */
    public enum Outcome { COMPLETED, FAILED, UNKNOWN, REFUSED }

    /** Fixed resource budgets (a bounded vocabulary, never a tenant or session value). */
    public enum Budget {
        RENDER_CONCURRENCY("render_concurrency"), JOB_CONCURRENCY("job_concurrency"),
        LIVE_SESSIONS("live_sessions"), LIVE_BUFFER_BYTES("live_buffer_bytes");

        private final String label;
        Budget(String label) { this.label = label; }
    }

    /** Fixed scratch/spool volumes whose free space is budgeted. */
    public enum Volume {
        RENDER_SCRATCH("render_scratch"), LIVE_SPOOL("live_spool");

        private final String label;
        Volume(String label) { this.label = label; }
    }

    private final MeterRegistry registry;
    private final String service;
    private final ConcurrentMap<String, Boolean> seenCodes = new ConcurrentHashMap<>();
    private final ConcurrentMap<String, Boolean> registered = new ConcurrentHashMap<>();

    public MediaLaneMetrics(MeterRegistry registry, String service) {
        this.registry = registry;
        this.service = service == null ? "unknown" : service;
    }

    /** The lane for a raw request path, from the allow-list only. */
    public static String lane(String rawPath) {
        if (rawPath == null) return "other";
        String segment;
        String prefix;
        Set<String> allowed;
        if (rawPath.startsWith("/dev/v1/")) {
            prefix = "dev_"; allowed = DEV_SEGMENTS; segment = firstSegment(rawPath.substring("/dev/v1/".length()));
        } else if (rawPath.startsWith("/api/v1/")) {
            prefix = "api_"; allowed = API_SEGMENTS; segment = firstSegment(rawPath.substring("/api/v1/".length()));
        } else {
            return "other";
        }
        return allowed.contains(segment) ? prefix + segment.replace('-', '_') : "other";
    }

    private static String firstSegment(String rest) {
        int slash = rest.indexOf('/');
        int query = rest.indexOf('?');
        int end = rest.length();
        if (slash >= 0) end = Math.min(end, slash);
        if (query >= 0) end = Math.min(end, query);
        return rest.substring(0, end);
    }

    /** Typed outcome from the HTTP status and the server-defined error code. */
    public static Outcome outcome(int status, String code) {
        if (status >= 200 && status < 400) return Outcome.COMPLETED;
        String upper = code == null ? "" : code.toUpperCase(Locale.ROOT);
        if (upper.contains("UNKNOWN")) return Outcome.UNKNOWN;
        if (status >= 400 && status < 500) return Outcome.REFUSED;
        if (upper.contains("CAPACITY") || upper.contains("BACKPRESSURE") || upper.contains("BUSY")) return Outcome.REFUSED;
        return Outcome.FAILED; // 5xx, or no response at all (status < 0)
    }

    /** Record one finished request. Never throws: instrumentation must not replace the result it observes. */
    public void record(String lane, int status, String errorCode, long elapsedNanos) {
        try {
            Outcome outcome = outcome(status, errorCode);
            String code = outcome == Outcome.COMPLETED ? "OK" : boundedCode(status, errorCode);
            Counter.builder("media.lane.requests")
                    .description("Requests by fixed lane, typed outcome and server error code")
                    .tag("lane", lane).tag("outcome", outcome.name().toLowerCase(Locale.ROOT)).tag("code", code)
                    .tag("service", service).tag("contract_version", CONTRACT_VERSION).register(registry).increment();
            Timer.builder("media.lane.request.duration")
                    .description("Request duration by fixed lane (all outcomes)")
                    .serviceLevelObjectives(BUCKETS)
                    .tag("lane", lane).tag("service", service).tag("contract_version", CONTRACT_VERSION)
                    .register(registry).record(Math.max(0, elapsedNanos), java.util.concurrent.TimeUnit.NANOSECONDS);
        } catch (RuntimeException ignored) {
            // observational only
        }
    }

    private String boundedCode(int status, String errorCode) {
        String code = errorCode;
        if (code == null || !CODE.matcher(code).matches()) {
            code = status < 0 ? "NO_RESPONSE" : "HTTP_" + (status / 100) + "XX";
        }
        if (seenCodes.containsKey(code)) return code;
        if (seenCodes.size() >= MAX_CODES) return "OTHER";
        seenCodes.put(code, Boolean.TRUE);
        return code;
    }

    /** Export {@code limit}, {@code in_use} and {@code available} for one budget; once per budget. */
    public void registerBudget(Budget budget, DoubleSupplier limit, DoubleSupplier available) {
        if (registered.putIfAbsent("b:" + budget.label, Boolean.TRUE) != null) return;
        gauge("media.budget.limit", "Configured capacity of the budget", "resource", budget.label, limit);
        gauge("media.budget.available", "Capacity currently free in the budget; NaN when it cannot be read",
                "resource", budget.label, available);
        gauge("media.budget.in_use", "Capacity currently held; NaN when it cannot be read", "resource", budget.label,
                () -> limit.getAsDouble() - available.getAsDouble());
    }

    /** Export free bytes and the bytes the lane needs free on a scratch or spool volume; once per volume. */
    public void registerDisk(Volume volume, DoubleSupplier freeBytes, DoubleSupplier reserveBytes) {
        if (registered.putIfAbsent("v:" + volume.label, Boolean.TRUE) != null) return;
        gauge("media.disk.free.bytes", "Usable bytes on the volume now; NaN when it cannot be read",
                "volume", volume.label, freeBytes);
        gauge("media.disk.reserve.bytes", "Bytes that must stay free for the lane to accept work",
                "volume", volume.label, reserveBytes);
    }

    private void gauge(String name, String description, String tagName, String tagValue, DoubleSupplier supplier) {
        Gauge.builder(name, () -> {
                    try {
                        double value = supplier.getAsDouble();
                        return Double.isFinite(value) ? value : Double.NaN;
                    } catch (RuntimeException unreadable) {
                        return Double.NaN;
                    }
                })
                .description(description).tag(tagName, tagValue).tag("service", service)
                .tag("contract_version", CONTRACT_VERSION).register(registry);
    }
}
