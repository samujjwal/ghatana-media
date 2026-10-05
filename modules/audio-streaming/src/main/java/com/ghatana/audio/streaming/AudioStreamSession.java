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

    /**
     * Encodes one frame using a stable wire format:
     * [sequenceNumber:int][timestampMillis:long][payloadLength:int][payload:bytes].
     */
    public byte[] encodeFrame(int sequenceNumber, long timestampMillis, byte[] payload) {
        ByteBuffer buffer = ByteBuffer.allocate(Integer.BYTES + Long.BYTES + Integer.BYTES + payload.length);
        buffer.putInt(sequenceNumber);
        buffer.putLong(timestampMillis);
        buffer.putInt(payload.length);
        buffer.put(payload);
        return buffer.array();
    }

    public DecodedFrame decodeFrame(byte[] encodedFrame) {
        ByteBuffer buffer = ByteBuffer.wrap(encodedFrame);
        int sequence = buffer.getInt();
        long timestamp = buffer.getLong();
        int length = buffer.getInt();
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


