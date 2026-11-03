package com.ghatana.audio.streaming;

import org.junit.jupiter.api.Test;

import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.Random;

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
        // The final deliverable sequence is valid; Integer.MAX_VALUE is reserved
        // to prevent a next-expected cursor from wrapping on reconnect.
        var lastSequence = session.decodeFrame(session.encodeFrame(
                AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER, 0L, new byte[]{1}));
        assertThat(lastSequence.sequenceNumber()).isEqualTo(AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER);
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
        assertThatThrownBy(() -> session.decodeFrame(header(Integer.MIN_VALUE, 0L, 0)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sequence");
        assertThatThrownBy(() -> session.decodeFrame(header(Integer.MAX_VALUE, 0L, 0)))
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
        assertThatThrownBy(() -> session.encodeFrame(Integer.MAX_VALUE, 0L, new byte[0]))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sequence");
        assertThatThrownBy(() -> session.encodeFrame(1, 0L, null))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void deterministicFrameCorpusClassifiesValidAndMalformedBoundaries() {
        Random random = new Random(0x41532d3032L);
        byte[] payload = new byte[]{1, 2, 3, 4};
        byte[] valid = session.encodeFrame(17, 1234L, payload);
        assertValidFrame(valid, 17, 1234L, payload);

        // Exercise every bit of a negative length field. With four payload
        // bytes available, each mutation remains either negative or above the
        // available payload size and is therefore guaranteed malformed.
        byte[] invalidLengthFrame = header(17, 1234L, -1);
        invalidLengthFrame = Arrays.copyOf(invalidLengthFrame,
                AudioStreamSession.FRAME_HEADER_BYTES + payload.length);
        for (int offset = Integer.BYTES + Long.BYTES;
                offset < AudioStreamSession.FRAME_HEADER_BYTES; offset++) {
            for (int bit = 0; bit < Byte.SIZE; bit++) {
                byte[] mutated = invalidLengthFrame.clone();
                mutated[offset] ^= (byte) (1 << bit);
                assertInvalidFrame(mutated);
            }
        }

        assertInvalidFrame(header(-1, 1234L, 0));
        assertInvalidFrame(header(Integer.MAX_VALUE, 1234L, 0));
        assertInvalidFrame(header(17, 1234L, Integer.MIN_VALUE));
        assertInvalidFrame(header(17, 1234L, -1));
        assertInvalidFrame(header(17, 1234L,
                AudioStreamSession.MAX_FRAME_PAYLOAD_BYTES + 1));
        assertInvalidFrame(header(17, 1234L, Integer.MAX_VALUE));

        // The two exact-size forms are valid; adjacent declared lengths are
        // guaranteed invalid because the actual payload byte count differs.
        assertValidFrame(header(17, 1234L, 0), 17, 1234L, new byte[0]);
        assertInvalidFrame(header(17, 1234L, 1));
        assertInvalidFrame(header(17, 1234L, 4));
        assertInvalidFrame(Arrays.copyOf(header(17, 1234L, 3),
                AudioStreamSession.FRAME_HEADER_BYTES + 4));
        byte[] exactFour = header(17, 1234L, 4);
        byte[] withFourPayload = Arrays.copyOf(exactFour,
                AudioStreamSession.FRAME_HEADER_BYTES + 4);
        System.arraycopy(payload, 0, withFourPayload,
                AudioStreamSession.FRAME_HEADER_BYTES, payload.length);
        assertValidFrame(withFourPayload, 17, 1234L, payload);
        assertInvalidFrame(Arrays.copyOf(withFourPayload, withFourPayload.length + 1));

        // Random inputs stay strictly shorter than the fixed 16-byte header,
        // so every case has an unambiguous invalid outcome.
        for (int i = 0; i < 256; i++) {
            byte[] candidate = new byte[random.nextInt(AudioStreamSession.FRAME_HEADER_BYTES)];
            random.nextBytes(candidate);
            assertInvalidFrame(candidate);
        }
    }

    private void assertValidFrame(byte[] candidate, int sequence, long timestamp, byte[] payload) {
        var decoded = session.decodeFrame(candidate);
        assertThat(decoded.sequenceNumber()).isEqualTo(sequence);
        assertThat(decoded.timestampMillis()).isEqualTo(timestamp);
        assertThat(decoded.payload()).containsExactly(payload);
    }

    private void assertInvalidFrame(byte[] candidate) {
        assertThatThrownBy(() -> session.decodeFrame(candidate))
                .isExactlyInstanceOf(IllegalArgumentException.class)
                .hasMessageNotContaining("\n");
    }

    @Test
    void reconnectSequenceDoesNotWrapIntoAnAmbiguousStreamOrder() {
        assertThat(session.expectedNextSequenceAfterReconnect(-1)).isZero();
        assertThat(session.expectedNextSequenceAfterReconnect(41)).isEqualTo(42);
        assertThat(session.expectedNextSequenceAfterReconnect(
                        AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER - 1))
                .isEqualTo(AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER);
        assertThatThrownBy(() -> session.expectedNextSequenceAfterReconnect(-2))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> session.expectedNextSequenceAfterReconnect(Integer.MIN_VALUE))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> session.expectedNextSequenceAfterReconnect(Integer.MAX_VALUE))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("new stream");
        assertThatThrownBy(() -> session.expectedNextSequenceAfterReconnect(
                        AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("new stream");
        assertThatThrownBy(() -> session.restoreOrderedSequence(
                        Arrays.asList(1, null, 2)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("supported range");
        assertThatThrownBy(() -> session.restoreOrderedSequence(
                        Arrays.asList(1, Integer.MAX_VALUE)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("supported range");
    }
}
