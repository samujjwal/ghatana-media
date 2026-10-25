package com.ghatana.audio.video.multimodal.engine;

import java.util.List;

/**
 * Aligns a speech segment with the visual detections at the same video timestamp.
 *
 * <p>Each alignment carries the synchronization disposition separately from
 * its source-timestamp association. A timestamp association is not evidence
 * that the audio and video signals are synchronized.
  * @doc.type class
 * @doc.purpose Provides temporal alignment functionality.
 * @doc.layer product
 * @doc.pattern Component
*/
public class TemporalAlignment {

    private final MediaClockTimestamp timestamp;
    private final int    frameNumber;
    private final String speechText;
    private final List<DetectionResult> detections;

    /** Audio PTS minus video PTS in milliseconds (positive = audio leads). */
    private final long syncOffsetMs;
    /** Quality indicator in [0, 1]; zero is a safe legacy value when status is undetermined. */
    private final double syncConfidence;
    private final SyncStatus syncStatus;

    public enum SyncStatus {
        /** No signal-grounded synchronization measurement is available. */
        SYNC_UNDETERMINED,
        /** Offset and confidence were produced by an admitted synchronization algorithm. */
        MEASURED
    }

    /** Timestamp-only alignment; synchronization is not measured. */
    public TemporalAlignment(long timestampMs, int frameNumber,
                             String speechText, List<DetectionResult> detections) {
        this(timestampMs, frameNumber, speechText, detections, 0L, 0.0,
                SyncStatus.SYNC_UNDETERMINED);
    }

    public TemporalAlignment(long timestampMs, int frameNumber,
                             String speechText, List<DetectionResult> detections,
                             long syncOffsetMs, double syncConfidence,
                             SyncStatus syncStatus) {
        this(MediaClockTimestamp.mediaMilliseconds(timestampMs), frameNumber, speechText, detections,
                syncOffsetMs, syncConfidence, syncStatus);
    }

    public TemporalAlignment(MediaClockTimestamp timestamp, int frameNumber,
                             String speechText, List<DetectionResult> detections,
                             long syncOffsetMs, double syncConfidence,
                             SyncStatus syncStatus) {
        if (syncStatus == null) {
            throw new IllegalArgumentException("syncStatus is required");
        }
        if (syncStatus == SyncStatus.MEASURED
                && (!Double.isFinite(syncConfidence) || syncConfidence < 0.0 || syncConfidence > 1.0)) {
            throw new IllegalArgumentException("measured synchronization requires finite confidence in [0, 1]");
        }
        if (syncStatus == SyncStatus.MEASURED && !timestamp.isKnown()) {
            throw new IllegalArgumentException("measured synchronization requires a known timestamp");
        }
        if (syncStatus == SyncStatus.SYNC_UNDETERMINED
                && (syncOffsetMs != 0L || syncConfidence != 0.0)) {
            throw new IllegalArgumentException("undetermined synchronization cannot carry measurement values");
        }
        this.timestamp    = java.util.Objects.requireNonNull(timestamp, "timestamp");
        this.frameNumber    = frameNumber;
        this.speechText     = speechText;
        this.detections     = detections;
        this.syncOffsetMs   = syncOffsetMs;
        this.syncConfidence = syncConfidence;
        this.syncStatus     = syncStatus;
    }

    /** Backward-compatible measured-value constructor. */
    public TemporalAlignment(long timestampMs, int frameNumber,
                             String speechText, List<DetectionResult> detections,
                             long syncOffsetMs, double syncConfidence) {
        this(timestampMs, frameNumber, speechText, detections, syncOffsetMs, syncConfidence,
                SyncStatus.MEASURED);
    }

    public long   getTimestampMs()    { return timestamp.toMilliseconds() == null ? 0L : timestamp.toMilliseconds(); }
    public boolean hasTimestamp() { return timestamp.isKnown(); }
    public MediaClockTimestamp getTimestamp() { return timestamp; }
    public int    getFrameNumber()    { return frameNumber; }
    public String getSpeechText()     { return speechText; }
    public List<DetectionResult> getDetections() { return detections; }
    public long   getSyncOffsetMs()   { return syncOffsetMs; }
    public double getSyncConfidence() { return syncConfidence; }
    public SyncStatus getSyncStatus() { return syncStatus; }
    public boolean hasSyncMeasurement() { return syncStatus == SyncStatus.MEASURED; }
}
