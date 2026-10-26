package com.ghatana.audio.video.multimodal.engine;

import java.math.BigInteger;
import java.util.List;
import java.util.OptionalLong;

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

    private static final String MEDIA_MILLISECONDS_CLOCK = "media-ms";

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
        this.timestamp = java.util.Objects.requireNonNull(timestamp, "timestamp");
        this.detections = List.copyOf(java.util.Objects.requireNonNull(detections, "detections"));
        if (syncStatus == null) {
            throw new IllegalArgumentException("syncStatus is required");
        }
        if (syncStatus == SyncStatus.MEASURED
                && (!Double.isFinite(syncConfidence) || syncConfidence < 0.0 || syncConfidence > 1.0)) {
            throw new IllegalArgumentException("measured synchronization requires finite confidence in [0, 1]");
        }
        if (syncStatus == SyncStatus.MEASURED && !this.timestamp.isKnown()) {
            throw new IllegalArgumentException("measured synchronization requires a known timestamp");
        }
        if (syncStatus == SyncStatus.SYNC_UNDETERMINED
                && (syncOffsetMs != 0L || syncConfidence != 0.0)) {
            throw new IllegalArgumentException("undetermined synchronization cannot carry measurement values");
        }
        this.frameNumber    = frameNumber;
        this.speechText     = speechText;
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

    /**
     * Legacy projection; unknown timestamps use {@code 0L} as a sentinel. Prefer
     * {@link #getRepresentableTimestampMs()} when presence and representability matter.
     */
    public long   getTimestampMs()    { return timestamp.toMilliseconds() == null ? 0L : timestamp.toMilliseconds(); }
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
    public int    getFrameNumber()    { return frameNumber; }
    public String getSpeechText()     { return speechText; }
    public List<DetectionResult> getDetections() { return detections; }
    public long   getSyncOffsetMs()   { return syncOffsetMs; }
    public double getSyncConfidence() { return syncConfidence; }
    public SyncStatus getSyncStatus() { return syncStatus; }
    public boolean hasSyncMeasurement() { return syncStatus == SyncStatus.MEASURED; }

    /**
     * Tests whether an exact rational timestamp falls within an existing millisecond media window.
     *
     * <p>The compatibility window is defined on the media-millisecond clock. This performs an
     * exact rational comparison and does not map source, simulation, or wall clocks into it.
     */
    static boolean isWithinMediaWindow(MediaClockTimestamp timestamp, long startMs, long endMs) {
        if (timestamp == null || !timestamp.isKnown() || !timestamp.hasClockIdentity()
                || timestamp.domain() != MediaClockTimestamp.ClockDomain.MEDIA
                || !MEDIA_MILLISECONDS_CLOCK.equals(timestamp.clockId())
                || startMs < 0 || endMs < startMs) {
            return false;
        }
        return compareToMilliseconds(timestamp, startMs) >= 0
                && compareToMilliseconds(timestamp, endMs) <= 0;
    }

    /**
     * Match a timestamp only against a bounded window on the same identified clock. This compares
     * rational instants exactly and never maps between source, media, simulation, or wall time.
     */
    static boolean isWithinClockWindow(MediaClockTimestamp timestamp,
                                       MediaClockTimestamp start, MediaClockTimestamp end) {
        if (timestamp == null || start == null || end == null
                || !timestamp.sharesClock(start) || !timestamp.sharesClock(end)
                || start.compareWithinClock(end) > 0) {
            return false;
        }
        return timestamp.compareWithinClock(start) >= 0 && timestamp.compareWithinClock(end) <= 0;
    }

    private static int compareToMilliseconds(MediaClockTimestamp timestamp, long millis) {
        BigInteger timestampNumerator = BigInteger.valueOf(timestamp.ticks())
                .multiply(BigInteger.valueOf(timestamp.timeBaseNumerator()))
                .multiply(BigInteger.valueOf(1000));
        BigInteger windowNumerator = BigInteger.valueOf(millis)
                .multiply(BigInteger.valueOf(timestamp.timeBaseDenominator()));
        return timestampNumerator.compareTo(windowNumerator);
    }
}
