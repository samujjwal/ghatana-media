package com.ghatana.media.vision.api;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class VisionDetectorBoundingBoxTest {

    @Test
    void rejectsNonFiniteCoordinatesAndDimensions() {
        assertThatThrownBy(() -> new VisionDetector.BoundingBox(Double.NaN, 0, 1, 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new VisionDetector.BoundingBox(0, Double.POSITIVE_INFINITY, 1, 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new VisionDetector.BoundingBox(0, 0, Double.NaN, 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new VisionDetector.BoundingBox(0, 0, 1, Double.NEGATIVE_INFINITY))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void rejectsNegativeDimensionsButAllowsZeroAreaGeometry() {
        assertThatThrownBy(() -> new VisionDetector.BoundingBox(0, 0, -1, 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new VisionDetector.BoundingBox(0, 0, 1, -1))
                .isInstanceOf(IllegalArgumentException.class);

        VisionDetector.BoundingBox zeroArea = new VisionDetector.BoundingBox(0, 0, 0, 1);
        assertThat(zeroArea.getArea()).isZero();
        assertThat(zeroArea.iou(new VisionDetector.BoundingBox(0, 0, 1, 1))).isZero();
    }

    @Test
    void rejectsFiniteInputsWhoseDerivedGeometryOverflows() {
        assertThatThrownBy(() -> new VisionDetector.BoundingBox(Double.MAX_VALUE, 0, Double.MAX_VALUE, 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new VisionDetector.BoundingBox(0, Double.MAX_VALUE, 1, Double.MAX_VALUE))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new VisionDetector.BoundingBox(0, 0, 1e200, 1e200))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void computesIouWhenFiniteAreasWouldOverflowNaiveUnionAddition() {
        VisionDetector.BoundingBox first = new VisionDetector.BoundingBox(0, 0, 1e154, 1e154);
        VisionDetector.BoundingBox identical = new VisionDetector.BoundingBox(0, 0, 1e154, 1e154);

        assertThat(first.getArea()).isFinite();
        assertThat(first.iou(identical)).isEqualTo(1.0);
    }

    @Test
    void computesIouWhenRepresentableDimensionsHaveUnderflowingAreas() {
        VisionDetector.BoundingBox first = new VisionDetector.BoundingBox(0, 0, 1e-200, 1e-200);
        VisionDetector.BoundingBox identical = new VisionDetector.BoundingBox(0, 0, 1e-200, 1e-200);
        VisionDetector.BoundingBox halfOverlap = new VisionDetector.BoundingBox(5e-201, 0, 1e-200, 1e-200);

        assertThat(first.getArea()).isZero();
        assertThat(first.iou(identical)).isEqualTo(1.0);
        assertThat(first.iou(halfOverlap)).isEqualTo(1.0 / 3.0);
    }
}
