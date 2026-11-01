package com.ghatana.audio.video.common.resilience;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.util.concurrent.Callable;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.Predicate;

/**
 * Configurable retry policy with exponential back-off and optional jitter.
 *
 * <p>Provides both blocking ({@link #execute}) and result-returning ({@link #executeWithResult})
 * execution models. The policy is stateless and thread-safe; a single instance can be shared
 * across multiple call-sites.
 *
 * <h3>Default configuration</h3>
 * <ul>
 *   <li>Max attempts: 3</li>
 *   <li>Initial delay: 100 ms</li>
 *   <li>Max delay: 5 000 ms (5 s)</li>
 *   <li>Multiplier: 2.0 (doubles each attempt)</li>
 *   <li>Jitter: 10% of computed delay</li>
 * </ul>
 *
 * <h3>Usage</h3>
 * <pre>{@code
 * RetryPolicy policy = RetryPolicy.defaults();
 * String result = policy.executeWithResult(() -> remoteCall());
 * }</pre>
 *
 * @doc.type class
 * @doc.purpose Provides configurable retry logic with exponential back-off for transient failures
 * @doc.layer product
 * @doc.pattern Strategy
 */
public final class RetryPolicy {

    /** Hard ceiling preventing configurations from creating effectively unbounded retry work. */
    public static final int MAX_ATTEMPTS = 100;
    /** Hard ceiling for retry delays, including jitter. */
    public static final Duration MAX_DELAY = Duration.ofMinutes(1);
    /** Hard ceiling for retry/back-off elapsed budget. Callable execution needs its own I/O timeout. */
    public static final Duration MAX_ELAPSED = Duration.ofMinutes(5);

    private static final Logger LOG = LoggerFactory.getLogger(RetryPolicy.class);

    private final int maxAttempts;
    private final long initialDelayMs;
    private final long maxDelayMs;
    private final long maxElapsedMs;
    private final double multiplier;
    private final double jitterFactor;
    private final Predicate<Throwable> retryOn;

    private RetryPolicy(Builder builder) {
        this.maxAttempts = builder.maxAttempts;
        this.initialDelayMs = builder.initialDelayMs;
        this.maxDelayMs = builder.maxDelayMs;
        this.maxElapsedMs = builder.maxElapsedMs;
        this.multiplier = builder.multiplier;
        this.jitterFactor = builder.jitterFactor;
        this.retryOn = builder.retryOn;
    }

    /**
     * Returns a sensible default retry policy suitable for transient I/O errors.
     *
     * @return default retry policy instance
     */
    public static RetryPolicy defaults() {
        return builder().build();
    }

