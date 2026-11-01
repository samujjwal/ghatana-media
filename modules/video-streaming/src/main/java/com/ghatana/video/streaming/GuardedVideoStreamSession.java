package com.ghatana.video.streaming;

import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Objects;

/**
 * Tenant-scoped claim/lease-guarded video stream session.
 *
 * <p>VS-04: exactly one worker holds the session lease at a time, fenced by a
 * strictly increasing claim token. Every mutating or egress transition must
 * present the current claim — a stale worker after takeover can neither
 * submit frames, advance the ACK, nor reach a provider. Live consent is
 * re-evaluated on every actual egress; a revoked purpose forbids external
 * effects entirely.
 *
 * <p>Detach is a resumable transport loss; {@link #resume} restores the
 * durable ACK/keyframe/PTS position so frame identity and keyframe
 * dependencies survive a reconnect. A missing GOP keyframe is surfaced as a
 * gap — never as a decodable false success.
 *
 * <p>This object is an in-memory session state machine and is not thread-safe.
 * Its owner must serialize all transitions on one event loop or equivalent
 * per-session executor. Lease fencing protects serialized calls from stale
 * worker claims; it does not make concurrent calls atomic.
 *
 * <p>{@link #cancel} is a terminal guard for subsequent serialized local
 * transitions and discards held in-memory frames. It does not interrupt a
 * provider call already in progress, establish provider-side finality, or
 * persist cancellation across process restart.
 *
 * @doc.type class
 * @doc.purpose Lease-fenced, consent-guarded video stream session
 * @doc.layer product
 * @doc.pattern Guarded Session
 */
public final class GuardedVideoStreamSession {

    private static final int MAX_EGRESS_CANDIDATES = 256;

    /** The consent decision for one guarded egress transition. */
    public enum ConsentDecision { ADMITTED, DENIED, NOT_ADMITTED, EXPIRED }

    /** Immutable consent context re-evaluated per egress. */
    public record ConsentContext(
            String tenantId, String principalId, String purposeRef, long claimToken) {
        public ConsentContext {
            Objects.requireNonNull(tenantId, "tenantId");
            Objects.requireNonNull(principalId, "principalId");
            Objects.requireNonNull(purposeRef, "purposeRef");
        }
    }

    /** Trusted consent source; caller consent strings are never an input. */
    @FunctionalInterface
    public interface ConsentSource {
        ConsentDecision authorize(ConsentContext context);

        static ConsentSource unavailable() {
            return context -> ConsentDecision.NOT_ADMITTED;
        }
    }

    /** The delivery view the session reports for one frame — honest about gaps. */
    public enum FrameVerdict {
        /** Contiguous and decodable — a keyframe anchors its GOP. */
        DELIVERED_DECODABLE,
        /** Contiguous but not decodable — the GOP keyframe was lost; a gap, not success. */
        DELIVERED_UNDECODABLE,
        /** Held for a missing earlier sequence. */
        HELD,
        /** Duplicate of an acked or held frame. */
        DUPLICATE,
        /** Pending reorder set or bounded egress-candidate capacity is full. */
        OVERFLOW
    }

    /** Thrown when a worker presents a stale claim token after lease takeover. */
    public static final class StaleLeaseException extends RuntimeException {
        StaleLeaseException(String transition, long presented, long current) {
            super("stale stream lease on " + transition
                    + ": presented=" + presented + " current=" + current);
        }
    }

    /** Thrown when live consent does not admit an egress transition. */
    public static final class ConsentDeniedException extends RuntimeException {
        private final ConsentDecision decision;

        ConsentDeniedException(String transition, ConsentDecision decision) {
            super("video stream " + transition + " denied by consent source: " + decision);
            this.decision = decision;
        }

        public ConsentDecision decision() {
            return decision;
        }
    }

    /** Backpressure raised when a held deliverable frame cannot be retained for egress yet. */
    public static final class EgressCapacityException extends RuntimeException {
        EgressCapacityException() {
            super("video stream egress candidate capacity is full; release a candidate before draining held frames");
        }
    }

