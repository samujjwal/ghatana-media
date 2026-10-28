package com.ghatana.audio.video.vision.yolo;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class YoloXNanoOutputParserTest {
    @Test
    void decodesStrideAnchorsAndMultipliesObjectnessByClassScore() {
        float[] output = emptyOutput();
        output[4] = 0.8f;
        output[5] = 0.5f;
        var decoded = YoloXNanoOutputParser.decode(1, 3549, 85, output, 0.39);
        assertThat(decoded).hasSize(1);
        assertThat(decoded.getFirst().classId()).isZero();
        assertThat(decoded.getFirst().confidence()).isCloseTo(0.4, org.assertj.core.data.Offset.offset(0.000001));
        assertThat(decoded.getFirst().x()).isEqualTo(-4.0);
        assertThat(decoded.getFirst().y()).isEqualTo(-4.0);
        assertThat(decoded.getFirst().width()).isEqualTo(8.0);
        assertThat(decoded.getFirst().height()).isEqualTo(8.0);
    }

    @Test
    void appliesGridOffsetForLaterStrideCells() {
        float[] output = emptyOutput();
        int firstStride16Prediction = 52 * 52;
        int offset = firstStride16Prediction * 85;
        output[offset] = 0.25f;
        output[offset + 1] = 0.5f;
        output[offset + 4] = 1.0f;
        output[offset + 5 + 2] = 0.9f;
        var decoded = YoloXNanoOutputParser.decode(1, 3549, 85, output, 0.1);
        assertThat(decoded).hasSize(1);
        assertThat(decoded.getFirst().classId()).isEqualTo(2);
        assertThat(decoded.getFirst().x()).isEqualTo(-4.0);
        assertThat(decoded.getFirst().y()).isEqualTo(0.0);
        assertThat(decoded.getFirst().width()).isEqualTo(16.0);
    }

    @Test
    void rejectsWrongShapeMalformedScoresAndExplosiveAnchors() {
        assertThatThrownBy(() -> YoloXNanoOutputParser.decode(1, 3548, 85, new float[3548 * 85], 0.2))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("exactly [1,3549,85]");
        float[] invalidScore = emptyOutput();
        invalidScore[4] = 1.01f;
        assertThatThrownBy(() -> YoloXNanoOutputParser.decode(1, 3549, 85, invalidScore, 0.2))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("objectness");
        float[] overflow = emptyOutput();
        overflow[2] = 21.0f;
        assertThatThrownBy(() -> YoloXNanoOutputParser.decode(1, 3549, 85, overflow, 0.2))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("decode bound");
        float[] nan = emptyOutput();
        nan[85 + 5] = Float.NaN;
        assertThatThrownBy(() -> YoloXNanoOutputParser.decode(1, 3549, 85, nan, 0.2))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("finite");
    }

    @Test
    void exactInputAndOutputContractAreExplicit() {
        assertThat(YoloXNanoOutputParser.INPUT_SIZE).isEqualTo(416);
        assertThat(YoloXNanoOutputParser.PREDICTION_COUNT).isEqualTo(3549);
        assertThat(YoloXNanoOutputParser.ATTRIBUTES).isEqualTo(85);
    }

    private static float[] emptyOutput() {
        return new float[YoloXNanoOutputParser.PREDICTION_COUNT * YoloXNanoOutputParser.ATTRIBUTES];
    }
}
