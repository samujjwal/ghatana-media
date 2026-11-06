package com.ghatana.media.production.timeline;

import static com.ghatana.media.runtime.MediaProjectTimelineContracts.*;

import com.ghatana.media.runtime.MediaTimebase;
import com.ghatana.media.runtime.MediaVisualContracts.NormalizedBox;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.Collections;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;

/**
 * Version-bound, reversible ROI edit planning and CAS boundary.
 *
 * <p>This class consumes only caller-supplied tracked-region samples. It does not run CV, infer
 * missing observations, transform image pixels, or claim an edited media artifact. The opaque
 * {@link EditSnapshot} is the caller's immutable edit-state payload and metadata, not renderer output.
 * PDP-0 leaves exact edit geometry/profile and fidelity open, and the exact PDP-1 field mapping for
 * a tracked edit is not established. This local projection requires an explicit coordinate-context
 * reference and uses normalized boxes or explicitly supplied masks.</p>
 */
public final class ReversibleRegionEditEngine {
    private static final int MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
    private static final int MAX_TRACKED_SAMPLES = 10_000;
    private static final int MAX_SNAPSHOT_METADATA_ENTRIES = 256;
    private static final int MAX_SNAPSHOT_METADATA_KEY_CHARS = 256;
    private static final int MAX_SNAPSHOT_METADATA_VALUE_CHARS = 4_096;
    private static final int MAX_SNAPSHOT_METADATA_UTF8_BYTES = 1_048_576;
    private static final double BOX_EPSILON = 1.0e-9;

    private final RegionEditStore store;
    private final FreshRightsAuthority rights;

    public ReversibleRegionEditEngine(RegionEditStore store, FreshRightsAuthority rights) {
        this.store = Objects.requireNonNull(store, "store");
        this.rights = Objects.requireNonNull(rights, "rights");
    }

    /** Validate source-bound explicit tracking evidence and make a plan; no project state is changed. */
    public RegionEditPlan prepare(Actor actor, EditRequest request) {
        Objects.requireNonNull(actor, "actor");
        Objects.requireNonNull(request, "request");
        if (request.evidence() == null || request.evidence().samples().isEmpty()) {
            throw new UnsupportedTrackingException("tracked-region evidence is absent");
        }
        if (!request.evidence().source().equals(request.source())
                || !request.evidence().sourceSha256().equals(request.sourceSha256())
                || !request.evidence().regionId().equals(request.regionId())) {
            throw new RegionMappingConflictException("tracking evidence does not bind the exact source version and digest");
        }
        validateSamples(request.sourceTimebase(), request.evidence());
        verifyRights(actor, request.source(), request.sourceSha256(), request.purpose(), request.regionId(),
                request.evidence().samples());
        return new RegionEditPlan(actor.tenantId(), actor.principalId(), request.projectId(), request.editPlanId(),
                request.expectedRevisionId(), request.source(), request.sourceSha256(), request.purpose(),
                request.regionId(), request.sourceTimebase(), request.evidence(), request.intent());
    }

    /**
     * Commit an explicitly supplied immutable edit-state snapshot. The store must atomically enforce
     * tenant/principal scope, expected revision, and request idempotency. This method does not render.
     */
    public EditRevision apply(Actor actor, RegionEditPlan plan, String expectedRevisionId,
                              String requestId, EditSnapshot afterState) {
        requireOwner(actor, plan);
        if (!plan.expectedRevisionId().equals(required(expectedRevisionId, "expectedRevisionId"))) {
            throw new RevisionConflictException(plan.expectedRevisionId(), expectedRevisionId);
        }
        Objects.requireNonNull(afterState, "afterState");
        validateSamples(plan.sourceTimebase(), plan.evidence());
        verifyRights(actor, plan.source(), plan.sourceSha256(), plan.purpose(), plan.regionId(), plan.evidence().samples());
        return store.commit(actor, plan, expectedRevisionId, requestId(requestId), afterState);
    }

    /**
     * Conditional undo of one exact current revision. The authority appends a new revision that
     * carries the target's retained parent bytes and metadata; it never rewinds or reuses a revision id.
     */
    public EditRevision undo(Actor actor, String projectId, String targetRevisionId,
                             String expectedCurrentRevisionId, String requestId) {
        EditRevision target = store.revision(actor, projectId, targetRevisionId);
        verifyRights(actor, target.source(), target.sourceSha256(), target.purpose(), target.regionId(),
                target.evidence().samples());
        return store.undo(actor, projectId, targetRevisionId,
                required(expectedCurrentRevisionId, "expectedCurrentRevisionId"), requestId(requestId));
    }

