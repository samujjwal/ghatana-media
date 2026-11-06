package com.ghatana.video.streaming;

import java.util.Objects;
import java.util.TreeMap;

/**
 * Ordered video-frame reconciliation preserving keyframe dependencies and
 * source-time uncertainty.
 *
 * <p>The wire's {@code timestampMillis} has no declared clock and is never
 * promoted to source PTS. A frame depends on the most recent keyframe in its GOP, so
 * losing a keyframe means dependent frames can be held but not rendered
 * until the next keyframe arrives. Source-time mapping is not admitted by the
 * session contract. Every source timestamp therefore remains UNKNOWN; the
 * wire millisecond field is never promoted to source PTS.
 *
 * <p>Pending out-of-order frames are bounded by both {@link #MAX_PENDING}
 * and {@link #MAX_PENDING_BYTES} total payload bytes.
 *
 * @doc.type class
 * @doc.purpose Keyframe/PTS-aware ordered video frame reconciliation
 * @doc.layer product
 * @doc.pattern Reconciler
 */
public final class VideoFrameReconciler {

    private static final int MAX_PENDING = 256;
    /** Total retained reorder payload is capped at one maximum video frame. */
    private static final long MAX_PENDING_BYTES = VideoStreamSession.MAX_FRAME_PAYLOAD_BYTES;

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
            /** Source-time disposition; currently always SOURCE_TIME_MAPPING_NOT_ADMITTED. */
            String discontinuity) {
    }

    /** The stream identity a frame flow must match. */
    public record SessionIdentity(
            String streamId, String tenantId, String principalId,
            String purposeRef, long sessionRevision) {
        public SessionIdentity {
            streamId = requiredIdentity(streamId, "streamId");
            tenantId = requiredIdentity(tenantId, "tenantId");
            principalId = requiredIdentity(principalId, "principalId");
            purposeRef = requiredIdentity(purposeRef, "purposeRef");
        }

        private static String requiredIdentity(String value, String field) {
            Objects.requireNonNull(value, field);
            if (value.isBlank()) {
                throw new IllegalArgumentException(field + " must not be blank");
            }
            return value;
        }
    }

    private final SessionIdentity identity;
    private final TreeMap<Integer, VideoStreamSession.DecodedFrame> pending = new TreeMap<>();
    private int nextExpected;
    private long pendingBytes;
    private int lastKeyFrameSequence = -1;

    private VideoFrameReconciler(SessionIdentity identity, int lastAckedSequence,
            int lastKeyFrameSequence) {
        this.identity = identity;
        this.nextExpected = lastAckedSequence + 1;
        this.lastKeyFrameSequence = lastKeyFrameSequence;
        // Legacy resume metadata contains only an unqualified long. It cannot
        // safely restore a source clock position.
    }

    /** Opens a fresh video session; the first delivered frame should be a keyframe. */
    public static VideoFrameReconciler open(SessionIdentity identity) {
        return new VideoFrameReconciler(identity, -1, -1);
    }

    /**
     * Resumes after process loss at the durable ACK/keyframe position. A
     * different tenant or revision is denied — never silently merged.
     * The legacy unqualified {@code lastDeliveredPts} argument is ignored; the
     * session contract has no source clock/origin/version binding to restore.
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
        if (!identity.principalId().equals(durable.principalId())) {
            throw new IllegalArgumentException("resume principal does not match the durable session");
        }
        if (!identity.purposeRef().equals(durable.purposeRef())) {
            throw new IllegalArgumentException("resume purpose does not match the durable session");
        }
        if (identity.sessionRevision() != durable.sessionRevision()) {
            throw new IllegalArgumentException(
                    "resume session revision does not match the durable session generation");
        }
        // MAX_FRAME_SEQUENCE is a valid acknowledged frame. Its successor is
        // Integer.MAX_VALUE, the exhausted-cursor sentinel, so restoring that
        // durable position is safe even though no further frame can be accepted.
        if (lastAckedSequence < -1 || lastAckedSequence > VideoStreamSession.MAX_FRAME_SEQUENCE) {
            throw new IllegalArgumentException("resume last ACK is outside the supported sequence range");
        }
        if (lastKeyFrameSequence < -1 || lastKeyFrameSequence > lastAckedSequence) {
            throw new IllegalArgumentException("resume keyframe sequence must be at or before the last ACK");
        }
        return new VideoFrameReconciler(identity, lastAckedSequence,
                lastKeyFrameSequence);
    }

    /** Offers one decoded frame; returns its disposition. */
    public Disposition offer(VideoStreamSession.DecodedFrame frame) {
        Objects.requireNonNull(frame, "frame");
        int sequence = frame.sequenceNumber();
        if (sequence < 0 || sequence > VideoStreamSession.MAX_FRAME_SEQUENCE) {
            throw new IllegalArgumentException("video frame sequence is outside the supported range");
        }
        byte[] payload = frame.payload();
        if (payload == null || payload.length > VideoStreamSession.MAX_FRAME_PAYLOAD_BYTES) {
            throw new IllegalArgumentException("video frame payload is outside the bounded size");
        }
        if (sequence < nextExpected) {
            return Disposition.DUPLICATE;
        }
        if (sequence == nextExpected) {
            nextExpected = sequence + 1;
            if (frame.keyFrame()) {
                lastKeyFrameSequence = sequence;
            }
            return Disposition.DELIVERED;
        }
        if (pending.containsKey(sequence)) {
            return Disposition.DUPLICATE;
        }
        if (pending.size() >= MAX_PENDING) {
            return Disposition.OVERFLOW;
        }
        if (pendingBytes + payload.length > MAX_PENDING_BYTES) {
            return Disposition.OVERFLOW;
        }
        pending.put(sequence, frame);
        pendingBytes += payload.length;
        return Disposition.HELD;
    }

    /**
     * The delivery view of the last-offered delivered frame — whether it is
     * decodable (a keyframe anchors its GOP) and any timestamp discontinuity.
     */
    public Delivery deliveryOf(VideoStreamSession.DecodedFrame frame) {
        Objects.requireNonNull(frame, "frame");
        boolean decodable = frame.keyFrame()
                || (lastKeyFrameSequence >= 0 && lastKeyFrameSequence <= frame.sequenceNumber());
        return new Delivery(frame, decodable, "SOURCE_TIME_MAPPING_NOT_ADMITTED");
    }

    /** A held frame released once its gap closes; re-check for further releases. */
    public VideoStreamSession.DecodedFrame takeDelivered() {
        var head = pending.firstEntry();
        if (head == null || head.getKey() != nextExpected) {
            return null;
        }
        var frame = pending.pollFirstEntry().getValue();
        pendingBytes -= frame.payload().length;
        nextExpected = head.getKey() + 1;
        if (frame.keyFrame()) {
            lastKeyFrameSequence = frame.sequenceNumber();
        }
        return frame;
    }

    /** Read-only view of the next held frame eligible for release. */
    VideoStreamSession.DecodedFrame peekDelivered() {
        var head = pending.firstEntry();
        return head != null && head.getKey() == nextExpected ? head.getValue() : null;
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

    /** Legacy accessor: unqualified session state cannot restore source PTS. */
    public long lastDeliveredPts() {
        return Long.MIN_VALUE;
    }

    public int pendingCount() {
        return pending.size();
    }

    /** Total payload bytes retained behind a sequence gap. */
    public long pendingBytes() {
        return pendingBytes;
    }

    /** Drops held frame payloads when the owning guarded session is cancelled. */
    void discardPending() {
        pending.clear();
        pendingBytes = 0L;
    }

    public SessionIdentity identity() {
        return identity;
    }
}
