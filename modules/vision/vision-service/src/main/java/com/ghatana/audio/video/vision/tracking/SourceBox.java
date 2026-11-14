package com.ghatana.audio.video.vision.tracking;

/**
 * An axis-aligned box in SOURCE pixel coordinates (origin top-left, x to the right, y down) of an exact frame.
 * Coordinates are finite doubles; {@link #withinFrame} is the single bounds rule used for detections and ROIs.
 *
 * @doc.type record
 * @doc.purpose Source-pixel bounding box with IoU and frame-bounds validation
 * @doc.layer product
 * @doc.pattern Value Object
 */
public record SourceBox(double x, double y, double width, double height) {
    /** Slack (pixels) tolerated when a detector's rounding lands a box edge a hair outside the raster. */
    public static final double EDGE_TOLERANCE = 1.0;

    public SourceBox {
        if (!Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(width) || !Double.isFinite(height)) {
            throw new IllegalArgumentException("box coordinates must be finite");
        }
    }

    public double right() { return x + width; }

    public double bottom() { return y + height; }

    public double area() { return width * height; }

    /** True when the box has positive size and lies inside a {@code frameWidth x frameHeight} raster. */
    public boolean withinFrame(int frameWidth, int frameHeight) {
        return width > 0 && height > 0 && x >= 0 && y >= 0 && right() <= frameWidth && bottom() <= frameHeight;
    }

    /**
     * Clamps edges that are at most {@link #EDGE_TOLERANCE} outside the raster; anything further outside is not a
     * rounding artefact and yields {@code null} (the caller must count it as rejected, never silently keep it).
     */
    public SourceBox clampedToFrame(int frameWidth, int frameHeight) {
        if (width <= 0 || height <= 0) return null;
        if (x < -EDGE_TOLERANCE || y < -EDGE_TOLERANCE
                || right() > frameWidth + EDGE_TOLERANCE || bottom() > frameHeight + EDGE_TOLERANCE) return null;
        double nx = Math.max(0, x);
        double ny = Math.max(0, y);
        double nr = Math.min(frameWidth, right());
        double nb = Math.min(frameHeight, bottom());
        if (nr - nx <= 0 || nb - ny <= 0) return null;
        return new SourceBox(nx, ny, nr - nx, nb - ny);
    }

    public SourceBox translated(double dx, double dy) { return new SourceBox(x + dx, y + dy, width, height); }

    /** Intersection over union in [0, 1]; 0 when either box is degenerate or they do not overlap. */
    public double iou(SourceBox other) {
        double ix = Math.max(0, Math.min(right(), other.right()) - Math.max(x, other.x));
        double iy = Math.max(0, Math.min(bottom(), other.bottom()) - Math.max(y, other.y));
        double inter = ix * iy;
        double union = area() + other.area() - inter;
        return union <= 0 ? 0 : inter / union;
    }
}
