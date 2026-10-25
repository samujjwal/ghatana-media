package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaTimebase.ClockDomain;
import com.ghatana.media.runtime.MediaTimebase.Timestamp;
import org.junit.jupiter.api.Test;

import java.math.RoundingMode;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaTimebaseTest {

    @Test
    void ratesAreCanonicalizedToLowestTerms() {
        assertThat(new MediaTimebase(60_000, 2_002)).isEqualTo(MediaTimebase.NTSC_29_97);
        assertThat(new MediaTimebase(180_000, 2)).isEqualTo(MediaTimebase.MPEG_TS_90KHZ);
    }

    @Test
    void invalidRatesAndNegativeTicksAreRejected() {
        assertThatThrownBy(() -> new MediaTimebase(0, 1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MediaTimebase(1, 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MediaTimebase(-3, 2)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MediaTimebase.MPEG_TS_90KHZ.nanosForTicks(-1, RoundingMode.HALF_EVEN))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MediaTimebase.MPEG_TS_90KHZ.ticksForNanos(-1, RoundingMode.HALF_EVEN))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void exactConversionsUseIntegerResultsUnderUnnecessaryRounding() {
        // 90 kHz MPEG-TS: 90,000 ticks == exactly 1 second.
        assertThat(MediaTimebase.MPEG_TS_90KHZ.nanosForTicks(90_000, RoundingMode.UNNECESSARY))
                .isEqualTo(1_000_000_000L);
        // 48 kHz audio: 48 ticks == exactly 1 millisecond.
        assertThat(MediaTimebase.AUDIO_48KHZ.nanosForTicks(48, RoundingMode.UNNECESSARY))
                .isEqualTo(1_000_000L);
        // NTSC: 30,000 ticks == exactly 1,001 seconds.
        assertThat(MediaTimebase.NTSC_29_97.nanosForTicks(30_000, RoundingMode.UNNECESSARY))
                .isEqualTo(1_001L * 1_000_000_000L);
        assertThat(MediaTimebase.MPEG_TS_90KHZ.ticksForNanos(1_000_000_000L, RoundingMode.UNNECESSARY))
                .isEqualTo(90_000);
    }

    @Test
    void unnecessaryRoundingFailsClosedOnInexactResults() {
        // 1 NTSC tick is 1001/30000 s — not an integral number of nanoseconds.
        assertThatThrownBy(() -> MediaTimebase.NTSC_29_97.nanosForTicks(1, RoundingMode.UNNECESSARY))
                .isInstanceOf(ArithmeticException.class);
        assertThatThrownBy(() -> MediaTimebase.NTSC_29_97.ticksForNanos(1, RoundingMode.UNNECESSARY))
                .isInstanceOf(ArithmeticException.class);
    }

    @Test
    void ntscTickDurationIsDeclaredRoundingNotFloat() {
        // 1 NTSC frame = 1001/30000 s = 33,366,700 ns exactly? 1001/30000 s = 33,366,666.67 ns.
        // HALF_EVEN must round to 33,366,667 ns — and this value is computed rationally, not via double.
        assertThat(MediaTimebase.NTSC_29_97.nanosForTicks(1, RoundingMode.HALF_EVEN))
                .isEqualTo(33_366_667L);
        assertThat(MediaTimebase.NTSC_29_97.nanosForTicks(1, RoundingMode.FLOOR))
                .isEqualTo(33_366_666L);
    }

    @Test
    void crossTimebaseResamplingPreservesTheInstantWithinDeclaredTolerance() {
        // Resample every NTSC frame tick of a 3-hour stream into 90 kHz and back:
        // forward loss is bounded by 1 target tick per declared HALF_EVEN rounding.
        MediaTimebase ntsc = MediaTimebase.NTSC_29_97;
        long threeHourNtscTicks = 30_000L * 3 * 3_600 / 1_001; // ~323,676 ticks at 29.97 fps
        for (long frame = 0; frame <= threeHourNtscTicks; frame += 997) {
            long ts90k = ntsc.convertTicks(frame, MediaTimebase.MPEG_TS_90KHZ, RoundingMode.HALF_EVEN);
            long back = MediaTimebase.MPEG_TS_90KHZ.convertTicks(ts90k, ntsc, RoundingMode.HALF_EVEN);
            assertThat(Math.abs(back - frame))
                    .as("round-trip frame %d", frame)
                    .isLessThanOrEqualTo(1);
        }
    }

    @Test
    void largeOffsetsRoundTripWithoutOverflow() {
        // ~292 years of nanoseconds near long range must not silently overflow.
        long hugeNanos = Long.MAX_VALUE - 1_000_000_000L;
        long ticks = MediaTimebase.MPEG_TS_90KHZ.ticksForNanos(hugeNanos, RoundingMode.FLOOR);
        assertThat(ticks).isPositive();
        // Values whose product exceeds long range are computed exactly via BigInteger; the
        // declared round-trip tolerance is one 90 kHz tick (~11,112 ns).
        long nanos = MediaTimebase.MPEG_TS_90KHZ.nanosForTicks(ticks, RoundingMode.FLOOR);
        assertThat(Math.abs(nanos - hugeNanos)).isLessThanOrEqualTo(12_000L);
    }

    @Test
    void outOfRangeResultsThrowInsteadOfWrapping() {
        // Long.MAX_VALUE ticks at 90 kHz is ~2.9e14 seconds — nanos overflow a long.
        assertThatThrownBy(() -> MediaTimebase.MPEG_TS_90KHZ.nanosForTicks(
                Long.MAX_VALUE, RoundingMode.HALF_EVEN))
                .isInstanceOf(ArithmeticException.class);
    }

    @Test
    void timestampsCarryClockDomainAndResampleWithinItOnly() {
        Timestamp sourceTick = MediaTimebase.MPEG_TS_90KHZ.timestamp(90_000, ClockDomain.SOURCE);
        Timestamp mediaTick = sourceTick.resample(MediaTimebase.NANOS, RoundingMode.UNNECESSARY);
        assertThat(mediaTick.ticks()).isEqualTo(1_000_000_000L);
        assertThat(mediaTick.domain()).isEqualTo(ClockDomain.SOURCE);

        Timestamp wallTick = new Timestamp(MediaTimebase.NANOS, 1_000_000_000L, ClockDomain.WALL);
        assertThatThrownBy(() -> mediaTick.ticksUntil(wallTick))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("clock domains");
    }

    @Test
    void ticksUntilRejectsMixedTimebasesAndComputesDeltas() {
        Timestamp t1 = MediaTimebase.AUDIO_48KHZ.timestamp(48_000, ClockDomain.MEDIA);
        Timestamp t2 = MediaTimebase.AUDIO_48KHZ.timestamp(96_000, ClockDomain.MEDIA);
        assertThat(t1.ticksUntil(t2)).isEqualTo(48_000);

        Timestamp otherBase = MediaTimebase.MPEG_TS_90KHZ.timestamp(90_000, ClockDomain.MEDIA);
        assertThatThrownBy(() -> t1.ticksUntil(otherBase))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("different timebases");
    }

    @Test
    void forwardBackNanosRoundTripStaysWithinOneTick() {
        // For any large tick count whose nanos still fit a long, ticks -> nanos -> ticks
        // loses at most one source tick. 2e11 NTSC ticks is ~7,700 days.
        for (long ticks : new long[] {1, 999, 1_000_000_000L, 200_000_000_000L}) {
            long nanos = MediaTimebase.NTSC_29_97.nanosForTicks(ticks, RoundingMode.HALF_EVEN);
            long back = MediaTimebase.NTSC_29_97.ticksForNanos(nanos, RoundingMode.HALF_EVEN);
            assertThat(Math.abs(back - ticks)).isLessThanOrEqualTo(1);
        }
    }
}
