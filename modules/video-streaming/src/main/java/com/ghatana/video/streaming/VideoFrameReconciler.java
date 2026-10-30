package com.ghatana.video.streaming;

import java.util.Objects;
import java.util.TreeMap;

/**
 * Ordered video-frame reconciliation preserving source presentation
 * timestamps, keyframe dependencies and discontinuity markers.
 *
 * <p>VS-03: the wire timestamp is the source presentation time — it is
 * preserved verbatim and never substituted by wall-clock time. A
 * non-keyframe frame depends on the most recent keyframe in its GOP, so
 * losing a keyframe means dependent frames can be held but not rendered
 * until the next keyframe arrives. Backwards or non-monotonic
 * timestamps mark a discontinuity (VFR, scene cut or timestamp jump) as
 * uncertainty — never an error, never smoothed over.
 *
 * <p>Pending out-of-order frames are bounded by {@link #MAX_PENDING}.
 *
 * @doc.type class
 * @doc.purpose Keyframe/PTS-aware ordered video frame reconciliation
 * @doc.layer product
 * @doc.pattern Reconciler
 */
public final class VideoFrameReconciler {

    private static final int MAX_PENDING = 256;
    private static final long MAX_FORWARD_PTS_JUMP_MS = 30_000L;

    /** What the reconciler decided about one offered frame. */
    public enum Disposition {
        /** Next expected sequence — delivered; decodable if a keyframe anchors the GOP. */
        DELIVERED,
        /** Held for a missing earlier sequence — not yet deliverable. */
        HELD,
        /** A duplicate of an already-acked or held frame. */
        DUPLICATE,
        /** Held set is full — the frame cannot be accommodated within bounds. */
        OVERFLOW
    }

    /** Delivery view of one frame — whether it is renderable now and any uncertainty. */
    public record Delivery(
            VideoStreamSession.DecodedFrame frame,
            /** true when a keyframe exists at-or-before this frame in its GOP. */
            boolean decodable,
            /** non-null when the source PTS jumped backwards or beyond the forward bound. */
            String discontinuity) {
    }

    /** The stream identity a frame flow must match. */
    public record SessionIdentity(
            String streamId, String tenantId, String principalId,
            String purposeRef, long sessionRevision) {
        public SessionIdentity {
            Objects.requireNonNull(streamId, "streamId");
            Objects.requireNonNull(tenantId, "tenantId");
            Objects.requireNonNull(principalId, "principalId");
            Objects.requireNonNull(purposeRef, "purposeRef");
        }
    }

    private final SessionIdentity identity;
    private final TreeMap<Integer, VideoStreamSession.DecodedFrame> pending = new TreeMap<>();
    private int nextExpected;
    private int lastKeyFrameSequence = -1;
    private long lastDeliveredPts = Long.MIN_VALUE;

    private VideoFrameReconciler(SessionIdentity identity, int lastAckedSequence,
            int lastKeyFrameSequence, long lastDeliveredPts) {
        this.identity = identity;
        this.nextExpected = lastAckedSequence + 1;
        this.lastKeyFrameSequence = lastKeyFrameSequence;
        this.lastDeliveredPts = lastDeliveredPts;
    }

    /** Opens a fresh video session; the first delivered frame should be a keyframe. */
    public static VideoFrameReconciler open(SessionIdentity identity) {
        return new VideoFrameReconciler(identity, -1, -1, Long.MIN_VALUE);
    }

    /**
     * Resumes after process loss at the durable ACK/keyframe position. A
     * different tenant or an older revision is denied — never silently merged.
     */
    public static VideoFrameReconciler resume(
            SessionIdentity identity, SessionIdentity durable,
            int lastAckedSequence, int lastKeyFrameSequence, long lastDeliveredPts) {
        Objects.requireNonNull(identity, "identity");
        Objects.requireNonNull(durable, "durable");
        if (!identity.streamId().equals(durable.streamId())) {
            throw new IllegalArgumentException("resume streamId does not match the durable session");
        }
        if (!identity.tenantId().equals(durable.tenantId())) {
            throw new IllegalArgumentException("cross-tenant resume is denied");
        }
        if (identity.sessionRevision() < durable.sessionRevision()) {
            throw new IllegalArgumentException(
                    "resume carries an older session revision than the durable session");
        }
        return new VideoFrameReconciler(identity, lastAckedSequence,
                lastKeyFrameSequence, lastDeliveredPts);
    }

    /** Offers one decoded frame; returns its disposition. */
    public Disposition offer(VideoStreamSession.DecodedFrame frame) {
        Objects.requireNonNull(frame, "frame");
        int sequence = frame.sequenceNumber();
        if (sequence < nextExpected) {
            return Disposition.DUPLICATE;
        }
        if (sequence == nextExpected) {
            nextExpected = sequence + 1;
            if (frame.keyFrame()) {
                lastKeyFrameSequence = sequence;
            }
            lastDeliveredPts = frame.timestampMillis();
            return Disposition.DELIVERED;
        }
        if (pending.containsKey(sequence)) {
            return Disposition.DUPLICATE;
        }
        if (pending.size() >= MAX_PENDING) {
            return Disposition.OVERFLOW;
        }
        pending.put(sequence, frame);
        return Disposition.HELD;
    }

    /**
     * The delivery view of the last-offered delivered frame — whether it is
     * decodable (a keyframe anchors its GOP) and any timestamp discontinuity.
     */
    public Delivery deliveryOf(VideoStreamSession.DecodedFrame frame) {
        boolean decodable = frame.keyFrame()
                || (lastKeyFrameSequence >= 0 && lastKeyFrameSequence <= frame.sequenceNumber());
        String discontinuity = null;
        if (lastDeliveredPts != Long.MIN_VALUE) {
            long pts = frame.timestampMillis();
            if (pts < lastDeliveredPts) {
                discontinuity = "PTS_BACKWARDS";
            } else if (pts - lastDeliveredPts > MAX_FORWARD_PTS_JUMP_MS) {
                discontinuity = "PTS_JUMP";
            }
        }
        return new Delivery(frame, decodable, discontinuity);
    }

    /** A held frame released once its gap closes; re-check for further releases. */
    public VideoStreamSession.DecodedFrame takeDelivered() {
        var head = pending.firstEntry();
        if (head == null || head.getKey() != nextExpected) {
            return null;
        }
        var frame = pending.pollFirstEntry().getValue();
        nextExpected = head.getKey() + 1;
        if (frame.keyFrame()) {
            lastKeyFrameSequence = frame.sequenceNumber();
        }
        lastDeliveredPts = frame.timestampMillis();
        return frame;
    }

    /** The sequence the next ACK acknowledges — the last contiguous delivered. */
    public int nextAck() {
        return nextExpected - 1;
    }

    public int nextExpected() {
        return nextExpected;
    }

    /** Sequence of the last delivered keyframe; -1 before the first. */
    public int lastKeyFrameSequence() {
        return lastKeyFrameSequence;
    }

    /** Last delivered source presentation timestamp (preserved verbatim, not wall clock). */
    public long lastDeliveredPts() {
        return lastDeliveredPts;
    }

    public int pendingCount() {
        return pending.size();
    }

    public SessionIdentity identity() {
        return identity;
    }
}
