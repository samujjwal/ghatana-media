package com.ghatana.video.streaming;

import com.ghatana.video.streaming.VideoFrameReconciler.SessionIdentity;
import com.ghatana.video.streaming.VideoPrivacyGuard.AccessDeniedException;
import com.ghatana.video.streaming.VideoPrivacyGuard.BoundedFrameCache;
import com.ghatana.video.streaming.VideoPrivacyGuard.Classification;
import com.ghatana.video.streaming.VideoPrivacyGuard.FrameView;
import com.ghatana.video.streaming.VideoPrivacyGuard.ViewerScope;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

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

    private static ViewerScope viewer(Classification clearance) {
        return new ViewerScope("tenant-1", "principal-1", clearance);
    }

    private static BoundedFrameCache cache(int maxFrames, long maxBytes, long retentionMillis) {
        return new BoundedFrameCache(owner(), Classification.INTERNAL, maxFrames, maxBytes, retentionMillis);
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
        BoundedFrameCache cache = cache(3, 12, 60_000);
        cache.put(owner(), frame(0, 4), 0);
        cache.put(owner(), frame(1, 4), 1);
        cache.put(owner(), frame(2, 4), 2);
        // A stalled producer keeps writing — the cache stays at 3 frames/12 bytes.
        cache.put(owner(), frame(3, 4), 3);
        assertThat(cache.size()).isEqualTo(3);
        assertThat(cache.totalBytes()).isEqualTo(12);
        assertThat(cache.get(viewer(Classification.INTERNAL), 0, 4)).isNull(); // evicted oldest
        assertThat(cache.get(viewer(Classification.INTERNAL), 3, 4)).isNotNull();
    }

    @Test
    @DisplayName("byte bound evicts even under the frame-count limit")
    void byteBoundEnforced() {
        BoundedFrameCache cache = cache(100, 8, 60_000);
        cache.put(owner(), frame(0, 6), 0);
        cache.put(owner(), frame(1, 6), 1);
        assertThat(cache.totalBytes()).isLessThanOrEqualTo(8);
        assertThat(cache.get(viewer(Classification.INTERNAL), 0, 1)).isNull();
    }

    @Test
    @DisplayName("retention expiry drops stale frames on access")
    void retentionExpiry() {
        BoundedFrameCache cache = cache(10, 1024, 1_000);
        cache.put(owner(), frame(0, 4), 0);
        assertThat(cache.get(viewer(Classification.INTERNAL), 0, 2_000)).isNull();
        assertThat(cache.size()).isZero();
    }

    @Test
    @DisplayName("cancel purges every cached frame — no residue")
    void cancelPurges() {
        BoundedFrameCache cache = cache(10, 1024, 60_000);
        cache.put(owner(), frame(0, 4), 0);
        cache.put(owner(), frame(1, 4), 1);
        assertThat(cache.purge()).isEqualTo(2);
        assertThat(cache.size()).isZero();
        assertThat(cache.totalBytes()).isZero();
    }

    @Test
    @DisplayName("cache is bound to one tenant, principal and exact session revision")
    void cacheScopeIsBoundBeforeLookupOrMutation() {
        BoundedFrameCache cache = cache(10, 1024, 60_000);
        cache.put(owner(), frame(0, 4), 0);

        assertThatThrownBy(() -> cache.get(
                new ViewerScope("tenant-2", "principal-1", Classification.RESTRICTED), 0, 1))
                .isInstanceOf(AccessDeniedException.class)
                .hasMessageContaining("cross-tenant");
        assertThatThrownBy(() -> cache.get(
                new ViewerScope("tenant-1", "principal-2", Classification.RESTRICTED), 999, 1))
                .isInstanceOf(AccessDeniedException.class)
                .hasMessageContaining("cross-principal");
        assertThatThrownBy(() -> cache.put(
                new SessionIdentity("stream-1", "tenant-2", "principal-1", "purpose-1", 1),
                frame(1, 4), 2))
                .isInstanceOf(AccessDeniedException.class)
                .hasMessageContaining("scope mismatch");
        assertThatThrownBy(() -> cache.put(
                new SessionIdentity("stream-1", "tenant-1", "principal-1", "purpose-1", 2),
                frame(1, 4), 2))
                .isInstanceOf(AccessDeniedException.class)
                .hasMessageContaining("scope mismatch");
        assertThatThrownBy(() -> cache.put(
                new SessionIdentity("stream-1", "tenant-1", "principal-1", "purpose-2", 1),
                frame(1, 4), 2))
                .isInstanceOf(AccessDeniedException.class)
                .hasMessageContaining("scope mismatch");
        assertThat(cache.get(viewer(Classification.INTERNAL), 0, 1)).isNotNull();
        assertThat(cache.size()).isEqualTo(1);
    }

    @Test
    @DisplayName("cache snapshots and privacy views never expose mutable cached payload")
    void cacheAndViewPayloadsAreDefensiveCopies() {
        BoundedFrameCache cache = cache(10, 1024, 60_000);
        byte[] sourcePayload = "camera-token-frame-secret".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        VideoStreamSession.DecodedFrame source = new VideoStreamSession.DecodedFrame(
                7, true, 231L, sourcePayload);
        cache.put(owner(), source, 0);
        sourcePayload[0] = 0;

        var view = cache.get(viewer(Classification.INTERNAL), 7, 1);
        assertThat(view).isNotNull();
        assertThat(new String(view.payload(), java.nio.charset.StandardCharsets.UTF_8))
                .isEqualTo("camera-token-frame-secret");
        byte[] returned = view.payload();
        returned[0] = 0;
        assertThat(new String(cache.get(viewer(Classification.INTERNAL), 7, 2).payload(),
                java.nio.charset.StandardCharsets.UTF_8)).isEqualTo("camera-token-frame-secret");

        VideoPrivacyGuard guard = new VideoPrivacyGuard(owner(), Classification.INTERNAL);
        assertThat(guard.describeForLog(source)).doesNotContain("camera-token-frame-secret");
    }

    @Test
    @DisplayName("cache redacts lower-clearance reads and rejects entries larger than its byte budget")
    void cacheAppliesClassificationAndEntryBound() {
        BoundedFrameCache cache = new BoundedFrameCache(owner(), Classification.RESTRICTED, 10, 4, 60_000);
        cache.put(owner(), frame(0, 4), 0);
        assertThat(cache.get(viewer(Classification.INTERNAL), 0, 1).hasPayload()).isFalse();
        assertThat(cache.get(viewer(Classification.RESTRICTED), 0, 1).hasPayload()).isTrue();
        assertThatThrownBy(() -> cache.put(owner(), frame(1, 5), 2))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("cache bound");
        assertThat(cache.size()).isEqualTo(1);
        assertThat(cache.totalBytes()).isEqualTo(4);
    }

    @Test
    @DisplayName("replacement updates byte accounting and moves the key behind older entries")
    void replacingSequenceReconcilesBytesAndOrder() {
        BoundedFrameCache cache = cache(2, 10, 60_000);
        cache.put(owner(), frame(0, 2), 0);
        cache.put(owner(), frame(1, 3), 1);
        cache.put(owner(), frame(0, 4), 2);

        assertThat(cache.size()).isEqualTo(2);
        assertThat(cache.totalBytes()).isEqualTo(7);
        assertThat(cache.get(viewer(Classification.INTERNAL), 1, 3)).isNotNull();
        assertThat(cache.get(viewer(Classification.INTERNAL), 0, 3)).isNotNull();
        cache.put(owner(), frame(2, 4), 4);
        assertThat(cache.size()).isEqualTo(2);
        assertThat(cache.totalBytes()).isEqualTo(8);
        assertThat(cache.get(viewer(Classification.INTERNAL), 1, 5)).isNull();
        assertThat(cache.get(viewer(Classification.INTERNAL), 0, 5)).isNotNull();
        assertThat(cache.get(viewer(Classification.INTERNAL), 2, 5)).isNotNull();
    }

    @Test
    @DisplayName("concurrent cache writes preserve both entry and byte bounds")
    void concurrentWritersStayWithinBounds() throws Exception {
        BoundedFrameCache cache = cache(16, 64, 60_000);
        ExecutorService workers = Executors.newFixedThreadPool(8);
        try {
            var writes = java.util.stream.IntStream.range(0, 128)
                    .<Callable<Void>>mapToObj(sequence -> () -> {
                        cache.put(owner(), frame(sequence, 4), sequence);
                        return null;
                    }).toList();
            for (var result : workers.invokeAll(writes)) {
                result.get();
            }
        } finally {
            workers.shutdownNow();
        }

        assertThat(cache.size()).isEqualTo(16);
        assertThat(cache.totalBytes()).isEqualTo(64);
    }
}
