package com.ghatana.audio.video.vision.yolo;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class LetterboxTransformTest {
    @Test void sourcePixelBoxesRoundTripThroughModelCanvasWithinOnePixel() {
        int[][] dimensions = {{1920, 1080}, {720, 1280}, {333, 777}, {1280, 1280}};
        for (int[] size : dimensions) {
            LetterboxTransform transform = LetterboxTransform.fit(size[0], size[1], 640);
            LetterboxTransform.Box source = new LetterboxTransform.Box(
                    size[0] * 0.17, size[1] * 0.23, size[0] * 0.41, size[1] * 0.36);
            LetterboxTransform.Box roundTrip = transform.toSourcePixels(transform.toModelPixels(source));
            assertThat(roundTrip.x()).isCloseTo(source.x(), org.assertj.core.data.Offset.offset(1.0));
            assertThat(roundTrip.y()).isCloseTo(source.y(), org.assertj.core.data.Offset.offset(1.0));
            assertThat(roundTrip.width()).isCloseTo(source.width(), org.assertj.core.data.Offset.offset(1.0));
            assertThat(roundTrip.height()).isCloseTo(source.height(), org.assertj.core.data.Offset.offset(1.0));
            assertThat(transform.toModelPixels(source).x()).isGreaterThanOrEqualTo(transform.padLeft());
        }
    }

    @Test void clipsModelBoxesToSourceRasterBounds() {
        LetterboxTransform transform = LetterboxTransform.fit(1920, 1080, 640);
        var source = transform.toSourcePixels(new LetterboxTransform.Box(-20, 20, 700, 700));
        assertThat(source.x()).isZero();
        assertThat(source.y()).isZero();
        assertThat(source.x() + source.width()).isLessThanOrEqualTo(1920);
        assertThat(source.y() + source.height()).isLessThanOrEqualTo(1080);
    }
}
