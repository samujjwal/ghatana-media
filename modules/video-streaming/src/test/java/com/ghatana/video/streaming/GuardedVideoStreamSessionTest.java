package com.ghatana.video.streaming;

import com.ghatana.video.streaming.GuardedVideoStreamSession.ConsentDecision;
import com.ghatana.video.streaming.GuardedVideoStreamSession.ConsentDeniedException;
import com.ghatana.video.streaming.GuardedVideoStreamSession.FrameVerdict;
import com.ghatana.video.streaming.GuardedVideoStreamSession.StaleLeaseException;
import com.ghatana.video.streaming.VideoFrameReconciler.SessionIdentity;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * VS-04: lease fencing between workers, tenant-scoped claims, honest gap vs
 * false success on missing keyframes, consent-guarded egress and resumable
 * reconnect preserving frame/keyframe/PTS position.
 */
@DisplayName("GuardedVideoStreamSession")
class GuardedVideoStreamSessionTest {

    private static SessionIdentity identity(String tenant) {
        return new SessionIdentity("stream-1", tenant, "principal-1", "purpose-1", 1);
    }

    private static VideoStreamSession.DecodedFrame frame(int seq, boolean key) {
        return new VideoStreamSession.DecodedFrame(seq, key, seq * 33L, new byte[]{0x2});
    }

    private static GuardedVideoStreamSession.ConsentSource consent(ConsentDecision decision) {
        return context -> decision;
    }

    @Test
    @DisplayName("two workers: takeover fences the stale lease holder out of submit, ack and egress")
    void staleLeaseWorkerFenced() {
        GuardedVideoStreamSession session = GuardedVideoStreamSession.open(
                identity("t1"), consent(ConsentDecision.ADMITTED), "worker-a");
        assertThat(session.submitFrame("worker-a", 1L, frame(0, true)))
                .isEqualTo(FrameVerdict.DELIVERED_DECODABLE);

        session.claim("worker-b", 2L);
        assertThat(session.leaseHolder()).isEqualTo("worker-b");

        // Stale worker + stale token: every transition is denied.
        assertThatThrownBy(() -> session.submitFrame("worker-a", 1L, frame(1, false)))
                .isInstanceOf(StaleLeaseException.class);
        assertThatThrownBy(() -> session.nextAck("worker-a", 1L))
                .isInstanceOf(StaleLeaseException.class);
        AtomicInteger egressEffects = new AtomicInteger();
        assertThatThrownBy(() -> session.egress("worker-a", 1L, frame(0, true),
                f -> egressEffects.incrementAndGet()))
                .isInstanceOf(StaleLeaseException.class);
        assertThat(egressEffects.get()).isZero();
        assertThat(session.nextAck("worker-b", 2L)).isEqualTo(0);
    }

    @Test
    @DisplayName("a claim replayed at an equal-or-older token is stale, never a takeover")
    void claimMonotonicFencing() {
        GuardedVideoStreamSession session = GuardedVideoStreamSession.open(
                identity("t1"), consent(ConsentDecision.ADMITTED), "worker-a");
        assertThatThrownBy(() -> session.claim("worker-b", 1L))
                .isInstanceOf(StaleLeaseException.class);
        session.claim("worker-b", 2L);
        assertThatThrownBy(() -> session.claim("worker-c", 2L))
                .isInstanceOf(StaleLeaseException.class);
        assertThat(session.leaseHolder()).isEqualTo("worker-b");
    }

    @Test
    @DisplayName("a missing GOP keyframe yields an undecodable gap, never a false success")
    void missingKeyframeIsGapNotSuccess() {
        GuardedVideoStreamSession session = GuardedVideoStreamSession.open(
                identity("t1"), consent(ConsentDecision.ADMITTED), "worker-a");
        // A contiguous non-keyframe with no prior keyframe: delivered but not decodable.
        assertThat(session.submitFrame("worker-a", 1L, frame(0, false)))
                .isEqualTo(FrameVerdict.DELIVERED_UNDECODABLE);
        // After the keyframe anchors the GOP, dependent frames decode.
        assertThat(session.submitFrame("worker-a", 1L, frame(1, true)))
                .isEqualTo(FrameVerdict.DELIVERED_DECODABLE);
        assertThat(session.submitFrame("worker-a", 1L, frame(2, false)))
                .isEqualTo(FrameVerdict.DELIVERED_DECODABLE);
    }

