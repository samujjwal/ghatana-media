package com.ghatana.video.streaming;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * @doc.type class
 * @doc.purpose Performance tier for video frame encode/decode throughput.
 * @doc.layer product
 * @doc.pattern Test
 */
@DisplayName("Video Streaming Performance Tier")
class VideoStreamingPerformanceTierTest {

    private final VideoStreamSession session = new VideoStreamSession();

    @Test
    @DisplayName("video frame encode/decode throughput stays within baseline")
    void shouldMeetVideoFrameThroughputBaseline() {
        int frameCount = 10_000;
        byte[] payload = "h264-key-frame".getBytes(StandardCharsets.UTF_8);

        Instant started = Instant.now();
        for (int i = 0; i < frameCount; i++) {
            byte[] encoded = session.encodeFrame(i, i % 60 == 0, 1_700_000_000_000L + i, payload);
            VideoStreamSession.DecodedFrame decoded = session.decodeFrame(encoded);
            assertThat(decoded.sequenceNumber()).isEqualTo(i);
        }

        long elapsedMillis = Duration.between(started, Instant.now()).toMillis();
        double fps = session.framesPerSecond(frameCount, Math.max(1, elapsedMillis));

        assertThat(fps).isGreaterThan(6_000.0d);
    }
}

