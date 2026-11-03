package com.ghatana.video.streaming;

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
