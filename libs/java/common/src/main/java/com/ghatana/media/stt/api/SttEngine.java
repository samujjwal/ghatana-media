/**
 * @doc.type interface
 * @doc.purpose Speech-to-Text Engine API for embedded library usage
 * @doc.layer platform
 * @doc.pattern ServiceInterface
 */
package com.ghatana.media.stt.api;

import com.ghatana.media.common.*;
import io.activej.promise.Promise;

import java.util.List;
import java.util.Optional;

/**
 * Speech-to-Text Engine interface for transcription and adaptation.
 *
 * <p>Usage:
 * <pre>{@code
 * try (SttEngine engine = library.getSttEngine()) {
 *     // Synchronous transcription
 *     TranscriptionResult result = engine.transcribe(audioData);
 *
 *     // Streaming transcription
 *     StreamingSession session = engine.createStreamingSession(profile);
 *     session.onTranscription(text -> System.out.println(text));
 *     session.feedAudio(chunk);
 * }
 * }</pre>
 */
public interface SttEngine extends AutoCloseable {

    // ====================================================================================
    // Core Transcription
    // ====================================================================================

    /**
     * Transcribe audio data synchronously.
     *
     * @param audio the audio data to transcribe
     * @return transcription result
     * @throws ValidationError if audio format is invalid
     * @throws InferenceError if transcription fails
     */
    default TranscriptionResult transcribe(AudioData audio) {
        return transcribe(audio, TranscriptionOptions.defaults());
    }

    /**
     * Transcribe audio with options.
     *
     * <p>Failure scenarios:
     * <ul>
     *   <li><b>Empty or too-short audio</b> — throws {@code ValidationError} if the payload
     *       is null, zero-length, or shorter than the minimum frame size supported by the
     *       active model.</li>
     *   <li><b>Unsupported sample rate</b> — throws {@code ValidationError} when the
     *       {@link AudioData} sample rate does not match the model's expected input.
     *       Use {@code AudioConverter} to resample before calling this method.</li>
     *   <li><b>No model loaded</b> — throws {@code ModelLoadingError} if no model has been
     *       initialised yet.  Call {@link #warmup()} or {@link #loadModel(String)} first.</li>
     *   <li><b>Inference failure</b> — throws {@code InferenceError} when the ONNX runtime
     *       returns an error.  {@link InferenceError#isRetryable()} indicates whether a
     *       retry with the same input is safe.</li>
     *   <li><b>Resource exhaustion</b> — throws {@code ResourceExhaustedError} when the
     *       engine's concurrency limiter or the engine pool is saturated.  Always retryable.</li>
     *   <li><b>Timeout</b> — throws {@code InferenceError} (retryable) when inference
     *       exceeds {@link TranscriptionOptions#timeout()}.</li>
     * </ul>
     *
     * @param audio   the audio data; must not be null or empty
     * @param options transcription options; use {@link TranscriptionOptions#defaults()} when
     *                no customisation is needed
     * @return transcription result; never null, but {@link TranscriptionResult#text()} may be
     *         empty for silent audio
     * @throws com.ghatana.media.error.ValidationError       if the audio payload is invalid
     * @throws com.ghatana.media.error.InferenceError        if transcription fails at runtime
     * @throws com.ghatana.media.error.ResourceExhaustedError if the engine is at capacity
     */
    TranscriptionResult transcribe(AudioData audio, TranscriptionOptions options);

    /**
     * Transcribe audio asynchronously.
     *
     * @param audio the audio data
     * @param options transcription options
     * @return promise of transcription result
     */
    default Promise<TranscriptionResult> transcribeAsync(AudioData audio, TranscriptionOptions options) {
        try {
            return Promise.of(transcribe(audio, options));
        } catch (Exception e) {
            return Promise.ofException(e);
        }
    }

    /**
     * Transcribe audio asynchronously with default options.
     */
    default Promise<TranscriptionResult> transcribeAsync(AudioData audio) {
        return transcribeAsync(audio, TranscriptionOptions.defaults());
    }

    // ====================================================================================
    // Streaming Transcription
    // ====================================================================================

    /**
     * Create a streaming transcription session.
     *
     * @return new streaming session
     */
    StreamingSession createStreamingSession();

    /**
     * Create a streaming session with user profile.
     *
     * @param profile user profile for personalized transcription
     * @return new streaming session
     */
    StreamingSession createStreamingSession(UserProfile profile);

    // ====================================================================================
    // Profile Management
    // ====================================================================================

    /**
     * Create a user profile from enrollment audio.
     *
     * @param profileId unique profile identifier
     * @param enrollmentAudio audio samples for speaker adaptation
     * @return created user profile
     */
    UserProfile createProfile(String profileId, List<AudioData> enrollmentAudio);

    /**
     * Load an existing profile.
     *
     * @param profileId profile identifier
     * @return optional containing profile if found
     */
    Optional<UserProfile> loadProfile(String profileId);

    /**
     * Save a profile to persistent storage.
     *
     * @param profile profile to save
     */
    void saveProfile(UserProfile profile);

    /**
     * Delete a profile.
     *
     * @param profileId profile identifier
     * @return true if deleted, false if not found
     */
    boolean deleteProfile(String profileId);

    /**
     * List all available profiles.
     */
    List<String> listProfiles();

    // ====================================================================================
    // Model Management
    // ====================================================================================

    /**
     * Get available models.
     */
    List<ModelInfo> getAvailableModels();

    /**
     * Load a specific model.
     *
     * @param modelId model identifier
     * @throws ModelLoadingError if model cannot be loaded
     */
    void loadModel(String modelId);

    /**
     * Get the currently active model.
     */
    ModelInfo getActiveModel();

    /**
     * Warm up the engine (pre-load models for lower latency).
     */
    void warmup();

    // ====================================================================================
    // Status & Metrics
    // ====================================================================================

    @Override
    void close();

    /**
     * Get engine status.
     */
    EngineStatus getStatus();

    /**
     * Get engine metrics.
     */
    EngineMetrics getMetrics();
}
