package com.ghatana.video.streaming;

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
 * @doc.type class
 * @doc.purpose Lease-fenced, consent-guarded video stream session
 * @doc.layer product
 * @doc.pattern Guarded Session
 */
public final class GuardedVideoStreamSession {

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
        /** Bounded pending set is full. */
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
        Objects.requireNonNull(workerId, "workerId");
        if (newClaimToken <= claimToken) {
            throw new StaleLeaseException("claim", newClaimToken, claimToken);
        }
        leaseHolder = workerId;
        claimToken = newClaimToken;
    }

    /** Offers one frame under the presented claim; returns the honest verdict. */
    public FrameVerdict submitFrame(
            String workerId, long presentedToken, VideoStreamSession.DecodedFrame frame) {
        requireLease(workerId, presentedToken, "frame submit");
        requireAttached("frame submit");
        VideoFrameReconciler.Disposition disposition = reconciler.offer(frame);
        if (disposition == VideoFrameReconciler.Disposition.DELIVERED) {
            // A contiguous frame is not automatically a success — without its
            // GOP keyframe it is an undecodable gap.
            return reconciler.deliveryOf(frame).decodable()
                    ? FrameVerdict.DELIVERED_DECODABLE
                    : FrameVerdict.DELIVERED_UNDECODABLE;
        }
        return switch (disposition) {
            case HELD -> FrameVerdict.HELD;
            case DUPLICATE -> FrameVerdict.DUPLICATE;
            case OVERFLOW -> FrameVerdict.OVERFLOW;
            default -> throw new IllegalStateException("unmapped disposition " + disposition);
        };
    }

    /** Releases a held frame once its gap closes, under the presented claim. */
    public VideoStreamSession.DecodedFrame takeDelivered(
            String workerId, long presentedToken) {
        requireLease(workerId, presentedToken, "frame delivery");
        requireAttached("frame delivery");
        return reconciler.takeDelivered();
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
     * submit and dispatch prevents the external effect entirely.
     */
    public void egress(
            String workerId, long presentedToken,
            VideoStreamSession.DecodedFrame frame, ProviderEgress sink) {
        Objects.requireNonNull(frame, "frame");
        Objects.requireNonNull(sink, "sink");
        requireLease(workerId, presentedToken, "provider egress");
        requireAttached("provider egress");
        ConsentDecision decision = consent.authorize(new ConsentContext(
                identity.tenantId(), identity.principalId(),
                identity.purposeRef(), claimToken));
        if (decision != ConsentDecision.ADMITTED) {
            throw new ConsentDeniedException("provider egress", decision);
        }
        sink.accept(frame);
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
     * denied by the reconciler, never merged.
     */
    public void resume(
            String workerId, long presentedToken,
            VideoFrameReconciler.SessionIdentity durableIdentity,
            int lastAckedSequence, int lastKeyFrameSequence, long lastDeliveredPts) {
        requireLease(workerId, presentedToken, "resume");
        if (!detached) {
            throw new IllegalStateException("only a detached session can resume");
        }
        reconciler = VideoFrameReconciler.resume(
                identity, durableIdentity,
                lastAckedSequence, lastKeyFrameSequence, lastDeliveredPts);
        detached = false;
    }

    /** The sequence the next ACK acknowledges — only under the current claim. */
    public int nextAck(String workerId, long presentedToken) {
        requireLease(workerId, presentedToken, "acknowledge");
        return reconciler.nextAck();
    }

    public boolean detached() {
        return detached;
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
        if (!Objects.equals(workerId, leaseHolder) || presentedToken != claimToken) {
            throw new StaleLeaseException(transition, presentedToken, claimToken);
        }
    }

    private void requireAttached(String transition) {
        if (detached) {
            throw new IllegalStateException(
                    "video stream " + transition + " requires an attached session");
        }
    }
}
