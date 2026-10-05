package com.ghatana.media.common;

/**
 * Bounding box for object detection.
 *
 * @doc.type record
 * @doc.purpose Shared bounding box value object for detection results
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public record BoundingBox(
    double x,
    double y,
    double width,
    double height,
    double confidence
) {
    public BoundingBox {
        if (width < 0) throw new IllegalArgumentException("width cannot be negative");
        if (height < 0) throw new IllegalArgumentException("height cannot be negative");
        if (confidence < 0 || confidence > 1) {
            throw new IllegalArgumentException("confidence must be in [0, 1]");
        }
    }

    public double centerX() {
        return x + width / 2.0;
    }

    public double centerY() {
        return y + height / 2.0;
    }

    public double area() {
        return width * height;
    }

    public boolean intersects(BoundingBox other) {
        return x < other.x + other.width
            && x + width > other.x
            && y < other.y + other.height
            && y + height > other.y;
    }

    public double iou(BoundingBox other) {
        if (!intersects(other)) {
            return 0.0;
        }

        double intersectX = Math.max(x, other.x);
        double intersectY = Math.max(y, other.y);
        double intersectW = Math.min(x + width, other.x + other.width) - intersectX;
        double intersectH = Math.min(y + height, other.y + other.height) - intersectY;

        double intersectArea = intersectW * intersectH;
        double unionArea = area() + other.area() - intersectArea;
        return intersectArea / unionArea;
    }
}
