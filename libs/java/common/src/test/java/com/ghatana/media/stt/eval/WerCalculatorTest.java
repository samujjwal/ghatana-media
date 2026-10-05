package com.ghatana.media.stt.eval;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

/**
 * Unit tests for {@link WerCalculator}.
 *
 * @doc.type class
 * @doc.purpose Unit tests for the WER evaluation metric
 * @doc.layer platform
 * @doc.pattern TestCase
 */
@DisplayName("WerCalculator")
class WerCalculatorTest {

    private final WerCalculator calc = new WerCalculator(); 

    @Test
    @DisplayName("perfect match → WER = 0")
    void perfectMatch_werIsZero() { 
        var r = calc.compute("the cat sat on the mat", "the cat sat on the mat"); 
        assertThat(r.wer()).isCloseTo(0.0, within(1e-6)); 
        assertThat(r.substitutions()).isZero(); 
        assertThat(r.deletions()).isZero(); 
        assertThat(r.insertions()).isZero(); 
    }

    @Test
    @DisplayName("one deletion → WER = 1/N")
    void oneDeletion_werIsOneDivN() { 
        // ref = 6 words, hypothesis drops "the" before "mat"
        var r = calc.compute("the cat sat on the mat", "the cat sat on mat"); 
        assertThat(r.deletions()).isEqualTo(1); 
        assertThat(r.wer()).isCloseTo(1.0 / 6, within(1e-6)); 
    }

    @Test
    @DisplayName("one insertion → WER = 1/N")
    void oneInsertion_werIsOneDivN() { 
        var r = calc.compute("hello world", "hello beautiful world"); 
        assertThat(r.insertions()).isEqualTo(1); 
        assertThat(r.wer()).isCloseTo(1.0 / 2, within(1e-6)); 
    }

    @Test
    @DisplayName("one substitution → WER = 1/N")
    void oneSubstitution_werIsOneDivN() { 
        var r = calc.compute("the quick brown fox", "the slow brown fox"); 
        assertThat(r.substitutions()).isEqualTo(1); 
        assertThat(r.wer()).isCloseTo(1.0 / 4, within(1e-6)); 
    }

    @Test
    @DisplayName("completely wrong → WER ≥ 1.0")
    void completelyWrong_werGtOne() { 
        var r = calc.compute("hello world", "goodbye universe today"); 
        assertThat(r.wer()).isGreaterThanOrEqualTo(1.0); 
    }

    @Test
    @DisplayName("empty hypothesis → WER = 1.0 (all deletions)")
    void emptyHypothesis_allDeletions() { 
        var r = calc.compute("four words in here", ""); 
        assertThat(r.deletions()).isEqualTo(4); 
        assertThat(r.wer()).isCloseTo(1.0, within(1e-6)); 
    }

    @Test
    @DisplayName("empty reference and hypothesis → WER = 0")
    void bothEmpty_werIsZero() { 
        var r = calc.compute("", ""); 
        assertThat(r.wer()).isCloseTo(0.0, within(1e-6)); 
    }

    @Test
    @DisplayName("punctuation stripped before comparison")
    void punctuationIgnored() { 
        var r = calc.compute("Hello, world!", "hello world"); 
        assertThat(r.wer()).isCloseTo(0.0, within(1e-6)); 
    }

    @Test
    @DisplayName("corpus WER aggregates over multiple pairs")
    void corpusWer_aggregatesCorrectly() { 
        // Pair 1: perfect  (N=2, E=0) 
        // Pair 2: 1 del    (N=3, E=1) 
        // Corpus WER = 1/5
        var result = calc.computeCorpus(List.of( 
            new WerCalculator.Pair("hello world",        "hello world"), 
            new WerCalculator.Pair("one two three",      "one three") 
        ));
        assertThat(result.wer()).isCloseTo(1.0 / 5, within(1e-6)); 
        assertThat(result.referenceLength()).isEqualTo(5); 
    }

    @Test
    @DisplayName("accuracy() = 1 − WER")
    void accuracy_isComplementOfWer() { 
        var r = calc.compute("one two three four", "one two three five"); 
        assertThat(r.accuracy()).isCloseTo(1.0 - r.wer(), within(1e-6)); 
    }
}
