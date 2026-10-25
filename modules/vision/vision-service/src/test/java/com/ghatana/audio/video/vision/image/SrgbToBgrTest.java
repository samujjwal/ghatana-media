package com.ghatana.audio.video.vision.image;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class SrgbToBgrTest {
    @Test void convertsRedSrgbToBgrForRgbModelBlob() {
        assertThat(SrgbToBgr.convert(0xFFFF0000)).containsExactly(0.0, 0.0, 255.0);
    }

    @Test void transparentInputIsCompositedOnNeutralGrayBeforeThreeChannelInference() {
        assertThat(SrgbToBgr.convert(0x00FF0000)).containsExactly(114.0, 114.0, 114.0);
        double gray = 114.0 * 127.0 / 255.0;
        double red = 255.0 * 128.0 / 255.0 + gray;
        double[] bgr = SrgbToBgr.convert(0x80FF0000);
        assertThat(bgr[0]).isCloseTo(gray, org.assertj.core.data.Offset.offset(1e-12));
        assertThat(bgr[1]).isCloseTo(gray, org.assertj.core.data.Offset.offset(1e-12));
        assertThat(bgr[2]).isCloseTo(red, org.assertj.core.data.Offset.offset(1e-12));
    }
}
