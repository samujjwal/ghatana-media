package com.ghatana.multimodal.engine;

import java.time.Duration;
import java.util.*;

/**
 * Cross-modal fusion engine for audio-visual and text-image alignment.
 *
 * <p>Fuses signals from audio, video, and text modalities to produce unified
 * semantic representations. Handles missing modalities with graceful degradation.
 *
 * @doc.type    class
 * @doc.purpose Cross-modal fusion: audio-visual fusion, text-image fusion, missing modality handling
 * @doc.layer   product
 * @doc.pattern Engine
 */
public class CrossModalFusionEngine {

    /** Audio feature vector derived from a speech segment. */
    public record AudioFeatures(double[] embeddings, double confidence, String embeddingSpaceId) {
        public AudioFeatures {
            embeddings = copy(embeddings);
        }
        @Override public double[] embeddings() { return copy(embeddings); }
        /** Compatibility constructor. The coordinate space remains unknown until explicitly supplied. */
        public AudioFeatures(double[] embeddings, double confidence) {
            this(embeddings, confidence, null);
        }
        public boolean isEmpty() { return embeddings == null || embeddings.length == 0; }
    }

    /** Visual feature vector derived from a video frame. */
    public record VisualFeatures(
            double[] embeddings, double[] boundingBoxes, double confidence, String embeddingSpaceId) {
        public VisualFeatures {
            embeddings = copy(embeddings);
            boundingBoxes = copy(boundingBoxes);
        }
        @Override public double[] embeddings() { return copy(embeddings); }
        @Override public double[] boundingBoxes() { return copy(boundingBoxes); }
        /** Compatibility constructor. The coordinate space remains unknown until explicitly supplied. */
        public VisualFeatures(double[] embeddings, double[] boundingBoxes, double confidence) {
            this(embeddings, boundingBoxes, confidence, null);
        }
        public boolean isEmpty() { return embeddings == null || embeddings.length == 0; }
    }

    /** Text feature vector derived from transcript or caption. */
    public record TextFeatures(double[] embeddings, String text, double confidence, String embeddingSpaceId) {
        public TextFeatures {
            embeddings = copy(embeddings);
        }
        @Override public double[] embeddings() { return copy(embeddings); }
        /** Compatibility constructor. The coordinate space remains unknown until explicitly supplied. */
        public TextFeatures(double[] embeddings, String text, double confidence) {
            this(embeddings, text, confidence, null);
        }
        public boolean isEmpty() { return embeddings == null || embeddings.length == 0; }
    }

    private static double[] copy(double[] values) {
        return values == null ? null : values.clone();
    }

    /** Fused multimodal representation. */
    public record FusionResult(
            double[] fusedEmbeddings,
            /** Arithmetic input score only; it is not calibrated confidence or alignment quality. */
            double fusionConfidence,
            Map<String, Double> modalityWeights,
            Duration processingTime,
            boolean hadMissingModality
    ) {
        public FusionResult {
            Objects.requireNonNull(fusedEmbeddings, "fusedEmbeddings must not be null");
            Objects.requireNonNull(modalityWeights, "modalityWeights must not be null");
            Objects.requireNonNull(processingTime, "processingTime must not be null");
            if (!Double.isFinite(fusionConfidence) || fusionConfidence < 0.0 || fusionConfidence > 1.0) {
                throw new IllegalArgumentException("Fusion confidence must be finite and in [0, 1]");
            }
            for (double component : fusedEmbeddings) {
                if (!Double.isFinite(component)) {
                    throw new IllegalArgumentException("Fused embeddings must contain only finite values");
                }
            }
            if (processingTime.isNegative()) {
                throw new IllegalArgumentException("Processing time must not be negative");
            }
            modalityWeights = Map.copyOf(modalityWeights);
            if (modalityWeights.isEmpty()) {
                throw new IllegalArgumentException("At least one modality weight is required");
            }
            double weightSum = 0.0;
            for (Map.Entry<String, Double> entry : modalityWeights.entrySet()) {
                Double weight = entry.getValue();
                if (entry.getKey() == null || entry.getKey().isBlank() || weight == null
                        || !Double.isFinite(weight) || weight < 0.0 || weight > 1.0) {
                    throw new IllegalArgumentException("Modality weights must be finite and in [0, 1]");
                }
                weightSum += weight;
            }
            if (!Double.isFinite(weightSum) || Math.abs(weightSum - 1.0) > 1.0e-9) {
                throw new IllegalArgumentException("Modality weights must sum to 1");
            }
            fusedEmbeddings = fusedEmbeddings.clone();
        }

        @Override
        public double[] fusedEmbeddings() {
            return fusedEmbeddings.clone();
        }

        public ConfidenceDisposition confidenceDisposition() {
            return ConfidenceDisposition.HEURISTIC_UNCALIBRATED;
        }
    }

