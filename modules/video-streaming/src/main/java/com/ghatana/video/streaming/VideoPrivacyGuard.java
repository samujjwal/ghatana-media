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

    /** Who is viewing — construct from a trusted authenticated context, never caller-supplied metadata. */
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
        public FrameView {
            payload = payload == null ? null : payload.clone();
        }

        public byte[] payload() {
            return payload == null ? null : payload.clone();
        }

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
        requireViewer(viewer);
        byte[] payload = frame.payload();
        if (payload == null || payload.length > VideoStreamSession.MAX_FRAME_PAYLOAD_BYTES) {
            throw new IllegalArgumentException("video frame payload is outside the bounded size");
        }
        boolean redacted = viewer.clearance().ordinal() < frameClassification.ordinal();
        return new FrameView(
                frame.sequenceNumber(), frame.keyFrame(), frame.timestampMillis(),
                redacted ? null : payload, redacted);
    }

    /** A log-safe projection — metadata only, never payload or credentials. */
    public String describeForLog(VideoStreamSession.DecodedFrame frame) {
        return "frame{seq=" + frame.sequenceNumber()
                + ",key=" + frame.keyFrame()
                + ",timestampMillis=" + frame.timestampMillis()
                + ",bytes=" + frame.payload().length + "}";
    }

    /**
     * Single-session frame cache bounded in entries and bytes with per-entry
     * retention. The owner identity and classification are fixed at creation;
     * callers cannot read or write under another session scope. Overflow evicts oldest first (bounded, never unbounded);
     * expired entries are dropped on access; {@link #purge()} on cancel
     * leaves no residue.
     */
    public static final class BoundedFrameCache {

        private final VideoFrameReconciler.SessionIdentity owner;
        private final Classification frameClassification;
        private final int maxFrames;
        private final long maxBytes;
        private final long retentionMillis;
        private final LinkedHashMap<Integer, Entry> entries = new LinkedHashMap<>();
        private long totalBytes;

        private record Entry(VideoStreamSession.DecodedFrame frame, long storedAtMillis) {
        }

        public BoundedFrameCache(
                VideoFrameReconciler.SessionIdentity owner,
                Classification frameClassification,
                int maxFrames, long maxBytes, long retentionMillis) {
            this.owner = Objects.requireNonNull(owner, "owner");
            this.frameClassification = Objects.requireNonNull(frameClassification, "frameClassification");
            if (maxFrames < 1 || maxBytes < 1 || retentionMillis < 1) {
                throw new IllegalArgumentException("cache bounds must be positive");
            }
            this.maxFrames = maxFrames;
            this.maxBytes = maxBytes;
            this.retentionMillis = retentionMillis;
        }

        /** Stores one frame for the bound session, evicting oldest entries to stay within bounds. */
        public synchronized void put(
                VideoFrameReconciler.SessionIdentity session,
                VideoStreamSession.DecodedFrame frame,
                long nowMillis) {
            requireOwner(session);
            Objects.requireNonNull(frame, "frame");
            byte[] payload = frame.payload();
            if (payload == null || payload.length > VideoStreamSession.MAX_FRAME_PAYLOAD_BYTES
                    || payload.length > maxBytes) {
                throw new IllegalArgumentException("video frame payload is outside the cache bound");
            }
            evictExpired(nowMillis);
            Entry replaced = entries.remove(frame.sequenceNumber());
            if (replaced != null) {
                totalBytes -= replaced.frame().payload().length;
            }
            while (entries.size() >= maxFrames || totalBytes > maxBytes - payload.length) {
                var eldest = entries.entrySet().iterator().next();
                totalBytes -= eldest.getValue().frame().payload().length;
                entries.remove(eldest.getKey());
            }
            VideoStreamSession.DecodedFrame snapshot = new VideoStreamSession.DecodedFrame(
                    frame.sequenceNumber(), frame.keyFrame(), frame.timestampMillis(), payload.clone());
            entries.put(frame.sequenceNumber(), new Entry(snapshot, nowMillis));
            totalBytes += payload.length;
        }

        /** Returns a scope-checked, classification-aware view, or null if absent/expired. */
        public synchronized FrameView get(ViewerScope viewer, int sequenceNumber, long nowMillis) {
            requireViewer(viewer);
            evictExpired(nowMillis);
            Entry entry = entries.get(sequenceNumber);
            return entry == null ? null
                    : new VideoPrivacyGuard(owner, frameClassification).viewOf(viewer, entry.frame());
        }

        /** Safe temp deletion on cancel — every cached frame is dropped. */
        public synchronized int purge() {
            int purged = entries.size();
            entries.clear();
            totalBytes = 0;
            return purged;
        }

        public synchronized int size() {
            return entries.size();
        }

        public synchronized long totalBytes() {
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

        private void requireOwner(VideoFrameReconciler.SessionIdentity session) {
            if (!owner.equals(session)) {
                throw new AccessDeniedException("cache session scope mismatch");
            }
        }

        private void requireViewer(ViewerScope viewer) {
            Objects.requireNonNull(viewer, "viewer");
            if (!owner.tenantId().equals(viewer.tenantId())) {
                throw new AccessDeniedException("cross-tenant view");
            }
            if (!owner.principalId().equals(viewer.principalId())) {
                throw new AccessDeniedException("cross-principal view");
            }
        }
    }

    private void requireViewer(ViewerScope viewer) {
        if (!owner.tenantId().equals(viewer.tenantId())) {
            throw new AccessDeniedException("cross-tenant view");
        }
        if (!owner.principalId().equals(viewer.principalId())) {
            throw new AccessDeniedException("cross-principal view");
        }
    }
}
