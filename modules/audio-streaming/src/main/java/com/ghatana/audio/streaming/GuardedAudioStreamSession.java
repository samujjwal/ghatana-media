package com.ghatana.audio.streaming;

import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.LinkedHashMap;
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
 * <p>This in-memory state machine is not thread-safe. Its owner must serialize
 * transitions on one event loop or per-session executor. Cancellation clears
 * local pending frames and blocks later transitions; it does not interrupt an
 * in-flight provider call, persist across restart, or prove provider finality.
 *
 * @doc.type class
 * @doc.purpose Consent-gated frame/reconnect/dispatch lifecycle for one stream
 * @doc.layer product
 * @doc.pattern Guarded Session
 */
public final class GuardedAudioStreamSession {

    private static final int MAX_PROVIDER_CANDIDATES = 256;

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

    /** Backpressure raised when a held deliverable frame cannot be retained for dispatch yet. */
    public static final class ProviderDispatchCapacityException extends RuntimeException {
        ProviderDispatchCapacityException() {
            super("audio stream provider candidate capacity is full; dispatch a candidate before draining held frames");
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
    /** Bounded digests bind provider dispatch to exact frames delivered in this process. */
    private final LinkedHashMap<Integer, byte[]> providerCandidates = new LinkedHashMap<>();
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

    /**
     * Offers one frame under current consent. OVERFLOW applies backpressure
     * without advancing the ACK when a delivered frame cannot be retained for
     * its later provider-dispatch check.
     */
    public StreamFrameReconciler.Disposition submitFrame(
            AudioStreamSession.DecodedFrame frame) {
        requireAttached("frame submit");
        try {
            requireConsent("frame submit");
        } catch (ConsentDeniedException denied) {
            discardUndispatchedFrames();
            throw denied;
        }
        AudioStreamSession.DecodedFrame snapshot = snapshotFrame(frame);
        if (snapshot.sequenceNumber() >= 0
                && snapshot.sequenceNumber() < Integer.MAX_VALUE
                && snapshot.sequenceNumber() == reconciler.nextExpected()
                && providerCandidates.size() >= MAX_PROVIDER_CANDIDATES) {
            return StreamFrameReconciler.Disposition.OVERFLOW;
        }
        StreamFrameReconciler.Disposition disposition = reconciler.offer(snapshot);
        if (disposition == StreamFrameReconciler.Disposition.DELIVERED) {
            rememberProviderCandidate(snapshot);
        }
        return disposition;
    }

    /**
     * Held-frame release after a gap closes; same guard as submit. If the
     * next held frame cannot be retained for provider dispatch, this throws
     * and leaves it pending for retry after capacity is released.
     */
    public AudioStreamSession.DecodedFrame takeDelivered() {
        requireAttached("frame delivery");
        try {
            requireConsent("frame delivery");
        } catch (ConsentDeniedException denied) {
            discardUndispatchedFrames();
            throw denied;
        }
        AudioStreamSession.DecodedFrame pending = reconciler.peekDelivered();
        if (pending != null && providerCandidates.size() >= MAX_PROVIDER_CANDIDATES) {
            throw new ProviderDispatchCapacityException();
        }
        AudioStreamSession.DecodedFrame frame = reconciler.takeDelivered();
        if (frame != null) {
            frame = snapshotFrame(frame);
            rememberProviderCandidate(frame);
        }
        return frame;
    }

    /**
     * Dispatches one exact frame delivered by this in-memory reconciler.
     * Consent is re-evaluated at dispatch, the candidate is consumed before
     * the sink call to prevent blind local replay, and a sink exception leaves
     * the provider outcome unknown. This is not provider-side exactly-once or
     * finality evidence.
     */
    public void dispatchToProvider(
            AudioStreamSession.DecodedFrame frame, ProviderSink sink) {
        Objects.requireNonNull(sink, "sink");
        requireAttached("provider dispatch");
        try {
            requireConsent("provider dispatch");
        } catch (ConsentDeniedException denied) {
            discardUndispatchedFrames();
            throw denied;
        }
        AudioStreamSession.DecodedFrame snapshot = snapshotFrame(frame);
        byte[] admittedDigest = providerCandidates.get(snapshot.sequenceNumber());
        if (admittedDigest == null || !Arrays.equals(admittedDigest, frameDigest(snapshot))) {
            throw new IllegalArgumentException(
                    "audio frame was not delivered by this session or was already dispatched");
        }
        providerCandidates.remove(snapshot.sequenceNumber());
        sink.accept(snapshot);
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
        try {
            requireConsent(consent, identity, reconnectGeneration, "reconnect");
        } catch (ConsentDeniedException denied) {
            // Frames accepted before detach must not survive an unauthorized
            // reconnect and become provider work after consent is restored.
            discardUndispatchedFrames();
            throw denied;
        }
        generation = reconnectGeneration;
        attachment = Attachment.ATTACHED;
    }

    /**
     * Terminal server-side cancel. After this, no resume, frame or provider
     * dispatch is possible — distinct from a reversible client detach.
     */
    public void cancel() {
        discardUndispatchedFrames();
        attachment = Attachment.CANCELLED;
    }

    /** Drop locally retained frames when current consent no longer admits work. */
    private void discardUndispatchedFrames() {
        reconciler.discardPending();
        providerCandidates.clear();
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

    private void rememberProviderCandidate(AudioStreamSession.DecodedFrame frame) {
        providerCandidates.put(frame.sequenceNumber(), frameDigest(frame));
    }

    private static AudioStreamSession.DecodedFrame snapshotFrame(
            AudioStreamSession.DecodedFrame frame) {
        Objects.requireNonNull(frame, "frame");
        byte[] payload = frame.payload();
        if (payload == null || payload.length > AudioStreamSession.MAX_FRAME_PAYLOAD_BYTES) {
            throw new IllegalArgumentException("audio stream frame payload is outside the bounded size");
        }
        return new AudioStreamSession.DecodedFrame(
                frame.sequenceNumber(), frame.timestampMillis(), payload.clone());
    }

    private static byte[] frameDigest(AudioStreamSession.DecodedFrame frame) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(ByteBuffer.allocate(Integer.BYTES + Long.BYTES)
                    .putInt(frame.sequenceNumber())
                    .putLong(frame.timestampMillis())
                    .array());
            digest.update(frame.payload());
            return digest.digest();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }
}
