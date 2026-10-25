package com.ghatana.audio.video.vision.yolo;

import static org.assertj.core.api.Assertions.assertThat;

import com.ghatana.audio.video.vision.image.ExifOrientationTransform;
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

    @Test void encodedPixelBoxRoundTripsThroughExifOrientationAndLetterboxWithinOnePixel() {
        // This checks the existing implementation's pixel-boundary xywh transforms only.
        // PDP-1 protobuf-vision still leaves the public wire bbox origin, units, and
        // reference dimensions unresolved, so this is not a public coordinate-contract claim.
        int encodedWidth = 1920;
        int encodedHeight = 1080;
        ExifOrientationTransform.Box encodedBox = new ExifOrientationTransform.Box(
                encodedWidth * 0.17, encodedHeight * 0.23,
                encodedWidth * 0.41, encodedHeight * 0.36);
        org.assertj.core.data.Offset<Double> tolerance = org.assertj.core.data.Offset.offset(1.0);

        for (int orientation = 1; orientation <= 8; orientation++) {
            ExifOrientationTransform exif = new ExifOrientationTransform(
                    orientation, encodedWidth, encodedHeight);
            LetterboxTransform letterbox = LetterboxTransform.fit(
                    exif.orientedWidth(), exif.orientedHeight(), 640);

            ExifOrientationTransform.Box decodedRasterBox = exif.toOrientedBox(encodedBox);
            LetterboxTransform.Box modelInputBox = letterbox.toModelPixels(new LetterboxTransform.Box(
                    decodedRasterBox.x(), decodedRasterBox.y(),
                    decodedRasterBox.width(), decodedRasterBox.height()));
            LetterboxTransform.Box decodedSourceRasterBox = letterbox.toSourcePixels(modelInputBox);
            ExifOrientationTransform.Box roundTrip = exif.toSourceBox(new ExifOrientationTransform.Box(
                    decodedSourceRasterBox.x(), decodedSourceRasterBox.y(),
                    decodedSourceRasterBox.width(), decodedSourceRasterBox.height()));

            assertThat(roundTrip.x()).as("orientation %s left", orientation)
                    .isCloseTo(encodedBox.x(), tolerance);
            assertThat(roundTrip.y()).as("orientation %s top", orientation)
                    .isCloseTo(encodedBox.y(), tolerance);
            assertThat(roundTrip.width()).as("orientation %s width", orientation)
                    .isCloseTo(encodedBox.width(), tolerance);
            assertThat(roundTrip.height()).as("orientation %s height", orientation)
                    .isCloseTo(encodedBox.height(), tolerance);
        }
    }
}
