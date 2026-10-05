package com.ghatana.audio.video.multimodal.engine;

import java.util.List;

/**
 * Aligns a speech segment with the visual detections at the same video timestamp.
 *
 * <p>Each alignment carries the estimated A/V sync offset (audio PTS − video PTS)
 * and a confidence score so consumers can flag problematic sync points.
  * @doc.type class
 * @doc.purpose Provides temporal alignment functionality.
 * @doc.layer product
 * @doc.pattern Component
*/
public class TemporalAlignment {

    private final long   timestampMs;
    private final int    frameNumber;
    private final String speechText;
    private final List<DetectionResult> detections;

    /** Audio PTS minus video PTS in milliseconds (positive = audio leads). */
    private final long   syncOffsetMs;
    /** Quality indicator in [0, 1]: 1.0 = perfectly aligned. */
    private final double syncConfidence;

    /** Backward-compatible constructor — syncOffsetMs=0, syncConfidence=1.0 */
    public TemporalAlignment(long timestampMs, int frameNumber,
                             String speechText, List<DetectionResult> detections) {
        this(timestampMs, frameNumber, speechText, detections, 0L, 1.0);
    }

    public TemporalAlignment(long timestampMs, int frameNumber,
                             String speechText, List<DetectionResult> detections,
                             long syncOffsetMs, double syncConfidence) {
        this.timestampMs    = timestampMs;
        this.frameNumber    = frameNumber;
        this.speechText     = speechText;
        this.detections     = detections;
        this.syncOffsetMs   = syncOffsetMs;
        this.syncConfidence = syncConfidence;
    }

    public long   getTimestampMs()    { return timestampMs; }
    public int    getFrameNumber()    { return frameNumber; }
    public String getSpeechText()     { return speechText; }
    public List<DetectionResult> getDetections() { return detections; }
    public long   getSyncOffsetMs()   { return syncOffsetMs; }
    public double getSyncConfidence() { return syncConfidence; }
}
