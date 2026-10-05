package com.ghatana.media.tts.api;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.config.TtsConfig;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * @doc.type class
 * @doc.purpose Verifies fail-closed TTS loading and library-owned borrowed engine lifecycle
 * @doc.layer platform
 * @doc.pattern UnitTest
 */
class TtsEngineFactoryHardeningTest {

    @TempDir
    Path tempDirectory;

    @Test
    void rejectsMissingModelWhenSyntheticFallbackIsNotExplicitlyEnabled() {
        TtsConfig config = baseConfig(false);

        assertThatThrownBy(() -> TtsEngineFactory.create(
                config,
                new AudioVideoLibrary.LibraryState()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("synthetic fallback is disabled");
    }

    @Test
    void explicitSyntheticFallbackIsDegradedAndDoesNotFabricateAdvancedFeatures() {
        AudioVideoLibrary.LibraryState state = new AudioVideoLibrary.LibraryState();
        TtsEngine engine = TtsEngineFactory.create(baseConfig(true), state);

        assertThat(engine.getStatus().state()).isEqualTo(EngineStatus.State.DEGRADED);
        assertThat(state.isHealthy()).isFalse();
        assertThat(state.healthIssue()).contains("Synthetic TTS fallback");
        assertThat(engine.synthesize("hello").data()).isNotEmpty();
        assertThat(engine.getAvailableVoices())
                .extracting(VoiceInfo::voiceId)
                .containsExactly("test-voice-" + uniqueVoiceSuffix());
        assertThatThrownBy(() -> engine.cloneVoice("fake", List.of()))
                .isInstanceOf(UnsupportedOperationException.class)
                .hasMessageContaining("does not implement voice training or cloning");
        assertThatThrownBy(() -> engine.loadProfile("profile-1"))
                .isInstanceOf(UnsupportedOperationException.class)
                .hasMessageContaining("requires an enabled profileStoragePath");
        engine.close();
    }

    @Test
    void borrowedEngineCloseDoesNotCloseLibraryOwnedEngine() {
        TtsConfig config = baseConfig(true);
        AudioVideoLibrary library = AudioVideoLibrary.builder()
                .withTtsConfig(config)
                .build();
        TtsEngine borrowed = library.getTtsEngine();

        borrowed.close();
        assertThat(borrowed.synthesize("still available").data()).isNotEmpty();

        library.close();
        assertThatThrownBy(() -> borrowed.synthesize("closed"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("closed");
        assertThatThrownBy(library::getTtsEngine)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("has been closed");
    }

    @Test
    void validatesConfigurationBounds() {
        assertThatThrownBy(() -> TtsConfig.builder().maxConcurrentRequests(0).build())
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("maxConcurrentRequests");
        assertThatThrownBy(() -> TtsConfig.builder().sampleRate(7_999).build())
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sampleRate");
        assertThatThrownBy(() -> TtsConfig.builder().maxTextLength(0).build())
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("maxTextLength");
    }

    private TtsConfig baseConfig(boolean allowSyntheticFallback) {
        String voiceId = "test-voice-" + uniqueVoiceSuffix();
        return TtsConfig.builder()
                .voiceModelPath(tempDirectory.resolve(voiceId + ".missing.onnx"))
                .defaultVoiceId(voiceId)
                .availableVoices(List.of(voiceId))
                .allowSyntheticFallback(allowSyntheticFallback)
                .build();
    }

    private static String uniqueVoiceSuffix() {
        return UniqueVoiceHolder.VALUE;
    }

    private static final class UniqueVoiceHolder {
        private static final String VALUE = UUID.randomUUID().toString();
    }
}
