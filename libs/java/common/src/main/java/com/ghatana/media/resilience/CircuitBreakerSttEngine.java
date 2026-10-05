/**
 * @doc.type class
 * @doc.purpose Circuit breaker wrapper for audio/video engines to prevent cascade failures
 * @doc.layer platform
 * @doc.pattern Resilience, CircuitBreaker, Decorator
 */
package com.ghatana.media.resilience;

import com.ghatana.media.common.*;
import com.ghatana.media.stt.api.*;
import com.ghatana.resilience.CircuitBreaker;

import io.activej.eventloop.Eventloop;
import io.activej.promise.Promise;

import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.function.Consumer;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Circuit breaker wrapper for STT Engine providing resilience against cascade failures.
 *
 * <p>Protects transcription operations with circuit breaker pattern:
 * <ul>
 *   <li>CLOSED: Normal operation, failures counted</li>
 *   <li>OPEN: Fast-fail for all calls until timeout expires</li>
 *   <li>HALF_OPEN: Single probe call to test recovery</li>
 * </ul></p>
 *
 * <p>Provides degraded response (empty transcription) when circuit is open to allow
 * graceful system degradation rather than complete failure.</p>
 *
 * @since 2026-03-27
 * @author Ghatana Audio-Video Team
 * @see CircuitBreaker
 * @see SttEngine
 */
public class CircuitBreakerSttEngine implements SttEngine {

    private static final Logger LOG = Logger.getLogger(CircuitBreakerSttEngine.class.getName());

    private final SttEngine delegate;
    private final CircuitBreaker circuitBreaker;
    private final Eventloop eventloop;

    // Default circuit breaker configuration for STT operations
    private static final int DEFAULT_FAILURE_THRESHOLD = 5;
    private static final int DEFAULT_SUCCESS_THRESHOLD = 2;
    private static final Duration DEFAULT_RESET_TIMEOUT = Duration.ofSeconds(30);
    private static final Duration DEFAULT_MAX_BACKOFF = Duration.ofMinutes(2);
    private static final double DEFAULT_BACKOFF_MULTIPLIER = 1.5;

    /**
     * Creates a circuit breaker protected STT engine with default configuration.
     *
     * @param delegate the underlying STT engine to protect
     * @param eventloop ActiveJ eventloop for async operations
     */
    public CircuitBreakerSttEngine(SttEngine delegate, Eventloop eventloop) {
        this(delegate, eventloop, createDefaultCircuitBreaker(delegate));
    }

    /**
     * Creates a circuit breaker protected STT engine with custom configuration.
     *
     * @param delegate the underlying STT engine to protect
     * @param eventloop ActiveJ eventloop for async operations
     * @param circuitBreaker custom circuit breaker configuration
     */
    public CircuitBreakerSttEngine(SttEngine delegate, Eventloop eventloop, CircuitBreaker circuitBreaker) {
        this.delegate = delegate;
        this.eventloop = eventloop;
        this.circuitBreaker = circuitBreaker;
    }

    /**
     * Creates default circuit breaker configuration for STT operations.
     */
    private static CircuitBreaker createDefaultCircuitBreaker(SttEngine engine) {
        String engineName = engine.getClass().getSimpleName();
        return CircuitBreaker.builder(engineName + "-circuit")
            .failureThreshold(DEFAULT_FAILURE_THRESHOLD)
            .successThreshold(DEFAULT_SUCCESS_THRESHOLD)
            .resetTimeout(DEFAULT_RESET_TIMEOUT)
            .maxBackoff(DEFAULT_MAX_BACKOFF)
            .backoffMultiplier(DEFAULT_BACKOFF_MULTIPLIER)
            .build();
    }

    @Override
    public TranscriptionResult transcribe(AudioData audio, TranscriptionOptions options) {
        try {
            return circuitBreaker.executeSync(
                () -> delegate.transcribe(audio, options),
                () -> createDegradedResult(audio, options)
            );
        } catch (CircuitBreaker.CircuitBreakerOpenException e) {
            LOG.log(Level.WARNING, "Circuit breaker open - returning degraded transcription", e);
            return createDegradedResult(audio, options);
        } catch (InferenceError e) {
            throw e;
        } catch (Exception e) {
            LOG.log(Level.SEVERE, "Transcription failed", e);
            throw new InferenceError("Transcription failed", e, false);
        }
    }

    @Override
    public Promise<TranscriptionResult> transcribeAsync(AudioData audio, TranscriptionOptions options) {
        return CircuitBreakerPromiseAdapter.execute(circuitBreaker, () -> {
            return delegate.transcribeAsync(audio, options)
                .then(
                    result -> Promise.of(result),
                    error -> {
                        LOG.log(Level.WARNING, "Async transcription failed", error);
                        return Promise.ofException(error);
                    }
                );
        }, () -> createDegradedResult(audio, options));
    }

    @Override
    public StreamingSession createStreamingSession() {
        return createStreamingSession(null);
    }

    @Override
    public StreamingSession createStreamingSession(UserProfile profile) {
        try {
            return circuitBreaker.executeSync(
                () -> delegate.createStreamingSession(profile),
                () -> new DegradedStreamingSession(profile)
            );
        } catch (CircuitBreaker.CircuitBreakerOpenException e) {
            LOG.log(Level.WARNING, "Circuit breaker open - returning degraded streaming session", e);
            return new DegradedStreamingSession(profile);
        } catch (Exception e) {
            throw new RuntimeException("Failed to create streaming session", e);
        }
    }