    @Test
    @DisplayName("out-of-order frames hold across a gap and deliver honestly")
    void outOfOrderGapHonest() {
        GuardedVideoStreamSession session = GuardedVideoStreamSession.open(
                identity("t1"), consent(ConsentDecision.ADMITTED), "worker-a");
        assertThat(session.submitFrame("worker-a", 1L, frame(0, true)))
                .isEqualTo(FrameVerdict.DELIVERED_DECODABLE);
        assertThat(session.submitFrame("worker-a", 1L, frame(2, false)))
                .isEqualTo(FrameVerdict.HELD);
        assertThat(session.nextAck("worker-a", 1L)).isEqualTo(0);
        assertThat(session.submitFrame("worker-a", 1L, frame(1, false)))
                .isEqualTo(FrameVerdict.DELIVERED_DECODABLE);
        var released = session.takeDelivered("worker-a", 1L);
        assertThat(released.sequenceNumber()).isEqualTo(2);
        // Frame 2's GOP keyframe (seq 0) predates it — decodable.
        assertThat(session.verdictOfDelivered("worker-a", 1L, released))
                .isEqualTo(FrameVerdict.DELIVERED_DECODABLE);
        assertThat(session.nextAck("worker-a", 1L)).isEqualTo(2);
    }

    @Test
    @DisplayName("revoked consent forbids egress even when frames were admitted earlier")
    void revokedConsentBlocksEgress() {
        AtomicReference<ConsentDecision> live = new AtomicReference<>(ConsentDecision.ADMITTED);
        GuardedVideoStreamSession session = GuardedVideoStreamSession.open(
                identity("t1"), context -> live.get(), "worker-a");
        session.submitFrame("worker-a", 1L, frame(0, true));

        live.set(ConsentDecision.DENIED);
        AtomicInteger egressEffects = new AtomicInteger();
        assertThatThrownBy(() -> session.egress("worker-a", 1L, frame(0, true),
                f -> egressEffects.incrementAndGet()))
                .isInstanceOf(ConsentDeniedException.class);
        assertThat(egressEffects.get()).isZero();
    }

    @Test
    @DisplayName("reconnect resumes durable ack/keyframe/PTS; cross-tenant resume is denied")
    void resumableReconnectPreservesPosition() {
        SessionIdentity durable = identity("t1");
        GuardedVideoStreamSession session = GuardedVideoStreamSession.open(
                durable, consent(ConsentDecision.ADMITTED), "worker-a");
        session.submitFrame("worker-a", 1L, frame(0, true));
        session.submitFrame("worker-a", 1L, frame(1, false));
        session.detach("worker-a", 1L);

        // Cross-tenant durable identity is denied — never merged.
        assertThatThrownBy(() -> session.resume("worker-a", 1L,
                identity("t2"), 1, 0, 33L))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("cross-tenant");

        session.resume("worker-a", 1L, durable, 1, 0, 33L);
        assertThat(session.detached()).isFalse();
        // Durable position preserved: frames 0-1 are duplicates, next is 2.
        assertThat(session.submitFrame("worker-a", 1L, frame(1, false)))
                .isEqualTo(FrameVerdict.DUPLICATE);
        assertThat(session.submitFrame("worker-a", 1L, frame(2, false)))
                .isEqualTo(FrameVerdict.DELIVERED_DECODABLE);
        assertThat(session.nextAck("worker-a", 1L)).isEqualTo(2);
    }

    @Test
    @DisplayName("denied tenant consent source fails closed on first egress")
    void consentUnavailableFailsClosed() {
        GuardedVideoStreamSession session = GuardedVideoStreamSession.open(
                identity("t1"), GuardedVideoStreamSession.ConsentSource.unavailable(), "worker-a");
        session.submitFrame("worker-a", 1L, frame(0, true));
        AtomicInteger egressEffects = new AtomicInteger();
        assertThatThrownBy(() -> session.egress("worker-a", 1L, frame(0, true),
                f -> egressEffects.incrementAndGet()))
                .isInstanceOf(ConsentDeniedException.class);
        assertThat(egressEffects.get()).isZero();
    }

    @Test
    @DisplayName("disconnect forbids submits until resume — no silent accept while detached")
    void detachBlocksSubmits() {
        GuardedVideoStreamSession session = GuardedVideoStreamSession.open(
                identity("t1"), consent(ConsentDecision.ADMITTED), "worker-a");
        session.detach("worker-a", 1L);
        assertThatThrownBy(() -> session.submitFrame("worker-a", 1L, frame(0, true)))
                .isInstanceOf(IllegalStateException.class);
        session.resume("worker-a", 1L, identity("t1"), -1, -1, Long.MIN_VALUE);
        assertThat(session.submitFrame("worker-a", 1L, frame(0, true)))
                .isEqualTo(FrameVerdict.DELIVERED_DECODABLE);
    }
}
