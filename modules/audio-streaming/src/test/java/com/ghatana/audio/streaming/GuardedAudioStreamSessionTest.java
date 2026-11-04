package com.ghatana.audio.streaming;

import com.ghatana.audio.streaming.GuardedAudioStreamSession.Attachment;
import com.ghatana.audio.streaming.GuardedAudioStreamSession.ConsentDeniedException;
import com.ghatana.audio.streaming.StreamConsentGate.Decision;
import com.ghatana.audio.streaming.StreamFrameReconciler.Disposition;
import com.ghatana.audio.streaming.StreamFrameReconciler.SessionIdentity;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * AS-05: consent re-evaluated at connect, frame submit, provider dispatch and
 * reconnect; revocation forbids new frames and external effects; detach is
 * not a server cancel.
 */
@DisplayName("GuardedAudioStreamSession")
class GuardedAudioStreamSessionTest {

    private static SessionIdentity identity() {
        return new SessionIdentity("stream-1", "tenant-1", "principal-1", "purpose-1", 1);
    }

    private static AudioStreamSession.DecodedFrame frame(int seq) {
        return new AudioStreamSession.DecodedFrame(seq, seq * 20L, new byte[]{0x1});
    }

    private static StreamConsentGate.Source consent(Decision decision) {
        return context -> decision;
    }

    @Test
    @DisplayName("connect is denied when consent is not admitted")
    void connectDenied() {
        for (Decision denied : new Decision[]{Decision.DENIED, Decision.NOT_ADMITTED, Decision.EXPIRED}) {
            assertThatThrownBy(() -> GuardedAudioStreamSession.connect(identity(), consent(denied)))
                    .isInstanceOf(ConsentDeniedException.class)
                    .hasMessageContaining("connect");
        }
    }

    @Test
    @DisplayName("revocation during the stream forbids new frames")
    void revocationForbidsFrames() {
        AtomicReference<Decision> live = new AtomicReference<>(Decision.ADMITTED);
        GuardedAudioStreamSession session =
                GuardedAudioStreamSession.connect(identity(), context -> live.get());
        assertThat(session.submitFrame(frame(0))).isEqualTo(Disposition.DELIVERED);

        live.set(Decision.DENIED);
        assertThatThrownBy(() -> session.submitFrame(frame(1)))
                .isInstanceOf(ConsentDeniedException.class)
                .hasMessageContaining("frame submit");
        // The denied frame was never reconciled — no partial accept.
        assertThat(session.nextAck()).isEqualTo(0);
        assertThat(session.nextExpected()).isEqualTo(1);
    }

    @Test
    @DisplayName("an expired grant forbids provider dispatch between submit and dispatch")
    void expiryForbidsExternalEffect() {
        AtomicReference<Decision> live = new AtomicReference<>(Decision.ADMITTED);
        GuardedAudioStreamSession session =
                GuardedAudioStreamSession.connect(identity(), context -> live.get());
        session.submitFrame(frame(0));

        live.set(Decision.EXPIRED);
        AtomicInteger providerEffects = new AtomicInteger();
        assertThatThrownBy(() ->
                session.dispatchToProvider(frame(0), f -> providerEffects.incrementAndGet()))
                .isInstanceOf(ConsentDeniedException.class)
                .hasMessageContaining("provider dispatch");
        assertThat(providerEffects.get()).isZero();
    }

