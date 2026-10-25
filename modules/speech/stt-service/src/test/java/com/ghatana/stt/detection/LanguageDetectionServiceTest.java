package com.ghatana.stt.detection;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;
import static org.assertj.core.api.Assertions.assertThatNullPointerException;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Adapter contract tests for {@link LanguageDetectionService}; they do not qualify an STT model.
 *
 * @doc.type class
 * @doc.purpose Unit tests for the automatic language detection service
 * @doc.layer product
 * @doc.pattern Test
 */
@DisplayName("LanguageDetectionService")
class LanguageDetectionServiceTest {

    /** Deterministic scripted model used to test propagation, not language classification. */
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

    @Test
    @DisplayName("of(model, threshold): non-finite thresholds throw IllegalArgumentException")
    void of_nonFiniteThreshold_throwsIAE() {
        for (double threshold : new double[] {Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY}) {
            assertThatIllegalArgumentException()
                    .isThrownBy(() -> LanguageDetectionService.of(TEXT_MODEL, threshold));
        }
    }

    // ─── detect() ─────────────────────────────────────────────────────────────

    @Nested
    @DisplayName("detect(text)")
    class Detect {

        @Test
        @DisplayName("propagates the scripted English candidate for 'hello world'")
        void detect_english_highConfidence() {
            LanguageDetectionService service = LanguageDetectionService.of(TEXT_MODEL);
            LanguageDetectionService.DetectionResult result = service.detect("hello world");

            assertThat(result.topLanguageTag()).contains("en");
            assertThat(result.isReliable()).isTrue();
        }

        @Test
        @DisplayName("propagates the scripted French candidate for 'bonjour monde'")
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

        @Test
        @DisplayName("null model candidate list is rejected with a stable provider-result error")
        void detect_nullModelResultIsRejected() {
            LanguageDetectionService.LanguageDetectionModel model = textSample -> null;

            assertThatThrownBy(() -> LanguageDetectionService.of(model).detect("hello world"))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("STT_LANGUAGE_CANDIDATE_INVALID")
                    .hasMessageContaining("null candidate list");
        }

        @Test
        @DisplayName("null first model candidate is validated before diagnostic logging")
        void detect_nullFirstCandidateIsRejectedBeforeLogging() {
            LanguageDetectionService.LanguageDetectionModel model = textSample ->
                    java.util.Arrays.asList((LanguageDetectionService.LanguageCandidate) null);

            assertThatThrownBy(() -> LanguageDetectionService.of(model).detect("hello world"))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("STT_LANGUAGE_CANDIDATE_INVALID");
        }
    }

    // ─── detectFromAudio() ────────────────────────────────────────────────────

    @Nested
    @DisplayName("detectFromAudio()")
    class DetectFromAudio {

        @Test
        @DisplayName("non-empty audio returns the configured model candidate")
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

        @Test
        @DisplayName("null audio model result is rejected with a stable provider-result error")
        void detectFromAudio_nullModelResultIsRejected() {
            var model = new LanguageDetectionService.LanguageDetectionModel() {
                @Override
                public List<LanguageDetectionService.LanguageCandidate> detect(String textSample) {
                    return List.of();
                }

                @Override
                public List<LanguageDetectionService.LanguageCandidate> detectFromAudio(byte[] audioBytes) {
                    return null;
                }
            };

            assertThatThrownBy(() -> LanguageDetectionService.of(model).detectFromAudio(new byte[] {1}))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("STT_LANGUAGE_CANDIDATE_INVALID")
                    .hasMessageContaining("null candidate list");
        }
    }

    /**
     * These checks exercise only the adapter contract. The controlled model is not a detector,
     * and these fixture-shaped inputs do not establish language coverage or model quality.
     */
    @Nested
    @DisplayName("scenario-shaped adapter contract")
    class ScenarioShapedAdapterContract {

        @Test
        @DisplayName("passes Devanagari text unchanged to the configured model")
        void devanagariTextIsDelegatedWithoutNormalization() {
            String sample = "नमस्ते संसार";
            AtomicReference<String> received = new AtomicReference<>();
            var nepali = LanguageDetectionService.LanguageCandidate.of("ne-NP", 0.82);
            var model = (LanguageDetectionService.LanguageDetectionModel) text -> {
                received.set(text);
                return List.of(nepali);
            };

            var result = LanguageDetectionService.of(model).detect(sample);

            assertThat(received).hasValue(sample);
            assertThat(result.candidates()).containsExactly(nepali);
            assertThat(result.topLanguageTag()).contains("ne-NP");
        }

