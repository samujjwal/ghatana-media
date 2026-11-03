package com.ghatana.video.streaming;

import com.ghatana.video.streaming.VideoFrameReconciler.Disposition;
import com.ghatana.video.streaming.VideoFrameReconciler.SessionIdentity;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** VS-03: source time remains unknown until the session has authoritative source binding. */
@DisplayName("VideoFrameReconciler")
class VideoFrameReconcilerTest {

    private static SessionIdentity identity(String tenant) {
        return new SessionIdentity("vstream-1", tenant, "principal-1", "purpose-1", 1);
    }

    private static VideoStreamSession.DecodedFrame frame(int seq, boolean key, long pts) {
        return new VideoStreamSession.DecodedFrame(seq, key, pts, new byte[]{1});
    }

    @Test
    @DisplayName("a keyframe anchors its GOP and dependent frames are decodable")
    void keyframeAnchorsDecodability() {
        VideoFrameReconciler rec = VideoFrameReconciler.open(identity("t1"));
        rec.offer(frame(0, true, 1000));
        assertThat(rec.deliveryOf(frame(1, false, 1033)).decodable()).isTrue();
        rec.offer(frame(1, false, 1033));
        assertThat(rec.lastKeyFrameSequence()).isEqualTo(0);
    }

    @Test
    @DisplayName("wire VFR, discontinuity, and wall-time-like values remain unknown")
    void unboundSourceTimesRemainUnknown() {
        VideoFrameReconciler rec = VideoFrameReconciler.open(identity("t1"));
        rec.offer(frame(0, true, 1_700_000_000_000L));
        assertThat(rec.deliveryOf(frame(1, false, 1_700_000_000_040L)).discontinuity())
                .isEqualTo("SOURCE_TIME_MAPPING_NOT_ADMITTED");
        rec.offer(frame(1, false, 1_700_000_000_040L));
        assertThat(rec.deliveryOf(frame(2, true, -500L)).discontinuity())
                .isEqualTo("SOURCE_TIME_MAPPING_NOT_ADMITTED");
        rec.offer(frame(2, true, -500L));
        assertThat(rec.deliveryOf(frame(3, false, Long.MAX_VALUE)).discontinuity())
                .isEqualTo("SOURCE_TIME_MAPPING_NOT_ADMITTED");
        rec.offer(frame(3, false, Long.MAX_VALUE));
        assertThat(rec.lastDeliveredPts()).isEqualTo(Long.MIN_VALUE);
        assertThat(rec.nextAck()).isEqualTo(3);
    }

    @Test
    @DisplayName("reordered delivery preserves frame order while source time remains unknown")
    void reorderedDeliveryKeepsTimeUnknown() {
        VideoFrameReconciler rec = VideoFrameReconciler.open(identity("t1"));
        rec.offer(frame(0, true, 10_000));
        VideoStreamSession.DecodedFrame held = frame(2, false, 5_000);
        assertThat(rec.offer(held)).isEqualTo(Disposition.HELD);
        assertThat(rec.offer(frame(1, false, 20_000))).isEqualTo(Disposition.DELIVERED);

        VideoStreamSession.DecodedFrame released = rec.takeDelivered();
        assertThat(released.sequenceNumber()).isEqualTo(2);
        assertThat(rec.deliveryOf(released).discontinuity()).isEqualTo("SOURCE_TIME_MAPPING_NOT_ADMITTED");
        assertThat(rec.lastDeliveredPts()).isEqualTo(Long.MIN_VALUE);
    }

    @Test
    @DisplayName("VFR-like wire timestamps and keyframes survive reorder without timebase inference")
    void preservesVfrWireValuesWithoutInferringSourceTime() {
        VideoStreamSession wire = new VideoStreamSession();
        VideoFrameReconciler rec = VideoFrameReconciler.open(identity("t1"));
        long[] irregularWireTimes = {100, 141, 142, 260};
        boolean[] keyframes = {true, false, false, true};

        // These irregular values exercise preservation only. The wire has no
        // clock, source stream, origin, or retained source-map binding.
        VideoStreamSession.DecodedFrame[] decoded = new VideoStreamSession.DecodedFrame[4];
        for (int i = 0; i < decoded.length; i++) {
            decoded[i] = wire.decodeFrame(wire.encodeFrame(
                    i, keyframes[i], irregularWireTimes[i], new byte[]{(byte) i}));
        }

        assertThat(rec.offer(decoded[0])).isEqualTo(Disposition.DELIVERED);
        assertThat(rec.offer(decoded[3])).isEqualTo(Disposition.HELD);
        assertThat(rec.offer(decoded[1])).isEqualTo(Disposition.DELIVERED);
        assertThat(rec.offer(decoded[2])).isEqualTo(Disposition.DELIVERED);
        VideoStreamSession.DecodedFrame released = rec.takeDelivered();

        assertThat(released.sequenceNumber()).isEqualTo(3);
        assertThat(released.keyFrame()).isTrue();
        assertThat(released.timestampMillis()).isEqualTo(260);
        assertThat(rec.deliveryOf(released).decodable()).isTrue();
        assertThat(rec.deliveryOf(released).discontinuity())
                .isEqualTo("SOURCE_TIME_MAPPING_NOT_ADMITTED");
        assertThat(rec.lastDeliveredPts()).isEqualTo(Long.MIN_VALUE);
    }