    @Test
    @DisplayName("revoked dispatch and expired reconnect remain denied without effects or state advance")
    void revokedDispatchAndExpiredReconnectFailClosed() {
        for (Decision denied : new Decision[]{Decision.DENIED, Decision.EXPIRED}) {
            AtomicReference<Decision> dispatchConsent = new AtomicReference<>(Decision.ADMITTED);
            GuardedAudioStreamSession dispatchSession = GuardedAudioStreamSession.connect(
                    identity(), context -> dispatchConsent.get());
            dispatchSession.submitFrame(frame(0));
            dispatchConsent.set(denied);
            AtomicInteger providerEffects = new AtomicInteger();

            assertThatThrownBy(() -> dispatchSession.dispatchToProvider(
                    frame(0), f -> providerEffects.incrementAndGet()))
                    .isInstanceOf(ConsentDeniedException.class)
                    .hasMessageContaining("provider dispatch");
            assertThat(providerEffects.get()).isZero();

            AtomicReference<Decision> reconnectConsent = new AtomicReference<>(Decision.ADMITTED);
            GuardedAudioStreamSession reconnectSession = GuardedAudioStreamSession.connect(
                    identity(), context -> reconnectConsent.get());
            reconnectSession.detach();
            reconnectConsent.set(denied);

            assertThatThrownBy(() -> reconnectSession.reconnect(1))
                    .isInstanceOf(ConsentDeniedException.class)
                    .hasMessageContaining("reconnect");
            assertThat(reconnectSession.attachment()).isEqualTo(Attachment.DETACHED);
            assertThat(reconnectSession.generation()).isZero();
        }
    }

