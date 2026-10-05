/**
 * @doc.type class
 * @doc.purpose Streaming retry handler with exponential backoff for audio-video operations
 * @doc.layer platform
 * @doc.pattern Resilience, Retry, Decorator
 */
package com.ghatana.media.resilience;

import com.ghatana.media.config.TimeoutConfig;

import java.time.Duration;
import java.util.Locale;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.Supplier;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Streaming retry handler with configurable backoff strategies.
 *
 * <p>Addresses AV-007: Provides consistent retry logic for streaming operations
 * with exponential backoff, jitter, and circuit breaker integration.</p>
 *
 * <p>Features:
 * <ul>
 *   <li>Exponential backoff with configurable multiplier</li>
 *   <li>Jitter to prevent thundering herd</li>
 *   <li>Per-exception-type retry policies</li>
 *   <li>Timeout-aware retry limits</li>
 *   <li>Retry context propagation</li>
 * </ul></p>
 *
 * @since 2026-03-27
 * @see CircuitBreaker
 * @see TimeoutConfig
 */
public class StreamingRetryHandler {

    private static final Logger LOG = Logger.getLogger(StreamingRetryHandler.class.getName());

    private final int maxRetries;
    private final Duration initialDelay;
    private final Duration maxDelay;
    private final double backoffMultiplier;
    private final boolean addJitter;
    private final TimeoutConfig timeoutConfig;

    private StreamingRetryHandler(Builder builder) {
        this.maxRetries = builder.maxRetries;
        this.initialDelay = builder.initialDelay;
        this.maxDelay = builder.maxDelay;
        this.backoffMultiplier = builder.backoffMultiplier;
        this.addJitter = builder.addJitter;
        this.timeoutConfig = builder.timeoutConfig;
    }

    /**
     * Creates a builder for retry handler.
     */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Creates a retry handler with sensible defaults for streaming.
     */
    public static StreamingRetryHandler defaults() {
        return builder().build();
    }

    /**
     * Creates an aggressive retry handler for low-latency scenarios.
     */
    public static StreamingRetryHandler aggressive() {
        return builder()
            .maxRetries(5)
            .initialDelay(Duration.ofMillis(100))
            .maxDelay(Duration.ofSeconds(5))
            .backoffMultiplier(1.5)
            .addJitter(true)
            .build();
    }

    /**
     * Creates a conservative retry handler for high-reliability scenarios.
     */
    public static StreamingRetryHandler conservative() {
        return builder()
            .maxRetries(10)
            .initialDelay(Duration.ofMillis(500))
            .maxDelay(Duration.ofSeconds(30))
            .backoffMultiplier(2.0)
            .addJitter(true)
            .build();
    }

    /**
     * Executes an operation with retry logic.
     *
     * @param operation the operation to execute
     * @param context context for logging
     * @param <T> return type
     * @return operation result
     * @throws StreamingRetryExhaustedException if all retries exhausted
     */
    public <T> T executeWithRetry(Supplier<T> operation, String context) {
        return executeWithRetry(operation, context, this::shouldRetry);
    }

    /**
     * Executes an operation with custom retry predicate.
     *
     * @param operation the operation to execute
     * @param context context for logging
     * @param shouldRetry predicate to determine if exception is retryable
     * @param <T> return type
     * @return operation result
     * @throws StreamingRetryExhaustedException if all retries exhausted
     */
    public <T> T executeWithRetry(Supplier<T> operation, String context,
                                   java.util.function.Predicate<Throwable> shouldRetry) {
        int attempt = 0;
        Throwable lastException = null;
        long startTime = System.currentTimeMillis();
        long timeoutMs = timeoutConfig != null ? timeoutConfig.streamingTimeout().toMillis() : Long.MAX_VALUE;

        while (attempt <= maxRetries) {
            // Check if we've exceeded total timeout
            if (System.currentTimeMillis() - startTime > timeoutMs) {
                throw new StreamingRetryExhaustedException(
                    "Retry timeout exceeded for: " + context, lastException, attempt);
            }

            try {
                T result = operation.get();
                if (attempt > 0) {
                    LOG.info("Operation succeeded after " + attempt + " retries: " + context);
                }
                return result;
            } catch (Exception e) {
                lastException = e;

                if (attempt >= maxRetries || !shouldRetry.test(e)) {
                    throw new StreamingRetryExhaustedException(
                        "Retries exhausted for: " + context, e, attempt + 1);
                }

                Duration delay = calculateDelay(attempt);
                LOG.log(Level.WARNING,
                    "Attempt " + (attempt + 1) + "/" + (maxRetries + 1) +
                    " failed for " + context + ", retrying in " + delay.toMillis() + "ms", e);

                try {
                    Thread.sleep(delay.toMillis());
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    throw new StreamingRetryExhaustedException(
                        "Retry interrupted for: " + context, e, attempt + 1);
                }

                attempt++;
            }
        }

        // Should never reach here
        throw new StreamingRetryExhaustedException(
            "Unexpected retry exhaustion for: " + context, lastException, attempt);
    }

