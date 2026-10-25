package com.ghatana.audio.video.multimodal.engine;

import java.util.List;
import java.util.OptionalLong;

/**
 * Detection results for a single video frame.
  * @doc.type class
 * @doc.purpose Provides frame result functionality.
 * @doc.layer product
 * @doc.pattern ValueObject
*/
public class FrameResult {

    private final int frameNumber;
    private final MediaClockTimestamp timestamp;
    private final List<DetectionResult> detections;

    public FrameResult(int frameNumber, long timestampMs, List<DetectionResult> detections) {
        this(frameNumber, MediaClockTimestamp.mediaMilliseconds(timestampMs), detections);
    }

    public FrameResult(int frameNumber, MediaClockTimestamp timestamp, List<DetectionResult> detections) {
        this.frameNumber = frameNumber;
        this.timestamp = java.util.Objects.requireNonNull(timestamp, "timestamp");
        this.detections = detections;
    }

    public int getFrameNumber() { return frameNumber; }
    /**
     * Legacy projection; unknown timestamps use {@code 0L} as a sentinel. Prefer
     * {@link #getRepresentableTimestampMs()} when presence and representability matter.
     */
    public long getTimestampMs() { return timestamp.toMilliseconds() == null ? 0L : timestamp.toMilliseconds(); }
    /** Returns milliseconds only when the timestamp is known and representable as a signed long. */
    public OptionalLong getRepresentableTimestampMs() {
        if (!timestamp.isKnown()) return OptionalLong.empty();
        try {
            return OptionalLong.of(timestamp.toMilliseconds());
        } catch (ArithmeticException overflow) {
            return OptionalLong.empty();
        }
    }
    public boolean hasTimestamp() { return timestamp.isKnown(); }
    public MediaClockTimestamp getTimestamp() { return timestamp; }
    public List<DetectionResult> getDetections() { return detections; }
}
