package com.ghatana.video.streaming;

import java.math.BigInteger;
import java.util.Objects;

/**
 * Source-bound timing metadata for a video frame.
 *
 * <p>The legacy frame wire timestamp is milliseconds with no clock identity. This adapter keeps
 * that value separate from explicit capture and presentation timestamps. It does not infer a
 * source clock, convert between clocks, or normalize VFR timestamps.</p>
 */
public final class VideoFrameTimebase {

    private VideoFrameTimebase() { }

    /** Binds caller-supplied source timing and codec metadata to an already decoded frame. */
    public static FrameTiming bind(
            String streamId,
            VideoStreamSession.DecodedFrame frame,
            Integer keyFrameSequence,
            SourceTimestamp capturePts,
            SourceTimestamp presentationPts,
            String discontinuityId,
            String codecId,
            String codecConfigurationId,
            PresentationMapping presentationMapping) {
        Objects.requireNonNull(frame, "frame");
        int sequence = frame.sequenceNumber();
        if (sequence < 0 || sequence > VideoStreamSession.MAX_FRAME_SEQUENCE) {
            throw new IllegalArgumentException("frame sequence is outside the supported range");
        }
        if (frame.keyFrame()) {
            if (keyFrameSequence == null || keyFrameSequence != sequence) {
                throw new IllegalArgumentException("keyframe identity must equal the keyframe sequence");
            }
        } else if (keyFrameSequence != null
                && (keyFrameSequence < 0 || keyFrameSequence > sequence)) {
            throw new IllegalArgumentException("keyframe identity must be at or before the frame sequence");
        }
        return new FrameTiming(
                required(streamId, "streamId"), sequence, frame.keyFrame(), keyFrameSequence,
                Objects.requireNonNull(capturePts, "capturePts"),
                Objects.requireNonNull(presentationPts, "presentationPts"),
                required(discontinuityId, "discontinuityId"),
                required(codecId, "codecId"),
                required(codecConfigurationId, "codecConfigurationId"),
                Objects.requireNonNull(presentationMapping, "presentationMapping"));
    }

