package com.ghatana.audio.video.vision.image;

/** Pixel and half-open rectangle transforms from encoded raster coordinates to EXIF-oriented coordinates. */
public record ExifOrientationTransform(int orientation, int sourceWidth, int sourceHeight) {
    public ExifOrientationTransform {
        if (orientation < 1 || orientation > 8 || sourceWidth < 1 || sourceHeight < 1) {
            throw new IllegalArgumentException("Invalid EXIF orientation or source dimensions");
        }
    }

    public int orientedWidth() { return orientation >= 5 ? sourceHeight : sourceWidth; }
    public int orientedHeight() { return orientation >= 5 ? sourceWidth : sourceHeight; }

    /** Maps an encoded-raster pixel index to its EXIF-oriented raster pixel index. */
    public Pixel toOrientedPixel(int x, int y) {
        if (x < 0 || y < 0 || x >= sourceWidth || y >= sourceHeight) {
            throw new IllegalArgumentException("Source pixel is outside image bounds");
        }
        return switch (orientation) {
            case 1 -> new Pixel(x, y);
            case 2 -> new Pixel(sourceWidth - 1 - x, y);
            case 3 -> new Pixel(sourceWidth - 1 - x, sourceHeight - 1 - y);
            case 4 -> new Pixel(x, sourceHeight - 1 - y);
            case 5 -> new Pixel(y, x);
            case 6 -> new Pixel(sourceHeight - 1 - y, x);
            case 7 -> new Pixel(sourceHeight - 1 - y, sourceWidth - 1 - x);
            case 8 -> new Pixel(y, sourceWidth - 1 - x);
            default -> throw new IllegalStateException("Validated orientation became invalid");
        };
    }

    public Pixel toSourcePixel(int x, int y) {
        ExifOrientationTransform inverse = new ExifOrientationTransform(
                inverseOrientation(orientation), orientedWidth(), orientedHeight());
        return inverse.toOrientedPixel(x, y);
    }

    /** Maps half-open pixel-edge xywh bounds, preserving width and height through rotations. */
    public Box toOrientedBox(Box box) {
        if (box.x < 0 || box.y < 0 || box.width < 0 || box.height < 0
                || box.x + box.width > sourceWidth || box.y + box.height > sourceHeight) {
            throw new IllegalArgumentException("Source box is outside image bounds");
        }
        return switch (orientation) {
            case 1 -> box;
            case 2 -> new Box(sourceWidth - box.x - box.width, box.y, box.width, box.height);
            case 3 -> new Box(sourceWidth - box.x - box.width,
                    sourceHeight - box.y - box.height, box.width, box.height);
            case 4 -> new Box(box.x, sourceHeight - box.y - box.height, box.width, box.height);
            case 5 -> new Box(box.y, box.x, box.height, box.width);
            case 6 -> new Box(sourceHeight - box.y - box.height, box.x, box.height, box.width);
            case 7 -> new Box(sourceHeight - box.y - box.height,
                    sourceWidth - box.x - box.width, box.height, box.width);
            case 8 -> new Box(box.y, sourceWidth - box.x - box.width, box.height, box.width);
            default -> throw new IllegalStateException("Validated orientation became invalid");
        };
    }

    public Box toSourceBox(Box box) {
        ExifOrientationTransform inverse = new ExifOrientationTransform(
                inverseOrientation(orientation), orientedWidth(), orientedHeight());
        return inverse.toOrientedBox(box);
    }

    private static int inverseOrientation(int value) {
        return switch (value) {
            case 1, 2, 3, 4, 5, 7 -> value;
            case 6 -> 8;
            case 8 -> 6;
            default -> throw new IllegalStateException("Validated orientation became invalid");
        };
    }

    public record Pixel(int x, int y) { }
    public record Box(double x, double y, double width, double height) { }
}
