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
    @DisplayName("default voice returns NOT_ADMITTED without a synthesis result or audio")
    void defaultVoiceReturnsNoAudioWithoutProvider() {
        VoiceConfig voice = VoiceConfig.defaults(); 
        assertNotAdmitted(() -> engine.synthesize("Hello world", voice, AudioEncoding.PCM_16BIT));
    }

    @Test
    @DisplayName("voice metadata is not returned when synthesis is NOT_ADMITTED")
    void voiceMetadataIsNotReturnedWithoutProvider() {
        VoiceConfig voice = VoiceConfig.defaults(); 
        assertNotAdmitted(() -> engine.synthesize("Test input", voice, AudioEncoding.PCM_16BIT));
    }

    // ── Multiple voices ───────────────────────────────────────────────────────

    @ParameterizedTest(name = "voice={0}") 
    @EnumSource(AudioEncoding.class) 
    @DisplayName("all requested encodings remain NOT_ADMITTED without a provider")
    void allEncodingsRemainNotAdmitted(AudioEncoding encoding) {
        assertNotAdmitted(() -> engine.synthesize("Test", VoiceConfig.defaults(), encoding));
    }

    @Test
    @DisplayName("second voice returns NOT_ADMITTED without audio")
    void secondVoiceReturnsNoAudioWithoutProvider() {
        VoiceConfig voice = new VoiceConfig("en-US-standard-b", "en-US", "MALE", 1.0f, 0.0f, 0.0f); 
        assertNotAdmitted(() -> engine.synthesize("Hello again", voice, AudioEncoding.PCM_16BIT));
    }

    @Test
    @DisplayName("French voice returns NOT_ADMITTED without audio")
    void frenchVoiceReturnsNoAudioWithoutProvider() {
        VoiceConfig voice = new VoiceConfig("fr-FR-standard-a", "fr-FR", "FEMALE", 1.0f, 0.0f, 0.0f); 
        assertNotAdmitted(() -> engine.synthesize("Bonjour le monde", voice, AudioEncoding.OPUS));
    }

    // ── SSML synthesis ────────────────────────────────────────────────────────

    @Test
    @DisplayName("SSML break request returns NOT_ADMITTED without audio")
    void ssmlBreakReturnsNoAudioWithoutProvider() {
        String ssml = "<speak>Hello <break time=\"500ms\"/> world.</speak>";
        assertNotAdmitted(() -> engine.synthesize(ssml, VoiceConfig.defaults(), AudioEncoding.PCM_16BIT));
    }

    @Test
    @DisplayName("SSML prosody request returns NOT_ADMITTED without audio")
    void ssmlProsodyReturnsNoAudioWithoutProvider() {
        String ssml = "<speak><prosody rate=\"slow\">Test text to speak.</prosody></speak>";
        assertNotAdmitted(() -> engine.synthesize(ssml, VoiceConfig.defaults(), AudioEncoding.MP3));
    }

    @Test
    @DisplayName("SSML emphasis request returns NOT_ADMITTED without audio")
    void ssmlEmphasisReturnsNoAudioWithoutProvider() {
        String ssml = "<speak>This is <emphasis level=\"strong\">important</emphasis>.</speak>";
        assertNotAdmitted(() -> engine.synthesize(ssml, VoiceConfig.defaults(), AudioEncoding.PCM_16BIT));
    }

    // ── Prosody control ───────────────────────────────────────────────────────

    @Test
    @DisplayName("non-neutral rates return NOT_ADMITTED without duration output")
    void nonNeutralRatesReturnNoDurationWithoutProvider() {
        VoiceConfig fast = new VoiceConfig("en-US-standard-a", "en-US", "NEUTRAL", 2.0f, 0.0f, 0.0f); 
        VoiceConfig slow = new VoiceConfig("en-US-standard-a", "en-US", "NEUTRAL", 0.5f, 0.0f, 0.0f); 
        String text = "This is a test sentence with several words";
        assertNotAdmitted(() -> engine.synthesize(text, fast, AudioEncoding.PCM_16BIT));
        assertNotAdmitted(() -> engine.synthesize(text, slow, AudioEncoding.PCM_16BIT));
    }

    @Test
    @DisplayName("non-neutral pitch and volume return NOT_ADMITTED without output")
    void nonNeutralPitchAndVolumeReturnNoOutputWithoutProvider() {
        VoiceConfig voice = new VoiceConfig("en-US-standard-a", "en-US", "NEUTRAL", 1.0f, 2.0f, -3.0f); 
        assertNotAdmitted(() -> engine.synthesize("Test pitch and volume", voice, AudioEncoding.PCM_16BIT));
    }

    // ── Synthesis quality attributes ──────────────────────────────────────────

    @Test
    @DisplayName("sample rate metadata is unavailable without synthesis output")
    void sampleRateMetadataUnavailableWithoutProvider() {
        assertNotAdmitted(() -> engine.synthesize("Sample rate check", VoiceConfig.defaults(), AudioEncoding.PCM_16BIT));
    }

    @Test
    @DisplayName("processing time metadata is unavailable without synthesis output")
    void processingTimeMetadataUnavailableWithoutProvider() {
        assertNotAdmitted(() -> engine.synthesize("Processing time", VoiceConfig.defaults(), AudioEncoding.PCM_16BIT));
    }

    @Test
    @DisplayName("text duration comparison is unavailable without synthesis output")
    void textDurationComparisonUnavailableWithoutProvider() {
        String longText = "The quick brown fox jumps over the lazy dog. " .repeat(10); 
        String shortText = "Hello world";
        assertNotAdmitted(() -> engine.synthesize(longText, VoiceConfig.defaults(), AudioEncoding.PCM_16BIT));
        assertNotAdmitted(() -> engine.synthesize(shortText, VoiceConfig.defaults(), AudioEncoding.PCM_16BIT));
    }

    // ── Error handling ────────────────────────────────────────────────────────

    @Test
    @DisplayName("NOT_ADMITTED is thrown instead of returning fabricated audio")
    void noSynthesisResultOrAudioIsReturnedWithoutProvider() {
        assertThatThrownBy(() -> engine.synthesize("Hello world", VoiceConfig.defaults(), AudioEncoding.PCM_16BIT))
                .isInstanceOfSatisfying(SynthesisException.class, error ->
                        assertThat(error.reason()).isEqualTo(FailureReason.NOT_ADMITTED))
                .hasMessageContaining("NOT_ADMITTED");
    }

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