    private void verifyRights(Actor actor, SourceVersion source, String sha256, String purpose, String regionId,
                              List<TrackedSample> samples) {
        RightsDecision decision;
        try {
            decision = rights.inspect(actor, source, sha256, purpose, regionId, samples);
        } catch (RuntimeException unavailable) {
            throw new RightsAuthorityUnavailableException();
        }
        if (decision == null || decision == RightsDecision.UNKNOWN) throw new RightsAuthorityUnavailableException();
        switch (decision) {
            case ELIGIBLE -> { }
            case MISSING -> throw new SourceRevisionMissingException();
            case STALE -> throw new StaleSourceRevisionException();
            case REVOKED, DENIED -> throw new RegionRightsDeniedException();
            case UNKNOWN -> throw new RightsAuthorityUnavailableException();
        }
    }

    private static void requireOwner(Actor actor, RegionEditPlan plan) {
        Objects.requireNonNull(actor, "actor");
        Objects.requireNonNull(plan, "plan");
        if (!actor.tenantId().equals(plan.tenantId())) throw new ProjectNotFoundException();
        if (!actor.principalId().equals(plan.ownerPrincipalId())) throw new ProjectAccessDeniedException();
    }

    private static void validateSamples(MediaTimebase timebase, TrackingEvidence evidence) {
        Objects.requireNonNull(timebase, "timebase");
        if (evidence.samples().size() > MAX_TRACKED_SAMPLES) {
            throw new IllegalArgumentException("tracked samples exceed the 10000-frame local bound");
        }
        long previous = -1;
        for (TrackedSample sample : evidence.samples()) {
            MediaTimebase.Timestamp pts = sample.sourcePts();
            if (pts.domain() != MediaTimebase.ClockDomain.SOURCE || !pts.timebase().equals(timebase)) {
                throw new IllegalArgumentException("tracked sample must use the exact source presentation clock");
            }
            if (pts.ticks() <= previous) throw new IllegalArgumentException("source presentation timestamps must strictly increase");
            previous = pts.ticks();
            validateMapping(sample);
        }
    }

    private static void validateMapping(TrackedSample sample) {
        if (sample.originalToEdited().isIdentity()
                && !sample.sourceCoordinateContextRef().equals(sample.editedCoordinateContextRef())) {
            throw new RegionMappingConflictException("identity transform cannot change coordinate context");
        }
        RegionShape source = sample.sourceShape();
        RegionShape edited = sample.editedShape();
        if (source instanceof BoxShape sourceBox && edited instanceof BoxShape editedBox) {
            NormalizedBox mapped = sample.originalToEdited().map(sourceBox.box());
            if (!near(mapped.x(), editedBox.box().x()) || !near(mapped.y(), editedBox.box().y())
                    || !near(mapped.width(), editedBox.box().width()) || !near(mapped.height(), editedBox.box().height())) {
                throw new RegionMappingConflictException("caller-supplied edited box drifts from the declared frame transform");
            }
            return;
        }
        if (source instanceof MaskShape sourceMask && edited instanceof MaskShape editedMask) {
            if (!sample.originalToEdited().isIdentity()) {
                throw new UnsupportedRegionMappingException(
                        "mask warping is unsupported; supply explicit per-PTS mask samples in one coordinate context");
            }
            if (!sourceMask.equals(editedMask)) {
                throw new RegionMappingConflictException("mask bytes or dimensions drift without an explicit transform mapping");
            }
            return;
        }
        throw new UnsupportedRegionMappingException("region shape conversion is unsupported without an explicit mapping");
    }

    private static boolean near(double left, double right) { return Math.abs(left - right) <= BOX_EPSILON; }

