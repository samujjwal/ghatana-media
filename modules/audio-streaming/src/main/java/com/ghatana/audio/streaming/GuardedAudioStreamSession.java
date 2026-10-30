package com.ghatana.audio.streaming;

import java.util.Objects;

/**
 * Consent-guarded audio stream session.
 *
 * <p>AS-05: every transition that can accept a frame or reach a provider is
 * gated on the <em>current</em> consent decision from the trusted
 * {@link StreamConsentGate.Source} — connect, frame submit, provider dispatch
 * and reconnect each re-evaluate consent. An expired grant or a revoked
 * purpose forbids new frames and any external processing.
 *
 * <p>Detach and server cancel are distinct: {@link #detach()} is a
 * client-side transport loss that leaves the session resumable, while
 * {@link #cancel()} is a terminal server-side cancellation after which no
 * resume, frame or dispatch is possible. A reconnect must carry a strictly
 * newer session generation — replaying an older generation is denied, never
 * silently merged.
 *
 * @doc.type class
 * @doc.purpose Consent-gated frame/reconnect/dispatch lifecycle for one stream
 * @doc.layer product
 * @doc.pattern Guarded Session
 */
public final class GuardedAudioStreamSession {

    /** Transport attachment state; orthogonal to consent. */
    public enum Attachment {
        /** Connected — frames and dispatch allowed subject to live consent. */
        ATTACHED,
        /** Detached by the client transport — resumable, no frames meanwhile. */
        DETACHED,
        /** Server-cancelled — terminal; no resume, frame or dispatch. */
        CANCELLED
    }

    /** Thrown when live consent does not admit a guarded transition. */
    public static final class ConsentDeniedException extends RuntimeException {
        private final StreamConsentGate.Decision decision;

        ConsentDeniedException(String transition, StreamConsentGate.Decision decision) {
            super("stream " + transition + " denied by consent source: " + decision);
            this.decision = decision;
        }

        public StreamConsentGate.Decision decision() {
            return decision;
        }
    }

    /** External provider effect sink; invoked only under admitted consent. */
    @FunctionalInterface
    public interface ProviderSink {
        void accept(AudioStreamSession.DecodedFrame frame);
    }

    private final StreamFrameReconciler.SessionIdentity identity;
    private final StreamConsentGate.Source consent;
    private final StreamFrameReconciler reconciler;
    private Attachment attachment;
    private long generation;

    private GuardedAudioStreamSession(
            StreamFrameReconciler.SessionIdentity identity,
            StreamConsentGate.Source consent,
            StreamFrameReconciler reconciler,
            long generation) {
        this.identity = identity;
        this.consent = consent;
        this.reconciler = reconciler;
        this.attachment = Attachment.ATTACHED;
        this.generation = generation;
    }

    /**
     * Opens a guarded session at generation 0. Consent is evaluated now —
     * a denied or unadmitted session is never attached.
     */
    public static GuardedAudioStreamSession connect(
            StreamFrameReconciler.SessionIdentity identity,
            StreamConsentGate.Source consent) {
        Objects.requireNonNull(identity, "identity");
        Objects.requireNonNull(consent, "consent");
        requireConsent(consent, identity, 0L, "connect");
        return new GuardedAudioStreamSession(
                identity, consent, StreamFrameReconciler.open(identity), 0L);
    }

    /** Offers one frame; requires ATTACHED plus currently admitted consent. */
    public StreamFrameReconciler.Disposition submitFrame(
            AudioStreamSession.DecodedFrame frame) {
        requireAttached("frame submit");
        requireConsent("frame submit");
        return reconciler.offer(frame);
    }

    /** Held-frame release after a gap closes; same guard as submit. */
    public AudioStreamSession.DecodedFrame takeDelivered() {
        requireAttached("frame delivery");
        requireConsent("frame delivery");
        return reconciler.takeDelivered();
    }

    /**
     * Dispatches one delivered frame to an external provider sink. Consent is
     * re-evaluated at the point of dispatch — a revocation between frame
     * submit and dispatch prevents the external effect entirely.
     */
    public void dispatchToProvider(
            AudioStreamSession.DecodedFrame frame, ProviderSink sink) {
        Objects.requireNonNull(frame, "frame");
        Objects.requireNonNull(sink, "sink");
        requireAttached("provider dispatch");
        requireConsent("provider dispatch");
        sink.accept(frame);
    }

    /** Client transport detach — the session stays resumable. */
    public void detach() {
        if (attachment == Attachment.CANCELLED) {
            throw new IllegalStateException("a cancelled session cannot detach");
        }
        attachment = Attachment.DETACHED;
    }

    /**
     * Reconnects a detached session at a strictly newer generation. A stale
     * or replayed generation is denied; consent is re-evaluated. A cancelled
     * session can never be reconnected — cancel is terminal.
     */
    public void reconnect(long reconnectGeneration) {
        if (attachment == Attachment.CANCELLED) {
            throw new IllegalStateException("a cancelled session cannot reconnect");
        }
        if (attachment != Attachment.DETACHED) {
            throw new IllegalStateException("only a detached session can reconnect");
        }
        if (reconnectGeneration <= generation) {
            throw new IllegalArgumentException(
                    "stale session generation on reconnect: " + reconnectGeneration);
        }
        requireConsent(consent, identity, reconnectGeneration, "reconnect");
        generation = reconnectGeneration;
        attachment = Attachment.ATTACHED;
    }

    /**
     * Terminal server-side cancel. After this, no resume, frame or provider
     * dispatch is possible — distinct from a reversible client detach.
     */
    public void cancel() {
        attachment = Attachment.CANCELLED;
    }

    public Attachment attachment() {
        return attachment;
    }

    public long generation() {
        return generation;
    }

    public int nextAck() {
        return reconciler.nextAck();
    }

    public int nextExpected() {
        return reconciler.nextExpected();
    }

    public int pendingCount() {
        return reconciler.pendingCount();
    }

    public StreamFrameReconciler.SessionIdentity identity() {
        return identity;
    }

    private void requireAttached(String transition) {
        if (attachment != Attachment.ATTACHED) {
            throw new IllegalStateException(
                    "stream " + transition + " requires an attached session: " + attachment);
        }
    }

    private void requireConsent(String transition) {
        requireConsent(consent, identity, generation, transition);
    }

    private static void requireConsent(
            StreamConsentGate.Source consent,
            StreamFrameReconciler.SessionIdentity identity,
            long generation,
            String transition) {
        StreamConsentGate.Decision decision = consent.authorize(
                new StreamConsentGate.ConsentContext(
                        identity.tenantId(), identity.principalId(),
                        identity.purposeRef(), generation));
        if (!StreamConsentGate.permits(decision)) {
            throw new ConsentDeniedException(transition, decision);
        }
    }
}
