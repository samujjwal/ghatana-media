package com.ghatana.audio.video.vision.scene;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

/**
 * Scene understanding service for the Vision pipeline (AV-009.2).
 *
 * <p>Classifies the semantic content of an image into a structured scene description,
 * including dominant scene type, environmental attributes, and salient object categories.
 *
 * <h3>Acceptance criteria (AV-009.2)</h3>
 * <ul>
 *   <li>Semantic scene classification and environmental context detection.</li>
 *   <li>Classification accuracy &gt;90% across at least 20 scene categories.</li>
 * </ul>
 *
 * @doc.type class
 * @doc.purpose Scene classification and environmental understanding for vision analysis
 * @doc.layer product
 * @doc.pattern Service
 */
public final class SceneUnderstandingService {

    private static final Logger LOG = LoggerFactory.getLogger(SceneUnderstandingService.class);

    private final SceneClassificationModel model;
    private final double confidenceThreshold;

    private SceneUnderstandingService(SceneClassificationModel model, double confidenceThreshold) {
        this.model = model;
        this.confidenceThreshold = confidenceThreshold;
    }

    /**
     * Creates a service with a default 60% confidence threshold.
     *
     * @param model the scene classification model
     * @return a new service instance
     * @throws NullPointerException if model is null
     */
    public static SceneUnderstandingService of(SceneClassificationModel model) {
        Objects.requireNonNull(model, "model must not be null");
        return new SceneUnderstandingService(model, 0.60);
    }

    /**
     * Creates a service with an explicit confidence threshold.
     *
     * @param model               the scene classification model
     * @param confidenceThreshold minimum scene confidence to include in results
     * @return a new service instance
     * @throws NullPointerException     if model is null
     * @throws IllegalArgumentException if threshold is not in [0, 1]
     */
    public static SceneUnderstandingService of(SceneClassificationModel model, double confidenceThreshold) {
        Objects.requireNonNull(model, "model must not be null");
        if (confidenceThreshold < 0 || confidenceThreshold > 1) {
            throw new IllegalArgumentException("confidenceThreshold must be in [0, 1]");
        }
        return new SceneUnderstandingService(model, confidenceThreshold);
    }

    // ─── classify ────────────────────────────────────────────────────────────

    /**
     * Classifies the scene in the given image.
     *
     * @param imageBytes raw image bytes (JPEG, PNG, etc.)
     * @return a {@link SceneDescription} containing the top scene and attributes
     * @throws NullPointerException     if imageBytes is null
     * @throws IllegalArgumentException if imageBytes is empty
     */
    public SceneDescription classify(byte[] imageBytes) {
        Objects.requireNonNull(imageBytes, "imageBytes must not be null");
        if (imageBytes.length == 0) {
            throw new IllegalArgumentException("imageBytes must not be empty");
        }

        List<SceneLabel> candidates = model.classify(imageBytes);
        List<SceneLabel> filtered = candidates.stream()
                .filter(l -> l.confidence() >= confidenceThreshold)
                .toList();

        Optional<SceneLabel> top = filtered.isEmpty()
                ? candidates.stream().max(java.util.Comparator.comparingDouble(SceneLabel::confidence))
                : Optional.of(filtered.get(0));

        LOG.debug("Scene classification: {} total, {} above threshold, top={}",
                candidates.size(), filtered.size(), top.map(SceneLabel::label).orElse("none"));

        return new SceneDescription(
                top.orElse(null),
                Collections.unmodifiableList(new ArrayList<>(filtered)),
                imageBytes.length);
    }

    // ─── domain types ─────────────────────────────────────────────────────────

    /** Pluggable scene classification model. */
    public interface SceneClassificationModel {
        /**
         * Classifies the scene in the given image.
         *
         * @param imageBytes raw image bytes
         * @return ranked list of scene labels (highest confidence first)
         */
        List<SceneLabel> classify(byte[] imageBytes);
    }

    /**
     * A scene label with confidence.
     *
     * @param label      the scene category (e.g. {@code "outdoor/park"})
     * @param confidence classification confidence in [0, 1]
     */
    public record SceneLabel(String label, double confidence) {
        public SceneLabel {
            Objects.requireNonNull(label, "label must not be null");
            if (confidence < 0 || confidence > 1) {
                throw new IllegalArgumentException("confidence must be in [0, 1]");
            }
        }
    }

    /**
     * A complete scene understanding result.
     *
     * @param topScene          the highest-confidence scene label (may be null if none)
     * @param qualifyingScenes  all labels above the confidence threshold
     * @param imageSizeBytes    the size of the analysed image in bytes
     */
    public record SceneDescription(
            SceneLabel topScene,
            List<SceneLabel> qualifyingScenes,
            int imageSizeBytes
    ) {
        /** @return true if a top scene was determined */
        public boolean hasTopScene() {
            return topScene != null;
        }

        /** @return the top scene label string, or "unknown" if no scene was determined */
        public String topSceneLabel() {
            return topScene != null ? topScene.label() : "unknown";
        }
    }
}
