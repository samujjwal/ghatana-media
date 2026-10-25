package com.ghatana.audio.video.multimodal.engine;

import com.ghatana.audio.video.vision.video.SourceMediaTimestamp;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class MediaClockMappingTest {
    @Test
    void mapsRationalVariableFramePtsWithoutAssumingConstantFps() {
        MediaClockMapping mapping = new MediaClockMapping(1, 1, 0, 0);
        MediaClockTimestamp first = MediaClockTimestamp.fromSource(SourceMediaTimestamp.fromPts("3003", "1/90000"));
        MediaClockTimestamp second = MediaClockTimestamp.fromSource(SourceMediaTimestamp.fromPts("6006", "1/90000"));

        assertThat(mapping.map(first, null).toMilliseconds()).isEqualTo(33L);
        assertThat(mapping.map(second, first).toMilliseconds()).isEqualTo(67L);
    }

    @Test
    void mappingPreservesDriftOffsetAndRejectsClockDiscontinuity() {
        MediaClockTimestamp first = MediaClockTimestamp.fromSource(SourceMediaTimestamp.fromPts("90000", "1/90000"));
        MediaClockTimestamp backwards = MediaClockTimestamp.fromSource(SourceMediaTimestamp.fromPts("45000", "1/90000"));
        MediaClockMapping mapping = new MediaClockMapping(1001, 1000, 12, 20);

        assertThat(mapping.map(first, null).toMilliseconds()).isEqualTo(1013L);
        MediaClockTimestamp discontinuity = mapping.map(backwards, first);
        assertThat(discontinuity.status()).isEqualTo(MediaClockTimestamp.Status.UNKNOWN);
        assertThat(discontinuity.unknownReason()).isEqualTo("SOURCE_CLOCK_DISCONTINUITY");
    }

    @Test
    void missingPtsRemainsUnknownAndCannotBeMappedToZero() {
        MediaClockTimestamp unknown = MediaClockTimestamp.fromSource(SourceMediaTimestamp.unknown("NO_SOURCE_PTS"));
        MediaClockTimestamp mapped = new MediaClockMapping(1, 1, 0, 0).map(unknown, null);

        assertThat(mapped.status()).isEqualTo(MediaClockTimestamp.Status.UNKNOWN);
        assertThat(mapped.toMilliseconds()).isNull();
    }

    @Test
    void mismatchedClockDomainsAreNotComparable() {
        MediaClockTimestamp source = MediaClockTimestamp.fromSource(SourceMediaTimestamp.fromPts("1000", "1/1000"));
        MediaClockTimestamp media = MediaClockTimestamp.mediaMilliseconds(1000);

        assertThat(source.sharesClock(media)).isFalse();
    }
}
