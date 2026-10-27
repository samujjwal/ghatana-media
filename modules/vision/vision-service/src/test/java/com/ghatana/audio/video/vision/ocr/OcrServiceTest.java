package com.ghatana.audio.video.vision.ocr;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

class OcrServiceTest {

    @Test
    void normalizedRegionBoundsAcceptEdgesAndRejectInvalidOrOutOfImageCoordinates() {
        org.assertj.core.api.Assertions.assertThatCode(() ->
                new OcrService.BoundingBox(0.0, 0.0, 1.0, 1.0))
                .doesNotThrowAnyException();
        org.assertj.core.api.Assertions.assertThatCode(() ->
                new OcrService.BoundingBox(1.0, 1.0, 0.0, 0.0))
                .doesNotThrowAnyException();

        for (double[] invalid : new double[][] {
                {-0.01, 0.0, 0.1, 0.1}, {0.0, -0.01, 0.1, 0.1},
                {0.0, 0.0, 1.01, 0.1}, {0.0, 0.0, 0.1, 1.01},
                {0.9, 0.0, 0.2, 0.1}, {0.0, 0.9, 0.1, 0.2},
                {Double.NaN, 0.0, 0.1, 0.1}, {0.0, Double.POSITIVE_INFINITY, 0.1, 0.1}
        }) {
            assertThatThrownBy(() -> new OcrService.BoundingBox(
                    invalid[0], invalid[1], invalid[2], invalid[3]))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("normalized source image coordinates");
        }
    }

    @Test
    void factoryRejectsNonFiniteThresholdsAndAcceptsInclusiveBounds() {
        OcrService.OcrModel model = image -> List.of();
        for (double invalid : new double[] {
                Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY
        }) {
            assertThatThrownBy(() -> OcrService.of(model, invalid))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        for (double boundary : new double[] {0.0, 1.0}) {
            org.assertj.core.api.Assertions.assertThatCode(() -> OcrService.of(model, boundary))
                    .doesNotThrowAnyException();
        }
    }

    @Test
    void extractFailsNotAdmittedWithoutCallingLegacyModel() {
        AtomicInteger calls = new AtomicInteger();
        OcrService service = OcrService.of(image -> {
            calls.incrementAndGet();
            return List.of(new OcrService.TextRegion(
                    "fabricated invoice text",
                    new OcrService.BoundingBox(0.1, 0.2, 0.3, 0.1),
                    0.99,
                    0));
        });

        assertThatThrownBy(() -> service.extract(new byte[]{1}))
                .isInstanceOf(OcrService.NotAdmittedException.class)
                .hasMessage("NOT_ADMITTED: Document Intelligence public API adapter is unavailable");
        org.assertj.core.api.Assertions.assertThat(calls).hasValue(0);
    }

    @Test
    void extractTextAlsoFailsNotAdmittedWithoutCallingLegacyModel() {
        AtomicInteger calls = new AtomicInteger();
        OcrService service = OcrService.of(image -> {
            calls.incrementAndGet();
            return List.of(new OcrService.TextRegion(
                    "fabricated invoice text",
                    new OcrService.BoundingBox(0.1, 0.2, 0.3, 0.1),
                    0.99,
                    0));
        });

        assertThatThrownBy(() -> service.extractText(new byte[]{1}))
                .isInstanceOf(OcrService.NotAdmittedException.class)
                .hasMessage("NOT_ADMITTED: Document Intelligence public API adapter is unavailable");
        org.assertj.core.api.Assertions.assertThat(calls).hasValue(0);
    }
}
