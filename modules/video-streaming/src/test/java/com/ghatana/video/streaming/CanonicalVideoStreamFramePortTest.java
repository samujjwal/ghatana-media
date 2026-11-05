package com.ghatana.video.streaming;

import java.time.Instant;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class CanonicalVideoStreamFramePortTest {

    @Test
    void missingCanonicalAdapterFailsClosedWithoutAnAcknowledgement() {
        CanonicalVideoStreamFramePort port = CanonicalVideoStreamFramePort.notAdmitted(
                "purpose-bound canonical stream session is unavailable");
        VideoStreamSession helper = new VideoStreamSession();
        VideoStreamSession.DecodedFrame decodedHelperFrame = helper.decodeFrame(
                helper.encodeFrame(0, true, 10L, new byte[] {1}));

        // A local decode is not a canonical session binding or durable ACK.
        assertThat(port.currentBinding("tenant-1", "stream-1", "principal-1")).isEmpty();
        assertThat(port.offer(binding(), decodedHelperFrame))
                .isEqualTo(CanonicalVideoStreamFramePort.Result.notAdmitted(
                        "purpose-bound canonical stream session is unavailable"));
    }

    @Test
    void bindingRequiresTrustedIdentityDurableCursorAndLease() {
        Instant expiry = Instant.parse("2026-11-05T20:00:00Z");
        CanonicalVideoStreamFramePort.Binding binding = new CanonicalVideoStreamFramePort.Binding(
                "stream-1", "tenant-1", "principal-1", "purpose-1", 2, 7, 4, expiry);
        assertThat(binding.lastAcknowledgedSequence()).isEqualTo(4);
        assertThat(binding.sessionRevision()).isEqualTo(2);
        assertThat(binding.storeVersion()).isEqualTo(7);
        assertThat(binding.leaseExpiresAt()).isEqualTo(expiry);

        assertThatThrownBy(() -> new CanonicalVideoStreamFramePort.Binding(
                "stream-1", "tenant-1", "principal-1", " ", 1, 1, -1, expiry))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new CanonicalVideoStreamFramePort.Binding(
                "stream-1", "tenant-1", "principal-1", "purpose-1", 0, 1, -1, expiry))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("revision or ACK cursor");
        assertThatThrownBy(() -> new CanonicalVideoStreamFramePort.Binding(
                "stream-1", "tenant-1", "principal-1", "purpose-1", 1, 1,
                (long) VideoStreamSession.MAX_FRAME_SEQUENCE + 1, expiry))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("revision or ACK cursor");
    }

    @Test
    void acknowledgementsCannotExceedSupportedFrameSequenceRange() {
        assertThat(CanonicalVideoStreamFramePort.Result.acknowledged(
                VideoStreamSession.MAX_FRAME_SEQUENCE).acknowledgedSequence())
                .isEqualTo(VideoStreamSession.MAX_FRAME_SEQUENCE);
        assertThatThrownBy(() -> CanonicalVideoStreamFramePort.Result.acknowledged(
                (long) VideoStreamSession.MAX_FRAME_SEQUENCE + 1))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("supported range");
        assertThatThrownBy(() -> new CanonicalVideoStreamFramePort.Result(
                CanonicalVideoStreamFramePort.Disposition.LEASE_EXPIRED, 0, "expired"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("non-ACK");
    }

    private static CanonicalVideoStreamFramePort.Binding binding() {
        return new CanonicalVideoStreamFramePort.Binding(
                "stream-1", "tenant-1", "principal-1", "purpose-1", 1, 1, -1,
                Instant.parse("2026-11-05T20:00:00Z"));
    }
}
