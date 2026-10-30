package com.ghatana.video.streaming;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Privacy, rights, budget and retention guard for captured video frames.
 *
 * <p>VS-06: a frame's payload is only visible to a viewer whose tenant and
 * principal match the owning session <em>and</em> whose clearance meets the
 * frame's classification. A RESTRICTED frame viewed under a lower clearance
 * yields a redacted view — metadata only, never payload bytes. Capture and
 * device credentials are never carried into any view or log projection.
 *
 * <p>The frame cache is bounded in frames and bytes, honours per-entry
 * retention, and purges on cancel — a stalled stream cannot grow memory
 * without bound and a cancelled session leaves no residue.
 *
 * @doc.type class
 * @doc.purpose Redaction, tenant scope, bounded cache and safe cancel for video
 * @doc.layer product
 * @doc.pattern Privacy Guard
 */
public final class VideoPrivacyGuard {

    /** PDP classification floor; ordered by sensitivity. */
    public enum Classification { PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED }

    /** Who is viewing — scope is tenant+principal bound, clearance-bounded. */
    public record ViewerScope(
            String tenantId, String principalId, Classification clearance) {
        public ViewerScope {
            Objects.requireNonNull(tenantId, "tenantId");
            Objects.requireNonNull(principalId, "principalId");
            Objects.requireNonNull(clearance, "clearance");
        }
    }

    /**
     * A frame view: payload is present only when the viewer is admitted at
     * full visibility; redacted views expose sequence/keyframe/PTS only.
     */
    public record FrameView(
            int sequenceNumber, boolean keyFrame, long timestampMillis,
            byte[] payload, boolean redacted) {
        public boolean hasPayload() {
            return payload != null;
        }
    }

    /** Thrown when a viewer outside the owning tenant/principal asks for a frame. */
    public static final class AccessDeniedException extends RuntimeException {
        AccessDeniedException(String what) {
            super("video frame access denied: " + what);
        }
    }

    private final VideoFrameReconciler.SessionIdentity owner;
    private final Classification frameClassification;

    public VideoPrivacyGuard(
            VideoFrameReconciler.SessionIdentity owner,
            Classification frameClassification) {
        this.owner = Objects.requireNonNull(owner, "owner");
        this.frameClassification = Objects.requireNonNull(frameClassification, "frameClassification");
    }

    /**
     * Projects one frame for a viewer. Cross-tenant or cross-principal views
     * are denied outright; a viewer below the frame's classification gets a
     * redacted metadata-only view. No credentials ever appear in a view.
     */
    public FrameView viewOf(ViewerScope viewer, VideoStreamSession.DecodedFrame frame) {
        Objects.requireNonNull(viewer, "viewer");
        Objects.requireNonNull(frame, "frame");
        if (!viewer.tenantId().equals(owner.tenantId())) {
            throw new AccessDeniedException("cross-tenant view");
        }
        if (!viewer.principalId().equals(owner.principalId())) {
            throw new AccessDeniedException("cross-principal view");
        }
        boolean redacted = viewer.clearance().ordinal() < frameClassification.ordinal();
        return new FrameView(
                frame.sequenceNumber(), frame.keyFrame(), frame.timestampMillis(),
                redacted ? null : frame.payload(), redacted);
    }

    /** A log-safe projection — metadata only, never payload or credentials. */
    public String describeForLog(VideoStreamSession.DecodedFrame frame) {
        return "frame{seq=" + frame.sequenceNumber()
                + ",key=" + frame.keyFrame()
                + ",pts=" + frame.timestampMillis()
                + ",bytes=" + frame.payload().length + "}";
    }

    /**
     * Tenant-scoped frame cache bounded in entries and bytes with per-entry
     * retention. Overflow evicts oldest first (bounded, never unbounded);
     * expired entries are dropped on access; {@link #purge()} on cancel
     * leaves no residue.
     */
    public static final class BoundedFrameCache {

        private final int maxFrames;
        private final long maxBytes;
        private final long retentionMillis;
        private final LinkedHashMap<Integer, Entry> entries = new LinkedHashMap<>();
        private long totalBytes;

        private record Entry(VideoStreamSession.DecodedFrame frame, long storedAtMillis) {
        }

        public BoundedFrameCache(int maxFrames, long maxBytes, long retentionMillis) {
            if (maxFrames < 1 || maxBytes < 1 || retentionMillis < 1) {
                throw new IllegalArgumentException("cache bounds must be positive");
            }
            this.maxFrames = maxFrames;
            this.maxBytes = maxBytes;
            this.retentionMillis = retentionMillis;
        }

        /** Stores one frame, evicting oldest entries to stay within bounds. */
        public void put(VideoStreamSession.DecodedFrame frame, long nowMillis) {
            Objects.requireNonNull(frame, "frame");
            evictExpired(nowMillis);
            entries.put(frame.sequenceNumber(), new Entry(frame, nowMillis));
            totalBytes += frame.payload().length;
            while (entries.size() > maxFrames || totalBytes > maxBytes) {
                var eldest = entries.entrySet().iterator().next();
                totalBytes -= eldest.getValue().frame().payload().length;
                entries.remove(eldest.getKey());
            }
        }

        /** Returns the frame if present and within retention, else null. */
        public VideoStreamSession.DecodedFrame get(int sequenceNumber, long nowMillis) {
            evictExpired(nowMillis);
            Entry entry = entries.get(sequenceNumber);
            return entry == null ? null : entry.frame();
        }

        /** Safe temp deletion on cancel — every cached frame is dropped. */
        public int purge() {
            int purged = entries.size();
            entries.clear();
            totalBytes = 0;
            return purged;
        }

        public int size() {
            return entries.size();
        }

        public long totalBytes() {
            return totalBytes;
        }

        private void evictExpired(long nowMillis) {
            var it = entries.entrySet().iterator();
            while (it.hasNext()) {
                var entry = it.next();
                if (nowMillis - entry.getValue().storedAtMillis() > retentionMillis) {
                    totalBytes -= entry.getValue().frame().payload().length;
                    it.remove();
                }
            }
        }
    }
}
