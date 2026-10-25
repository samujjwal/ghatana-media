package com.ghatana.audio.video.multimodal.engine;

import com.ghatana.audio.video.vision.video.SourceMediaTimestamp;
import java.math.BigInteger;
import java.util.Objects;

/** Exact media timestamp with its rational timebase and explicit unknown state. */
public record MediaClockTimestamp(
        Status status,
        Long ticks,
        Long timeBaseNumerator,
        Long timeBaseDenominator,
        ClockDomain domain,
        String clockId,
        String unknownReason) {

    public MediaClockTimestamp {
        Objects.requireNonNull(status, "status");
        if (status == Status.KNOWN) {
            if (ticks == null || timeBaseNumerator == null || timeBaseDenominator == null
                    || domain == null || clockId == null || clockId.isBlank()
                    || timeBaseNumerator <= 0 || timeBaseDenominator <= 0) {
                throw new IllegalArgumentException("Known timestamps require ticks, rational timebase and clock identity");
            }
            if (unknownReason != null) throw new IllegalArgumentException("Known timestamp cannot have unknown reason");
        } else if (ticks != null || timeBaseNumerator != null || timeBaseDenominator != null
                || domain != null || clockId != null || unknownReason == null || unknownReason.isBlank()) {
            throw new IllegalArgumentException("Unknown timestamp requires a reason and no fabricated clock values");
        }
    }

    public static MediaClockTimestamp unknown(String reason) {
        return new MediaClockTimestamp(Status.UNKNOWN, null, null, null, null, null, reason);
    }

    public static MediaClockTimestamp mediaMilliseconds(long millis) {
        return new MediaClockTimestamp(Status.KNOWN, millis, 1L, 1000L,
                ClockDomain.MEDIA, "media-ms", null);
    }

    public static MediaClockTimestamp fromSource(SourceMediaTimestamp source) {
        Objects.requireNonNull(source, "source");
        if (!source.isKnown()) return unknown(source.reason());
        return new MediaClockTimestamp(Status.KNOWN, source.pts(), source.timeBaseNumerator(),
                source.timeBaseDenominator(), ClockDomain.SOURCE, "source-pts", null);
    }

    public boolean isKnown() { return status == Status.KNOWN; }

    public Long toMilliseconds() {
        if (!isKnown()) return null;
        BigInteger numerator = BigInteger.valueOf(ticks)
                .multiply(BigInteger.valueOf(timeBaseNumerator)).multiply(BigInteger.valueOf(1000));
        BigInteger denominator = BigInteger.valueOf(timeBaseDenominator);
        BigInteger[] result = numerator.divideAndRemainder(denominator);
        BigInteger rounded = result[0];
        if (result[1].abs().shiftLeft(1).compareTo(denominator) >= 0) {
            rounded = rounded.add(BigInteger.valueOf(numerator.signum()));
        }
        return rounded.longValueExact();
    }

    public boolean sharesClock(MediaClockTimestamp other) {
        return isKnown() && other != null && other.isKnown()
                && domain == other.domain && clockId.equals(other.clockId);
    }

    public enum Status { KNOWN, UNKNOWN }
    public enum ClockDomain { SOURCE, MEDIA, SIMULATION, WALL }
}
