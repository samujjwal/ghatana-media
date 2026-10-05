package com.ghatana.tts.ssml;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;
import static org.assertj.core.api.Assertions.assertThatNullPointerException;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Unit tests for {@link SsmlProcessor} — AV-008.3.
 *
 * @doc.type class
 * @doc.purpose SSML compliance tests for the TTS SSML processor
 * @doc.layer product
 * @doc.pattern Test
 */
@DisplayName("SsmlProcessor")
class SsmlProcessorTest {

    private final SsmlProcessor processor = SsmlProcessor.create(); 

    // ─── parse: validation ────────────────────────────────────────────────────

    @Nested
    @DisplayName("parse() - validation")
    class ParseValidation {

        @Test
        @DisplayName("null ssml throws NullPointerException")
        void parse_null_throwsNPE() { 
            assertThatNullPointerException().isThrownBy(() -> processor.parse(null)); 
        }

        @Test
        @DisplayName("blank ssml throws IllegalArgumentException")
        void parse_blank_throwsIAE() { 
            assertThatIllegalArgumentException().isThrownBy(() -> processor.parse("   "));
        }

        @Test
        @DisplayName("missing <speak> root throws IllegalArgumentException")
        void parse_noSpeakRoot_throwsIAE() { 
            assertThatIllegalArgumentException() 
                    .isThrownBy(() -> processor.parse("<say>Hello</say>"))
                    .withMessageContaining("<speak>");
        }
    }

    // ─── parse: plain text ────────────────────────────────────────────────────

    @Nested
    @DisplayName("parse() - plain text")
    class ParsePlainText {

        @Test
        @DisplayName("plain text inside <speak> produces a single TEXT segment")
        void parse_plainText_singleTextSegment() { 
            List<SsmlProcessor.SsmlSegment> segments =
                    processor.parse("<speak>Hello world</speak>");
            assertThat(segments).hasSize(1); 
            assertThat(segments.get(0).type()) 
                    .isEqualTo(SsmlProcessor.SsmlSegment.SegmentType.TEXT); 
            assertThat(segments.get(0).text()).isEqualTo("Hello world");
        }

        @Test
        @DisplayName("empty speak element produces no segments")
        void parse_emptySpeak_noSegments() { 
            List<SsmlProcessor.SsmlSegment> segments =
                    processor.parse("<speak>   </speak>");
            assertThat(segments).isEmpty(); 
        }
    }

    // ─── parse: break tag ─────────────────────────────────────────────────────

    @Nested
    @DisplayName("parse() - <break>")
    class ParseBreak {

        @Test
        @DisplayName("break tag in ms unit produces PAUSE segment with correct duration")
        void parse_breakMs_pauseSegment() { 
            String ssml = "<speak>Hello<break time=\"500ms\"/>World</speak>";
            List<SsmlProcessor.SsmlSegment> segments = processor.parse(ssml); 

            long pauseCount = segments.stream() 
                    .filter(s -> s.type() == SsmlProcessor.SsmlSegment.SegmentType.PAUSE) 
                    .count(); 
            assertThat(pauseCount).isEqualTo(1); 

            SsmlProcessor.SsmlSegment.PauseSegment pause = segments.stream() 
                    .filter(s -> s instanceof SsmlProcessor.SsmlSegment.PauseSegment) 
                    .map(s -> (SsmlProcessor.SsmlSegment.PauseSegment) s) 
                    .findFirst() 
                    .orElseThrow(); 
            assertThat(pause.durationMs()).isEqualTo(500L); 
        }

        @Test
        @DisplayName("break tag in seconds unit converts to milliseconds")
        void parse_breakSeconds_convertedToMs() { 
            String ssml = "<speak>Hello<break time=\"2s\"/>World</speak>";
            List<SsmlProcessor.SsmlSegment> segments = processor.parse(ssml); 

            SsmlProcessor.SsmlSegment.PauseSegment pause = segments.stream() 
                    .filter(s -> s instanceof SsmlProcessor.SsmlSegment.PauseSegment) 
                    .map(s -> (SsmlProcessor.SsmlSegment.PauseSegment) s) 
                    .findFirst() 
                    .orElseThrow(); 
            assertThat(pause.durationMs()).isEqualTo(2_000L); 
        }

