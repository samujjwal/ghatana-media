package com.ghatana.tts.engine;

import com.ghatana.tts.engine.TtsSynthesisEngine.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

import java.util.Set;

import static org.assertj.core.api.Assertions.*;

/**
 * Tests for {@link TtsSynthesisEngine}.
 *
 * @doc.type    class
 * @doc.purpose TtsSynthesisEngine: voice selection, SSML, prosody, encoding, error cases
 * @doc.layer   product
 * @doc.pattern Test
 */
@DisplayName("TtsSynthesisEngineTest")
class TtsSynthesisEngineTest {

    private static final Set<String> VOICES = Set.of( 
            "en-US-standard-a", "en-US-standard-b", "fr-FR-standard-a"
    );

    private TtsSynthesisEngine engine;

    @BeforeEach
    void setUp() { 
        engine = new TtsSynthesisEngine("tts-v2", VOICES); 
    }

    // ── Default voice synthesis ───────────────────────────────────────────────

    @Test
    @DisplayName("synthesis with default voice produces non-empty audio")
    void synthesisDefaultVoiceProducesAudio() { 
        VoiceConfig voice = VoiceConfig.defaults(); 
        SynthesisResult result = engine.synthesize("Hello world", voice, AudioEncoding.PCM_16BIT); 
        assertThat(result).isNotNull(); 
        assertThat(result.isEmpty()).isFalse(); 
        assertThat(result.audioContent().length).isGreaterThan(0); 
    }

    @Test
    @DisplayName("synthesis result carries the voice ID from the config")
    void synthesisResultHasVoiceId() { 
        VoiceConfig voice = VoiceConfig.defaults(); 
        SynthesisResult result = engine.synthesize("Test input", voice, AudioEncoding.PCM_16BIT); 
        assertThat(result.voiceId()).isEqualTo(voice.voiceId()); 
    }

    // ── Multiple voices ───────────────────────────────────────────────────────

    @ParameterizedTest(name = "voice={0}") 
    @EnumSource(AudioEncoding.class) 
    @DisplayName("all output encodings are accepted for the default voice")
    void allEncodingsAccepted(AudioEncoding encoding) { 
        SynthesisResult result = engine.synthesize("Test", VoiceConfig.defaults(), encoding); 
        assertThat(result.encoding()).isEqualTo(encoding); 
    }

    @Test
    @DisplayName("second registered voice produces audio")
    void secondVoiceProducesAudio() { 
        VoiceConfig voice = new VoiceConfig("en-US-standard-b", "en-US", "MALE", 1.0f, 0.0f, 0.0f); 
        SynthesisResult result = engine.synthesize("Hello again", voice, AudioEncoding.PCM_16BIT); 
        assertThat(result.audioContent().length).isGreaterThan(0); 
    }

    @Test
    @DisplayName("French voice produces audio")
    void frenchVoiceProducesAudio() { 
        VoiceConfig voice = new VoiceConfig("fr-FR-standard-a", "fr-FR", "FEMALE", 1.0f, 0.0f, 0.0f); 
        SynthesisResult result = engine.synthesize("Bonjour le monde", voice, AudioEncoding.OPUS); 
        assertThat(result.isEmpty()).isFalse(); 
    }

    // ── SSML synthesis ────────────────────────────────────────────────────────

    @Test
    @DisplayName("SSML break tag is accepted without error")
    void ssmlBreakAccepted() { 
        String ssml = "<speak>Hello <break time=\"500ms\"/> world.</speak>";
        assertThatCode(() -> engine.synthesize(ssml, VoiceConfig.defaults(), AudioEncoding.PCM_16BIT)) 
                .doesNotThrowAnyException(); 
    }

    @Test
    @DisplayName("SSML prosody tag is accepted without error")
    void ssmlProsodyAccepted() { 
        String ssml = "<speak><prosody rate=\"slow\">Test text to speak.</prosody></speak>";
        assertThatCode(() -> engine.synthesize(ssml, VoiceConfig.defaults(), AudioEncoding.MP3)) 
                .doesNotThrowAnyException(); 
    }

    @Test
    @DisplayName("SSML emphasis tag produces non-empty audio")
    void ssmlEmphasisProducesAudio() { 
        String ssml = "<speak>This is <emphasis level=\"strong\">important</emphasis>.</speak>";
        SynthesisResult result = engine.synthesize(ssml, VoiceConfig.defaults(), AudioEncoding.PCM_16BIT); 
        assertThat(result.audioContent()).isNotEmpty(); 
    }

