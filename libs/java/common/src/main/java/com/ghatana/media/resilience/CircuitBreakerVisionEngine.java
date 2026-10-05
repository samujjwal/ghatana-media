/**
 * @doc.type class
 * @doc.purpose Circuit breaker wrapper for Vision Engine to prevent cascade failures
 * @doc.layer platform
 * @doc.pattern Resilience, CircuitBreaker, Decorator
 */
package com.ghatana.media.resilience;

import com.ghatana.media.common.*;
import com.ghatana.media.vision.api.*;
import com.ghatana.resilience.CircuitBreaker;

import io.activej.eventloop.Eventloop;
import io.activej.promise.Promise;

import java.time.Duration;
import java.util.Collections;
import java.util.List;
import java.util.function.Consumer;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Circuit breaker wrapper for Vision Engine providing resilience against cascade failures.
 *
 * <p>Protects detection and classification operations with circuit breaker pattern:
 * <ul>
 *   <li>CLOSED: Normal operation, failures counted</li>
 *   <li>OPEN: Fast-fail for all calls until timeout expires</li>
 *   <li>HALF_OPEN: Single probe call to test recovery</li>
 * </ul></p>
 *
 * <p>Provides degraded responses (empty results) when circuit is open, allowing
 * graceful system degradation rather than complete failure cascades.</p>
 *
 * @since 2026-03-27
 * @author Ghatana Audio-Video Team
 * @see CircuitBreaker
 * @see VisionEngine
 */
public class CircuitBreakerVisionEngine implements VisionEngine {

    private static final Logger LOG = Logger.getLogger(CircuitBreakerVisionEngine.class.getName());

    private final VisionEngine delegate;
    private final CircuitBreaker circuitBreaker;
    private final Eventloop eventloop;

    private static final int DEFAULT_FAILURE_THRESHOLD = 5;
    private static final int DEFAULT_SUCCESS_THRESHOLD = 2;
    private static final Duration DEFAULT_RESET_TIMEOUT = Duration.ofSeconds(30);
    private static final Duration DEFAULT_MAX_BACKOFF = Duration.ofMinutes(2);
    private static final double DEFAULT_BACKOFF_MULTIPLIER = 1.5;

    /**
     * Creates a circuit breaker protected Vision engine with default configuration.
     *
     * @param delegate  the underlying Vision engine to protect
     * @param eventloop ActiveJ eventloop for async operations
     */
    public CircuitBreakerVisionEngine(VisionEngine delegate, Eventloop eventloop) {
        this(delegate, eventloop, createDefaultCircuitBreaker(delegate));
    }

    /**
     * Creates a circuit breaker protected Vision engine with custom configuration.
     *
     * @param delegate       the underlying Vision engine to protect
     * @param eventloop      ActiveJ eventloop for async operations
     * @param circuitBreaker custom circuit breaker configuration
     */
    public CircuitBreakerVisionEngine(VisionEngine delegate, Eventloop eventloop, CircuitBreaker circuitBreaker) {
        this.delegate = delegate;
        this.eventloop = eventloop;
        this.circuitBreaker = circuitBreaker;
    }

    private static CircuitBreaker createDefaultCircuitBreaker(VisionEngine engine) {
        String engineName = engine.getClass().getSimpleName();
        return CircuitBreaker.builder(engineName + "-vision-circuit")
            .failureThreshold(DEFAULT_FAILURE_THRESHOLD)
            .successThreshold(DEFAULT_SUCCESS_THRESHOLD)
            .resetTimeout(DEFAULT_RESET_TIMEOUT)
            .maxBackoff(DEFAULT_MAX_BACKOFF)
            .backoffMultiplier(DEFAULT_BACKOFF_MULTIPLIER)
            .build();
    }

    @Override
    public DetectionResult detect(ImageData image, DetectionOptions options) {
        try {
            return circuitBreaker.executeSync(
                () -> delegate.detect(image, options),
                () -> new DetectionResult(Collections.emptyList(), 0, 0, 0L, "degraded")
            );
        } catch (CircuitBreaker.CircuitBreakerOpenException e) {
            LOG.log(Level.WARNING, "Vision circuit breaker open - returning empty detection result", e);
            return new DetectionResult(Collections.emptyList(), 0, 0, 0L, "degraded");
        } catch (InferenceError e) {
            throw e;
        } catch (Exception e) {
            LOG.log(Level.SEVERE, "Object detection failed", e);
            throw new InferenceError("Object detection failed", e, false);
        }
    }

