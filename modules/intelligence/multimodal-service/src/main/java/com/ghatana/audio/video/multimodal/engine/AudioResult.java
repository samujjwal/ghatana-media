package com.ghatana.audio.video.multimodal.engine;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Result from STT transcription.
  * @doc.type class
 * @doc.purpose Provides audio result functionality.
 * @doc.layer product
 * @doc.pattern ValueObject
*/
public class AudioResult {

    private final String transcription;
    private final Double confidence;
    private final ConfidenceCalibration confidenceCalibration;
    private final List<TimedSegment> timedSegments;
    private final String error;

    private AudioResult(Builder builder) {
        this.transcription = builder.transcription;
        this.confidence = builder.confidence;
        this.confidenceCalibration = builder.confidenceCalibration;
        this.timedSegments = immutableSnapshot(builder.timedSegments);
        this.error = builder.error;
    }

    public static AudioResult error(String message) {
        return builder().error(message).transcription("").build();
    }

    public static Builder builder() {
        return new Builder();
    }

    public boolean isError() {
        return error != null && !error.isEmpty();
    }

    public String getTranscription() { return transcription; }
    /** Confidence is null when the upstream result did not provide an available score. */
    public Double getConfidence() { return confidence; }
    public boolean hasConfidence() { return confidence != null; }
    public ConfidenceCalibration getConfidenceCalibration() { return confidenceCalibration; }
    public List<TimedSegment> getTimedSegments() { return timedSegments; }
    public String getError() { return error; }

    private static <T> List<T> immutableSnapshot(List<T> values) {
        return values == null ? null : Collections.unmodifiableList(new ArrayList<>(values));
    }

    /**
     * Returns the transcription text active at the given video timestamp.
     * Returns empty when timed segments or a shared clock are unavailable. Use
     * {@link #getTranscription()} for a non-temporal full-transcript read.
     */
    public String getTranscriptionAtTimestamp(long timestampMs) {
        return getTranscriptionAtTimestamp(MediaClockTimestamp.mediaMilliseconds(timestampMs));
    }

    public String getTranscriptionAtTimestamp(MediaClockTimestamp timestamp) {
        if (timestamp == null || !timestamp.isKnown()) return "";
        if (timedSegments == null || timedSegments.isEmpty()) {
            return "";
        }
        for (TimedSegment seg : timedSegments) {
            if (TemporalAlignment.isWithinClockWindow(timestamp, seg.startTime, seg.endTime)) {
                return seg.getText();
            }
        }
        return "";
    }

    public static class Builder {
        private String transcription = "";
        private Double confidence;
        private ConfidenceCalibration confidenceCalibration = ConfidenceCalibration.UNKNOWN;
        private List<TimedSegment> timedSegments = new ArrayList<>();
        private String error;

        public Builder transcription(String t) { this.transcription = t; return this; }
        public Builder confidence(double c) {
            if (!Double.isFinite(c) || c < 0.0 || c > 1.0) {
                throw new IllegalArgumentException("Confidence must be finite and in [0, 1]");
            }
            this.confidence = c;
            return this;
        }
        public Builder confidenceCalibration(ConfidenceCalibration calibration) {
            this.confidenceCalibration = java.util.Objects.requireNonNull(calibration, "calibration");
            return this;
        }
        public Builder timedSegments(List<TimedSegment> s) { this.timedSegments = s; return this; }
        public Builder error(String e) { this.error = e; return this; }
        public AudioResult build() {
            if (confidence == null && confidenceCalibration != ConfidenceCalibration.UNKNOWN) {
                throw new IllegalArgumentException("Confidence calibration requires an available score");
            }
            if (timedSegments != null) {
                TimedSegment previous = null;
                for (TimedSegment segment : timedSegments) {
                    if (segment == null) {
                        throw new IllegalArgumentException("Timed segments must be non-null and ordered");
                    }
                    if (previous != null && (!previous.getEndTime().sharesClock(segment.getStartTime())
                            || previous.getEndTime().compareWithinClock(segment.getStartTime()) > 0)) {
                        throw new IllegalArgumentException("Timed segments must use one ordered source clock");
                    }
                    previous = segment;
                }
            }
            return new AudioResult(this);
        }
    }

    /**
     * Raw upstream declaration only. CALIBRATED does not establish a shared metric or authorize
     * comparison with another provider's score.
     */
    public enum ConfidenceCalibration { UNKNOWN, UNCALIBRATED, CALIBRATED }

    public static class TimedSegment {
        private final long startMs;
        private final long endMs;
        private final String text;
        private final MediaClockTimestamp startTime;
        private final MediaClockTimestamp endTime;

        public TimedSegment(long startMs, long endMs, String text) {
            this(mediaStart(startMs, endMs), MediaClockTimestamp.mediaMilliseconds(endMs), text);
        }

        /**
         * A timestamped transcript interval in an explicit clock domain. This constructor keeps
         * source PTS/sample clocks exact; it does not establish a mapping to any other clock.
         */
        public TimedSegment(MediaClockTimestamp startTime, MediaClockTimestamp endTime, String text) {
            if (text == null) throw new NullPointerException("segment text must not be null");
            if (startTime == null || endTime == null || !startTime.sharesClock(endTime)
                    || startTime.compareWithinClock(endTime) > 0) {
                throw new IllegalArgumentException("Timed segment requires ordered timestamps on one known clock");
            }
            this.startTime = startTime;
            this.endTime = endTime;
            try {
                this.startMs = startTime.toMilliseconds();
                this.endMs = endTime.toMilliseconds();
            } catch (ArithmeticException overflow) {
                throw new IllegalArgumentException("Timed segment milliseconds are outside the supported range", overflow);
            }
            this.text = text;
        }

        public long getStartMs() { return startMs; }
        public long getEndMs() { return endMs; }
        public String getText() { return text; }
        public MediaClockTimestamp getStartTime() { return startTime; }
        public MediaClockTimestamp getEndTime() { return endTime; }

        private static MediaClockTimestamp mediaStart(long startMs, long endMs) {
            if (startMs < 0 || endMs < startMs) {
                throw new IllegalArgumentException("Timed segment bounds must be non-negative and ordered");
            }
            return MediaClockTimestamp.mediaMilliseconds(startMs);
        }
    }
}
