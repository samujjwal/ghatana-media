package com.ghatana.audio.video.multimodal.engine;

import java.util.List;

/**
 * Result from combined video + audio analysis with temporal alignment.
 * @doc.type class
 * @doc.purpose Provides video audio result functionality.
 * @doc.layer product
 * @doc.pattern ValueObject
 */
public final class VideoAudioResult {

    private final AudioResult audioResult;
    private final VisualResult videoResult;
    private final List<TemporalAlignment> temporalAlignments;
    private final String combinedNarrative;
    private final long processingTimeMs;

    private VideoAudioResult(Builder builder) {
        this.audioResult = builder.audioResult;
        this.videoResult = builder.videoResult;
        this.temporalAlignments = builder.temporalAlignments;
        this.combinedNarrative = builder.combinedNarrative;
        this.processingTimeMs = builder.processingTimeMs;
    }

    public static Builder builder() {
        return new Builder();
    }

    public AudioResult getAudioResult() {
        return audioResult;
    }

    public VisualResult getVideoResult() {
        return videoResult;
    }

    public List<TemporalAlignment> getTemporalAlignments() {
        return temporalAlignments;
    }

    public String getCombinedNarrative() {
        return combinedNarrative;
    }

    public long getProcessingTimeMs() {
        return processingTimeMs;
    }

    public static class Builder {
        private AudioResult audioResult;
        private VisualResult videoResult;
        private List<TemporalAlignment> temporalAlignments;
        private String combinedNarrative = "";
        private long processingTimeMs;

        public Builder audioResult(AudioResult a) {
            this.audioResult = a;
            return this;
        }

        public Builder videoResult(VisualResult v) {
            this.videoResult = v;
            return this;
        }

        public Builder temporalAlignments(List<TemporalAlignment> t) {
            this.temporalAlignments = t;
            return this;
        }

        public Builder combinedNarrative(String n) {
            this.combinedNarrative = n;
            return this;
        }

        public Builder processingTimeMs(long t) {
            this.processingTimeMs = t;
            return this;
        }

        public VideoAudioResult build() {
            return new VideoAudioResult(this);
        }
    }
}