    /** External provider/capture egress sink; reached only under lease+consent. */
    @FunctionalInterface
    public interface ProviderEgress {
        void accept(VideoStreamSession.DecodedFrame frame);
    }

    private final VideoFrameReconciler.SessionIdentity identity;
    private final ConsentSource consent;
    private VideoFrameReconciler reconciler;
    private String leaseHolder;
    private long claimToken;
    private boolean detached;
    private boolean cancelled;
    /** Bounded digests bind provider egress to exact frames delivered in this process. */
    private final LinkedHashMap<Integer, byte[]> egressCandidates = new LinkedHashMap<>();

    private GuardedVideoStreamSession(
            VideoFrameReconciler.SessionIdentity identity,
            ConsentSource consent,
            VideoFrameReconciler reconciler,
            String leaseHolder,
            long claimToken) {
        this.identity = identity;
        this.consent = consent;
        this.reconciler = reconciler;
        this.leaseHolder = leaseHolder;
        this.claimToken = claimToken;
    }

    /**
     * Opens a session and grants the initial claim to {@code workerId} at
     * fencing token 1.
     */
    public static GuardedVideoStreamSession open(
            VideoFrameReconciler.SessionIdentity identity,
            ConsentSource consent,
            String workerId) {
        Objects.requireNonNull(identity, "identity");
        Objects.requireNonNull(consent, "consent");
        Objects.requireNonNull(workerId, "workerId");
        return new GuardedVideoStreamSession(
                identity, consent, VideoFrameReconciler.open(identity), workerId, 1L);
    }

    /**
     * Transfers the lease to a new worker at a strictly higher fencing token.
     * The prior holder's token goes stale immediately — its further submits,
     * ACKs and egress are rejected by {@link #requireLease}.
     */
    public void claim(String workerId, long newClaimToken) {
        requireNotCancelled("claim");
        Objects.requireNonNull(workerId, "workerId");
        if (newClaimToken <= claimToken) {
            throw new StaleLeaseException("claim", newClaimToken, claimToken);
        }
        leaseHolder = workerId;
        claimToken = newClaimToken;
    }

    /**
     * Offers one frame under the presented claim; returns the honest verdict.
     * {@link FrameVerdict#OVERFLOW} applies backpressure without advancing the
     * ACK cursor when a decodable frame cannot be retained for egress.
     */
    public FrameVerdict submitFrame(
            String workerId, long presentedToken, VideoStreamSession.DecodedFrame frame) {
        requireLease(workerId, presentedToken, "frame submit");
        requireAttached("frame submit");
        VideoStreamSession.DecodedFrame snapshot = snapshotFrame(frame);
        // Do not advance the ACK cursor when a decodable frame could not be
        // retained for its later provider-egress check. Duplicates remain
        // duplicates even while the egress queue is full.
        if (snapshot.sequenceNumber() >= 0
                && snapshot.sequenceNumber() < Integer.MAX_VALUE
                && snapshot.sequenceNumber() == reconciler.nextExpected()
                && reconciler.deliveryOf(snapshot).decodable()
                && egressCandidates.size() >= MAX_EGRESS_CANDIDATES) {
            return FrameVerdict.OVERFLOW;
        }
        VideoFrameReconciler.Disposition disposition = reconciler.offer(snapshot);
        if (disposition == VideoFrameReconciler.Disposition.DELIVERED) {
            // A contiguous frame is not automatically a success — without its
            // GOP keyframe it is an undecodable gap.
            if (reconciler.deliveryOf(snapshot).decodable()) {
                rememberEgressCandidate(snapshot);
                return FrameVerdict.DELIVERED_DECODABLE;
            }
            return FrameVerdict.DELIVERED_UNDECODABLE;
        }
        return switch (disposition) {
            case HELD -> FrameVerdict.HELD;
            case DUPLICATE -> FrameVerdict.DUPLICATE;
            case OVERFLOW -> FrameVerdict.OVERFLOW;
            default -> throw new IllegalStateException("unmapped disposition " + disposition);
        };
    }