        @Test
        @DisplayName("silence and seeded noise can abstain without a fabricated language")
        void nonSpeechAudioAbstentionDoesNotInventCandidateOrConfidence() {
            List<byte[]> received = new ArrayList<>();
            var model = new LanguageDetectionService.LanguageDetectionModel() {
                @Override
                public List<LanguageDetectionService.LanguageCandidate> detect(String textSample) {
                    return List.of();
                }

                @Override
                public List<LanguageDetectionService.LanguageCandidate> detectFromAudio(byte[] audioBytes) {
                    received.add(audioBytes.clone());
                    return List.of();
                }
            };
            byte[] silence = new byte[64];
            byte[] seededNoise = new byte[] {7, -3, 12, 0, -9, 2};
            var service = LanguageDetectionService.of(model);

            var silenceResult = service.detectFromAudio(silence);
            var noiseResult = service.detectFromAudio(seededNoise);

            assertThat(received).hasSize(2);
            assertThat(received.get(0)).containsExactly(silence);
            assertThat(received.get(1)).containsExactly(seededNoise);
            assertThat(silenceResult.candidates()).isEmpty();
            assertThat(silenceResult.topLanguageTag()).isEmpty();
            assertThat(silenceResult.isReliable()).isFalse();
            assertThat(noiseResult.candidates()).isEmpty();
            assertThat(noiseResult.topLanguageTag()).isEmpty();
            assertThat(noiseResult.isReliable()).isFalse();
        }

        @Test
        @DisplayName("unsupported and accent/overlap outcomes remain model-owned")
        void unsupportedAndAmbiguousTextPreserveOnlyModelOutput() {
            String unsupportedSample = "sample in a language outside this model's coverage";
            String accentOverlapSample = "bonjour hello [overlapping speakers]";
            AtomicReference<String> received = new AtomicReference<>();
            var model = (LanguageDetectionService.LanguageDetectionModel) text -> {
                received.set(text);
                return List.of();
            };
            var service = LanguageDetectionService.of(model);

            var unsupported = service.detect(unsupportedSample);
            var accentOverlap = service.detect(accentOverlapSample);

            assertThat(received).hasValue(accentOverlapSample);
            assertThat(unsupported.candidates()).isEmpty();
            assertThat(unsupported.topLanguageTag()).isEmpty();
            assertThat(accentOverlap.candidates()).isEmpty();
            assertThat(accentOverlap.topLanguageTag()).isEmpty();
        }

        @Test
        @DisplayName("reported confidence is preserved; empty output has no inferred confidence")
        void confidenceAvailabilityIsNotSynthesized() {
            var candidate = LanguageDetectionService.LanguageCandidate.of("en", 0.63);
            var model = new LanguageDetectionService.LanguageDetectionModel() {
                @Override
                public List<LanguageDetectionService.LanguageCandidate> detect(String textSample) {
                    return textSample.equals("confidence-present") ? List.of(candidate) : List.of();
                }
            };
            var service = LanguageDetectionService.of(model, 0.60);

            var present = service.detect("confidence-present");
            var unavailable = service.detect("confidence-unavailable");

            assertThat(present.topCandidate()).contains(candidate);
            assertThat(present.topCandidate().orElseThrow().confidence()).isEqualTo(0.63);
            assertThat(present.isReliable()).isTrue();
            assertThat(unavailable.topCandidate()).isEmpty();
            assertThat(unavailable.topLanguageTag()).isEmpty();
            assertThat(unavailable.isReliable()).isFalse();
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
            assertThat(LanguageDetectionService.LanguageCandidate.of("ne-NP", 0.8).languageTag())
                    .isEqualTo("ne-NP");
        }

        @Test
        @DisplayName("blank and malformed language tags are rejected")
        void candidate_invalidLanguageTags_throwStableValidationError() {
            for (String tag : new String[] {"", " ", "en_US", "en--US"}) {
                assertThatThrownBy(() -> LanguageDetectionService.LanguageCandidate.of(tag, 0.9))
                        .isInstanceOf(IllegalArgumentException.class)
                        .hasMessageContaining("STT_LANGUAGE_TAG_INVALID");
            }
        }

        @Test
        @DisplayName("direct construction requires a matching non-null locale")
        void candidate_localeMustMatchTag() {
            assertThatNullPointerException()
                    .isThrownBy(() -> new LanguageDetectionService.LanguageCandidate("en", 0.9, null));
            assertThatThrownBy(() -> new LanguageDetectionService.LanguageCandidate(
                    "en", 0.9, Locale.forLanguageTag("fr")))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("STT_LANGUAGE_LOCALE_MISMATCH");
        }

