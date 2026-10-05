/**
 * @doc.type class
 * @doc.purpose Unified timeout configuration for audio-video operations
 * @doc.layer platform
 * @doc.pattern Configuration, ValueObject
 */
package com.ghatana.media.config;

import java.time.Duration;
import java.util.Objects;

/**
 * Unified timeout configuration for all audio-video operations.
 *
 * <p>Addresses AV-008: Standardizes timeout values across the audio-video platform
 * to prevent inconsistent timeout handling.</p>
 *
 * <p>Default values follow industry best practices:
 * <ul>
 *   <li>Connection timeouts: 5-10 seconds</li>
 *   <li>Operation timeouts: 30-60 seconds</li>
 *   <li>Streaming timeouts: 5 minutes (for long-running streams)</li>
 *   <li>Health check timeouts: 5 seconds</li>
 * </ul></p>
 *
 * @since 2026-03-27
 * @see TimeoutAware
 */
public final class TimeoutConfig {

    // Default timeout values (in milliseconds)
    private static final long DEFAULT_CONNECTION_TIMEOUT_MS = 5000;
    private static final long DEFAULT_OPERATION_TIMEOUT_MS = 30000;
    private static final long DEFAULT_STREAMING_TIMEOUT_MS = 300000;
    private static final long DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 5000;
    private static final long DEFAULT_INITIALIZATION_TIMEOUT_MS = 60000;
    private static final long DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;

    private final Duration connectionTimeout;
    private final Duration operationTimeout;
    private final Duration streamingTimeout;
    private final Duration healthCheckTimeout;
    private final Duration initializationTimeout;
    private final Duration shutdownTimeout;

    private TimeoutConfig(Builder builder) {
        this.connectionTimeout = Objects.requireNonNullElse(builder.connectionTimeout,
            Duration.ofMillis(DEFAULT_CONNECTION_TIMEOUT_MS));
        this.operationTimeout = Objects.requireNonNullElse(builder.operationTimeout,
            Duration.ofMillis(DEFAULT_OPERATION_TIMEOUT_MS));
        this.streamingTimeout = Objects.requireNonNullElse(builder.streamingTimeout,
            Duration.ofMillis(DEFAULT_STREAMING_TIMEOUT_MS));
        this.healthCheckTimeout = Objects.requireNonNullElse(builder.healthCheckTimeout,
            Duration.ofMillis(DEFAULT_HEALTH_CHECK_TIMEOUT_MS));
        this.initializationTimeout = Objects.requireNonNullElse(builder.initializationTimeout,
            Duration.ofMillis(DEFAULT_INITIALIZATION_TIMEOUT_MS));
        this.shutdownTimeout = Objects.requireNonNullElse(builder.shutdownTimeout,
            Duration.ofMillis(DEFAULT_SHUTDOWN_TIMEOUT_MS));
    }

    /**
     * Creates a new builder with default timeouts.
     */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Creates a config with all default timeouts.
     */
    public static TimeoutConfig defaults() {
        return new Builder().build();
    }

    /**
     * Creates a config suitable for high-latency environments.
     */
    public static TimeoutConfig highLatency() {
        return builder()
            .connectionTimeout(Duration.ofSeconds(10))
            .operationTimeout(Duration.ofSeconds(60))
            .streamingTimeout(Duration.ofMinutes(10))
            .healthCheckTimeout(Duration.ofSeconds(10))
            .initializationTimeout(Duration.ofMinutes(2))
            .shutdownTimeout(Duration.ofSeconds(20))
            .build();
    }

    /**
     * Creates a config for low-latency/real-time environments.
     */
    public static TimeoutConfig lowLatency() {
        return builder()
            .connectionTimeout(Duration.ofSeconds(2))
            .operationTimeout(Duration.ofSeconds(10))
            .streamingTimeout(Duration.ofSeconds(60))
            .healthCheckTimeout(Duration.ofSeconds(2))
            .initializationTimeout(Duration.ofSeconds(30))
            .shutdownTimeout(Duration.ofSeconds(5))
            .build();
    }

    // Getters
    public Duration connectionTimeout() { return connectionTimeout; }
    public Duration operationTimeout() { return operationTimeout; }
    public Duration streamingTimeout() { return streamingTimeout; }
    public Duration healthCheckTimeout() { return healthCheckTimeout; }
    public Duration initializationTimeout() { return initializationTimeout; }
    public Duration shutdownTimeout() { return shutdownTimeout; }

    // Convenience methods for milliseconds
    public long connectionTimeoutMs() { return connectionTimeout.toMillis(); }
    public long operationTimeoutMs() { return operationTimeout.toMillis(); }
    public long streamingTimeoutMs() { return streamingTimeout.toMillis(); }
    public long healthCheckTimeoutMs() { return healthCheckTimeout.toMillis(); }
    public long initializationTimeoutMs() { return initializationTimeout.toMillis(); }
    public long shutdownTimeoutMs() { return shutdownTimeout.toMillis(); }

    @Override
    public String toString() {
        return String.format(
            "TimeoutConfig{connection=%ds, operation=%ds, streaming=%ds, health=%ds, init=%ds, shutdown=%ds}",
            connectionTimeout.getSeconds(),
            operationTimeout.getSeconds(),
            streamingTimeout.getSeconds(),
            healthCheckTimeout.getSeconds(),
            initializationTimeout.getSeconds(),
            shutdownTimeout.getSeconds()
        );
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        TimeoutConfig that = (TimeoutConfig) o;
        return Objects.equals(connectionTimeout, that.connectionTimeout) &&
               Objects.equals(operationTimeout, that.operationTimeout) &&
               Objects.equals(streamingTimeout, that.streamingTimeout) &&
               Objects.equals(healthCheckTimeout, that.healthCheckTimeout) &&
               Objects.equals(initializationTimeout, that.initializationTimeout) &&
               Objects.equals(shutdownTimeout, that.shutdownTimeout);
    }

    @Override
    public int hashCode() {
        return Objects.hash(connectionTimeout, operationTimeout, streamingTimeout,
            healthCheckTimeout, initializationTimeout, shutdownTimeout);
    }

    public static class Builder {
        private Duration connectionTimeout;
        private Duration operationTimeout;
        private Duration streamingTimeout;
        private Duration healthCheckTimeout;
        private Duration initializationTimeout;
        private Duration shutdownTimeout;

        private Builder() {}

        public Builder connectionTimeout(Duration timeout) {
            this.connectionTimeout = timeout;
            return this;
        }

        public Builder operationTimeout(Duration timeout) {
            this.operationTimeout = timeout;
            return this;
        }

        public Builder streamingTimeout(Duration timeout) {
            this.streamingTimeout = timeout;
            return this;
        }

        public Builder healthCheckTimeout(Duration timeout) {
            this.healthCheckTimeout = timeout;
            return this;
        }

        public Builder initializationTimeout(Duration timeout) {
            this.initializationTimeout = timeout;
            return this;
        }

        public Builder shutdownTimeout(Duration timeout) {
            this.shutdownTimeout = timeout;
            return this;
        }

        public TimeoutConfig build() {
            return new TimeoutConfig(this);
        }
    }
}
