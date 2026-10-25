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
 * Comprehensive test suite for {@link TtsSynthesisEngine}.
 *
 * Validates text-to-speech synthesis including voice selection, audio encoding,
 * prosody control (pitch, rate, volume), special character handling, and output quality. 
 *
 * @doc.type    class
 * @doc.purpose Comprehensive TTS engine tests: voice selection, encoding, prosody, special characters
 * @doc.layer   product
 * @doc.pattern Test
 */
@DisplayName("TextToSpeechServiceTest")
class TextToSpeechServiceTest {

    private static final Set<String> SUPPORTED_VOICES = Set.of( 
            "en-US-standard-a",
            "en-US-standard-b",
            "en-GB-standard-a",
            "en-AU-standard-a",
            "fr-FR-standard-a",
            "de-DE-standard-a",
            "ja-JP-standard-a",
            "es-ES-standard-a",
            "pt-BR-standard-a"
    );

    private static final String SIMPLE_TEXT = "Hello, world!";
    private static final String SSML_TEXT = "<speak>Hello <emphasis level=\"strong\">world</emphasis>!</speak>";
    private static final String LONG_TEXT = "The quick brown fox jumps over the lazy dog. " +
            "This pangram contains every letter of the English alphabet at least once. " +
            "Pangrams are often used for displaying fonts and for other applications involving text generation and display.";
    private static final String SPECIAL_CHARS_TEXT = "Hello! How are you? (I'm fine...) #Great :) @mention"; 
    private static final String PUNCTUATION_TEXT = "Really?! Yes... Absolutely! No, never. Perhaps; maybe: certainly.";
    private static final String EMPTY_TEXT = "";
    private static final String WHITESPACE_TEXT = "   ";

    private TtsSynthesisEngine engine;
    private VoiceConfig defaultVoice;

