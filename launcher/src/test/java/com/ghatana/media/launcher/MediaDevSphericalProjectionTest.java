package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaDevSphericalProjectionTest {
    @Test
    void theCentreTheSeamAndThePolesLandOnTheDocumentedPixels() {
        var centre = MediaDevSphericalProjection.toPixel(0, 0, 1024, 512);
        assertThat(centre.xExact()).isEqualTo(512.0);
        assertThat(centre.yExact()).isEqualTo(256.0);
        assertThat(MediaDevSphericalProjection.toPixel(-180, 0, 1024, 512).x()).isEqualTo(0);
        assertThat(MediaDevSphericalProjection.toPixel(180, 0, 1024, 512).x()).isEqualTo(1023);
        assertThat(MediaDevSphericalProjection.toPixel(0, 90, 1024, 512).y()).isEqualTo(0);
        assertThat(MediaDevSphericalProjection.toPixel(0, -90, 1024, 512).y()).isEqualTo(511);
        var marker = MediaDevSphericalProjection.toPixel(60, 20, 1024, 512);
        assertThat(marker.x()).isEqualTo(682);
        assertThat(marker.y()).isEqualTo(199);
    }

    @Test
    void theInverseReturnsThePixelCentreDirection() {
        double[] direction = MediaDevSphericalProjection.toDirection(682, 199, 1024, 512);
        var back = MediaDevSphericalProjection.toPixel(direction[0], direction[1], 1024, 512);
        assertThat(back.x()).isEqualTo(682);
        assertThat(back.y()).isEqualTo(199);
    }

    @Test
    void outOfRangeDirectionsAreRefused() {
        assertThatThrownBy(() -> MediaDevSphericalProjection.toPixel(181, 0, 100, 50)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MediaDevSphericalProjection.toPixel(0, 91, 100, 50)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MediaDevSphericalProjection.toPixel(Double.NaN, 0, 100, 50)).isInstanceOf(IllegalArgumentException.class);
    }
}
