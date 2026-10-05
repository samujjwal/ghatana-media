/**
 * @doc.type class
 * @doc.purpose Circuit breaker wrapper for TTS engines to prevent cascade failures
 * @doc.layer platform
 * @doc.pattern Resilience, CircuitBreaker, Decorator
 */
package com.ghatana.media.resilience;

import com.ghatana.media.common.*;
import com.ghatana.media.tts.api.*;
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
 * Circuit breaker wrapper for TTS Engine providing resilience against cascade failures.
 *
 * <p>Protects speech synthesis operations with circuit breaker pattern:
 * <ul>
 *   <li>CLOSED: Normal operation, failures counted</li>
 *   <li>OPEN: Fast-fail for all calls until timeout expires</li>
 *   <li>HALF_OPEN: Single probe call to test recovery</li>
 * </ul></p>
 *
 * <p>Provides degraded response (silence/empty audio) when circuit is open to allow
 * graceful system degradation rather than complete failure.</p>
 *
 * @since 2026-03-27
 * @author Ghatana Audio-Video Team
 * @see CircuitBreaker
 * @see TtsEngine
 */
public class CircuitBreakerTtsEngine implements TtsEngine {

    private static final Logger LOG = Logger.getLogger(CircuitBreakerTtsEngine.class.getName());

    private final TtsEngine delegate;
    private final CircuitBreaker circuitBreaker;
    private final Eventloop eventloop;

    // Default circuit breaker configuration for TTS operations
    private static final int DEFAULT_FAILURE_THRESHOLD = 5;
    private static final int DEFAULT_SUCCESS_THRESHOLD = 2;
    private static final Duration DEFAULT_RESET_TIMEOUT = Duration.ofSeconds(30);
    private static final Duration DEFAULT_MAX_BACKOFF = Duration.ofMinutes(2);
    private static final double DEFAULT_BACKOFF_MULTIPLIER = 1.5;

    // Sample rate constants for degraded audio
    private static final int DEFAULT_SAMPLE_RATE = 24000;
    private static final int DEFAULT_CHANNELS = 1;
    private static final int DEFAULT_BITS_PER_SAMPLE = 16;

    /**
     * Creates a circuit breaker protected TTS engine with default configuration.
     *
     * @param delegate the underlying TTS engine to protect
     * @param eventloop ActiveJ eventloop for async operations
     */
    public CircuitBreakerTtsEngine(TtsEngine delegate, Eventloop eventloop) {
        this(delegate, eventloop, createDefaultCircuitBreaker(delegate));
    }

    /**
     * Creates a circuit breaker protected TTS engine with custom configuration.
     *
     * @param delegate the underlying TTS engine to protect
     * @param eventloop ActiveJ eventloop for async operations
     * @param circuitBreaker custom circuit breaker configuration
     */
    public CircuitBreakerTtsEngine(TtsEngine delegate, Eventloop eventloop, CircuitBreaker circuitBreaker) {
        this.delegate = delegate;
        this.eventloop = eventloop;
        this.circuitBreaker = circuitBreaker;
    }

    /**
     * Creates default circuit breaker configuration for TTS operations.
     */
    private static CircuitBreaker createDefaultCircuitBreaker(TtsEngine engine) {
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
    public AudioData synthesize(String text, SynthesisOptions options) {
        try {
            return circuitBreaker.executeSync(
                () -> delegate.synthesize(text, options),
                () -> createDegradedAudio(text, options)
            );
        } catch (CircuitBreaker.CircuitBreakerOpenException e) {
            LOG.log(Level.WARNING, "Circuit breaker open - returning degraded (silent) audio", e);
            return createDegradedAudio(text, options);
        } catch (InferenceError e) {
            throw e;
        } catch (Exception e) {
            LOG.log(Level.SEVERE, "Synthesis failed", e);
            throw new InferenceError("Synthesis failed", e, false);
        }
    }

    @Override
    public Promise<AudioData> synthesizeAsync(String text, SynthesisOptions options) {
        return CircuitBreakerPromiseAdapter.execute(circuitBreaker, () -> {
            return delegate.synthesizeAsync(text, options)
                .then(
                    result -> Promise.of(result),
                    error -> {
                        LOG.log(Level.WARNING, "Async synthesis failed", error);
                        return Promise.ofException(error);
                    }
                );
        }, () -> createDegradedAudio(text, options));
    }

    @Override
    public void synthesizeStreaming(String text, SynthesisOptions options, Consumer<AudioChunk> chunkConsumer) {
        try {
            circuitBreaker.executeSync(
                () -> { delegate.synthesizeStreaming(text, options, chunkConsumer); return null; }
            );
        } catch (CircuitBreaker.CircuitBreakerOpenException e) {
            LOG.log(Level.WARNING, "Circuit breaker open - streaming synthesis degraded", e);
            // Send empty chunk to signal degraded mode
            chunkConsumer.accept(new AudioChunk(
                new byte[0],
                0,
                true,
                0L
            ));
        } catch (InferenceError e) {
            throw e;
        } catch (Exception e) {
            throw new InferenceError("Streaming synthesis failed", e, false);
        }
    }

    @Override
    public VoiceInfo cloneVoice(String voiceName, List<AudioData> audioSamples, CloneOptions options) {
        return delegate.cloneVoice(voiceName, audioSamples, options);
    }

    @Override
    public TtsProfile createProfile(String profileId, String displayName, ProfileSettings settings) {
        return delegate.createProfile(profileId, displayName, settings);
    }

    @Override
    public Optional<TtsProfile> loadProfile(String profileId) {
        return delegate.loadProfile(profileId);
    }

    @Override
    public void saveProfile(TtsProfile profile) {
        delegate.saveProfile(profile);
    }

    @Override
    public boolean deleteProfile(String profileId) {
        return delegate.deleteProfile(profileId);
    }

    @Override
    public List<VoiceInfo> getAvailableVoices() {
        return delegate.getAvailableVoices();
    }

    @Override
    public List<VoiceInfo> getAvailableVoices(Locale locale) {
        return delegate.getAvailableVoices(locale);
    }

    @Override
    public VoiceInfo loadVoice(String voiceId) {
        return delegate.loadVoice(voiceId);
    }

    @Override
    public void setActiveVoice(String voiceId) {
        delegate.setActiveVoice(voiceId);
    }

    @Override
    public VoiceInfo getActiveVoice() {
        return delegate.getActiveVoice();
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
     * Create degraded (silent) audio when circuit is open.
     */
    private AudioData createDegradedAudio(String text, SynthesisOptions options) {
        // Return 0.5 seconds of silence
        int sampleCount = (int) (DEFAULT_SAMPLE_RATE * 0.5);
        byte[] silenceData = new byte[sampleCount * DEFAULT_CHANNELS * (DEFAULT_BITS_PER_SAMPLE / 8)];

        return new AudioData(
            silenceData,
            DEFAULT_SAMPLE_RATE,
            DEFAULT_CHANNELS,
            DEFAULT_BITS_PER_SAMPLE,
            java.time.Duration.ofMillis(500),
            AudioFormat.PCM
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

    // Degraded streaming synthesis removed - not needed for TtsEngine interface
}
