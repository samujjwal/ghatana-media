package com.ghatana.audio.video.multimodal.engine;

/**
 * A single object detection result.
 * @doc.type class
 * @doc.purpose Provides detection result functionality.
 * @doc.layer product
 * @doc.pattern ValueObject
 */
public final class DetectionResult {

    private final String className;
    private final double confidence;
    private final double x;
    private final double y;
    private final double width;
    private final double height;

    /**
     * Creates an immutable object detection result.
     */
    public DetectionResult(String className, double confidence,
                           double x, double y, double width, double height) {
        if (!Double.isFinite(confidence) || confidence < 0.0 || confidence > 1.0) {
            throw new IllegalArgumentException("Detection confidence must be finite and in [0, 1]");
        }
        // Match the platform pixel-space box contract: origins may be outside the image;
        // extents are nonnegative and derived bounds/area must remain finite.
        if (!Double.isFinite(x) || !Double.isFinite(y)
                || !Double.isFinite(width) || !Double.isFinite(height)
                || width < 0.0 || height < 0.0
                || !Double.isFinite(x + width) || !Double.isFinite(y + height)
                || !Double.isFinite(width * height)) {
            throw new IllegalArgumentException(
                    "Detection box must have finite coordinates and nonnegative finite extents, bounds, and area");
        }
        this.className = className;
        this.confidence = confidence;
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
    }

    public String getClassName() {
        return className;
    }

    public double getConfidence() {
        return confidence;
    }

    public double getX() {
        return x;
    }

    public double getY() {
        return y;
    }

    public double getWidth() {
        return width;
    }

    public double getHeight() {
        return height;
    }
}
