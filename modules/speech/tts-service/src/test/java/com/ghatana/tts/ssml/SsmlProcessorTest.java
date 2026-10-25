package com.ghatana.tts.ssml;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.xml.sax.SAXParseException;

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

    @Test
    @DisplayName("normalizes nested supported tags and decodes escaped text")
    void parse_nestedTagsAndEscapedTextAreNormalized() {
        var segments = processor.parse("<speak><say-as interpret-as=\"cardinal\"><emphasis level=\"STRONG\">A &amp; B</emphasis></say-as></speak>");
        assertThat(segments).hasSize(1);
        assertThat(segments.get(0).type()).isEqualTo(SsmlProcessor.SsmlSegment.SegmentType.EMPHASIS);
        assertThat(segments.get(0).text()).isEqualTo("A & B");
        assertThat(((SsmlProcessor.SsmlSegment.EmphasisSegment) segments.get(0)).emphasisLevel()).isEqualTo("strong");
    }

    @Test
    @DisplayName("rejects DTD and external entity expansion")
    void rejectsXxeAndEntityDeclarations() {
        String xxe = "<!DOCTYPE speak [<!ENTITY x SYSTEM \"file:///etc/passwd\">]><speak>&x;</speak>";
        assertThatIllegalArgumentException().isThrownBy(() -> processor.parse(xxe));
        String bomb = "<!DOCTYPE speak [<!ENTITY a \"1234567890\"><!ENTITY b \"&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;\">]><speak>&b;</speak>";
        assertThatIllegalArgumentException().isThrownBy(() -> processor.parse(bomb));
    }

    @Test
    @DisplayName("rejects XInclude elements without expanding local resources")
    void rejectsXIncludeExpansion() {
        String xinclude = "<speak xmlns:xi=\"http://www.w3.org/2001/XInclude\">before"
                + "<xi:include href=\"file:///etc/passwd\" parse=\"text\"/>after</speak>";

        assertThatIllegalArgumentException()
                .isThrownBy(() -> processor.parse(xinclude));
    }

    @Test
    @DisplayName("rejects malformed XML, oversized input, excessive pause, and unknown tags")
    void rejectsMalformedAndUnboundedSsml() {
        assertThatIllegalArgumentException().isThrownBy(() -> processor.parse("<speak><emphasis>broken</speak>"));
        assertThatIllegalArgumentException().isThrownBy(() -> processor.parse("<speak>" + "x".repeat(SsmlProcessor.MAX_INPUT_CHARS) + "</speak>"));
        assertThatIllegalArgumentException().isThrownBy(() -> processor.parse("<speak><break time=\"11s\"/></speak>"));
        assertThatIllegalArgumentException().isThrownBy(() -> processor.parse("<speak><script>unsafe</script></speak>"));
    }

    @Test
    @DisplayName("rejects excessive nesting in the XML parser before building the SSML tree")
    void rejectsExcessiveNesting() {
        String nested = "<speak>" + "<say-as interpret-as=\"cardinal\">".repeat(SsmlProcessor.MAX_DEPTH)
                + "x" + "</say-as>".repeat(SsmlProcessor.MAX_DEPTH) + "</speak>";
        assertThatThrownBy(() -> processor.parse(nested))
                .isInstanceOf(IllegalArgumentException.class)
                .hasCauseInstanceOf(SAXParseException.class);
    }

    @Test
    @DisplayName("rejects invalid prosody units and ranges and negative pauses")
    void rejectsInvalidProsodyUnitsAndRanges() {
        assertThatIllegalArgumentException().isThrownBy(() -> processor.parse("<speak><prosody rate=\"NaN%\">x</prosody></speak>"));
        assertThatIllegalArgumentException().isThrownBy(() -> processor.parse("<speak><prosody rate=\"Infinity%\">x</prosody></speak>"));
        assertThatIllegalArgumentException().isThrownBy(() -> processor.parse("<speak><prosody rate=\"fast-ish\">x</prosody></speak>"));
        assertThatIllegalArgumentException().isThrownBy(() -> processor.parse("<speak><prosody pitch=\"2hz\">x</prosody></speak>"));
        assertThatIllegalArgumentException().isThrownBy(() -> processor.parse("<speak><prosody volume=\"loud-ish\">x</prosody></speak>"));
        assertThatIllegalArgumentException().isThrownBy(() -> processor.parse("<speak><prosody rate=\"201%\">x</prosody></speak>"));
        assertThatIllegalArgumentException().isThrownBy(() -> processor.parse("<speak><prosody pitch=\"13st\">x</prosody></speak>"));
        assertThatIllegalArgumentException().isThrownBy(() -> processor.parse("<speak><prosody volume=\"7dB\">x</prosody></speak>"));
        assertThatIllegalArgumentException().isThrownBy(() -> processor.parse("<speak><break time=\"-1ms\"/></speak>"));
    }

    @Test
    @DisplayName("rejects overflowing prosody values and malformed pronunciation controls")
    void rejectsOverflowingProsodyAndMalformedPronunciationControls() {
        assertThatIllegalArgumentException().isThrownBy(() ->
                processor.parse("<speak><prosody rate=\"1e309%\">x</prosody></speak>"));
        assertThatIllegalArgumentException().isThrownBy(() ->
                processor.parse("<speak><prosody pitch=\"-1e309st\">x</prosody></speak>"));
        assertThatIllegalArgumentException().isThrownBy(() ->
                processor.parse("<speak><prosody volume=\"1e309dB\">x</prosody></speak>"));
        assertThatIllegalArgumentException().isThrownBy(() ->
                processor.parse("<speak><phoneme alphabet=\"x-sampa\" ph=\"həˈloʊ\">hello</phoneme></speak>"));
        assertThatIllegalArgumentException().isThrownBy(() ->
                processor.parse("<speak><phoneme alphabet=\"ipa\" ph=\" \">hello</phoneme></speak>"));
        assertThatIllegalArgumentException().isThrownBy(() ->
                processor.parse("<speak><prosody contour=\"(0%,+0st)\">x</prosody></speak>"));
    }

    @Test
    @DisplayName("accepts finite prosody values at documented bounds without claiming provider effects")
    void acceptsProsodyValuesAtBounds() {
        assertThat(processor.parse("<speak><prosody rate=\"50%\" pitch=\"-12st\" volume=\"-20dB\">x</prosody></speak>"))
                .hasSize(1);
        assertThat(processor.parse("<speak><prosody rate=\"200%\" pitch=\"+12st\" volume=\"200%\">x</prosody></speak>"))
                .hasSize(1);
        assertThat(processor.parse("<speak><phoneme alphabet=\"ipa\" ph=\"həˈloʊ\">hello</phoneme></speak>"))
                .singleElement().satisfies(segment -> {
                    assertThat(segment).isInstanceOf(SsmlProcessor.SsmlSegment.PhonemeSegment.class);
                    assertThat(((SsmlProcessor.SsmlSegment.PhonemeSegment) segment).phoneme()).isEqualTo("həˈloʊ");
                });
    }

    @Test
    @DisplayName("rejects unknown or injection elements nested in flattened controls")
    void rejectsUnknownNestedElementsInsideProsodyAndEmphasis() {
        assertThatIllegalArgumentException().isThrownBy(() ->
                processor.parse("<speak><prosody rate=\"120%\"><script>unsafe</script></prosody></speak>"));
        assertThatIllegalArgumentException().isThrownBy(() ->
                processor.parse("<speak><emphasis level=\"strong\"><unknown>unsafe</unknown></emphasis></speak>"));
        assertThatIllegalArgumentException().isThrownBy(() ->
                processor.parse("<speak><prosody><break time=\"1s\"/></prosody></speak>"));
    }

    @Test
    @DisplayName("break elements cannot carry text or child elements")
    void rejectsNonEmptyBreakContent() {
        assertThatIllegalArgumentException().isThrownBy(() ->
                processor.parse("<speak><break time=\"1s\">unexpected</break></speak>"));
        assertThatIllegalArgumentException().isThrownBy(() ->
                processor.parse("<speak><break time=\"1s\"><emphasis level=\"strong\">x</emphasis></break></speak>"));
    }

    @Test
    @DisplayName("phoneme, substitution alias, and language annotations remain typed")
    void preservesTypedPhonemeSubstitutionAndLanguageInformation() {
        var segments = processor.parse("<speak><phoneme alphabet=\"ipa\" ph=\"təˈmeɪtoʊ\">tomato</phoneme>"
                + "<sub alias=\"World Wide Web\">WWW</sub><lang xml:lang=\"ne-NP\">नमस्ते</lang></speak>");

        assertThat(segments).hasSize(3);
        assertThat(segments.get(0)).isEqualTo(new SsmlProcessor.SsmlSegment.PhonemeSegment("tomato", "ipa", "təˈmeɪtoʊ"));
        assertThat(segments.get(1)).isEqualTo(new SsmlProcessor.SsmlSegment.SubstitutionSegment("WWW", "World Wide Web"));
        assertThat(segments.get(2)).isEqualTo(new SsmlProcessor.SsmlSegment.LanguageSegment("नमस्ते", "ne-NP"));
    }
}
