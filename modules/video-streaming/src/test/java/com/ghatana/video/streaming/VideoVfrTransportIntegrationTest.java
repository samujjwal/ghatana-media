package com.ghatana.video.streaming;

import com.ghatana.video.streaming.VideoFrameReconciler.Disposition;
import com.ghatana.video.streaming.VideoFrameReconciler.SessionIdentity;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * VS-07 local integration coverage for irregular wire timestamps across the
 * in-process transport and a temporary frame-sequence gap.
 *
 * <p>This exercises deterministic fixture frames only. The wire timestamp has
 * no clock identity, so this test does not qualify a codec or source-time map.
 */
class VideoVfrTransportIntegrationTest {

    @Test
    void wireRoundtripAndGapFillPreserveVfrFrameOrderWithoutPromotingSourceTime() {
        InProcessVideoTransport transport = new InProcessVideoTransport();
        VideoFrameReconciler reconciler = VideoFrameReconciler.open(new SessionIdentity(
                "vstream-vfr", "tenant-1", "principal-1", "purpose-1", 1));

        VideoStreamSession.DecodedFrame keyframe = frame(0, true, 0L, 0x10);
        VideoStreamSession.DecodedFrame lateFrame = frame(2, false, 83L, 0x30);
        VideoStreamSession.DecodedFrame gapFrame = frame(1, false, 17L, 0x20);

        assertThat(transport.send(keyframe)).isTrue();
        assertThat(transport.send(lateFrame)).isTrue();
        assertThat(reconciler.offer(transport.receive())).isEqualTo(Disposition.DELIVERED);
        assertThat(reconciler.offer(transport.receive())).isEqualTo(Disposition.HELD);
        assertThat(reconciler.pendingCount()).isEqualTo(1);

        assertThat(transport.send(gapFrame)).isTrue();
        VideoStreamSession.DecodedFrame decodedGap = transport.receive();
        assertThat(reconciler.offer(decodedGap)).isEqualTo(Disposition.DELIVERED);
        VideoStreamSession.DecodedFrame released = reconciler.takeDelivered();

        assertThat(released.sequenceNumber()).isEqualTo(2);
        assertThat(released.keyFrame()).isFalse();
        assertThat(released.timestampMillis()).isEqualTo(83L);
        assertThat(released.payload()).containsExactly((byte) 0x30);
        assertThat(reconciler.nextAck()).isEqualTo(2);
        assertThat(reconciler.lastKeyFrameSequence()).isEqualTo(0);
        assertThat(reconciler.deliveryOf(released).decodable()).isTrue();
        assertThat(reconciler.deliveryOf(released).discontinuity())
                .isEqualTo("SOURCE_TIME_MAPPING_NOT_ADMITTED");
        assertThat(reconciler.lastDeliveredPts()).isEqualTo(Long.MIN_VALUE);
        assertThat(transport.inFlightCount()).isZero();
    }

    private static VideoStreamSession.DecodedFrame frame(
            int sequence, boolean keyFrame, long wireMillis, int payloadByte) {
        return new VideoStreamSession.DecodedFrame(
                sequence, keyFrame, wireMillis, new byte[]{(byte) payloadByte});
    }
}
