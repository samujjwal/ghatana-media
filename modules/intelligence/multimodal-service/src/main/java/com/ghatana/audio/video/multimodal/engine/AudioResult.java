package com.ghatana.audio.video.multimodal.engine;

import java.util.ArrayList;
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
    private final double confidence;
    private final List<TimedSegment> timedSegments;
    private final String error;

    private AudioResult(Builder builder) {
        this.transcription = builder.transcription;
        this.confidence = builder.confidence;
        this.timedSegments = builder.timedSegments;
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
    public double getConfidence() { return confidence; }
    public List<TimedSegment> getTimedSegments() { return timedSegments; }
    public String getError() { return error; }

    /**
     * Returns the transcription text active at the given video timestamp.
     * Falls back to the full transcription if no timed segments are available.
     */
    public String getTranscriptionAtTimestamp(long timestampMs) {
        if (timedSegments == null || timedSegments.isEmpty()) {
            return transcription;
        }
        String best = "";
        for (TimedSegment seg : timedSegments) {
            if (seg.getStartMs() <= timestampMs && timestampMs <= seg.getEndMs()) {
                return seg.getText();
            }
            // keep the closest prior segment as fallback
            if (seg.getEndMs() <= timestampMs) {
                best = seg.getText();
            }
        }
        return best;
    }

    public static class Builder {
        private String transcription = "";
        private double confidence = 0.0;
        private List<TimedSegment> timedSegments = new ArrayList<>();
        private String error;

        public Builder transcription(String t) { this.transcription = t; return this; }
        public Builder confidence(double c) { this.confidence = c; return this; }
        public Builder timedSegments(List<TimedSegment> s) { this.timedSegments = s; return this; }
        public Builder error(String e) { this.error = e; return this; }
        public AudioResult build() { return new AudioResult(this); }
    }

    public static class TimedSegment {
        private final long startMs;
        private final long endMs;
        private final String text;

        public TimedSegment(long startMs, long endMs, String text) {
            this.startMs = startMs;
            this.endMs = endMs;
            this.text = text;
        }

        public long getStartMs() { return startMs; }
        public long getEndMs() { return endMs; }
        public String getText() { return text; }
    }
}
