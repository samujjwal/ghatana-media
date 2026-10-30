package com.ghatana.video.streaming;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.Objects;

/**
 * The module's one qualified transport: a real in-process wire transport.
 *
 * <p>VS-05: frames cross an actual encode → bounded transfer → decode
 * roundtrip, so a captured readback reflects real wire behavior — sequence
 * numbers, keyframe flags, PTS and payload bytes are preserved or the frame
 * fails. The transfer queue is bounded; overflow applies backpressure by
 * rejecting the send rather than growing unboundedly.
 *
 * <p>This is not a stand-in for WebRTC/HLS/DASH — those transports remain
 * unqualified in {@link VideoCaptureProfile}. This transport exists so that
 * capture/readback behavior is real and testable without a network relay.
 *
 * @doc.type class
 * @doc.purpose Qualified bounded in-process video wire transport
 * @doc.layer product
 * @doc.pattern Transport
 */
public final class InProcessVideoTransport {

    /** Maximum encoded frames held in flight before backpressure rejects. */
    public static final int MAX_IN_FLIGHT = 512;

    private final VideoStreamSession wire = new VideoStreamSession();
    private final Deque<byte[]> inFlight = new ArrayDeque<>();

    /**
     * Encodes and queues one frame for transfer. Returns false under
     * backpressure — the frame is not accepted, never silently dropped.
     */
    public boolean send(VideoStreamSession.DecodedFrame frame) {
        Objects.requireNonNull(frame, "frame");
        if (inFlight.size() >= MAX_IN_FLIGHT) {
            return false;
        }
        inFlight.addLast(wire.encodeFrame(
                frame.sequenceNumber(), frame.keyFrame(),
                frame.timestampMillis(), frame.payload()));
        return true;
    }

    /**
     * Receives and decodes the next transferred frame, or null when the
     * transfer queue is empty. Malformed wire bytes fail the decode — a
     * corrupted frame is never read back as valid.
     */
    public VideoStreamSession.DecodedFrame receive() {
        byte[] encoded = inFlight.pollFirst();
        if (encoded == null) {
            return null;
        }
        return wire.decodeFrame(encoded);
    }

    /** Drains all in-flight frames in order for capture sealing. */
    public void drainInto(List<VideoStreamSession.DecodedFrame> sink) {
        VideoStreamSession.DecodedFrame frame;
        while ((frame = receive()) != null) {
            sink.add(frame);
        }
    }

    public int inFlightCount() {
        return inFlight.size();
    }
}
