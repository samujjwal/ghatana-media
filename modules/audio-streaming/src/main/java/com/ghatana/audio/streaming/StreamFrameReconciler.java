package com.ghatana.audio.streaming;

import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;

/**
 * Ordered frame reconciliation for one tenant-scoped stream session.
 *
 * <p>AS-03: duplicate, dropped and out-of-order chunks — and a reconnect
 * after process loss — must yield exactly one logical frame each plus the
 * correct next-ACK. A reconciler is bound to an immutable identity
 * (streamId, tenantId, principalId, purposeRef, sessionRevision); a resume
 * with a different tenant or revision is denied, never silently merged.
 *
 * <p>Gap handling is bounded: out-of-order frames ahead of the next
 * expected sequence are held up to {@link #MAX_PENDING} then rejected, so
 * an unbounded reorder storm cannot exhaust memory.
 *
 * @doc.type class
 * @doc.purpose Idempotent ordered frame/ACK reconciliation per stream session
 * @doc.layer product
 * @doc.pattern Reconciler
 */
public final class StreamFrameReconciler {

    private static final int MAX_PENDING = 256;

    /** What the reconciler did with one frame. */
    public enum Disposition {
        /** The next expected frame — delivered, ACK advances. */
        DELIVERED,
        /** An out-of-order frame ahead of the cursor — held for the gap to fill. */
        HELD,
        /** A duplicate of an already-acked or held frame — no second delivery. */
        DUPLICATE,
        /** A held frame whose gap could never be filled within bounds. */
        OVERFLOW
    }

    /** The session identity a frame stream must match to reconcile. */
    public record SessionIdentity(
            String streamId,
            String tenantId,
            String principalId,
            String purposeRef,
            long sessionRevision) {
        public SessionIdentity {
            Objects.requireNonNull(streamId, "streamId");
            Objects.requireNonNull(tenantId, "tenantId");
            Objects.requireNonNull(principalId, "principalId");
            Objects.requireNonNull(purposeRef, "purposeRef");
        }
    }

    private final SessionIdentity identity;
    private final TreeMap<Integer, AudioStreamSession.DecodedFrame> pending = new TreeMap<>();
    private int nextExpected; // first undelivered sequence (exclusive lower bound of the gap)

    /** @param lastAckedSequence the durable last-delivered sequence; -1 for a new session. */
    private StreamFrameReconciler(SessionIdentity identity, int lastAckedSequence) {
        this.identity = identity;
        this.nextExpected = lastAckedSequence + 1;
    }

    /** Opens a fresh session whose next expected frame is sequence 0. */
    public static StreamFrameReconciler open(SessionIdentity identity) {
        return new StreamFrameReconciler(identity, -1);
    }

    /**
     * Resumes a session after process loss. The durable last-ACK position is
     * re-established and anything earlier is a duplicate. A resume carrying a
     * different tenant or an older session revision is rejected.
     */
    public static StreamFrameReconciler resume(
            SessionIdentity identity, SessionIdentity durable, int lastAckedSequence) {
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
        return new StreamFrameReconciler(identity, lastAckedSequence);
    }

    /**
     * Offers one decoded frame. Returns the disposition; the caller delivers
     * a {@link #DELIVERED} frame exactly once and may ACK {@link #nextAck()}.
     */
    public Disposition offer(AudioStreamSession.DecodedFrame frame) {
        Objects.requireNonNull(frame, "frame");
        int sequence = frame.sequenceNumber();
        if (sequence < nextExpected) {
            return Disposition.DUPLICATE;
        }
        if (sequence == nextExpected) {
            advance(sequence);
            return Disposition.DELIVERED;
        }
        // Out-of-order ahead of the cursor — hold bounded until the gap fills.
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
     * A previously held frame is delivered once its gap closes — the caller
     * delivers it then re-checks {@link #takeDelivered} for further releases.
     */
    public AudioStreamSession.DecodedFrame takeDelivered() {
        Map.Entry<Integer, AudioStreamSession.DecodedFrame> head = pending.firstEntry();
        if (head == null || head.getKey() != nextExpected) {
            return null;
        }
        advance(head.getKey());
        return pending.pollFirstEntry().getValue();
    }

    /** The sequence the next ACK acknowledges — the last contiguous delivered. */
    public int nextAck() {
        return nextExpected - 1;
    }

    /** Next sequence still awaited; frames below it are duplicates. */
    public int nextExpected() {
        return nextExpected;
    }

    /** Currently held out-of-order frames awaiting a gap fill. */
    public int pendingCount() {
        return pending.size();
    }

    public SessionIdentity identity() {
        return identity;
    }

    private void advance(int sequence) {
        nextExpected = sequence + 1;
    }
}