    /**
     * Executes an async operation with retry logic.
     * Returns immediately with fallback if retries exhausted.
     *
     * @param operation the operation to execute
     * @param fallback fallback value on failure
     * @param context context for logging
     * @param <T> return type
     * @return operation result or fallback
     */
    public <T> T executeWithFallback(Supplier<T> operation, T fallback, String context) {
        try {
            return executeWithRetry(operation, context);
        } catch (StreamingRetryExhaustedException e) {
            LOG.log(Level.WARNING, "Using fallback after retries exhausted: " + context, e);
            return fallback;
        }
    }

    /**
     * Calculates delay for given attempt using exponential backoff.
     *
     * @param attempt attempt number (0-based)
     * @return delay duration
     */
    private Duration calculateDelay(int attempt) {
        long delayMs = (long) (initialDelay.toMillis() * Math.pow(backoffMultiplier, attempt));
        delayMs = Math.min(delayMs, maxDelay.toMillis());

        if (addJitter) {
            // Add up to 20% jitter
            long jitter = delayMs > 4 ? ThreadLocalRandom.current().nextLong(0, delayMs / 5) : 0;
            delayMs += jitter;
        }

        return Duration.ofMillis(delayMs);
    }

    /**
     * Default retry predicate - retries on retryable exceptions.
     */
    private boolean shouldRetry(Throwable t) {
        // Retry on IO and timeout exceptions
        if (t instanceof java.io.IOException ||
            t instanceof java.net.SocketTimeoutException ||
            t instanceof java.util.concurrent.TimeoutException) {
            return true;
        }

        // Retry on transient errors
        String msg = t.getMessage();
        if (msg != null) {
            String lowerMsg = msg.toLowerCase(Locale.ROOT);
            if (lowerMsg.contains("temporarily unavailable") ||
                lowerMsg.contains("try again") ||
                lowerMsg.contains("rate limit") ||
                lowerMsg.contains("too many requests")) {
                return true;
            }
        }

        // Check cause
        if (t.getCause() != null && !t.getCause().equals(t)) {
            return shouldRetry(t.getCause());
        }

        return false;
    }

    // Getters
    public int getMaxRetries() { return maxRetries; }
    public Duration getInitialDelay() { return initialDelay; }
    public Duration getMaxDelay() { return maxDelay; }
    public double getBackoffMultiplier() { return backoffMultiplier; }
    public boolean isJitterEnabled() { return addJitter; }

    public static class Builder {
        private int maxRetries = 3;
        private Duration initialDelay = Duration.ofMillis(100);
        private Duration maxDelay = Duration.ofSeconds(10);
        private double backoffMultiplier = 2.0;
        private boolean addJitter = true;
        private TimeoutConfig timeoutConfig = null;

        private Builder() {}

        public Builder maxRetries(int maxRetries) {
            this.maxRetries = maxRetries;
            return this;
        }

        public Builder initialDelay(Duration delay) {
            this.initialDelay = delay;
            return this;
        }

        public Builder maxDelay(Duration delay) {
            this.maxDelay = delay;
            return this;
        }

        public Builder backoffMultiplier(double multiplier) {
            this.backoffMultiplier = multiplier;
            return this;
        }

        public Builder addJitter(boolean addJitter) {
            this.addJitter = addJitter;
            return this;
        }

        public Builder timeoutConfig(TimeoutConfig config) {
            this.timeoutConfig = config;
            return this;
        }

        public StreamingRetryHandler build() {
            return new StreamingRetryHandler(this);
        }
    }

    /**
     * Exception thrown when all retry attempts are exhausted.
     */
    public static class StreamingRetryExhaustedException extends RuntimeException {
        private final int attemptsMade;
        private final Throwable lastException;

        public StreamingRetryExhaustedException(String message, Throwable cause, int attemptsMade) {
            super(message + " (attempts: " + attemptsMade + ")", cause);
            this.attemptsMade = attemptsMade;
            this.lastException = cause;
        }

        public int getAttemptsMade() { return attemptsMade; }
        public Throwable getLastException() { return lastException; }
    }
}
