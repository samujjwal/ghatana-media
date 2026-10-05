/**
 * @doc.type class
 * @doc.purpose Test real-time audio streaming, buffering, and latency
 * @doc.layer products
 * @doc.pattern Test
 */
package com.ghatana.audio.streaming;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Real-Time Audio Tests
 *
 * Test real-time audio streaming, buffering, and latency.
 */
@DisplayName("Real-Time Audio Tests")
class RealTimeAudioTest {

    private final AudioStreamSession session = new AudioStreamSession();

    @Test
    @DisplayName("AV-1: should measure stable streaming throughput")
    void shouldMeasureStreamingThroughput() {
        double fps = session.framesPerSecond(120, 1_000);

        assertThat(fps).isEqualTo(120.0d);
        assertThat(fps).isGreaterThan(60.0d);
    }

    @Test
    @DisplayName("AV-2: should recover expected next sequence after network loss")
    void shouldRecoverAfterNetworkLoss() {
        int nextSequence = session.expectedNextSequenceAfterReconnect(41);

        assertThat(nextSequence).isEqualTo(42);
    }

    @Test
    @DisplayName("AV-3: should preserve wire-format contract across encode/decode")
    void shouldPreserveWireFormatContract() {
        byte[] encoded = session.encodeFrame(7, 1_700_000_000_000L, "pcm-bytes".getBytes(StandardCharsets.UTF_8));
        AudioStreamSession.DecodedFrame decoded = session.decodeFrame(encoded);

        assertThat(decoded.sequenceNumber()).isEqualTo(7);
        assertThat(decoded.timestampMillis()).isEqualTo(1_700_000_000_000L);
        assertThat(new String(decoded.payload(), StandardCharsets.UTF_8)).isEqualTo("pcm-bytes");
    }

    @Test
    @DisplayName("AV-4: should restore frame ordering across reconnect duplicates")
    void shouldRestoreFrameOrderAcrossReconnect() {
        List<Integer> reordered = session.restoreOrderedSequence(List.of(10, 12, 11, 12, 13, 10));

        assertThat(reordered).containsExactly(10, 11, 12, 13);
    }
}
