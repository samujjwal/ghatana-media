package com.ghatana.media.integration;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.common.pool.EnginePool;
import com.ghatana.media.config.TtsConfig;
import com.ghatana.media.resilience.CircuitBreakerSttEngine;
import com.ghatana.media.resilience.StreamingRetryHandler;
import com.ghatana.media.stt.api.TranscriptionOptions;
import com.ghatana.media.test.AudioVideoTestUtils;
import com.ghatana.media.tts.api.TtsEngine;
import io.activej.eventloop.Eventloop;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Deterministic integration tests for Media resilience and lifecycle boundaries.
 *
 * <p>Provider accuracy and native-model loading are validated in provider-backed suites. These
 * tests prove behavior that is deterministic without external models: retry accounting,
 * circuit-breaker degradation, bounded engine-pool concurrency, and explicit degraded TTS
 * lifecycle. No test accepts both success and failure as equivalent outcomes.
 *
 * @doc.type class
 * @doc.purpose Deterministic Media resilience, concurrency, and lifecycle integration proof
 * @doc.layer platform
 * @doc.pattern IntegrationTest
 */
class AudioVideoIntegrationTest {

    @TempDir
    Path tempDirectory;

    private Eventloop eventloop;
    private ExecutorService eventloopExecutor;

    @BeforeEach
    void setUp() {
        eventloop = Eventloop.create();
        eventloopExecutor = Executors.newSingleThreadExecutor();
        eventloopExecutor.submit(eventloop::run);
    }

    @AfterEach
    void tearDown() {
        eventloop.breakEventloop();
        eventloopExecutor.shutdownNow();
    }

    @Test
    void circuitBreakerReturnsExplicitDegradedResultAfterFailureThreshold() throws Exception {
        var failingEngine = AudioVideoTestUtils.createFailingSttEngine(1.0, RuntimeException.class);
        var circuitBreakerEngine = new CircuitBreakerSttEngine(failingEngine, eventloop);
        AudioData audio = new AudioData(new byte[16_000], 16_000, 1, 16);

        for (int index = 0; index < 10; index++) {
            try {
                circuitBreakerEngine.transcribe(audio, TranscriptionOptions.defaults());
            } catch (RuntimeException expected) {
                // Required provider failures drive the circuit to open.
            }
        }
        Thread.sleep(100);

        var degraded = circuitBreakerEngine.transcribe(audio, TranscriptionOptions.defaults());
        assertThat(degraded).isNotNull();
        assertThat(degraded.text()).isEmpty();
        assertThat(degraded.confidence()).isZero();
        circuitBreakerEngine.close();
    }

    @Test
    void retryHandlerUsesExactlyTheConfiguredRetryBudget() {
        StreamingRetryHandler retryHandler = StreamingRetryHandler.builder()
                .maxRetries(3)
                .initialDelay(Duration.ofMillis(1))
                .build();
        AtomicInteger attempts = new AtomicInteger();

        String recovered = retryHandler.executeWithRetry(() -> {
            int attempt = attempts.incrementAndGet();
            if (attempt < 3) {
                throw new IllegalStateException("temporarily unavailable-" + attempt);
            }
            return "recovered";
        }, "media-retry");

        assertThat(recovered).isEqualTo("recovered");
        assertThat(attempts).hasValue(3);

        attempts.set(0);
        String fallback = retryHandler.executeWithFallback(() -> {
            attempts.incrementAndGet();
            throw new IllegalStateException("temporarily unavailable");
        }, "fallback", "media-fallback");
        assertThat(fallback).isEqualTo("fallback");
        assertThat(attempts).hasValue(4);
    }

    @Test
    void enginePoolNeverExceedsConfiguredCapacity() throws Exception {
        int poolSize = 3;
        int requests = 12;
        EnginePool<com.ghatana.media.stt.api.SttEngine> pool = new EnginePool<>(
                () -> AudioVideoTestUtils.createFailingSttEngine(0.0, RuntimeException.class),
                engine -> true,
                engine -> {
                    engine.close();
                    return null;
                },
                EnginePool.PoolConfig.defaults()
                        .minSize(0)
                        .maxSize(poolSize)
                        .borrowTimeout(Duration.ofSeconds(1)));
        CountDownLatch completed = new CountDownLatch(requests);
        AtomicInteger active = new AtomicInteger();
        AtomicInteger maximumActive = new AtomicInteger();
        List<Throwable> failures = new CopyOnWriteArrayList<>();
        ExecutorService executor = Executors.newFixedThreadPool(requests);

        try {
            for (int index = 0; index < requests; index++) {
                executor.submit(() -> {
                    com.ghatana.media.stt.api.SttEngine engine = null;
                    try {
                        engine = pool.borrow();
                        int current = active.incrementAndGet();
                        maximumActive.accumulateAndGet(current, Math::max);
                        Thread.sleep(20);
                    } catch (Throwable failure) {
                        failures.add(failure);
                    } finally {
                        if (engine != null) {
                            active.decrementAndGet();
                            pool.returnEngine(engine);
                        }
                        completed.countDown();
                    }
                });
            }

            assertThat(completed.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(failures).isEmpty();
            assertThat(maximumActive.get()).isLessThanOrEqualTo(poolSize);
        } finally {
            executor.shutdownNow();
            pool.close();
        }
    }

    @Test
    void explicitSyntheticTtsRemainsUsableAcrossRequestScopeCloseAndStopsWithLibrary() {
        AudioVideoLibrary library = AudioVideoLibrary.builder()
                .withTtsConfig(TtsConfig.builder()
                        .voiceModelPath(tempDirectory.resolve("missing.onnx"))
                        .defaultVoiceId("integration-test")
                        .availableVoices(List.of("integration-test"))
                        .allowSyntheticFallback(true)
                        .build())
                .build();
        TtsEngine borrowed = library.getTtsEngine();

        try (borrowed) {
            assertThat(borrowed.synthesize("first request").data()).isNotEmpty();
        }
        assertThat(library.getTtsEngine().synthesize("second request").data()).isNotEmpty();
        assertThat(library.getStatus().ttsStatus().state()).isEqualTo(EngineStatus.State.DEGRADED);

        library.close();
        assertThat(borrowed.getStatus().state()).isEqualTo(EngineStatus.State.CLOSED);
    }
}
