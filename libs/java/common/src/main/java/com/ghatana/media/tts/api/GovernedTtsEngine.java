package com.ghatana.media.tts.api;

import com.ghatana.media.common.AudioChunk;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.EngineMetrics;
import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.config.TtsConfig;
import com.ghatana.media.tts.profile.FileTtsProfileStore;
import io.activej.promise.Promise;

import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

/**
 * Truthful capability and resource boundary around a concrete TTS provider.
 *
 * <p>The current Piper composition owns one model file and therefore advertises exactly one voice.
 * Voice cloning is unsupported until a real training provider exists. Profiles are available only
 * when a durable profile directory is configured and the provider composition enables them.
 * Streaming emits one bounded chunk at a time and honours downstream readiness and cancellation.
 *
 * @doc.type class
 * @doc.purpose Enforce provider capability truth, resource limits, profiles, and streaming control
 * @doc.layer platform
 * @doc.pattern Decorator
 */
public final class GovernedTtsEngine implements TtsEngine {

    private final TtsEngine delegate;
    private final TtsConfig config;
    private final Optional<FileTtsProfileStore> profiles;
    private final ExecutorService streamingExecutor = Executors.newVirtualThreadPerTaskExecutor();
    private final AtomicBoolean closed = new AtomicBoolean();

    public GovernedTtsEngine(TtsEngine delegate, TtsConfig config) {
        this(delegate, config, true);
    }

    public GovernedTtsEngine(
            TtsEngine delegate,
            TtsConfig config,
            boolean profileCapabilityEnabled) {
        this.delegate = Objects.requireNonNull(delegate, "delegate");
        this.config = Objects.requireNonNull(config, "config");
        this.profiles = profileCapabilityEnabled
                ? Optional.ofNullable(config.profileStoragePath()).map(FileTtsProfileStore::new)
                : Optional.empty();
    }

    @Override
    public AudioData synthesize(String text, SynthesisOptions options) {
        ensureOpen();
        validateVoice(options);
        AudioData audio = Objects.requireNonNull(
                delegate.synthesize(text, options),
                "TTS provider returned null audio");
        validateOutputSize(audio);
        return audio;
    }

    @Override
    public Promise<AudioData> synthesizeAsync(String text, SynthesisOptions options) {
        ensureOpen();
        validateVoice(options);
        return delegate.synthesizeAsync(text, options)
                .map(audio -> {
                    if (audio == null) throw new IllegalStateException("TTS provider returned null audio");
                    validateOutputSize(audio);
                    return audio;
                });
    }

    @Override
    public void synthesizeStreaming(
            String text,
            SynthesisOptions options,
            Consumer<AudioChunk> chunkConsumer) {
        Objects.requireNonNull(chunkConsumer, "chunkConsumer");
        AudioData audio = synthesize(text, options);
        emit(audio, options, chunkConsumer, null, null);
    }

    @Override
    public TtsStreamingSession startStreaming(
            String text,
            SynthesisOptions options,
            TtsStreamSink sink) {
        ensureOpen();
        Objects.requireNonNull(options, "options");
        Objects.requireNonNull(sink, "sink");
        if (!config.enableStreaming()) {
            throw new UnsupportedOperationException("Streaming synthesis is disabled");
        }
        AtomicBoolean cancelled = new AtomicBoolean();
        CompletableFuture<Void> completion = new CompletableFuture<>();
        AtomicReference<Future<?>> task = new AtomicReference<>();
        task.set(streamingExecutor.submit(() -> {
            try {
                AudioData audio = synthesize(text, options);
                emit(audio, options, sink::onChunk, sink, cancelled);
                if (cancelled.get() || sink.isCancelled()) {
                    completion.cancel(false);
                } else {
                    completion.complete(null);
                }
            } catch (CancellationException cancellation) {
                cancelled.set(true);
                completion.cancel(false);
            } catch (Throwable failure) {
                completion.completeExceptionally(failure);
            }
        }));
        return TtsStreamingSession.create(
                cancelled,
                completion,
                () -> {
                    Future<?> running = task.get();
                    if (running != null) running.cancel(true);
                });
    }

    @Override
    public List<VoiceInfo> getAvailableVoices() {
        ensureOpen();
        return List.of(currentVoice());
    }

    @Override
    public List<VoiceInfo> getAvailableVoices(Locale language) {
        Objects.requireNonNull(language, "language");
        VoiceInfo voice = currentVoice();
        return voice.language().getLanguage().equals(language.getLanguage())
                ? List.of(voice)
                : List.of();
    }

    @Override
    public VoiceInfo loadVoice(String voiceId) {
        ensureOpen();
        requireConfiguredVoice(voiceId);
        VoiceInfo voice = delegate.loadVoice(config.defaultVoiceId());
        if (!config.defaultVoiceId().equals(voice.voiceId())) {
            throw new IllegalStateException("TTS provider returned mismatched voice identity");
        }
        return voice;
    }