    @Test
    @DisplayName("out-of-order frames hold until the gap fills, keyframe deps tracked")
    void outOfOrderHoldsWithKeyframeTracking() {
        VideoFrameReconciler rec = VideoFrameReconciler.open(identity("t1"));
        rec.offer(frame(0, true, 0));
        assertThat(rec.offer(frame(2, true, 66))).isEqualTo(Disposition.HELD);
        assertThat(rec.offer(frame(1, false, 33))).isEqualTo(Disposition.DELIVERED);
        assertThat(rec.takeDelivered().sequenceNumber()).isEqualTo(2);
        assertThat(rec.lastKeyFrameSequence()).isEqualTo(2); // held keyframe tracked
    }

    @Test
    @DisplayName("duplicates never redeliver; reorder storm is bounded")
    void dedupAndBoundedStorm() {
        VideoFrameReconciler rec = VideoFrameReconciler.open(identity("t1"));
        rec.offer(frame(0, true, 0));
        assertThat(rec.offer(frame(0, true, 0))).isEqualTo(Disposition.DUPLICATE);
        for (int i = 1; i <= 256; i++) {
            assertThat(rec.offer(frame(i + 1, false, i * 33))).isEqualTo(Disposition.HELD);
        }
        assertThat(rec.offer(frame(300, false, 99999))).isEqualTo(Disposition.OVERFLOW);
    }

    @Test
    @DisplayName("resume honors durable ACK/keyframe position; cross-tenant denied")
    void resumeHonorsDurableAndDeniesCrossTenant() {
        SessionIdentity durable = identity("t1");
        VideoFrameReconciler rec = VideoFrameReconciler.resume(
                durable, durable, 41, 40, 9000);
        assertThat(rec.nextExpected()).isEqualTo(42);
        assertThat(rec.lastKeyFrameSequence()).isEqualTo(40);
        assertThat(rec.lastDeliveredPts()).isEqualTo(Long.MIN_VALUE);
        assertThat(rec.offer(frame(40, false, 8950))).isEqualTo(Disposition.DUPLICATE);
        assertThatThrownBy(() -> VideoFrameReconciler.resume(
                identity("t2"), durable, 41, 40, 9000))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("cross-tenant");
    }

