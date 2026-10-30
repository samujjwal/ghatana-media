package com.ghatana.video.streaming;

import com.ghatana.video.streaming.VideoFrameReconciler.SessionIdentity;
import com.ghatana.video.streaming.VideoPrivacyGuard.AccessDeniedException;
import com.ghatana.video.streaming.VideoPrivacyGuard.BoundedFrameCache;
import com.ghatana.video.streaming.VideoPrivacyGuard.Classification;
import com.ghatana.video.streaming.VideoPrivacyGuard.FrameView;
import com.ghatana.video.streaming.VideoPrivacyGuard.ViewerScope;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * VS-06: redaction by classification, tenant/principal scope denial, bounded
 * cache under stalls, retention expiry and residue-free cancel — and no
 * payload or credential in any view or log projection.
 */
@DisplayName("VideoPrivacyGuard")
class VideoPrivacyGuardTest {

    private static SessionIdentity owner() {
        return new SessionIdentity("stream-1", "tenant-1", "principal-1", "purpose-1", 1);
    }

    private static VideoStreamSession.DecodedFrame frame(int seq, int payloadSize) {
        return new VideoStreamSession.DecodedFrame(seq, false, seq * 33L, new byte[payloadSize]);
    }

    @Test
    @DisplayName("a RESTRICTED frame viewed below clearance is redacted — metadata only")
    void restrictedFrameRedacted() {
        VideoPrivacyGuard guard = new VideoPrivacyGuard(owner(), Classification.RESTRICTED);
        FrameView view = guard.viewOf(
                new ViewerScope("tenant-1", "principal-1", Classification.INTERNAL),
                frame(0, 16));
        assertThat(view.redacted()).isTrue();
        assertThat(view.hasPayload()).isFalse();
        assertThat(view.payload()).isNull();
        assertThat(view.sequenceNumber()).isEqualTo(0);
        assertThat(view.timestampMillis()).isEqualTo(0);
    }

    @Test
    @DisplayName("equal or higher clearance sees the payload; lower never does")
    void clearanceOrdering() {
        VideoPrivacyGuard guard = new VideoPrivacyGuard(owner(), Classification.CONFIDENTIAL);
        var frame = frame(1, 8);
        assertThat(guard.viewOf(new ViewerScope("tenant-1", "principal-1",
                Classification.CONFIDENTIAL), frame).hasPayload()).isTrue();
        assertThat(guard.viewOf(new ViewerScope("tenant-1", "principal-1",
                Classification.RESTRICTED), frame).hasPayload()).isTrue();
        assertThat(guard.viewOf(new ViewerScope("tenant-1", "principal-1",
                Classification.PUBLIC), frame).hasPayload()).isFalse();
    }

    @Test
    @DisplayName("cross-tenant and cross-principal frame access is denied outright")
    void scopeDenied() {
        VideoPrivacyGuard guard = new VideoPrivacyGuard(owner(), Classification.PUBLIC);
        var frame = frame(0, 4);
        assertThatThrownBy(() -> guard.viewOf(
                new ViewerScope("tenant-2", "principal-1", Classification.RESTRICTED), frame))
                .isInstanceOf(AccessDeniedException.class)
                .hasMessageContaining("cross-tenant");
        assertThatThrownBy(() -> guard.viewOf(
                new ViewerScope("tenant-1", "principal-2", Classification.RESTRICTED), frame))
                .isInstanceOf(AccessDeniedException.class)
                .hasMessageContaining("cross-principal");
    }

    @Test
    @DisplayName("log projection exposes metadata only — no payload, no credentials")
    void logSafe() {
        VideoPrivacyGuard guard = new VideoPrivacyGuard(owner(), Classification.PUBLIC);
        String described = guard.describeForLog(frame(7, 3));
        assertThat(described).contains("seq=7").contains("bytes=3");
        assertThat(described).doesNotContain("principal").doesNotContain("token");
    }

    @Test
    @DisplayName("bounded cache evicts oldest under a stall — memory stays within budget")
    void boundedUnderStall() {
        BoundedFrameCache cache = new BoundedFrameCache(3, 12, 60_000);
        cache.put(frame(0, 4), 0);
        cache.put(frame(1, 4), 1);
        cache.put(frame(2, 4), 2);
        // A stalled producer keeps writing — the cache stays at 3 frames/12 bytes.
        cache.put(frame(3, 4), 3);
        assertThat(cache.size()).isEqualTo(3);
        assertThat(cache.totalBytes()).isEqualTo(12);
        assertThat(cache.get(0, 4)).isNull(); // evicted oldest
        assertThat(cache.get(3, 4)).isNotNull();
    }

    @Test
    @DisplayName("byte bound evicts even under the frame-count limit")
    void byteBoundEnforced() {
        BoundedFrameCache cache = new BoundedFrameCache(100, 8, 60_000);
        cache.put(frame(0, 6), 0);
        cache.put(frame(1, 6), 1);
        assertThat(cache.totalBytes()).isLessThanOrEqualTo(8);
        assertThat(cache.get(0, 1)).isNull();
    }

    @Test
    @DisplayName("retention expiry drops stale frames on access")
    void retentionExpiry() {
        BoundedFrameCache cache = new BoundedFrameCache(10, 1024, 1_000);
        cache.put(frame(0, 4), 0);
        assertThat(cache.get(0, 2_000)).isNull();
        assertThat(cache.size()).isZero();
    }

    @Test
    @DisplayName("cancel purges every cached frame — no residue")
    void cancelPurges() {
        BoundedFrameCache cache = new BoundedFrameCache(10, 1024, 60_000);
        cache.put(frame(0, 4), 0);
        cache.put(frame(1, 4), 1);
        assertThat(cache.purge()).isEqualTo(2);
        assertThat(cache.size()).isZero();
        assertThat(cache.totalBytes()).isZero();
    }
}
