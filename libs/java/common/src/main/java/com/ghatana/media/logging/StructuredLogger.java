/**
 * @doc.type class
 * @doc.purpose Structured logging for audio-video operations
 * @doc.layer platform
 * @doc.pattern Logging, Observability
 */
package com.ghatana.media.logging;

import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Structured logging utility for audio-video operations.
 *
 * <p>Addresses AV-010 and DC-010: Provides standardized logging patterns
 * with structured context for observability and debugging.</p>
 *
 * @since 2026-03-27
 */
public final class StructuredLogger {

    private final Logger logger;
    private final Map<String, String> context = new ConcurrentHashMap<>();

    private StructuredLogger(String name) {
        this.logger = Logger.getLogger(name);
    }

    /**
     * Creates a structured logger.
     */
    public static StructuredLogger getLogger(String name) {
        return new StructuredLogger(name);
    }

    /**
     * Creates a structured logger for a class.
     */
    public static StructuredLogger getLogger(Class<?> clazz) {
        return new StructuredLogger(clazz.getName());
    }

    /**
     * Adds a context field.
     */
    public StructuredLogger withContext(String key, String value) {
        context.put(key, value);
        return this;
    }

    /**
     * Adds a context field if condition is true.
     */
    public StructuredLogger withContext(String key, String value, boolean condition) {
        if (condition) {
            context.put(key, value);
        }
        return this;
    }

    /**
     * Logs an operation start.
     */
    public void operationStart(String operation, Object... params) {
        log(Level.INFO, "OPERATION_START", operation,
            () -> formatParams(params));
    }

    /**
     * Logs an operation completion.
     */
    public void operationComplete(String operation, long durationMs, Object result) {
        withContext("duration_ms", String.valueOf(durationMs));
        log(Level.INFO, "OPERATION_COMPLETE", operation,
            () -> result != null ? "result=" + result : "result=null");
    }

    /**
     * Logs an operation failure.
     */
    public void operationFailed(String operation, Throwable error, long durationMs) {
        withContext("duration_ms", String.valueOf(durationMs));
        withContext("error_type", error.getClass().getSimpleName());
        log(Level.WARNING, "OPERATION_FAILED", operation,
            () -> "error=" + error.getMessage());
    }

    /**
     * Logs a retry attempt.
     */
    public void retryAttempt(String operation, int attempt, int maxAttempts, long backoffMs) {
        withContext("attempt", String.valueOf(attempt));
        withContext("max_attempts", String.valueOf(maxAttempts));
        withContext("backoff_ms", String.valueOf(backoffMs));
        log(Level.INFO, "RETRY_ATTEMPT", operation, null);
    }

    /**
     * Logs circuit breaker state change.
     */
    public void circuitBreakerState(String circuitName, String fromState, String toState) {
        withContext("circuit", circuitName);
        withContext("from_state", fromState);
        withContext("to_state", toState);
        log(Level.INFO, "CIRCUIT_BREAKER_STATE", "state_change", null);
    }

    /**
     * Logs resource pool metrics.
     */
    public void poolMetrics(String poolName, int available, int inUse, int total) {
        withContext("pool", poolName);
        withContext("available", String.valueOf(available));
        withContext("in_use", String.valueOf(inUse));
        withContext("total", String.valueOf(total));
        withContext("utilization", String.format("%.2f", (double)inUse/total));
        log(Level.FINE, "POOL_METRICS", poolName, null);
    }

    /**
     * Logs sync quality metrics.
     */
    public void syncQuality(String syncId, String quality, double avgDrift, long maxDrift) {
        withContext("sync_id", syncId);
        withContext("quality", quality);
        withContext("avg_drift_ms", String.format("%.2f", avgDrift));
        withContext("max_drift_ms", String.valueOf(maxDrift));
        log(Level.INFO, "SYNC_QUALITY", "sync_metrics", null);
    }

    /**
     * Logs at INFO level.
     */
    public void info(String event, String message) {
        log(Level.INFO, event, message, null);
    }

    /**
     * Logs at WARNING level.
     */
    public void warning(String event, String message, Throwable error) {
        log(Level.WARNING, event, message, () -> error != null ? error.getMessage() : null);
    }

    /**
     * Logs at SEVERE level.
     */
    public void error(String event, String message, Throwable error) {
        log(Level.SEVERE, event, message, () -> error != null ? error.getMessage() : null);
    }

    private void log(Level level, String event, String message, Supplier<String> detailSupplier) {
        StringBuilder sb = new StringBuilder();
        sb.append("[").append(Instant.now()).append("]");
        sb.append("[").append(event).append("]");
        sb.append(" ").append(message);

        // Add context
        if (!context.isEmpty()) {
            sb.append(" {");
            boolean first = true;
            for (Map.Entry<String, String> entry : context.entrySet()) {
                if (!first) sb.append(", ");
                sb.append(entry.getKey()).append("=").append(entry.getValue());
                first = false;
            }
            sb.append("}");
        }

        // Add detail if provided
        if (detailSupplier != null) {
            String detail = detailSupplier.get();
            if (detail != null) {
                sb.append(" - ").append(detail);
            }
        }

        String logMessage = sb.toString();
        if (level.intValue() >= Level.WARNING.intValue()) {
            logger.log(level, logMessage);
        } else {
            logger.log(level, logMessage);
        }

        // Clear context for next log
        context.clear();
    }

    private String formatParams(Object... params) {
        if (params == null || params.length == 0) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < params.length; i += 2) {
            if (i > 0) sb.append(", ");
            String key = params[i].toString();
            String value = i + 1 < params.length ? params[i + 1].toString() : "null";
            sb.append(key).append("=").append(value);
        }
        return sb.toString();
    }
}
