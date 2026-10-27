package com.ghatana.audio.video.vision.yolo;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.audio.video.vision.image.ExifOrientationTransform;
import org.junit.jupiter.api.Test;

import java.util.Random;

class LetterboxTransformTest {
    @Test void validatesCanvasFitWithoutIntegerOverflow() {
        int maximum = Integer.MAX_VALUE;

        var valid = new LetterboxTransform(maximum, 1, maximum, maximum, 1, 0, (maximum - 1) / 2);
        assertThat(valid.resizedWidth() + (long) valid.padLeft()).isLessThanOrEqualTo(maximum);
        assertThat(valid.resizedHeight() + (long) valid.padTop()).isLessThanOrEqualTo(maximum);

        assertThatThrownBy(() -> new LetterboxTransform(1, 1, maximum, maximum, 1, 1, 0))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Invalid letterbox geometry");
    }

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

    @Test void randomizedPixelXywhBoxesRoundTripWithinOnePixelAcrossAspectRatios() {
        Random random = new Random(0x56495305L);
        org.assertj.core.data.Offset<Double> tolerance = org.assertj.core.data.Offset.offset(1.0);

        for (int sample = 0; sample < 2_000; sample++) {
            int width = 1 + random.nextInt(16_384);
            int height = 1 + random.nextInt(16_384);
            LetterboxTransform transform = LetterboxTransform.fit(width, height, 640);

            double x = random.nextDouble() * width;
            double y = random.nextDouble() * height;
            double boxWidth = random.nextDouble() * (width - x);
            double boxHeight = random.nextDouble() * (height - y);
            LetterboxTransform.Box source = new LetterboxTransform.Box(x, y, boxWidth, boxHeight);
            LetterboxTransform.Box roundTrip = transform.toSourcePixels(transform.toModelPixels(source));

            assertThat(roundTrip.x()).as("sample %s x", sample).isCloseTo(x, tolerance);
            assertThat(roundTrip.y()).as("sample %s y", sample).isCloseTo(y, tolerance);
            assertThat(roundTrip.width()).as("sample %s width", sample).isCloseTo(boxWidth, tolerance);
            assertThat(roundTrip.height()).as("sample %s height", sample).isCloseTo(boxHeight, tolerance);
        }
    }

    @Test void randomizedClippingReturnsOnlySourceRasterPixels() {
        Random random = new Random(0x434C4950L);

        for (int sample = 0; sample < 2_000; sample++) {
            int width = 1 + random.nextInt(16_384);
            int height = 1 + random.nextInt(16_384);
            LetterboxTransform transform = LetterboxTransform.fit(width, height, 640);
            double x = random.nextDouble() * 1_280 - 320;
            double y = random.nextDouble() * 1_280 - 320;
            double boxWidth = random.nextDouble() * 1_280;
            double boxHeight = random.nextDouble() * 1_280;

            LetterboxTransform.Box clipped = transform.toSourcePixels(
                    new LetterboxTransform.Box(x, y, boxWidth, boxHeight));

            assertThat(clipped.x()).as("sample %s x", sample).isBetween(0.0, (double) width);
            assertThat(clipped.y()).as("sample %s y", sample).isBetween(0.0, (double) height);
            assertThat(clipped.width()).as("sample %s width", sample)
                    .isBetween(0.0, (double) width - clipped.x());
            assertThat(clipped.height()).as("sample %s height", sample)
                    .isBetween(0.0, (double) height - clipped.y());
        }
    }

    @Test void encodedPixelBoxRoundTripsThroughExifOrientationAndLetterboxWithinOnePixel() {
        // Wire bbox coordinates are absolute EXIF-oriented source-raster pixel xywh.
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

    @Test void roiCropLetterboxAndAllExifRotationsMapCornersBackToOrientedSource() {
        int encodedWidth = 1920;
        int encodedHeight = 1080;
        ExifOrientationTransform.Box encodedRoi = new ExifOrientationTransform.Box(320, 180, 1280, 720);
        ExifOrientationTransform.Box encodedDetection = new ExifOrientationTransform.Box(320, 180, 160, 90);

        for (int orientation = 1; orientation <= 8; orientation++) {
            ExifOrientationTransform exif = new ExifOrientationTransform(
                    orientation, encodedWidth, encodedHeight);
            ExifOrientationTransform.Box orientedRoi = exif.toOrientedBox(encodedRoi);
            ExifOrientationTransform.Box orientedDetection = exif.toOrientedBox(encodedDetection);
            SourceRasterRoi roi = new SourceRasterRoi((int) orientedRoi.x(), (int) orientedRoi.y(),
                    (int) orientedRoi.width(), (int) orientedRoi.height(), "frame-v42");
            roi.validateWithin(exif.orientedWidth(), exif.orientedHeight());

            LetterboxTransform letterbox = LetterboxTransform.fit(roi.width(), roi.height(), 640);
            LetterboxTransform.Box cropDetection = new LetterboxTransform.Box(
                    orientedDetection.x() - roi.x(), orientedDetection.y() - roi.y(),
                    orientedDetection.width(), orientedDetection.height());
            LetterboxTransform.Box modelDetection = letterbox.toModelPixels(cropDetection);
            LetterboxTransform.Box sourceDetection = roi.toSourceRasterPixels(letterbox, modelDetection);

            assertThat(sourceDetection.x()).as("orientation %s x", orientation)
                    .isCloseTo(orientedDetection.x(), org.assertj.core.data.Offset.offset(1.0));
            assertThat(sourceDetection.y()).as("orientation %s y", orientation)
                    .isCloseTo(orientedDetection.y(), org.assertj.core.data.Offset.offset(1.0));
            assertThat(sourceDetection.width()).as("orientation %s width", orientation)
                    .isCloseTo(orientedDetection.width(), org.assertj.core.data.Offset.offset(1.0));
            assertThat(sourceDetection.height()).as("orientation %s height", orientation)
                    .isCloseTo(orientedDetection.height(), org.assertj.core.data.Offset.offset(1.0));
        }
    }

    @Test void roiRejectsUnboundOrOutOfRasterGeometryAndMapsClippedDetections() {
        assertThatThrownBy(() -> new SourceRasterRoi(0, 0, 10, 10, " "))
                .isInstanceOf(IllegalArgumentException.class);
        SourceRasterRoi roi = new SourceRasterRoi(100, 50, 320, 240, "frame-v42");
        assertThatThrownBy(() -> roi.validateWithin(400, 289))
                .isInstanceOf(IllegalArgumentException.class);

        LetterboxTransform transform = LetterboxTransform.fit(roi.width(), roi.height(), 640);
        LetterboxTransform.Box mapped = roi.toSourceRasterPixels(
                transform, new LetterboxTransform.Box(-20, 20, 700, 700));
        assertThat(mapped.x()).isEqualTo(roi.x());
        assertThat(mapped.y()).isEqualTo(roi.y());
        assertThat(mapped.x() + mapped.width()).isLessThanOrEqualTo(roi.x() + roi.width());
        assertThat(mapped.y() + mapped.height()).isLessThanOrEqualTo(roi.y() + roi.height());
        assertThatThrownBy(() -> roi.toSourceRasterPixels(
                LetterboxTransform.fit(roi.width() - 1, roi.height(), 640),
                new LetterboxTransform.Box(0, 0, 1, 1)))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
