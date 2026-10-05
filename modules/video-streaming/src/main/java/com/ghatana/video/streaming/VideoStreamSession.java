package com.ghatana.video.streaming;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;

/**
 * @doc.type class
 * @doc.purpose Deterministic video streaming session helpers for throughput, reconnect recovery, wire format, and frame ordering
 * @doc.layer product
 * @doc.pattern Domain Service
 */
public final class VideoStreamSession {

    /**
     * Encodes one video frame:
     * [sequenceNumber:int][keyFrame:boolean as byte][timestampMillis:long][payloadLength:int][payload:bytes].
     */
    public byte[] encodeFrame(int sequenceNumber, boolean keyFrame, long timestampMillis, byte[] payload) {
        ByteBuffer buffer = ByteBuffer.allocate(Integer.BYTES + 1 + Long.BYTES + Integer.BYTES + payload.length);
        buffer.putInt(sequenceNumber);
        buffer.put((byte) (keyFrame ? 1 : 0));
        buffer.putLong(timestampMillis);
        buffer.putInt(payload.length);
        buffer.put(payload);
        return buffer.array();
    }

    public DecodedFrame decodeFrame(byte[] encodedFrame) {
        ByteBuffer buffer = ByteBuffer.wrap(encodedFrame);
        int sequence = buffer.getInt();
        boolean keyFrame = buffer.get() == 1;
        long timestamp = buffer.getLong();
        int length = buffer.getInt();
        byte[] payload = new byte[length];
        buffer.get(payload);
        return new DecodedFrame(sequence, keyFrame, timestamp, payload);
    }

    public double framesPerSecond(int frameCount, long elapsedMillis) {
        if (elapsedMillis <= 0) {
            throw new IllegalArgumentException("elapsedMillis must be > 0");
        }
        return frameCount / (elapsedMillis / 1000.0d);
    }

    public int expectedNextFrameAfterReconnect(int lastRenderedFrame) {
        return lastRenderedFrame + 1;
    }

    public List<Integer> restoreFrameOrder(List<Integer> receivedFrames) {
        TreeSet<Integer> ordered = new TreeSet<>(receivedFrames);
        return new ArrayList<>(ordered);
    }

    public record DecodedFrame(int sequenceNumber, boolean keyFrame, long timestampMillis, byte[] payload) {
    }
}

