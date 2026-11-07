package com.ghatana.audio.video.integration;

import com.ghatana.audio.streaming.AudioStreamSession;
import com.ghatana.audio.streaming.GuardedAudioStreamSession;
import com.ghatana.audio.streaming.StreamConsentGate;
import com.ghatana.audio.streaming.StreamFrameReconciler;
import com.ghatana.video.streaming.GuardedVideoStreamSession;
import com.ghatana.video.streaming.VideoFrameReconciler;
import com.ghatana.video.streaming.VideoStreamSession;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Fixture-only cross-modality exercise of the two existing in-memory guarded
 * session state machines. It does not establish consent authority, persistence,
 * provider behavior, or durable resume evidence.
 */
@DisplayName("Guarded cross-modality stream state machine")
class GuardedCrossModalityStreamStateMachineTest {

    private static final String TENANT = "fixture-tenant";
    private static final String PRINCIPAL = "fixture-principal";
    private static final String PURPOSE = "fixture-purpose";

    @Test
    @DisplayName("revoked consent blocks reconnect and resume after detach and video lease transfer")
    void revokedConsentBlocksReconnectAndResumeAcrossModalities() {
        AtomicReference<StreamConsentGate.Decision> audioConsent =
                new AtomicReference<>(StreamConsentGate.Decision.ADMITTED);
        AtomicReference<GuardedVideoStreamSession.ConsentDecision> videoConsent =
                new AtomicReference<>(GuardedVideoStreamSession.ConsentDecision.ADMITTED);

        StreamFrameReconciler.SessionIdentity audioIdentity =
                new StreamFrameReconciler.SessionIdentity(
                        "fixture-audio", TENANT, PRINCIPAL, PURPOSE, 1L);
        VideoFrameReconciler.SessionIdentity videoIdentity =
                new VideoFrameReconciler.SessionIdentity(
                        "fixture-video", TENANT, PRINCIPAL, PURPOSE, 1L);
        GuardedAudioStreamSession audio = GuardedAudioStreamSession.connect(
                audioIdentity, context -> audioConsent.get());
        GuardedVideoStreamSession video = GuardedVideoStreamSession.open(
                videoIdentity, context -> videoConsent.get(), "worker-a");

        AudioStreamSession.DecodedFrame audioFrame =
                new AudioStreamSession.DecodedFrame(0, 0L, new byte[]{0x11, 0x22});
        AudioStreamSession.DecodedFrame heldAudioFrame =
                new AudioStreamSession.DecodedFrame(2, 40L, new byte[]{0x23, 0x24});
        VideoStreamSession.DecodedFrame videoFrame =
                new VideoStreamSession.DecodedFrame(0, true, 0L, new byte[]{0x33, 0x44});
        VideoStreamSession.DecodedFrame heldVideoFrame =
                new VideoStreamSession.DecodedFrame(2, false, 66L, new byte[]{0x45, 0x46});
        List<Integer> audioDelivered = new ArrayList<>();
        List<Integer> videoDelivered = new ArrayList<>();
        AtomicInteger providerEffects = new AtomicInteger();

        assertThat(audio.submitFrame(audioFrame))
                .isEqualTo(StreamFrameReconciler.Disposition.DELIVERED);
        audioDelivered.add(audioFrame.sequenceNumber());
        assertThat(video.submitFrame("worker-a", 1L, videoFrame))
                .isEqualTo(GuardedVideoStreamSession.FrameVerdict.DELIVERED_DECODABLE);
        videoDelivered.add(videoFrame.sequenceNumber());
        assertThat(audio.submitFrame(heldAudioFrame))
                .isEqualTo(StreamFrameReconciler.Disposition.HELD);
        assertThat(video.submitFrame("worker-a", 1L, heldVideoFrame))
                .isEqualTo(GuardedVideoStreamSession.FrameVerdict.HELD);
        assertThat(audio.nextAck()).isZero();
        assertThat(video.nextAck("worker-a", 1L)).isZero();
        assertThat(audio.pendingCount()).isEqualTo(1);
        assertThat(video.pendingCount()).isEqualTo(1);

        audio.detach();
        video.detach("worker-a", 1L);
        audioConsent.set(StreamConsentGate.Decision.DENIED);
        videoConsent.set(GuardedVideoStreamSession.ConsentDecision.EXPIRED);
        video.claim("worker-b", 2L);

        assertThatThrownBy(() -> audio.reconnect(1L))
                .isInstanceOf(GuardedAudioStreamSession.ConsentDeniedException.class)
                .hasMessageContaining("reconnect");
        // These arguments mirror only this fixture's observed in-memory position;
        // no durable record or external resume authority is represented.
        assertThatThrownBy(() -> video.resume(
                "worker-b", 2L, videoIdentity, 0, 0, 0L))
                .isInstanceOf(GuardedVideoStreamSession.ConsentDeniedException.class)
                .hasMessageContaining("resume");
        assertThatThrownBy(audio::takeDelivered)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("DETACHED");
        assertThatThrownBy(() -> video.takeDelivered("worker-b", 2L))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("attached");

        assertThat(audio.attachment()).isEqualTo(GuardedAudioStreamSession.Attachment.DETACHED);
        assertThat(audio.generation()).isZero();
        assertThat(audio.nextAck()).isZero();
        // Denied audio reconnect discards its gap-held frame; video resume denial preserves its in-memory frame.
        assertThat(audio.pendingCount()).isZero();
        assertThat(video.detached()).isTrue();
        assertThat(video.claimToken()).isEqualTo(2L);
        assertThat(video.leaseHolder()).isEqualTo("worker-b");
        assertThat(video.nextAck("worker-b", 2L)).isZero();
        assertThat(video.pendingCount()).isEqualTo(1);

        assertThatThrownBy(() -> audio.submitFrame(
                new AudioStreamSession.DecodedFrame(1, 20L, new byte[]{0x55})))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("DETACHED");
        assertThatThrownBy(() -> video.submitFrame("worker-b", 2L,
                new VideoStreamSession.DecodedFrame(1, false, 33L, new byte[]{0x66})))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("attached");
        assertThatThrownBy(() -> audio.dispatchToProvider(
                audioFrame, frame -> providerEffects.incrementAndGet()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("DETACHED");
        assertThatThrownBy(() -> video.egress("worker-b", 2L, videoFrame,
                frame -> providerEffects.incrementAndGet()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("attached");

        assertThatThrownBy(() -> video.submitFrame("worker-a", 1L,
                new VideoStreamSession.DecodedFrame(1, false, 33L, new byte[]{0x77})))
                .isInstanceOf(GuardedVideoStreamSession.StaleLeaseException.class);
        assertThatThrownBy(() -> video.egress("worker-a", 1L, videoFrame,
                frame -> providerEffects.incrementAndGet()))
                .isInstanceOf(GuardedVideoStreamSession.StaleLeaseException.class);
        assertThatThrownBy(() -> video.nextAck("worker-a", 1L))
                .isInstanceOf(GuardedVideoStreamSession.StaleLeaseException.class);
        assertThatThrownBy(() -> video.takeDelivered("worker-a", 1L))
                .isInstanceOf(GuardedVideoStreamSession.StaleLeaseException.class);

        // Denied audio reconnect discarded its held frame. Neither denied video
        // resume nor stale-worker replay delivered another frame or reached a sink.
        assertThat(audioDelivered).containsExactly(0);
        assertThat(videoDelivered).containsExactly(0);
        assertThat(providerEffects).hasValue(0);
        assertThat(audio.nextAck()).isZero();
        assertThat(audio.pendingCount()).isZero();
        assertThat(audio.generation()).isZero();
        assertThat(audio.attachment()).isEqualTo(GuardedAudioStreamSession.Attachment.DETACHED);
        assertThat(video.nextAck("worker-b", 2L)).isZero();
        assertThat(video.pendingCount()).isEqualTo(1);
        assertThat(video.detached()).isTrue();
    }

    @Test
    @DisplayName("live NOT_ADMITTED consent blocks next frame and pending provider egress")
    void liveConsentNotAdmittedDoesNotAdvanceAckOrReachProvider() {
        AtomicReference<StreamConsentGate.Decision> audioConsent =
                new AtomicReference<>(StreamConsentGate.Decision.ADMITTED);
        AtomicReference<GuardedVideoStreamSession.ConsentDecision> videoConsent =
                new AtomicReference<>(GuardedVideoStreamSession.ConsentDecision.ADMITTED);
        StreamFrameReconciler.SessionIdentity audioIdentity =
                new StreamFrameReconciler.SessionIdentity("live-audio", TENANT, PRINCIPAL, PURPOSE, 1L);
        VideoFrameReconciler.SessionIdentity videoIdentity =
                new VideoFrameReconciler.SessionIdentity("live-video", TENANT, PRINCIPAL, PURPOSE, 1L);
        GuardedAudioStreamSession audio = GuardedAudioStreamSession.connect(
                audioIdentity, context -> audioConsent.get());
        GuardedVideoStreamSession video = GuardedVideoStreamSession.open(
                videoIdentity, context -> videoConsent.get(), "worker-live");
        AudioStreamSession.DecodedFrame admittedAudio =
                new AudioStreamSession.DecodedFrame(0, 0L, new byte[]{0x11});
        AudioStreamSession.DecodedFrame deniedAudio =
                new AudioStreamSession.DecodedFrame(1, 20L, new byte[]{0x12});
        VideoStreamSession.DecodedFrame admittedVideo =
                new VideoStreamSession.DecodedFrame(0, true, 0L, new byte[]{0x21});
        VideoStreamSession.DecodedFrame deniedVideo =
                new VideoStreamSession.DecodedFrame(1, false, 33L, new byte[]{0x22});
        AtomicInteger providerEffects = new AtomicInteger();

        assertThat(audio.submitFrame(admittedAudio))
                .isEqualTo(StreamFrameReconciler.Disposition.DELIVERED);
        assertThat(video.submitFrame("worker-live", 1L, admittedVideo))
                .isEqualTo(GuardedVideoStreamSession.FrameVerdict.DELIVERED_DECODABLE);
        assertThat(audio.nextAck()).isZero();
        assertThat(video.nextAck("worker-live", 1L)).isZero();

        // The session stays attached, but a newly unavailable authorization result
        // blocks both already-buffered egress and the next frame on each modality.
        audioConsent.set(StreamConsentGate.Decision.NOT_ADMITTED);
        videoConsent.set(GuardedVideoStreamSession.ConsentDecision.NOT_ADMITTED);
        assertThat(audio.attachment()).isEqualTo(GuardedAudioStreamSession.Attachment.ATTACHED);
        assertThat(video.detached()).isFalse();

        assertThatThrownBy(() -> audio.dispatchToProvider(admittedAudio,
                frame -> providerEffects.incrementAndGet()))
                .isInstanceOf(GuardedAudioStreamSession.ConsentDeniedException.class);
        assertThatThrownBy(() -> audio.submitFrame(deniedAudio))
                .isInstanceOf(GuardedAudioStreamSession.ConsentDeniedException.class);
        assertThatThrownBy(() -> video.egress("worker-live", 1L, admittedVideo,
                frame -> providerEffects.incrementAndGet()))
                .isInstanceOf(GuardedVideoStreamSession.ConsentDeniedException.class);
        assertThatThrownBy(() -> video.submitFrame("worker-live", 1L, deniedVideo))
                .isInstanceOf(GuardedVideoStreamSession.ConsentDeniedException.class);

        assertThat(audio.nextAck()).isZero();
        assertThat(video.nextAck("worker-live", 1L)).isZero();
        assertThat(providerEffects).hasValue(0);
    }

    @Test
    @DisplayName("unknown provider frame outcome holds bounded recovery without replay")
    void unknownProviderOutcomeHoldsRecoveryAndPreventsFrameReplay() {
        StreamFrameReconciler.SessionIdentity audioIdentity =
                new StreamFrameReconciler.SessionIdentity(
                        "unknown-audio", TENANT, PRINCIPAL, PURPOSE, 1L);
        VideoFrameReconciler.SessionIdentity videoIdentity =
                new VideoFrameReconciler.SessionIdentity(
                        "unknown-video", TENANT, PRINCIPAL, PURPOSE, 1L);
        GuardedAudioStreamSession audio = GuardedAudioStreamSession.connect(
                audioIdentity, context -> StreamConsentGate.Decision.ADMITTED);
        GuardedVideoStreamSession video = GuardedVideoStreamSession.open(
                videoIdentity, context -> GuardedVideoStreamSession.ConsentDecision.ADMITTED,
                "worker-a");
        AudioStreamSession.DecodedFrame audioFrame =
                new AudioStreamSession.DecodedFrame(0, 0L, new byte[]{0x31});
        VideoStreamSession.DecodedFrame videoFrame =
                new VideoStreamSession.DecodedFrame(0, true, 0L, new byte[]{0x41});
        AtomicInteger providerEffects = new AtomicInteger();

        assertThat(audio.submitFrame(audioFrame))
                .isEqualTo(StreamFrameReconciler.Disposition.DELIVERED);
        assertThat(video.submitFrame("worker-a", 1L, videoFrame))
                .isEqualTo(GuardedVideoStreamSession.FrameVerdict.DELIVERED_DECODABLE);
        assertThatThrownBy(() -> audio.dispatchToProvider(audioFrame, frame -> {
            providerEffects.incrementAndGet();
            throw new IllegalStateException("fixture transport failure");
        }))
                .isInstanceOf(GuardedAudioStreamSession.ProviderOutcomeUnknownException.class);
        assertThatThrownBy(() -> video.egress("worker-a", 1L, videoFrame, frame -> {
            providerEffects.incrementAndGet();
            throw new IllegalStateException("fixture transport failure");
        }))
                .isInstanceOf(GuardedVideoStreamSession.ProviderOutcomeUnknownException.class);

        // Reconnect/lease recovery has no authoritative durable query in these
        // in-memory helpers. An ambiguous sink result must therefore hold work.
        audio.detach();
        assertThatThrownBy(() -> audio.reconnect(1L))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("unknown provider frame outcome");
        assertThatThrownBy(() -> video.claim("worker-b", 2L))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("unknown provider frame outcome");
        assertThatThrownBy(() -> video.egress("worker-a", 1L, videoFrame,
                frame -> providerEffects.incrementAndGet()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("unknown provider frame outcome");

        assertThat(providerEffects).hasValue(2);
        assertThat(audio.attachment()).isEqualTo(GuardedAudioStreamSession.Attachment.DETACHED);
        assertThat(audio.generation()).isZero();
        assertThat(audio.nextAck()).isZero();
        assertThat(audio.pendingCount()).isZero();
        assertThat(video.claimToken()).isEqualTo(1L);
        assertThat(video.leaseHolder()).isEqualTo("worker-a");
        assertThat(video.nextAck("worker-a", 1L)).isZero();
        assertThat(video.pendingCount()).isZero();
    }
}
