package com.ghatana.audio.video.vision.model;

/**
 * A single classification label with its confidence score.
 *
 * @doc.type    class
 * @doc.purpose Represents one candidate label from a vision classification backend
 * @doc.layer   product
 * @doc.pattern Model
 */
public record ClassificationCandidate(String label, double confidence) {
    public ClassificationCandidate {
        if (label == null || label.isBlank()) {
            throw new IllegalArgumentException("label must not be blank");
        }
        if (confidence < 0.0 || confidence > 1.0) {
            throw new IllegalArgumentException("confidence must be in [0.0, 1.0]");
        }
    }
}
