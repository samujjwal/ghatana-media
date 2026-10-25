package com.ghatana.stt.diarization;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.util.Collections;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;
import static org.assertj.core.api.Assertions.assertThatNullPointerException;

/**
 * Unit tests for {@link SpeakerDiarizationService} — AV-007.1.
 *
 * @doc.type class
 * @doc.purpose Unit tests for the speaker diarization service
 * @doc.layer product
 * @doc.pattern Test
 */
@DisplayName("SpeakerDiarizationService")
class SpeakerDiarizationServiceTest {

    /**
     * Embedding extractor stub: returns a distinct embedding per byte[] content length bucket.
     * Different lengths → different speakers; same length → same speaker.
     */
    private static final SpeakerDiarizationService.SpeakerEmbeddingExtractor STUB_EXTRACTOR =
            audioBytes -> {
                float[] emb = new float[16];
                int bucket = audioBytes.length % 3; // 3 distinct speaker buckets
                emb[bucket] = 1.0f;
                return emb;
            };

    private SpeakerDiarizationService buildService() { 
        return SpeakerDiarizationService.builder() 
                .embeddingExtractor(STUB_EXTRACTOR) 
                .admission(() -> true) // test fixture; no production rights authority is wired
                .maxSpeakers(5) 
                .similarityThreshold(0.80) 
                .build(); 
    }

    // ─── diarize ──────────────────────────────────────────────────────────────

    @Nested
    @DisplayName("diarize()")
    class Diarize {

        @Test
        @DisplayName("empty segment list returns empty list")
        void diarize_empty_returnsEmpty() { 
            SpeakerDiarizationService service = buildService(); 
            assertThat(service.diarize(Collections.emptyList())).isEmpty(); 
        }

        @Test
        @DisplayName("missing trusted admission fails before calling the embedding provider")
        void diarize_withoutAdmissionFailsBeforeProvider() {
            var providerCalls = new java.util.concurrent.atomic.AtomicInteger();
            SpeakerDiarizationService service = SpeakerDiarizationService.builder()
                    .embeddingExtractor(bytes -> { providerCalls.incrementAndGet(); return new float[]{1}; })
                    .build();

            org.assertj.core.api.Assertions.assertThatThrownBy(() -> service.diarize(List.of(
                            new SpeakerDiarizationService.AudioSegment(new byte[]{1}, 0, 10, "x"))))
                    .isInstanceOf(SpeakerDiarizationService.DiarizationException.class)
                    .hasMessageStartingWith("STT_DIARIZATION_NOT_ADMITTED:");
            assertThat(providerCalls).hasValue(0);
        }

        @Test
        @DisplayName("explicitly denied purpose or voice-biometric rights fails before provider dispatch")
        void diarize_deniedRightsOrPurposeFailsBeforeProvider() {
            var providerCalls = new java.util.concurrent.atomic.AtomicInteger();
            SpeakerDiarizationService service = SpeakerDiarizationService.builder()
                    .embeddingExtractor(bytes -> { providerCalls.incrementAndGet(); return new float[]{1}; })
                    .admission(() -> false)
                    .build();

            org.assertj.core.api.Assertions.assertThatThrownBy(() -> service.diarize(List.of(
                            new SpeakerDiarizationService.AudioSegment(new byte[]{1}, 0, 10, "x"))))
                    .isInstanceOf(SpeakerDiarizationService.DiarizationException.class)
                    .hasMessage("STT_DIARIZATION_NOT_ADMITTED: trusted rights and purpose admission is unavailable");
            assertThat(providerCalls).hasValue(0);
        }

        @Test
        @DisplayName("single segment returns one turn labeled SPEAKER_0")
        void diarize_singleSegment_labeledSpeaker0() { 
            SpeakerDiarizationService service = buildService(); 
            var segment = new SpeakerDiarizationService.AudioSegment( 
                    new byte[]{1, 2, 3}, 0, 1000, "Hello");
            List<SpeakerDiarizationService.SpeakerTurn> turns =
                    service.diarize(List.of(segment)); 

            assertThat(turns).hasSize(1); 
            assertThat(turns.get(0).speakerId()).isEqualTo("SPEAKER_0");
            assertThat(turns.get(0).text()).isEqualTo("Hello");
        }

