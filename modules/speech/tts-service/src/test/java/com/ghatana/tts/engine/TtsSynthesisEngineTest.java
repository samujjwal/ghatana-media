package com.ghatana.tts.engine;

import com.ghatana.tts.engine.TtsSynthesisEngine.FailureReason;
import com.ghatana.tts.engine.TtsSynthesisEngine.SynthesisException;

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
    @DisplayName("NOT_ADMITTED without real provider: synthesis Default Voice Produces Audio")
    void synthesisDefaultVoiceProducesAudio() { 
        VoiceConfig voice = VoiceConfig.defaults(); 
        assertNotAdmitted(() -> engine.synthesize("Hello world", voice, AudioEncoding.PCM_16BIT));
    }

    @Test
    @DisplayName("NOT_ADMITTED without real provider: synthesis Result Has Voice Id")
    void synthesisResultHasVoiceId() { 
        VoiceConfig voice = VoiceConfig.defaults(); 
        assertNotAdmitted(() -> engine.synthesize("Test input", voice, AudioEncoding.PCM_16BIT));
    }

    // ── Multiple voices ───────────────────────────────────────────────────────

    @ParameterizedTest(name = "voice={0}") 
    @EnumSource(AudioEncoding.class) 
    @DisplayName("NOT_ADMITTED without real provider: all Encodings Accepted")
    void allEncodingsAccepted(AudioEncoding encoding) { 
        assertNotAdmitted(() -> engine.synthesize("Test", VoiceConfig.defaults(), encoding));
    }

    @Test
    @DisplayName("NOT_ADMITTED without real provider: second Voice Produces Audio")
    void secondVoiceProducesAudio() { 
        VoiceConfig voice = new VoiceConfig("en-US-standard-b", "en-US", "MALE", 1.0f, 0.0f, 0.0f); 
        assertNotAdmitted(() -> engine.synthesize("Hello again", voice, AudioEncoding.PCM_16BIT));
    }

    @Test
    @DisplayName("NOT_ADMITTED without real provider: french Voice Produces Audio")
    void frenchVoiceProducesAudio() { 
        VoiceConfig voice = new VoiceConfig("fr-FR-standard-a", "fr-FR", "FEMALE", 1.0f, 0.0f, 0.0f); 
        assertNotAdmitted(() -> engine.synthesize("Bonjour le monde", voice, AudioEncoding.OPUS));
    }

    // ── SSML synthesis ────────────────────────────────────────────────────────

    @Test
    @DisplayName("NOT_ADMITTED without real provider: ssml Break Accepted")
    void ssmlBreakAccepted() { 
        String ssml = "<speak>Hello <break time=\"500ms\"/> world.</speak>";
        assertNotAdmitted(() -> engine.synthesize(ssml, VoiceConfig.defaults(), AudioEncoding.PCM_16BIT));
    }

    @Test
    @DisplayName("NOT_ADMITTED without real provider: ssml Prosody Accepted")
    void ssmlProsodyAccepted() { 
        String ssml = "<speak><prosody rate=\"slow\">Test text to speak.</prosody></speak>";
        assertNotAdmitted(() -> engine.synthesize(ssml, VoiceConfig.defaults(), AudioEncoding.MP3));
    }

    @Test
    @DisplayName("NOT_ADMITTED without real provider: ssml Emphasis Produces Audio")
    void ssmlEmphasisProducesAudio() { 
        String ssml = "<speak>This is <emphasis level=\"strong\">important</emphasis>.</speak>";
        assertNotAdmitted(() -> engine.synthesize(ssml, VoiceConfig.defaults(), AudioEncoding.PCM_16BIT));
    }

    // ── Prosody control ───────────────────────────────────────────────────────

    @Test
    @DisplayName("NOT_ADMITTED without real provider: faster Rate Shorts Duration")
    void fasterRateShortsDuration() { 
        VoiceConfig fast = new VoiceConfig("en-US-standard-a", "en-US", "NEUTRAL", 2.0f, 0.0f, 0.0f); 
        VoiceConfig slow = new VoiceConfig("en-US-standard-a", "en-US", "NEUTRAL", 0.5f, 0.0f, 0.0f); 
        String text = "This is a test sentence with several words";
        assertNotAdmitted(() -> engine.synthesize(text, fast, AudioEncoding.PCM_16BIT));
        assertNotAdmitted(() -> engine.synthesize(text, slow, AudioEncoding.PCM_16BIT));
    }

    @Test
    @DisplayName("NOT_ADMITTED without real provider: pitch And Volume Accepted")
    void pitchAndVolumeAccepted() { 
        VoiceConfig voice = new VoiceConfig("en-US-standard-a", "en-US", "NEUTRAL", 1.0f, 2.0f, -3.0f); 
        assertNotAdmitted(() -> engine.synthesize("Test pitch and volume", voice, AudioEncoding.PCM_16BIT));
    }

    // ── Synthesis quality attributes ──────────────────────────────────────────

    @Test
    @DisplayName("NOT_ADMITTED without real provider: sample Rate Is Positive")
    void sampleRateIsPositive() { 
        assertNotAdmitted(() -> engine.synthesize("Sample rate check", VoiceConfig.defaults(), AudioEncoding.PCM_16BIT));
    }

    @Test
    @DisplayName("NOT_ADMITTED without real provider: processing Time Is Non Negative")
    void processingTimeIsNonNegative() { 
        assertNotAdmitted(() -> engine.synthesize("Processing time", VoiceConfig.defaults(), AudioEncoding.PCM_16BIT));
    }

    @Test
    @DisplayName("NOT_ADMITTED without real provider: longer Text Has Longer Duration")
    void longerTextHasLongerDuration() { 
        String longText = "The quick brown fox jumps over the lazy dog. " .repeat(10); 
        String shortText = "Hello world";
        assertNotAdmitted(() -> engine.synthesize(longText, VoiceConfig.defaults(), AudioEncoding.PCM_16BIT));
        assertNotAdmitted(() -> engine.synthesize(shortText, VoiceConfig.defaults(), AudioEncoding.PCM_16BIT));
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

    private static void assertNotAdmitted(Runnable request) {
        org.assertj.core.api.Assertions.assertThatThrownBy(request::run)
                .isInstanceOfSatisfying(SynthesisException.class, error ->
                        org.assertj.core.api.Assertions.assertThat(error.reason())
                                .isEqualTo(FailureReason.NOT_ADMITTED))
                .hasMessageContaining("NOT_ADMITTED");
    }
}
