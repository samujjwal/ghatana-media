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
        if (status == Status.UNKNOWN && (pts != null || timeBaseNumerator != null
                || timeBaseDenominator != null || timestampMs != null || reason == null || reason.isBlank())) {
            throw new IllegalArgumentException("Unknown timestamps require a reason and no fabricated values");
        }
    }

    public static SourceMediaTimestamp fromPts(String rawPts, String rawTimeBase) {
        try {
            long pts = Long.parseLong(rawPts.trim());
            RationalTimeBase timeBase = RationalTimeBase.parse(rawTimeBase);
            BigInteger numerator = BigInteger.valueOf(pts)
                    .multiply(BigInteger.valueOf(timeBase.numerator()))
                    .multiply(BigInteger.valueOf(1000));
            BigInteger denominator = BigInteger.valueOf(timeBase.denominator());
            BigInteger[] division = numerator.divideAndRemainder(denominator);
            BigInteger millis = division[0];
            if (division[1].abs().shiftLeft(1).compareTo(denominator) >= 0) {
                millis = millis.add(BigInteger.valueOf(numerator.signum()));
            }
            return new SourceMediaTimestamp(Status.KNOWN, pts, timeBase.numerator(), timeBase.denominator(),
                    millis.longValueExact(), null);
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
