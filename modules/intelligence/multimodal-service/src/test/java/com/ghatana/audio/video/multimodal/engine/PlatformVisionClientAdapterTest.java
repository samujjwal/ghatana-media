package com.ghatana.audio.video.multimodal.engine;

import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.ghatana.media.common.BoundingBox;
import com.ghatana.media.vision.api.DetectionResult;
import com.ghatana.media.vision.api.DetectedObject;
import com.ghatana.media.vision.api.VisionEngine;
import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class PlatformVisionClientAdapterTest {
    @Test
    void resultValueObjectsRejectMalformedNumericValues() {
        for (double confidence : new double[] {Double.NaN, Double.POSITIVE_INFINITY, -0.01, 1.01}) {
            assertThatThrownBy(() -> VisualResult.builder().confidence(confidence).build())
                    .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("confidence");
            assertThatThrownBy(() -> new com.ghatana.audio.video.multimodal.engine.DetectionResult(
                    "person", confidence, 0, 0, 1, 1))
                    .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("confidence");
        }
        for (double coordinate : new double[] {Double.NaN, Double.NEGATIVE_INFINITY}) {
            assertThatThrownBy(() -> new com.ghatana.audio.video.multimodal.engine.DetectionResult(
                    "person", 0.5, coordinate, 0, 1, 1))
                    .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("box");
        }
        for (double extent : new double[] {Double.NaN, Double.POSITIVE_INFINITY, -1.0}) {
            assertThatThrownBy(() -> new com.ghatana.audio.video.multimodal.engine.DetectionResult(
                    "person", 0.5, 0, 0, extent, 1))
                    .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("box");
        }
    }

    @Test
    void detectionResultAllowsFiniteNegativePixelOrigins() {
        var detection = new com.ghatana.audio.video.multimodal.engine.DetectionResult(
                "person", 0.5, -2.0, -3.0, 4.0, 5.0);
        assertThat(detection.getX()).isEqualTo(-2.0);
        assertThat(detection.getY()).isEqualTo(-3.0);
        assertThat(detection.getWidth()).isEqualTo(4.0);
        assertThat(detection.getHeight()).isEqualTo(5.0);
    }

    @Test
    void detectionResultRejectsOverflowingDerivedBoundsAndArea() {
        assertThatThrownBy(() -> new com.ghatana.audio.video.multimodal.engine.DetectionResult(
                "person", 0.5, Double.MAX_VALUE, 0, Double.MAX_VALUE, 1))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("bounds");
        assertThatThrownBy(() -> new com.ghatana.audio.video.multimodal.engine.DetectionResult(
                "person", 0.5, 0, Double.MAX_VALUE, 1, Double.MAX_VALUE))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("bounds");
        assertThatThrownBy(() -> new com.ghatana.audio.video.multimodal.engine.DetectionResult(
                "person", 0.5, 0, 0, 1.0e200, 1.0e200))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("area");
    }

    @Test
    void rejectsMalformedProviderDetectionBeforeReturningVisualResult() throws Exception {
        VisionEngine engine = mock(VisionEngine.class);
        when(engine.detect(any(), any())).thenReturn(new DetectionResult(
                java.util.List.of(new DetectedObject("person", Double.NaN,
                        new BoundingBox(0, 0, 1, 1, 0.5))), 8, 8, 1, "test"));
        assertThatThrownBy(() -> adapter(engine).detectObjects(png()))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("confidence");
    }

    @Test
    void routesImageThroughPublishedVisionSpi() throws Exception {
        VisionEngine engine = mock(VisionEngine.class);
        when(engine.detect(any(), any())).thenReturn(new DetectionResult(
                java.util.List.of(new DetectedObject("cat", .9, new BoundingBox(1, 2, 3, 4, .9))), 8, 8, 1, "test"));
        when(engine.caption(any())).thenReturn("cat");
        var result = adapter(engine).detectObjects(png());
        assertThat(result.getSceneDescription()).isEqualTo("cat");
        assertThat(result.getDetections()).hasSize(1);
        assertThat(result.getConfidence()).isNull();
    }

    @Test
    void malformedImageFailsBeforeProviderCall() {
        VisionEngine engine = mock(VisionEngine.class);
        assertThatThrownBy(() -> adapter(engine).detectObjects(new byte[] {1, 2, 3}))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("malformed");
    }

    @Test
    void providerExceptionIsNotConvertedToSuccessfulResult() throws Exception {
        VisionEngine engine = mock(VisionEngine.class);
        when(engine.detect(any(), any())).thenThrow(new IllegalStateException("provider unavailable"));
        assertThatThrownBy(() -> adapter(engine).detectObjects(png()))
                .isInstanceOf(IllegalStateException.class).hasMessage("provider unavailable");
    }

    @Test
    void missingPublicEngineAndOversizedVideoFailClosed() {
        assertThatThrownBy(() -> new PlatformVisionClientAdapter(null, new VideoFrameExtractor(),
                AudioVideoRuntimeSettings.defaults())).isInstanceOf(NullPointerException.class)
                .hasMessage("public VisionEngine SPI unavailable");
        assertThatThrownBy(() -> adapter(mock(VisionEngine.class)).analyseVideo(new byte[32 * 1024 * 1024 + 1], 1, 1))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("32 MiB");
    }

    private static PlatformVisionClientAdapter adapter(VisionEngine engine) {
        return new PlatformVisionClientAdapter(engine, new VideoFrameExtractor(), AudioVideoRuntimeSettings.defaults());
    }

    private static byte[] png() throws Exception {
        BufferedImage image = new BufferedImage(8, 8, BufferedImage.TYPE_INT_RGB);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        ImageIO.write(image, "png", output);
        return output.toByteArray();
    }
}
