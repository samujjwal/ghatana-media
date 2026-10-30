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

    /** Fixed wire header: sequence(4) + keyFrame(1) + timestampMillis(8) + payloadLength(4). */
    static final int FRAME_HEADER_BYTES = Integer.BYTES + 1 + Long.BYTES + Integer.BYTES;
    /** Maximum accepted frame payload; larger inputs are rejected before allocation. */
    static final int MAX_FRAME_PAYLOAD_BYTES = 16 * 1024 * 1024;

    /**
     * Encodes one video frame:
     * [sequenceNumber:int][keyFrame:boolean as byte][timestampMillis:long][payloadLength:int][payload:bytes].
     */
    public byte[] encodeFrame(int sequenceNumber, boolean keyFrame, long timestampMillis, byte[] payload) {
        if (payload == null || payload.length > MAX_FRAME_PAYLOAD_BYTES) {
            throw new IllegalArgumentException("video frame payload is outside the bounded size");
        }
        ByteBuffer buffer = ByteBuffer.allocate(Integer.BYTES + 1 + Long.BYTES + Integer.BYTES + payload.length);
        buffer.putInt(sequenceNumber);
        buffer.put((byte) (keyFrame ? 1 : 0));
        buffer.putLong(timestampMillis);
        buffer.putInt(payload.length);
        buffer.put(payload);
        return buffer.array();
    }

    /**
     * Decodes one frame. The untrusted length, keyframe flag and trailing bytes
     * are validated against the fixed header, the declared bound and the actual
     * remaining bytes before any allocation; short, negative, oversized,
     * truncated, unknown-flag or trailing-garbage input fails with
     * {@link IllegalArgumentException} rather than an unbounded allocation or
     * an implicit partial accept.
     */
    public DecodedFrame decodeFrame(byte[] encodedFrame) {
        if (encodedFrame == null || encodedFrame.length < FRAME_HEADER_BYTES
                || encodedFrame.length > FRAME_HEADER_BYTES + MAX_FRAME_PAYLOAD_BYTES) {
            throw new IllegalArgumentException("video frame is outside the bounded wire size");
        }
        ByteBuffer buffer = ByteBuffer.wrap(encodedFrame);
        int sequence = buffer.getInt();
        byte keyFlag = buffer.get();
        if (keyFlag != 0 && keyFlag != 1) {
            throw new IllegalArgumentException("video frame keyframe flag is invalid");
        }
        boolean keyFrame = keyFlag == 1;
        long timestamp = buffer.getLong();
        int length = buffer.getInt();
        if (length < 0 || length > MAX_FRAME_PAYLOAD_BYTES || buffer.remaining() != length) {
            throw new IllegalArgumentException("video frame payload length is invalid");
        }
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

