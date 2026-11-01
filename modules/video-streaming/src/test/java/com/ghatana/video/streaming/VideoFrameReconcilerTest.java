package com.ghatana.video.streaming;

import com.ghatana.video.streaming.VideoFrameReconciler.Disposition;
import com.ghatana.video.streaming.VideoFrameReconciler.SessionIdentity;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** VS-03: source PTS preserved, keyframe deps honored, discontinuities marked, never wall clock. */
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
    @DisplayName("source presentation timestamps are preserved verbatim, not wall clock")
    void sourcePtsPreservedVerbatim() {
        VideoFrameReconciler rec = VideoFrameReconciler.open(identity("t1"));
        rec.offer(frame(0, true, 4_999_999_999L));
        assertThat(rec.deliveryOf(frame(1, false, 5_000_000_082L)).discontinuity()).isNull();
        rec.offer(frame(1, false, 5_000_000_082L));
        assertThat(rec.lastDeliveredPts()).isEqualTo(5_000_000_082L);
        // The stored PTS is the source presentation value — a wall-clock
        // timestamp would be the test's own Instant.now(), not 5e9.
    }

    @Test
    @DisplayName("backwards and jumped PTS mark a discontinuity, never an error")
    void discontinuityMarkedNotErrored() {
        VideoFrameReconciler rec = VideoFrameReconciler.open(identity("t1"));
        rec.offer(frame(0, true, 10_000));
        // VFR forward jump beyond the 30s bound → PTS_JUMP (evaluated against
        // the cursor before the frame is offered).
        assertThat(rec.deliveryOf(frame(1, false, 50_000)).discontinuity())
                .isEqualTo("PTS_JUMP");
        rec.offer(frame(1, false, 50_000));
        // Scene cut rewinds PTS → PTS_BACKWARDS, still delivered.
        assertThat(rec.deliveryOf(frame(2, true, 0)).discontinuity())
                .isEqualTo("PTS_BACKWARDS");
        rec.offer(frame(2, true, 0));
        assertThat(rec.nextAck()).isEqualTo(2); // uncertainty never blocks delivery
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
        assertThat(rec.lastDeliveredPts()).isEqualTo(9000);
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
        assertThat(valid.lastDeliveredPts()).isEqualTo(99);
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
