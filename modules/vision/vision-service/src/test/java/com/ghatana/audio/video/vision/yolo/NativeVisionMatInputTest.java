package com.ghatana.audio.video.vision.yolo;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Path;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.opencv.core.CvType;
import org.opencv.core.Mat;

class NativeVisionMatInputTest {
    @BeforeAll
    static void loadOpenCv() { nu.pattern.OpenCV.loadLocally(); }

    @Test
    void rejectsNativeRastersOutsideDecoderDimensionAndPixelBounds() {
        YoloV8Adapter yoloV8 = new YoloV8Adapter(Path.of("unused"), 0.5, 0.4);
        Mat tooWide = new Mat(1, 8193, CvType.CV_8UC3);
        Mat tooManyPixels = new Mat(4096, 4097, CvType.CV_8UC3);
        try {
            assertThatThrownBy(() -> yoloV8.preprocessImage(tooWide))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("dimensions exceed");
            assertThatThrownBy(() -> YoloXNanoAdapter.preprocess(tooWide))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("dimensions exceed");
            assertThatThrownBy(() -> yoloV8.preprocessImage(tooManyPixels))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("dimensions exceed");
        } finally {
            tooWide.release();
            tooManyPixels.release();
        }
    }

    @Test
    void rejectsUnexpectedNativePixelDepthOrChannelCount() {
        Mat grayscale = new Mat(4, 4, CvType.CV_8UC1);
        Mat floatBgr = new Mat(4, 4, CvType.CV_32FC3);
        try {
            assertThatThrownBy(() -> NativeVisionMatInput.validate(grayscale))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("8-bit three-channel BGR");
            assertThatThrownBy(() -> NativeVisionMatInput.validate(floatBgr))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("8-bit three-channel BGR");
        } finally {
            grayscale.release();
            floatBgr.release();
        }
    }
}
