package com.ghatana.audio.video.vision.ocr;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * Optical Character Recognition (OCR) service for the Vision pipeline (AV-009.3).
 *
 * <p>Extracts text regions from images using a pluggable {@link OcrModel}.
 * Returns a structured list of {@link TextRegion} objects that include the
 * recognised text, bounding box, and confidence score.
 *
 * <h3>Acceptance criteria (AV-009.3)</h3>
 * <ul>
 *   <li>Text extraction from images with structural output.</li>
 *   <li>OCR accuracy &gt;95% (validated in quality tests).</li>
 * </ul>
 *
 * @doc.type class
 * @doc.purpose OCR text extraction service for the vision analysis pipeline
 * @doc.layer product
 * @doc.pattern Service
 */
public final class OcrService {

    private static final Logger LOG = LoggerFactory.getLogger(OcrService.class);

    private final OcrModel model;
    private final double confidenceThreshold;

    private OcrService(OcrModel model, double confidenceThreshold) {
        this.model = model;
        this.confidenceThreshold = confidenceThreshold;
    }

    /**
     * Creates an OCR service with the given model and a 70% confidence threshold.
     *
     * @param model the OCR model to use
     * @return a new service instance
     * @throws NullPointerException if model is null
     */
    public static OcrService of(OcrModel model) {
        Objects.requireNonNull(model, "model must not be null");
        return new OcrService(model, 0.70);
    }

    /**
     * Creates an OCR service with an explicit confidence threshold.
     *
     * @param model               the OCR model to use
     * @param confidenceThreshold minimum region confidence to include in results
     * @return a new service instance
     * @throws NullPointerException     if model is null
     * @throws IllegalArgumentException if threshold is out of [0, 1]
     */
    public static OcrService of(OcrModel model, double confidenceThreshold) {
        Objects.requireNonNull(model, "model must not be null");
        if (confidenceThreshold < 0 || confidenceThreshold > 1) {
            throw new IllegalArgumentException("confidenceThreshold must be in [0, 1]");
        }
        return new OcrService(model, confidenceThreshold);
    }

    // ─── extract ──────────────────────────────────────────────────────────────

    /**
     * Extracts all text regions from the given image.
     *
     * @param imageBytes raw image bytes (JPEG, PNG, etc.)
     * @return an unmodifiable list of {@link TextRegion} objects above the confidence threshold
     * @throws NullPointerException     if imageBytes is null
     * @throws IllegalArgumentException if imageBytes is empty
     */
    public List<TextRegion> extract(byte[] imageBytes) {
        Objects.requireNonNull(imageBytes, "imageBytes must not be null");
        if (imageBytes.length == 0) {
            throw new IllegalArgumentException("imageBytes must not be empty");
        }

        List<TextRegion> raw = model.extractRegions(imageBytes);
        List<TextRegion> filtered = raw.stream()
                .filter(r -> r.confidence() >= confidenceThreshold)
                .toList();

        LOG.debug("OCR: {} raw regions → {} above threshold ({}) in {} byte image",
                raw.size(), filtered.size(), confidenceThreshold, imageBytes.length);
        return Collections.unmodifiableList(new ArrayList<>(filtered));
    }

    /**
     * Concatenates all extracted text regions into a single plain-text string.
     *
     * @param imageBytes raw image bytes
     * @return the full document text in reading order
     * @throws NullPointerException     if imageBytes is null
     * @throws IllegalArgumentException if imageBytes is empty
     */
    public String extractText(byte[] imageBytes) {
        return String.join("\n", extract(imageBytes).stream()
                .map(TextRegion::text)
                .toList());
    }

    // ─── domain types ─────────────────────────────────────────────────────────

    /** Pluggable OCR model. */
    public interface OcrModel {
        /**
         * Extracts all text regions from the given image bytes.
         *
         * @param imageBytes raw image bytes
         * @return list of detected text regions (unfiltered)
         */
        List<TextRegion> extractRegions(byte[] imageBytes);
    }

    /**
     * A localised text region extracted from an image.
     *
     * @param text        the recognised text
     * @param boundingBox bounding box in relative coordinates
     * @param confidence  recognition confidence in [0, 1]
     * @param readingOrder zero-based position in reading order (top-to-bottom, left-to-right)
     */
    public record TextRegion(String text, BoundingBox boundingBox, double confidence, int readingOrder) {
        public TextRegion {
            Objects.requireNonNull(text, "text must not be null");
            Objects.requireNonNull(boundingBox, "boundingBox must not be null");
            if (confidence < 0 || confidence > 1) {
                throw new IllegalArgumentException("confidence must be in [0, 1]");
            }
            if (readingOrder < 0) {
                throw new IllegalArgumentException("readingOrder must be >= 0");
            }
        }
    }

    /**
     * Bounding box in relative image coordinates.
     *
     * @param x      left edge in [0, 1]
     * @param y      top edge in [0, 1]
     * @param width  width in [0, 1]
     * @param height height in [0, 1]
     */
    public record BoundingBox(double x, double y, double width, double height) {}
}