        @Test
        @DisplayName("two acoustically distinct segments → two different speaker labels")
        void diarize_twoSpeakers_distinctLabels() { 
            SpeakerDiarizationService service = buildService(); 

            // bucket 0: length 3 → speaker A
            var seg1 = new SpeakerDiarizationService.AudioSegment(new byte[3], 0, 1000, "Hi"); 
            // bucket 1: length 4 → speaker B
            var seg2 = new SpeakerDiarizationService.AudioSegment(new byte[4], 1000, 2000, "Hello"); 

            List<SpeakerDiarizationService.SpeakerTurn> turns = service.diarize(List.of(seg1, seg2)); 

            assertThat(turns).hasSize(2); 
            assertThat(turns.get(0).speakerId()) 
                    .isNotEqualTo(turns.get(1).speakerId()); 
        }

        @Test
        @DisplayName("overlapping speaker fixture retains stable anonymous cluster IDs")
        void overlappingFixtureUsesStableAnonymousIds() {
            var service = buildService();
            var turns = service.diarize(List.of(
                    new SpeakerDiarizationService.AudioSegment(new byte[3], 0, 1200, "speaker a"),
                    new SpeakerDiarizationService.AudioSegment(new byte[4], 700, 1500, "speaker b"),
                    new SpeakerDiarizationService.AudioSegment(new byte[3], 1300, 2000, "speaker a again")));

            assertThat(turns).extracting(SpeakerDiarizationService.SpeakerTurn::speakerId)
                    .containsExactly("SPEAKER_0", "SPEAKER_1", "SPEAKER_0")
                    .allMatch(id -> id.matches("SPEAKER_[0-9]+"));
        }

        @Test
        @DisplayName("out-of-order source segments fail before embedding extraction")
        void outOfOrderSegmentsFailBeforeProvider() {
            var providerCalls = new java.util.concurrent.atomic.AtomicInteger();
            var service = SpeakerDiarizationService.builder()
                    .embeddingExtractor(bytes -> { providerCalls.incrementAndGet(); return new float[] {1}; })
                    .admission(() -> true)
                    .build();

            org.assertj.core.api.Assertions.assertThatThrownBy(() -> service.diarize(List.of(
                            new SpeakerDiarizationService.AudioSegment(new byte[] {1}, 100, 200, "later"),
                            new SpeakerDiarizationService.AudioSegment(new byte[] {2}, 50, 150, "earlier"))))
                    .isInstanceOf(SpeakerDiarizationService.DiarizationException.class)
                    .hasMessageStartingWith("STT_DIARIZATION_SEGMENTS_OUT_OF_ORDER:");
            assertThat(providerCalls).hasValue(0);
        }

        @Test
        @DisplayName("acoustically similar segments → same speaker label")
        void diarize_sameSpeaker_sameLabel() { 
            SpeakerDiarizationService service = buildService(); 

            // Same bucket (length 3 → bucket 0): identical embeddings 
            var seg1 = new SpeakerDiarizationService.AudioSegment(new byte[3], 0, 500, "Hey"); 
            var seg2 = new SpeakerDiarizationService.AudioSegment(new byte[3], 500, 1000, "there"); 

            List<SpeakerDiarizationService.SpeakerTurn> turns = service.diarize(List.of(seg1, seg2)); 

            assertThat(turns.get(0).speakerId()).isEqualTo(turns.get(1).speakerId()); 
        }

        @Test
        @DisplayName("turns preserve start/end times from input segments")
        void diarize_timesPreserved() { 
            SpeakerDiarizationService service = buildService(); 
            var segment = new SpeakerDiarizationService.AudioSegment( 
                    new byte[]{0x01}, 500, 1500, "test");
            var turns = service.diarize(List.of(segment)); 

            assertThat(turns.get(0).startMs()).isEqualTo(500); 
            assertThat(turns.get(0).endMs()).isEqualTo(1500); 
        }

        @Test
        @DisplayName("null segments list throws NullPointerException")
        void diarize_null_throwsNPE() { 
            SpeakerDiarizationService service = buildService(); 
            assertThatNullPointerException() 
                    .isThrownBy(() -> service.diarize(null)); 
        }