    public enum ConfidenceDisposition { HEURISTIC_UNCALIBRATED }

    /** Source-raster region identity. Coordinates are EXIF-oriented decoded-raster XYWH pixels. */
    public record RegionFrame(
            String sourceId, String sourceVersion, String frameVersion,
            int x, int y, int width, int height) {
        public RegionFrame {
            if (!boundedIdentity(sourceId) || !boundedIdentity(sourceVersion) || !boundedIdentity(frameVersion)) {
                throw new IllegalArgumentException("Region source and frame versions are required");
            }
            if (x < 0 || y < 0 || width <= 0 || height <= 0) {
                throw new IllegalArgumentException("Region must use non-negative top-left XYWH pixels with positive size");
            }
            try {
                Math.addExact(x, width);
                Math.addExact(y, height);
            } catch (ArithmeticException overflow) {
                throw new IllegalArgumentException("Region bounds overflow", overflow);
            }
        }
    }

    public enum SynchronizationDisposition { SYNC_UNDETERMINED }

    /** A fail-closed result for source-bound fusion; empty fusion means the inputs abstained. */
    public record FusionOutcome(
            Optional<FusionResult> fusion,
            ConfidenceDisposition confidenceDisposition,
            SynchronizationDisposition synchronizationDisposition,
            String abstentionReason) {
        public FusionOutcome {
            Objects.requireNonNull(fusion, "fusion");
            Objects.requireNonNull(confidenceDisposition, "confidenceDisposition");
            Objects.requireNonNull(synchronizationDisposition, "synchronizationDisposition");
            if (fusion.isPresent() == (abstentionReason != null)) {
                throw new IllegalArgumentException("Outcome must contain either fusion or abstention reason");
            }
            if (abstentionReason != null && abstentionReason.isBlank()) {
                throw new IllegalArgumentException("Abstention reason must not be blank");
            }
        }
    }

    private final String modelId;
    private final int embeddingDim;

    public CrossModalFusionEngine(String modelId, int embeddingDim) {
        Objects.requireNonNull(modelId, "modelId must not be null");
        if (embeddingDim <= 0) throw new IllegalArgumentException("embeddingDim must be positive");
        this.modelId = modelId;
        this.embeddingDim = embeddingDim;
    }

    /**
     * Fuses audio and visual features into a joint representation.
     *
     * @param audio  audio feature vector (may be empty for silent frames)
     * @param visual visual feature vector (may be empty for audio-only input)
     * @return fused representation with confidence
     */
    public FusionResult fuseAudioVisual(AudioFeatures audio, VisualFeatures visual) {
        Objects.requireNonNull(audio, "audio features must not be null");
        Objects.requireNonNull(visual, "visual features must not be null");

        boolean missingAudio = audio.isEmpty();
        boolean missingVisual = visual.isEmpty();

        validateConfidence("audio", audio.confidence());
        validateConfidence("visual", visual.confidence());
        if (!missingAudio) validateEmbedding("audio", audio.embeddings());
        if (!missingVisual) validateEmbedding("visual", visual.embeddings());

        if (missingAudio && missingVisual) {
            throw new FusionException("At least one modality must have valid embeddings");
        }
        if (!missingAudio && !missingVisual) {
            validateCompatibleEmbeddingSpaces("audio", audio.embeddingSpaceId(),
                    "visual", visual.embeddingSpaceId());
        }

        long startNs = System.nanoTime();
        double[] fused = fuseVectors(
                missingAudio ? new double[embeddingDim] : audio.embeddings(),
                missingVisual ? new double[embeddingDim] : visual.embeddings(),
                missingAudio ? 0.0 : audio.confidence(),
                missingVisual ? 0.0 : visual.confidence()
        );

        Map<String, Double> weights = normalizedWeights(
                "audio", missingAudio ? 0.0 : audio.confidence(),
                "visual", missingVisual ? 0.0 : visual.confidence());

        Duration elapsed = Duration.ofNanos(System.nanoTime() - startNs);
        double fusionConf = ((missingAudio ? 0.0 : audio.confidence())
                + (missingVisual ? 0.0 : visual.confidence())) / 2.0;
        return new FusionResult(fused, fusionConf, weights, elapsed, missingAudio || missingVisual);
    }

