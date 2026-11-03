package com.ghatana.audio.streaming;

import com.ghatana.audio.streaming.StreamFrameReconciler.Disposition;
import com.ghatana.audio.streaming.StreamFrameReconciler.SessionIdentity;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** AS-03: one logical frame each, correct next-ACK, no cross-tenant resume. */
@DisplayName("StreamFrameReconciler")
class StreamFrameReconcilerTest {

    private static SessionIdentity identity(String tenant) {
        return new SessionIdentity("stream-1", tenant, "principal-1", "purpose-1", 1);
    }

    private static AudioStreamSession.DecodedFrame frame(int seq) {
        return new AudioStreamSession.DecodedFrame(seq, seq * 1000L, new byte[]{1});
    }

    @Test
    @DisplayName("in-order frames deliver once and advance the ACK")
    void inOrderDeliversAndAcks() {
        StreamFrameReconciler rec = StreamFrameReconciler.open(identity("t1"));
        assertThat(rec.offer(frame(0))).isEqualTo(Disposition.DELIVERED);
        assertThat(rec.offer(frame(1))).isEqualTo(Disposition.DELIVERED);
        assertThat(rec.nextAck()).isEqualTo(1);
        assertThat(rec.nextExpected()).isEqualTo(2);
    }

    @Test
    @DisplayName("duplicates and already-acked frames never redeliver")
    void duplicatesNeverRedeliver() {
        StreamFrameReconciler rec = StreamFrameReconciler.open(identity("t1"));
        rec.offer(frame(0));
        rec.offer(frame(1));
        assertThat(rec.offer(frame(0))).isEqualTo(Disposition.DUPLICATE);
        assertThat(rec.offer(frame(1))).isEqualTo(Disposition.DUPLICATE);
        assertThat(rec.nextAck()).isEqualTo(1);
    }

    @Test
    @DisplayName("out-of-order frames are held until the gap fills, then deliver in order")
    void outOfOrderHeldThenDelivered() {
        StreamFrameReconciler rec = StreamFrameReconciler.open(identity("t1"));
        assertThat(rec.offer(frame(0))).isEqualTo(Disposition.DELIVERED);
        assertThat(rec.offer(frame(2))).isEqualTo(Disposition.HELD);
        assertThat(rec.offer(frame(4))).isEqualTo(Disposition.HELD);
        assertThat(rec.nextAck()).isEqualTo(0); // gap — ACK cannot pass frame 0
        assertThat(rec.offer(frame(1))).isEqualTo(Disposition.DELIVERED);
        assertThat(rec.takeDelivered().sequenceNumber()).isEqualTo(2);
        assertThat(rec.nextAck()).isEqualTo(2); // 3 still held behind the gap at 3
        assertThat(rec.offer(frame(3))).isEqualTo(Disposition.DELIVERED);
        assertThat(rec.takeDelivered().sequenceNumber()).isEqualTo(4);
        assertThat(rec.nextAck()).isEqualTo(4);
        assertThat(rec.takeDelivered()).isNull();
    }

    @Test
    @DisplayName("held payload is snapshotted before the caller can mutate it")
    void heldPayloadIsSnapshotted() {
        StreamFrameReconciler rec = StreamFrameReconciler.open(identity("t1"));
        byte[] sourcePayload = new byte[]{1, 2, 3};
        AudioStreamSession.DecodedFrame source =
                new AudioStreamSession.DecodedFrame(1, 1000L, sourcePayload);

        assertThat(rec.offer(source)).isEqualTo(Disposition.HELD);
        sourcePayload[0] = 9;
        source.payload()[1] = 8;
        assertThat(rec.pendingBytes()).isEqualTo(3);
        assertThat(rec.offer(frame(0))).isEqualTo(Disposition.DELIVERED);

        AudioStreamSession.DecodedFrame delivered = rec.takeDelivered();
        assertThat(delivered.payload()).containsExactly((byte) 1, (byte) 2, (byte) 3);
        assertThat(delivered).isNotSameAs(source);
    }

