package com.ghatana.tts.quality;

import com.ghatana.tts.engine.TtsSynthesisEngine.FailureReason;
import com.ghatana.tts.engine.TtsSynthesisEngine.SynthesisException;

import com.ghatana.tts.engine.TtsSynthesisEngine;
import com.ghatana.tts.engine.TtsSynthesisEngine.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.Set;

import static org.assertj.core.api.Assertions.*;

/**
 * Synthesis quality regression tests for {@link TtsSynthesisEngine}.
 *
 * <p>Former deterministic-byte checks now verify fail-closed behavior only. They
 * are not model-quality evidence; real decodable speech remains unqualified.
 *
 * @doc.type    class
 * @doc.purpose Reject fabricated audio as model-quality evidence
 * @doc.layer   product
 * @doc.pattern Test
 */
@DisplayName("SynthesisQualityTest")
class SynthesisQualityTest {

    private static final Set<String> VOICES = Set.of( 
            "en-US-standard-a", "en-US-standard-b"
    );

    private TtsSynthesisEngine engine;
    private VoiceConfig defaultVoice;

    @BeforeEach
    void setUp() { 
        engine = new TtsSynthesisEngine("tts-quality-model", VOICES); 
        defaultVoice = VoiceConfig.defaults(); 
    }

    // ── Benchmark dataset ─────────────────────────────────────────────────────

    @ParameterizedTest(name = "text={0}") 
    @ValueSource(strings = { 
        "The quick brown fox jumps over the lazy dog.",
        "She sells sea shells by the sea shore.",
        "How much wood would a woodchuck chuck?",
        "Peter Piper picked a peck of pickled peppers."
    })
    @DisplayName("NOT_ADMITTED without real provider: benchmark Sentences Produce Audio")
    void benchmarkSentencesProduceAudio(String text) { 
        assertNotAdmitted(() -> engine.synthesize(text, defaultVoice, AudioEncoding.PCM_16BIT));
    }

    @Test
    @DisplayName("NOT_ADMITTED without real provider: short Long Ratio Is Reasonable")
    void shortLongRatioIsReasonable() { 
        String shortText = "Hi.";
        String longText = "This is a significantly longer piece of text that should produce a longer audio file.";
        assertNotAdmitted(() -> engine.synthesize(shortText, defaultVoice, AudioEncoding.PCM_16BIT));
        assertNotAdmitted(() -> engine.synthesize(longText, defaultVoice, AudioEncoding.PCM_16BIT));
    }

    // ── Prosody quality ───────────────────────────────────────────────────────

    @Test
    @DisplayName("NOT_ADMITTED without real provider: prosody Speaking Rate Impacts Duration")
    void prosodySpeakingRateImpactsDuration() { 
        VoiceConfig fast = new VoiceConfig("en-US-standard-a", "en-US", "NEUTRAL", 2.0f, 0.0f, 0.0f); 
        VoiceConfig slow = new VoiceConfig("en-US-standard-a", "en-US", "NEUTRAL", 0.5f, 0.0f, 0.0f); 
        String text = "Prosody speaking rate test sentence used to measure duration delta";
        assertNotAdmitted(() -> engine.synthesize(text, fast, AudioEncoding.PCM_16BIT));
        assertNotAdmitted(() -> engine.synthesize(text, slow, AudioEncoding.PCM_16BIT));
    }

    @ParameterizedTest(name = "rate={0}") 
    @ValueSource(floats = {0.25f, 0.5f, 1.0f, 1.5f, 2.0f, 4.0f}) 
    @DisplayName("NOT_ADMITTED without real provider: all Speaking Rates Produce Audio")
    void allSpeakingRatesProduceAudio(float rate) { 
        VoiceConfig voice = new VoiceConfig("en-US-standard-a", "en-US", "NEUTRAL", rate, 0.0f, 0.0f); 
        assertNotAdmitted(() -> engine.synthesize("Rate test", voice, AudioEncoding.PCM_16BIT));
    }

    @Test
    @DisplayName("NOT_ADMITTED without real provider: pitch Variation Is Safe")
    void pitchVariationIsSafe() { 
        for (float pitch : new float[]{-20.0f, -5.0f, 0.0f, 5.0f, 20.0f}) { 
            VoiceConfig voice = new VoiceConfig("en-US-standard-a", "en-US", "NEUTRAL", 1.0f, pitch, 0.0f); 
            assertNotAdmitted(() -> engine.synthesize("Pitch test", voice, AudioEncoding.PCM_16BIT));
        }
    }

