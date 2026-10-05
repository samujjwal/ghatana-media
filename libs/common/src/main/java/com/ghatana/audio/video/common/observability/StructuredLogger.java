package com.ghatana.audio.video.common.observability;

import org.slf4j.Logger;
import org.slf4j.MDC;

import java.util.UUID;
import java.util.function.Supplier;

/**
 * Structured logging utility for audio-video gRPC services.
 *
 * <p>Standardises the log format across all four audio-video services by:
 * <ul>
 *   <li>Generating and propagating correlation IDs per request.</li>
 *   <li>Emitting structured "event" log lines with consistent keys.</li>
 *   <li>Automatically clearing MDC context after each request to prevent leaks.</li>
 * </ul>
 *
 * <h3>MDC keys</h3>
 * <ul>
 *   <li>{@code correlationId} — per-request UUID for log correlation</li>
 *   <li>{@code service} — service name (e.g., {@code "stt-service"})</li>
 *   <li>{@code operation} — gRPC method name (e.g., {@code "transcribe"})</li>
 * </ul>
 *
 * <h3>Log events</h3>
 * <ul>
 *   <li>{@code STARTED} — operation began</li>
 *   <li>{@code SUCCEEDED} — operation completed successfully (includes latencyMs)</li>
 *   <li>{@code FAILED} — operation failed (includes error category and message)</li>
 * </ul>
 *
 * <h3>Usage</h3>
 * <pre>{@code
 * String cid = StructuredLogger.newCorrelationId();
 * StructuredLogger.withContext(cid, "stt-service", "transcribe", () -> {
 *     StructuredLogger.logStarted(LOG, "transcribe");
 *     long start = System.currentTimeMillis();
 *     try {
 *         Result result = doWork();
 *         StructuredLogger.logSucceeded(LOG, "transcribe", System.currentTimeMillis() - start);
 *     } catch (Exception e) {
 *         StructuredLogger.logFailed(LOG, "transcribe", e);
 *         throw e;
 *     }
 * });
 * }</pre>
 *
 * @doc.type class
 * @doc.purpose Structured logging utility — consistent log events with MDC correlation for audio-video services
 * @doc.layer product
 * @doc.pattern Utility
 */
public final class StructuredLogger {

    /** MDC key for per-request correlation ID. */
    public static final String MDC_CORRELATION_ID = "correlationId";

    /** MDC key for the service name. */
    public static final String MDC_SERVICE = "service";

    /** MDC key for the gRPC operation name. */
    public static final String MDC_OPERATION = "operation";

    private StructuredLogger() {}

    /**
     * Generates a new short correlation ID (first 8 chars of a UUID).
     *
     * @return short correlation ID string
     */
    public static String newCorrelationId() {
        return UUID.randomUUID().toString().substring(0, 8);
    }

    /**
     * Runs the given block with MDC context set, and clears it afterwards.
     *
     * @param correlationId per-request ID for log correlation
     * @param service       service name
     * @param operation     gRPC method name
     * @param block         work to execute within the MDC context
     */
    public static void withContext(
            String correlationId, String service, String operation, Runnable block) {
        MDC.put(MDC_CORRELATION_ID, correlationId);
        MDC.put(MDC_SERVICE, service);
        MDC.put(MDC_OPERATION, operation);
        try {
            block.run();
        } finally {
            MDC.remove(MDC_CORRELATION_ID);
            MDC.remove(MDC_SERVICE);
            MDC.remove(MDC_OPERATION);
        }
    }

    /**
     * Runs the given supplier within MDC context and returns its result.
     *
     * @param correlationId per-request ID for log correlation
     * @param service       service name
     * @param operation     gRPC method name
     * @param block         work to execute; its return value is propagated
     * @param <T>           result type
     * @return the value returned by {@code block}
     */
    public static <T> T withContext(
            String correlationId, String service, String operation, Supplier<T> block) {
        MDC.put(MDC_CORRELATION_ID, correlationId);
        MDC.put(MDC_SERVICE, service);
        MDC.put(MDC_OPERATION, operation);
        try {
            return block.get();
        } finally {
            MDC.remove(MDC_CORRELATION_ID);
            MDC.remove(MDC_SERVICE);
            MDC.remove(MDC_OPERATION);
        }
    }

    /**
     * Emits an INFO-level "STARTED" event.
     *
     * @param log       the caller's logger
     * @param operation operation name
     */
    public static void logStarted(Logger log, String operation) {
        log.info("event=STARTED operation={}", operation);
    }

    /**
     * Emits an INFO-level "SUCCEEDED" event with latency.
     *
     * @param log       the caller's logger
     * @param operation operation name
     * @param latencyMs wall-clock latency in milliseconds
     */
    public static void logSucceeded(Logger log, String operation, long latencyMs) {
        log.info("event=SUCCEEDED operation={} latencyMs={}", operation, latencyMs);
    }

    /**
     * Emits a WARN or ERROR-level "FAILED" event.
     *
     * <p>Retryable errors are logged at WARN level; non-retryable errors at ERROR level.
     *
     * @param log       the caller's logger
     * @param operation operation name
     * @param error     the exception that caused the failure
     */
    public static void logFailed(Logger log, String operation, Throwable error) {
        boolean retryable = isRetryable(error);
        String msg = error == null ? "unknown" : error.getMessage();
        if (retryable) {
            log.warn("event=FAILED operation={} retryable=true error={}", operation, msg, error);
        } else {
            log.error("event=FAILED operation={} retryable=false error={}", operation, msg, error);
        }
    }

    /**
     * Emits a DEBUG-level validation failure event.
     *
     * @param log       the caller's logger
     * @param operation operation name
     * @param reason    human-readable validation failure reason
     */
    public static void logInvalid(Logger log, String operation, String reason) {
        log.debug("event=INVALID_INPUT operation={} reason={}", operation, reason);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private static boolean isRetryable(Throwable error) {
        if (error instanceof com.ghatana.media.common.ProcessingError pe) {
            return pe.isRetryable();
        }
        return false;
    }
}