    @Override
    public Promise<DetectionResult> detectAsync(ImageData image, DetectionOptions options) {
        return CircuitBreakerPromiseAdapter.execute(circuitBreaker, () ->
            delegate.detectAsync(image, options)
                .then(
                    Promise::of,
                    error -> {
                        LOG.log(Level.WARNING, "Async detection failed", error);
                        return Promise.ofException(error);
                    }
                ),
            () -> new DetectionResult(Collections.emptyList(), 0, 0, 0L, "degraded")
        );
    }

    @Override
    public StreamingDetectionSession createStreamingSession(DetectionOptions options,
                                                            Consumer<DetectionResult> resultCallback) {
        try {
            return circuitBreaker.executeSync(
                () -> delegate.createStreamingSession(options, resultCallback),
                () -> new NoOpStreamingDetectionSession()
            );
        } catch (CircuitBreaker.CircuitBreakerOpenException e) {
            LOG.log(Level.WARNING, "Vision circuit breaker open - returning no-op streaming session", e);
            return new NoOpStreamingDetectionSession();
        } catch (Exception e) {
            throw new RuntimeException("Failed to create vision streaming session", e);
        }
    }

    @Override
    public String caption(ImageData image) {
        try {
            return circuitBreaker.executeSync(
                () -> delegate.caption(image),
                () -> ""
            );
        } catch (CircuitBreaker.CircuitBreakerOpenException e) {
            LOG.log(Level.WARNING, "Vision circuit breaker open - returning empty caption", e);
            return "";
        } catch (InferenceError e) {
            throw e;
        } catch (Exception e) {
            LOG.log(Level.SEVERE, "Captioning failed", e);
            throw new InferenceError("Captioning failed", e, false);
        }
    }

    @Override
    public List<Classification> classify(ImageData image, int topK) {
        try {
            return circuitBreaker.executeSync(
                () -> delegate.classify(image, topK),
                () -> Collections.emptyList()
            );
        } catch (CircuitBreaker.CircuitBreakerOpenException e) {
            LOG.log(Level.WARNING, "Vision circuit breaker open - returning empty classifications", e);
            return Collections.emptyList();
        } catch (InferenceError e) {
            throw e;
        } catch (Exception e) {
            LOG.log(Level.SEVERE, "Classification failed", e);
            throw new InferenceError("Classification failed", e, false);
        }
    }

    @Override
    public List<DetectionModelInfo> getAvailableModels() {
        return delegate.getAvailableModels();
    }

    @Override
    public void loadModel(String modelId) {
        delegate.loadModel(modelId);
    }

    @Override
    public DetectionModelInfo getActiveModel() {
        return delegate.getActiveModel();
    }

    @Override
    public void warmup() {
        delegate.warmup();
    }

    @Override
    public EngineMetrics getMetrics() {
        EngineMetrics delegateMetrics = delegate.getMetrics();
        CircuitBreaker.State state = circuitBreaker.getState();
        // Fold circuit breaker rejections into memoryUsageBytes slot (as an approximation)
        return new EngineMetrics(
            delegateMetrics.requestCount(),
            delegateMetrics.errorCount() + circuitBreaker.getTotalFailures(),
            delegateMetrics.avgLatencyMs(),
            delegateMetrics.activeRequests(),
            circuitBreaker.getTotalRejections()
        );
    }

    @Override
    public EngineStatus getStatus() {
        EngineStatus delegateStatus = delegate.getStatus();
        CircuitBreaker.State state = circuitBreaker.getState();
        String statusMessage = delegateStatus.errorMessage() != null
            ? delegateStatus.errorMessage() + " [Circuit: " + state + "]"
            : "[Circuit: " + state + "]";
        return new EngineStatus(
            state == CircuitBreaker.State.OPEN ? EngineStatus.State.ERROR : delegateStatus.state(),
            delegateStatus.modelId(),
            delegateStatus.version(),
            delegateStatus.uptimeMs(),
            statusMessage
        );
    }

    @Override
    public void close() {
        delegate.close();
    }

    /** Returns the underlying circuit breaker for monitoring/testing. */
    public CircuitBreaker getCircuitBreaker() {
        return circuitBreaker;
    }

    /** Returns the current circuit breaker state. */
    public CircuitBreaker.State getCircuitBreakerState() {
        return circuitBreaker.getState();
    }

    // ── Degraded session: no-op implementation used when circuit is open ─────

    private static final class NoOpStreamingDetectionSession implements StreamingDetectionSession {
        private final java.util.concurrent.atomic.AtomicBoolean active =
            new java.util.concurrent.atomic.AtomicBoolean(true);

        @Override
        public void feedFrame(ImageData frame, long frameNumber) { /* no-op */ }

        @Override
        public void endStream() { active.set(false); }

        @Override
        public boolean isActive() { return active.get(); }

        @Override
        public void close() { active.set(false); }
    }
}
