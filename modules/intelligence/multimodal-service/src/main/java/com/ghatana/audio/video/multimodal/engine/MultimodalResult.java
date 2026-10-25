package com.ghatana.audio.video.multimodal.engine;

/**
 * Fused result from multimodal analysis.
 * @doc.type class
 * @doc.purpose Provides multimodal result functionality.
 * @doc.layer product
 * @doc.pattern ValueObject
 */
public final class MultimodalResult {

    /**
     * Availability of the requested modality executions. This does not describe
     * scientific quality, source grounding, or durable persistence.
     */
    public enum Outcome {
        COMPLETE,
        PARTIAL,
        FAILED,
        NO_MODALITY
    }

    private final AudioResult audioResult;
    private final VisualResult visualResult;
    private final String combinedAnalysis;
    private final long processingTimeMs;
    private final Outcome outcome;

    private MultimodalResult(Builder builder) {
        this.audioResult = builder.audioResult;
        this.visualResult = builder.visualResult;
        this.combinedAnalysis = builder.combinedAnalysis;
        this.processingTimeMs = builder.processingTimeMs;
        this.outcome = builder.outcome;
    }

    public static Builder builder() {
        return new Builder();
    }

    public AudioResult getAudioResult() {
        return audioResult;
    }

    public VisualResult getVisualResult() {
        return visualResult;
    }

    public String getCombinedAnalysis() {
        return combinedAnalysis;
    }

    public long getProcessingTimeMs() {
        return processingTimeMs;
    }

    public Outcome getOutcome() {
        return outcome;
    }

    public static class Builder {
        private AudioResult audioResult;
        private VisualResult visualResult;
        private String combinedAnalysis = "";
        private long processingTimeMs;
        private Outcome outcome = Outcome.NO_MODALITY;

        public Builder audioResult(AudioResult a) {
            this.audioResult = a;
            return this;
        }

        public Builder visualResult(VisualResult v) {
            this.visualResult = v;
            return this;
        }

        public Builder combinedAnalysis(String c) {
            this.combinedAnalysis = c;
            return this;
        }

        public Builder processingTimeMs(long t) {
            this.processingTimeMs = t;
            return this;
        }

        public Builder outcome(Outcome outcome) {
            this.outcome = java.util.Objects.requireNonNull(outcome, "outcome");
            return this;
        }

        public MultimodalResult build() {
            return new MultimodalResult(this);
        }
    }
}
