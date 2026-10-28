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
        if (builder.processingTimeMs < 0) {
            throw new IllegalArgumentException("Processing time must not be negative");
        }
        this.audioResult = builder.audioResult;
        this.visualResult = builder.visualResult;
        this.combinedAnalysis = java.util.Objects.requireNonNull(
                builder.combinedAnalysis, "combinedAnalysis must not be null");
        this.processingTimeMs = builder.processingTimeMs;
        this.outcome = builder.outcome == null
                ? deriveOutcome(builder.audioResult, builder.visualResult)
                : builder.outcome;
    }

    private static Outcome deriveOutcome(AudioResult audio, VisualResult visual) {
        int requested = 0;
        int succeeded = 0;
        int failed = 0;
        if (audio != null) {
            requested++;
            if (audio.isError()) failed++;
            else succeeded++;
        }
        if (visual != null) {
            requested++;
            if (visual.isError()) failed++;
            else succeeded++;
        }
        if (requested == 0) return Outcome.NO_MODALITY;
        if (failed == 0) return Outcome.COMPLETE;
        return succeeded == 0 ? Outcome.FAILED : Outcome.PARTIAL;
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
        private Outcome outcome;

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
