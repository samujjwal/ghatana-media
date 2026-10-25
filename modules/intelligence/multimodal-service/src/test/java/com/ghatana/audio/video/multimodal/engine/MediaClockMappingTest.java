package com.ghatana.audio.video.multimodal.engine;

import com.ghatana.audio.video.vision.video.SourceMediaTimestamp;
import java.util.List;
import java.util.OptionalLong;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaClockMappingTest {
    @Test
    void representableTimestampAccessorsDistinguishUnknownZeroAndOverflow() {
        MediaClockTimestamp unknown = MediaClockTimestamp.unknown("NO_SOURCE_PTS");
        MediaClockTimestamp zero = MediaClockTimestamp.mediaMilliseconds(0);
        MediaClockTimestamp overflow = new MediaClockTimestamp(MediaClockTimestamp.Status.KNOWN,
                Long.MAX_VALUE, Long.MAX_VALUE, 1L, MediaClockTimestamp.ClockDomain.MEDIA,
                "media-ms", null);

        assertTimestampAccessors(unknown, OptionalLong.empty());
        assertTimestampAccessors(zero, OptionalLong.of(0L));
        assertTimestampAccessors(overflow, OptionalLong.empty());
    }

    private static void assertTimestampAccessors(MediaClockTimestamp timestamp, OptionalLong expected) {
        FrameResult frame = new FrameResult(1, timestamp, List.of());
        TemporalAlignment alignment = new TemporalAlignment(timestamp, 1, "", List.of(),
                0L, 0.0, TemporalAlignment.SyncStatus.SYNC_UNDETERMINED);

        assertThat(frame.getRepresentableTimestampMs()).isEqualTo(expected);
        assertThat(alignment.getRepresentableTimestampMs()).isEqualTo(expected);
        if (!timestamp.isKnown()) {
            assertThat(frame.getTimestampMs()).isEqualTo(0L);
            assertThat(alignment.getTimestampMs()).isEqualTo(0L);
        } else if (expected.isPresent()) {
            assertThat(frame.getTimestampMs()).isEqualTo(expected.getAsLong());
            assertThat(alignment.getTimestampMs()).isEqualTo(expected.getAsLong());
        }
    }

    @Test
    void mapsIrregularRationalPtsWithoutAssumingConstantFps() {
        MediaClockMapping mapping = new MediaClockMapping(1, 1, 0, 0);
        MediaClockTimestamp first = MediaClockTimestamp.fromSource(SourceMediaTimestamp.fromPts("3003", "1/90000"), "video-a");
        MediaClockTimestamp second = MediaClockTimestamp.fromSource(SourceMediaTimestamp.fromPts("7500", "1/90000"), "video-a");
        MediaClockTimestamp third = MediaClockTimestamp.fromSource(SourceMediaTimestamp.fromPts("18000", "1/90000"), "video-a");

        assertThat(mapping.map(first, null).toMilliseconds()).isEqualTo(33L);
        assertThat(mapping.map(second, first).toMilliseconds()).isEqualTo(83L);
        assertThat(mapping.map(third, second).toMilliseconds()).isEqualTo(200L);
        assertThat(mapping.map(third, second).toMilliseconds()
                - mapping.map(second, first).toMilliseconds()).isEqualTo(117L);
    }

    @Test
    void mapsExplicitAudioSampleClockWithoutClaimingSynchronization() {
        MediaClockMapping mapping = new MediaClockMapping(1, 1, 0, 0);
        MediaClockTimestamp first = MediaClockTimestamp.audioSamples(48_000, 48_000, "audio-a");
        MediaClockTimestamp second = MediaClockTimestamp.audioSamples(72_000, 48_000, "audio-a");

        assertThat(first.domain()).isEqualTo(MediaClockTimestamp.ClockDomain.SOURCE);
        assertThat(first.timeBaseNumerator()).isEqualTo(1L);
        assertThat(first.timeBaseDenominator()).isEqualTo(48_000L);
        assertThat(mapping.map(first, null).toMilliseconds()).isEqualTo(1_000L);
        assertThat(mapping.map(second, first).toMilliseconds()).isEqualTo(1_500L);

        MediaClockTimestamp otherStream = MediaClockTimestamp.audioSamples(96_000, 48_000, "audio-b");
        MediaClockTimestamp mismatch = mapping.map(otherStream, second);
        assertThat(mismatch.status()).isEqualTo(MediaClockTimestamp.Status.UNKNOWN);
        assertThat(mismatch.unknownReason()).isEqualTo("SOURCE_CLOCK_MISMATCH");
    }

    @Test
    void rejectsInvalidAudioSampleClockDeclarations() {
        assertThatThrownBy(() -> MediaClockTimestamp.audioSamples(1, 0, "audio-a"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MediaClockTimestamp.audioSamples(1, 48_000, " "))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void acceptsEquivalentVariableTimebasesAndAppliesBoundedOffset() {
        MediaClockTimestamp first = MediaClockTimestamp.fromSource(SourceMediaTimestamp.fromPts("25", "1/25"), "video-a");
        MediaClockTimestamp second = MediaClockTimestamp.fromSource(SourceMediaTimestamp.fromPts("2000", "1/2000"), "video-a");
        MediaClockMapping mapping = new MediaClockMapping(1, 1, -7, 7);

        assertThat(mapping.map(first, null).toMilliseconds()).isEqualTo(993L);
        assertThat(mapping.map(second, first).toMilliseconds()).isEqualTo(993L);
        assertThatThrownBy(() -> new MediaClockMapping(1, 1, 8, 7))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void mappingPreservesDriftOffsetAndRejectsClockDiscontinuity() {
        MediaClockTimestamp first = MediaClockTimestamp.fromSource(SourceMediaTimestamp.fromPts("90000", "1/90000"), "video-a");
        MediaClockTimestamp backwards = MediaClockTimestamp.fromSource(SourceMediaTimestamp.fromPts("45000", "1/90000"), "video-a");
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
        assertThat(mapped.unknownReason()).isEqualTo("SOURCE_TIMESTAMP_UNAVAILABLE");
    }

    @Test
    void unscopedSourcePtsIsPreservedButCannotBeComparedOrMapped() {
        MediaClockTimestamp unscoped = MediaClockTimestamp.fromSource(
                SourceMediaTimestamp.fromPts("3003", "1/90000"));

        assertThat(unscoped.isKnown()).isTrue();
        assertThat(unscoped.ticks()).isEqualTo(3003L);
        assertThat(unscoped.hasClockIdentity()).isFalse();
        assertThat(unscoped.sharesClock(MediaClockTimestamp.fromSource(
                SourceMediaTimestamp.fromPts("7500", "1/90000")))).isFalse();
        MediaClockTimestamp mapped = new MediaClockMapping(1, 1, 0, 0).map(unscoped, null);
        assertThat(mapped.status()).isEqualTo(MediaClockTimestamp.Status.UNKNOWN);
        assertThat(mapped.unknownReason()).isEqualTo("SOURCE_CLOCK_ID_UNAVAILABLE");
    }

    @Test
    void sourceClockIdentityChangeIsUnresolvableInsteadOfSilentlyMapped() {
        MediaClockTimestamp previous = MediaClockTimestamp.fromSource(
                SourceMediaTimestamp.fromPts("90000", "1/90000"), "video-a");
        MediaClockTimestamp nextClock = MediaClockTimestamp.fromSource(
                SourceMediaTimestamp.fromPts("93000", "1/90000"), "video-b");

        MediaClockTimestamp result = new MediaClockMapping(1, 1, 0, 0).map(nextClock, previous);
        assertThat(result.status()).isEqualTo(MediaClockTimestamp.Status.UNKNOWN);
        assertThat(result.unknownReason()).isEqualTo("SOURCE_CLOCK_MISMATCH");
    }

    @Test
    void rationalFrameConversionDoesNotAccumulateRoundedPerFrameDrift() {
        MediaClockMapping mapping = new MediaClockMapping(1001, 1000, 0, 0);
        MediaClockTimestamp first = MediaClockTimestamp.fromSource(
                SourceMediaTimestamp.fromPts("0", "1/90000"), "video-a");
        long finalPts = 3003L * 30_000L;
        MediaClockTimestamp finalFrame = MediaClockTimestamp.fromSource(
                SourceMediaTimestamp.fromPts(Long.toString(finalPts), "1/90000"), "video-a");

        assertThat(mapping.map(first, null).toMilliseconds()).isEqualTo(0L);
        // Map absolute rational PTS; 30,000 NTSC-rate frame periods remain the exact declared
        // 1001-second rate conversion, rather than accumulating 30,000 rounded 33ms intervals.
        assertThat(mapping.map(finalFrame, first).toMilliseconds()).isEqualTo(1_002_001L);
    }

    @Test
    void mismatchedClockDomainsAreNotComparable() {
        MediaClockTimestamp source = MediaClockTimestamp.fromSource(SourceMediaTimestamp.fromPts("1000", "1/1000"), "video-a");
        MediaClockTimestamp media = MediaClockTimestamp.mediaMilliseconds(1000);

        assertThat(source.sharesClock(media)).isFalse();
    }
}
