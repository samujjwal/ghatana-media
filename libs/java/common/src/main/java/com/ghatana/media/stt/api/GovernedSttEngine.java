package com.ghatana.media.stt.api;

import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.EngineMetrics;
import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.common.ValidationError;
import com.ghatana.media.config.SttConfig;
import io.activej.promise.Promise;

import java.time.Duration;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Truthful capability and resource boundary around a concrete STT provider.
 *
 * <p>The current composition owns one model file. Model hot-swap and speaker profile adaptation are
 * unsupported until providers with real persistence and embedding extraction are wired. Input size,
 * duration, result model identity, warmup, and lifecycle are enforced consistently for real and
 * explicitly synthetic providers.
 *
 * @doc.type class
 * @doc.purpose Enforce STT provider capability truth and resource limits
 * @doc.layer platform
 * @doc.pattern Decorator
 */
public final class GovernedSttEngine implements SttEngine {

    private final SttEngine delegate;
    private final SttConfig config;
    private final AtomicBoolean closed = new AtomicBoolean();

    public GovernedSttEngine(SttEngine delegate, SttConfig config) {
        this.delegate = Objects.requireNonNull(delegate, "delegate");
        this.config = Objects.requireNonNull(config, "config");
    }

    @Override
    public TranscriptionResult transcribe(AudioData audio, TranscriptionOptions options) {
        ensureOpen();
        validateAudio(audio);
        Objects.requireNonNull(options, "options");
        TranscriptionResult result = Objects.requireNonNull(
                delegate.transcribe(audio, options),
                "STT provider returned null result");
        if (!config.modelId().equals(result.modelId())) {
            throw new IllegalStateException(
                    "STT provider returned mismatched model identity: " + result.modelId());
        }
        if (result.confidence() < 0.0 || result.confidence() > 1.0) {
            throw new IllegalStateException("STT provider returned invalid confidence");
        }
        return result;
    }

    @Override
    public Promise<TranscriptionResult> transcribeAsync(
            AudioData audio,
            TranscriptionOptions options) {
        ensureOpen();
        validateAudio(audio);
        Objects.requireNonNull(options, "options");
        return delegate.transcribeAsync(audio, options)
                .map(result -> {
                    if (result == null) throw new IllegalStateException("STT provider returned null result");
                    if (!config.modelId().equals(result.modelId())) {
                        throw new IllegalStateException(
                                "STT provider returned mismatched model identity: " + result.modelId());
                    }
                    if (result.confidence() < 0.0 || result.confidence() > 1.0) {
                        throw new IllegalStateException("STT provider returned invalid confidence");
                    }
                    return result;
                });
    }

    @Override
    public StreamingSession createStreamingSession() {
        ensureOpen();
        return delegate.createStreamingSession();
    }

    @Override
    public StreamingSession createStreamingSession(UserProfile profile) {
        if (profile != null) throw profilesUnsupported();
        return createStreamingSession();
    }

    @Override
    public UserProfile createProfile(String profileId, List<AudioData> enrollmentAudio) {
        throw profilesUnsupported();
    }

    @Override
    public Optional<UserProfile> loadProfile(String profileId) {
        throw profilesUnsupported();
    }

    @Override
    public void saveProfile(UserProfile profile) {
        throw profilesUnsupported();
    }

    @Override
    public boolean deleteProfile(String profileId) {
        throw profilesUnsupported();
    }

    @Override
    public List<String> listProfiles() {
        throw profilesUnsupported();
    }

    @Override
    public List<ModelInfo> getAvailableModels() {
        ensureOpen();
        return List.of(activeModel());
    }

    @Override
    public void loadModel(String modelId) {
        ensureOpen();
        String normalized = requireText(modelId, "modelId");
        if (!config.modelId().equals(normalized)) {
            throw new UnsupportedOperationException(
                    "This STT provider owns only model " + config.modelId());
        }
    }

    @Override
    public ModelInfo getActiveModel() {
        ensureOpen();
        return activeModel();
    }

    @Override
    public void warmup() {
        ensureOpen();
        delegate.warmup();
        AudioData probe = AudioData.builder()
                .data(new byte[16_000 * 2])
                .sampleRate(16_000)
                .channels(1)
                .bitsPerSample(16)
                .build();
        TranscriptionResult result = transcribe(probe, TranscriptionOptions.defaults());
        if (result.modelId() == null || result.modelId().isBlank()) {
            throw new IllegalStateException("STT warmup returned no model identity");
        }
    }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) delegate.close();
    }

    @Override
    public EngineStatus getStatus() {
        return delegate.getStatus();
    }

    @Override
    public EngineMetrics getMetrics() {
        return delegate.getMetrics();
    }

    private ModelInfo activeModel() {
        ModelInfo model = Objects.requireNonNull(
                delegate.getActiveModel(),
                "STT provider returned null active model");
        if (!config.modelId().equals(model.modelId())) {
            throw new IllegalStateException("STT provider returned mismatched active model identity");
        }
        return model;
    }

    private void validateAudio(AudioData audio) {
        if (audio == null) throw new ValidationError("Audio data cannot be null");
        if (audio.data() == null || audio.data().length == 0) {
            throw new ValidationError("Audio data cannot be empty");
        }
        if (audio.data().length > config.maxMemoryBytes()) {
            throw new ValidationError(
                    "Audio payload exceeds configured maxMemoryBytes: "
                            + audio.data().length + " > " + config.maxMemoryBytes());
        }
        Duration duration = audio.duration();
        if (duration != null && duration.compareTo(
                Duration.ofSeconds(config.maxAudioLengthSeconds())) > 0) {
            throw new ValidationError(
                    "Audio duration exceeds " + config.maxAudioLengthSeconds() + " seconds");
        }
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("STT Engine is closed");
    }

    private static UnsupportedOperationException profilesUnsupported() {
        return new UnsupportedOperationException(
                "STT speaker profiles require a real embedding and persistence provider");
    }

    private static String requireText(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(field + " must not be blank");
        }
        return value.trim();
    }
}