    @Override
    public VoiceInfo getActiveVoice() {
        ensureOpen();
        return currentVoice();
    }

    @Override
    public void setActiveVoice(String voiceId) {
        loadVoice(voiceId);
    }

    @Override
    public VoiceInfo cloneVoice(
            String voiceName,
            List<AudioData> audioSamples,
            CloneOptions options) {
        throw new UnsupportedOperationException(
                "This TTS provider does not implement voice training or cloning");
    }

    @Override
    public TtsProfile createProfile(
            String profileId,
            String displayName,
            ProfileSettings settings) {
        FileTtsProfileStore store = profileStore();
        TtsProfile profile = new TtsProfile(
                requireText(profileId, "profileId"),
                requireText(displayName, "displayName"),
                config.defaultVoiceId(),
                Objects.requireNonNull(settings, "settings"),
                List.of());
        return store.save(profile);
    }

    @Override
    public Optional<TtsProfile> loadProfile(String profileId) {
        return profileStore().load(requireText(profileId, "profileId"));
    }

    @Override
    public void saveProfile(TtsProfile profile) {
        Objects.requireNonNull(profile, "profile");
        requireConfiguredVoice(profile.preferredVoiceId());
        profileStore().save(profile);
    }

    @Override
    public boolean deleteProfile(String profileId) {
        return profileStore().delete(requireText(profileId, "profileId"));
    }

    @Override
    public void warmup() {
        ensureOpen();
        SynthesisOptions options = SynthesisOptions.builder()
                .voiceId(config.defaultVoiceId())
                .sampleRate(config.sampleRate())
                .build();
        AudioData audio = synthesize("TTS warmup", options);
        if (audio.data().length == 0) {
            throw new IllegalStateException("TTS warmup produced empty audio");
        }
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) return;
        streamingExecutor.shutdownNow();
        delegate.close();
    }

    @Override
    public EngineStatus getStatus() {
        return delegate.getStatus();
    }

    @Override
    public EngineMetrics getMetrics() {
        return delegate.getMetrics();
    }

    private void emit(
            AudioData audio,
            SynthesisOptions options,
            Consumer<AudioChunk> consumer,
            TtsStreamSink sink,
            AtomicBoolean cancelled) {
        if (!config.enableStreaming()) {
            throw new UnsupportedOperationException("Streaming synthesis is disabled");
        }
        int sampleRate = audio.sampleRate() > 0
                ? audio.sampleRate()
                : options.sampleRate() > 0 ? options.sampleRate() : config.sampleRate();
        int bytesPerChunk = Math.max(2, Math.multiplyExact(Math.max(1, sampleRate / 10), 2));
        byte[] data = audio.data();
        int sequence = 0;
        for (int offset = 0; offset < data.length; offset += bytesPerChunk) {
            if ((cancelled != null && cancelled.get())
                    || (sink != null && sink.isCancelled())
                    || Thread.currentThread().isInterrupted()) {
                throw new CancellationException("TTS stream cancelled");
            }
            if (sink != null) {
                try {
                    while (!sink.isReady()) {
                        sink.awaitReady();
                        if (sink.isCancelled()) throw new CancellationException("TTS stream cancelled");
                    }
                } catch (InterruptedException exception) {
                    Thread.currentThread().interrupt();
                    throw new CancellationException("TTS stream interrupted");
                }
            }
            int end = Math.min(offset + bytesPerChunk, data.length);
            consumer.accept(new AudioChunk(
                    Arrays.copyOfRange(data, offset, end),
                    sequence++,
                    end == data.length,
                    System.currentTimeMillis()));
        }
    }

    private VoiceInfo currentVoice() {
        VoiceInfo voice = delegate.getActiveVoice();
        if (!config.defaultVoiceId().equals(voice.voiceId())) {
            throw new IllegalStateException(
                    "TTS provider active voice does not match configured model identity");
        }
        return voice;
    }

    private void validateVoice(SynthesisOptions options) {
        Objects.requireNonNull(options, "options");
        if (options.voiceId() != null) requireConfiguredVoice(options.voiceId());
    }

    private void validateOutputSize(AudioData audio) {
        if (audio.data().length > config.maxMemoryBytes()) {
            throw new IllegalStateException(
                    "TTS output exceeds configured maxMemoryBytes: "
                            + audio.data().length + " > " + config.maxMemoryBytes());
        }
    }

    private void requireConfiguredVoice(String voiceId) {
        if (!config.defaultVoiceId().equals(requireText(voiceId, "voiceId"))) {
            throw new IllegalArgumentException(
                    "Configured TTS provider owns only voice " + config.defaultVoiceId());
        }
    }

    private FileTtsProfileStore profileStore() {
        ensureOpen();
        return profiles.orElseThrow(() -> new UnsupportedOperationException(
                "TTS profile persistence requires an enabled profileStoragePath"));
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("TTS Engine is closed");
    }

    private static String requireText(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(field + " must not be blank");
        }
        return value.trim();
    }
}
