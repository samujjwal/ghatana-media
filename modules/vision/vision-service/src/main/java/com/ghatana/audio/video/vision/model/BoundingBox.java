package com.ghatana.audio.video.vision.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.Objects;

/**
 * Represents a bounding box for object detection.
 *
 * @doc.type model
 * @doc.purpose Bounding box coordinates for detected objects
 * @doc.layer product
 * @doc.pattern ValueObject
 */
public class BoundingBox {

    @JsonProperty("x")
    private final double x;

    @JsonProperty("y")
    private final double y;

    @JsonProperty("width")
    private final double width;

    @JsonProperty("height")
    private final double height;

    private BoundingBox(Builder builder) {
        this.x = builder.x;
        this.y = builder.y;
        this.width = builder.width;
        this.height = builder.height;
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

    /**
     * Get the center point of the bounding box.
     *
     * @return center point coordinates
     */
    public Point getCenter() {
        return new Point(x + width / 2, y + height / 2);
    }

    /**
     * Get the area of the bounding box.
     *
     * @return area in square pixels
     */
    public double getArea() {
        return width * height;
    }

    /**
     * Check if this bounding box intersects with another.
     *
     * @param other other bounding box
     * @return true if intersecting
     */
    public boolean intersects(BoundingBox other) {
        return x < other.x + other.width &&
               x + width > other.x &&
               y < other.y + other.height &&
               y + height > other.y;
    }

    /**
     * Calculate intersection over union (IoU) with another bounding box.
     *
     * @param other other bounding box
     * @return IoU value between 0 and 1
     */
    public double calculateIoU(BoundingBox other) {
        double intersectionArea = calculateIntersectionArea(other);
        double unionArea = getArea() + other.getArea() - intersectionArea;

        return unionArea > 0 ? intersectionArea / unionArea : 0.0;
    }

    private double calculateIntersectionArea(BoundingBox other) {
        double x1 = Math.max(x, other.x);
        double y1 = Math.max(y, other.y);
        double x2 = Math.min(x + width, other.x + other.width);
        double y2 = Math.min(y + height, other.y + other.height);

        if (x2 > x1 && y2 > y1) {
            return (x2 - x1) * (y2 - y1);
        }

        return 0.0;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        BoundingBox that = (BoundingBox) o;
        return Double.compare(that.x, x) == 0 &&
               Double.compare(that.y, y) == 0 &&
               Double.compare(that.width, width) == 0 &&
               Double.compare(that.height, height) == 0;
    }

    @Override
    public int hashCode() {
        return Objects.hash(x, y, width, height);
    }

    @Override
    public String toString() {
        return "BoundingBox{" +
               "x=" + x +
               ", y=" + y +
               ", width=" + width +
               ", height=" + height +
               '}';
    }

    public static Builder builder() {
        return new Builder();
    }

    public static class Builder {
        private double x;
        private double y;
        private double width;
        private double height;

        public Builder x(double x) {
            this.x = x;
            return this;
        }

        public Builder y(double y) {
            this.y = y;
            return this;
        }

        public Builder width(double width) {
            this.width = width;
            return this;
        }

        public Builder height(double height) {
            this.height = height;
            return this;
        }

        public BoundingBox build() {
            return new BoundingBox(this);
        }
    }
}
