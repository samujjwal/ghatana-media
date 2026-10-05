package com.ghatana.media;

import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.config.TtsConfig;
import com.ghatana.media.tts.api.TtsEngine;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Concurrent lifecycle proof for the embeddable Media library.
 *
 * <p>This suite intentionally replaces the former expansion tests that only asserted local strings,
 * builders, and counters while claiming STT/TTS/Vision processing coverage. Provider accuracy,
 * codecs, and native inference belong to provider-backed suites. This test proves the reusable
 * library behavior that can be established deterministically without native models: one cached
 * borrowed engine, bounded concurrent calls, request-scope close isolation, and library-owned
 * terminal shutdown.
 *
 * @doc.type class
 * @doc.purpose Deterministic concurrent Media library lifecycle and synthetic TTS proof
 * @doc.layer platform
 * @doc.pattern ConcurrencyTest
 */
class AudioVideoExpansionTest {

    @TempDir
    Path tempDirectory;

    private AudioVideoLibrary library;

    @BeforeEach
    void setUp() {
        library = AudioVideoLibrary.builder()
                .withTtsConfig(TtsConfig.builder()
                        .voiceModelPath(tempDirectory.resolve("missing-model.onnx"))
                        .defaultVoiceId("synthetic-test")
                        .availableVoices(List.of("synthetic-test"))
                        .maxConcurrentRequests(4)
                        .allowSyntheticFallback(true)
                        .build())
                .build();
    }

    @AfterEach
    void tearDown() {
        if (library != null) {
            library.close();
        }
    }

    @Test
    void concurrentBorrowersShareOneEngineWithoutClosingEachOther() throws Exception {
        TtsEngine cached = library.getTtsEngine();
        int requestCount = 120;
        ExecutorService executor = Executors.newFixedThreadPool(12);
        try {
            List<Callable<AudioData>> work = new ArrayList<>();
            for (int index = 0; index < requestCount; index++) {
                int requestIndex = index;
                work.add(() -> {
                    TtsEngine borrowed = library.getTtsEngine();
                    assertThat(borrowed).isSameAs(cached);
                    try (borrowed) {
                        return borrowed.synthesize("concurrent request " + requestIndex);
                    }
                });
            }

            List<Future<AudioData>> futures = executor.invokeAll(work);
            for (Future<AudioData> future : futures) {
                AudioData audio = future.get();
                assertThat(audio.data()).isNotEmpty();
                assertThat(audio.sampleRate()).isEqualTo(22_050);
            }
        } finally {
            executor.shutdownNow();
        }

        assertThat(cached.getStatus().state()).isEqualTo(EngineStatus.State.DEGRADED);
        assertThat(cached.getMetrics().requestCount()).isEqualTo(requestCount);
        assertThat(cached.synthesize("still open after request closes").data()).isNotEmpty();
    }

    @Test
    void libraryCloseTerminatesTheOwnedEngineForEveryBorrower() {
        TtsEngine first = library.getTtsEngine();
        TtsEngine second = library.getTtsEngine();

        first.close();
        assertThat(second.synthesize("borrowed close is isolated").data()).isNotEmpty();

        library.close();
        assertThat(first.getStatus().state()).isEqualTo(EngineStatus.State.CLOSED);
        assertThat(second.getStatus().state()).isEqualTo(EngineStatus.State.CLOSED);
        assertThatThrownBy(() -> first.synthesize("closed"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("closed");
    }

    @Test
    void syntheticFallbackRemainsExplicitAndDegraded() {
        AudioVideoLibrary.LibraryStatus status = library.getStatus();
        assertThat(status.ttsStatus()).isNull();

        TtsEngine engine = library.getTtsEngine();
        status = library.getStatus();
        assertThat(status.healthy()).isFalse();
        assertThat(status.ttsStatus().state()).isEqualTo(EngineStatus.State.DEGRADED);
        assertThat(engine.getAvailableVoices())
                .extracting(voice -> voice.voiceId())
                .containsExactly("synthetic-test");
    }
}
