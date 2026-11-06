package com.ghatana.audio.streaming;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class CanonicalStreamFramePortTest {

    @Test
    void missingCanonicalAdapterFailsClosedWithoutAnAcknowledgement() {
        CanonicalStreamFramePort port = CanonicalStreamFramePort.notAdmitted(
                "purpose-bound canonical stream session is unavailable");
        AudioStreamSession helper = new AudioStreamSession();
        AudioStreamSession.DecodedFrame decodedHelperFrame = helper.decodeFrame(
                helper.encodeFrame(0, 10L, new byte[] {1}));

        // A valid local helper frame is not evidence that a canonical stream
        // session exists; only the runtime-owned port can supply that binding.
        assertThat(port.currentBinding("tenant-1", "stream-1", "principal-1"))
                .isEmpty();
        assertThat(port.offer(binding(), decodedHelperFrame))
                .isEqualTo(CanonicalStreamFramePort.Result.notAdmitted(
                        "purpose-bound canonical stream session is unavailable"));
        assertThat(port.offerWithFeedback(binding(), decodedHelperFrame))
                .satisfies(feedback -> {
                    assertThat(feedback.result()).isEqualTo(CanonicalStreamFramePort.Result.notAdmitted(
                            "purpose-bound canonical stream session is unavailable"));
                    assertThat(feedback.feedbackAvailable()).isFalse();
                });
        assertThat(port.endOfStreamWithFeedback(binding()).result().disposition())
                .isEqualTo(CanonicalStreamFramePort.Disposition.NOT_ADMITTED);
    }

    @Test
    void bindingRequiresACompleteTrustedIdentityAndDurableCursor() {
        assertThat(new CanonicalStreamFramePort.Binding(
                        "stream-1", "tenant-1", "principal-1", "purpose-1", 1, 1, -1,
                        java.time.Instant.now().plusSeconds(30)))
                .satisfies(binding -> {
                    assertThat(binding.lastAcknowledgedSequence()).isEqualTo(-1);
                    assertThat(binding.sessionRevision()).isEqualTo(1);
                    assertThat(binding.storeVersion()).isEqualTo(1);
                });
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new CanonicalStreamFramePort.Binding(
                        "stream-1", "tenant-1", "principal-1", " ", 1, 1, -1,
                        java.time.Instant.now().plusSeconds(30)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(new CanonicalStreamFramePort.Binding(
                        "stream-1", "tenant-1", "principal-1", "purpose-1", 1, 1,
                        AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER,
                        java.time.Instant.now().plusSeconds(30)).lastAcknowledgedSequence())
                .isEqualTo(AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new CanonicalStreamFramePort.Binding(
                        "stream-1", "tenant-1", "principal-1", "purpose-1", 1, 1,
                        (long) AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER + 1,
                        java.time.Instant.now().plusSeconds(30)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("ACK cursor");
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new CanonicalStreamFramePort.Binding(
                        "stream-1", "tenant-1", "principal-1", "purpose-1", 1, 1,
                        Long.MAX_VALUE, java.time.Instant.now().plusSeconds(30)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("ACK cursor");
    }

    @Test
    void acknowledgementsCannotExceedTheSupportedFrameSequenceRange() {
        assertThat(CanonicalStreamFramePort.Result.acknowledged(
                        AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER).acknowledgedSequence())
                .isEqualTo(AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER);
        org.assertj.core.api.Assertions.assertThatThrownBy(() ->
                        CanonicalStreamFramePort.Result.acknowledged(
                                (long) AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER + 1))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("supported range");
    }

    @Test
    void exhaustedFinalAckCanResumeAndFinalFrameReplaysAsDuplicate() {
        CanonicalStreamFramePort.Binding exhausted = new CanonicalStreamFramePort.Binding(
                "stream-1", "tenant-1", "principal-1", "purpose-1", 1, 2,
                AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER, java.time.Instant.now().plusSeconds(30));
        StreamFrameReconciler.SessionIdentity identity = new StreamFrameReconciler.SessionIdentity(
                exhausted.streamId(), exhausted.tenantId(), exhausted.principalId(),
                exhausted.purposeRef(), exhausted.sessionRevision());

        StreamFrameReconciler resumed = StreamFrameReconciler.resume(
                identity, identity, (int) exhausted.lastAcknowledgedSequence());
        assertThat(resumed.nextExpected()).isEqualTo(Integer.MAX_VALUE);
        assertThat(resumed.nextAck()).isEqualTo(AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER);
        assertThat(resumed.offer(new AudioStreamSession.DecodedFrame(
                        AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER, 0L, new byte[] {1})))
                .isEqualTo(StreamFrameReconciler.Disposition.DUPLICATE);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> StreamFrameReconciler.resume(
                        identity, identity, Integer.MAX_VALUE))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("last ACK");
    }

    private static CanonicalStreamFramePort.Binding binding() {
        return new CanonicalStreamFramePort.Binding(
                "stream-1", "tenant-1", "principal-1", "purpose-1", 1, 1, -1,
                java.time.Instant.now().plusSeconds(30));
    }
}
