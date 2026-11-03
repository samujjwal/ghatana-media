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
        for (int size : new int[]{0, 1, VideoStreamSession.MAX_FRAME_PAYLOAD_BYTES}) {
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
                VideoStreamSession.MAX_FRAME_SEQUENCE, false, 0L, new byte[]{2}));
        assertThat(delta.keyFrame()).isFalse();
        assertThat(delta.sequenceNumber()).isEqualTo(VideoStreamSession.MAX_FRAME_SEQUENCE);
        assertThatThrownBy(() -> session.encodeFrame(Integer.MAX_VALUE, false, 1L, new byte[]{3}))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sequence");
    }

    @Test
    void decodedPayloadCannotBeMutatedThroughReturnedArray() {
        var decoded = session.decodeFrame(
                session.encodeFrame(1, true, 0L, new byte[]{4, 5, 6}));

        byte[] exposed = decoded.payload();
        exposed[0] = 99;

        assertThat(decoded.payload()).containsExactly(4, 5, 6);
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
        assertThatThrownBy(() -> session.encodeFrame(-1, false, 0L, new byte[]{1}))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sequence");
        assertThatThrownBy(() -> session.encodeFrame(Integer.MIN_VALUE, false, 0L, new byte[]{1}))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sequence");
        assertThatThrownBy(() -> session.decodeFrame(header(-1, 0, 0L, 0)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sequence");
        assertThatThrownBy(() -> session.decodeFrame(header(Integer.MIN_VALUE, 0, 0L, 0)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sequence");
        assertThatThrownBy(() -> session.decodeFrame(header(Integer.MAX_VALUE, 0, 0L, 0)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sequence");
    }

    @Test
    void encodedWireSizeCannotExceedHeaderPlusMaximumPayload() {
        byte[] oversized = new byte[
                VideoStreamSession.FRAME_HEADER_BYTES + VideoStreamSession.MAX_FRAME_PAYLOAD_BYTES + 1];
        assertThatThrownBy(() -> session.decodeFrame(oversized))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("bounded wire size");
    }

    @Test
    void seededMalformedFrameMutationsNeverEscapeBoundsOrThrowUnexpectedErrors() {
        final long seed = 0x7669_6465_6f5f_7632L;
        final int cases = 256;
        long state = seed;
        byte[] valid = session.encodeFrame(17, true, 1234L, new byte[48]);

        for (int caseNumber = 0; caseNumber < cases; caseNumber++) {
            byte[] mutated = valid.clone();
            int operations = 1 + (int) (nextRandom(state) & 7);
            state = nextRandom(state);
            for (int operation = 0; operation < operations; operation++) {
                long random = nextRandom(state);
                state = random;
                if (mutated.length == 0) {
                    mutated = new byte[]{(byte) nextRandom(state)};
                    state = nextRandom(state);
                    continue;
                }
                switch ((int) (random & 3)) {
                    case 0 -> {
                        int index = (int) Long.remainderUnsigned(nextRandom(state), mutated.length);
                        state = nextRandom(state);
                        mutated[index] ^= (byte) nextRandom(state);
                    }
                    case 1 -> {
                        int index = (int) Long.remainderUnsigned(nextRandom(state), mutated.length);
                        state = nextRandom(state);
                        mutated[index] = (byte) nextRandom(state);
                    }
                    case 2 -> mutated = Arrays.copyOf(mutated, (int) Long.remainderUnsigned(
                            nextRandom(state), mutated.length + 1L));
                    default -> {
                        if (mutated.length < 128) {
                            mutated = Arrays.copyOf(mutated, mutated.length + 1);
                            mutated[mutated.length - 1] = (byte) nextRandom(state);
                        }
                    }
                }
                state = nextRandom(state);
            }

            try {
                var decoded = session.decodeFrame(mutated);
                assertThat(decoded.sequenceNumber())
                        .as("accepted mutation %s sequence", caseNumber)
                        .isBetween(0, VideoStreamSession.MAX_FRAME_SEQUENCE);
                assertThat(decoded.payload().length)
                        .as("accepted mutation %s payload", caseNumber)
                        .isLessThanOrEqualTo(VideoStreamSession.MAX_FRAME_PAYLOAD_BYTES);
            } catch (IllegalArgumentException expected) {
                // Malformed mutations must fail through the bounded wire validation path.
            } catch (RuntimeException unexpected) {
                throw new AssertionError(
                        "mutation " + caseNumber + " escaped frame validation unexpectedly", unexpected);
            }
        }
    }

    private static long nextRandom(long value) {
        value ^= value >>> 12;
        value ^= value << 25;
        value ^= value >>> 27;
        return value * 0x2545_f491_4f6c_dd1dL;
    }

    @Test
    void reconnectFrameDoesNotWrapIntoAnAmbiguousStreamOrder() {
        assertThat(session.expectedNextFrameAfterReconnect(41)).isEqualTo(42);
        assertThat(session.expectedNextFrameAfterReconnect(-1)).isZero();
        assertThat(session.expectedNextFrameAfterReconnect(Integer.MAX_VALUE - 2))
                .isEqualTo(VideoStreamSession.MAX_FRAME_SEQUENCE);
        assertThatThrownBy(() -> session.expectedNextFrameAfterReconnect(
                VideoStreamSession.MAX_FRAME_SEQUENCE))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("new stream");
        assertThatThrownBy(() -> session.expectedNextFrameAfterReconnect(-2))
                .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> session.expectedNextFrameAfterReconnect(Integer.MAX_VALUE))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("new stream");
    }
}
