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
    public record AudioFeatures(double[] embeddings, double confidence) {
        public boolean isEmpty() { return embeddings == null || embeddings.length == 0; }
    }

    /** Visual feature vector derived from a video frame. */
    public record VisualFeatures(double[] embeddings, double[] boundingBoxes, double confidence) {
        public boolean isEmpty() { return embeddings == null || embeddings.length == 0; }
    }

    /** Text feature vector derived from transcript or caption. */
    public record TextFeatures(double[] embeddings, String text, double confidence) {
        public boolean isEmpty() { return embeddings == null || embeddings.length == 0; }
    }

    /** Fused multimodal representation. */
    public record FusionResult(
            double[] fusedEmbeddings,
            double fusionConfidence,
            Map<String, Double> modalityWeights,
            Duration processingTime,
            boolean hadMissingModality
    ) {}

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

        if (missingAudio && missingVisual) {
            throw new FusionException("At least one modality must have valid embeddings");
        }

        long startNs = System.nanoTime();
        double[] fused = fuseVectors(
                missingAudio ? new double[embeddingDim] : pad(audio.embeddings(), embeddingDim),
                missingVisual ? new double[embeddingDim] : pad(visual.embeddings(), embeddingDim),
                missingAudio ? 0.0 : audio.confidence(),
                missingVisual ? 0.0 : visual.confidence()
        );

        Map<String, Double> weights = new LinkedHashMap<>();
        weights.put("audio", missingAudio ? 0.0 : audio.confidence());
        weights.put("visual", missingVisual ? 0.0 : visual.confidence());

        Duration elapsed = Duration.ofNanos(System.nanoTime() - startNs);
        double fusionConf = (weights.get("audio") + weights.get("visual")) / 2.0;
        return new FusionResult(fused, fusionConf, weights, elapsed, missingAudio || missingVisual);
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

        if (missingText && missingVisual) {
            throw new FusionException("At least one modality must have valid embeddings");
        }

        long startNs = System.nanoTime();
        double[] fused = fuseVectors(
                missingText ? new double[embeddingDim] : pad(text.embeddings(), embeddingDim),
                missingVisual ? new double[embeddingDim] : pad(visual.embeddings(), embeddingDim),
                missingText ? 0.0 : text.confidence(),
                missingVisual ? 0.0 : visual.confidence()
        );

        Map<String, Double> weights = new LinkedHashMap<>();
        weights.put("text", missingText ? 0.0 : text.confidence());
        weights.put("visual", missingVisual ? 0.0 : visual.confidence());

        Duration elapsed = Duration.ofNanos(System.nanoTime() - startNs);
        double fusionConf = (weights.values().stream().mapToDouble(Double::doubleValue).sum()) / weights.size();
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
        }
        return result;
    }

    private double[] pad(double[] v, int targetLen) {
        if (v.length >= targetLen) return Arrays.copyOf(v, targetLen);
        return Arrays.copyOf(v, targetLen);  // zero-pads automatically
    }

    /** Thrown when fusion cannot be performed. */
    public static class FusionException extends RuntimeException {
        public FusionException(String message) { super(message); }
        public FusionException(String message, Throwable cause) { super(message, cause); }
    }
}
