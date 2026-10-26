package com.ghatana.audio.video.vision.yolo;

/** A crop in the EXIF-oriented source raster, bound to the exact immutable frame version. */
public record SourceRasterRoi(int x, int y, int width, int height, String sourceFrameVersion) {
    public SourceRasterRoi {
        if (x < 0 || y < 0 || width < 1 || height < 1
                || sourceFrameVersion == null || sourceFrameVersion.isBlank()) {
            throw new IllegalArgumentException("ROI requires non-negative top-left XYWH pixels and a source frame version");
        }
        try {
            Math.addExact(x, width);
            Math.addExact(y, height);
        } catch (ArithmeticException overflow) {
            throw new IllegalArgumentException("ROI bounds overflow", overflow);
        }
    }

    public void validateWithin(int sourceWidth, int sourceHeight) {
        if (sourceWidth < 1 || sourceHeight < 1 || x + width > sourceWidth || y + height > sourceHeight) {
            throw new IllegalArgumentException("ROI must fit within the EXIF-oriented source raster");
        }
    }

    /** Maps a model-canvas detection through letterbox inversion and crop translation. */
    public LetterboxTransform.Box toSourceRasterPixels(LetterboxTransform transform,
                                                        LetterboxTransform.Box modelBox) {
        if (transform.sourceWidth() != width || transform.sourceHeight() != height) {
            throw new IllegalArgumentException("Letterbox dimensions must match the ROI crop dimensions");
        }
        LetterboxTransform.Box cropBox = transform.toSourcePixels(modelBox);
        return new LetterboxTransform.Box(x + cropBox.x(), y + cropBox.y(),
                cropBox.width(), cropBox.height());
    }
}
