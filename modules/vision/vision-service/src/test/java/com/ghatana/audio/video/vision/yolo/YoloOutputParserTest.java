package com.ghatana.audio.video.vision.yolo;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import org.junit.jupiter.api.Test;

class YoloOutputParserTest {
    @Test void parsesChannelMajorTensorAndMapsMaximumClassScoreWithInclusiveThreshold() {
        float[] tensor = tensor(0.5f, 0.75f);
        List<YoloOutputParser.Detection> parsed = YoloOutputParser.parse(1, 6, 1, tensor, 2, 0.75);
        assertThat(parsed).containsExactly(new YoloOutputParser.Detection(1, 0.75, 30, 30, 20, 20));
    }

    @Test void parsesMultipleBoxesFromChannelMajorOutputWithoutMixingTheirScores() {
        // [1, 6, 2]: each channel contains both boxes, as emitted by the YOLOv8 ONNX export.
        float[] tensor = {
                40, 80, // center x
                40, 80, // center y
                20, 20, // width
                20, 20, // height
                0.8f, 0.1f, // class 0 scores
                0.2f, 0.9f  // class 1 scores
        };

        List<YoloOutputParser.Detection> parsed = YoloOutputParser.parse(1, 6, 2, tensor, 2, 0.1);

        assertThat(parsed).containsExactly(
                new YoloOutputParser.Detection(0, (double) 0.8f, 30, 30, 20, 20),
                new YoloOutputParser.Detection(1, (double) 0.9f, 70, 70, 20, 20));
    }

    @Test void rejectsUnsupportedLayoutsAndInconsistentTensorLengths() {
        float[] values = tensor(0.8f, 0.2f);
        assertThatThrownBy(() -> YoloOutputParser.parse(2, 6, 1, values, 2, 0.2))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("batch");
        assertThatThrownBy(() -> YoloOutputParser.parse(1, 5, 1, values, 2, 0.2))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("layout");
        assertThatThrownBy(() -> YoloOutputParser.parse(1, 6, 2, values, 2, 0.2))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("size");
        assertThatThrownBy(() -> YoloOutputParser.parse(1, 6, 0, values, 2, 0.2))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("box count");
    }

    @Test void rejectsClassAndBoxCountsOutsideSupportedBoundsBeforeReadingTensor() {
        assertThatThrownBy(() -> YoloOutputParser.parse(1, 4, 1, new float[0], 0, 0.2))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("channel layout");
        assertThatThrownBy(() -> YoloOutputParser.parse(1, 1005, 1, new float[0], 1001, 0.2))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("channel layout");
        assertThatThrownBy(() -> YoloOutputParser.parse(
                1, 6, YoloOutputParser.MAX_BOXES + 1, new float[0], 2, 0.2))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("box count");
        assertThatThrownBy(() -> YoloOutputParser.parse(1, 6, 1, null, 2, 0.2))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("tensor size");
    }

    @Test void rejectsNonFiniteAndOutOfRangeScores() {
        for (float invalid : new float[] {Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY, -0.01f, 1.01f}) {
            float[] values = tensor(invalid, 0.2f);
            assertThatThrownBy(() -> YoloOutputParser.parse(1, 6, 1, values, 2, 0.2))
                    .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("class scores");
        }
    }

    @Test void rejectsNonFiniteUnboundedAndNonPositiveBoxCoordinates() {
        for (float invalid : new float[] {Float.NaN, Float.POSITIVE_INFINITY, 640.0f * 17.0f}) {
            float[] values = tensor(0.9f, 0.1f);
            values[0] = invalid;
            assertThatThrownBy(() -> YoloOutputParser.parse(1, 6, 1, values, 2, 0.2))
                    .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("center x");
        }
        float[] zeroWidth = tensor(0.9f, 0.1f);
        zeroWidth[2] = 0;
        assertThatThrownBy(() -> YoloOutputParser.parse(1, 6, 1, zeroWidth, 2, 0.2))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("dimensions");
        float[] negativeHeight = tensor(0.9f, 0.1f);
        negativeHeight[3] = -1;
        assertThatThrownBy(() -> YoloOutputParser.parse(1, 6, 1, negativeHeight, 2, 0.2))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("dimensions");
    }

    @Test void respectsConfidenceThresholdAndClassTieOrder() {
        float[] tied = tensor(0.5f);
        assertThat(YoloOutputParser.parse(1, 5, 1, tied, 1, 0.5001)).isEmpty();
        assertThat(YoloOutputParser.parse(1, 5, 1, tied, 1, 0.5).getFirst().classId()).isZero();
        assertThatThrownBy(() -> YoloOutputParser.parse(1, 5, 1, tied, 1, Double.NaN))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("threshold");
        for (double invalidThreshold : new double[] {Double.NEGATIVE_INFINITY, -0.01, 1.01,
                Double.POSITIVE_INFINITY}) {
            assertThatThrownBy(() -> YoloOutputParser.parse(1, 5, 1, tied, 1, invalidThreshold))
                    .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("threshold");
        }
    }

    private static float[] tensor(float... scores) {
        // One [1, 6, 1] tensor in contiguous channel-major order: cx,cy,w,h,score0,score1.
        float[] values = new float[4 + scores.length];
        values[0] = 40;
        values[1] = 40;
        values[2] = 20;
        values[3] = 20;
        System.arraycopy(scores, 0, values, 4, scores.length);
        return values;
    }
}
