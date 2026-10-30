package com.ghatana.video.streaming;

import org.junit.jupiter.api.Test;

import java.nio.ByteBuffer;
import java.util.Arrays;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Untrusted wire-frame boundary coverage: the decoder must reject short,
 * negative, oversized, truncated, unknown-keyframe-flag and trailing-garbage
 * input before any allocation while legitimate frames keep round-tripping.
 */
class VideoStreamSessionFrameTest {

    private final VideoStreamSession session = new VideoStreamSession();

    private static byte[] header(int sequence, int keyFlag, long timestamp, int declaredLength) {
        ByteBuffer buffer = ByteBuffer.allocate(VideoStreamSession.FRAME_HEADER_BYTES);
        buffer.putInt(sequence);
        buffer.put((byte) keyFlag);
        buffer.putLong(timestamp);
        buffer.putInt(declaredLength);
        return buffer.array();
    }

    @Test
    void legitimateFramesRoundTripAtBoundaries() {
        for (int size : new int[]{0, 1, VideoStreamSession.MAX_FRAME_PAYLOAD_BYTES - 1}) {
            byte[] payload = new byte[size];
            Arrays.fill(payload, (byte) 0x3c);
            var decoded = session.decodeFrame(
                    session.encodeFrame(9, true, 1_700_000_000_000L, payload));
            assertThat(decoded.sequenceNumber()).isEqualTo(9);
            assertThat(decoded.keyFrame()).isTrue();
            assertThat(decoded.timestampMillis()).isEqualTo(1_700_000_000_000L);
            assertThat(decoded.payload()).isEqualTo(payload);
        }
        var delta = session.decodeFrame(session.encodeFrame(
                Integer.MIN_VALUE, false, 0L, new byte[]{2}));
        assertThat(delta.keyFrame()).isFalse();
        assertThat(delta.sequenceNumber()).isEqualTo(Integer.MIN_VALUE);
    }

    @Test
    void malformedFramesFailBeforeAnyPayloadAllocation() {
        byte[] payload = new byte[]{5, 6, 7};
        byte[] valid = session.encodeFrame(2, false, 11L, payload);

        assertThatThrownBy(() -> session.decodeFrame(null))
                .isInstanceOf(IllegalArgumentException.class);
        for (int size : new int[]{0, 9, VideoStreamSession.FRAME_HEADER_BYTES - 1}) {
            byte[] shortFrame = Arrays.copyOf(valid, size);
            assertThatThrownBy(() -> session.decodeFrame(shortFrame))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        // Unknown keyframe flag values are rejected.
        assertThatThrownBy(() -> session.decodeFrame(header(1, 2, 0L, 0)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> session.decodeFrame(header(1, 0x7f, 0L, 0)))
                .isInstanceOf(IllegalArgumentException.class);
        // Negative and oversized declared lengths never reach allocation.
        assertThatThrownBy(() -> session.decodeFrame(header(1, 0, 0L, -4)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> session.decodeFrame(header(1, 1, 0L, Integer.MIN_VALUE)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> session.decodeFrame(
                        header(1, 0, 0L, VideoStreamSession.MAX_FRAME_PAYLOAD_BYTES + 1)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> session.decodeFrame(header(1, 1, 0L, Integer.MAX_VALUE)))
                .isInstanceOf(IllegalArgumentException.class);
        // Declared length larger than the bytes actually present.
        assertThatThrownBy(() -> session.decodeFrame(header(1, 0, 0L, 3)))
                .isInstanceOf(IllegalArgumentException.class);
        // Trailing garbage after a complete payload is rejected.
        byte[] trailing = Arrays.copyOf(valid, valid.length + 1);
        trailing[trailing.length - 1] = 0x01;
        assertThatThrownBy(() -> session.decodeFrame(trailing))
                .isInstanceOf(IllegalArgumentException.class);
        // Encoding itself refuses an unbounded payload.
        assertThatThrownBy(() -> session.encodeFrame(
                        1, true, 0L, new byte[VideoStreamSession.MAX_FRAME_PAYLOAD_BYTES + 1]))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> session.encodeFrame(1, false, 0L, null))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