        @Test
        @DisplayName("confidence > 1 throws IllegalArgumentException")
        void candidate_invalidConfidence_throwsIAE() {
            assertThatIllegalArgumentException()
                    .isThrownBy(() -> LanguageDetectionService.LanguageCandidate.of("en", 1.1));
        }

        @Test
        @DisplayName("non-finite confidence is rejected")
        void candidate_nonFiniteConfidence_throwsIAE() {
            for (double confidence : new double[] {
                    Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY}) {
                assertThatIllegalArgumentException()
                        .isThrownBy(() -> LanguageDetectionService.LanguageCandidate.of("en", confidence));
            }
        }

        @Test
        @DisplayName("confidence boundaries are accepted")
        void candidate_confidenceBoundariesAreAccepted() {
            assertThat(LanguageDetectionService.LanguageCandidate.of("en", 0.0).confidence()).isZero();
            assertThat(LanguageDetectionService.LanguageCandidate.of("en", 1.0).confidence()).isEqualTo(1.0);
        }

        @Test
        @DisplayName("null languageTag throws NullPointerException")
        void candidate_nullTag_throwsNPE() {
            assertThatNullPointerException()
                    .isThrownBy(() -> LanguageDetectionService.LanguageCandidate.of(null, 0.9));
        }
    }

    @Nested
    @DisplayName("DetectionResult boundary")
    class DetectionResultBoundary {

        @Test
        @DisplayName("candidate list is snapshotted defensively")
        void candidateListIsSnapshotted() {
            var original = LanguageDetectionService.LanguageCandidate.of("en", 0.9);
            var mutableCandidates = new ArrayList<>(List.of(original));

            var result = new LanguageDetectionService.DetectionResult(mutableCandidates, 0.7);
            mutableCandidates.clear();
            mutableCandidates.add(LanguageDetectionService.LanguageCandidate.of("fr", 0.95));

            assertThat(result.candidates()).containsExactly(original);
            assertThatThrownBy(() -> result.candidates().add(
                    LanguageDetectionService.LanguageCandidate.of("de", 0.1)))
                    .isInstanceOf(UnsupportedOperationException.class);
        }

        @Test
        @DisplayName("accepts tied confidences and confidence boundary values in ranked order")
        void rankedCandidates_allowTiesAndConfidenceBoundaries() {
            var result = new LanguageDetectionService.DetectionResult(List.of(
                    LanguageDetectionService.LanguageCandidate.of("en", 1.0),
                    LanguageDetectionService.LanguageCandidate.of("fr", 0.5),
                    LanguageDetectionService.LanguageCandidate.of("de", 0.5),
                    LanguageDetectionService.LanguageCandidate.of("ja", 0.0)), 0.5);

            assertThat(result.topCandidate()).contains(result.candidates().get(0));
            assertThat(result.topLanguageTag()).contains("en");
        }

        @Test
        @DisplayName("rejects provider candidates whose confidence increases")
        void rankedCandidates_rejectsUnsortedConfidence() {
            assertThatThrownBy(() -> new LanguageDetectionService.DetectionResult(List.of(
                    LanguageDetectionService.LanguageCandidate.of("en", 0.6),
                    LanguageDetectionService.LanguageCandidate.of("fr", 0.9)), 0.5))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("STT_LANGUAGE_CANDIDATE_ORDER_INVALID");
        }

        @Test
        @DisplayName("null and excessive provider candidates are rejected")
        void invalidCandidateListsAreRejected() {
            assertThatThrownBy(() -> new LanguageDetectionService.DetectionResult(
                    java.util.Arrays.asList(LanguageDetectionService.LanguageCandidate.of("en", 0.9), null), 0.7))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("STT_LANGUAGE_CANDIDATE_INVALID");

            List<LanguageDetectionService.LanguageCandidate> excessive =
                    java.util.stream.IntStream.range(0, LanguageDetectionService.MAX_CANDIDATES + 1)
                            .mapToObj(index -> LanguageDetectionService.LanguageCandidate.of(
                                    "en-x-c" + Integer.toString(index, 36), 0.5))
                            .toList();
            assertThatThrownBy(() -> new LanguageDetectionService.DetectionResult(excessive, 0.7))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("STT_LANGUAGE_CANDIDATE_LIMIT");
        }

        @Test
        @DisplayName("direct result construction rejects non-finite threshold")
        void resultRejectsNonFiniteThreshold() {
            assertThatIllegalArgumentException()
                    .isThrownBy(() -> new LanguageDetectionService.DetectionResult(List.of(), Double.NaN));
        }
    }
}
