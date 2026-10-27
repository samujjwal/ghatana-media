package com.ghatana.media.tts.api;

import com.ghatana.media.common.AudioChunk;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.common.CanonicalAudioFormat;
import com.ghatana.media.config.TtsConfig;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class GovernedTtsEngineStreamingTest {

    private static final CanonicalAudioFormat FORMAT = new CanonicalAudioFormat(
            22_050, 1, 16, AudioFormat.PCM);

    @Test
    void relaysProviderChunksBeforeProviderCompletion() throws Exception {
        TtsEngine delegate = mock(TtsEngine.class);
        CompletableFuture<Void> providerCompletion = new CompletableFuture<>();
        List<String> events = new CopyOnWriteArrayList<>();
        CountDownLatch firstChunk = new CountDownLatch(1);
        when(delegate.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
            TtsStreamSink providerSink = invocation.getArgument(2);
            providerSink.onAudioFormat(FORMAT);
            providerSink.onChunk(new AudioChunk(new byte[] {1, 2}, 0, false, 0));
            events.add("provider-still-running");
            firstChunk.countDown();
            return TtsStreamingSession.create(new AtomicBoolean(), providerCompletion);
        });
        GovernedTtsEngine engine = new GovernedTtsEngine(delegate, config(8));
        TtsStreamSink sink = recordingSink(events);

        try {
            TtsStreamingSession session = engine.startStreaming("hello", options(), sink);

            assertThat(firstChunk.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(events).containsExactly("format", "chunk:0", "provider-still-running");
            assertThat(session.completion().isDone()).isFalse();
            verify(delegate, never()).synthesize(anyString(), any());

            providerCompletion.complete(null);
            session.completion().get(1, TimeUnit.SECONDS);
            assertThat(session.isCancelled()).isFalse();
        } finally {
            engine.close();
        }
    }

    @Test
    void enforcesCumulativeConfiguredOutputBoundAcrossProviderChunks() throws Exception {
        TtsEngine delegate = mock(TtsEngine.class);
        CountDownLatch secondChunkRejected = new CountDownLatch(1);
        when(delegate.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
            TtsStreamSink providerSink = invocation.getArgument(2);
            providerSink.onChunk(new AudioChunk(new byte[] {1, 2}, 0, false, 0));
            try {
                providerSink.onChunk(new AudioChunk(new byte[] {3, 4}, 1, true, 1));
            } catch (IllegalStateException overLimit) {
                secondChunkRejected.countDown();
                throw overLimit;
            }
            return TtsStreamingSession.create(new AtomicBoolean(), CompletableFuture.completedFuture(null));
        });
        GovernedTtsEngine engine = new GovernedTtsEngine(delegate, config(3));
        List<String> events = new CopyOnWriteArrayList<>();

        try {
            TtsStreamingSession session = engine.startStreaming("hello", options(), recordingSink(events));
            assertThatThrownBy(() -> session.completion().get(1, TimeUnit.SECONDS))
                    .hasCauseInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("TTS stream output exceeds configured maxMemoryBytes");
            assertThat(secondChunkRejected.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(events).containsExactly("chunk:0");
        } finally {
            engine.close();
        }
    }

    @Test
    void cancellationCancelsTheDelegatedProviderSession() throws Exception {
        TtsEngine delegate = mock(TtsEngine.class);
        AtomicBoolean providerCancelled = new AtomicBoolean();
        CountDownLatch providerCancellationObserved = new CountDownLatch(1);
        CompletableFuture<Void> providerCompletion = new CompletableFuture<>();
        CountDownLatch providerStarted = new CountDownLatch(1);
        when(delegate.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
            providerStarted.countDown();
            return TtsStreamingSession.create(new AtomicBoolean(), providerCompletion,
                    () -> {
                        providerCancelled.set(true);
                        providerCancellationObserved.countDown();
                    });
        });
        GovernedTtsEngine engine = new GovernedTtsEngine(delegate, config(8));

        try {
            TtsStreamingSession session = engine.startStreaming("hello", options(), recordingSink(new CopyOnWriteArrayList<>()));

            assertThat(providerStarted.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(session.cancel()).isTrue();
            assertThat(session.isCancelled()).isTrue();
            // If cancel races with provider startup, GovernedTtsEngine cancels the session
            // immediately after startStreaming returns; observe that bounded handoff instead
            // of assuming the provider has already returned at the instant cancel() is called.
            assertThat(providerCancellationObserved.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(providerCancelled).isTrue();
            assertThat(session.completion()).isCancelled();
        } finally {
            engine.close();
        }
    }

    @Test
    void providerChunkWaitsForDownstreamReadiness() throws Exception {
        TtsEngine delegate = mock(TtsEngine.class);
        CountDownLatch providerAttemptedChunk = new CountDownLatch(1);
        CompletableFuture<Void> providerCompletion = new CompletableFuture<>();
        when(delegate.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
            TtsStreamSink providerSink = invocation.getArgument(2);
            providerAttemptedChunk.countDown();
            providerSink.onChunk(new AudioChunk(new byte[] {1, 2}, 0, true, 0));
            providerCompletion.complete(null);
            return TtsStreamingSession.create(new AtomicBoolean(), providerCompletion);
        });
        GovernedTtsEngine engine = new GovernedTtsEngine(delegate, config(8));
        AtomicBoolean ready = new AtomicBoolean();
        CountDownLatch becameReady = new CountDownLatch(1);
        CountDownLatch deliveredChunk = new CountDownLatch(1);
        TtsStreamSink sink = new TtsStreamSink() {
            @Override public boolean isReady() { return ready.get(); }
            @Override public boolean isCancelled() { return false; }
            @Override public void awaitReady() throws InterruptedException { becameReady.await(); }
            @Override public void onChunk(AudioChunk chunk) { deliveredChunk.countDown(); }
        };

        try {
            TtsStreamingSession session = engine.startStreaming("hello", options(), sink);
            assertThat(providerAttemptedChunk.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(deliveredChunk.await(50, TimeUnit.MILLISECONDS)).isFalse();

            ready.set(true);
            becameReady.countDown();
            assertThat(deliveredChunk.await(1, TimeUnit.SECONDS)).isTrue();
            session.completion().get(1, TimeUnit.SECONDS);
        } finally {
            engine.close();
        }
    }

    @Test
    void returnsSessionPromptlyAndInterruptsProviderStartupBlockedOnReadiness() throws Exception {
        TtsEngine delegate = mock(TtsEngine.class);
        CountDownLatch waitingForReadiness = new CountDownLatch(1);
        AtomicBoolean startupInterrupted = new AtomicBoolean();
        AtomicBoolean providerCancelled = new AtomicBoolean();
        when(delegate.startStreaming(anyString(), any(), any())).thenAnswer(invocation -> {
            TtsStreamSink providerSink = invocation.getArgument(2);
            waitingForReadiness.countDown();
            try {
                providerSink.awaitReady();
            } catch (InterruptedException interrupted) {
                startupInterrupted.set(true);
                Thread.currentThread().interrupt();
            }
            return TtsStreamingSession.create(new AtomicBoolean(), new CompletableFuture<>(),
                    () -> providerCancelled.set(true));
        });
        GovernedTtsEngine engine = new GovernedTtsEngine(delegate, config(8));
        TtsStreamSink blockedSink = new TtsStreamSink() {
            @Override public boolean isReady() { return false; }
            @Override public boolean isCancelled() { return false; }
            @Override public void awaitReady() throws InterruptedException { new CountDownLatch(1).await(); }
            @Override public void onChunk(AudioChunk chunk) { throw new AssertionError("unexpected chunk"); }
        };

        try {
            TtsStreamingSession session = engine.startStreaming("hello", options(), blockedSink);
            assertThat(session).isNotNull();
            assertThat(waitingForReadiness.await(1, TimeUnit.SECONDS)).isTrue();

            assertThat(session.cancel()).isTrue();
            assertThat(session.completion().isCancelled()).isTrue();
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
            while (!providerCancelled.get() && System.nanoTime() < deadline) Thread.onSpinWait();
            assertThat(startupInterrupted).isTrue();
            assertThat(providerCancelled).isTrue();
        } finally {
            engine.close();
        }
    }

    private static TtsConfig config(long maxMemoryBytes) {
        return TtsConfig.builder()
                .defaultVoiceId("voice-test")
                .availableVoices(List.of("voice-test"))
                .maxMemoryBytes(maxMemoryBytes)
                .enableStreaming(true)
                .build();
    }

    private static SynthesisOptions options() {
        return SynthesisOptions.builder().outputFormat(AudioFormat.PCM).build();
    }

    private static TtsStreamSink recordingSink(List<String> events) {
        return new TtsStreamSink() {
            @Override public boolean isReady() { return true; }
            @Override public boolean isCancelled() { return false; }
            @Override public void awaitReady() { }
            @Override public void onAudioFormat(CanonicalAudioFormat format) { events.add("format"); }
            @Override public void onChunk(AudioChunk chunk) { events.add("chunk:" + chunk.sequenceNumber()); }
        };
    }
}
