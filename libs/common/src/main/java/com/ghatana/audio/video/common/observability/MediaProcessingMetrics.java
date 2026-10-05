/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.common.observability;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.LongAdder;

/**
 * Business-level metrics for audio-video media processing operations.
 *
 * <p>Tracks started, succeeded, and failed call counts plus total latency per
 * named operation (e.g. {@code vision.detect}, {@code vision.analyze},
 * {@code multimodal.analyse}).  Exposes Prometheus-format text via
 * {@link #scrape()} for mounting on the service's {@code /metrics} endpoint.
 *
 * <p>This class is intentionally zero-dependency on a Micrometer or Prometheus
 * client library, keeping it consistent with the lightweight
 * {@link MetricsServerInterceptor} pattern in this module.
 *
 * <h2>Usage</h2>
 * <pre>{@code
 * MediaProcessingMetrics metrics = MediaProcessingMetrics.create();
 *
 * long start = System.currentTimeMillis();
 * metrics.recordStarted("vision.detect");
 * try {
 *     List<DetectedObject> results = detector.detectObjects(imageBytes, options);
 *     metrics.recordSucceeded("vision.detect", System.currentTimeMillis() - start);
 * } catch (Exception e) {
 *     metrics.recordFailed("vision.detect");
 *     throw e;
 * }
 * }</pre>
 *
 * <h2>Metric names (Prometheus text format)</h2>
 * <ul>
 *   <li>{@code media_processing_started_total{operation="…"}}</li>
 *   <li>{@code media_processing_succeeded_total{operation="…"}}</li>
 *   <li>{@code media_processing_failed_total{operation="…"}}</li>
 *   <li>{@code media_processing_latency_ms_total{operation="…"}}</li>
 *   <li>{@code media_processing_latency_ms_count{operation="…"}}</li>
 * </ul>
 *
 * @doc.type class
 * @doc.purpose Business metrics for media processing operations (vision, multimodal)
 * @doc.layer product
 * @doc.pattern Facade, Metrics
 */
public final class MediaProcessingMetrics {

    private static final Logger LOG = LoggerFactory.getLogger(MediaProcessingMetrics.class);

    private static final MediaProcessingMetrics NOOP = new MediaProcessingMetrics(false);

    private final boolean enabled;

    // Per-operation counters — operation name is the key
    private final ConcurrentHashMap<String, LongAdder> started    = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, LongAdder> succeeded  = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, LongAdder> failed     = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, AtomicLong> latencySum  = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, LongAdder> latencyCount = new ConcurrentHashMap<>();

    private MediaProcessingMetrics(boolean enabled) {
        this.enabled = enabled;
    }

    /**
     * Creates a live {@link MediaProcessingMetrics} instance that records all events.
     *
     * @return new live instance
     */
    public static MediaProcessingMetrics create() {
        return new MediaProcessingMetrics(true);
    }

    /**
     * Returns a shared no-op instance that discards all events.  Useful as a safe
     * default so callers never need null checks.
     *
     * @return shared no-op instance
     */
    public static MediaProcessingMetrics noop() {
        return NOOP;
    }

    // -------------------------------------------------------------------------
    // Recording methods — all null-safe and non-throwing
    // -------------------------------------------------------------------------

    /**
     * Records that a processing operation has started.
     *
     * @param operation operation name, e.g. {@code "vision.detect"}
     */
    public void recordStarted(String operation) {
        if (!enabled || operation == null) return;
        try {
            started.computeIfAbsent(operation, k -> new LongAdder()).increment();
        } catch (Exception e) {
            LOG.debug("MediaProcessingMetrics.recordStarted failed silently: {}", e.getMessage());
        }
    }

    /**
     * Records that a processing operation completed successfully.
     *
     * @param operation  operation name
     * @param latencyMs  wall-clock latency in milliseconds
     */
    public void recordSucceeded(String operation, long latencyMs) {
        if (!enabled || operation == null) return;
        try {
            succeeded.computeIfAbsent(operation, k -> new LongAdder()).increment();
            latencySum.computeIfAbsent(operation, k -> new AtomicLong(0)).addAndGet(latencyMs);
            latencyCount.computeIfAbsent(operation, k -> new LongAdder()).increment();
        } catch (Exception e) {
            LOG.debug("MediaProcessingMetrics.recordSucceeded failed silently: {}", e.getMessage());
        }
    }

    /**
     * Records that a processing operation failed.
     *
     * @param operation operation name
     */
    public void recordFailed(String operation) {
        if (!enabled || operation == null) return;
        try {
            failed.computeIfAbsent(operation, k -> new LongAdder()).increment();
        } catch (Exception e) {
            LOG.debug("MediaProcessingMetrics.recordFailed failed silently: {}", e.getMessage());
        }
    }

    // -------------------------------------------------------------------------
    // Prometheus scrape
    // -------------------------------------------------------------------------

    /**
     * Returns the current metric state in Prometheus text exposition format.
     * All known operations are included in the output.
     *
     * @return Prometheus text-format string
     */
    public String scrape() {
        StringBuilder sb = new StringBuilder();
        emitCounter(sb, "media_processing_started_total",
                "Total media processing operations started", started);
        emitCounter(sb, "media_processing_succeeded_total",
                "Total media processing operations succeeded", succeeded);
        emitCounter(sb, "media_processing_failed_total",
                "Total media processing operations failed", failed);
        emitLatency(sb, "media_processing_latency_ms",
                "Total latency of media processing operations in milliseconds");
        return sb.toString();
    }

    // -------------------------------------------------------------------------
    // Snapshot accessors for tests
    // -------------------------------------------------------------------------

    /** Returns the started count for the given operation, or 0 if never recorded. */
    public long startedCount(String operation) {
        LongAdder a = started.get(operation);
        return a == null ? 0L : a.sum();
    }

    /** Returns the succeeded count for the given operation, or 0 if never recorded. */
    public long succeededCount(String operation) {
        LongAdder a = succeeded.get(operation);
        return a == null ? 0L : a.sum();
    }

    /** Returns the failed count for the given operation, or 0 if never recorded. */
    public long failedCount(String operation) {
        LongAdder a = failed.get(operation);
        return a == null ? 0L : a.sum();
    }

    /** Returns the accumulated latency (ms) for the given operation. */
    public long latencyMsTotal(String operation) {
        AtomicLong a = latencySum.get(operation);
        return a == null ? 0L : a.get();
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private static void emitCounter(StringBuilder sb, String name, String help,
                                    ConcurrentHashMap<String, LongAdder> map) {
        sb.append("# HELP ").append(name).append(' ').append(help).append('\n');
        sb.append("# TYPE ").append(name).append(" counter\n");
        map.forEach((op, adder) ->
            sb.append(name)
              .append("{operation=\"").append(op).append("\"} ")
              .append(adder.sum()).append('\n')
        );
    }

    private void emitLatency(StringBuilder sb, String name, String help) {
        sb.append("# HELP ").append(name).append("_total ").append(help).append('\n');
        sb.append("# TYPE ").append(name).append("_total gauge\n");
        latencySum.forEach((op, sum) ->
            sb.append(name)
              .append("_total{operation=\"").append(op).append("\"} ")
              .append(sum.get()).append('\n')
        );
        sb.append("# HELP ").append(name).append("_count Number of completed operations\n");
        sb.append("# TYPE ").append(name).append("_count counter\n");
        latencyCount.forEach((op, count) ->
            sb.append(name)
              .append("_count{operation=\"").append(op).append("\"} ")
              .append(count.sum()).append('\n')
        );
    }
}
