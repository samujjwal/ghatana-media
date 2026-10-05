package com.ghatana.media;

import com.ghatana.media.common.AudioChunk;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.common.ValidationError;
import com.ghatana.media.config.TtsConfig;
import com.ghatana.media.tts.api.CloneOptions;
import com.ghatana.media.tts.api.SynthesisOptions;
import com.ghatana.media.tts.api.TtsEngine;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Tests the library-owned lifecycle and explicit synthetic TTS contract.
 *
 * <p>Real STT, TTS, and Vision provider semantics belong in their provider/module suites. This file
 * deliberately does not treat missing models or fabricated profile/voice behavior as successful
 * production features.
 *
 * @doc.type class
 * @doc.purpose Verifies AudioVideoLibrary ownership and explicit degraded TTS fallback
 * @doc.layer platform
 * @doc.pattern UnitTest
 */
class AudioVideoLibraryTest {

    @TempDir
    Path tempDirectory;

    private AudioVideoLibrary library;

    @BeforeEach
    void setUp() {
        library = AudioVideoLibrary.builder()
                .withTtsConfig(TtsConfig.builder()
                        .voiceModelPath(tempDirectory.resolve("missing.onnx"))
                        .defaultVoiceId("test-voice")
                        .availableVoices(List.of("test-voice", "alternate-voice"))
                        .allowSyntheticFallback(true)
                        .sampleRate(22_050)
                        .maxTextLength(5_000)
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
    void builderRequiresAtLeastOneEngine() {
        assertThatThrownBy(() -> AudioVideoLibrary.builder().build())
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("At least one engine");
    }

    @Test
    void returnsOneCachedBorrowedView() {
        TtsEngine first = library.getTtsEngine();
        TtsEngine second = library.getTtsEngine();

        assertThat(first).isSameAs(second);
        assertThat(library.isTtsEnabled()).isTrue();
        assertThat(library.isSttEnabled()).isFalse();
        assertThat(library.isVisionEnabled()).isFalse();
    }

    @Test
    void borrowedCloseDoesNotCloseOwnedEngine() {
        TtsEngine borrowed = library.getTtsEngine();
        borrowed.close();

        assertThat(borrowed.synthesize("hello after borrowed close").data()).isNotEmpty();
        assertThat(borrowed.getStatus().state()).isEqualTo(EngineStatus.State.DEGRADED);
    }

    @Test
    void libraryCloseClosesOwnedEngineExactlyOnce() {
        TtsEngine borrowed = library.getTtsEngine();

        library.close();
        assertThatCode(library::close).doesNotThrowAnyException();
        assertThat(borrowed.getStatus().state()).isEqualTo(EngineStatus.State.CLOSED);
        assertThatThrownBy(() -> borrowed.synthesize("closed"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("closed");
        assertThatThrownBy(library::getTtsEngine)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("has been closed");
    }

    @Test
    void syntheticFallbackReportsDegradedLibraryHealth() throws Exception {
        AudioVideoLibrary.LibraryStatus status = library.initializeAsync()
                .toCompletableFuture()
                .get();

        assertThat(status.healthy()).isFalse();
        assertThat(status.ttsStatus()).isNotNull();
        assertThat(status.ttsStatus().state()).isEqualTo(EngineStatus.State.DEGRADED);
    }

    @Test
    void validatesAndSynthesizesBoundedSyntheticAudio() {
        TtsEngine engine = library.getTtsEngine();

        assertThatThrownBy(() -> engine.synthesize(null, SynthesisOptions.defaults()))
                .isInstanceOf(ValidationError.class);
        assertThatThrownBy(() -> engine.synthesize(" ", SynthesisOptions.defaults()))
                .isInstanceOf(ValidationError.class);

        AudioData audio = engine.synthesize("Hello, world!");
        assertThat(audio.data()).isNotEmpty();
        assertThat(audio.sampleRate()).isEqualTo(22_050);
    }

    @Test
    void streamsDeterministicChunksWhenEnabled() {
        TtsEngine engine = library.getTtsEngine();
        List<AudioChunk> chunks = new ArrayList<>();

        engine.synthesizeStreaming("Hello for streaming", SynthesisOptions.defaults(), chunks::add);

        assertThat(chunks).isNotEmpty();
        assertThat(chunks.getLast().isLast()).isTrue();
    }

    @Test
    void permitsOnlyConfiguredSyntheticVoices() {
        TtsEngine engine = library.getTtsEngine();

        assertThat(engine.getAvailableVoices())
                .extracting(voice -> voice.voiceId())
                .containsExactly("test-voice");
        assertThatThrownBy(() -> engine.setActiveVoice("alternate-voice"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("owns only voice test-voice");
    }

    @Test
    void doesNotFabricateVoiceCloningOrProfilePersistence() {
        TtsEngine engine = library.getTtsEngine();

        assertThatThrownBy(() -> engine.cloneVoice("voice", List.of(), CloneOptions.defaults()))
                .isInstanceOf(UnsupportedOperationException.class)
                .hasMessageContaining("does not implement voice training or cloning");
        assertThatThrownBy(() -> engine.loadProfile("profile-1"))
                .isInstanceOf(UnsupportedOperationException.class)
                .hasMessageContaining("requires an enabled profileStoragePath");
    }
}
