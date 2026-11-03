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
        assertThatThrownBy(() -> session.cancel("worker-a", 1L))
                .isInstanceOf(StaleLeaseException.class)
                .hasMessageContaining("cancel");
        assertThat(session.cancelled()).isFalse();
        AtomicInteger egressEffects = new AtomicInteger();
        assertThatThrownBy(() -> session.egress("worker-a", 1L, frame(0, true),
                f -> egressEffects.incrementAndGet()))
                .isInstanceOf(StaleLeaseException.class);
        assertThatThrownBy(() -> session.egress("worker-a", 1L,
                new VideoStreamSession.DecodedFrame(0, true, 0L, null),
                f -> egressEffects.incrementAndGet()))
                .isInstanceOf(StaleLeaseException.class);
        assertThat(egressEffects.get()).isZero();
        assertThat(session.nextAck("worker-b", 2L)).isEqualTo(0);
    }

    @Test
    @DisplayName("stale lease cannot drain a held frame after its gap closes")
    void staleLeaseCannotDrainPendingFrame() {
        GuardedVideoStreamSession session = GuardedVideoStreamSession.open(
                identity("t1"), consent(ConsentDecision.ADMITTED), "worker-a");
        assertThat(session.submitFrame("worker-a", 1L, frame(0, true)))
                .isEqualTo(FrameVerdict.DELIVERED_DECODABLE);
        assertThat(session.submitFrame("worker-a", 1L, frame(2, false)))
                .isEqualTo(FrameVerdict.HELD);
        assertThat(session.submitFrame("worker-a", 1L, frame(1, false)))
                .isEqualTo(FrameVerdict.DELIVERED_DECODABLE);
        assertThat(session.pendingCount()).isEqualTo(1);
        assertThat(session.nextAck("worker-a", 1L)).isEqualTo(1);

        session.claim("worker-b", 2L);
        assertThatThrownBy(() -> session.takeDelivered("worker-a", 1L))
                .isInstanceOf(StaleLeaseException.class)
                .hasMessageContaining("frame delivery");
        assertThat(session.pendingCount()).isEqualTo(1);
        assertThat(session.nextAck("worker-b", 2L)).isEqualTo(1);

        assertThat(session.takeDelivered("worker-b", 2L).sequenceNumber()).isEqualTo(2);
        assertThat(session.nextAck("worker-b", 2L)).isEqualTo(2);
        assertThat(session.pendingCount()).isZero();
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
        VideoStreamSession.DecodedFrame held = new VideoStreamSession.DecodedFrame(
                2, false, 66L, new byte[]{0x4});
        assertThat(session.submitFrame("worker-a", 1L, held))
                .isEqualTo(FrameVerdict.HELD);
        held.payload()[0] = 0x7;
        assertThat(session.nextAck("worker-a", 1L)).isEqualTo(0);
        assertThat(session.submitFrame("worker-a", 1L, frame(1, false)))
                .isEqualTo(FrameVerdict.DELIVERED_DECODABLE);
        var released = session.takeDelivered("worker-a", 1L);
        assertThat(released.sequenceNumber()).isEqualTo(2);
        assertThat(released.payload()).containsExactly(0x4);
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
        VideoStreamSession.DecodedFrame invalidPayload = new VideoStreamSession.DecodedFrame(
                0, true, 0L, null);
        assertThatThrownBy(() -> session.egress("worker-a", 1L, invalidPayload,
                f -> egressEffects.incrementAndGet()))
                .isInstanceOf(ConsentDeniedException.class)
                .hasMessageContaining("provider egress");
        assertThat(egressEffects.get()).isZero();
    }

    @Test
    @DisplayName("consent is reauthorized after open before any frame state changes")
    void postOpenConsentBlocksFrameSubmission() {
        for (ConsentDecision decision : new ConsentDecision[]{
                ConsentDecision.DENIED,
                ConsentDecision.EXPIRED,
                ConsentDecision.NOT_ADMITTED}) {
            AtomicReference<ConsentDecision> live = new AtomicReference<>(ConsentDecision.ADMITTED);
            AtomicReference<GuardedVideoStreamSession.ConsentContext> lastContext = new AtomicReference<>();
            GuardedVideoStreamSession session = GuardedVideoStreamSession.open(
                    identity("t1"), context -> {
                        lastContext.set(context);
                        return live.get();
                    }, "worker-a");
            session.claim("worker-b", 2L);
            live.set(decision);

            assertThatThrownBy(() -> session.submitFrame("worker-b", 2L, frame(0, true)))
                    .isInstanceOf(ConsentDeniedException.class)
                    .hasMessageContaining(decision.name());
            assertThat(lastContext.get()).isEqualTo(new GuardedVideoStreamSession.ConsentContext(
                    "t1", "principal-1", "purpose-1", 2L));
            assertThat(session.nextAck("worker-b", 2L)).isEqualTo(-1);
            assertThat(session.pendingCount()).isZero();
        }
    }

    @Test
    @DisplayName("revoked consent prevents draining an already-held frame")
    void revokedConsentPreservesHeldFrameDuringDrain() {
        AtomicReference<ConsentDecision> live = new AtomicReference<>(ConsentDecision.ADMITTED);
        GuardedVideoStreamSession session = GuardedVideoStreamSession.open(
                identity("t1"), context -> live.get(), "worker-a");
        session.submitFrame("worker-a", 1L, frame(0, true));
        assertThat(session.submitFrame("worker-a", 1L, frame(2, false)))
                .isEqualTo(FrameVerdict.HELD);
        session.submitFrame("worker-a", 1L, frame(1, false));
        assertThat(session.pendingCount()).isEqualTo(1);
        assertThat(session.nextAck("worker-a", 1L)).isEqualTo(1);

        live.set(ConsentDecision.DENIED);
        assertThatThrownBy(() -> session.takeDelivered("worker-a", 1L))
                .isInstanceOf(ConsentDeniedException.class)
                .hasMessageContaining("frame delivery");
        assertThat(session.pendingCount()).isEqualTo(1);
        assertThat(session.nextAck("worker-a", 1L)).isEqualTo(1);
    }

    @Test
    @DisplayName("provider egress requires the exact delivered decodable frame and is single-attempt")
    void egressRequiresDeliveredFrameAndRejectsMutationAndReplay() {
        GuardedVideoStreamSession session = GuardedVideoStreamSession.open(
                identity("t1"), consent(ConsentDecision.ADMITTED), "worker-a");
        AtomicInteger egressEffects = new AtomicInteger();
        VideoStreamSession.DecodedFrame admitted = frame(0, true);

        assertThatThrownBy(() -> session.egress("worker-a", 1L, admitted,
                f -> egressEffects.incrementAndGet()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("not delivered");
        assertThat(egressEffects.get()).isZero();

        assertThat(session.submitFrame("worker-a", 1L, admitted))
                .isEqualTo(FrameVerdict.DELIVERED_DECODABLE);
        VideoStreamSession.DecodedFrame forged = new VideoStreamSession.DecodedFrame(
                0, true, admitted.timestampMillis(), new byte[]{0x7});
        assertThatThrownBy(() -> session.egress("worker-a", 1L, forged,
                f -> egressEffects.incrementAndGet()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("not delivered");
        assertThat(egressEffects.get()).isZero();

        session.egress("worker-a", 1L, admitted, f -> {
            admitted.payload()[0] = 0x8;
            assertThat(f.payload()).containsExactly(0x2);
            egressEffects.incrementAndGet();
        });
        assertThat(egressEffects.get()).isEqualTo(1);
        assertThatThrownBy(() -> session.egress("worker-a", 1L, admitted,
                f -> egressEffects.incrementAndGet()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("already egressed");
        assertThat(egressEffects.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("full egress retention applies backpressure without dropping accepted frames")
    void egressCapacityBackpressuresWithoutEviction() {
        GuardedVideoStreamSession session = GuardedVideoStreamSession.open(
                identity("t1"), consent(ConsentDecision.ADMITTED), "worker-a");
        for (int seq = 0; seq < 256; seq++) {
            assertThat(session.submitFrame("worker-a", 1L, frame(seq, seq == 0)))
                    .isEqualTo(FrameVerdict.DELIVERED_DECODABLE);
        }

        assertThat(session.submitFrame("worker-a", 1L, frame(0, true)))
                .isEqualTo(FrameVerdict.DUPLICATE);
        assertThat(session.submitFrame("worker-a", 1L, frame(257, false)))
                .isEqualTo(FrameVerdict.HELD);
        assertThat(session.submitFrame("worker-a", 1L, frame(256, false)))
                .isEqualTo(FrameVerdict.OVERFLOW);
        assertThat(session.nextAck("worker-a", 1L)).isEqualTo(255);
        assertThat(session.pendingCount()).isEqualTo(1);

        session.egress("worker-a", 1L, frame(0, true), f -> { });
        assertThat(session.submitFrame("worker-a", 1L, frame(256, false)))
                .isEqualTo(FrameVerdict.DELIVERED_DECODABLE);
        assertThat(session.nextAck("worker-a", 1L)).isEqualTo(256);
        assertThatThrownBy(() -> session.takeDelivered("worker-a", 1L))
                .isInstanceOf(GuardedVideoStreamSession.EgressCapacityException.class);
        assertThat(session.pendingCount()).isEqualTo(1);

        session.egress("worker-a", 1L, frame(1, false), f -> { });
        VideoStreamSession.DecodedFrame released = session.takeDelivered("worker-a", 1L);
        assertThat(released.sequenceNumber()).isEqualTo(257);
        assertThat(session.nextAck("worker-a", 1L)).isEqualTo(257);
        assertThat(session.pendingCount()).isZero();
    }

    @Test
    @DisplayName("malformed frame payload is rejected before the ACK cursor advances")
    void malformedFrameDoesNotAdvanceStream() {
        GuardedVideoStreamSession session = GuardedVideoStreamSession.open(
                identity("t1"), consent(ConsentDecision.ADMITTED), "worker-a");
        VideoStreamSession.DecodedFrame missingPayload = new VideoStreamSession.DecodedFrame(
                0, true, 0L, null);

        assertThatThrownBy(() -> session.submitFrame("worker-a", 1L, missingPayload))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("payload");
        assertThat(session.nextAck("worker-a", 1L)).isEqualTo(-1);
        assertThat(session.submitFrame("worker-a", 1L, frame(0, true)))
                .isEqualTo(FrameVerdict.DELIVERED_DECODABLE);
    }

    @Test
    @DisplayName("sink failure leaves egress outcome unknown and the frame is not blindly retried")
    void sinkFailureDoesNotPermitBlindEgressRetry() {
        GuardedVideoStreamSession session = GuardedVideoStreamSession.open(
                identity("t1"), consent(ConsentDecision.ADMITTED), "worker-a");
        VideoStreamSession.DecodedFrame admitted = frame(0, true);
        session.submitFrame("worker-a", 1L, admitted);
        AtomicInteger attempts = new AtomicInteger();

        assertThatThrownBy(() -> session.egress("worker-a", 1L, admitted, f -> {
            attempts.incrementAndGet();
            throw new IllegalStateException("provider outcome unknown");
        })).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("outcome unknown");
        assertThatThrownBy(() -> session.egress("worker-a", 1L, admitted,
                f -> attempts.incrementAndGet()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("already egressed");
        assertThat(attempts.get()).isEqualTo(1);
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
    @DisplayName("resume preserves pending egress candidates only at the matching durable ACK")
    void resumePreservesEgressCandidatesAtMatchingAck() {
        SessionIdentity durable = identity("t1");
        GuardedVideoStreamSession session = GuardedVideoStreamSession.open(
                durable, consent(ConsentDecision.ADMITTED), "worker-a");
        VideoStreamSession.DecodedFrame admitted = frame(0, true);
        session.submitFrame("worker-a", 1L, admitted);
        session.detach("worker-a", 1L);

        assertThatThrownBy(() -> session.resume(
                "worker-a", 1L, durable, -1, -1, Long.MIN_VALUE))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("ACK must match");
        assertThat(session.detached()).isTrue();
        assertThat(session.nextAck("worker-a", 1L)).isZero();

        session.resume("worker-a", 1L, durable, 0, 0, 0L);
        AtomicInteger effects = new AtomicInteger();
        session.egress("worker-a", 1L, admitted, f -> effects.incrementAndGet());
        assertThat(effects.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("denied resume preserves detached state and candidates; resumed egress rechecks consent")
    void deniedResumePreservesStateAndEgressRechecksConsent() {
        SessionIdentity durable = identity("t1");
        AtomicReference<ConsentDecision> live = new AtomicReference<>(ConsentDecision.ADMITTED);
        GuardedVideoStreamSession session = GuardedVideoStreamSession.open(
                durable, context -> live.get(), "worker-a");
        VideoStreamSession.DecodedFrame admitted = frame(0, true);
        session.submitFrame("worker-a", 1L, admitted);
        session.detach("worker-a", 1L);
        live.set(ConsentDecision.NOT_ADMITTED);

        assertThatThrownBy(() -> session.resume("worker-a", 1L, durable, 0, 0, 0L))
                .isInstanceOf(ConsentDeniedException.class)
                .hasMessageContaining("resume");
        assertThat(session.detached()).isTrue();
        assertThat(session.nextAck("worker-a", 1L)).isZero();

        live.set(ConsentDecision.ADMITTED);
        session.resume("worker-a", 1L, durable, 0, 0, 0L);
        assertThat(session.detached()).isFalse();
        live.set(ConsentDecision.EXPIRED);
        AtomicInteger effects = new AtomicInteger();
        assertThatThrownBy(() -> session.egress("worker-a", 1L, admitted,
                f -> effects.incrementAndGet()))
                .isInstanceOf(ConsentDeniedException.class)
                .hasMessageContaining("provider egress");
        assertThat(effects.get()).isZero();

        live.set(ConsentDecision.ADMITTED);
        session.egress("worker-a", 1L, admitted, f -> effects.incrementAndGet());
        assertThat(effects.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("unavailable consent source fails closed before frame admission")
    void consentUnavailableFailsClosed() {
        GuardedVideoStreamSession session = GuardedVideoStreamSession.open(
                identity("t1"), GuardedVideoStreamSession.ConsentSource.unavailable(), "worker-a");
        assertThatThrownBy(() -> session.submitFrame("worker-a", 1L, frame(0, true)))
                .isInstanceOf(ConsentDeniedException.class)
                .hasMessageContaining("NOT_ADMITTED");
        assertThat(session.nextAck("worker-a", 1L)).isEqualTo(-1);
        assertThat(session.pendingCount()).isZero();
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

    @Test
    @DisplayName("server cancellation is terminal and prevents every later stream effect")
    void cancellationIsTerminal() {
        GuardedVideoStreamSession session = GuardedVideoStreamSession.open(
                identity("t1"), consent(ConsentDecision.ADMITTED), "worker-a");
        assertThat(session.submitFrame("worker-a", 1L, frame(0, true)))
                .isEqualTo(FrameVerdict.DELIVERED_DECODABLE);
        assertThat(session.submitFrame("worker-a", 1L, frame(2, false)))
                .isEqualTo(FrameVerdict.HELD);
        assertThat(session.pendingCount()).isEqualTo(1);

        session.cancel("worker-a", 1L);
        assertThat(session.cancelled()).isTrue();
        assertThat(session.pendingCount()).isZero();
        AtomicInteger egressEffects = new AtomicInteger();
        assertThatThrownBy(() -> session.submitFrame("worker-a", 1L, frame(1, false)))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("cancellation");
        assertThatThrownBy(() -> session.egress("worker-a", 1L, frame(0, true),
                f -> egressEffects.incrementAndGet()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("cancellation");
        assertThatThrownBy(() -> session.claim("worker-b", 2L))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("cancellation");
        assertThatThrownBy(() -> session.resume(
                "worker-a", 1L, identity("t1"), 0, 0, 0L))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("cancellation");
        assertThat(egressEffects.get()).isZero();
    }
}
