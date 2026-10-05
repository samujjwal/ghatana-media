package com.ghatana.stt.detection;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;
import static org.assertj.core.api.Assertions.assertThatNullPointerException;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Unit tests for {@link LanguageDetectionService} — AV-007.2.
 *
 * @doc.type class
 * @doc.purpose Unit tests for the automatic language detection service
 * @doc.layer product
 * @doc.pattern Test
 */
@DisplayName("LanguageDetectionService")
class LanguageDetectionServiceTest {

    /** Deterministic text model: returns "en" at 0.97 confidence for any text containing "hello",
     *  "fr" at 0.95 for "bonjour", else "de" at 0.60. */
    private static final LanguageDetectionService.LanguageDetectionModel TEXT_MODEL = textSample -> {
        if (textSample.toLowerCase().contains("hello")) {
            return List.of(
                    LanguageDetectionService.LanguageCandidate.of("en", 0.97),
                    LanguageDetectionService.LanguageCandidate.of("en-US", 0.90));
        }
        if (textSample.toLowerCase().contains("bonjour")) {
            return List.of(
                    LanguageDetectionService.LanguageCandidate.of("fr", 0.95),
                    LanguageDetectionService.LanguageCandidate.of("fr-FR", 0.85));
        }
        return List.of(LanguageDetectionService.LanguageCandidate.of("de", 0.60));
    };

    private static final LanguageDetectionService.LanguageDetectionModel AUDIO_MODEL =
            new LanguageDetectionService.LanguageDetectionModel() {
                @Override
                public List<LanguageDetectionService.LanguageCandidate> detect(String textSample) {
                    return TEXT_MODEL.detect(textSample);
                }

                @Override
                public List<LanguageDetectionService.LanguageCandidate> detectFromAudio(byte[] audioBytes) {
                    return List.of(LanguageDetectionService.LanguageCandidate.of("en", 0.91));
                }
            };

    // ─── of() factories ───────────────────────────────────────────────────────

    @Test
    @DisplayName("of(model): null model throws NullPointerException")
    void of_nullModel_throwsNPE() {
        assertThatNullPointerException()
                .isThrownBy(() -> LanguageDetectionService.of(null));
    }

    @Test
    @DisplayName("of(model, threshold): threshold > 1 throws IllegalArgumentException")
    void of_invalidThreshold_throwsIAE() {
        assertThatIllegalArgumentException()
                .isThrownBy(() -> LanguageDetectionService.of(TEXT_MODEL, 1.5));
    }

    // ─── detect() ─────────────────────────────────────────────────────────────

    @Nested
    @DisplayName("detect(text)")
    class Detect {

        @Test
        @DisplayName("detects English for 'hello world' with high confidence")
        void detect_english_highConfidence() {
            LanguageDetectionService service = LanguageDetectionService.of(TEXT_MODEL);
            LanguageDetectionService.DetectionResult result = service.detect("hello world");

            assertThat(result.topLanguageTag()).contains("en");
            assertThat(result.isReliable()).isTrue();
        }

        @Test
        @DisplayName("detects French for 'bonjour monde'")
        void detect_french_detected() {
            LanguageDetectionService service = LanguageDetectionService.of(TEXT_MODEL);
            LanguageDetectionService.DetectionResult result = service.detect("bonjour monde");

            assertThat(result.topLanguageTag()).contains("fr");
        }

        @Test
        @DisplayName("below-threshold result returns empty topLanguageTag")
        void detect_belowThreshold_emptyTop() {
            // 0.60 < 0.80 threshold
            LanguageDetectionService service = LanguageDetectionService.of(TEXT_MODEL, 0.80);
            LanguageDetectionService.DetectionResult result = service.detect("xyz123");

            assertThat(result.topLanguageTag()).isEmpty();
            assertThat(result.isReliable()).isFalse();
        }

        @Test
        @DisplayName("null textSample throws NullPointerException")
        void detect_null_throwsNPE() {
            LanguageDetectionService service = LanguageDetectionService.of(TEXT_MODEL);
            assertThatNullPointerException()
                    .isThrownBy(() -> service.detect(null));
        }

        @Test
        @DisplayName("blank textSample throws IllegalArgumentException")
        void detect_blank_throwsIAE() {
            LanguageDetectionService service = LanguageDetectionService.of(TEXT_MODEL);
            assertThatIllegalArgumentException()
                    .isThrownBy(() -> service.detect("   "));
        }

        @Test
        @DisplayName("result.candidates() is unmodifiable")
        void detect_candidatesUnmodifiable() {
            LanguageDetectionService service = LanguageDetectionService.of(TEXT_MODEL);
            LanguageDetectionService.DetectionResult result = service.detect("hello world");
            assertThatThrownBy(() -> result.candidates().add(
                    LanguageDetectionService.LanguageCandidate.of("de", 0.1)))
                    .isInstanceOf(UnsupportedOperationException.class);
        }
    }

    // ─── detectFromAudio() ────────────────────────────────────────────────────

    @Nested
    @DisplayName("detectFromAudio()")
    class DetectFromAudio {

        @Test
        @DisplayName("non-empty audio returns at least one candidate")
        void detectFromAudio_returnsCandidate() {
            LanguageDetectionService service = LanguageDetectionService.of(AUDIO_MODEL);
            LanguageDetectionService.DetectionResult result =
                    service.detectFromAudio(new byte[]{1, 2, 3, 4});

            assertThat(result.candidates()).isNotEmpty();
        }

        @Test
        @DisplayName("null audioBytes throws NullPointerException")
        void detectFromAudio_null_throwsNPE() {
            LanguageDetectionService service = LanguageDetectionService.of(TEXT_MODEL);
            assertThatNullPointerException()
                    .isThrownBy(() -> service.detectFromAudio(null));
        }

        @Test
        @DisplayName("empty audioBytes throws IllegalArgumentException")
        void detectFromAudio_empty_throwsIAE() {
            LanguageDetectionService service = LanguageDetectionService.of(TEXT_MODEL);
            assertThatIllegalArgumentException()
                    .isThrownBy(() -> service.detectFromAudio(new byte[0]));
        }
    }

    // ─── LanguageCandidate ────────────────────────────────────────────────────

    @Nested
    @DisplayName("LanguageCandidate")
    class LanguageCandidateTests {

        @Test
        @DisplayName("of() resolves locale from language tag")
        void candidate_localeResolved() {
            var candidate = LanguageDetectionService.LanguageCandidate.of("fr-CA", 0.90);
            assertThat(candidate.locale().getLanguage()).isEqualTo("fr");
            assertThat(candidate.locale().getCountry()).isEqualTo("CA");
        }

        @Test
        @DisplayName("confidence > 1 throws IllegalArgumentException")
        void candidate_invalidConfidence_throwsIAE() {
            assertThatIllegalArgumentException()
                    .isThrownBy(() -> LanguageDetectionService.LanguageCandidate.of("en", 1.1));
        }

        @Test
        @DisplayName("null languageTag throws NullPointerException")
        void candidate_nullTag_throwsNPE() {
            assertThatNullPointerException()
                    .isThrownBy(() -> LanguageDetectionService.LanguageCandidate.of(null, 0.9));
        }
    }
}
