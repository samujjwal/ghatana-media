package com.ghatana.audio.video.vision.yolo;

import org.opencv.core.CvType;
import org.opencv.core.Mat;

/** Bounds caller-owned native rasters before resizing or allocating model input buffers. */
final class NativeVisionMatInput {
    private static final int MAX_DIMENSION = 8192;
    private static final long MAX_PIXELS = 16_000_000L;

    private NativeVisionMatInput() { }

    static void validate(Mat image) {
        if (image == null || image.empty()) {
            throw new IllegalArgumentException("Image must not be empty");
        }
        int width = image.cols();
        int height = image.rows();
        if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION
                || (long) width * height > MAX_PIXELS) {
            throw new IllegalArgumentException("Native image dimensions exceed the supported bounds");
        }
        if (image.type() != CvType.CV_8UC3) {
            throw new IllegalArgumentException("Native image must use 8-bit three-channel BGR pixels");
        }
    }
}
