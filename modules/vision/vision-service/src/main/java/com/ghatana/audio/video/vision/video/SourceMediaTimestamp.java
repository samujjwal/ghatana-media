package com.ghatana.audio.video.vision.video;

import java.math.BigInteger;
import java.util.Objects;

/** Exact source-frame PTS/timebase, with explicit unknown state when either value is unusable. */
public record SourceMediaTimestamp(Status status, Long pts, Long timeBaseNumerator,
        Long timeBaseDenominator, Long timestampMs, String reason) {
    public SourceMediaTimestamp {
        Objects.requireNonNull(status, "status");
        if (status == Status.KNOWN && (pts == null || timeBaseNumerator == null || timeBaseDenominator == null
                || timestampMs == null || timeBaseNumerator <= 0 || timeBaseDenominator <= 0)) {
            throw new IllegalArgumentException("Known media timestamps require PTS, rational timebase, and millis");
        }
        if (status == Status.KNOWN) {
            // The canonical record constructor must enforce the same timebase bounds as the
            // parser factory; callers may construct this public value directly.
            new RationalTimeBase(timeBaseNumerator, timeBaseDenominator);
            if (reason != null) {
                throw new IllegalArgumentException("Known media timestamps must not have an unknown reason");
            }
            long expectedMillis;
            try {
                expectedMillis = toTimestampMillis(pts, timeBaseNumerator, timeBaseDenominator);
            } catch (ArithmeticException overflow) {
                throw new IllegalArgumentException("Known media timestamp millis are outside the supported range", overflow);
            }
            if (timestampMs != expectedMillis) {
                throw new IllegalArgumentException("Known media timestamp millis must match PTS and timebase");
            }
        }
        if (status == Status.UNKNOWN && (pts != null || timeBaseNumerator != null
                || timeBaseDenominator != null || timestampMs != null || reason == null || reason.isBlank())) {
            throw new IllegalArgumentException("Unknown timestamps require a reason and no fabricated values");
        }
    }

    public static SourceMediaTimestamp fromPts(String rawPts, String rawTimeBase) {
        try {
            long pts = Long.parseLong(rawPts.trim());
            RationalTimeBase timeBase = RationalTimeBase.parse(rawTimeBase);
            return new SourceMediaTimestamp(Status.KNOWN, pts, timeBase.numerator(), timeBase.denominator(),
                    toTimestampMillis(pts, timeBase.numerator(), timeBase.denominator()), null);
        } catch (RuntimeException invalid) {
            return unknown(invalid instanceof ArithmeticException ? "TIMESTAMP_OUT_OF_RANGE" : "INVALID_PTS_OR_TIMEBASE");
        }
    }

    public static SourceMediaTimestamp unknown(String reason) {
        return new SourceMediaTimestamp(Status.UNKNOWN, null, null, null, null, reason);
    }

    public boolean isKnown() { return status == Status.KNOWN; }

    public static RationalTimeBase parseTimeBase(String value) {
        return RationalTimeBase.parse(value);
    }

    private static long toTimestampMillis(long pts, long timeBaseNumerator, long timeBaseDenominator) {
        BigInteger numerator = BigInteger.valueOf(pts)
                .multiply(BigInteger.valueOf(timeBaseNumerator))
                .multiply(BigInteger.valueOf(1000));
        BigInteger denominator = BigInteger.valueOf(timeBaseDenominator);
        BigInteger[] division = numerator.divideAndRemainder(denominator);
        BigInteger millis = division[0];
        if (division[1].abs().shiftLeft(1).compareTo(denominator) >= 0) {
            millis = millis.add(BigInteger.valueOf(numerator.signum()));
        }
        return millis.longValueExact();
    }

    public enum Status { KNOWN, UNKNOWN }

    public record RationalTimeBase(long numerator, long denominator) {
        public RationalTimeBase {
            if (numerator <= 0 || denominator <= 0 || numerator > 1_000_000_000L
                    || denominator > 1_000_000_000L) {
                throw new IllegalArgumentException("Media timebase must be a positive bounded rational");
            }
        }

        public static RationalTimeBase parse(String value) {
            if (value == null) throw new IllegalArgumentException("Media timebase is missing");
            String[] parts = value.trim().split("/", -1);
            if (parts.length != 2) throw new IllegalArgumentException("Media timebase must be numerator/denominator");
            return new RationalTimeBase(Long.parseLong(parts[0]), Long.parseLong(parts[1]));
        }
    }
}