    private static String required(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " must not be blank");
        }
        return value;
    }

    /** A signed source tick value and its exact declared rational timebase. */
    public record SourceTimestamp(
            Status status,
            Long ticks,
            Long timebaseNumerator,
            Long timebaseDenominator,
            String clockId,
            String unknownReason) {
        public SourceTimestamp {
            Objects.requireNonNull(status, "status");
            if (status == Status.KNOWN) {
                if (ticks == null || timebaseNumerator == null || timebaseDenominator == null
                        || timebaseNumerator <= 0 || timebaseDenominator <= 0
                        || clockId == null || clockId.isBlank() || unknownReason != null) {
                    throw new IllegalArgumentException(
                            "known source timestamps require ticks, a positive rational timebase, and clock identity");
                }
                if (!clockId.equals(clockId.strip())) {
                    throw new IllegalArgumentException("source clock identity must not have surrounding whitespace");
                }
            } else if (ticks != null || timebaseNumerator != null || timebaseDenominator != null
                    || clockId != null || unknownReason == null || unknownReason.isBlank()) {
                throw new IllegalArgumentException("unknown source timestamps must not contain fabricated clock values");
            }
        }

        public static SourceTimestamp known(long ticks, long timebaseNumerator,
                long timebaseDenominator, String clockId) {
            return new SourceTimestamp(Status.KNOWN, ticks, timebaseNumerator,
                    timebaseDenominator, clockId, null);
        }

        public static SourceTimestamp unknown(String reason) {
            return new SourceTimestamp(Status.UNKNOWN, null, null, null, null, reason);
        }

        /**
         * Re-expresses this timestamp in another seconds-per-tick rational for the same
         * source clock. Conversion is exact-only: callers must retain the original rational
         * value or provide an explicit mapping when the target tick rate cannot represent it.
         *
         * @throws IllegalStateException if this timestamp is unknown
         * @throws ArithmeticException if the target tick is fractional or does not fit a long
         */
        public SourceTimestamp rescaleExactly(long targetTimebaseNumerator,
                long targetTimebaseDenominator) {
            if (status != Status.KNOWN) {
                throw new IllegalStateException("unknown source timestamp cannot be rescaled");
            }
            if (targetTimebaseNumerator <= 0 || targetTimebaseDenominator <= 0) {
                throw new IllegalArgumentException("target timebase must be a positive rational");
            }
            // source seconds = ticks * sourceNumerator / sourceDenominator.
            // target ticks = source seconds * targetDenominator / targetNumerator.
            BigInteger dividend = BigInteger.valueOf(ticks)
                    .multiply(BigInteger.valueOf(timebaseNumerator))
                    .multiply(BigInteger.valueOf(targetTimebaseDenominator));
            BigInteger divisor = BigInteger.valueOf(timebaseDenominator)
                    .multiply(BigInteger.valueOf(targetTimebaseNumerator));
            BigInteger[] quotientAndRemainder = dividend.divideAndRemainder(divisor);
            if (quotientAndRemainder[1].signum() != 0) {
                throw new ArithmeticException("target timebase cannot exactly represent source timestamp");
            }
            return known(quotientAndRemainder[0].longValueExact(),
                    targetTimebaseNumerator, targetTimebaseDenominator, clockId);
        }
    }

    /** Explicit mapping from a source frame position to a presentation timeline position. */
    public record PresentationMapping(
            Status status,
            SourceTimestamp sourcePosition,
            TimelineTimestamp presentationPosition,
            String origin,
            String uncertainty,
            String roundingPolicy,
            String evidenceRef,
            String unknownReason) {
        public PresentationMapping {
            Objects.requireNonNull(status, "status");
            if (status == Status.KNOWN) {
                Objects.requireNonNull(sourcePosition, "sourcePosition");
                Objects.requireNonNull(presentationPosition, "presentationPosition");
                if (sourcePosition.status() != Status.KNOWN
                        || presentationPosition.domain() != ClockDomain.STORY_EXPLANATION
                        || blank(origin) || blank(uncertainty) || blank(roundingPolicy)
                        || blank(evidenceRef) || unknownReason != null) {
                    throw new IllegalArgumentException(
                            "known presentation mappings require source and story positions, origin, uncertainty, policy, and evidence");
                }
            } else if (sourcePosition != null || presentationPosition != null || origin != null || uncertainty != null
                    || roundingPolicy != null || evidenceRef != null
                    || blank(unknownReason)) {
                throw new IllegalArgumentException("unknown presentation mappings must not contain fabricated mapping values");
            }
        }

        public static PresentationMapping unknown(String reason) {
            return new PresentationMapping(Status.UNKNOWN, null, null, null, null, null, null, reason);
        }
    }

    /** Exact target position in one of the product-defined clock domains. */
    public record TimelineTimestamp(
            long ticks,
            long timebaseNumerator,
            long timebaseDenominator,
            ClockDomain domain,
            String clockId) {
        public TimelineTimestamp {
            if (timebaseNumerator <= 0 || timebaseDenominator <= 0) {
                throw new IllegalArgumentException("timeline timebase must be a positive rational");
            }
            Objects.requireNonNull(domain, "domain");
            if (clockId == null || clockId.isBlank()) {
                throw new IllegalArgumentException("timeline timestamp requires clock identity");
            }
        }

        public static TimelineTimestamp known(long ticks, long timebaseNumerator,
                long timebaseDenominator, ClockDomain domain, String clockId) {
            return new TimelineTimestamp(ticks, timebaseNumerator, timebaseDenominator, domain, clockId);
        }
    }

    /** Product clock domains remain distinct; source PTS itself is represented by SourceTimestamp. */
    public enum ClockDomain {
        SOURCE_VIDEO_PRESENTATION,
        AUDIO_SAMPLE,
        STORY_EXPLANATION,
        SIMULATION_EXECUTION,
        WALL_CLOCK
    }

    /** The source frame identity and all clock/codec boundary facts preserved for that frame. */
    public record FrameTiming(
            String streamId,
            int sequence,
            boolean keyFrame,
            Integer keyFrameSequence,
            SourceTimestamp capturePts,
            SourceTimestamp presentationPts,
            String discontinuityId,
            String codecId,
            String codecConfigurationId,
            PresentationMapping presentationMapping) {
        public FrameTiming {
            streamId = required(streamId, "streamId");
            if (sequence < 0 || sequence > VideoStreamSession.MAX_FRAME_SEQUENCE) {
                throw new IllegalArgumentException("frame sequence is outside the supported range");
            }
            if (keyFrame && (keyFrameSequence == null || keyFrameSequence != sequence)) {
                throw new IllegalArgumentException("keyframe identity must equal the keyframe sequence");
            }
            if (!keyFrame && keyFrameSequence != null
                    && (keyFrameSequence < 0 || keyFrameSequence > sequence)) {
                throw new IllegalArgumentException("keyframe identity must be at or before the frame sequence");
            }
            Objects.requireNonNull(capturePts, "capturePts");
            Objects.requireNonNull(presentationPts, "presentationPts");
            discontinuityId = required(discontinuityId, "discontinuityId");
            codecId = required(codecId, "codecId");
            codecConfigurationId = required(codecConfigurationId, "codecConfigurationId");
            Objects.requireNonNull(presentationMapping, "presentationMapping");
            if (presentationMapping.status() == Status.KNOWN
                    && !presentationMapping.sourcePosition().equals(presentationPts)) {
                throw new IllegalArgumentException(
                        "presentation mapping source position must match the frame presentation PTS");
            }
        }
    }

    public enum Status { KNOWN, UNKNOWN }

    private static boolean blank(String value) {
        return value == null || value.isBlank();
    }
}