    /**
     * Returns a builder for constructing a custom retry policy.
     *
     * @return new builder
     */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Executes {@code action} up to {@link #maxAttempts} times.
     *
     * @param action the action to execute; must not be {@code null}
     * @throws RetryExhaustedException if all attempts fail
     * @throws InterruptedException    if the calling thread is interrupted during a back-off sleep
     */
    public void execute(RunnableChecked action) throws InterruptedException {
        executeWithResult(() -> {
            action.run();
            return null;
        });
    }

    /**
     * Executes {@code action} up to {@link #maxAttempts} times and returns the result.
     *
     * @param action the callable to execute; must not be {@code null}
     * @param <T>    the return type
     * @return the result of the first successful invocation
     * @throws RetryExhaustedException if all attempts fail
     * @throws InterruptedException    if the calling thread is interrupted during a back-off sleep
     */
    public <T> T executeWithResult(Callable<T> action) throws InterruptedException {
        Throwable lastError = null;
        long delayMs = initialDelayMs;
        long startedNanos = System.nanoTime();
        int attemptsMade = 0;

        for (int attempt = 1; attempt <= maxAttempts; attempt++) {
            if (retryBudgetExpired(startedNanos, System.nanoTime(), maxElapsedMs)) {
                LOG.warn("Retry elapsed-time budget exhausted before attempt {}", attempt);
                break;
            }
            attemptsMade = attempt;
            try {
                return action.call();
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                throw ie;
            } catch (Exception e) {
                lastError = e;
                if (!retryOn.test(e)) {
                    LOG.warn("Non-retryable error on attempt {}/{}: {}", attempt, maxAttempts,
                            e.getClass().getSimpleName());
                    throw new RetryExhaustedException("Non-retryable failure", e, attempt);
                }
                if (attempt == maxAttempts) {
                    LOG.error("All {} retry attempts exhausted: {}", maxAttempts,
                            e.getClass().getSimpleName());
                    break;
                }

                long actualDelay = applyJitter(delayMs);
                long elapsedNanos = System.nanoTime() - startedNanos;
                if (elapsedNanos < 0) {
                    LOG.warn("Retry elapsed-time measurement exceeded the monotonic clock range");
                    break;
                }
                long elapsedMs = Duration.ofNanos(elapsedNanos).toMillis();
                if (elapsedMs >= maxElapsedMs || actualDelay > maxElapsedMs - elapsedMs) {
                    LOG.warn("Retry elapsed-time budget exhausted after {} attempts", attempt);
                    break;
                }
                LOG.warn("Attempt {}/{} failed ({}), retrying in {}ms", attempt, maxAttempts,
                        e.getClass().getSimpleName(), actualDelay);
                Thread.sleep(actualDelay);
                delayMs = Math.min((long) (delayMs * multiplier), maxDelayMs);
            }
        }

        throw new RetryExhaustedException(
                "Retry policy exhausted after " + attemptsMade + " attempts",
                lastError,
                attemptsMade);
    }

    private long applyJitter(long delayMs) {
        double randomValue = jitterFactor <= 0 ? 0.5 : ThreadLocalRandom.current().nextDouble();
        return boundedDelay(delayMs, maxDelayMs, jitterFactor, randomValue);
    }

    /** Applies jitter and the configured cap, including to the first retry delay. */
    static long boundedDelay(long delayMs, long maxDelayMs, double jitterFactor, double randomValue) {
        long jitteredDelay = jitterFactor <= 0 ? delayMs : applyJitter(delayMs, jitterFactor, randomValue);
        return Math.min(jitteredDelay, maxDelayMs);
    }

    /** Returns true when another attempt must not start within the elapsed retry budget. */
    static boolean retryBudgetExpired(long startedNanos, long nowNanos, long maxElapsedMs) {
        long elapsedNanos = nowNanos - startedNanos;
        return elapsedNanos < 0 || elapsedNanos / 1_000_000L >= maxElapsedMs;
    }

    /** Applies symmetric jitter while saturating the addition instead of wrapping a large delay. */
    static long applyJitter(long delayMs, double jitterFactor, double randomValue) {
        double jitterValue = delayMs * jitterFactor * (randomValue * 2 - 1);
        long jitter = (long) jitterValue;
        long adjusted;
        if (jitter > 0 && delayMs > Long.MAX_VALUE - jitter) {
            adjusted = Long.MAX_VALUE;
        } else if (jitter < 0 && delayMs < Long.MIN_VALUE - jitter) {
            adjusted = Long.MIN_VALUE;
        } else {
            adjusted = delayMs + jitter;
        }
        return Math.max(0, adjusted);
    }

    /**
     * Checked runnable interface for use with {@link #execute}.
     */
    @FunctionalInterface
    public interface RunnableChecked {
        void run() throws Exception;
    }

    /**
     * Thrown when all retry attempts have been exhausted.
     */
    public static final class RetryExhaustedException extends RuntimeException {

        private final int attemptsMade;

        public RetryExhaustedException(String message, Throwable cause, int attemptsMade) {
            super(message, cause);
            this.attemptsMade = attemptsMade;
        }

        /**
         * Returns the number of attempts made before giving up.
         *
         * @return attempt count
         */
        public int getAttemptsMade() {
            return attemptsMade;
        }
    }

    /**
     * Builder for {@link RetryPolicy}.
     */
    public static final class Builder {

        private int maxAttempts = 3;
        private long initialDelayMs = 100L;
        private long maxDelayMs = 5_000L;
        private long maxElapsedMs = 30_000L;
        private double multiplier = 2.0;
        private double jitterFactor = 0.1;
        private Predicate<Throwable> retryOn = t -> true; // retry on all exceptions by default

        private Builder() {}

        /**
         * Maximum number of total attempts (including the first).
         *
         * @param maxAttempts must be &ge; 1
         * @return this builder
         */
        public Builder maxAttempts(int maxAttempts) {
            if (maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
                throw new IllegalArgumentException("maxAttempts must be between 1 and " + MAX_ATTEMPTS);
            }
            this.maxAttempts = maxAttempts;
            return this;
        }

        /**
         * Delay before the first retry.
         *
         * @param initialDelay must be positive
         * @return this builder
         */
        public Builder initialDelay(Duration initialDelay) {
            this.initialDelayMs = positiveMillis(initialDelay, "initialDelay");
            return this;
        }

        /**
         * Upper cap on computed delay (after multiplier and jitter).
         *
         * @param maxDelay must be positive
         * @return this builder
         */
        public Builder maxDelay(Duration maxDelay) {
            this.maxDelayMs = boundedMillis(maxDelay, "maxDelay", MAX_DELAY);
            return this;
        }

        /** Maximum wall-clock time spent retrying, including back-off sleeps. */
        public Builder maxElapsed(Duration maxElapsed) {
            this.maxElapsedMs = boundedMillis(maxElapsed, "maxElapsed", MAX_ELAPSED);
            return this;
        }

        /**
         * Back-off multiplier applied to the previous delay on each attempt.
         *
         * @param multiplier must be &ge; 1.0
         * @return this builder
         */
        public Builder multiplier(double multiplier) {
            if (!Double.isFinite(multiplier) || multiplier < 1.0) {
                throw new IllegalArgumentException("multiplier must be finite and >= 1.0");
            }
            this.multiplier = multiplier;
            return this;
        }

        /**
         * Fraction of the computed delay to add as random jitter.
         * Use 0 to disable jitter.
         *
         * @param jitterFactor 0.0 to 1.0
         * @return this builder
         */
        public Builder jitterFactor(double jitterFactor) {
            if (!Double.isFinite(jitterFactor) || jitterFactor < 0 || jitterFactor > 1) {
                throw new IllegalArgumentException("jitterFactor must be in [0, 1]");
            }
            this.jitterFactor = jitterFactor;
            return this;
        }

        /**
         * Predicate to decide whether a given exception should trigger a retry.
         * Return {@code true} to retry, {@code false} to propagate immediately.
         *
         * @param retryOn predicate; must not be {@code null}
         * @return this builder
         */
        public Builder retryOn(Predicate<Throwable> retryOn) {
            if (retryOn == null) throw new IllegalArgumentException("retryOn must not be null");
            this.retryOn = retryOn;
            return this;
        }

        /**
         * Convenience method: retry only on exceptions that are subtypes of {@code type}.
         *
         * @param type the exception type to retry on
         * @return this builder
         */
        public Builder retryOnlyOn(Class<? extends Throwable> type) {
            this.retryOn = type::isInstance;
            return this;
        }

        /**
         * Builds the {@link RetryPolicy}.
         *
         * @return new immutable policy
         */
        public RetryPolicy build() {
            if (initialDelayMs < 0) {
                throw new IllegalArgumentException("initialDelay must not be negative");
            }
            return new RetryPolicy(this);
        }

        private static long positiveMillis(Duration duration, String name) {
            if (duration == null || duration.isZero() || duration.isNegative()) {
                throw new IllegalArgumentException(name + " must be positive");
            }
            long millis;
            try {
                millis = duration.toMillis();
            } catch (ArithmeticException overflow) {
                throw new IllegalArgumentException(name + " exceeds the supported millisecond range", overflow);
            }
            if (millis <= 0) {
                throw new IllegalArgumentException(name + " must be at least 1 millisecond");
            }
            return millis;
        }

        private static long boundedMillis(Duration duration, String name, Duration maximum) {
            long millis = positiveMillis(duration, name);
            if (duration.compareTo(maximum) > 0) {
                throw new IllegalArgumentException(name + " must not exceed " + maximum);
            }
            return millis;
        }
    }
}
