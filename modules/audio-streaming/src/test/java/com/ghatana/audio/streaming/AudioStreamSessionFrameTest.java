package com.ghatana.audio.streaming;

import org.junit.jupiter.api.Test;

import java.nio.ByteBuffer;
import java.util.Arrays;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Untrusted wire-frame boundary coverage: the decoder must reject short,
 * negative, oversized, truncated and trailing-garbage input before any
 * allocation while legitimate frames keep round-tripping.
 */
class AudioStreamSessionFrameTest {

    private final AudioStreamSession session = new AudioStreamSession();

    private static byte[] header(int sequence, long timestamp, int declaredLength) {
        ByteBuffer buffer = ByteBuffer.allocate(AudioStreamSession.FRAME_HEADER_BYTES);
        buffer.putInt(sequence);
        buffer.putLong(timestamp);
        buffer.putInt(declaredLength);
        return buffer.array();
    }

    @Test
    void legitimateFramesRoundTripAtBoundaries() {
        for (int size : new int[]{
                0,
                1,
                AudioStreamSession.MAX_FRAME_PAYLOAD_BYTES - 1,
                AudioStreamSession.MAX_FRAME_PAYLOAD_BYTES
        }) {
            byte[] payload = new byte[size];
            Arrays.fill(payload, (byte) 0x5a);
            var decoded = session.decodeFrame(
                    session.encodeFrame(7, 1_700_000_000_000L, payload));
            assertThat(decoded.sequenceNumber()).isEqualTo(7);
            assertThat(decoded.timestampMillis()).isEqualTo(1_700_000_000_000L);
            assertThat(decoded.payload()).isEqualTo(payload);
        }
        // The largest nonnegative sequence is valid on the legacy wire format.
        var lastSequence = session.decodeFrame(session.encodeFrame(
                Integer.MAX_VALUE, 0L, new byte[]{1}));
        assertThat(lastSequence.sequenceNumber()).isEqualTo(Integer.MAX_VALUE);
    }

    @Test
    void decodedPayloadCannotBeMutatedThroughReturnedArray() {
        var decoded = session.decodeFrame(session.encodeFrame(1, 0L, new byte[]{1, 2, 3}));

        byte[] exposed = decoded.payload();
        exposed[0] = 99;

        assertThat(decoded.payload()).containsExactly(1, 2, 3);
    }

    @Test
    void malformedFramesFailBeforeAnyPayloadAllocation() {
        byte[] payload = new byte[]{1, 2, 3, 4};
        byte[] valid = session.encodeFrame(3, 42L, payload);

        assertThatThrownBy(() -> session.decodeFrame(null))
                .isInstanceOf(IllegalArgumentException.class);
        for (int size : new int[]{0, 8, AudioStreamSession.FRAME_HEADER_BYTES - 1}) {
            byte[] shortFrame = Arrays.copyOf(valid, size);
            assertThatThrownBy(() -> session.decodeFrame(shortFrame))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        // Negative and oversized declared lengths never reach allocation.
        assertThatThrownBy(() -> session.decodeFrame(header(1, 0L, -1)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> session.decodeFrame(header(1, 0L, Integer.MIN_VALUE)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> session.decodeFrame(
                        header(1, 0L, AudioStreamSession.MAX_FRAME_PAYLOAD_BYTES + 1)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> session.decodeFrame(header(1, 0L, Integer.MAX_VALUE)))
                .isInstanceOf(IllegalArgumentException.class);
        // The wire-size guard also rejects an oversized buffer even when its
        // header advertises an otherwise valid empty payload.
        byte[] oversizedWireFrame = Arrays.copyOf(
                header(1, 0L, 0), AudioStreamSession.FRAME_HEADER_BYTES
                        + AudioStreamSession.MAX_FRAME_PAYLOAD_BYTES + 1);
        assertThatThrownBy(() -> session.decodeFrame(oversizedWireFrame))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> session.decodeFrame(header(-1, 0L, 0)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sequence");
        // Declared length larger than the bytes actually present.
        assertThatThrownBy(() -> session.decodeFrame(header(1, 0L, 4)))
                .isInstanceOf(IllegalArgumentException.class);
        // A partial payload cannot be accepted even when the total wire size is bounded.
        assertThatThrownBy(() -> session.decodeFrame(Arrays.copyOf(valid, valid.length - 1)))
                .isInstanceOf(IllegalArgumentException.class);
        // Trailing garbage after a complete payload is rejected.
        byte[] trailing = Arrays.copyOf(valid, valid.length + 1);
        trailing[trailing.length - 1] = 0x7f;
        assertThatThrownBy(() -> session.decodeFrame(trailing))
                .isInstanceOf(IllegalArgumentException.class);
        // Encoding itself refuses an unbounded payload.
        assertThatThrownBy(() -> session.encodeFrame(
                        1, 0L, new byte[AudioStreamSession.MAX_FRAME_PAYLOAD_BYTES + 1]))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> session.encodeFrame(-1, 0L, new byte[0]))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sequence");
        assertThatThrownBy(() -> session.encodeFrame(1, 0L, null))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void reconnectSequenceDoesNotWrapIntoAnAmbiguousStreamOrder() {
        assertThat(session.expectedNextSequenceAfterReconnect(41)).isEqualTo(42);
        assertThatThrownBy(() -> session.expectedNextSequenceAfterReconnect(Integer.MAX_VALUE))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("new stream");
    }
}