    /**
     * Source-bound fusion seam. It accepts only the same exact source/version/frame/ROI and
     * identical instants on an explicitly shared clock. This establishes timestamp alignment
     * only; it does not claim measured A/V synchronization or authorize speaker-face identity.
     */
    public FusionOutcome fuseAudioVisual(
            AudioFeatures audio, VisualFeatures visual,
            RegionFrame audioRegion, RegionFrame visualRegion,
            com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp audioTime,
            com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp visualTime) {
        if (audio == null || visual == null || audio.isEmpty() || visual.isEmpty()) {
            return abstain("MISSING_MODALITY");
        }
        if (audioRegion == null || visualRegion == null || !audioRegion.equals(visualRegion)) {
            return abstain("SOURCE_FRAME_OR_REGION_MISMATCH");
        }
        if (audioTime == null || visualTime == null
                || audioTime.domain() != com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp.ClockDomain.SOURCE
                || visualTime.domain() != com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp.ClockDomain.SOURCE
                || !audioTime.sharesClock(visualTime)
                || !sameInstant(audioTime, visualTime)) {
            return abstain("SYNC_UNDETERMINED");
        }
        try {
            return new FusionOutcome(Optional.of(fuseAudioVisual(audio, visual)),
                    ConfidenceDisposition.HEURISTIC_UNCALIBRATED,
                    SynchronizationDisposition.SYNC_UNDETERMINED, null);
        } catch (FusionException | NullPointerException invalidInput) {
            return abstain("INVALID_FUSION_INPUT");
        }
    }

    private FusionOutcome abstain(String reason) {
        return new FusionOutcome(Optional.empty(), ConfidenceDisposition.HEURISTIC_UNCALIBRATED,
                SynchronizationDisposition.SYNC_UNDETERMINED, reason);
    }

    private static boolean boundedIdentity(String value) {
        return value != null && !value.isBlank() && value.length() <= 256;
    }

    private boolean sameInstant(
            com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp left,
            com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp right) {
        java.math.BigInteger leftNumerator = java.math.BigInteger.valueOf(left.ticks())
                .multiply(java.math.BigInteger.valueOf(left.timeBaseNumerator()))
                .multiply(java.math.BigInteger.valueOf(right.timeBaseDenominator()));
        java.math.BigInteger rightNumerator = java.math.BigInteger.valueOf(right.ticks())
                .multiply(java.math.BigInteger.valueOf(right.timeBaseNumerator()))
                .multiply(java.math.BigInteger.valueOf(left.timeBaseDenominator()));
        return leftNumerator.equals(rightNumerator);
    }