    @Test
    @DisplayName("denied provider work is discarded and cannot replay after consent returns")
    void deniedWorkCannotReplayAfterConsentReturns() {
        AtomicReference<Decision> live = new AtomicReference<>(Decision.ADMITTED);
        GuardedAudioStreamSession dispatchSession = GuardedAudioStreamSession.connect(
                identity(), context -> live.get());
        dispatchSession.submitFrame(frame(0));
        live.set(Decision.DENIED);
        AtomicInteger providerEffects = new AtomicInteger();

        assertThatThrownBy(() -> dispatchSession.dispatchToProvider(
                frame(0), f -> providerEffects.incrementAndGet()))
                .isInstanceOf(ConsentDeniedException.class);
        live.set(Decision.ADMITTED);
        assertThatThrownBy(() -> dispatchSession.dispatchToProvider(
                frame(0), f -> providerEffects.incrementAndGet()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("not delivered");
        assertThat(providerEffects.get()).isZero();

        GuardedAudioStreamSession reconnectSession = GuardedAudioStreamSession.connect(
                identity(), context -> live.get());
        reconnectSession.submitFrame(frame(0));
        reconnectSession.detach();
        live.set(Decision.EXPIRED);
        assertThatThrownBy(() -> reconnectSession.reconnect(1))
                .isInstanceOf(ConsentDeniedException.class);
        assertThat(reconnectSession.attachment()).isEqualTo(Attachment.DETACHED);
        assertThat(reconnectSession.generation()).isZero();

        // A later grant can reconnect the session, but cannot revive the
        // frame retained before the denied reconnect.
        live.set(Decision.ADMITTED);
        reconnectSession.reconnect(1);
        assertThatThrownBy(() -> reconnectSession.dispatchToProvider(
                frame(0), f -> providerEffects.incrementAndGet()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("not delivered");
        assertThat(providerEffects.get()).isZero();
    }

    @Test
    @DisplayName("denied reconnect retains only frames still held behind a sequence gap")
    void deniedReconnectRetainsHeldFramesButDropsDeliveredCandidates() {
        AtomicReference<Decision> live = new AtomicReference<>(Decision.ADMITTED);
        GuardedAudioStreamSession session = GuardedAudioStreamSession.connect(
                identity(), context -> live.get());
        AudioStreamSession.DecodedFrame delivered = frame(0);
        AudioStreamSession.DecodedFrame held = frame(2);
        session.submitFrame(delivered);
        assertThat(session.submitFrame(held)).isEqualTo(Disposition.HELD);
        session.detach();

        live.set(Decision.DENIED);
        assertThatThrownBy(() -> session.reconnect(1))
                .isInstanceOf(ConsentDeniedException.class)
                .hasMessageContaining("reconnect");
        assertThat(session.pendingCount()).isEqualTo(1);
        assertThat(session.attachment()).isEqualTo(Attachment.DETACHED);

        live.set(Decision.ADMITTED);
        session.reconnect(1);
        assertThatThrownBy(() -> session.dispatchToProvider(
                delivered, ignored -> { }))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("not delivered");
        assertThat(session.submitFrame(frame(1))).isEqualTo(Disposition.DELIVERED);
        AudioStreamSession.DecodedFrame released = session.takeDelivered();
        assertThat(released.sequenceNumber()).isEqualTo(held.sequenceNumber());
        assertThat(released.timestampMillis()).isEqualTo(held.timestampMillis());
        assertThat(released.payload()).containsExactly(held.payload());
    }

    @Test
    @DisplayName("denied frame submit and delivery discard prior undispatched work")
    void deniedFrameTransitionsDiscardPriorWork() {
        AtomicReference<Decision> live = new AtomicReference<>(Decision.ADMITTED);
        AtomicInteger providerEffects = new AtomicInteger();

        GuardedAudioStreamSession submitSession = GuardedAudioStreamSession.connect(
                identity(), context -> live.get());
        submitSession.submitFrame(frame(0));
        live.set(Decision.DENIED);
        assertThatThrownBy(() -> submitSession.submitFrame(frame(1)))
                .isInstanceOf(ConsentDeniedException.class)
                .hasMessageContaining("frame submit");
        assertThat(submitSession.attachment()).isEqualTo(Attachment.ATTACHED);
        assertThat(submitSession.generation()).isZero();
        live.set(Decision.ADMITTED);
        assertThatThrownBy(() -> submitSession.dispatchToProvider(
                frame(0), f -> providerEffects.incrementAndGet()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("not delivered");

        GuardedAudioStreamSession deliverySession = GuardedAudioStreamSession.connect(
                identity(), context -> live.get());
        deliverySession.submitFrame(frame(0));
        deliverySession.submitFrame(frame(2));
        live.set(Decision.EXPIRED);
        assertThatThrownBy(deliverySession::takeDelivered)
                .isInstanceOf(ConsentDeniedException.class)
                .hasMessageContaining("frame delivery");
        assertThat(deliverySession.attachment()).isEqualTo(Attachment.ATTACHED);
        assertThat(deliverySession.generation()).isZero();
        assertThat(deliverySession.pendingCount()).isZero();

        live.set(Decision.ADMITTED);
        assertThatThrownBy(() -> deliverySession.dispatchToProvider(
                frame(0), f -> providerEffects.incrementAndGet()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("not delivered");
        assertThat(deliverySession.takeDelivered()).isNull();
        assertThat(providerEffects.get()).isZero();
    }

    @Test
    @DisplayName("provider dispatch requires the exact delivered frame and rejects replay")
    void dispatchRequiresDeliveredSnapshotAndRejectsReplay() {
        GuardedAudioStreamSession session = GuardedAudioStreamSession.connect(
                identity(), consent(Decision.ADMITTED));
        AtomicInteger providerEffects = new AtomicInteger();
        AudioStreamSession.DecodedFrame source = new AudioStreamSession.DecodedFrame(
                0, 0L, new byte[]{0x1});

        assertThatThrownBy(() -> session.dispatchToProvider(source,
                f -> providerEffects.incrementAndGet()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("not delivered");
        assertThat(providerEffects.get()).isZero();

        assertThat(session.submitFrame(source)).isEqualTo(Disposition.DELIVERED);
        source.payload()[0] = 0x2;
        // Accessor mutation cannot change the immutable frame that was delivered.
        session.dispatchToProvider(source, f -> providerEffects.incrementAndGet());
        assertThat(providerEffects.get()).isEqualTo(1);

        AudioStreamSession.DecodedFrame admitted = new AudioStreamSession.DecodedFrame(
                0, 0L, new byte[]{0x1});
        assertThatThrownBy(() -> session.dispatchToProvider(admitted, f -> {
            source.payload()[0] = 0x3;
            assertThat(f.payload()).containsExactly((byte) 0x1);
            providerEffects.incrementAndGet();
        }))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("already dispatched");
        assertThat(providerEffects.get()).isEqualTo(1);
        assertThatThrownBy(() -> session.dispatchToProvider(admitted,
                f -> providerEffects.incrementAndGet()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("already dispatched");
        assertThat(providerEffects.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("missing or oversized payload is rejected before the ACK advances")
    void malformedPayloadDoesNotAdvanceAck() {
        GuardedAudioStreamSession session = GuardedAudioStreamSession.connect(
                identity(), consent(Decision.ADMITTED));
        AudioStreamSession.DecodedFrame noPayload = new AudioStreamSession.DecodedFrame(
                0, 0L, null);
        AudioStreamSession.DecodedFrame oversized = new AudioStreamSession.DecodedFrame(
                0, 0L, new byte[AudioStreamSession.MAX_FRAME_PAYLOAD_BYTES + 1]);

        assertThatThrownBy(() -> session.submitFrame(noPayload))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("payload");
        assertThatThrownBy(() -> session.submitFrame(oversized))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("payload");
        assertThat(session.nextAck()).isEqualTo(-1);
        assertThat(session.submitFrame(frame(0))).isEqualTo(Disposition.DELIVERED);
    }

    @Test
    @DisplayName("held audio payload is snapshotted and bounded dispatch applies backpressure")
    void heldPayloadSnapshotAndDispatchCapacity() {
        GuardedAudioStreamSession session = GuardedAudioStreamSession.connect(
                identity(), consent(Decision.ADMITTED));
        assertThat(session.submitFrame(frame(0))).isEqualTo(Disposition.DELIVERED);
        AudioStreamSession.DecodedFrame held = new AudioStreamSession.DecodedFrame(
                2, 40L, new byte[]{0x4});
        assertThat(session.submitFrame(held)).isEqualTo(Disposition.HELD);
        held.payload()[0] = 0x7;
        assertThat(session.submitFrame(frame(1))).isEqualTo(Disposition.DELIVERED);
        AudioStreamSession.DecodedFrame released = session.takeDelivered();
        assertThat(released.sequenceNumber()).isEqualTo(2);
        assertThat(released.payload()).containsExactly((byte) 0x4);
        session.dispatchToProvider(released, f -> { });

        GuardedAudioStreamSession saturated = GuardedAudioStreamSession.connect(
                identity(), consent(Decision.ADMITTED));
        for (int seq = 0; seq < 256; seq++) {
            assertThat(saturated.submitFrame(frame(seq))).isEqualTo(Disposition.DELIVERED);
        }
        assertThat(saturated.submitFrame(frame(0))).isEqualTo(Disposition.DUPLICATE);
        assertThat(saturated.submitFrame(frame(258))).isEqualTo(Disposition.HELD);
        assertThat(saturated.submitFrame(frame(256))).isEqualTo(Disposition.OVERFLOW);
        assertThat(saturated.nextAck()).isEqualTo(255);
        saturated.dispatchToProvider(frame(0), f -> { });
        assertThat(saturated.submitFrame(frame(256))).isEqualTo(Disposition.DELIVERED);
        assertThat(saturated.nextAck()).isEqualTo(256);
        assertThat(saturated.submitFrame(frame(257))).isEqualTo(Disposition.OVERFLOW);
        saturated.dispatchToProvider(frame(1), f -> { });
        assertThat(saturated.submitFrame(frame(257))).isEqualTo(Disposition.DELIVERED);
        assertThatThrownBy(saturated::takeDelivered)
                .isInstanceOf(GuardedAudioStreamSession.ProviderDispatchCapacityException.class);
        assertThat(saturated.pendingCount()).isEqualTo(1);
        saturated.dispatchToProvider(frame(2), f -> { });
        assertThat(saturated.takeDelivered().sequenceNumber()).isEqualTo(258);
        assertThat(saturated.nextAck()).isEqualTo(258);
    }

    @Test
    @DisplayName("detach is resumable and distinct from terminal server cancel")
    void detachVsCancel() {
        GuardedAudioStreamSession session =
                GuardedAudioStreamSession.connect(identity(), consent(Decision.ADMITTED));
        session.submitFrame(frame(0));
        session.detach();
        assertThat(session.attachment()).isEqualTo(Attachment.DETACHED);
        // No frames while detached — but the session survives.
        assertThatThrownBy(() -> session.submitFrame(frame(1)))
                .isInstanceOf(IllegalStateException.class);
        session.reconnect(1);
        assertThat(session.attachment()).isEqualTo(Attachment.ATTACHED);
        assertThat(session.submitFrame(frame(1))).isEqualTo(Disposition.DELIVERED);
        assertThat(session.submitFrame(frame(3))).isEqualTo(Disposition.HELD);
        assertThat(session.pendingCount()).isEqualTo(1);

        session.cancel();
        assertThat(session.attachment()).isEqualTo(Attachment.CANCELLED);
        assertThat(session.pendingCount()).isZero();
        AtomicInteger providerEffects = new AtomicInteger();
        assertThatThrownBy(() -> session.dispatchToProvider(frame(1),
                f -> providerEffects.incrementAndGet()))
                .isInstanceOf(IllegalStateException.class);
        assertThat(providerEffects.get()).isZero();
        assertThatThrownBy(() -> session.reconnect(2))
                .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> session.submitFrame(frame(2)))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    @DisplayName("stale-generation reconnect is denied and produces no provider effect")
    void staleGenerationReconnectDenied() {
        AtomicReference<Decision> live = new AtomicReference<>(Decision.ADMITTED);
        GuardedAudioStreamSession session =
                GuardedAudioStreamSession.connect(identity(), context -> live.get());
        session.submitFrame(frame(0));
        session.detach();
        session.reconnect(1);
        session.detach();

        // Replaying generation 1 (or anything older) is stale — denied.
        assertThatThrownBy(() -> session.reconnect(1))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("stale session generation");
        assertThatThrownBy(() -> session.reconnect(0))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(session.attachment()).isEqualTo(Attachment.DETACHED);
        assertThat(session.generation()).isEqualTo(1);
    }

    @Test
    @DisplayName("unauthorized reconnect — consent revoked while detached — stays detached")
    void unauthorizedReconnect() {
        AtomicReference<Decision> live = new AtomicReference<>(Decision.ADMITTED);
        GuardedAudioStreamSession session =
                GuardedAudioStreamSession.connect(identity(), context -> live.get());
        session.detach();

        live.set(Decision.DENIED);
        assertThatThrownBy(() -> session.reconnect(1))
                .isInstanceOf(ConsentDeniedException.class)
                .hasMessageContaining("reconnect");
        assertThat(session.attachment()).isEqualTo(Attachment.DETACHED);
        assertThat(session.generation()).isZero();
    }

    @Test
    @DisplayName("consent is evaluated per transition, not cached at connect")
    void consentReevaluatedPerTransition() {
        AtomicInteger evaluations = new AtomicInteger();
        StreamConsentGate.Source counting = context -> {
            evaluations.incrementAndGet();
            return Decision.ADMITTED;
        };
        GuardedAudioStreamSession session =
                GuardedAudioStreamSession.connect(identity(), counting);
        session.submitFrame(frame(0));
        session.dispatchToProvider(frame(0), f -> { });
        session.detach();
        session.reconnect(1);
        // connect + submit + dispatch + reconnect each re-authorized.
        assertThat(evaluations.get()).isEqualTo(4);
    }

    @Test
    @DisplayName("a consent source with no admitted record fails every transition closed")
    void unavailableSourceFailsClosed() {
        assertThatThrownBy(() -> GuardedAudioStreamSession.connect(
                identity(), StreamConsentGate.Source.unavailable()))
                .isInstanceOf(ConsentDeniedException.class);
    }
}
