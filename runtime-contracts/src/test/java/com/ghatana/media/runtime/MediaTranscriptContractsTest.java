package com.ghatana.media.runtime;

import java.util.AbstractList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaTranscriptContractsTest {
    @Test
    void transcriptPurposeBindingsRespectPersistedCharacterBounds() {
        var valid = transcriptDraft("urn:media:purpose:transcription", "transcription");
        assertThat(valid.purposeRef()).isEqualTo("urn:media:purpose:transcription");
        assertThat(valid.processingPurpose()).isEqualTo("transcription");

        assertThat(transcriptDraft("x".repeat(256), "p".repeat(255)).purposeRef()).hasSize(256);
        assertThat(transcriptDraft("😀".repeat(256), "transcription").purposeRef()).isEqualTo("😀".repeat(256));
        assertThatThrownBy(() -> transcriptDraft("😀".repeat(257), "transcription"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("purposeRef");
        assertThatThrownBy(() -> transcriptDraft("x".repeat(257), "transcription"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("purposeRef");
        assertThatThrownBy(() -> transcriptDraft("urn:media:purpose:transcription", "p".repeat(256)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("processingPurpose");
    }

    @Test
    void alignmentTranslationAndCaptionRegistrationAreTypedNoEffectUntilQualified() {
        for (var capability : MediaTranscriptContracts.TranscriptDerivedCapability.values()) {
            var result = MediaTranscriptContracts.unavailableCapability(capability);
            assertThat(result.capability()).isEqualTo(capability);
            assertThat(result.disposition()).isEqualTo(
                    MediaTranscriptContracts.TranscriptCapabilityDisposition.UNMET_CAPABILITY);
            assertThat(result.blockers()).isNotEmpty();
            assertThat(result.effectOccurred()).isFalse();
        }
    }

    @Test
    void unavailableCapabilityCannotClaimAnEffectOrOmitItsReason() {
        assertThatThrownBy(() -> new MediaTranscriptContracts.TranscriptCapabilityResult(
                MediaTranscriptContracts.TranscriptDerivedCapability.CAPTION_VERSION_REGISTRATION,
                MediaTranscriptContracts.TranscriptCapabilityDisposition.UNMET_CAPABILITY,
                java.util.List.of(), false))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MediaTranscriptContracts.TranscriptCapabilityResult(
                MediaTranscriptContracts.TranscriptDerivedCapability.CAPTION_VERSION_REGISTRATION,
                MediaTranscriptContracts.TranscriptCapabilityDisposition.UNMET_CAPABILITY, java.util.List.of(
                        MediaTranscriptContracts.TranscriptCapabilityBlocker.CANONICAL_TRANSCRIPT_VERSION_UNAVAILABLE),
                true))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void transcriptDraftRejectsUnderreportedSegmentListBeforeConsumingItem4097() {
        AtomicInteger consumed = new AtomicInteger();
        List<MediaTranscriptContracts.TranscriptSegment> hostile = underreportedList(segment(), consumed);

        assertThatThrownBy(() -> transcriptDraftWithSegments(hostile))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("bounded ordered array");
        assertThat(consumed).hasValue(4096);
    }

    @Test
    void parameterParserRejectsUnderreportedSegmentListBeforeConsumingItem4097() {
        AtomicInteger consumed = new AtomicInteger();
        Map<String, Object> segment = Map.of(
                "segmentId", "segment-1", "text", "hello", "origin", "RECOGNIZED",
                "timing", Map.of("tag", "NOT_SUPPLIED"));

        assertThatThrownBy(() -> MediaTranscriptContracts.segmentsFromParameterValue(
                underreportedList(segment, consumed)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("bounded ordered array");
        assertThat(consumed).hasValue(4096);
    }

    @Test
    void parameterProjectionRejectsUnderreportedSegmentListBeforeConsumingItem4097() {
        AtomicInteger consumed = new AtomicInteger();

        assertThatThrownBy(() -> MediaTranscriptContracts.segmentsToParametersValue(
                underreportedList(segment(), consumed)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("bounded ordered array");
        assertThat(consumed).hasValue(4096);
    }

    private static MediaTranscriptContracts.TranscriptDraft transcriptDraft(String purposeRef, String purpose) {
        return transcriptDraftWithSegments(purposeRef, purpose, List.of());
    }

    private static MediaTranscriptContracts.TranscriptDraft transcriptDraftWithSegments(
            List<MediaTranscriptContracts.TranscriptSegment> segments) {
        return transcriptDraftWithSegments("urn:media:purpose:transcription", "transcription", segments);
    }

    private static MediaTranscriptContracts.TranscriptDraft transcriptDraftWithSegments(
            String purposeRef, String purpose, List<MediaTranscriptContracts.TranscriptSegment> segments) {
        String digest = "a".repeat(64);
        return new MediaTranscriptContracts.TranscriptDraft(
                "tenant", "principal", "transcript", "artifact", "sha256:" + digest, digest,
                "job", "profile", "provider", "model", "en-US", "milliseconds", "text",
                "consent", "rights", "policy", purposeRef, purpose, segments);
    }

    private static MediaTranscriptContracts.TranscriptSegment segment() {
        return new MediaTranscriptContracts.TranscriptSegment("segment-1", "hello", "RECOGNIZED",
                MediaTranscriptContracts.TranscriptSegmentTiming.notSupplied());
    }

    private static <T> List<T> underreportedList(T value, AtomicInteger consumed) {
        return new AbstractList<>() {
            @Override
            public T get(int index) {
                throw new AssertionError("bounded iterator should be used instead of indexed traversal");
            }

            @Override
            public int size() {
                return 0;
            }

            @Override
            public Iterator<T> iterator() {
                return new Iterator<>() {
                    private int index;

                    @Override
                    public boolean hasNext() {
                        return index < 4097;
                    }

                    @Override
                    public T next() {
                        if (!hasNext()) throw new java.util.NoSuchElementException();
                        index++;
                        consumed.incrementAndGet();
                        return value;
                    }
                };
            }
        };
    }
}