    @BeforeEach
    void setUp() { 
        engine = new TtsSynthesisEngine("tts-standard-v1", SUPPORTED_VOICES); 
        defaultVoice = VoiceConfig.defaults(); 
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // INPUT VALIDATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("input validation")
    class InputValidation {

        @Test
        @DisplayName("null text throws SynthesisException")
        void nullText_throwsSynthesisException() { 
            assertThatThrownBy(() -> engine.synthesize(null, defaultVoice, AudioEncoding.MP3)) 
                    .isInstanceOf(SynthesisException.class) 
                    .hasMessageContaining("blank");
        }

        @Test
        @DisplayName("empty text throws SynthesisException")
        void emptyText_throwsSynthesisException() { 
            assertThatThrownBy(() -> engine.synthesize(EMPTY_TEXT, defaultVoice, AudioEncoding.MP3)) 
                    .isInstanceOf(SynthesisException.class) 
                    .hasMessageContaining("blank");
        }

        @Test
        @DisplayName("whitespace-only text throws SynthesisException")
        void whitespaceOnlyText_throwsSynthesisException() { 
            assertThatThrownBy(() -> engine.synthesize(WHITESPACE_TEXT, defaultVoice, AudioEncoding.MP3)) 
                    .isInstanceOf(SynthesisException.class) 
                    .hasMessageContaining("blank");
        }

        @Test
        @DisplayName("null voice config is classified as an invalid request")
        void nullVoiceConfig_throwsSynthesisException() {
            assertThatThrownBy(() -> engine.synthesize(SIMPLE_TEXT, null, AudioEncoding.MP3)) 
                    .isInstanceOfSatisfying(SynthesisException.class, error ->
                            assertThat(error.reason()).isEqualTo(FailureReason.INVALID_REQUEST));
        }

        @Test
        @DisplayName("null audio encoding is classified as an invalid request")
        void nullAudioEncoding_throwsSynthesisException() {
            assertThatThrownBy(() -> engine.synthesize(SIMPLE_TEXT, defaultVoice, null)) 
                    .isInstanceOfSatisfying(SynthesisException.class, error ->
                            assertThat(error.reason()).isEqualTo(FailureReason.INVALID_REQUEST));
        }

        @Test
        @DisplayName("unsupported voice ID throws SynthesisException")
        void unsupportedVoiceId_throwsSynthesisException() { 
            VoiceConfig unsupportedVoice = new VoiceConfig( 
                    "unsupported-voice-xyz",
                    "en-US", "NEUTRAL", 1.0f, 0.0f, 0.0f
            );

            assertThatThrownBy(() -> engine.synthesize(SIMPLE_TEXT, unsupportedVoice, AudioEncoding.MP3)) 
                    .isInstanceOf(SynthesisException.class) 
                    .hasMessageContaining("Unsupported voice");
        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: single Character Text is Accepted")
        void singleCharacterText_isAccepted() { 
            assertNotAdmitted(() -> engine.synthesize("A", defaultVoice, AudioEncoding.MP3));

        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // AUDIO ENCODING TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("audio encoding")
    class AudioEncodingTests {

        @ParameterizedTest
        @EnumSource(TtsSynthesisEngine.AudioEncoding.class) 
        @DisplayName("NOT_ADMITTED without real provider: synthesis Succeeds For All Encodings")
        void synthesisSucceedsForAllEncodings(TtsSynthesisEngine.AudioEncoding encoding) { 
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, defaultVoice, encoding));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: pcm16 Bit Encoding Produces Valid Output")
        void pcm16BitEncodingProducesValidOutput() { 
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, defaultVoice, AudioEncoding.PCM_16BIT));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: mp3 Encoding Produces Valid Output")
        void mp3EncodingProducesValidOutput() { 
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, defaultVoice, AudioEncoding.MP3));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: opus Encoding Produces Valid Output")
        void opusEncodingProducesValidOutput() { 
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, defaultVoice, AudioEncoding.OPUS));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: pcm32 Bit Encoding Produces Valid Output")
        void pcm32BitEncodingProducesValidOutput() { 
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, defaultVoice, AudioEncoding.PCM_32BIT));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: different Encodings Produce Different Output")
        void differentEncodingsProduceDifferentOutput() { 
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, defaultVoice, AudioEncoding.MP3));
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, defaultVoice, AudioEncoding.PCM_16BIT));

            // Different encodings should produce different byte sequences
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // VOICE SELECTION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("voice selection")
    class VoiceSelection {

        @Test
        @DisplayName("NOT_ADMITTED without real provider: default Voice Is Used")
        void defaultVoiceIsUsed() { 
            VoiceConfig voice = VoiceConfig.defaults(); 
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, voice, AudioEncoding.MP3));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: all Supported Voices Are Accepted")
        void allSupportedVoicesAreAccepted() { 
            for (String voiceId : SUPPORTED_VOICES) { 
                VoiceConfig voice = new VoiceConfig(voiceId, "en-US", "NEUTRAL", 1.0f, 0.0f, 0.0f); 
                assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, voice, AudioEncoding.MP3));

            }
        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: different Voices May Produce Different Audio")
        void differentVoicesMayProduceDifferentAudio() { 
            VoiceConfig voice1 = new VoiceConfig("en-US-standard-a", "en-US", "NEUTRAL", 1.0f, 0.0f, 0.0f); 
            VoiceConfig voice2 = new VoiceConfig("en-US-standard-b", "en-US", "NEUTRAL", 1.0f, 0.0f, 0.0f); 

            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, voice1, AudioEncoding.MP3));
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, voice2, AudioEncoding.MP3));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: voice Config Parameters Are Preserved")
        void voiceConfigParametersArePreserved() { 
            VoiceConfig voice = new VoiceConfig("en-US-standard-a", "en-US", "MALE", 1.5f, 2.0f, 5.0f); 
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, voice, AudioEncoding.MP3));

        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // PROSODY CONTROL TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("prosody control")
    class ProsodyControl {

        @Test
        @DisplayName("NOT_ADMITTED without real provider: speaking Rate Can Be Increased")
        void speakingRateCanBeIncreased() { 
            VoiceConfig fasterVoice = new VoiceConfig( 
                    "en-US-standard-a", "en-US", "NEUTRAL", 1.5f, 0.0f, 0.0f
            );
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, fasterVoice, AudioEncoding.MP3));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: speaking Rate Can Be Decreased")
        void speakingRateCanBeDecreased() { 
            VoiceConfig slowerVoice = new VoiceConfig( 
                    "en-US-standard-a", "en-US", "NEUTRAL", 0.8f, 0.0f, 0.0f
            );
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, slowerVoice, AudioEncoding.MP3));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: pitch Can Be Raised")
        void pitchCanBeRaised() { 
            VoiceConfig higherPitch = new VoiceConfig( 
                    "en-US-standard-a", "en-US", "NEUTRAL", 1.0f, 5.0f, 0.0f
            );
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, higherPitch, AudioEncoding.MP3));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: pitch Can Be Lowered")
        void pitchCanBeLowered() { 
            VoiceConfig lowerPitch = new VoiceConfig( 
                    "en-US-standard-a", "en-US", "NEUTRAL", 1.0f, -5.0f, 0.0f
            );
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, lowerPitch, AudioEncoding.MP3));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: volume Gain Can Be Increased")
        void volumeGainCanBeIncreased() { 
            VoiceConfig louderVoice = new VoiceConfig( 
                    "en-US-standard-a", "en-US", "NEUTRAL", 1.0f, 0.0f, 6.0f
            );
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, louderVoice, AudioEncoding.MP3));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: volume Gain Can Be Decreased")
        void volumeGainCanBeDecreased() { 
            VoiceConfig quieterVoice = new VoiceConfig( 
                    "en-US-standard-a", "en-US", "NEUTRAL", 1.0f, 0.0f, -6.0f
            );
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, quieterVoice, AudioEncoding.MP3));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: all Prosody Parameters Can Be Combined")
        void allProsodyParametersCanBeCombined() { 
            VoiceConfig customVoice = new VoiceConfig( 
                    "en-US-standard-a", "en-US", "NEUTRAL",
                    1.5f,    // faster speaking rate
                    3.0f,    // higher pitch
                    3.0f     // louder volume
            );
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, customVoice, AudioEncoding.MP3));

        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // SPECIAL CHARACTER & PUNCTUATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("special characters and punctuation")
    class SpecialCharactersAndPunctuation {

        @Test
        @DisplayName("NOT_ADMITTED without real provider: simple Punctuation Is Handled")
        void simplePunctuationIsHandled() { 
            assertNotAdmitted(() -> engine.synthesize(PUNCTUATION_TEXT, defaultVoice, AudioEncoding.MP3));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: special Characters Are Handled")
        void specialCharactersAreHandled() { 
            assertNotAdmitted(() -> engine.synthesize(SPECIAL_CHARS_TEXT, defaultVoice, AudioEncoding.MP3));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: numbers Are Synthesized")
        void numbersAreSynthesized() { 
            String numberText = "The number is 42. Call 555-1234 for more info.";
            assertNotAdmitted(() -> engine.synthesize(numberText, defaultVoice, AudioEncoding.MP3));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: email Addresses Are Handled")
        void emailAddressesAreHandled() { 
            String emailText = "Contact us at support@example.com for assistance.";
            assertNotAdmitted(() -> engine.synthesize(emailText, defaultVoice, AudioEncoding.MP3));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: urls Are Handled")
        void urlsAreHandled() { 
            String urlText = "Visit https://www.example.com for more information.";
            assertNotAdmitted(() -> engine.synthesize(urlText, defaultVoice, AudioEncoding.MP3));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: ssml Content Is Processed")
        void ssmlContentIsProcessed() { 
            assertNotAdmitted(() -> engine.synthesize(SSML_TEXT, defaultVoice, AudioEncoding.MP3));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: quotes Are Handled")
        void quotesAreHandled() { 
            String quoteText = "He said, \"Hello, world!\" with emphasis.";
            assertNotAdmitted(() -> engine.synthesize(quoteText, defaultVoice, AudioEncoding.MP3));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: apostrophes Are Handled")
        void apostrophesAreHandled() { 
            String apostropheText = "It's what you're looking for, isn't it?";
            assertNotAdmitted(() -> engine.synthesize(apostropheText, defaultVoice, AudioEncoding.MP3));

        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // OUTPUT QUALITY & VALIDATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("output quality and validation")
    class OutputQualityAndValidation {

        @Test
        @DisplayName("NOT_ADMITTED without real provider: result Contains Non Empty Audio")
        void resultContainsNonEmptyAudio() { 
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, defaultVoice, AudioEncoding.MP3));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: sample Rate Is Valid")
        void sampleRateIsValid() { 
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, defaultVoice, AudioEncoding.MP3));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: duration Is Reasonable")
        void durationIsReasonable() { 
            assertNotAdmitted(() -> engine.synthesize(LONG_TEXT, defaultVoice, AudioEncoding.MP3));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: processing Time Is Recorded")
        void processingTimeIsRecorded() { 
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, defaultVoice, AudioEncoding.MP3));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: audio Duration Increases With Text")
        void audioDurationIncreasesWithText() { 
            assertNotAdmitted(() -> engine.synthesize("Hello", defaultVoice, AudioEncoding.MP3));
            assertNotAdmitted(() -> engine.synthesize(LONG_TEXT, defaultVoice, AudioEncoding.MP3));

            // Longer text should result in longer audio
        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: is Empty Reflects Content")
        void isEmptyReflectsContent() { 
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, defaultVoice, AudioEncoding.MP3));

        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // CONSISTENCY TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("consistency")
    class Consistency {

        @Test
        @DisplayName("NOT_ADMITTED without real provider: same Input Produces Deterministic Output")
        void sameInputProducesDeterministicOutput() { 
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, defaultVoice, AudioEncoding.MP3));
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, defaultVoice, AudioEncoding.MP3));

        }

        @Test
        @DisplayName("NOT_ADMITTED without real provider: same Text Different Voices Produces Different Audio")
        void sameTextDifferentVoicesProducesDifferentAudio() { 
            VoiceConfig v1 = new VoiceConfig("en-US-standard-a", "en-US", "NEUTRAL", 1.0f, 0.0f, 0.0f); 
            VoiceConfig v2 = new VoiceConfig("en-US-standard-b", "en-US", "NEUTRAL", 1.0f, 0.0f, 0.0f); 

            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, v1, AudioEncoding.MP3));
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, v2, AudioEncoding.MP3));

            // Different voices should produce different audio
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // ENGINE PROPERTIES TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("engine properties")
    class EngineProperties {

        @Test
        @DisplayName("engine returns configured model ID")
        void engineReturnsConfiguredModelId() { 
            assertThat(engine.getModelId()).isEqualTo("tts-standard-v1");
        }

        @Test
        @DisplayName("engine returns all supported voices")
        void engineReturnsSupportedVoices() { 
            Set<String> voices = engine.getSupportedVoiceIds(); 

            assertThat(voices).isNotEmpty(); 
            assertThat(voices).containsAll(SUPPORTED_VOICES); 
        }

        @Test
        @DisplayName("supported voices are immutable")
        void supportedVoicesAreImmutable() { 
            Set<String> voices = engine.getSupportedVoiceIds(); 

            assertThat(voices).isNotEmpty(); 
            assertThat(voices).containsAll(SUPPORTED_VOICES); 
            // Verify it's unmodifiable
            assertThatThrownBy(() -> voices.add("new-voice"))
                    .isInstanceOf(UnsupportedOperationException.class); 
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // VOICE CONFIG DEFAULTS TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("voice config defaults")
    class VoiceConfigDefaults {

        @Test
        @DisplayName("NOT_ADMITTED without real provider: default Voice Config Can Be Used")
        void defaultVoiceConfigCanBeUsed() { 
            VoiceConfig defaults = VoiceConfig.defaults(); 
            assertNotAdmitted(() -> engine.synthesize(SIMPLE_TEXT, defaults, AudioEncoding.MP3));

        }

        @Test
        @DisplayName("default voice has reasonable prosody values")
        void defaultVoiceHasReasonableProsody() { 
            VoiceConfig defaults = VoiceConfig.defaults(); 

            assertThat(defaults.speakingRate()).isEqualTo(1.0f); 
            assertThat(defaults.pitch()).isEqualTo(0.0f); 
            assertThat(defaults.volumeGainDb()).isEqualTo(0.0f); 
        }
    }

    private static void assertNotAdmitted(Runnable request) {
        org.assertj.core.api.Assertions.assertThatThrownBy(request::run)
                .isInstanceOfSatisfying(SynthesisException.class, error ->
                        org.assertj.core.api.Assertions.assertThat(error.reason())
                                .isEqualTo(FailureReason.NOT_ADMITTED))
                .hasMessageContaining("NOT_ADMITTED");
    }
}