    @Test
    @DisplayName("a duplicate of a held frame is deduplicated, not held twice")
    void heldDuplicateDedup() {
        StreamFrameReconciler rec = StreamFrameReconciler.open(identity("t1"));
        rec.offer(frame(0));
        assertThat(rec.offer(frame(3))).isEqualTo(Disposition.HELD);
        assertThat(rec.offer(frame(3))).isEqualTo(Disposition.DUPLICATE);
        assertThat(rec.pendingCount()).isEqualTo(1);
    }

    @Test
    @DisplayName("an unbounded reorder storm is rejected at the held-frame bound")
    void reorderStormBounded() {
        StreamFrameReconciler rec = StreamFrameReconciler.open(identity("t1"));
        rec.offer(frame(0));
        for (int i = 1; i <= 256; i++) {
            // Skip sequence 1 so everything lands in the held set.
            assertThat(rec.offer(frame(i + 1))).isEqualTo(Disposition.HELD);
        }
        assertThat(rec.pendingCount()).isEqualTo(256);
        assertThat(rec.offer(frame(300))).isEqualTo(Disposition.OVERFLOW);
    }

    @Test
    @DisplayName("resume re-establishes the durable ACK and dedups everything earlier")
    void resumeHonorsDurableAck() {
        StreamFrameReconciler rec = StreamFrameReconciler.resume(
                identity("t1"), identity("t1"), 41);
        assertThat(rec.nextExpected()).isEqualTo(42);
        assertThat(rec.offer(frame(40))).isEqualTo(Disposition.DUPLICATE);
        assertThat(rec.offer(frame(42))).isEqualTo(Disposition.DELIVERED);
    }

    @Test
    @DisplayName("cross-tenant and noncanonical-generation resumes are denied")
    void resumeDeniedCrossTenantOrNoncanonicalRevision() {
        SessionIdentity durable = identity("t1");
        assertThatThrownBy(() -> StreamFrameReconciler.resume(
                identity("t2"), durable, 10))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("cross-tenant");
        SessionIdentity stale = new SessionIdentity(
                "stream-1", "t1", "principal-1", "purpose-1", 0);
        assertThatThrownBy(() -> StreamFrameReconciler.resume(stale, durable, 10))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("does not match");
        SessionIdentity future = new SessionIdentity(
                "stream-1", "t1", "principal-1", "purpose-1", 2);
        assertThatThrownBy(() -> StreamFrameReconciler.resume(future, durable, 10))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("does not match");
        assertThatThrownBy(() -> StreamFrameReconciler.resume(
                new SessionIdentity("other", "t1", "principal-1", "purpose-1", 1), durable, 10))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("streamId");
    }

    @Test
    @DisplayName("resume cannot change the durable principal or processing purpose")
    void resumeDeniedPrincipalOrPurposeChange() {
        SessionIdentity durable = identity("t1");
        SessionIdentity otherPrincipal = new SessionIdentity(
                "stream-1", "t1", "principal-2", "purpose-1", 1);
        SessionIdentity otherPurpose = new SessionIdentity(
                "stream-1", "t1", "principal-1", "purpose-2", 1);

        assertThatThrownBy(() -> StreamFrameReconciler.resume(otherPrincipal, durable, 10))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("principal");
        assertThatThrownBy(() -> StreamFrameReconciler.resume(otherPurpose, durable, 10))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("purpose");
    }

