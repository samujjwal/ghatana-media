package com.ghatana.tts.quality;

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
 * <p>Validates that synthesis quality attributes (duration estimates, audio payload 
 * size, SSML handling, prosody accuracy) remain stable across benchmark inputs.
 *
 * @doc.type    class
 * @doc.purpose Synthesis quality: benchmark dataset, prosody, SSML tags, long text
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
    @DisplayName("benchmark sentences produce non-empty audio")
    void benchmarkSentencesProduceAudio(String text) { 
        SynthesisResult result = engine.synthesize(text, defaultVoice, AudioEncoding.PCM_16BIT); 
        assertThat(result.audioContent()).isNotEmpty(); 
        assertThat(result.duration()).isPositive(); 
    }

    @Test
    @DisplayName("benchmark fixtures produce consistent audio size ratio")
    void shortLongRatioIsReasonable() { 
        String shortText = "Hi.";
        String longText = "This is a significantly longer piece of text that should produce a longer audio file.";
        SynthesisResult shortResult = engine.synthesize(shortText, defaultVoice, AudioEncoding.PCM_16BIT); 
        SynthesisResult longResult = engine.synthesize(longText, defaultVoice, AudioEncoding.PCM_16BIT); 
        assertThat(longResult.audioContent().length).isGreaterThan(shortResult.audioContent().length); 
    }

    // ── Prosody quality ───────────────────────────────────────────────────────

    @Test
    @DisplayName("speaking rate 2x produces shorter duration than 0.5x")
    void prosodySpeakingRateImpactsDuration() { 
        VoiceConfig fast = new VoiceConfig("en-US-standard-a", "en-US", "NEUTRAL", 2.0f, 0.0f, 0.0f); 
        VoiceConfig slow = new VoiceConfig("en-US-standard-a", "en-US", "NEUTRAL", 0.5f, 0.0f, 0.0f); 
        String text = "Prosody speaking rate test sentence used to measure duration delta";
        SynthesisResult fastResult = engine.synthesize(text, fast, AudioEncoding.PCM_16BIT); 
        SynthesisResult slowResult = engine.synthesize(text, slow, AudioEncoding.PCM_16BIT); 
        assertThat(fastResult.duration()).isLessThan(slowResult.duration()); 
    }

    @ParameterizedTest(name = "rate={0}") 
    @ValueSource(floats = {0.25f, 0.5f, 1.0f, 1.5f, 2.0f, 4.0f}) 
    @DisplayName("all speaking rates produce valid audio")
    void allSpeakingRatesProduceAudio(float rate) { 
        VoiceConfig voice = new VoiceConfig("en-US-standard-a", "en-US", "NEUTRAL", rate, 0.0f, 0.0f); 
        SynthesisResult result = engine.synthesize("Rate test", voice, AudioEncoding.PCM_16BIT); 
        assertThat(result.audioContent()).isNotEmpty(); 
    }

    @Test
    @DisplayName("pitch variation does not cause synthesis failure")
    void pitchVariationIsSafe() { 
        for (float pitch : new float[]{-20.0f, -5.0f, 0.0f, 5.0f, 20.0f}) { 
            VoiceConfig voice = new VoiceConfig("en-US-standard-a", "en-US", "NEUTRAL", 1.0f, pitch, 0.0f); 
            assertThatCode(() -> engine.synthesize("Pitch test", voice, AudioEncoding.PCM_16BIT)) 
                    .doesNotThrowAnyException(); 
        }
    }

    // ── SSML tag handling ─────────────────────────────────────────────────────

    @Test
    @DisplayName("SSML break tag produces non-empty audio")
    void ssmlBreakProducesAudio() { 
        String ssml = "<speak>Hello.<break time=\"300ms\"/>Goodbye.</speak>";
        SynthesisResult result = engine.synthesize(ssml, defaultVoice, AudioEncoding.PCM_16BIT); 
        assertThat(result.audioContent()).isNotEmpty(); 
    }

    @Test
    @DisplayName("SSML prosody tags are processed without error")
    void ssmlProsodyTags() { 
        String ssml = "<speak><prosody rate=\"slow\" pitch=\"+5st\">Slow and high pitch.</prosody></speak>";
        assertThatCode(() -> engine.synthesize(ssml, defaultVoice, AudioEncoding.PCM_16BIT)) 
                .doesNotThrowAnyException(); 
    }

    @Test
    @DisplayName("SSML sub (pronunciation substitution) is accepted")
    void ssmlSubAccepted() { 
        String ssml = "<speak><sub alias=\"World Wide Web Consortium\">W3C</sub></speak>";
        assertThatCode(() -> engine.synthesize(ssml, defaultVoice, AudioEncoding.PCM_16BIT)) 
                .doesNotThrowAnyException(); 
    }

    @Test
    @DisplayName("SSML phoneme tag is accepted")
    void ssmlPhonemeAccepted() { 
        String ssml = "<speak>Say <phoneme alphabet=\"ipa\" ph=\"pɪˈkɑːn\">pecan</phoneme>.</speak>";
        assertThatCode(() -> engine.synthesize(ssml, defaultVoice, AudioEncoding.PCM_16BIT)) 
                .doesNotThrowAnyException(); 
    }

    @Test
    @DisplayName("nested SSML tags are accepted")
    void nestedSsmlTagsAccepted() { 
        String ssml = "<speak><prosody rate=\"fast\"><emphasis level=\"moderate\">Fast and notable.</emphasis></prosody></speak>";
        assertThatCode(() -> engine.synthesize(ssml, defaultVoice, AudioEncoding.PCM_16BIT)) 
                .doesNotThrowAnyException(); 
    }

    // ── Long text handling ────────────────────────────────────────────────────

    @ParameterizedTest(name = "repetitions={0}") 
    @ValueSource(ints = {1, 5, 20, 50}) 
    @DisplayName("long text of varying size completes without error")
    void longTextCompletesWithoutError(int repetitions) { 
        String base = "The quick brown fox jumps over the lazy dog. ";
        String text = base.repeat(repetitions); 
        assertThatCode(() -> engine.synthesize(text, defaultVoice, AudioEncoding.PCM_16BIT)) 
                .doesNotThrowAnyException(); 
    }

    @Test
    @DisplayName("200-word text produces audio longer than 200ms")
    void twoHundredWordsExceedsMinDuration() { 
        String text = ("word ").repeat(200).strip();
        SynthesisResult result = engine.synthesize(text, defaultVoice, AudioEncoding.PCM_16BIT); 
        assertThat(result.duration().toMillis()).isGreaterThan(200); 
    }

    // ── Output encoding ───────────────────────────────────────────────────────

    @ParameterizedTest(name = "encoding={0}") 
    @EnumSource(value = AudioEncoding.class, names = {"PCM_16BIT", "OPUS", "MP3"}) 
    @DisplayName("encoding type is preserved in synthesis result")
    void encodingPreservedInResult(AudioEncoding encoding) { 
        SynthesisResult result = engine.synthesize("Encoding test", defaultVoice, encoding); 
        assertThat(result.encoding()).isEqualTo(encoding); 
    }
}
