package com.ghatana.audio.video.vision.yolo;

/** Pixel-space transform between a source raster and the model's square letterboxed input. */
public record LetterboxTransform(
        int sourceWidth, int sourceHeight, int inputSize,
        int resizedWidth, int resizedHeight, int padLeft, int padTop) {

    public LetterboxTransform {
        if (sourceWidth < 1 || sourceHeight < 1 || inputSize < 1
                || resizedWidth < 1 || resizedHeight < 1
                || padLeft < 0 || padTop < 0
                || resizedWidth > inputSize - padLeft || resizedHeight > inputSize - padTop) {
            throw new IllegalArgumentException("Invalid letterbox geometry");
        }
    }

    public static LetterboxTransform fit(int sourceWidth, int sourceHeight, int inputSize) {
        if (sourceWidth < 1 || sourceHeight < 1 || inputSize < 1) {
            throw new IllegalArgumentException("Image and model dimensions must be positive");
        }
        double scale = Math.min((double) inputSize / sourceWidth, (double) inputSize / sourceHeight);
        int width = Math.max(1, (int) Math.round(sourceWidth * scale));
        int height = Math.max(1, (int) Math.round(sourceHeight * scale));
        return new LetterboxTransform(sourceWidth, sourceHeight, inputSize,
                width, height, (inputSize - width) / 2, (inputSize - height) / 2);
    }

    public Box toModelPixels(Box source) {
        double sx = (double) resizedWidth / sourceWidth;
        double sy = (double) resizedHeight / sourceHeight;
        return new Box(source.x() * sx + padLeft, source.y() * sy + padTop,
                source.width() * sx, source.height() * sy);
    }

    /** Returns a source-raster pixel xywh box, clipped to source bounds. */
    public Box toSourcePixels(Box model) {
        double sx = (double) resizedWidth / sourceWidth;
        double sy = (double) resizedHeight / sourceHeight;
        double x1 = clamp((model.x() - padLeft) / sx, 0, sourceWidth);
        double y1 = clamp((model.y() - padTop) / sy, 0, sourceHeight);
        double x2 = clamp((model.x() + model.width() - padLeft) / sx, 0, sourceWidth);
        double y2 = clamp((model.y() + model.height() - padTop) / sy, 0, sourceHeight);
        return new Box(x1, y1, Math.max(0, x2 - x1), Math.max(0, y2 - y1));
    }

    private static double clamp(double value, double minimum, double maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }

    public record Box(double x, double y, double width, double height) {
        public Box {
            if (!Double.isFinite(x) || !Double.isFinite(y)
                    || !Double.isFinite(width) || !Double.isFinite(height)
                    || width < 0 || height < 0
                    || !Double.isFinite(x + width) || !Double.isFinite(y + height)) {
                throw new IllegalArgumentException("Bounding box must contain finite coordinates and non-negative size");
            }
        }
    }
}