    /**
     * Fuses text and visual features into a joint representation.
     *
     * @param text   text feature vector
     * @param visual visual feature vector
     * @return fused representation
     */
    public FusionResult fuseTextImage(TextFeatures text, VisualFeatures visual) {
        Objects.requireNonNull(text, "text features must not be null");
        Objects.requireNonNull(visual, "visual features must not be null");

        boolean missingText = text.isEmpty();
        boolean missingVisual = visual.isEmpty();

        validateConfidence("text", text.confidence());
        validateConfidence("visual", visual.confidence());
        if (!missingText) validateEmbedding("text", text.embeddings());
        if (!missingVisual) validateEmbedding("visual", visual.embeddings());

        if (missingText && missingVisual) {
            throw new FusionException("At least one modality must have valid embeddings");
        }
        if (!missingText && !missingVisual) {
            validateCompatibleEmbeddingSpaces("text", text.embeddingSpaceId(),
                    "visual", visual.embeddingSpaceId());
        }

        long startNs = System.nanoTime();
        double[] fused = fuseVectors(
                missingText ? new double[embeddingDim] : text.embeddings(),
                missingVisual ? new double[embeddingDim] : visual.embeddings(),
                missingText ? 0.0 : text.confidence(),
                missingVisual ? 0.0 : visual.confidence()
        );

        Map<String, Double> weights = normalizedWeights(
                "text", missingText ? 0.0 : text.confidence(),
                "visual", missingVisual ? 0.0 : visual.confidence());

        Duration elapsed = Duration.ofNanos(System.nanoTime() - startNs);
        double fusionConf = ((missingText ? 0.0 : text.confidence())
                + (missingVisual ? 0.0 : visual.confidence())) / 2.0;
        return new FusionResult(fused, fusionConf, weights, elapsed, missingText || missingVisual);
    }

    /** @return the model ID this engine was initialized with */
    public String getModelId() { return modelId; }

    /** @return the embedding dimension */
    public int getEmbeddingDim() { return embeddingDim; }

    // ── Private helpers ──────────────────────────────────────────────────────

    private double[] fuseVectors(double[] a, double[] b, double weightA, double weightB) {
        double total = weightA + weightB;
        double wa = total > 0 ? weightA / total : 0.5;
        double wb = total > 0 ? weightB / total : 0.5;
        double[] result = new double[embeddingDim];
        for (int i = 0; i < embeddingDim; i++) {
            result[i] = wa * a[i] + wb * b[i];
            if (!Double.isFinite(result[i])) {
                throw new FusionException("Fused embedding contains a non-finite value");
            }
        }
        return result;
    }

    /** Returns normalized contribution weights; these are not quality or identity confidence. */
    private Map<String, Double> normalizedWeights(
            String nameA, double weightA, String nameB, double weightB) {
        double total = weightA + weightB;
        double wa = total > 0.0 ? weightA / total : 0.5;
        double wb = total > 0.0 ? weightB / total : 0.5;
        Map<String, Double> weights = new LinkedHashMap<>();
        weights.put(nameA, wa);
        weights.put(nameB, wb);
        return weights;
    }

    private void validateEmbedding(String modality, double[] embedding) {
        if (embedding.length != embeddingDim) {
            throw new FusionException(modality + " embedding dimension must equal " + embeddingDim);
        }
        for (double component : embedding) {
            if (!Double.isFinite(component)) {
                throw new FusionException(modality + " embedding contains a non-finite value");
            }
        }
    }

    private void validateCompatibleEmbeddingSpaces(
            String modalityA, String embeddingSpaceA, String modalityB, String embeddingSpaceB) {
        if (embeddingSpaceA == null || embeddingSpaceA.isBlank()
                || embeddingSpaceB == null || embeddingSpaceB.isBlank()) {
            throw new FusionException("Both non-empty modality embeddings must declare a known embeddingSpaceId");
        }
        if (!embeddingSpaceA.equals(embeddingSpaceB)) {
            throw new FusionException("Cannot fuse " + modalityA + " and " + modalityB
                    + " embeddings from incompatible coordinate spaces");
        }
    }

    private void validateConfidence(String modality, double confidence) {
        if (!Double.isFinite(confidence) || confidence < 0.0 || confidence > 1.0) {
            throw new FusionException(modality + " confidence must be finite and in [0, 1]");
        }
    }

    /** Thrown when fusion cannot be performed. */
    public static class FusionException extends RuntimeException {
        public FusionException(String message) { super(message); }
        public FusionException(String message, Throwable cause) { super(message, cause); }
    }
}
