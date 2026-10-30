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

        session.cancel();
        assertThat(session.attachment()).isEqualTo(Attachment.CANCELLED);
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
