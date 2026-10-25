package com.ghatana.audio.video.multimodal.engine;

import java.math.BigInteger;

/**
 * Deterministic rational source-to-media conversion using caller-supplied mapping parameters.
 * This utility does not estimate, validate, or measure synchronization and is not wired to a
 * production request; temporal alignment remains {@code SYNC_UNDETERMINED} without admitted
 * source mapping and signal evidence.
 */
public record MediaClockMapping(long scaleNumerator, long scaleDenominator, long offsetMs,
                                long maximumAbsoluteOffsetMs) {
    public MediaClockMapping {
        if (scaleNumerator <= 0 || scaleDenominator <= 0 || scaleNumerator > 1_000_000_000L
                || scaleDenominator > 1_000_000_000L || maximumAbsoluteOffsetMs < 0
                || absExceeds(offsetMs, maximumAbsoluteOffsetMs)) {
            throw new IllegalArgumentException("Clock mapping must be positive, rational and within its offset bound");
        }
    }

    public MediaClockTimestamp map(MediaClockTimestamp source, MediaClockTimestamp previousSource) {
        if (source == null || !source.isKnown() || source.domain() != MediaClockTimestamp.ClockDomain.SOURCE) {
            return MediaClockTimestamp.unknown("SOURCE_TIMESTAMP_UNAVAILABLE");
        }
        if (!source.hasClockIdentity()) {
            return MediaClockTimestamp.unknown("SOURCE_CLOCK_ID_UNAVAILABLE");
        }
        if (previousSource != null && previousSource.isKnown()) {
            if (previousSource.domain() != source.domain()
                    || !previousSource.hasClockIdentity()
                    || !previousSource.clockId().equals(source.clockId())) {
                return MediaClockTimestamp.unknown("SOURCE_CLOCK_MISMATCH");
            }
        }
        if (previousSource != null && previousSource.isKnown()
                && compareTicks(source, previousSource) < 0) {
            return MediaClockTimestamp.unknown("SOURCE_CLOCK_DISCONTINUITY");
        }
        try {
            BigInteger numerator = BigInteger.valueOf(source.ticks())
                    .multiply(BigInteger.valueOf(source.timeBaseNumerator()))
                    .multiply(BigInteger.valueOf(1000))
                    .multiply(BigInteger.valueOf(scaleNumerator));
            BigInteger denominator = BigInteger.valueOf(source.timeBaseDenominator())
                    .multiply(BigInteger.valueOf(scaleDenominator));
            BigInteger[] division = numerator.divideAndRemainder(denominator);
            BigInteger rounded = division[0];
            if (division[1].abs().shiftLeft(1).compareTo(denominator) >= 0) {
                rounded = rounded.add(BigInteger.valueOf(numerator.signum()));
            }
            return MediaClockTimestamp.mediaMilliseconds(
                    rounded.add(BigInteger.valueOf(offsetMs)).longValueExact());
        } catch (ArithmeticException overflow) {
            return MediaClockTimestamp.unknown("MAPPED_TIMESTAMP_OUT_OF_RANGE");
        }
    }

    private static int compareTicks(MediaClockTimestamp left, MediaClockTimestamp right) {
        BigInteger a = BigInteger.valueOf(left.ticks()).multiply(BigInteger.valueOf(left.timeBaseNumerator()))
                .multiply(BigInteger.valueOf(right.timeBaseDenominator()));
        BigInteger b = BigInteger.valueOf(right.ticks()).multiply(BigInteger.valueOf(right.timeBaseNumerator()))
                .multiply(BigInteger.valueOf(left.timeBaseDenominator()));
        return a.compareTo(b);
    }

    private static boolean absExceeds(long value, long bound) {
        return BigInteger.valueOf(value).abs().compareTo(BigInteger.valueOf(bound)) > 0;
    }
}