        @Test
        @DisplayName("unmatched segment at speaker cap fails instead of inheriting another speaker")
        void diarize_unmatchedSegmentAtMaxSpeakersFailsClosed() {
            // Allow only 2 speakers but send 3 distinct acoustic buckets.
            SpeakerDiarizationService service = SpeakerDiarizationService.builder() 
                    .embeddingExtractor(STUB_EXTRACTOR) 
                    .admission(() -> true) // test fixture; no production rights authority is wired
                    .maxSpeakers(2) 
                    .similarityThreshold(0.80) 
                    .build(); 

            var seg0 = new SpeakerDiarizationService.AudioSegment(new byte[3], 0, 500, "a"); // bucket 0 
            var seg1 = new SpeakerDiarizationService.AudioSegment(new byte[4], 500, 1000, "b"); // bucket 1 
            var seg2 = new SpeakerDiarizationService.AudioSegment(new byte[5], 1000, 1500, "c"); // bucket 2 

            org.assertj.core.api.Assertions.assertThatThrownBy(() -> service.diarize(List.of(seg0, seg1, seg2)))
                    .isInstanceOf(SpeakerDiarizationService.DiarizationException.class)
                    .hasMessageStartingWith("STT_DIARIZATION_SPEAKER_LIMIT_EXCEEDED:");
        }

        @Test
        @DisplayName("existing speaker remains assignable after speaker cap is reached")
        void diarizeExistingMatchStillWorksAtSpeakerCap() {
            SpeakerDiarizationService service = SpeakerDiarizationService.builder()
                    .embeddingExtractor(STUB_EXTRACTOR)
                    .admission(() -> true)
                    .maxSpeakers(2)
                    .similarityThreshold(0.80)
                    .build();

            List<SpeakerDiarizationService.SpeakerTurn> turns = service.diarize(List.of(
                    new SpeakerDiarizationService.AudioSegment(new byte[3], 0, 500, "first"),
                    new SpeakerDiarizationService.AudioSegment(new byte[4], 500, 1000, "second"),
                    new SpeakerDiarizationService.AudioSegment(new byte[3], 1000, 1500, "first again")));

            assertThat(turns).extracting(SpeakerDiarizationService.SpeakerTurn::speakerId)
                    .containsExactly("SPEAKER_0", "SPEAKER_1", "SPEAKER_0");
        }
    }

    // ─── builder validation ───────────────────────────────────────────────────

    @Nested
    @DisplayName("Builder validation")
    class BuilderValidation {

        @Test
        @DisplayName("null extractor throws NullPointerException")
        void builder_nullExtractor_throwsNPE() { 
            assertThatNullPointerException() 
                    .isThrownBy(() -> SpeakerDiarizationService.builder() 
                            .embeddingExtractor(null)); 
        }

        @Test
        @DisplayName("maxSpeakers < 1 throws IllegalArgumentException")
        void builder_invalidMaxSpeakers_throwsIAE() { 
            assertThatIllegalArgumentException() 
                    .isThrownBy(() -> SpeakerDiarizationService.builder().maxSpeakers(0)); 
        }

        @Test
        @DisplayName("similarityThreshold > 1 throws IllegalArgumentException")
        void builder_invalidThreshold_throwsIAE() { 
            assertThatIllegalArgumentException() 
                    .isThrownBy(() -> SpeakerDiarizationService.builder().similarityThreshold(1.1)); 
        }
    }

    // ─── AudioSegment validation ──────────────────────────────────────────────

    @Nested
    @DisplayName("AudioSegment")
    class AudioSegmentTests {

        @Test
        @DisplayName("null audioBytes throws NullPointerException")
        void audioSegment_nullBytes_throwsNPE() { 
            assertThatNullPointerException() 
                    .isThrownBy(() -> new SpeakerDiarizationService.AudioSegment(null, 0, 100, "t")); 
        }

        @Test
        @DisplayName("negative startMs throws IllegalArgumentException")
        void audioSegment_negativeStart_throwsIAE() { 
            assertThatIllegalArgumentException() 
                    .isThrownBy(() -> new SpeakerDiarizationService.AudioSegment(new byte[1], -1, 100, "t")); 
        }

        @Test
        @DisplayName("endMs < startMs throws IllegalArgumentException")
        void audioSegment_endBeforeStart_throwsIAE() { 
            assertThatIllegalArgumentException() 
                    .isThrownBy(() -> new SpeakerDiarizationService.AudioSegment(new byte[1], 500, 100, "t")); 
        }

        @Test
        @DisplayName("zero-duration and empty-audio segments are rejected")
        void audioSegment_rejectsEmptyOrZeroDuration() {
            assertThatIllegalArgumentException()
                    .isThrownBy(() -> new SpeakerDiarizationService.AudioSegment(new byte[1], 100, 100, "t"));
            assertThatIllegalArgumentException()
                    .isThrownBy(() -> new SpeakerDiarizationService.AudioSegment(new byte[0], 100, 200, "t"));
        }
    }
}
