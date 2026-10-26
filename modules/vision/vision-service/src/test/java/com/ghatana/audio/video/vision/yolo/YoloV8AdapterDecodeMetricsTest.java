package com.ghatana.audio.video.vision.yolo;

import com.ghatana.audiovideo.observability.MediaWorkflowMetrics;
import io.micrometer.core.instrument.Timer;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class YoloV8AdapterDecodeMetricsTest {
    private SimpleMeterRegistry registry;
    private YoloV8Adapter adapter;

    @BeforeEach
    void setUp() {
        registry = new SimpleMeterRegistry();
        adapter = new YoloV8Adapter(java.nio.file.Path.of("unused"), 0.5, 0.4, registry);
    }

    @Test
    void imageDecodeRecordsSuccessWithOnlyBoundedTags() throws Exception {
        var decoded = adapter.decodeImage(png());

        assertThat(decoded.image().getWidth()).isEqualTo(2);
        assertThat(decoded.image().getHeight()).isEqualTo(2);
        assertDecodeTimer("success");
    }

    @Test
    void rejectedImageRecordsFailureAndPreservesTheDecoderError() {
        assertThatThrownBy(() -> adapter.decodeImage(new byte[] {1, 2, 3}))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Unsupported or malformed image encoding");

        assertDecodeTimer("failure");
    }

    @Test
    void unexpectedDecoderFailureRecordsUnknown() {
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "vision");
        assertThatThrownBy(() -> YoloV8Adapter.measureDecode(metrics, () -> {
            throw new IllegalStateException("decoder implementation failed");
        })).isInstanceOf(IllegalStateException.class)
                .hasMessage("decoder implementation failed");

        assertDecodeTimer("unknown");
    }

    private void assertDecodeTimer(String outcome) {
        Timer timer = registry.get("media.modality.boundary.duration")
                .tag("modality", "vision")
                .tag("service", "vision")
                .tag("boundary", "decode")
                .tag("execution_class", "model")
                .tag("outcome", outcome)
                .tag("contract_version", "v1")
                .timer();
        assertThat(timer.count()).isEqualTo(1);
        assertThat(timer.getId().getTags()).extracting("key")
                .containsExactlyInAnyOrder("modality", "service", "boundary", "execution_class",
                        "outcome", "contract_version");
        assertThat(registry.getMeters()).allSatisfy(meter -> {
            assertThat(meter.getId().getTag("tenant")).isNull();
            assertThat(meter.getId().getTag("request_id")).isNull();
            assertThat(meter.getId().getTag("content")).isNull();
        });
    }

    private static byte[] png() throws Exception {
        BufferedImage image = new BufferedImage(2, 2, BufferedImage.TYPE_INT_RGB);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        ImageIO.write(image, "png", output);
        return output.toByteArray();
    }
}
