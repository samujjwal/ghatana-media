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
        @DisplayName("batch copy validates aggregate boundary before owning segment payloads")
        void copySegments_acceptsExactAggregateLimitAndReturnsDefensiveCopies() {
            byte[] firstAudio = new byte[] {1};
            byte[] secondAudio = new byte[(int) SpeakerDiarizationService.MAX_TOTAL_AUDIO_BYTES - 1];
            secondAudio[0] = 2;

            List<SpeakerDiarizationService.AudioSegment> copied = SpeakerDiarizationService.copySegments(List.of(
                    new SpeakerDiarizationService.AudioSegmentInput(firstAudio, 0, 10, "first"),
                    new SpeakerDiarizationService.AudioSegmentInput(secondAudio, 10, 20, "second")));

            firstAudio[0] = 9;
            secondAudio[0] = 9;
            assertThat(copied).hasSize(2);
            assertThat(copied.get(0).audioBytes()).containsExactly(1);
            assertThat(copied.get(1).audioBytes()[0]).isEqualTo((byte) 2);
        }

        @Test
        @DisplayName("batch copy rejects aggregate overflow before creating segment copies")
        void copySegments_rejectsAggregateOverflow() {
            byte[] firstAudio = new byte[(int) (SpeakerDiarizationService.MAX_TOTAL_AUDIO_BYTES / 2)];
            byte[] secondAudio = new byte[firstAudio.length + 1];
            var providerCalls = new java.util.concurrent.atomic.AtomicInteger();
            var service = SpeakerDiarizationService.builder()
                    .embeddingExtractor(bytes -> { providerCalls.incrementAndGet(); return new float[] {1}; })
                    .admission(() -> true)
                    .build();

            org.assertj.core.api.Assertions.assertThatThrownBy(() -> service.diarizeInputs(List.of(
                            new SpeakerDiarizationService.AudioSegmentInput(firstAudio, 0, 10, "first"),
                            new SpeakerDiarizationService.AudioSegmentInput(secondAudio, 10, 20, "second"))))
                    .isInstanceOf(SpeakerDiarizationService.DiarizationException.class)
                    .hasMessageStartingWith("STT_DIARIZATION_INPUT_TOO_LARGE:");
            assertThat(providerCalls).hasValue(0);
        }

        @Test
        @DisplayName("batch copy rejects too many inputs before creating segment copies")
        void copySegments_rejectsExcessiveSegmentCount() {
            var input = new SpeakerDiarizationService.AudioSegmentInput(new byte[] {1}, 0, 1, "x");
            List<SpeakerDiarizationService.AudioSegmentInput> inputs = Collections.nCopies(
                    SpeakerDiarizationService.MAX_SEGMENTS_PER_REQUEST + 1, input);

            org.assertj.core.api.Assertions.assertThatThrownBy(() -> SpeakerDiarizationService.copySegments(inputs))
                    .isInstanceOf(SpeakerDiarizationService.DiarizationException.class)
                    .hasMessageStartingWith("STT_DIARIZATION_SEGMENT_LIMIT:");
        }

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
        @DisplayName("rechecks trusted admission before every embedding dispatch")
        void diarize_rechecksAdmissionForEachSegment() {
            var admissionChecks = new java.util.concurrent.atomic.AtomicInteger();
            var providerCalls = new java.util.concurrent.atomic.AtomicInteger();
            SpeakerDiarizationService service = SpeakerDiarizationService.builder()
                    .embeddingExtractor(bytes -> { providerCalls.incrementAndGet(); return new float[]{1}; })
                    .admission(() -> admissionChecks.incrementAndGet() <= 2)
                    .build();

            org.assertj.core.api.Assertions.assertThatThrownBy(() -> service.diarize(List.of(
                            new SpeakerDiarizationService.AudioSegment(new byte[]{1}, 0, 10, "x"),
                            new SpeakerDiarizationService.AudioSegment(new byte[]{2}, 10, 20, "y"))))
                    .isInstanceOf(SpeakerDiarizationService.DiarizationException.class)
                    .hasMessage("STT_DIARIZATION_NOT_ADMITTED: trusted rights and purpose admission is unavailable");
            assertThat(admissionChecks).hasValue(3);
            assertThat(providerCalls).hasValue(1);
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
        @DisplayName("overlapping turns never reuse an active anonymous speaker label")
        void overlappingTurnsDoNotShareActiveSpeakerLabel() {
            var service = SpeakerDiarizationService.builder()
                    .embeddingExtractor(bytes -> new float[] {1.0f, 0.0f})
                    .admission(() -> true) // test fixture; no production rights authority is wired
                    .maxSpeakers(2)
                    .similarityThreshold(0.8)
                    .build();

            var turns = service.diarize(List.of(
                    new SpeakerDiarizationService.AudioSegment(new byte[] {1}, 0, 1000, "first"),
                    new SpeakerDiarizationService.AudioSegment(new byte[] {2}, 500, 1500, "overlap")));

            assertThat(turns).extracting(SpeakerDiarizationService.SpeakerTurn::speakerId)
                    .containsExactly("SPEAKER_0", "SPEAKER_1");
        }

        @Test
        @DisplayName("adjacent turns may reuse an anonymous speaker label at the exact endpoint")
        void adjacentTurnsReuseSpeakerLabelAtExactEndpoint() {
            var service = SpeakerDiarizationService.builder()
                    .embeddingExtractor(bytes -> new float[] {1.0f, 0.0f})
                    .admission(() -> true) // test fixture; no production rights authority is wired
                    .maxSpeakers(1)
                    .similarityThreshold(0.8)
                    .build();

            var turns = service.diarize(List.of(
                    new SpeakerDiarizationService.AudioSegment(new byte[] {1}, 0, 1000, "first"),
                    new SpeakerDiarizationService.AudioSegment(new byte[] {2}, 1000, 1500, "adjacent")));

            assertThat(turns).extracting(SpeakerDiarizationService.SpeakerTurn::speakerId)
                    .containsExactly("SPEAKER_0", "SPEAKER_0");
        }

        @Test
        @DisplayName("chooses an available matching label when the closest label is still active")
        void choosesAvailableSpeakerWhenClosestSpeakerOverlaps() {
            var service = SpeakerDiarizationService.builder()
                    .embeddingExtractor(bytes -> switch (bytes[0]) {
                        case 1 -> new float[] {1.0f, 0.0f};
                        case 2 -> new float[] {0.8f, 0.6f};
                        default -> new float[] {0.95f, 0.31225f};
                    })
                    .admission(() -> true) // test fixture; no production rights authority is wired
                    .maxSpeakers(2)
                    .similarityThreshold(0.9)
                    .build();

            var turns = service.diarize(List.of(
                    new SpeakerDiarizationService.AudioSegment(new byte[] {1}, 0, 2000, "first"),
                    new SpeakerDiarizationService.AudioSegment(new byte[] {2}, 500, 1000, "overlap"),
                    new SpeakerDiarizationService.AudioSegment(new byte[] {3}, 1000, 1500, "available")));

            assertThat(turns).extracting(SpeakerDiarizationService.SpeakerTurn::speakerId)
                    .containsExactly("SPEAKER_0", "SPEAKER_1", "SPEAKER_1");
        }

        @Test
        @DisplayName("overlapping matching turn fails closed when no anonymous label is available")
        void overlappingTurnAtSpeakerCapFailsClosed() {
            var service = SpeakerDiarizationService.builder()
                    .embeddingExtractor(bytes -> new float[] {1.0f, 0.0f})
                    .admission(() -> true) // test fixture; no production rights authority is wired
                    .maxSpeakers(1)
                    .similarityThreshold(0.8)
                    .build();

            org.assertj.core.api.Assertions.assertThatThrownBy(() -> service.diarize(List.of(
                            new SpeakerDiarizationService.AudioSegment(new byte[] {1}, 0, 1000, "first"),
                            new SpeakerDiarizationService.AudioSegment(new byte[] {2}, 500, 1500, "overlap"))))
                    .isInstanceOf(SpeakerDiarizationService.DiarizationException.class)
                    .hasMessageContaining("STT_DIARIZATION_SPEAKER_LIMIT_EXCEEDED");
        }

        @Test
        @DisplayName("inconsistent provider embedding dimensions fail with typed provider error")
        void inconsistentEmbeddingDimensionsFailBeforeReturningTurns() {
            var extractionCount = new java.util.concurrent.atomic.AtomicInteger();
            var service = SpeakerDiarizationService.builder()
                    .embeddingExtractor(bytes -> extractionCount.getAndIncrement() == 0
                            ? new float[] {1.0f, 0.0f}
                            : new float[] {1.0f})
                    .admission(() -> true) // test fixture; no production rights authority is wired
                    .build();

            org.assertj.core.api.Assertions.assertThatThrownBy(() -> service.diarize(List.of(
                            new SpeakerDiarizationService.AudioSegment(new byte[] {1}, 0, 100, "first"),
                            new SpeakerDiarizationService.AudioSegment(new byte[] {2}, 100, 200, "second"))))
                    .isInstanceOf(SpeakerDiarizationService.DiarizationException.class)
                    .hasMessageStartingWith("STT_DIARIZATION_PROVIDER_INVALID:");
            org.assertj.core.api.Assertions.assertThat(extractionCount).hasValue(2);
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
        @DisplayName("one-day source timeline boundary is accepted")
        void oneDayTimelineBoundaryIsAccepted() {
            var service = SpeakerDiarizationService.builder()
                    .embeddingExtractor(bytes -> new float[] {1.0f})
                    .admission(() -> true)
                    .build();

            var turns = service.diarize(List.of(new SpeakerDiarizationService.AudioSegment(
                    new byte[] {1}, 0, SpeakerDiarizationService.MAX_TIMELINE_DURATION_MILLIS, "boundary")));

            assertThat(turns).hasSize(1).first().satisfies(turn -> {
                assertThat(turn.startMs()).isZero();
                assertThat(turn.endMs()).isEqualTo(SpeakerDiarizationService.MAX_TIMELINE_DURATION_MILLIS);
            });
        }

        @Test
        @DisplayName("timeline beyond the PDP duration bound fails before embedding dispatch")
        void timelineOverOneDayFailsBeforeProvider() {
            var providerCalls = new java.util.concurrent.atomic.AtomicInteger();
            var service = SpeakerDiarizationService.builder()
                    .embeddingExtractor(bytes -> { providerCalls.incrementAndGet(); return new float[] {1}; })
                    .admission(() -> true)
                    .build();
            var segment = new SpeakerDiarizationService.AudioSegment(new byte[] {1}, 0,
                    SpeakerDiarizationService.MAX_TIMELINE_DURATION_MILLIS + 1, "over-bound");

            org.assertj.core.api.Assertions.assertThatThrownBy(() -> service.diarize(List.of(segment)))
                    .isInstanceOf(SpeakerDiarizationService.DiarizationException.class)
                    .hasMessageStartingWith("STT_DIARIZATION_TIMELINE_LIMIT:");
            assertThat(providerCalls).hasValue(0);
        }

        @Test
        @DisplayName("borrowed-input copy rejects timeline overflow before creating segment copies")
        void copySegmentsRejectsTimelineOverOneDay() {
            var input = new SpeakerDiarizationService.AudioSegmentInput(new byte[] {1}, 0,
                    SpeakerDiarizationService.MAX_TIMELINE_DURATION_MILLIS + 1, "over-bound");

            org.assertj.core.api.Assertions.assertThatThrownBy(() ->
                            SpeakerDiarizationService.copySegments(List.of(input)))
                    .isInstanceOf(SpeakerDiarizationService.DiarizationException.class)
                    .hasMessageStartingWith("STT_DIARIZATION_TIMELINE_LIMIT:");
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
        @DisplayName("aggregate audio over the STT byte budget fails before provider dispatch")
        void diarize_aggregateAudioLimitFailsBeforeProvider() {
            var providerCalls = new java.util.concurrent.atomic.AtomicInteger();
            var service = SpeakerDiarizationService.builder()
                    .embeddingExtractor(bytes -> { providerCalls.incrementAndGet(); return new float[] {1}; })
                    .admission(() -> true)
                    .build();
            int halfLimit = (int) (SpeakerDiarizationService.MAX_TOTAL_AUDIO_BYTES / 2);
            var segments = List.of(
                    new SpeakerDiarizationService.AudioSegment(new byte[halfLimit], 0, 100, "first"),
                    new SpeakerDiarizationService.AudioSegment(new byte[halfLimit + 2], 100, 200, "second"));

            org.assertj.core.api.Assertions.assertThatThrownBy(() -> service.diarize(segments))
                    .isInstanceOf(SpeakerDiarizationService.DiarizationException.class)
                    .hasMessageStartingWith("STT_DIARIZATION_INPUT_TOO_LARGE:");
            assertThat(providerCalls).hasValue(0);
        }

        @Test
        @DisplayName("excessive segment count fails before provider dispatch")
        void diarize_segmentCountLimitFailsBeforeProvider() {
            var providerCalls = new java.util.concurrent.atomic.AtomicInteger();
            var service = SpeakerDiarizationService.builder()
                    .embeddingExtractor(bytes -> { providerCalls.incrementAndGet(); return new float[] {1}; })
                    .admission(() -> true)
                    .build();
            var segment = new SpeakerDiarizationService.AudioSegment(new byte[] {1, 2}, 0, 1, "x");
            List<SpeakerDiarizationService.AudioSegment> segments = Collections.nCopies(
                    SpeakerDiarizationService.MAX_SEGMENTS_PER_REQUEST + 1, segment);

            org.assertj.core.api.Assertions.assertThatThrownBy(() -> service.diarize(segments))
                    .isInstanceOf(SpeakerDiarizationService.DiarizationException.class)
                    .hasMessageStartingWith("STT_DIARIZATION_SEGMENT_LIMIT:");
            assertThat(providerCalls).hasValue(0);
        }

        @Test
        @DisplayName("caller list mutation after dispatch cannot change the validated request")
        void diarize_snapshotsSegmentsBeforeProviderDispatch() {
            var segments = new java.util.ArrayList<>(List.of(
                    new SpeakerDiarizationService.AudioSegment(new byte[] {1, 2}, 0, 10, "first"),
                    new SpeakerDiarizationService.AudioSegment(new byte[] {3, 4}, 10, 20, "second")));
            var providerCalls = new java.util.concurrent.atomic.AtomicInteger();
            var service = SpeakerDiarizationService.builder()
                    .embeddingExtractor(bytes -> {
                        if (providerCalls.incrementAndGet() == 1) segments.clear();
                        return new float[] {1};
                    })
                    .admission(() -> true)
                    .build();

            List<SpeakerDiarizationService.SpeakerTurn> turns = service.diarize(segments);

            assertThat(providerCalls).hasValue(2);
            assertThat(segments).isEmpty();
            assertThat(turns).hasSize(2)
                    .extracting(SpeakerDiarizationService.SpeakerTurn::text)
                    .containsExactly("first", "second");
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
        @DisplayName("audio bytes are isolated from caller mutation before and after construction")
        void audioSegment_audioBytesAreDefensivelyCopied() {
            byte[] input = new byte[] {1, 2, 3};
            var segment = new SpeakerDiarizationService.AudioSegment(input, 0, 100, "t");

            input[0] = 9;
            assertThat(segment.audioBytes()).containsExactly(1, 2, 3);

            byte[] returned = segment.audioBytes();
            returned[1] = 8;
            assertThat(segment.audioBytes()).containsExactly(1, 2, 3);
        }

        @Test
        @DisplayName("oversized audio is rejected before the segment takes a defensive copy")
        void audioSegment_rejectsOversizedInput() {
            byte[] oversized = new byte[Math.toIntExact(SpeakerDiarizationService.MAX_TOTAL_AUDIO_BYTES + 1)];
            assertThatIllegalArgumentException()
                    .isThrownBy(() -> new SpeakerDiarizationService.AudioSegment(oversized, 0, 100, "t"))
                    .withMessageContaining("exceeds the STT audio input limit");
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
