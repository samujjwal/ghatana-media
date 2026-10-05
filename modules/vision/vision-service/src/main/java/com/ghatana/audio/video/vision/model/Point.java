package com.ghatana.audio.video.vision.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.Objects;

/**
 * Represents a 2D point in image coordinates.
 *
 * @doc.type model
 * @doc.purpose 2D point coordinates in image space
 * @doc.layer product
 * @doc.pattern ValueObject
 */
public class Point {

    @JsonProperty("x")
    private final double x;

    @JsonProperty("y")
    private final double y;

    public Point(double x, double y) {
        this.x = x;
        this.y = y;
    }

    public double getX() {
        return x;
    }

    public double getY() {
        return y;
    }

    public double distanceTo(Point other) {
        double dx = x - other.x;
        double dy = y - other.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    public Point add(Point other) {
        return new Point(x + other.x, y + other.y);
    }

    public Point subtract(Point other) {
        return new Point(x - other.x, y - other.y);
    }

    public Point multiply(double scalar) {
        return new Point(x * scalar, y * scalar);
    }

    public double dotProduct(Point other) {
        return x * other.x + y * other.y;
    }

    public double magnitude() {
        return Math.sqrt(x * x + y * y);
    }

    public Point normalize() {
        double mag = magnitude();
        if (mag > 0) {
            return new Point(x / mag, y / mag);
        }
        return new Point(0, 0);
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        Point point = (Point) o;
        return Double.compare(point.x, x) == 0 &&
               Double.compare(point.y, y) == 0;
    }

    @Override
    public int hashCode() {
        return Objects.hash(x, y);
    }

    @Override
    public String toString() {
        return "Point{" +
               "x=" + x +
               ", y=" + y +
               '}';
    }
}