    private static String digest(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is required by the JDK", impossible);
        }
    }

    public enum EditIntent { MOVE_OR_RESIZE_REGION, ADJUST_MASK_BOUNDARY }
    public enum RightsDecision { ELIGIBLE, MISSING, STALE, REVOKED, DENIED, UNKNOWN }

    @FunctionalInterface
    public interface FreshRightsAuthority {
        RightsDecision inspect(Actor actor, SourceVersion exactSource, String sourceSha256, String purpose,
                              String regionId, List<TrackedSample> exactSamples);
    }

    /**
     * Local draft owner must atomically fence edits and idempotency; this port does not imply a
     * canonical project commit. Commit binds the exact current editor revision and returns the
     * original revision receipt for an exact request replay. Undo requires targetRevisionId to equal
     * expectedCurrentRevisionId and appends a new revision containing the exact retained parent
     * snapshot. Both operations reject requestId payload rebinding.
     */
    public interface RegionEditStore {
        EditRevision revision(Actor actor, String projectId, String revisionId);
        EditRevision commit(Actor actor, RegionEditPlan plan, String expectedRevisionId,
                            String requestId, EditSnapshot afterState);
        EditRevision undo(Actor actor, String projectId, String targetRevisionId,
                          String expectedCurrentRevisionId, String requestId);
    }

    public record EditRequest(String projectId, String editPlanId, String expectedRevisionId, SourceVersion source,
                              String sourceSha256, String purpose, String regionId,
                              MediaTimebase sourceTimebase, TrackingEvidence evidence, EditIntent intent) {
        public EditRequest {
            projectId = required(projectId, "projectId");
            editPlanId = required(editPlanId, "editPlanId");
            expectedRevisionId = required(expectedRevisionId, "expectedRevisionId");
            Objects.requireNonNull(source, "source");
            sourceSha256 = requireSha256(sourceSha256);
            purpose = required(purpose, "purpose");
            regionId = required(regionId, "regionId");
            Objects.requireNonNull(sourceTimebase, "sourceTimebase");
            Objects.requireNonNull(intent, "intent");
        }
    }

    /** An exact observed/caller-authored region path; no interpolation or CV claim is implicit. */
    public record TrackingEvidence(String evidenceRef, SourceVersion source, String sourceSha256,
                                   String regionId, List<TrackedSample> samples) {
        public TrackingEvidence {
            evidenceRef = required(evidenceRef, "evidenceRef");
            Objects.requireNonNull(source, "source");
            sourceSha256 = requireSha256(sourceSha256);
            regionId = required(regionId, "regionId");
            if (samples != null && samples.size() > MAX_TRACKED_SAMPLES) {
                throw new IllegalArgumentException("tracked samples exceed the 10000-frame local bound");
            }
            samples = List.copyOf(samples == null ? List.of() : samples);
        }
    }

    public record TrackedSample(MediaTimebase.Timestamp sourcePts, String sourceCoordinateContextRef,
                                String editedCoordinateContextRef, RegionShape sourceShape,
                                RegionShape editedShape, AffineTransform originalToEdited) {
        public TrackedSample {
            Objects.requireNonNull(sourcePts, "sourcePts");
            sourceCoordinateContextRef = required(sourceCoordinateContextRef, "sourceCoordinateContextRef");
            editedCoordinateContextRef = required(editedCoordinateContextRef, "editedCoordinateContextRef");
            Objects.requireNonNull(sourceShape, "sourceShape");
            Objects.requireNonNull(editedShape, "editedShape");
            Objects.requireNonNull(originalToEdited, "originalToEdited");
        }
    }

    public sealed interface RegionShape permits BoxShape, MaskShape { }

    public record BoxShape(NormalizedBox box) implements RegionShape {
        public BoxShape { Objects.requireNonNull(box, "box"); }
    }

    /** Explicit row-major binary mask. The mask is a tracked-region input, never a generated model result. */
    public static final class MaskShape implements RegionShape {
        private final int width;
        private final int height;
        private final byte[] occupancy;
        public MaskShape(int width, int height, byte[] occupancy) {
            if (width < 1 || height < 1 || (long) width * height > 16_777_216L) {
                throw new IllegalArgumentException("mask dimensions are invalid or exceed the local pixel bound");
            }
            byte[] source = Objects.requireNonNull(occupancy, "occupancy");
            if (source.length != (long) width * height) throw new IllegalArgumentException("mask byte count must equal width × height");
            byte[] copy = source.clone();
            for (byte bit : copy) if (bit != 0 && bit != 1) throw new IllegalArgumentException("mask occupancy bytes must be 0 or 1");
            this.width = width;
            this.height = height;
            this.occupancy = copy;
        }
        public int width() { return width; }
        public int height() { return height; }
        public byte[] occupancy() { return occupancy.clone(); }
        @Override public boolean equals(Object other) {
            return other instanceof MaskShape mask && width == mask.width && height == mask.height
                    && Arrays.equals(occupancy, mask.occupancy);
        }
        @Override public int hashCode() { return 31 * Objects.hash(width, height) + Arrays.hashCode(occupancy); }
    }

    /** Affine normalized-coordinate transform from the original to edited frame space. */
    public record AffineTransform(double m00, double m01, double m10, double m11, double tx, double ty) {
        public AffineTransform {
            if (!Double.isFinite(m00) || !Double.isFinite(m01) || !Double.isFinite(m10)
                    || !Double.isFinite(m11) || !Double.isFinite(tx) || !Double.isFinite(ty)) {
                throw new IllegalArgumentException("affine transform values must be finite");
            }
        }
        public static AffineTransform identity() { return new AffineTransform(1, 0, 0, 1, 0, 0); }
        public boolean isIdentity() { return m00 == 1 && m01 == 0 && m10 == 0 && m11 == 1 && tx == 0 && ty == 0; }
        public NormalizedBox map(NormalizedBox box) {
            double x2 = box.x() + box.width(), y2 = box.y() + box.height();
            double[] xs = {m00 * box.x() + m01 * box.y() + tx, m00 * x2 + m01 * box.y() + tx,
                    m00 * box.x() + m01 * y2 + tx, m00 * x2 + m01 * y2 + tx};
            double[] ys = {m10 * box.x() + m11 * box.y() + ty, m10 * x2 + m11 * box.y() + ty,
                    m10 * box.x() + m11 * y2 + ty, m10 * x2 + m11 * y2 + ty};
            double minX = Arrays.stream(xs).min().orElseThrow(), maxX = Arrays.stream(xs).max().orElseThrow();
            double minY = Arrays.stream(ys).min().orElseThrow(), maxY = Arrays.stream(ys).max().orElseThrow();
            return new NormalizedBox(minX, minY, maxX - minX, maxY - minY);
        }
    }

    public record RegionEditPlan(String tenantId, String ownerPrincipalId, String projectId, String editPlanId,
                                 String expectedRevisionId, SourceVersion source, String sourceSha256,
                                 String purpose, String regionId, MediaTimebase sourceTimebase,
                                 TrackingEvidence evidence, EditIntent intent) {
        public RegionEditPlan {
            tenantId = required(tenantId, "tenantId");
            ownerPrincipalId = required(ownerPrincipalId, "ownerPrincipalId");
            projectId = required(projectId, "projectId");
            editPlanId = required(editPlanId, "editPlanId");
            expectedRevisionId = required(expectedRevisionId, "expectedRevisionId");
            Objects.requireNonNull(source, "source");
            sourceSha256 = requireSha256(sourceSha256);
            purpose = required(purpose, "purpose");
            regionId = required(regionId, "regionId");
            Objects.requireNonNull(sourceTimebase, "sourceTimebase");
            Objects.requireNonNull(evidence, "evidence");
            Objects.requireNonNull(intent, "intent");
            if (!source.equals(evidence.source()) || !sourceSha256.equals(evidence.sourceSha256())
                    || !regionId.equals(evidence.regionId())) {
                throw new IllegalArgumentException("plan must preserve exact source and region evidence identity");
            }
            validateSamples(sourceTimebase, evidence);
        }
    }

    /** Opaque authored project/edit state. It is not a decoded or edited image/video payload claim. */
    public static final class EditSnapshot {
        private final byte[] bytes;
        private final Map<String, String> metadata;
        public EditSnapshot(byte[] bytes, Map<String, String> metadata) {
            byte[] source = Objects.requireNonNull(bytes, "bytes");
            if (source.length > MAX_SNAPSHOT_BYTES) throw new IllegalArgumentException("edit snapshot exceeds byte bound");
            byte[] copy = source.clone();
            TreeMap<String, String> sorted = new TreeMap<>();
            if (metadata != null && metadata.size() > MAX_SNAPSHOT_METADATA_ENTRIES) {
                throw new IllegalArgumentException("edit snapshot metadata exceeds entry bound");
            }
            int metadataBytes = 0;
            if (metadata != null) {
                for (Map.Entry<String, String> entry : metadata.entrySet()) {
                    String key = required(entry.getKey(), "metadata key");
                    String value = Objects.requireNonNull(entry.getValue(), "metadata value");
                    if (key.length() > MAX_SNAPSHOT_METADATA_KEY_CHARS
                            || value.length() > MAX_SNAPSHOT_METADATA_VALUE_CHARS) {
                        throw new IllegalArgumentException("edit snapshot metadata field exceeds character bound");
                    }
                    metadataBytes = Math.addExact(metadataBytes,
                            key.getBytes(java.nio.charset.StandardCharsets.UTF_8).length);
                    metadataBytes = Math.addExact(metadataBytes,
                            value.getBytes(java.nio.charset.StandardCharsets.UTF_8).length);
                    if (metadataBytes > MAX_SNAPSHOT_METADATA_UTF8_BYTES) {
                        throw new IllegalArgumentException("edit snapshot metadata exceeds encoded byte bound");
                    }
                    sorted.put(key, value);
                }
            }
            this.bytes = copy;
            this.metadata = Collections.unmodifiableMap(sorted);
        }
        public byte[] bytes() { return bytes.clone(); }
        public Map<String, String> metadata() { return metadata; }
        public String sha256() { return digest(bytes); }
        @Override public boolean equals(Object other) {
            return other instanceof EditSnapshot snapshot && Arrays.equals(bytes, snapshot.bytes)
                    && metadata.equals(snapshot.metadata);
        }
        @Override public int hashCode() { return 31 * Arrays.hashCode(bytes) + metadata.hashCode(); }
    }

    public record EditRevision(String tenantId, String ownerPrincipalId, String projectId, String revisionId, String parentRevisionId,
                               String planId, SourceVersion source, String sourceSha256, String purpose,
                               String regionId, TrackingEvidence evidence, EditSnapshot snapshot,
                               String restoresRevisionId) {
        public EditRevision {
            tenantId = required(tenantId, "tenantId");
            ownerPrincipalId = required(ownerPrincipalId, "ownerPrincipalId");
            projectId = required(projectId, "projectId");
            revisionId = required(revisionId, "revisionId");
            parentRevisionId = parentRevisionId == null ? null : required(parentRevisionId, "parentRevisionId");
            planId = required(planId, "planId");
            Objects.requireNonNull(source, "source");
            sourceSha256 = requireSha256(sourceSha256);
            purpose = required(purpose, "purpose");
            regionId = required(regionId, "regionId");
            Objects.requireNonNull(evidence, "evidence");
            Objects.requireNonNull(snapshot, "snapshot");
            restoresRevisionId = restoresRevisionId == null ? null : required(restoresRevisionId, "restoresRevisionId");
        }
    }

    public static class UnsupportedTrackingException extends IllegalStateException {
        public UnsupportedTrackingException(String message) { super(message); }
    }
    public static class UnsupportedRegionMappingException extends IllegalArgumentException {
        public UnsupportedRegionMappingException(String message) { super(message); }
    }
    public static class RegionMappingConflictException extends IllegalArgumentException {
        public RegionMappingConflictException(String message) { super(message); }
    }
    public static class SourceRevisionMissingException extends IllegalArgumentException {
        public SourceRevisionMissingException() { super("exact source artifact version is unavailable"); }
    }
    public static class StaleSourceRevisionException extends IllegalStateException {
        public StaleSourceRevisionException() { super("exact source version or digest is stale"); }
    }
    public static class RegionRightsDeniedException extends SecurityException {
        public RegionRightsDeniedException() { super("current rights do not permit this region edit"); }
    }
    public static class RightsAuthorityUnavailableException extends IllegalStateException {
        public RightsAuthorityUnavailableException() { super("fresh rights authority is unavailable or unknown"); }
    }
    public static class EditIdempotencyConflictException extends IllegalStateException {
        public EditIdempotencyConflictException() { super("edit requestId was reused with a different payload"); }
    }
    public static class EditRevisionNotFoundException extends IllegalArgumentException {
        public EditRevisionNotFoundException() { super("revision is not available in this project scope"); }
    }

    private static String requireSha256(String value) {
        String normalized = required(value, "sourceSha256").toLowerCase(java.util.Locale.ROOT);
        if (!normalized.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("sourceSha256 must be 64 hexadecimal characters");
        return normalized;
    }

    private static String requestId(String value) {
        String requestId = required(value, "requestId");
        if (!requestId.matches("[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}")) {
            throw new IllegalArgumentException("requestId must be a 1-128 character ASCII opaque key");
        }
        return requestId;
    }
}