    /**
     * Releases a held frame once its gap closes, under the presented claim.
     * If the next held frame needs an egress slot and all bounded slots are
     * occupied, {@link EgressCapacityException} leaves it pending for retry.
     */
    public VideoStreamSession.DecodedFrame takeDelivered(
            String workerId, long presentedToken) {
        requireLease(workerId, presentedToken, "frame delivery");
        requireAttached("frame delivery");
        VideoStreamSession.DecodedFrame pending = reconciler.peekDelivered();
        if (pending != null && reconciler.deliveryOf(pending).decodable()
                && egressCandidates.size() >= MAX_EGRESS_CANDIDATES) {
            throw new EgressCapacityException();
        }
        VideoStreamSession.DecodedFrame frame = reconciler.takeDelivered();
        if (frame != null) {
            frame = snapshotFrame(frame);
            if (reconciler.deliveryOf(frame).decodable()) {
                rememberEgressCandidate(frame);
            }
        }
        return frame;
    }

    /**
     * The decodability verdict of a delivered frame — a contiguous frame
     * whose GOP keyframe was lost is an undecodable gap, never a success.
     */
    public FrameVerdict verdictOfDelivered(
            String workerId, long presentedToken, VideoStreamSession.DecodedFrame frame) {
        requireLease(workerId, presentedToken, "delivery verdict");
        return reconciler.deliveryOf(frame).decodable()
                ? FrameVerdict.DELIVERED_DECODABLE
                : FrameVerdict.DELIVERED_UNDECODABLE;
    }

    /**
     * Dispatches one frame to an external provider/capture egress. Live
     * consent is re-evaluated at the point of egress — revocation between
     * submit and dispatch prevents the external effect entirely. The exact
     * decodable frame must have been delivered by this in-memory session and
     * is consumed before the sink is called, preventing a local blind replay.
     * A sink exception therefore leaves the external outcome unknown and the
     * frame cannot be retried through this session; this is not provider-side
     * exactly-once or finality evidence.
     */
    public void egress(
            String workerId, long presentedToken,
            VideoStreamSession.DecodedFrame frame, ProviderEgress sink) {
        Objects.requireNonNull(sink, "sink");
        requireLease(workerId, presentedToken, "provider egress");
        requireAttached("provider egress");
        VideoStreamSession.DecodedFrame snapshot = snapshotFrame(frame);
        ConsentDecision decision = consent.authorize(new ConsentContext(
                identity.tenantId(), identity.principalId(),
                identity.purposeRef(), claimToken));
        if (decision != ConsentDecision.ADMITTED) {
            throw new ConsentDeniedException("provider egress", decision);
        }
        byte[] admittedDigest = egressCandidates.get(snapshot.sequenceNumber());
        if (admittedDigest == null || !Arrays.equals(admittedDigest, frameDigest(snapshot))) {
            throw new IllegalArgumentException(
                    "video frame was not delivered as a decodable frame or was already egressed");
        }
        egressCandidates.remove(snapshot.sequenceNumber());
        sink.accept(snapshot);
    }

    /** Client transport detach — the session stays resumable under its lease. */
    public void detach(String workerId, long presentedToken) {
        requireLease(workerId, presentedToken, "detach");
        detached = true;
    }

