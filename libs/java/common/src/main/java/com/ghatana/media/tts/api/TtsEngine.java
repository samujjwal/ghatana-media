package com.ghatana.media.tts.api;

import com.ghatana.media.common.AudioChunk;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.EngineMetrics;
import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.common.InferenceError;
import com.ghatana.media.common.ValidationError;
import io.activej.promise.Promise;

import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

/**
 * Text-to-Speech Engine interface for embedded library usage.
 *
 * @doc.type interface
 * @doc.purpose Text-to-Speech Engine API for embedded library usage
 * @doc.layer platform
 * @doc.pattern ServiceInterface
 */
public interface TtsEngine extends AutoCloseable {

    default AudioData synthesize(String text) {
        return synthesize(text, SynthesisOptions.defaults());
    }

    AudioData synthesize(String text, SynthesisOptions options);

    default Promise<AudioData> synthesizeAsync(String text, SynthesisOptions options) {
        try {
            return Promise.of(synthesize(text, options));
        } catch (Exception exception) {
            return Promise.ofException(exception);
        }
    }

    default Promise<AudioData> synthesizeAsync(String text) {
        return synthesizeAsync(text, SynthesisOptions.defaults());
    }

    /** Legacy callback streaming entry point. Prefer {@link #startStreaming}. */
    void synthesizeStreaming(
            String text,
            SynthesisOptions options,
            Consumer<AudioChunk> chunkConsumer);

    default void synthesizeStreaming(String text, Consumer<AudioChunk> chunkConsumer) {
        synthesizeStreaming(text, SynthesisOptions.defaults(), chunkConsumer);
    }

    /**
     * Starts one readiness-aware, cancellable streaming operation.
     *
     * <p>The compatibility implementation runs the existing callback method on a virtual thread,
     * emits at most one chunk at a time after downstream readiness, and interrupts the producer on
     * cancellation. Providers may override to integrate native streaming cancellation.
     */
    default TtsStreamingSession startStreaming(
            String text,
            SynthesisOptions options,
            TtsStreamSink sink) {
        java.util.Objects.requireNonNull(options, "options");
        java.util.Objects.requireNonNull(sink, "sink");
        AtomicBoolean cancelled = new AtomicBoolean();
        CompletableFuture<Void> completion = new CompletableFuture<>();
        AtomicReference<Thread> producer = new AtomicReference<>();
        Thread thread = Thread.startVirtualThread(() -> {
            try {
                synthesizeStreaming(text, options, chunk -> {
                    if (cancelled.get() || sink.isCancelled()) {
                        throw new CancellationException("TTS stream cancelled");
                    }
                    try {
                        while (!sink.isReady()) {
                            sink.awaitReady();
                            if (cancelled.get() || sink.isCancelled()) {
                                throw new CancellationException("TTS stream cancelled");
                            }
                        }
                    } catch (InterruptedException exception) {
                        Thread.currentThread().interrupt();
                        throw new CancellationException("TTS stream interrupted");
                    }
                    sink.onChunk(chunk);
                });
                if (cancelled.get() || sink.isCancelled()) {
                    completion.cancel(false);
                } else {
                    completion.complete(null);
                }
            } catch (CancellationException exception) {
                cancelled.set(true);
                completion.cancel(false);
            } catch (Throwable failure) {
                completion.completeExceptionally(failure);
            }
        });
        producer.set(thread);
        return TtsStreamingSession.create(
                cancelled,
                completion,
                () -> {
                    Thread running = producer.get();
                    if (running != null) running.interrupt();
                });
    }

    List<VoiceInfo> getAvailableVoices();

    List<VoiceInfo> getAvailableVoices(Locale language);

    VoiceInfo loadVoice(String voiceId);

    VoiceInfo getActiveVoice();

    void setActiveVoice(String voiceId);

    VoiceInfo cloneVoice(
            String voiceName,
            List<AudioData> audioSamples,
            CloneOptions options);

    default VoiceInfo cloneVoice(String voiceName, List<AudioData> audioSamples) {
        return cloneVoice(voiceName, audioSamples, CloneOptions.defaults());
    }

    TtsProfile createProfile(
            String profileId,
            String displayName,
            ProfileSettings settings);

    Optional<TtsProfile> loadProfile(String profileId);

    void saveProfile(TtsProfile profile);

    boolean deleteProfile(String profileId);

    void warmup();

    @Override
    void close();

    EngineStatus getStatus();

    EngineMetrics getMetrics();
}