        @Test
        @DisplayName("text before and after break are captured as TEXT segments")
        void parse_breakWithTextAround_threeSegments() { 
            String ssml = "<speak>Hello<break time=\"300ms\"/>World</speak>";
            List<SsmlProcessor.SsmlSegment> segments = processor.parse(ssml); 

            assertThat(segments).hasSize(3); 
            assertThat(segments.get(0).text()).isEqualTo("Hello");
            assertThat(segments.get(1).type()) 
                    .isEqualTo(SsmlProcessor.SsmlSegment.SegmentType.PAUSE); 
            assertThat(segments.get(2).text()).isEqualTo("World");
        }
    }

    // ─── parse: prosody ───────────────────────────────────────────────────────

    @Nested
    @DisplayName("parse() - <prosody>")
    class ParseProsody {

        @Test
        @DisplayName("prosody tag produces a PROSODY segment")
        void parse_prosody_segment() { 
            String ssml = "<speak><prosody rate=\"150%\" pitch=\"+10%\">Fast speech</prosody></speak>";
            List<SsmlProcessor.SsmlSegment> segments = processor.parse(ssml); 

            assertThat(segments).hasSize(1); 
            assertThat(segments.get(0).type()) 
                    .isEqualTo(SsmlProcessor.SsmlSegment.SegmentType.PROSODY); 
            assertThat(segments.get(0).text()).isEqualTo("Fast speech");
        }

        @Test
        @DisplayName("prosody segment retains attributes string")
        void parse_prosody_attributesRetained() { 
            String ssml = "<speak><prosody rate=\"80%\">Slow</prosody></speak>";
            SsmlProcessor.SsmlSegment.ProsodySegment seg = (SsmlProcessor.SsmlSegment.ProsodySegment) 
                    processor.parse(ssml).get(0); 
            assertThat(seg.attributes()).contains("rate");
        }
    }

    // ─── parse: emphasis ──────────────────────────────────────────────────────

    @Nested
    @DisplayName("parse() - <emphasis>")
    class ParseEmphasis {

        @Test
        @DisplayName("strong emphasis produces EMPHASIS segment")
        void parse_strongEmphasis_segment() { 
            String ssml = "<speak><emphasis level=\"strong\">Important!</emphasis></speak>";
            List<SsmlProcessor.SsmlSegment> segments = processor.parse(ssml); 

            assertThat(segments).hasSize(1); 
            assertThat(segments.get(0).type()) 
                    .isEqualTo(SsmlProcessor.SsmlSegment.SegmentType.EMPHASIS); 
            assertThat(segments.get(0).text()).isEqualTo("Important!");
        }

        @Test
        @DisplayName("emphasis level is preserved in the segment")
        void parse_emphasisLevel_preserved() { 
            String ssml = "<speak><emphasis level=\"reduced\">Quiet</emphasis></speak>";
            SsmlProcessor.SsmlSegment.EmphasisSegment seg = (SsmlProcessor.SsmlSegment.EmphasisSegment) 
                    processor.parse(ssml).get(0); 
            assertThat(seg.emphasisLevel()).isEqualToIgnoringCase("reduced");
        }
    }

    // ─── toPlainText ──────────────────────────────────────────────────────────

    @Nested
    @DisplayName("toPlainText()")
    class ToPlainText {

        @Test
        @DisplayName("strips all SSML tags leaving only text")
        void toPlainText_stripsAllTags() { 
            String ssml = "<speak>Hello <emphasis level=\"strong\">World</emphasis><break time=\"200ms\"/></speak>";
            assertThat(processor.toPlainText(ssml)).isEqualTo("Hello World");
        }

        @Test
        @DisplayName("null ssml throws NullPointerException")
        void toPlainText_null_throwsNPE() { 
            assertThatNullPointerException() 
                    .isThrownBy(() -> processor.toPlainText(null)); 
        }

        @Test
        @DisplayName("plain text input passes through unchanged")
        void toPlainText_plainInput() { 
            assertThat(processor.toPlainText("Hello World")).isEqualTo("Hello World");
        }
    }

    // ─── parse result is unmodifiable ─────────────────────────────────────────

    @Test
    @DisplayName("parse() returns an unmodifiable list")
    void parse_returnsUnmodifiableList() { 
        List<SsmlProcessor.SsmlSegment> segments = processor.parse("<speak>test</speak>");
        assertThatThrownBy(() -> segments.add(SsmlProcessor.SsmlSegment.text("extra")))
                .isInstanceOf(UnsupportedOperationException.class); 
    }
}
