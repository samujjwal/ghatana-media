/**
 * @doc.type class
 * @doc.purpose Test video streaming, adaptive bitrate, and quality of service
 * @doc.layer products
 * @doc.pattern Test
 */
package com.ghatana.video.streaming;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Video Streaming Tests
 *
 * Test video streaming, adaptive bitrate, and quality of service.
 */
@DisplayName("Video Streaming Tests")
class VideoStreamingTest {

    private final VideoStreamSession session = new VideoStreamSession();

    @Test
    @DisplayName("AV-1: should measure stable video throughput")
    void shouldMeasureVideoThroughput() {
        double fps = session.framesPerSecond(300, 2_000);

        assertThat(fps).isEqualTo(150.0d);
        assertThat(fps).isGreaterThan(60.0d);
    }

    @Test
    @DisplayName("AV-2: should recover expected next frame after reconnect")
    void shouldRecoverAfterReconnect() {
        int next = session.expectedNextFrameAfterReconnect(88);

        assertThat(next).isEqualTo(89);
    }

    @Test
    @DisplayName("AV-3: should preserve video wire-format contract")
    void shouldPreserveVideoWireFormatContract() {
        byte[] encoded = session.encodeFrame(3, true, 1_700_000_100_000L, "h264-frame".getBytes(StandardCharsets.UTF_8));
        VideoStreamSession.DecodedFrame decoded = session.decodeFrame(encoded);

        assertThat(decoded.sequenceNumber()).isEqualTo(3);
        assertThat(decoded.keyFrame()).isTrue();
        assertThat(decoded.timestampMillis()).isEqualTo(1_700_000_100_000L);
        assertThat(new String(decoded.payload(), StandardCharsets.UTF_8)).isEqualTo("h264-frame");
    }

    @Test
    @DisplayName("AV-4: should restore frame ordering across reconnect duplicates")
    void shouldRestoreOrderingAcrossReconnect() {
        List<Integer> restored = session.restoreFrameOrder(List.of(100, 98, 99, 100, 101, 99));

        assertThat(restored).containsExactly(98, 99, 100, 101);
    }
}