    @Override
    public UserProfile createProfile(String profileId, List<AudioData> enrollmentAudio) {
        return delegate.createProfile(profileId, enrollmentAudio);
    }

    @Override
    public Optional<UserProfile> loadProfile(String profileId) {
        return delegate.loadProfile(profileId);
    }

    @Override
    public void saveProfile(UserProfile profile) {
        delegate.saveProfile(profile);
    }

    @Override
    public boolean deleteProfile(String profileId) {
        return delegate.deleteProfile(profileId);
    }

    @Override
    public List<String> listProfiles() {
        return delegate.listProfiles();
    }

    @Override
    public List<ModelInfo> getAvailableModels() {
        return delegate.getAvailableModels();
    }

    @Override
    public void loadModel(String modelId) {
        delegate.loadModel(modelId);
    }

    @Override
    public ModelInfo getActiveModel() {
        return delegate.getActiveModel();
    }

    @Override
    public void warmup() {
        delegate.warmup();
    }

    @Override
    public void close() {
        delegate.close();
    }

    @Override
    public EngineStatus getStatus() {
        EngineStatus delegateStatus = delegate.getStatus();
        CircuitBreaker.State cbState = circuitBreaker.getState();

        // Include circuit breaker state in engine status
        String statusMessage = delegateStatus.errorMessage() != null
            ? delegateStatus.errorMessage() + " [Circuit: " + cbState + "]"
            : "[Circuit: " + cbState + "]";

        return new EngineStatus(
            cbState == CircuitBreaker.State.OPEN ? EngineStatus.State.ERROR : delegateStatus.state(),
            delegateStatus.modelId(),
            delegateStatus.version(),
            delegateStatus.uptimeMs(),
            statusMessage
        );
    }

    @Override
    public EngineMetrics getMetrics() {
        EngineMetrics delegateMetrics = delegate.getMetrics();

        // Merge delegate metrics with circuit breaker failure/rejection counts
        return new EngineMetrics(
            delegateMetrics.requestCount(),
            delegateMetrics.errorCount() + circuitBreaker.getTotalFailures(),
            delegateMetrics.avgLatencyMs(),
            delegateMetrics.activeRequests(),
            circuitBreaker.getTotalRejections()
        );
    }

    /**
     * Get circuit breaker state for monitoring.
     */
    public CircuitBreaker.State getCircuitBreakerState() {
        return circuitBreaker.getState();
    }

    /**
     * Get detailed circuit breaker metrics.
     */
    public CircuitBreakerMetrics getCircuitBreakerMetrics() {
        return new CircuitBreakerMetrics(
            circuitBreaker.getState().name(),
            circuitBreaker.getFailureCount(),
            circuitBreaker.getTotalCalls(),
            circuitBreaker.getTotalSuccesses(),
            circuitBreaker.getTotalFailures(),
            circuitBreaker.getTotalRejections()
        );
    }

    /**
     * Manually reset the circuit breaker.
     */
    public void resetCircuitBreaker() {
        LOG.info("Manually resetting circuit breaker for " + circuitBreaker.getName());
        circuitBreaker.reset();
    }

    /**
     * Create degraded transcription result when circuit is open.
     */
    private TranscriptionResult createDegradedResult(AudioData audio, TranscriptionOptions options) {
        return new TranscriptionResult(
            "", // Empty transcription
            0.0, // Zero confidence
            List.of(),
            List.of(),
            Duration.ZERO,
            options != null && options.language() != null ? options.language().toLanguageTag() : Locale.ENGLISH.toLanguageTag(),
            getActiveModel() != null ? getActiveModel().modelId() : "unknown"
        );
    }

    /**
     * Circuit breaker metrics data class.
     */
    public record CircuitBreakerMetrics(
        String state,
        int currentFailures,
        long totalCalls,
        long totalSuccesses,
        long totalFailures,
        long totalRejections
    ) {}

    /**
     * Degraded streaming session when circuit is open.
     */
    private static class DegradedStreamingSession implements StreamingSession {
        private final UserProfile profile;
        private final java.util.concurrent.atomic.AtomicBoolean active =
            new java.util.concurrent.atomic.AtomicBoolean(true);

        DegradedStreamingSession(UserProfile profile) {
            this.profile = profile;
        }

        @Override
        public void feedAudio(AudioChunk chunk) {
            // Silently drop audio chunks in degraded mode
        }

        @Override
        public void onTranscription(Consumer<StreamingTranscription> callback) {
            // Provide empty transcriptions
            callback.accept(new StreamingTranscription(
                "",
                false,
                0.0,
                List.of()
            ));
        }

        @Override
        public void onError(Consumer<ProcessingError> callback) {
            // Signal degraded mode error
            callback.accept(new InferenceError(
                "Circuit breaker open - streaming in degraded mode",
                null,
                true
            ));
        }

        @Override
        public void endStream() {
            active.set(false);
        }

        @Override
        public boolean isActive() {
            return active.get();
        }

        @Override
        public void close() {
            active.set(false);
        }
    }
}
