package com.ghatana.audio.video.vision.yolo;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.opencv.core.CvType;
import org.opencv.core.Mat;
import org.opencv.core.Scalar;

import static org.assertj.core.api.Assertions.assertThat;

class YoloXNanoAdapterPreprocessingTest {
    @BeforeAll
    static void loadOpenCv() { nu.pattern.OpenCV.loadLocally(); }

    @Test
    void preprocessesRgbNormalizedTensorWithUpstreamTopLeftPadding() {
        Mat source = new Mat(200, 100, CvType.CV_8UC3, new Scalar(10, 20, 30));
        Mat blob = null;
        try {
            YoloXNanoAdapter.PreprocessedInput prepared = YoloXNanoAdapter.preprocess(source);
            blob = prepared.blob();
            assertThat(prepared.transform()).isEqualTo(new LetterboxTransform(100, 200, 416, 208, 416, 0, 0));
            assertThat(blob.dims()).isEqualTo(4);
            assertThat(blob.size(0)).isEqualTo(1);
            assertThat(blob.size(1)).isEqualTo(3);
            assertThat(blob.size(2)).isEqualTo(416);
            assertThat(blob.size(3)).isEqualTo(416);
            assertThat(blob.get(new int[] {0, 0, 20, 20})[0]).isCloseTo(30.0 / 255.0,
                    org.assertj.core.data.Offset.offset(0.00001));
            assertThat(blob.get(new int[] {0, 0, 20, 300})[0]).isCloseTo(114.0 / 255.0,
                    org.assertj.core.data.Offset.offset(0.00001));
            assertThat(source.get(0, 0)).containsExactly(10.0, 20.0, 30.0);
        } finally {
            if (blob != null) blob.release();
            source.release();
        }
    }
}
