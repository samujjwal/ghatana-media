package com.ghatana.audio.video.multimodal.engine;

import java.util.List;

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
    /** Legacy wire projection; callers must check {@link #hasTimestamp()} first. */
    public long getTimestampMs() { return timestamp.toMilliseconds() == null ? 0L : timestamp.toMilliseconds(); }
    public boolean hasTimestamp() { return timestamp.isKnown(); }
    public MediaClockTimestamp getTimestamp() { return timestamp; }
    public List<DetectionResult> getDetections() { return detections; }
}
