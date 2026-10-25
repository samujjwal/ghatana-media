package com.ghatana.media.runtime;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.RoundingMode;

/**
 * Rational media timebase and clock-domain-aware timestamp for canonical Media temporal math.
 *
 * <p>A timebase is a reduced positive rational ticks-per-second rate ({@code numerator/denominator};
 * e.g. {@code 90000/1} MPEG-TS, {@code 30000/1001} NTSC). All tick conversions are computed with
 * exact rational arithmetic over {@link BigInteger} — floating point is never used for canonical
 * offsets. Where a target representation cannot express the exact rational result, the caller must
 * supply a {@link RoundingMode}; {@link RoundingMode#UNNECESSARY} makes inexact conversion a hard
 * failure, which is the preferred mode for reproducibility-critical paths.</p>
 *
 * <p>Timestamps carry a {@link ClockDomain} because tick origins are clock-specific: a source-media
 * tick, a normalized media timeline tick, a simulation tick and a wall-clock tick are not
 * interchangeable. Conversions that would silently mix domains are rejected.</p>
 *
 * @doc.type record
 * @doc.purpose Exact rational temporal conversion for media offsets, sample and frame ticks
 * @doc.layer product
 * @doc.pattern ValueObject
 */
public record MediaTimebase(long numerator, long denominator) {

    public static final MediaTimebase NANOS = new MediaTimebase(1_000_000_000L, 1L);
    public static final MediaTimebase MPEG_TS_90KHZ = new MediaTimebase(90_000L, 1L);
    public static final MediaTimebase NTSC_29_97 = new MediaTimebase(30_000L, 1_001L);
    public static final MediaTimebase FILM_24 = new MediaTimebase(24L, 1L);
    public static final MediaTimebase AUDIO_48KHZ = new MediaTimebase(48_000L, 1L);

    private static final BigInteger NANOS_PER_SECOND = BigInteger.valueOf(1_000_000_000L);

    public MediaTimebase {
        if (numerator < 1 || denominator < 1) {
            throw new IllegalArgumentException("timebase must be a positive rational rate");
        }
        long gcd = gcd(numerator, denominator);
        numerator /= gcd;
        denominator /= gcd;
    }

    /**
     * Nanoseconds elapsed for {@code ticks} in this timebase, rounded per the supplied mode.
     * Exact when the rational result is integral and {@link RoundingMode#UNNECESSARY} is used.
     *
     * @throws ArithmeticException if the result does not fit a long, or the mode rejects inexact
     */
    public long nanosForTicks(long ticks, RoundingMode rounding) {
        requireTicks(ticks);
        return divide(tickCount(ticks).multiply(BigInteger.valueOf(denominator)).multiply(NANOS_PER_SECOND),
                BigInteger.valueOf(numerator), rounding);
    }

    /** Ticks in this timebase spanning {@code nanos} nanoseconds, rounded per the supplied mode. */
    public long ticksForNanos(long nanos, RoundingMode rounding) {
        if (nanos < 0) throw new IllegalArgumentException("nanos cannot be negative");
        return divide(BigInteger.valueOf(nanos).multiply(BigInteger.valueOf(numerator)),
                BigInteger.valueOf(denominator).multiply(NANOS_PER_SECOND), rounding);
    }

    /**
     * Re-expresses {@code ticks} of this timebase as ticks of {@code target} at the same instant.
     * Crossing clock domains is the caller's responsibility — this method only rescales rates.
     */
    public long convertTicks(long ticks, MediaTimebase target, RoundingMode rounding) {
        requireTicks(ticks);
        java.util.Objects.requireNonNull(target, "target");
        return divide(tickCount(ticks)
                        .multiply(BigInteger.valueOf(denominator))
                        .multiply(BigInteger.valueOf(target.numerator)),
                BigInteger.valueOf(numerator).multiply(BigInteger.valueOf(target.denominator)),
                rounding);
    }

    /** Creates a timestamp in this timebase within the given clock domain. */
    public Timestamp timestamp(long ticks, ClockDomain domain) {
        return new Timestamp(this, ticks, domain);
    }

    private static BigInteger tickCount(long ticks) {
        return BigInteger.valueOf(ticks);
    }

    private static void requireTicks(long ticks) {
        if (ticks < 0) throw new IllegalArgumentException("time ticks cannot be negative");
    }

    private static long divide(BigInteger dividend, BigInteger divisor, RoundingMode rounding) {
        java.util.Objects.requireNonNull(rounding, "rounding");
        BigInteger[] qr = dividend.divideAndRemainder(divisor);
        if (qr[1].signum() == 0) {
            return qr[0].longValueExact();
        }
        if (rounding == RoundingMode.UNNECESSARY) {
            throw new ArithmeticException("conversion result is inexact under RoundingMode.UNNECESSARY");
        }
        BigDecimal result = new BigDecimal(dividend).divide(new BigDecimal(divisor), 0, rounding);
        return result.toBigIntegerExact().longValueExact();
    }

    private static long gcd(long a, long b) {
        while (b != 0) {
            long t = a % b;
            a = b;
            b = t;
        }
        return a;
    }

    /**
     * Origin domains for media timestamps. Ticks from different domains describe different
     * origins and must never be resampled into each other without an explicit external mapping.
     */
    public enum ClockDomain {
        /** Ticks on the origin media's own timeline (container demux/presentation clock). */
        SOURCE,
        /** Ticks on Media's normalized processing timeline for the artifact. */
        MEDIA,
        /** Deterministic simulation clock used by tests and replays; never wall time. */
        SIMULATION,
        /** Real wall-clock receipt/observation time. */
        WALL
    }

    /**
     * A tick position bound to a {@link MediaTimebase} and {@link ClockDomain}. Two timestamps are
     * directly comparable only within the same domain and timebase; rescaling keeps the domain.
     */
    public record Timestamp(MediaTimebase timebase, long ticks, ClockDomain domain) {
        public Timestamp {
            java.util.Objects.requireNonNull(timebase, "timebase");
            requireTicks(ticks);
            java.util.Objects.requireNonNull(domain, "domain");
        }

        /** Resamples this timestamp into another tick rate within the same clock domain. */
        public Timestamp resample(MediaTimebase target, RoundingMode rounding) {
            return new Timestamp(
                    target, timebase.convertTicks(ticks, target, rounding), domain);
        }

        /** Nanoseconds elapsed since this domain's origin, rounded per the supplied mode. */
        public long toNanos(RoundingMode rounding) {
            return timebase.nanosForTicks(ticks, rounding);
        }

        /**
         * Difference in ticks between two timestamps; same domain and timebase required.
         * Returns {@code other - this} in this timestamp's ticks (may be negative).
         */
        public long ticksUntil(Timestamp other) {
            java.util.Objects.requireNonNull(other, "other");
            if (!timebase.equals(other.timebase)) {
                throw new IllegalArgumentException("cannot subtract timestamps of different timebases");
            }
            if (domain != other.domain) {
                throw new IllegalArgumentException("cannot subtract timestamps of different clock domains");
            }
            return Math.subtractExact(other.ticks, ticks);
        }
    }
}
