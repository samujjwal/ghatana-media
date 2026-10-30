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
    @DisplayName("cross-tenant and stale-revision resumes are denied")
    void resumeDeniedCrossTenantOrStaleRevision() {
        SessionIdentity durable = identity("t1");
        assertThatThrownBy(() -> StreamFrameReconciler.resume(
                identity("t2"), durable, 10))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("cross-tenant");
        SessionIdentity stale = new SessionIdentity(
                "stream-1", "t1", "principal-1", "purpose-1", 0);
        assertThatThrownBy(() -> StreamFrameReconciler.resume(stale, durable, 10))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("older session revision");
        assertThatThrownBy(() -> StreamFrameReconciler.resume(
                new SessionIdentity("other", "t1", "principal-1", "purpose-1", 1), durable, 10))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("streamId");
    }
}