    /**
     * Resumes a detached session at the durable position: last ACK, last
     * delivered keyframe and last delivered PTS — frame identity and GOP
     * dependencies survive the reconnect. Tenant and revision mismatches are
     * denied by the reconciler, never merged. If locally delivered frames
     * still await provider egress, the supplied ACK must match the in-memory
     * ACK; those bounded egress candidates are preserved across this resume.
     */
    public void resume(
            String workerId, long presentedToken,
            VideoFrameReconciler.SessionIdentity durableIdentity,
            int lastAckedSequence, int lastKeyFrameSequence, long lastDeliveredPts) {
        requireLease(workerId, presentedToken, "resume");
        if (!detached) {
            throw new IllegalStateException("only a detached session can resume");
        }
        if (!egressCandidates.isEmpty() && lastAckedSequence != reconciler.nextAck()) {
            throw new IllegalArgumentException(
                    "resume ACK must match the in-memory ACK while delivered frames await egress");
        }
        reconciler = VideoFrameReconciler.resume(
                identity, durableIdentity,
                lastAckedSequence, lastKeyFrameSequence, lastDeliveredPts);
        detached = false;
    }

    /**
     * Terminal in-memory cancellation. Unlike {@link #detach}, cancellation
     * cannot be resumed or transferred to another worker and prevents every
     * subsequent serialized frame, ACK, or provider-egress transition. The
     * session owner must serialize this call with other transitions; this
     * method cannot interrupt an egress call already in progress and does not
     * persist cancellation across process restart.
     */
    public void cancel(String workerId, long presentedToken) {
        requireLeaseIdentity(workerId, presentedToken, "cancel");
        reconciler.discardPending();
        egressCandidates.clear();
        cancelled = true;
    }

    /** The sequence the next ACK acknowledges — only under the current claim. */
    public int nextAck(String workerId, long presentedToken) {
        requireLease(workerId, presentedToken, "acknowledge");
        return reconciler.nextAck();
    }

    public boolean detached() {
        return detached;
    }

    public boolean cancelled() {
        return cancelled;
    }

    public String leaseHolder() {
        return leaseHolder;
    }

    public long claimToken() {
        return claimToken;
    }

    public int pendingCount() {
        return reconciler.pendingCount();
    }

    public VideoFrameReconciler.SessionIdentity identity() {
        return identity;
    }

    private void requireLease(String workerId, long presentedToken, String transition) {
        requireNotCancelled(transition);
        requireLeaseIdentity(workerId, presentedToken, transition);
    }

    private void requireLeaseIdentity(String workerId, long presentedToken, String transition) {
        if (!Objects.equals(workerId, leaseHolder) || presentedToken != claimToken) {
            throw new StaleLeaseException(transition, presentedToken, claimToken);
        }
    }

    private void requireNotCancelled(String transition) {
        if (cancelled) {
            throw new IllegalStateException("video stream " + transition + " is forbidden after cancellation");
        }
    }

    private void rememberEgressCandidate(VideoStreamSession.DecodedFrame frame) {
        egressCandidates.put(frame.sequenceNumber(), frameDigest(frame));
    }

    private static byte[] frameDigest(VideoStreamSession.DecodedFrame frame) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(ByteBuffer.allocate(Integer.BYTES + 1 + Long.BYTES)
                    .putInt(frame.sequenceNumber())
                    .put((byte) (frame.keyFrame() ? 1 : 0))
                    .putLong(frame.timestampMillis())
                    .array());
            digest.update(validateFramePayload(frame));
            return digest.digest();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    private static byte[] validateFramePayload(VideoStreamSession.DecodedFrame frame) {
        Objects.requireNonNull(frame, "frame");
        byte[] payload = frame.payload();
        if (payload == null || payload.length > VideoStreamSession.MAX_FRAME_PAYLOAD_BYTES) {
            throw new IllegalArgumentException("video stream frame payload is outside the bounded size");
        }
        return payload;
    }

    private static VideoStreamSession.DecodedFrame snapshotFrame(
            VideoStreamSession.DecodedFrame frame) {
        byte[] payload = validateFramePayload(frame);
        return new VideoStreamSession.DecodedFrame(
                frame.sequenceNumber(), frame.keyFrame(), frame.timestampMillis(), payload.clone());
    }

    private void requireAttached(String transition) {
        if (detached) {
            throw new IllegalStateException(
                    "video stream " + transition + " requires an attached session");
        }
    }
}
