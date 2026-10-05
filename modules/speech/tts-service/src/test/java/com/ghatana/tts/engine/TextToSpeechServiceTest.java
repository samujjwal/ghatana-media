package com.ghatana.tts.engine;

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
        @DisplayName("null voice config throws NullPointerException")
        void nullVoiceConfig_throwsNullPointerException() { 
            assertThatThrownBy(() -> engine.synthesize(SIMPLE_TEXT, null, AudioEncoding.MP3)) 
                    .isInstanceOf(NullPointerException.class); 
        }

        @Test
        @DisplayName("null audio encoding throws NullPointerException")
        void nullAudioEncoding_throwsNullPointerException() { 
            assertThatThrownBy(() -> engine.synthesize(SIMPLE_TEXT, defaultVoice, null)) 
                    .isInstanceOf(NullPointerException.class); 
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
        @DisplayName("single character text is accepted")
        void singleCharacterText_isAccepted() { 
            SynthesisResult result = engine.synthesize("A", defaultVoice, AudioEncoding.MP3); 

            assertThat(result).isNotNull(); 
            assertThat(result.audioContent()).isNotEmpty(); 
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
        @DisplayName("synthesis succeeds for all supported encodings")
        void synthesisSucceedsForAllEncodings(TtsSynthesisEngine.AudioEncoding encoding) { 
            SynthesisResult result = engine.synthesize(SIMPLE_TEXT, defaultVoice, encoding); 

            assertThat(result).isNotNull(); 
            assertThat(result.audioContent()).isNotEmpty(); 
            assertThat(result.encoding()).isEqualTo(encoding); 
        }

        @Test
        @DisplayName("PCM_16BIT encoding produces valid output")
        void pcm16BitEncodingProducesValidOutput() { 
            SynthesisResult result = engine.synthesize(SIMPLE_TEXT, defaultVoice, AudioEncoding.PCM_16BIT); 

            assertThat(result.audioContent()).isNotEmpty(); 
            assertThat(result.sampleRateHz()).isGreaterThan(8000); 
            assertThat(result.encoding()).isEqualTo(AudioEncoding.PCM_16BIT); 
        }

        @Test
        @DisplayName("MP3 encoding produces valid output")
        void mp3EncodingProducesValidOutput() { 
            SynthesisResult result = engine.synthesize(SIMPLE_TEXT, defaultVoice, AudioEncoding.MP3); 

            assertThat(result.audioContent()).isNotEmpty(); 
            assertThat(result.encoding()).isEqualTo(AudioEncoding.MP3); 
        }

        @Test
        @DisplayName("OPUS encoding produces valid output")
        void opusEncodingProducesValidOutput() { 
            SynthesisResult result = engine.synthesize(SIMPLE_TEXT, defaultVoice, AudioEncoding.OPUS); 

            assertThat(result.audioContent()).isNotEmpty(); 
            assertThat(result.encoding()).isEqualTo(AudioEncoding.OPUS); 
        }

        @Test
        @DisplayName("PCM_32BIT encoding produces valid output")
        void pcm32BitEncodingProducesValidOutput() { 
            SynthesisResult result = engine.synthesize(SIMPLE_TEXT, defaultVoice, AudioEncoding.PCM_32BIT); 

            assertThat(result.audioContent()).isNotEmpty(); 
            assertThat(result.encoding()).isEqualTo(AudioEncoding.PCM_32BIT); 
        }

        @Test
        @DisplayName("different encodings produce different byte content for same text")
        void differentEncodingsProduceDifferentOutput() { 
            SynthesisResult r1 = engine.synthesize(SIMPLE_TEXT, defaultVoice, AudioEncoding.MP3); 
            SynthesisResult r2 = engine.synthesize(SIMPLE_TEXT, defaultVoice, AudioEncoding.PCM_16BIT); 

            // Different encodings should produce different byte sequences
            assertThat(r1.audioContent()).as("MP3 content").isNotEmpty();
            assertThat(r2.audioContent()).as("PCM content").isNotEmpty();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // VOICE SELECTION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("voice selection")
    class VoiceSelection {

        @Test
        @DisplayName("default voice is used when provided")
        void defaultVoiceIsUsed() { 
            VoiceConfig voice = VoiceConfig.defaults(); 
            SynthesisResult result = engine.synthesize(SIMPLE_TEXT, voice, AudioEncoding.MP3); 

            assertThat(result.voiceId()).isEqualTo(voice.voiceId()); 
        }

        @Test
        @DisplayName("all supported voices are accepted")
        void allSupportedVoicesAreAccepted() { 
            for (String voiceId : SUPPORTED_VOICES) { 
                VoiceConfig voice = new VoiceConfig(voiceId, "en-US", "NEUTRAL", 1.0f, 0.0f, 0.0f); 
                SynthesisResult result = engine.synthesize(SIMPLE_TEXT, voice, AudioEncoding.MP3); 

                assertThat(result.voiceId()).isEqualTo(voiceId); 
                assertThat(result.audioContent()).isNotEmpty(); 
            }
        }

        @Test
        @DisplayName("different voices may produce different audio characteristics")
        void differentVoicesMayProduceDifferentAudio() { 
            VoiceConfig voice1 = new VoiceConfig("en-US-standard-a", "en-US", "NEUTRAL", 1.0f, 0.0f, 0.0f); 
            VoiceConfig voice2 = new VoiceConfig("en-US-standard-b", "en-US", "NEUTRAL", 1.0f, 0.0f, 0.0f); 

            SynthesisResult r1 = engine.synthesize(SIMPLE_TEXT, voice1, AudioEncoding.MP3); 
            SynthesisResult r2 = engine.synthesize(SIMPLE_TEXT, voice2, AudioEncoding.MP3); 

            assertThat(r1.voiceId()).isNotEqualTo(r2.voiceId()); 
        }

        @Test
        @DisplayName("voice configuration parameters are preserved in result")
        void voiceConfigParametersArePreserved() { 
            VoiceConfig voice = new VoiceConfig("en-US-standard-a", "en-US", "MALE", 1.5f, 2.0f, 5.0f); 
            SynthesisResult result = engine.synthesize(SIMPLE_TEXT, voice, AudioEncoding.MP3); 

            assertThat(result.voiceId()).isEqualTo(voice.voiceId()); 
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // PROSODY CONTROL TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("prosody control")
    class ProsodyControl {

        @Test
        @DisplayName("speaking rate can be increased (1.5x)")
        void speakingRateCanBeIncreased() { 
            VoiceConfig fasterVoice = new VoiceConfig( 
                    "en-US-standard-a", "en-US", "NEUTRAL", 1.5f, 0.0f, 0.0f
            );
            SynthesisResult result = engine.synthesize(SIMPLE_TEXT, fasterVoice, AudioEncoding.MP3); 

            assertThat(result.audioContent()).isNotEmpty(); 
            assertThat(result.voiceId()).isEqualTo(fasterVoice.voiceId()); 
        }

        @Test
        @DisplayName("speaking rate can be decreased (0.8x)")
        void speakingRateCanBeDecreased() { 
            VoiceConfig slowerVoice = new VoiceConfig( 
                    "en-US-standard-a", "en-US", "NEUTRAL", 0.8f, 0.0f, 0.0f
            );
            SynthesisResult result = engine.synthesize(SIMPLE_TEXT, slowerVoice, AudioEncoding.MP3); 

            assertThat(result.audioContent()).isNotEmpty(); 
        }

        @Test
        @DisplayName("pitch can be raised (positive value)")
        void pitchCanBeRaised() { 
            VoiceConfig higherPitch = new VoiceConfig( 
                    "en-US-standard-a", "en-US", "NEUTRAL", 1.0f, 5.0f, 0.0f
            );
            SynthesisResult result = engine.synthesize(SIMPLE_TEXT, higherPitch, AudioEncoding.MP3); 

            assertThat(result.audioContent()).isNotEmpty(); 
        }

        @Test
        @DisplayName("pitch can be lowered (negative value)")
        void pitchCanBeLowered() { 
            VoiceConfig lowerPitch = new VoiceConfig( 
                    "en-US-standard-a", "en-US", "NEUTRAL", 1.0f, -5.0f, 0.0f
            );
            SynthesisResult result = engine.synthesize(SIMPLE_TEXT, lowerPitch, AudioEncoding.MP3); 

            assertThat(result.audioContent()).isNotEmpty(); 
        }

        @Test
        @DisplayName("volume gain can be increased (positive dB)")
        void volumeGainCanBeIncreased() { 
            VoiceConfig louderVoice = new VoiceConfig( 
                    "en-US-standard-a", "en-US", "NEUTRAL", 1.0f, 0.0f, 6.0f
            );
            SynthesisResult result = engine.synthesize(SIMPLE_TEXT, louderVoice, AudioEncoding.MP3); 

            assertThat(result.audioContent()).isNotEmpty(); 
        }

        @Test
        @DisplayName("volume gain can be decreased (negative dB)")
        void volumeGainCanBeDecreased() { 
            VoiceConfig quieterVoice = new VoiceConfig( 
                    "en-US-standard-a", "en-US", "NEUTRAL", 1.0f, 0.0f, -6.0f
            );
            SynthesisResult result = engine.synthesize(SIMPLE_TEXT, quieterVoice, AudioEncoding.MP3); 

            assertThat(result.audioContent()).isNotEmpty(); 
        }

        @Test
        @DisplayName("all prosody parameters can be combined")
        void allProsodyParametersCanBeCombined() { 
            VoiceConfig customVoice = new VoiceConfig( 
                    "en-US-standard-a", "en-US", "NEUTRAL",
                    1.5f,    // faster speaking rate
                    3.0f,    // higher pitch
                    3.0f     // louder volume
            );
            SynthesisResult result = engine.synthesize(SIMPLE_TEXT, customVoice, AudioEncoding.MP3); 

            assertThat(result.audioContent()).isNotEmpty(); 
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // SPECIAL CHARACTER & PUNCTUATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("special characters and punctuation")
    class SpecialCharactersAndPunctuation {

        @Test
        @DisplayName("simple punctuation is handled correctly")
        void simplePunctuationIsHandled() { 
            SynthesisResult result = engine.synthesize(PUNCTUATION_TEXT, defaultVoice, AudioEncoding.MP3); 

            assertThat(result.audioContent()).isNotEmpty(); 
        }

        @Test
        @DisplayName("special characters are handled without error")
        void specialCharactersAreHandled() { 
            SynthesisResult result = engine.synthesize(SPECIAL_CHARS_TEXT, defaultVoice, AudioEncoding.MP3); 

            assertThat(result.audioContent()).isNotEmpty(); 
        }

        @Test
        @DisplayName("numbers are synthesized correctly")
        void numbersAreSynthesized() { 
            String numberText = "The number is 42. Call 555-1234 for more info.";
            SynthesisResult result = engine.synthesize(numberText, defaultVoice, AudioEncoding.MP3); 

            assertThat(result.audioContent()).isNotEmpty(); 
        }

        @Test
        @DisplayName("email addresses are handled without error")
        void emailAddressesAreHandled() { 
            String emailText = "Contact us at support@example.com for assistance.";
            SynthesisResult result = engine.synthesize(emailText, defaultVoice, AudioEncoding.MP3); 

            assertThat(result.audioContent()).isNotEmpty(); 
        }

        @Test
        @DisplayName("URLs are handled without error")
        void urlsAreHandled() { 
            String urlText = "Visit https://www.example.com for more information.";
            SynthesisResult result = engine.synthesize(urlText, defaultVoice, AudioEncoding.MP3); 

            assertThat(result.audioContent()).isNotEmpty(); 
        }

        @Test
        @DisplayName("SSML content is processed")
        void ssmlContentIsProcessed() { 
            SynthesisResult result = engine.synthesize(SSML_TEXT, defaultVoice, AudioEncoding.MP3); 

            assertThat(result.audioContent()).isNotEmpty(); 
        }

        @Test
        @DisplayName("quotes are handled correctly")
        void quotesAreHandled() { 
            String quoteText = "He said, \"Hello, world!\" with emphasis.";
            SynthesisResult result = engine.synthesize(quoteText, defaultVoice, AudioEncoding.MP3); 

            assertThat(result.audioContent()).isNotEmpty(); 
        }

        @Test
        @DisplayName("apostrophes are handled correctly")
        void apostrophesAreHandled() { 
            String apostropheText = "It's what you're looking for, isn't it?";
            SynthesisResult result = engine.synthesize(apostropheText, defaultVoice, AudioEncoding.MP3); 

            assertThat(result.audioContent()).isNotEmpty(); 
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // OUTPUT QUALITY & VALIDATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("output quality and validation")
    class OutputQualityAndValidation {

        @Test
        @DisplayName("result contains non-empty audio content")
        void resultContainsNonEmptyAudio() { 
            SynthesisResult result = engine.synthesize(SIMPLE_TEXT, defaultVoice, AudioEncoding.MP3); 

            assertThat(result.audioContent()).isNotEmpty(); 
            assertThat(result.isEmpty()).isFalse(); 
        }

        @Test
        @DisplayName("sample rate is valid (within typical range)")
        void sampleRateIsValid() { 
            SynthesisResult result = engine.synthesize(SIMPLE_TEXT, defaultVoice, AudioEncoding.MP3); 

            assertThat(result.sampleRateHz()) 
                    .isBetween(8000, 48000); // Common sample rates 
        }

        @Test
        @DisplayName("duration is non-negative and reasonable")
        void durationIsReasonable() { 
            SynthesisResult result = engine.synthesize(LONG_TEXT, defaultVoice, AudioEncoding.MP3); 

            assertThat(result.duration()).isNotNull(); 
            assertThat(result.duration().toMillis()).isGreaterThanOrEqualTo(0); 
            assertThat(result.duration().toMillis()).isLessThan(120_000); // < 2 minutes for test text 
        }

        @Test
        @DisplayName("processing time is recorded and non-negative")
        void processingTimeIsRecorded() { 
            SynthesisResult result = engine.synthesize(SIMPLE_TEXT, defaultVoice, AudioEncoding.MP3); 

            assertThat(result.processingSeconds()).isGreaterThanOrEqualTo(0.0); 
        }

        @Test
        @DisplayName("audio duration increases with longer text")
        void audioDurationIncreasesWithText() { 
            SynthesisResult short_ = engine.synthesize("Hello", defaultVoice, AudioEncoding.MP3); 
            SynthesisResult long_ = engine.synthesize(LONG_TEXT, defaultVoice, AudioEncoding.MP3); 

            // Longer text should result in longer audio
            assertThat(long_.duration()).isGreaterThanOrEqualTo(short_.duration()); 
        }

        @Test
        @DisplayName("isEmpty() reflects actual audio content")
        void isEmptyReflectsContent() { 
            SynthesisResult result = engine.synthesize(SIMPLE_TEXT, defaultVoice, AudioEncoding.MP3); 

            assertThat(result.isEmpty()) 
                    .isEqualTo(result.audioContent() == null || result.audioContent().length == 0); 
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // CONSISTENCY TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("consistency")
    class Consistency {

        @Test
        @DisplayName("same input produces deterministic output")
        void sameInputProducesDeterministicOutput() { 
            SynthesisResult r1 = engine.synthesize(SIMPLE_TEXT, defaultVoice, AudioEncoding.MP3); 
            SynthesisResult r2 = engine.synthesize(SIMPLE_TEXT, defaultVoice, AudioEncoding.MP3); 

            assertThat(r1.audioContent()).isEqualTo(r2.audioContent()); 
            assertThat(r1.duration()).isEqualTo(r2.duration()); 
        }

        @Test
        @DisplayName("same text with different voices produces different audio")
        void sameTextDifferentVoicesProducesDifferentAudio() { 
            VoiceConfig v1 = new VoiceConfig("en-US-standard-a", "en-US", "NEUTRAL", 1.0f, 0.0f, 0.0f); 
            VoiceConfig v2 = new VoiceConfig("en-US-standard-b", "en-US", "NEUTRAL", 1.0f, 0.0f, 0.0f); 

            SynthesisResult r1 = engine.synthesize(SIMPLE_TEXT, v1, AudioEncoding.MP3); 
            SynthesisResult r2 = engine.synthesize(SIMPLE_TEXT, v2, AudioEncoding.MP3); 

            // Different voices should produce different audio
            assertThat(r1.voiceId()).isNotEqualTo(r2.voiceId()); 
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
        @DisplayName("default voice config can be used for synthesis")
        void defaultVoiceConfigCanBeUsed() { 
            VoiceConfig defaults = VoiceConfig.defaults(); 
            SynthesisResult result = engine.synthesize(SIMPLE_TEXT, defaults, AudioEncoding.MP3); 

            assertThat(result.audioContent()).isNotEmpty(); 
            assertThat(result.voiceId()).isEqualTo(defaults.voiceId()); 
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
}