    @Test
    @DisplayName("negative and rollover sequences are rejected without moving the ACK")
    void invalidSequenceCannotCorruptCursor() {
        StreamFrameReconciler rec = StreamFrameReconciler.open(identity("t1"));
        assertThatThrownBy(() -> rec.offer(frame(-1)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sequence");
        assertThatThrownBy(() -> rec.offer(frame(Integer.MAX_VALUE)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sequence");

        assertThat(rec.nextAck()).isEqualTo(-1);
        assertThat(rec.nextExpected()).isZero();
        assertThat(rec.offer(frame(0))).isEqualTo(Disposition.DELIVERED);
        assertThat(rec.nextAck()).isZero();
    }

    @Test
    @DisplayName("reorder storage applies an aggregate byte cap and releases capacity with the gap")
    void reorderStorageIsByteBounded() {
        StreamFrameReconciler rec = StreamFrameReconciler.open(identity("t1"));
        AudioStreamSession.DecodedFrame largest = new AudioStreamSession.DecodedFrame(
                2, 2000L, new byte[AudioStreamSession.MAX_FRAME_PAYLOAD_BYTES]);
        assertThat(rec.offer(largest)).isEqualTo(Disposition.HELD);
        assertThat(rec.pendingBytes()).isEqualTo(AudioStreamSession.MAX_FRAME_PAYLOAD_BYTES);

        assertThat(rec.offer(new AudioStreamSession.DecodedFrame(3, 3000L, new byte[]{1})))
                .isEqualTo(Disposition.OVERFLOW);
        assertThat(rec.pendingCount()).isEqualTo(1);
        assertThat(rec.pendingBytes()).isEqualTo(AudioStreamSession.MAX_FRAME_PAYLOAD_BYTES);
        assertThat(rec.nextAck()).isEqualTo(-1);

        assertThat(rec.offer(frame(0))).isEqualTo(Disposition.DELIVERED);
        assertThat(rec.offer(frame(1))).isEqualTo(Disposition.DELIVERED);
        AudioStreamSession.DecodedFrame delivered = rec.takeDelivered();
        assertThat(delivered).isNotSameAs(largest);
        assertThat(delivered.payload()).containsExactly(largest.payload());
        assertThat(rec.pendingBytes()).isZero();
        assertThat(rec.offer(new AudioStreamSession.DecodedFrame(3, 3000L, new byte[]{1})))
                .isEqualTo(Disposition.DELIVERED);
        assertThat(rec.nextAck()).isEqualTo(3);
    }

    @Test
    @DisplayName("malformed contiguous audio payload is rejected before advancing ACK")
    void malformedContiguousPayloadDoesNotAdvanceAck() {
        StreamFrameReconciler rec = StreamFrameReconciler.open(identity("t1"));
        AudioStreamSession.DecodedFrame missingPayload = new AudioStreamSession.DecodedFrame(
                0, 0L, null);
        AudioStreamSession.DecodedFrame oversized = new AudioStreamSession.DecodedFrame(
                0, 0L, new byte[AudioStreamSession.MAX_FRAME_PAYLOAD_BYTES + 1]);

        assertThatThrownBy(() -> rec.offer(missingPayload))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("payload");
        assertThatThrownBy(() -> rec.offer(oversized))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("payload");
        assertThat(rec.nextAck()).isEqualTo(-1);
        assertThat(rec.offer(frame(0))).isEqualTo(Disposition.DELIVERED);
        assertThat(rec.nextAck()).isZero();
    }

    @Test
    @DisplayName("resume rejects ACK values outside the supported sequence range")
    void resumeRejectsInvalidAck() {
        SessionIdentity same = identity("t1");
        for (int invalidAck : new int[]{-2, AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER + 1, Integer.MAX_VALUE}) {
            assertThatThrownBy(() -> StreamFrameReconciler.resume(same, same, invalidAck))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("last ACK");
        }
        StreamFrameReconciler exhausted = StreamFrameReconciler.resume(
                same, same, AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER);
        assertThat(exhausted.nextExpected()).isEqualTo(Integer.MAX_VALUE);
        assertThat(exhausted.nextAck()).isEqualTo(AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER);
        assertThat(exhausted.offer(frame(AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER)))
                .isEqualTo(Disposition.DUPLICATE);
    }

    @Test
    @DisplayName("the final legal frame is delivered and acknowledged before cursor exhaustion")
    void finalLegalFrameAdvancesToExhaustedCursor() {
        SessionIdentity same = identity("t1");
        StreamFrameReconciler reconciler = StreamFrameReconciler.resume(
                same, same, AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER - 1);

        assertThat(reconciler.offer(frame(AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER)))
                .isEqualTo(Disposition.DELIVERED);
        assertThat(reconciler.nextExpected()).isEqualTo(Integer.MAX_VALUE);
        assertThat(reconciler.nextAck()).isEqualTo(AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER);
    }
}
