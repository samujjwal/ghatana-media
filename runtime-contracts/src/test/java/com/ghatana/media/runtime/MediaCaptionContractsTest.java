package com.ghatana.media.runtime;

import static com.ghatana.media.runtime.MediaCaptionContracts.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.AbstractList;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class MediaCaptionContractsTest {
    @Test
    void registrationRequestRejectsDeclaredOversizeBeforeTraversingInput() {
        AtomicInteger reads = new AtomicInteger();

        assertInvalidRequestBeforeRead(() -> request(oversizedWithoutTraversal(reads)));

        assertThat(reads).hasValue(0);
    }

    @Test
    void captionSnapshotRejectsDeclaredOversizeBeforeTraversingInput() {
        AtomicInteger reads = new AtomicInteger();
        List<CaptionSegment> hostile = oversizedWithoutTraversal(reads);

        assertInvalidRequestBeforeRead(() -> new CaptionVersionSnapshot(
                "request-1", "a".repeat(64), "caption-v1", "receipt-1", "artifact-1", "source-v1",
                ParentVersionKind.TRANSCRIPT_VERSION, "transcript-v1", "clock-1", 1_000, 10_000,
                LanguageDisposition.DECLARED_BY_USER, Optional.of("en"), hostile, Optional.empty(), 1));

        assertThat(reads).hasValue(0);
    }

    @Test
    void registrationAndSnapshotKeepBoundedSegmentCopiesImmutable() {
        List<CaptionSegment> input = new ArrayList<>(List.of(
                CaptionSegment.of("segment-1", "hello", 0, 1_000, SegmentOrigin.USER_EDITED)));
        RegistrationRequest request = request(input);
        CaptionVersionSnapshot snapshot = new CaptionVersionSnapshot(
                "request-1", "a".repeat(64), "caption-v1", "receipt-1", "artifact-1", "source-v1",
                ParentVersionKind.TRANSCRIPT_VERSION, "transcript-v1", "clock-1", 1_000, 10_000,
                LanguageDisposition.DECLARED_BY_USER, Optional.of("en"), input, Optional.empty(), 1);
        input.clear();

        assertThat(request.captionSegments()).hasSize(1);
        assertThat(snapshot.captionSegments()).hasSize(1);
        assertThatThrownBy(() -> request.captionSegments().clear()).isInstanceOf(UnsupportedOperationException.class);
        assertThatThrownBy(() -> snapshot.captionSegments().clear()).isInstanceOf(UnsupportedOperationException.class);
    }

    @Test
    void rejectsSegmentListsWhoseDeclaredSizeDoesNotMatchObservedElements() {
        AtomicInteger reads = new AtomicInteger();
        List<CaptionSegment> underreported = new AbstractList<>() {
            @Override public CaptionSegment get(int index) { throw new UnsupportedOperationException(); }
            @Override public int size() { return 0; }
            @Override public java.util.Iterator<CaptionSegment> iterator() {
                java.util.Iterator<CaptionSegment> source = List.of(CaptionSegment.of(
                        "segment-1", "hello", 0, 1_000, SegmentOrigin.USER_EDITED)).iterator();
                return new java.util.Iterator<>() {
                    @Override public boolean hasNext() { return source.hasNext(); }
                    @Override public CaptionSegment next() {
                        reads.incrementAndGet();
                        return source.next();
                    }
                };
            }
        };

        assertThatThrownBy(() -> request(underreported))
                .isInstanceOf(CaptionRegistrationException.class)
                .hasMessageContaining("segment list size does not match observed elements");
        assertThat(reads).hasValue(1);
    }

    private static void assertInvalidRequestBeforeRead(Runnable construction) {
        assertThatThrownBy(construction::run)
                .isInstanceOf(CaptionRegistrationException.class)
                .satisfies(error -> assertThat(((CaptionRegistrationException) error).error())
                        .isEqualTo(RegistrationError.INVALID_REQUEST));
    }

    private static List<CaptionSegment> oversizedWithoutTraversal(AtomicInteger reads) {
        return new AbstractList<>() {
            @Override
            public CaptionSegment get(int index) {
                reads.incrementAndGet();
                throw new AssertionError("oversized caption list must be rejected before element access");
            }

            @Override
            public int size() {
                return Integer.MAX_VALUE;
            }
        };
    }

    private static RegistrationRequest request(List<CaptionSegment> segments) {
        return new RegistrationRequest("request-1", "artifact-1", "source-v1",
                ParentVersionKind.TRANSCRIPT_VERSION, "transcript-v1", "clock-1", 1_000, 10_000,
                LanguageDisposition.DECLARED_BY_USER, Optional.of("en"), segments, Optional.empty());
    }
}
