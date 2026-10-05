package com.ghatana.media.common;

import java.util.Objects;

/**
 * Image data container.
 *
 * @doc.type record
 * @doc.purpose Immutable image data with metadata
 * @doc.layer common
 * @doc.pattern ValueObject
 */
public record ImageData(
    byte[] data,
    int width,
    int height,
    ImageFormat format,
    ColorSpace colorSpace
) {
    public ImageData {
        Objects.requireNonNull(data, "data cannot be null");
        if (width <= 0) throw new IllegalArgumentException("width must be positive");
        if (height <= 0) throw new IllegalArgumentException("height must be positive");
    }

    public static Builder builder() { return new Builder(); }

    public static final class Builder {
        private byte[] data;
        private int width;
        private int height;
        private ImageFormat format = ImageFormat.PNG;
        private ColorSpace colorSpace = ColorSpace.RGB;

        public Builder data(byte[] v) { this.data = v; return this; }
        public Builder width(int v) { this.width = v; return this; }
        public Builder height(int v) { this.height = v; return this; }
        public Builder format(ImageFormat v) { this.format = v; return this; }
        public Builder colorSpace(ColorSpace v) { this.colorSpace = v; return this; }

        public ImageData build() {
            return new ImageData(data, width, height, format, colorSpace);
        }
    }
}