    // ── SSML tag handling ─────────────────────────────────────────────────────

    @Test
    @DisplayName("NOT_ADMITTED without real provider: ssml Break Produces Audio")
    void ssmlBreakProducesAudio() { 
        String ssml = "<speak>Hello.<break time=\"300ms\"/>Goodbye.</speak>";
        assertNotAdmitted(() -> engine.synthesize(ssml, defaultVoice, AudioEncoding.PCM_16BIT));
    }

    @Test
    @DisplayName("NOT_ADMITTED without real provider: ssml Prosody Tags")
    void ssmlProsodyTags() { 
        String ssml = "<speak><prosody rate=\"slow\" pitch=\"+5st\">Slow and high pitch.</prosody></speak>";
        assertNotAdmitted(() -> engine.synthesize(ssml, defaultVoice, AudioEncoding.PCM_16BIT));
    }

    @Test
    @DisplayName("NOT_ADMITTED without real provider: ssml Sub Accepted")
    void ssmlSubAccepted() { 
        String ssml = "<speak><sub alias=\"World Wide Web Consortium\">W3C</sub></speak>";
        assertNotAdmitted(() -> engine.synthesize(ssml, defaultVoice, AudioEncoding.PCM_16BIT));
    }

    @Test
    @DisplayName("NOT_ADMITTED without real provider: ssml Phoneme Accepted")
    void ssmlPhonemeAccepted() { 
        String ssml = "<speak>Say <phoneme alphabet=\"ipa\" ph=\"pɪˈkɑːn\">pecan</phoneme>.</speak>";
        assertNotAdmitted(() -> engine.synthesize(ssml, defaultVoice, AudioEncoding.PCM_16BIT));
    }

    @Test
    @DisplayName("NOT_ADMITTED without real provider: nested Ssml Tags Accepted")
    void nestedSsmlTagsAccepted() { 
        String ssml = "<speak><prosody rate=\"fast\"><emphasis level=\"moderate\">Fast and notable.</emphasis></prosody></speak>";
        assertNotAdmitted(() -> engine.synthesize(ssml, defaultVoice, AudioEncoding.PCM_16BIT));
    }

    // ── Long text handling ────────────────────────────────────────────────────

    @ParameterizedTest(name = "repetitions={0}") 
    @ValueSource(ints = {1, 5, 20, 50}) 
    @DisplayName("NOT_ADMITTED without real provider: long Text Completes Without Error")
    void longTextCompletesWithoutError(int repetitions) { 
        String base = "The quick brown fox jumps over the lazy dog. ";
        String text = base.repeat(repetitions); 
        assertNotAdmitted(() -> engine.synthesize(text, defaultVoice, AudioEncoding.PCM_16BIT));
    }

    @Test
    @DisplayName("NOT_ADMITTED without real provider: two Hundred Words Exceeds Min Duration")
    void twoHundredWordsExceedsMinDuration() { 
        String text = ("word ").repeat(200).strip();
        assertNotAdmitted(() -> engine.synthesize(text, defaultVoice, AudioEncoding.PCM_16BIT));
    }

    // ── Output encoding ───────────────────────────────────────────────────────

    @ParameterizedTest(name = "encoding={0}") 
    @EnumSource(value = AudioEncoding.class, names = {"PCM_16BIT", "OPUS", "MP3"}) 
    @DisplayName("NOT_ADMITTED without real provider: encoding Preserved In Result")
    void encodingPreservedInResult(AudioEncoding encoding) { 
        assertNotAdmitted(() -> engine.synthesize("Encoding test", defaultVoice, encoding));
    }

    private static void assertNotAdmitted(Runnable request) {
        org.assertj.core.api.Assertions.assertThatThrownBy(request::run)
                .isInstanceOfSatisfying(SynthesisException.class, error ->
                        org.assertj.core.api.Assertions.assertThat(error.reason())
                                .isEqualTo(FailureReason.NOT_ADMITTED))
                .hasMessageContaining("NOT_ADMITTED");
    }
}