    // ── Prosody control ───────────────────────────────────────────────────────

    @Test
    @DisplayName("faster speaking rate produces shorter estimated duration")
    void fasterRateShortsDuration() { 
        VoiceConfig fast = new VoiceConfig("en-US-standard-a", "en-US", "NEUTRAL", 2.0f, 0.0f, 0.0f); 
        VoiceConfig slow = new VoiceConfig("en-US-standard-a", "en-US", "NEUTRAL", 0.5f, 0.0f, 0.0f); 
        String text = "This is a test sentence with several words";
        SynthesisResult fastResult = engine.synthesize(text, fast, AudioEncoding.PCM_16BIT); 
        SynthesisResult slowResult = engine.synthesize(text, slow, AudioEncoding.PCM_16BIT); 
        assertThat(fastResult.duration()).isLessThan(slowResult.duration()); 
    }

    @Test
    @DisplayName("pitch and volume settings do not cause exceptions")
    void pitchAndVolumeAccepted() { 
        VoiceConfig voice = new VoiceConfig("en-US-standard-a", "en-US", "NEUTRAL", 1.0f, 2.0f, -3.0f); 
        assertThatCode(() -> engine.synthesize("Test pitch and volume", voice, AudioEncoding.PCM_16BIT)) 
                .doesNotThrowAnyException(); 
    }

    // ── Synthesis quality attributes ──────────────────────────────────────────

    @Test
    @DisplayName("sample rate is positive")
    void sampleRateIsPositive() { 
        SynthesisResult result = engine.synthesize("Sample rate check", VoiceConfig.defaults(), AudioEncoding.PCM_16BIT); 
        assertThat(result.sampleRateHz()).isGreaterThan(0); 
    }

    @Test
    @DisplayName("processing time is non-negative")
    void processingTimeIsNonNegative() { 
        SynthesisResult result = engine.synthesize("Processing time", VoiceConfig.defaults(), AudioEncoding.PCM_16BIT); 
        assertThat(result.processingSeconds()).isGreaterThanOrEqualTo(0.0); 
    }

    @Test
    @DisplayName("longer text produces longer audio duration")
    void longerTextHasLongerDuration() { 
        String longText = "The quick brown fox jumps over the lazy dog. " .repeat(10); 
        String shortText = "Hello world";
        SynthesisResult longResult = engine.synthesize(longText, VoiceConfig.defaults(), AudioEncoding.PCM_16BIT); 
        SynthesisResult shortResult = engine.synthesize(shortText, VoiceConfig.defaults(), AudioEncoding.PCM_16BIT); 
        assertThat(longResult.duration()).isGreaterThan(shortResult.duration()); 
    }

    // ── Error handling ────────────────────────────────────────────────────────

    @Test
    @DisplayName("null text throws SynthesisException")
    void nullTextThrows() { 
        assertThatThrownBy(() -> engine.synthesize(null, VoiceConfig.defaults(), AudioEncoding.PCM_16BIT)) 
                .isInstanceOf(TtsSynthesisEngine.SynthesisException.class); 
    }

    @Test
    @DisplayName("blank text throws SynthesisException")
    void blankTextThrows() { 
        assertThatThrownBy(() -> engine.synthesize("   ", VoiceConfig.defaults(), AudioEncoding.PCM_16BIT)) 
                .isInstanceOf(TtsSynthesisEngine.SynthesisException.class); 
    }

    @Test
    @DisplayName("unsupported voice ID throws SynthesisException")
    void unsupportedVoiceThrows() { 
        VoiceConfig unknown = new VoiceConfig("xx-XX-unknown", "xx-XX", "NEUTRAL", 1.0f, 0.0f, 0.0f); 
        assertThatThrownBy(() -> engine.synthesize("Hello", unknown, AudioEncoding.PCM_16BIT)) 
                .isInstanceOf(TtsSynthesisEngine.SynthesisException.class) 
                .hasMessageContaining("Unsupported voice");
    }

    // ── Engine metadata ───────────────────────────────────────────────────────

    @Test
    @DisplayName("engine reports correct model ID")
    void engineModelId() { 
        assertThat(engine.getModelId()).isEqualTo("tts-v2");
    }

    @Test
    @DisplayName("engine reports supported voice IDs")
    void engineSupportedVoices() { 
        assertThat(engine.getSupportedVoiceIds()).containsAll(VOICES); 
    }
}
