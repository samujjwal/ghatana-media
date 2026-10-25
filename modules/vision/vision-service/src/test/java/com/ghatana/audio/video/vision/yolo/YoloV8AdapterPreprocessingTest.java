package com.ghatana.audio.video.vision.yolo;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Path;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.opencv.core.CvType;
import org.opencv.core.Mat;
import org.opencv.core.Scalar;

class YoloV8AdapterPreprocessingTest {
    @BeforeAll
    static void loadOpenCv() {
        nu.pattern.OpenCV.loadLocally();
    }

    @Test
    void preprocessingBuilds640BlobWithoutTakingOwnershipOfSourceMat() {
        Mat source = new Mat(3, 2, CvType.CV_8UC3, new Scalar(10, 20, 30));
        Mat blob = null;
        try {
            YoloV8Adapter adapter = new YoloV8Adapter(Path.of("unused"), 0.5, 0.4);
            YoloV8Adapter.PreprocessedInput prepared = adapter.preprocessImage(source);
            blob = prepared.blob();

            assertThat(prepared.transform()).isEqualTo(LetterboxTransform.fit(2, 3, 640));
            assertThat(blob.empty()).isFalse();
            assertThat(blob.dims()).isEqualTo(4);
            assertThat(blob.size(0)).isEqualTo(1);
            assertThat(blob.size(1)).isEqualTo(3);
            assertThat(blob.size(2)).isEqualTo(640);
            assertThat(blob.size(3)).isEqualTo(640);
            assertThat(source.empty()).isFalse();
            assertThat(source.get(0, 0)).containsExactly(10.0, 20.0, 30.0);
        } finally {
            if (blob != null) blob.release();
            source.release();
        }
    }

    @Test
    void repeatedPreprocessingReleasesEachReturnedBlobAndRetainsCallerOwnedSource() {
        Mat source = new Mat(32, 24, CvType.CV_8UC3, new Scalar(20, 40, 60));
        try {
            YoloV8Adapter adapter = new YoloV8Adapter(Path.of("unused"), 0.5, 0.4);
            for (int iteration = 0; iteration < 64; iteration++) {
                Mat blob = adapter.preprocessImage(source).blob();
                try {
                    assertThat(blob.empty()).isFalse();
                    assertThat(blob.size(2)).isEqualTo(640);
                    assertThat(blob.size(3)).isEqualTo(640);
                } finally {
                    blob.release();
                }
                assertThat(source.empty()).isFalse();
            }
        } finally {
            source.release();
        }
    }
}
