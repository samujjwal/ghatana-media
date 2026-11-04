package com.ghatana.audio.streaming;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;

/**
 * @doc.type class
 * @doc.purpose Deterministic audio streaming session helpers for throughput, recovery, wire format, and ordering behavior
 * @doc.layer product
 * @doc.pattern Domain Service
 */
public final class AudioStreamSession {

    /** Fixed wire header: sequence(4) + timestampMillis(8) + payloadLength(4). */
    static final int FRAME_HEADER_BYTES = Integer.BYTES + Long.BYTES + Integer.BYTES;
    /** Maximum accepted frame payload; larger inputs are rejected before allocation. */
    static final int MAX_FRAME_PAYLOAD_BYTES = 8 * 1024 * 1024;
    /** Reserve {@link Integer#MAX_VALUE} so cursor advancement never wraps into a negative value. */
    static final int MAX_FRAME_SEQUENCE_NUMBER = Integer.MAX_VALUE - 1;

    /** Bounded decoder outcomes; values never contain input bytes or caller data. */
    public enum FrameDecodeError {
        NULL_FRAME("audio frame is required"),
        FRAME_TOO_SHORT("audio frame is shorter than its header"),
        FRAME_TOO_LARGE("audio frame exceeds the bounded wire size"),
        INVALID_SEQUENCE("audio frame sequence is outside the supported range"),
        INVALID_LENGTH("audio frame payload length is invalid"),
        SHORT_PAYLOAD("audio frame payload is truncated"),
        TRAILING_BYTES("audio frame contains trailing bytes");

        private final String description;

        FrameDecodeError(String description) {
            this.description = description;
        }

        public String description() {
            return description;
        }
    }

    /** Exactly one of frame or error is present. Error details are fixed and bounded. */
    public record FrameDecodeResult(DecodedFrame frame, FrameDecodeError error) {
        public FrameDecodeResult {
            if ((frame == null) == (error == null)) {
                throw new IllegalArgumentException("frame decode result requires exactly one outcome");
            }
        }

        public boolean decoded() {
            return frame != null;
        }
    }

    /**
     * Encodes one frame using a stable wire format:
     * [sequenceNumber:int][timestampMillis:long][payloadLength:int][payload:bytes].
     */
    public byte[] encodeFrame(int sequenceNumber, long timestampMillis, byte[] payload) {
        if (sequenceNumber < 0 || sequenceNumber > MAX_FRAME_SEQUENCE_NUMBER) {
            throw new IllegalArgumentException("audio frame sequence is outside the supported range");
        }
        if (payload == null || payload.length > MAX_FRAME_PAYLOAD_BYTES) {
            throw new IllegalArgumentException("audio frame payload is outside the bounded size");
        }
        ByteBuffer buffer = ByteBuffer.allocate(Integer.BYTES + Long.BYTES + Integer.BYTES + payload.length);
        buffer.putInt(sequenceNumber);
        buffer.putLong(timestampMillis);
        buffer.putInt(payload.length);
        buffer.put(payload);
        return buffer.array();
    }

    /**
     * Decodes one frame. The untrusted length is validated against the fixed
     * header, the declared bound and the actual remaining bytes before any
     * allocation; short, negative, oversized, truncated or trailing-garbage
     * input fails with {@link IllegalArgumentException} rather than an
     * unbounded allocation or an implicit partial accept.
     */
    public DecodedFrame decodeFrame(byte[] encodedFrame) {
        FrameDecodeResult result = decodeFrameResult(encodedFrame);
        if (result.error() != null) {
            throw new IllegalArgumentException(result.error().description());
        }
        return result.frame();
    }

    /**
     * Decodes one untrusted wire frame without allocating from its declared length.
     * All malformed outcomes are represented by a fixed enum and bounded message.
     */
    public FrameDecodeResult decodeFrameResult(byte[] encodedFrame) {
        if (encodedFrame == null) {
            return new FrameDecodeResult(null, FrameDecodeError.NULL_FRAME);
        }
        if (encodedFrame.length < FRAME_HEADER_BYTES) {
            return new FrameDecodeResult(null, FrameDecodeError.FRAME_TOO_SHORT);
        }
        if (encodedFrame.length > FRAME_HEADER_BYTES + MAX_FRAME_PAYLOAD_BYTES) {
            return new FrameDecodeResult(null, FrameDecodeError.FRAME_TOO_LARGE);
        }
        ByteBuffer buffer = ByteBuffer.wrap(encodedFrame);
        int sequence = buffer.getInt();
        if (sequence < 0 || sequence > MAX_FRAME_SEQUENCE_NUMBER) {
            return new FrameDecodeResult(null, FrameDecodeError.INVALID_SEQUENCE);
        }
        long timestamp = buffer.getLong();
        int length = buffer.getInt();
        if (length < 0 || length > MAX_FRAME_PAYLOAD_BYTES) {
            return new FrameDecodeResult(null, FrameDecodeError.INVALID_LENGTH);
        }
        if (buffer.remaining() < length) {
            return new FrameDecodeResult(null, FrameDecodeError.SHORT_PAYLOAD);
        }
        if (buffer.remaining() > length) {
            return new FrameDecodeResult(null, FrameDecodeError.TRAILING_BYTES);
        }
        byte[] payload = new byte[length];
        buffer.get(payload);
        return new FrameDecodeResult(new DecodedFrame(sequence, timestamp, payload), null);
    }

    public double framesPerSecond(int frameCount, long elapsedMillis) {
        if (elapsedMillis <= 0) {
            throw new IllegalArgumentException("elapsedMillis must be > 0");
        }
        return frameCount / (elapsedMillis / 1000.0d);
    }

    public int expectedNextSequenceAfterReconnect(int lastAckedSequence) {
        if (lastAckedSequence < -1) {
            throw new IllegalArgumentException("audio stream last ACK must be -1 or nonnegative");
        }
        if (lastAckedSequence >= MAX_FRAME_SEQUENCE_NUMBER) {
            throw new IllegalStateException("audio stream sequence exhausted; reconnect requires a new stream");
        }
        return lastAckedSequence + 1;
    }

    public List<Integer> restoreOrderedSequence(List<Integer> receivedSequences) {
        if (receivedSequences == null) {
            throw new IllegalArgumentException("audio stream sequences must be present");
        }
        for (Integer sequence : receivedSequences) {
            if (sequence == null || sequence < 0 || sequence > MAX_FRAME_SEQUENCE_NUMBER) {
                throw new IllegalArgumentException("audio stream sequence is outside the supported range");
            }
        }
        TreeSet<Integer> ordered = new TreeSet<>(receivedSequences);
        return new ArrayList<>(ordered);
    }

    public record DecodedFrame(int sequenceNumber, long timestampMillis, byte[] payload) {
        public DecodedFrame {
            payload = payload == null ? null : payload.clone();
        }

        /** Returns a copy so callers cannot mutate bytes after frame validation. */
        @Override
        public byte[] payload() {
            return payload == null ? null : payload.clone();
        }
    }
}


