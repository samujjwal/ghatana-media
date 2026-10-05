package com.ghatana.media.stt.api;

import com.ghatana.media.common.AudioChunk;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.EngineMetrics;
import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.common.InferenceError;
import com.ghatana.media.common.ProcessingError;
import com.ghatana.media.common.ValidationError;
import com.ghatana.media.config.SttConfig;
import io.activej.promise.Promise;

import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

/** Explicit local/test-only STT provider that produces no semantic transcript. */
final class SyntheticSttEngine implements SttEngine {

    private final SttConfig config;
    private final Semaphore permits;
    private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();
    private final AtomicLong requests = new AtomicLong();
    private final AtomicLong errors = new AtomicLong();
    private final AtomicBoolean closed = new AtomicBoolean();
    private final long startedAt = System.currentTimeMillis();

    SyntheticSttEngine(SttConfig config) {
        this.config = java.util.Objects.requireNonNull(config, "config");
        this.permits = new Semaphore(config.maxConcurrentRequests());
    }

    @Override
    public TranscriptionResult transcribe(AudioData audio, TranscriptionOptions options) {
        ensureOpen();
        validateAudio(audio);
        java.util.Objects.requireNonNull(options, "options");
        requests.incrementAndGet();
        long started = System.nanoTime();
        try {
            permits.acquire();
            try {
                return new TranscriptionResult(
                        "",
                        0.0,
                        List.of(),
                        List.of(),
                        Duration.ofNanos(System.nanoTime() - started),
                        options.language() == null
                                ? Locale.ROOT.toLanguageTag()
                                : options.language().toLanguageTag(),
                        config.modelId());
            } finally {
                permits.release();
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            errors.incrementAndGet();
            throw new InferenceError("Synthetic STT interrupted", interrupted, true);
        }
    }

    @Override
    public Promise<TranscriptionResult> transcribeAsync(
            AudioData audio,
            TranscriptionOptions options) {
        return Promise.ofBlocking(executor, () -> transcribe(audio, options));
    }

    @Override
    public StreamingSession createStreamingSession() {
        return new SyntheticStreamingSession();
    }

    @Override
    public StreamingSession createStreamingSession(UserProfile profile) {
        if (profile != null) throw profilesUnsupported();
        return createStreamingSession();
    }

    @Override public UserProfile createProfile(String profileId, List<AudioData> enrollmentAudio) { throw profilesUnsupported(); }
    @Override public Optional<UserProfile> loadProfile(String profileId) { throw profilesUnsupported(); }
    @Override public void saveProfile(UserProfile profile) { throw profilesUnsupported(); }
    @Override public boolean deleteProfile(String profileId) { throw profilesUnsupported(); }
    @Override public List<String> listProfiles() { throw profilesUnsupported(); }

    @Override
    public List<ModelInfo> getAvailableModels() {
        return List.of(getActiveModel());
    }

    @Override
    public void loadModel(String modelId) {
        if (!config.modelId().equals(modelId)) {
            throw new UnsupportedOperationException(
                    "Synthetic STT owns only model " + config.modelId());
        }
    }

    @Override
    public ModelInfo getActiveModel() {
        return new ModelInfo(
                config.modelId(),
                "Synthetic local/test STT",
                "synthetic-local-v1",
                new Locale[] {Locale.ROOT},
                0L,
                false);
    }

    @Override
    public void warmup() {
        ensureOpen();
    }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) executor.shutdownNow();
    }

    @Override
    public EngineStatus getStatus() {
        return new EngineStatus(
                closed.get() ? EngineStatus.State.CLOSED : EngineStatus.State.DEGRADED,
                config.modelId(),
                "synthetic-local-v1",
                System.currentTimeMillis() - startedAt,
                closed.get() ? "Engine closed" : "Synthetic STT fallback active");
    }

    @Override
    public EngineMetrics getMetrics() {
        return new EngineMetrics(
                requests.get(),
                errors.get(),
                0.0,
                config.maxConcurrentRequests() - permits.availablePermits(),
                0L);
    }

    private void validateAudio(AudioData audio) {
        if (audio == null) throw new ValidationError("Audio data cannot be null");
        if (audio.data() == null || audio.data().length == 0) {
            throw new ValidationError("Audio data cannot be empty");
        }
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("STT Engine is closed");
    }

    private static UnsupportedOperationException profilesUnsupported() {
        return new UnsupportedOperationException(
                "Synthetic STT does not provide speaker profiles or adaptation");
    }

    private static final class SyntheticStreamingSession implements StreamingSession {
        private final AtomicBoolean active = new AtomicBoolean(true);
        private final AtomicReference<Consumer<StreamingTranscription>> transcription =
                new AtomicReference<>();
        private final AtomicReference<Consumer<ProcessingError>> error = new AtomicReference<>();

        @Override
        public void feedAudio(AudioChunk chunk) {
            if (!active.get()) throw new IllegalStateException("Session is closed");
            if (chunk == null || chunk.data() == null || chunk.data().length == 0) {
                throw new ValidationError("Audio chunk cannot be empty");
            }
            Consumer<StreamingTranscription> callback = transcription.get();
            if (callback != null) {
                callback.accept(new StreamingTranscription("", chunk.isLast(), 0.0, List.of()));
            }
            if (chunk.isLast()) active.set(false);
        }

        @Override public void onTranscription(Consumer<StreamingTranscription> callback) { transcription.set(callback); }
        @Override public void onError(Consumer<ProcessingError> callback) { error.set(callback); }
        @Override public void endStream() { active.set(false); }
        @Override public boolean isActive() { return active.get(); }
        @Override public void close() { active.set(false); }
    }
}
