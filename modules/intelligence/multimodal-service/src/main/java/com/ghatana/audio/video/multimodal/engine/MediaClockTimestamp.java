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

    private static final String UNSCOPED_SOURCE_CLOCK = "source-pts:unscoped";

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

    /** Preserve source PTS without claiming a source identity unavailable from the timestamp alone. */
    public static MediaClockTimestamp fromSource(SourceMediaTimestamp source) {
        return fromSource(source, UNSCOPED_SOURCE_CLOCK);
    }

    /** Preserve source PTS with the stable identity of the source clock that owns it. */
    public static MediaClockTimestamp fromSource(SourceMediaTimestamp source, String sourceClockId) {
        Objects.requireNonNull(source, "source");
        if (!source.isKnown()) return unknown(source.reason());
        if (sourceClockId == null || sourceClockId.isBlank()) {
            throw new IllegalArgumentException("Source clock identity must not be blank");
        }
        return new MediaClockTimestamp(Status.KNOWN, source.pts(), source.timeBaseNumerator(),
                source.timeBaseDenominator(), ClockDomain.SOURCE, sourceClockId, null);
    }

    public boolean isKnown() { return status == Status.KNOWN; }

    /** Whether this timestamp has enough clock identity to compare with another timestamp. */
    public boolean hasClockIdentity() {
        return isKnown() && !(domain == ClockDomain.SOURCE && UNSCOPED_SOURCE_CLOCK.equals(clockId));
    }

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
        return hasClockIdentity() && other != null && other.hasClockIdentity()
                && domain == other.domain && clockId.equals(other.clockId);
    }

    public enum Status { KNOWN, UNKNOWN }
    public enum ClockDomain { SOURCE, MEDIA, SIMULATION, WALL }
}
