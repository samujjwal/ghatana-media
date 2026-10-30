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

    /**
     * Encodes one frame using a stable wire format:
     * [sequenceNumber:int][timestampMillis:long][payloadLength:int][payload:bytes].
     */
    public byte[] encodeFrame(int sequenceNumber, long timestampMillis, byte[] payload) {
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
        if (encodedFrame == null || encodedFrame.length < FRAME_HEADER_BYTES
                || encodedFrame.length > FRAME_HEADER_BYTES + MAX_FRAME_PAYLOAD_BYTES) {
            throw new IllegalArgumentException("audio frame is outside the bounded wire size");
        }
        ByteBuffer buffer = ByteBuffer.wrap(encodedFrame);
        int sequence = buffer.getInt();
        long timestamp = buffer.getLong();
        int length = buffer.getInt();
        if (length < 0 || length > MAX_FRAME_PAYLOAD_BYTES || buffer.remaining() != length) {
            throw new IllegalArgumentException("audio frame payload length is invalid");
        }
        byte[] payload = new byte[length];
        buffer.get(payload);
        return new DecodedFrame(sequence, timestamp, payload);
    }

    public double framesPerSecond(int frameCount, long elapsedMillis) {
        if (elapsedMillis <= 0) {
            throw new IllegalArgumentException("elapsedMillis must be > 0");
        }
        return frameCount / (elapsedMillis / 1000.0d);
    }

    public int expectedNextSequenceAfterReconnect(int lastAckedSequence) {
        return lastAckedSequence + 1;
    }

    public List<Integer> restoreOrderedSequence(List<Integer> receivedSequences) {
        TreeSet<Integer> ordered = new TreeSet<>(receivedSequences);
        return new ArrayList<>(ordered);
    }

    public record DecodedFrame(int sequenceNumber, long timestampMillis, byte[] payload) {
    }
}