    @Test
    @DisplayName("negative and wrapping sequences are rejected without advancing ACK")
    void rejectsNegativeAndWrappingSequences() {
        VideoFrameReconciler rec = VideoFrameReconciler.open(identity("t1"));

        assertThatThrownBy(() -> rec.offer(frame(-1, true, 10)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sequence is outside");
        assertThatThrownBy(() -> rec.offer(frame(Integer.MAX_VALUE, true, 10)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sequence is outside");

        assertThat(rec.nextAck()).isEqualTo(-1);
        assertThat(rec.nextExpected()).isZero();
        assertThat(rec.pendingCount()).isZero();
        assertThat(rec.offer(frame(0, true, 10))).isEqualTo(Disposition.DELIVERED);
        assertThat(rec.nextAck()).isZero();
    }

    @Test
    @DisplayName("reorder storage applies an aggregate byte cap and releases capacity with the gap")
    void reorderStorageIsByteBounded() {
        VideoFrameReconciler rec = VideoFrameReconciler.open(identity("t1"));
        assertThat(rec.offer(frame(0, true, 0))).isEqualTo(Disposition.DELIVERED);
        VideoStreamSession.DecodedFrame largest = new VideoStreamSession.DecodedFrame(
                2, false, 66L, new byte[VideoStreamSession.MAX_FRAME_PAYLOAD_BYTES]);
        assertThat(rec.offer(largest)).isEqualTo(Disposition.HELD);
        assertThat(rec.pendingBytes()).isEqualTo(VideoStreamSession.MAX_FRAME_PAYLOAD_BYTES);

        assertThat(rec.offer(frame(3, false, 99L))).isEqualTo(Disposition.OVERFLOW);
        assertThat(rec.pendingCount()).isEqualTo(1);
        assertThat(rec.pendingBytes()).isEqualTo(VideoStreamSession.MAX_FRAME_PAYLOAD_BYTES);
        assertThat(rec.nextAck()).isZero();

        assertThat(rec.offer(frame(1, false, 33L))).isEqualTo(Disposition.DELIVERED);
        assertThat(rec.takeDelivered()).isSameAs(largest);
        assertThat(rec.pendingBytes()).isZero();
        assertThat(rec.offer(frame(3, false, 99L))).isEqualTo(Disposition.DELIVERED);
        assertThat(rec.nextAck()).isEqualTo(3);
    }

    @Test
    @DisplayName("malformed contiguous video payload is rejected before advancing ACK")
    void malformedContiguousPayloadDoesNotAdvanceAck() {
        VideoFrameReconciler rec = VideoFrameReconciler.open(identity("t1"));
        VideoStreamSession.DecodedFrame missingPayload = new VideoStreamSession.DecodedFrame(
                0, true, 0L, null);
        VideoStreamSession.DecodedFrame oversized = new VideoStreamSession.DecodedFrame(
                0, true, 0L, new byte[VideoStreamSession.MAX_FRAME_PAYLOAD_BYTES + 1]);

        assertThatThrownBy(() -> rec.offer(missingPayload))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("payload");
        assertThatThrownBy(() -> rec.offer(oversized))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("payload");
        assertThat(rec.nextAck()).isEqualTo(-1);
        assertThat(rec.offer(frame(0, true, 0L))).isEqualTo(Disposition.DELIVERED);
        assertThat(rec.nextAck()).isZero();
    }

    @Test
    @DisplayName("resume rejects impossible ACK and keyframe positions")
    void resumeRejectsImpossiblePositions() {
        SessionIdentity durable = identity("t1");

        assertThatThrownBy(() -> VideoFrameReconciler.resume(
                durable, durable, Integer.MAX_VALUE, -1, 10))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("last ACK");
        assertThatThrownBy(() -> VideoFrameReconciler.resume(
                durable, durable, 3, 4, 10))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("keyframe sequence");
        assertThatThrownBy(() -> VideoFrameReconciler.resume(
                durable, durable, -2, -1, 10))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("last ACK");

        VideoFrameReconciler valid = VideoFrameReconciler.resume(durable, durable, 3, 2, 99);
        assertThat(valid.nextExpected()).isEqualTo(4);
        assertThat(valid.lastKeyFrameSequence()).isEqualTo(2);
        assertThat(valid.lastDeliveredPts()).isEqualTo(Long.MIN_VALUE);
    }

    @Test
    @DisplayName("maximum deliverable sequence is ACKed without entering the reserved sentinel")
    void reservesSequenceRolloverSentinelAcrossAckAndResume() {
        SessionIdentity durable = identity("t1");
        int lastDeliverable = VideoStreamSession.MAX_FRAME_SEQUENCE;
        int precedingAck = lastDeliverable - 1;

        VideoFrameReconciler resumed = VideoFrameReconciler.resume(
                durable, durable, precedingAck, precedingAck - 1, 0L);
        assertThat(resumed.nextExpected()).isEqualTo(lastDeliverable);
        assertThat(resumed.offer(frame(lastDeliverable, false, 1L))).isEqualTo(Disposition.DELIVERED);
        assertThat(resumed.nextAck()).isEqualTo(lastDeliverable);
        assertThat(resumed.nextExpected()).isEqualTo(Integer.MAX_VALUE);
        assertThatThrownBy(() -> resumed.offer(frame(Integer.MAX_VALUE, false, 2L)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sequence is outside");

        assertThatThrownBy(() -> VideoFrameReconciler.resume(
                durable, durable, lastDeliverable, lastDeliverable, 0L))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("last ACK");
        assertThatThrownBy(() -> VideoFrameReconciler.resume(
                durable, durable, Integer.MAX_VALUE, -1, 0L))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("last ACK");
    }

    @Test
    @DisplayName("resume cannot change the durable principal or processing purpose")
    void resumeDeniesPrincipalOrPurposeChange() {
        SessionIdentity durable = identity("t1");
        SessionIdentity otherPrincipal = new SessionIdentity(
                "vstream-1", "t1", "principal-2", "purpose-1", 1);
        SessionIdentity otherPurpose = new SessionIdentity(
                "vstream-1", "t1", "principal-1", "purpose-2", 1);

        assertThatThrownBy(() -> VideoFrameReconciler.resume(
                otherPrincipal, durable, 10, 8, 9000))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("principal");
        assertThatThrownBy(() -> VideoFrameReconciler.resume(
                otherPurpose, durable, 10, 8, 9000))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("purpose");
    }
}
