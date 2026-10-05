package com.ghatana.audio.streaming;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * @doc.type class
 * @doc.purpose Performance tier for audio frame encode/decode throughput.
 * @doc.layer product
 * @doc.pattern Test
 */
@DisplayName("Audio Streaming Performance Tier")
class AudioStreamingPerformanceTierTest {

    private final AudioStreamSession session = new AudioStreamSession();

    @Test
    @DisplayName("audio frame encode/decode throughput stays within baseline")
    void shouldMeetAudioFrameThroughputBaseline() {
        int frameCount = 12_000;
        byte[] payload = "pcm-sample-frame".getBytes(StandardCharsets.UTF_8);

        Instant started = Instant.now();
        for (int i = 0; i < frameCount; i++) {
            byte[] encoded = session.encodeFrame(i, 1_700_000_000_000L + i, payload);
            AudioStreamSession.DecodedFrame decoded = session.decodeFrame(encoded);
            assertThat(decoded.sequenceNumber()).isEqualTo(i);
        }

        long elapsedMillis = Duration.between(started, Instant.now()).toMillis();
        double fps = session.framesPerSecond(frameCount, Math.max(1, elapsedMillis));

        assertThat(fps).isGreaterThan(8_000.0d);
    }
}

