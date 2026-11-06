package com.ghatana.media.production.spatial;

import java.math.BigInteger;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashMap;
import java.util.HashSet;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Iterator;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import java.util.function.Predicate;

/** Bounded immutable skeleton evaluation and explicitly declared coordinate re-expression. */
public final class SpatialRigEngine {
    public static final int MAX_BONES = 512;
    public static final int MAX_TRACKS_PER_BONE = 256;
    public static final int MAX_SOURCE_VERSIONS = 256;
    public static final int MAX_DEPTH = 64;
    public static final int MAX_GLB_BYTES = 16 * 1024 * 1024;
    public static final double MAX_POSITION = 1_000_000.0;
    /** Explicit local export profile; not a canonical PDP unit identity. */
    public static final String GLB_METRE_UNIT_REF = "urn:media:spatial:unit:metre:v1";
    public static final String GLB_QUATERNION_UNIT_REF = "urn:media:spatial:orientation:unit-quaternion-xyzw:v1";
    private static final List<String> GLB_FLOAT32_LOSS_FIELDS = List.of(
            "animation.inputTimeSeconds", "animation.outputTranslation", "animation.outputRotation");
    private static final double EPSILON = 1e-10;

    public enum Handedness { RIGHT_HANDED, LEFT_HANDED }
    public enum AxisDirection {
        POS_X(0, 1), NEG_X(0, -1), POS_Y(1, 1), NEG_Y(1, -1), POS_Z(2, 1), NEG_Z(2, -1);
        private final int axis;
        private final int sign;
        AxisDirection(int axis, int sign) { this.axis = axis; this.sign = sign; }
    }
    public enum TransformOperation { REEXPRESS_SIGNED_ORTHONORMAL_AXES }
    public enum JointKind { BALL }
    public enum RightsOutcome { ELIGIBLE, REVOKED, UNKNOWN }
    @FunctionalInterface public interface ExactFrameResolver {
        CoordinateFrame resolve(String frameRef, String frameVersionRef);
    }
    @FunctionalInterface public interface SourceRightsPort {
        RightsOutcome current(SourceVersionRef exactSourceVersion);
    }

    public record Vec3(double x, double y, double z) {
        public static final Vec3 ZERO = new Vec3(0, 0, 0);
        public Vec3 {
            finiteBounded(x, "x"); finiteBounded(y, "y"); finiteBounded(z, "z");
        }
        public Vec3 add(Vec3 other) { return new Vec3(x + other.x, y + other.y, z + other.z); }
        public Vec3 subtract(Vec3 other) { return new Vec3(x - other.x, y - other.y, z - other.z); }
        public Vec3 scale(double factor) {
            if (!Double.isFinite(factor) || Math.abs(factor) > MAX_POSITION) throw new IllegalArgumentException("vector scale is outside bounds");
            return new Vec3(x * factor, y * factor, z * factor);
        }
        public double length() { return Math.sqrt(x * x + y * y + z * z); }
        public double dot(Vec3 other) { return x * other.x + y * other.y + z * other.z; }
        public Vec3 cross(Vec3 other) { return new Vec3(y * other.z - z * other.y, z * other.x - x * other.z, x * other.y - y * other.x); }
        public Vec3 normalized() {
            double length = length();
            if (length < EPSILON) throw new IllegalArgumentException("zero vector cannot be normalized");
            return scale(1.0 / length);
        }
        private static void finiteBounded(double value, String label) {
            if (!Double.isFinite(value) || Math.abs(value) > MAX_POSITION) throw new IllegalArgumentException(label + " must be finite and within bounds");
        }
    }

    /** Canonical normalized XYZW unit quaternion. */
    public record Quaternion(double x, double y, double z, double w) {
        public static final Quaternion IDENTITY = new Quaternion(0, 0, 0, 1);
        public Quaternion {
            if (!Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(z) || !Double.isFinite(w)) {
                throw new IllegalArgumentException("quaternion components must be finite");
            }
            double norm = Math.sqrt(x * x + y * y + z * z + w * w);
            if (norm < EPSILON || norm > 1e6) throw new IllegalArgumentException("quaternion norm is outside bounds");
            x /= norm; y /= norm; z /= norm; w /= norm;
            if (w < 0 || (w == 0 && (z < 0 || (z == 0 && (y < 0 || (y == 0 && x < 0)))))) {
                x = -x; y = -y; z = -z; w = -w;
            }
        }
        public Quaternion multiply(Quaternion other) {
            return new Quaternion(
                    w * other.x + x * other.w + y * other.z - z * other.y,
                    w * other.y - x * other.z + y * other.w + z * other.x,
                    w * other.z + x * other.y - y * other.x + z * other.w,
                    w * other.w - x * other.x - y * other.y - z * other.z);
        }
        public Quaternion inverse() { return new Quaternion(-x, -y, -z, w); }
        public Vec3 rotate(Vec3 value) {
            Vec3 q = new Vec3(x, y, z);
            Vec3 t = q.cross(value).scale(2.0);
            return value.add(t.scale(w)).add(q.cross(t));
        }
        public Quaternion slerp(Quaternion other, double alpha) {
            if (!Double.isFinite(alpha) || alpha < 0 || alpha > 1) throw new IllegalArgumentException("interpolation fraction must be within [0,1]");
            double dot = x * other.x + y * other.y + z * other.z + w * other.w;
            double ox = other.x, oy = other.y, oz = other.z, ow = other.w;
            if (dot < 0) { dot = -dot; ox = -ox; oy = -oy; oz = -oz; ow = -ow; }
            if (dot > 0.9995) return new Quaternion(x + alpha * (ox - x), y + alpha * (oy - y), z + alpha * (oz - z), w + alpha * (ow - w));
            double theta = Math.acos(Math.min(1, Math.max(-1, dot)));
            double sin = Math.sin(theta);
            double a = Math.sin((1 - alpha) * theta) / sin;
            double b = Math.sin(alpha * theta) / sin;
            return new Quaternion(a * x + b * ox, a * y + b * oy, a * z + b * oz, a * w + b * ow);
        }
        public double angularDistance(Quaternion other) {
            double dot = Math.abs(x * other.x + y * other.y + z * other.z + w * other.w);
            return 2 * Math.acos(Math.min(1, dot));
        }
    }

    public record CoordinateFrame(String frameRef, String frameVersionRef, Handedness handedness,
            AxisDirection xAxis, AxisDirection yAxis, AxisDirection zAxis,
            String positionUnitRef, String orientationUnitRef) {
        public CoordinateFrame {
            frameRef = required(frameRef, "frameRef"); frameVersionRef = required(frameVersionRef, "frameVersionRef");
            Objects.requireNonNull(handedness, "handedness"); Objects.requireNonNull(xAxis, "xAxis");
            Objects.requireNonNull(yAxis, "yAxis"); Objects.requireNonNull(zAxis, "zAxis");
            positionUnitRef = required(positionUnitRef, "positionUnitRef");
            orientationUnitRef = required(orientationUnitRef, "orientationUnitRef");
            if (xAxis.axis == yAxis.axis || xAxis.axis == zAxis.axis || yAxis.axis == zAxis.axis) {
                throw new IllegalArgumentException("coordinate axes must span three distinct basis dimensions");
            }
            int determinant = determinant(basis(xAxis, yAxis, zAxis));
            Handedness actual = determinant > 0 ? Handedness.RIGHT_HANDED : Handedness.LEFT_HANDED;
            if (actual != handedness) throw new IllegalArgumentException("declared handedness contradicts signed-axis basis");
        }
        public String identity() { return frameRef + "@" + frameVersionRef; }
    }

    public record TransformDeclaration(String planRef, String planVersionRef, CoordinateFrame source,
            CoordinateFrame target, List<TransformOperation> orderedOperations, String mappingRef) {
        public TransformDeclaration {
            planRef = required(planRef, "planRef"); planVersionRef = required(planVersionRef, "planVersionRef");
            Objects.requireNonNull(source, "source"); Objects.requireNonNull(target, "target");
            orderedOperations = List.copyOf(Objects.requireNonNull(orderedOperations, "orderedOperations"));
            if (!orderedOperations.equals(List.of(TransformOperation.REEXPRESS_SIGNED_ORTHONORMAL_AXES))) {
                throw new IllegalArgumentException("only the explicitly supported signed-axis re-expression plan is executable");
            }
            mappingRef = required(mappingRef, "mappingRef");
            if (!source.positionUnitRef().equals(target.positionUnitRef())) throw new IllegalArgumentException("position-unit conversion is not supported by this profile");
            if (!source.orientationUnitRef().equals(target.orientationUnitRef())) throw new IllegalArgumentException("orientation-unit conversion is not supported by this profile");
        }
    }

    public record SourceVersionRef(String tenantId, String artifactId, String versionId) {
        public SourceVersionRef {
            tenantId = required(tenantId, "tenantId"); artifactId = required(artifactId, "artifactId"); versionId = required(versionId, "versionId");
        }
    }
    public record LocalTransform(Vec3 position, Quaternion orientation) {
        public LocalTransform { Objects.requireNonNull(position, "position"); Objects.requireNonNull(orientation, "orientation"); }
        public static LocalTransform identity() { return new LocalTransform(Vec3.ZERO, Quaternion.IDENTITY); }
    }
    public record JointConstraint(JointKind kind, double maxAngularDeviationRadians) {
        public JointConstraint {
            Objects.requireNonNull(kind, "kind");
            if (!Double.isFinite(maxAngularDeviationRadians) || maxAngularDeviationRadians < 0 || maxAngularDeviationRadians > Math.PI) {
                throw new IllegalArgumentException("joint angular bound must be within [0, pi]");
            }
        }
    }
    public record Bone(String id, String parentId, LocalTransform restPose, JointConstraint constraint) {
        public Bone {
            id = required(id, "bone.id");
            if (parentId != null) parentId = required(parentId, "bone.parentId");
            Objects.requireNonNull(restPose, "restPose"); Objects.requireNonNull(constraint, "constraint");
        }
    }
    public record RationalTime(BigInteger numerator, BigInteger denominator) implements Comparable<RationalTime> {
        public RationalTime {
            Objects.requireNonNull(numerator, "numerator"); Objects.requireNonNull(denominator, "denominator");
            if (denominator.signum() <= 0 || numerator.signum() < 0 || numerator.bitLength() > 63 || denominator.bitLength() > 63) {
                throw new IllegalArgumentException("time must be nonnegative and use bounded positive rational components");
            }
            BigInteger gcd = numerator.gcd(denominator); numerator = numerator.divide(gcd); denominator = denominator.divide(gcd);
        }
        public static RationalTime of(long numerator, long denominator) { return new RationalTime(BigInteger.valueOf(numerator), BigInteger.valueOf(denominator)); }
        @Override public int compareTo(RationalTime other) { return numerator.multiply(other.denominator).compareTo(other.numerator.multiply(denominator)); }
        public double fractionBetween(RationalTime start, RationalTime end) {
            if (compareTo(start) < 0 || compareTo(end) > 0 || end.compareTo(start) <= 0) throw new IllegalArgumentException("time is outside interpolation interval");
            BigInteger top = numerator.multiply(start.denominator).subtract(start.numerator.multiply(denominator));
            BigInteger bottom = denominator.multiply(start.denominator);
            BigInteger rangeTop = end.numerator.multiply(start.denominator).subtract(start.numerator.multiply(end.denominator));
            BigInteger rangeBottom = end.denominator.multiply(start.denominator);
            return top.doubleValue() * rangeBottom.doubleValue() / (bottom.doubleValue() * rangeTop.doubleValue());
        }
    }
    public record PoseKeyframe(RationalTime time, LocalTransform localPose) {
        public PoseKeyframe { Objects.requireNonNull(time, "time"); Objects.requireNonNull(localPose, "localPose"); }
    }
    public record Rig(String id, CoordinateFrame coordinateFrame, String orientationRepresentation,
            List<SourceVersionRef> sourceVersions, List<Bone> bones, Map<String, List<PoseKeyframe>> tracks,
            String sourceProjectRevisionRef) {
        public Rig(String id, CoordinateFrame coordinateFrame, String orientationRepresentation,
                List<SourceVersionRef> sourceVersions, List<Bone> bones, Map<String, List<PoseKeyframe>> tracks) {
            this(id, coordinateFrame, orientationRepresentation, sourceVersions, bones, tracks, null);
        }

        public Rig {
            id = required(id, "rig.id"); Objects.requireNonNull(coordinateFrame, "coordinateFrame");
            if (!"UNIT_QUATERNION_XYZW".equals(orientationRepresentation)) throw new IllegalArgumentException("orientation representation must be explicit UNIT_QUATERNION_XYZW");
            sourceVersions = copyBounded(Objects.requireNonNull(sourceVersions, "sourceVersions"),
                    MAX_SOURCE_VERSIONS, "rig source-version count exceeds ceiling", "sourceVersions[]");
            if (new HashSet<>(sourceVersions).size() != sourceVersions.size()) throw new IllegalArgumentException("rig source versions must be unique");
            bones = copyBounded(Objects.requireNonNull(bones, "bones"), MAX_BONES,
                    "rig bone count is outside bounds", "bones[]");
            if (bones.isEmpty()) throw new IllegalArgumentException("rig bone count is outside bounds");
            HashSet<String> ids = new HashSet<>();
            for (Bone bone : bones) if (!ids.add(Objects.requireNonNull(bone, "bones[]").id())) throw new IllegalArgumentException("bone ids must be unique");
            HashMap<String, List<PoseKeyframe>> copied = new HashMap<>();
            Iterator<? extends Map.Entry<String, List<PoseKeyframe>>> trackEntries =
                    Objects.requireNonNull(tracks, "tracks").entrySet().iterator();
            int trackEntryCount = 0;
            while (trackEntries.hasNext()) {
                if (trackEntryCount >= MAX_BONES) throw new IllegalArgumentException("pose track count exceeds bone ceiling");
                Map.Entry<String, List<PoseKeyframe>> entry = trackEntries.next();
                trackEntryCount++;
                String boneId = entry.getKey();
                List<PoseKeyframe> values = entry.getValue();
                if (!ids.contains(boneId)) throw new IllegalArgumentException("pose track references an unknown bone");
                List<PoseKeyframe> track = copyBounded(Objects.requireNonNull(values, "track"),
                        MAX_TRACKS_PER_BONE, "pose track exceeds keyframe ceiling", "track[]");
                RationalTime prior = null;
                for (PoseKeyframe keyframe : track) {
                    Objects.requireNonNull(keyframe, "track[]");
                    if (prior != null && keyframe.time().compareTo(prior) <= 0) throw new IllegalArgumentException("pose track times must be strictly increasing");
                    prior = keyframe.time();
                }
                if (copied.putIfAbsent(boneId, track) != null) {
                    throw new IllegalArgumentException("pose track ids must be unique");
                }
            }
            tracks = Map.copyOf(copied);
            sourceProjectRevisionRef = sourceProjectRevisionRef == null ? null
                    : required(sourceProjectRevisionRef, "sourceProjectRevisionRef");
            validateHierarchy(bones);
        }
    }
    public record WorldPose(Vec3 position, Quaternion orientation) { }
    public record PoseResult(String rigId, String frameRef, String frameVersionRef, RationalTime sampleTime,
            Map<String, WorldPose> bones, String outputScope, boolean encodedSpatialOutputAvailable,
            String sourceProjectRevisionRef, List<SourceVersionRef> sourceVersions) {
        public PoseResult(String rigId, String frameRef, String frameVersionRef, RationalTime sampleTime,
                Map<String, WorldPose> bones, String outputScope, boolean encodedSpatialOutputAvailable) {
            this(rigId, frameRef, frameVersionRef, sampleTime, bones, outputScope,
                    encodedSpatialOutputAvailable, null, List.of());
        }
        public PoseResult {
            bones = java.util.Collections.unmodifiableMap(new TreeMap<>(bones));
            sourceProjectRevisionRef = sourceProjectRevisionRef == null ? null
                    : required(sourceProjectRevisionRef, "sourceProjectRevisionRef");
            sourceVersions = List.copyOf(sourceVersions);
        }
    }
    public record ProjectedPoint(double xPixels, double yPixels, double depth) { }
    /** Decodable GLB 2.0 skeleton/animation candidate, bound to one source project revision. */
    public record GlbArtifact(String rigId, String sourceProjectRevisionRef, String frameRef,
            String frameVersionRef, List<SourceVersionRef> sourceVersions, String mimeType,
            String timeEncoding, String lossDisposition, String sha256, byte[] bytes) {
        public GlbArtifact {
            rigId = required(rigId, "rigId");
            sourceProjectRevisionRef = required(sourceProjectRevisionRef, "sourceProjectRevisionRef");
            frameRef = required(frameRef, "frameRef"); frameVersionRef = required(frameVersionRef, "frameVersionRef");
            sourceVersions = List.copyOf(sourceVersions);
            if (!"model/gltf-binary".equals(mimeType) || !"FLOAT32_SECONDS".equals(timeEncoding)
                    || !"FLOAT32_APPROXIMATION".equals(lossDisposition)) {
                throw new IllegalArgumentException("GLB artifact metadata does not match the bounded export profile");
            }
            Objects.requireNonNull(bytes, "bytes"); bytes = bytes.clone();
            sha256 = Objects.requireNonNull(sha256, "sha256").toLowerCase(java.util.Locale.ROOT);
            if (!sha256.matches("^[a-f0-9]{64}$") || !SpatialRigEngine.sha256(bytes).equals(sha256)) {
                throw new IllegalArgumentException("GLB artifact SHA-256 does not match its bytes");
            }
        }
        @Override public byte[] bytes() { return bytes.clone(); }
    }
    public record PerspectiveCamera(CoordinateFrame coordinateFrame, Vec3 position, Quaternion orientation,
            double verticalFovRadians, double nearPlane, double farPlane, int width, int height) {
        public PerspectiveCamera {
            Objects.requireNonNull(coordinateFrame, "coordinateFrame"); Objects.requireNonNull(position, "position"); Objects.requireNonNull(orientation, "orientation");
            if (!Double.isFinite(verticalFovRadians) || verticalFovRadians <= 0 || verticalFovRadians >= Math.PI) throw new IllegalArgumentException("camera vertical FOV must be within (0, pi)");
            if (!Double.isFinite(nearPlane) || !Double.isFinite(farPlane) || nearPlane <= 0 || farPlane <= nearPlane || farPlane > MAX_POSITION) throw new IllegalArgumentException("camera clip planes are invalid");
            if (width < 1 || width > 16_384 || height < 1 || height > 16_384 || (long) width * height > 67_108_864L) throw new IllegalArgumentException("camera raster dimensions exceed bounds");
        }
    }

    public static final class SourceRightsDeniedException extends RuntimeException {
        private final RightsOutcome outcome;
        public SourceRightsDeniedException() { this(RightsOutcome.UNKNOWN); }
        public SourceRightsDeniedException(RightsOutcome outcome) {
            super("one or more exact spatial source versions are not currently eligible: " + outcome);
            this.outcome = Objects.requireNonNull(outcome, "outcome");
            if (outcome == RightsOutcome.ELIGIBLE) throw new IllegalArgumentException("eligible is not a denial outcome");
        }
        public RightsOutcome outcome() { return outcome; }
    }

    public enum ExportBlocker { PROJECT_REVISION_MISSING, SOURCE_VERSION_MISSING, COORDINATE_PROFILE_UNSUPPORTED, MOTION_CONSTRAINT_INVALID,
        NON_MONOTONIC_FLOAT_TIME, OUTPUT_TOO_LARGE }
    public static final class SpatialExportBlockedException extends IllegalStateException {
        private final ExportBlocker blocker;
        public SpatialExportBlockedException(ExportBlocker blocker) {
            super("spatial GLB export blocked: " + Objects.requireNonNull(blocker, "blocker"));
            this.blocker = blocker;
        }
        public ExportBlocker blocker() { return blocker; }
    }

    public Vec3 reexpressPoint(Vec3 point, TransformDeclaration declaration, ExactFrameResolver exactFrames) {
        Objects.requireNonNull(point, "point"); Objects.requireNonNull(declaration, "declaration");
        Objects.requireNonNull(exactFrames, "exactFrames");
        CoordinateFrame source = exactFrames.resolve(declaration.source().frameRef(), declaration.source().frameVersionRef());
        CoordinateFrame target = exactFrames.resolve(declaration.target().frameRef(), declaration.target().frameVersionRef());
        if (!declaration.source().equals(source) || !declaration.target().equals(target)) {
            throw new IllegalArgumentException("source/target coordinate frame version is not current in the supplied registry");
        }
        double[] world = applyBasis(basis(source.xAxis(), source.yAxis(), source.zAxis()), point);
        return applyTranspose(basis(target.xAxis(), target.yAxis(), target.zAxis()), world);
    }

    public PoseResult evaluate(Rig rig, RationalTime time, Predicate<SourceVersionRef> currentlyEligible) {
        Objects.requireNonNull(rig, "rig"); Objects.requireNonNull(time, "time");
        if (currentlyEligible == null && !rig.sourceVersions().isEmpty()) {
            throw new SourceRightsDeniedException(RightsOutcome.UNKNOWN);
        }
        for (SourceVersionRef source : rig.sourceVersions()) {
            final boolean allowed;
            try { allowed = currentlyEligible.test(source); }
            catch (RuntimeException unavailable) { throw new SourceRightsDeniedException(RightsOutcome.UNKNOWN); }
            if (!allowed) throw new SourceRightsDeniedException(RightsOutcome.REVOKED);
        }
        Map<String, Bone> byId = new HashMap<>(); rig.bones().forEach(bone -> byId.put(bone.id(), bone));
        Map<String, WorldPose> worlds = new HashMap<>();
        for (Bone bone : rig.bones()) evaluateBone(bone, byId, rig.tracks(), time, worlds, 0);
        return new PoseResult(rig.id(), rig.coordinateFrame().frameRef(), rig.coordinateFrame().frameVersionRef(), time,
                worlds, "POSE_ONLY", false, rig.sourceProjectRevisionRef(), rig.sourceVersions());
    }

    /** Typed authority overload; absent, failing or unknown rights never authorize a pose read. */
    public PoseResult evaluateWithAuthority(Rig rig, RationalTime time, SourceRightsPort authority) {
        Objects.requireNonNull(rig, "rig"); Objects.requireNonNull(time, "time");
        requireSourceRights(rig, authority);
        return evaluate(rig, time, (Predicate<SourceVersionRef>) source -> true);
    }

    /** Exports a bounded, portable GLB skeleton animation; no third-party renderer/provider is invoked. */
    public GlbArtifact exportGlb(Rig rig, SourceRightsPort authority) {
        Objects.requireNonNull(rig, "rig");
        requireSourceRights(rig, authority);
        if (rig.sourceProjectRevisionRef() == null) {
            throw new SpatialExportBlockedException(ExportBlocker.PROJECT_REVISION_MISSING);
        }
        if (rig.sourceVersions().isEmpty()) {
            throw new SpatialExportBlockedException(ExportBlocker.SOURCE_VERSION_MISSING);
        }
        CoordinateFrame frame = rig.coordinateFrame();
        if (frame.handedness() != Handedness.RIGHT_HANDED
                || frame.xAxis() != AxisDirection.POS_X || frame.yAxis() != AxisDirection.POS_Y
                || frame.zAxis() != AxisDirection.POS_Z
                || !GLB_METRE_UNIT_REF.equals(frame.positionUnitRef())
                || !GLB_QUATERNION_UNIT_REF.equals(frame.orientationUnitRef())) {
            throw new SpatialExportBlockedException(ExportBlocker.COORDINATE_PROFILE_UNSUPPORTED);
        }
        validateRigMotion(rig);
        byte[] bytes = encodeGlb(rig);
        if (bytes.length > MAX_GLB_BYTES) throw new SpatialExportBlockedException(ExportBlocker.OUTPUT_TOO_LARGE);
        return new GlbArtifact(rig.id(), rig.sourceProjectRevisionRef(), frame.frameRef(), frame.frameVersionRef(),
                rig.sourceVersions().stream().sorted(Comparator.comparing(SourceVersionRef::tenantId)
                        .thenComparing(SourceVersionRef::artifactId).thenComparing(SourceVersionRef::versionId)).toList(),
                "model/gltf-binary", "FLOAT32_SECONDS", "FLOAT32_APPROXIMATION", sha256(bytes), bytes);
    }

    private static void requireSourceRights(Rig rig, SourceRightsPort authority) {
        if (rig.sourceVersions().isEmpty()) return;
        if (authority == null) throw new SourceRightsDeniedException(RightsOutcome.UNKNOWN);
        for (SourceVersionRef source : rig.sourceVersions()) {
            final RightsOutcome outcome;
            try { outcome = authority.current(source); }
            catch (RuntimeException unavailable) { throw new SourceRightsDeniedException(RightsOutcome.UNKNOWN); }
            if (outcome != RightsOutcome.ELIGIBLE) {
                throw new SourceRightsDeniedException(outcome == null ? RightsOutcome.UNKNOWN : outcome);
            }
        }
    }

    private static void validateRigMotion(Rig rig) {
        Map<String, Bone> byId = new HashMap<>(); rig.bones().forEach(bone -> byId.put(bone.id(), bone));
        for (Map.Entry<String, List<PoseKeyframe>> entry : rig.tracks().entrySet()) {
            Bone bone = byId.get(entry.getKey());
            List<PoseKeyframe> track = entry.getValue();
            float previousSeconds = -1;
            for (int index = 0; index < track.size(); index++) {
                PoseKeyframe key = track.get(index);
                requireJointConstraint(bone, key.localPose());
                float currentSeconds = checkFloatTime(key.time());
                if (index > 0 && currentSeconds <= previousSeconds) {
                    throw new SpatialExportBlockedException(ExportBlocker.NON_MONOTONIC_FLOAT_TIME);
                }
                previousSeconds = currentSeconds;
                if (index + 1 < track.size()) {
                    LocalTransform left = key.localPose(), right = track.get(index + 1).localPose();
                    double maximumDeviation = maximumSlerpDeviation(bone.restPose().orientation(),
                            left.orientation(), right.orientation());
                    if (maximumDeviation > bone.constraint().maxAngularDeviationRadians() + EPSILON) {
                        throw new SpatialExportBlockedException(ExportBlocker.MOTION_CONSTRAINT_INVALID);
                    }
                }
            }
        }
    }

    /** Finds the farthest point from the rest orientation along the shortest quaternion arc. */
    private static double maximumSlerpDeviation(Quaternion rest, Quaternion start, Quaternion end) {
        double endpointDot = quaternionDot(start, end);
        double endSign = endpointDot < 0 ? -1.0 : 1.0;
        double theta = Math.acos(Math.min(1.0, Math.abs(endpointDot)));
        if (theta < 1e-12) return Math.max(rest.angularDistance(start), rest.angularDistance(end));

        // Along the shortest arc q(x) = start*cos(x) + tangent*sin(x), x in [0, theta].
        // Distance from rest is 2*acos(abs(dot(rest, q(x)))), so its maximum occurs
        // at a zero or a stationary point of that sinusoid, or at an endpoint.
        double a = quaternionDot(rest, start);
        double b = (endSign * quaternionDot(rest, end) - a * Math.cos(theta)) / Math.sin(theta);
        double minimumAbsoluteDot = Math.min(Math.abs(a), Math.abs(endSign * quaternionDot(rest, end)));

        double rootBase = Math.atan2(-a, b);
        for (int turn = -1; turn <= 1; turn++) {
            double root = rootBase + turn * Math.PI;
            if (root >= 0 && root <= theta) return Math.PI;
        }

        double stationaryBase = Math.atan2(b, a);
        for (int turn = -1; turn <= 1; turn++) {
            double stationary = stationaryBase + turn * Math.PI;
            if (stationary >= 0 && stationary <= theta) {
                minimumAbsoluteDot = Math.min(minimumAbsoluteDot,
                        Math.abs(a * Math.cos(stationary) + b * Math.sin(stationary)));
            }
        }
        return 2 * Math.acos(Math.min(1.0, minimumAbsoluteDot));
    }

    private static double quaternionDot(Quaternion left, Quaternion right) {
        return left.x() * right.x() + left.y() * right.y() + left.z() * right.z() + left.w() * right.w();
    }

    private static void requireJointConstraint(Bone bone, LocalTransform pose) {
        double deviation = bone.restPose().orientation().angularDistance(pose.orientation());
        if (deviation > bone.constraint().maxAngularDeviationRadians() + EPSILON) {
            throw new SpatialExportBlockedException(ExportBlocker.MOTION_CONSTRAINT_INVALID);
        }
    }

    private static float checkFloatTime(RationalTime time) {
        float seconds = (float) ((double) time.numerator().longValueExact() / time.denominator().longValueExact());
        if (!Float.isFinite(seconds)) throw new SpatialExportBlockedException(ExportBlocker.NON_MONOTONIC_FLOAT_TIME);
        return seconds;
    }

    /** Projects a point into the explicitly bounded camera profile (camera looks along local -Z). */
    public ProjectedPoint project(Vec3 worldPoint, CoordinateFrame worldFrame, PerspectiveCamera camera) {
        Objects.requireNonNull(worldPoint, "worldPoint"); Objects.requireNonNull(worldFrame, "worldFrame"); Objects.requireNonNull(camera, "camera");
        if (!worldFrame.equals(camera.coordinateFrame())) throw new IllegalArgumentException("camera and point must use the same exact coordinate-frame version and declaration");
        Vec3 local = camera.orientation().inverse().rotate(worldPoint.subtract(camera.position()));
        double depth = -local.z();
        if (depth < camera.nearPlane() || depth > camera.farPlane()) throw new IllegalArgumentException("point is outside camera clip range");
        double focal = camera.height() / (2.0 * Math.tan(camera.verticalFovRadians() / 2.0));
        return new ProjectedPoint(camera.width() / 2.0 + focal * local.x() / depth,
                camera.height() / 2.0 - focal * local.y() / depth, depth);
    }

    private static byte[] encodeGlb(Rig rig) {
        List<Bone> bones = rig.bones().stream().sorted(Comparator.comparing(Bone::id)).toList();
        Map<String, Integer> nodeIndex = new HashMap<>();
        for (int index = 0; index < bones.size(); index++) nodeIndex.put(bones.get(index).id(), index);
        ByteArrayOutputStream binary = new ByteArrayOutputStream();
        ArrayList<String> bufferViews = new ArrayList<>();
        ArrayList<String> accessors = new ArrayList<>();
        ArrayList<String> samplers = new ArrayList<>();
        ArrayList<String> channels = new ArrayList<>();

        rig.tracks().entrySet().stream().sorted(Map.Entry.comparingByKey()).forEach(entry -> {
            List<PoseKeyframe> track = entry.getValue();
            if (track.isEmpty()) return;
            int input = addTimeAccessor(track, binary, bufferViews, accessors);
            int translation = addVec3Accessor(track, false, binary, bufferViews, accessors);
            int rotation = addVec3Accessor(track, true, binary, bufferViews, accessors);
            int node = nodeIndex.get(entry.getKey());
            int translationSampler = samplers.size();
            samplers.add("{\"input\":" + input + ",\"output\":" + translation + ",\"interpolation\":\"LINEAR\"}");
            channels.add("{\"sampler\":" + translationSampler + ",\"target\":{\"node\":" + node + ",\"path\":\"translation\"}}");
            int rotationSampler = samplers.size();
            samplers.add("{\"input\":" + input + ",\"output\":" + rotation + ",\"interpolation\":\"LINEAR\"}");
            channels.add("{\"sampler\":" + rotationSampler + ",\"target\":{\"node\":" + node + ",\"path\":\"rotation\"}}");
        });

        ArrayList<String> nodes = new ArrayList<>();
        for (Bone bone : bones) {
            LocalTransform rest = bone.restPose();
            String children = bones.stream().filter(candidate -> bone.id().equals(candidate.parentId()))
                    .map(candidate -> Integer.toString(nodeIndex.get(candidate.id()))).collect(java.util.stream.Collectors.joining(","));
            nodes.add("{\"name\":" + json(bone.id()) + ",\"translation\":[" + rest.position().x() + ","
                    + rest.position().y() + "," + rest.position().z() + "],\"rotation\":["
                    + rest.orientation().x() + "," + rest.orientation().y() + "," + rest.orientation().z() + ","
                    + rest.orientation().w() + "],\"extras\":{\"jointKind\":" + json(bone.constraint().kind().name())
                    + ",\"maxAngularDeviationRadians\":" + bone.constraint().maxAngularDeviationRadians() + "}"
                    + (children.isEmpty() ? "" : ",\"children\":[" + children + "]") + "}");
        }
        String roots = bones.stream().filter(bone -> bone.parentId() == null)
                .map(bone -> Integer.toString(nodeIndex.get(bone.id()))).collect(java.util.stream.Collectors.joining(","));
        StringBuilder document = new StringBuilder(16_384);
        document.append("{\"asset\":{\"version\":\"2.0\",\"generator\":\"Ghatana Media bounded spatial rig\"},")
                .append("\"scene\":0,\"scenes\":[{\"nodes\":[").append(roots).append("]}],\"nodes\":[")
                .append(String.join(",", nodes)).append(']');
        if (!channels.isEmpty()) {
            document.append(",\"animations\":[{\"name\":\"rig-motion\",\"samplers\":[")
                    .append(String.join(",", samplers)).append("],\"channels\":[")
                    .append(String.join(",", channels)).append("]}]");
        }
        if (binary.size() > 0) {
            document.append(",\"buffers\":[{\"byteLength\":").append(binary.size()).append("}],\"bufferViews\":[")
                    .append(String.join(",", bufferViews)).append("],\"accessors\":[")
                    .append(String.join(",", accessors)).append(']');
        }
        appendSpatialMetadata(document, rig);
        document.append('}');
        return glb(document.toString(), binary.toByteArray());
    }

    private static int addTimeAccessor(List<PoseKeyframe> track, ByteArrayOutputStream binary,
            List<String> views, List<String> accessors) {
        float[] values = new float[track.size()];
        for (int index = 0; index < track.size(); index++) values[index] = checkFloatTime(track.get(index).time());
        int accessor = addFloatAccessor(values, 1, track.size(), binary, views, accessors,
                ",\"min\":[" + values[0] + "],\"max\":[" + values[values.length - 1] + "]");
        return accessor;
    }

    private static int addVec3Accessor(List<PoseKeyframe> track, boolean rotation, ByteArrayOutputStream binary,
            List<String> views, List<String> accessors) {
        int components = rotation ? 4 : 3;
        float[] values = new float[track.size() * components];
        for (int index = 0; index < track.size(); index++) {
            LocalTransform pose = track.get(index).localPose();
            int offset = index * components;
            if (rotation) {
                values[offset] = (float) pose.orientation().x(); values[offset + 1] = (float) pose.orientation().y();
                values[offset + 2] = (float) pose.orientation().z(); values[offset + 3] = (float) pose.orientation().w();
            } else {
                values[offset] = (float) pose.position().x(); values[offset + 1] = (float) pose.position().y();
                values[offset + 2] = (float) pose.position().z();
            }
        }
        return addFloatAccessor(values, components, track.size(), binary, views, accessors, "");
    }

    private static int addFloatAccessor(float[] values, int components, int count, ByteArrayOutputStream binary,
            List<String> views, List<String> accessors, String extraFields) {
        int byteOffset = binary.size();
        for (float value : values) {
            if (!Float.isFinite(value)) throw new SpatialExportBlockedException(ExportBlocker.NON_MONOTONIC_FLOAT_TIME);
            writeFloat(binary, value);
        }
        int viewIndex = views.size();
        views.add("{\"buffer\":0,\"byteOffset\":" + byteOffset + ",\"byteLength\":" + (values.length * 4) + "}");
        int accessorIndex = accessors.size();
        String type = switch (components) { case 1 -> "SCALAR"; case 3 -> "VEC3"; case 4 -> "VEC4"; default -> throw new IllegalArgumentException("unsupported accessor width"); };
        accessors.add("{\"bufferView\":" + viewIndex + ",\"componentType\":5126,\"count\":" + count
                + ",\"type\":" + json(type) + extraFields + "}");
        return accessorIndex;
    }

    private static void appendSpatialMetadata(StringBuilder json, Rig rig) {
        CoordinateFrame frame = rig.coordinateFrame();
        json.append(",\"extras\":{\"mediaSpatial\":{\"rigId\":").append(json(rig.id()))
                .append(",\"sourceProjectRevisionRef\":").append(json(rig.sourceProjectRevisionRef()))
                .append(",\"frameRef\":").append(json(frame.frameRef()))
                .append(",\"frameVersionRef\":").append(json(frame.frameVersionRef()))
                .append(",\"handedness\":").append(json(frame.handedness().name()))
                .append(",\"axisDirections\":[").append(json(frame.xAxis().name())).append(',')
                .append(json(frame.yAxis().name())).append(',').append(json(frame.zAxis().name())).append(']')
                .append(",\"positionUnitRef\":").append(json(frame.positionUnitRef()))
                .append(",\"orientationUnitRef\":").append(json(frame.orientationUnitRef()))
                .append(",\"timeEncoding\":\"FLOAT32_SECONDS\",\"lossDisposition\":\"FLOAT32_APPROXIMATION\",\"float32LossFields\":[");
        boolean hasAnimation = rig.tracks().values().stream().anyMatch(track -> !track.isEmpty());
        if (hasAnimation) {
            for (int index = 0; index < GLB_FLOAT32_LOSS_FIELDS.size(); index++) {
                if (index > 0) json.append(',');
                json.append(json(GLB_FLOAT32_LOSS_FIELDS.get(index)));
            }
        }
        json.append("],\"sourceVersions\":[");
        List<SourceVersionRef> sources = rig.sourceVersions().stream().sorted(Comparator.comparing(SourceVersionRef::tenantId)
                .thenComparing(SourceVersionRef::artifactId).thenComparing(SourceVersionRef::versionId)).toList();
        for (int index = 0; index < sources.size(); index++) {
            SourceVersionRef source = sources.get(index);
            if (index > 0) json.append(',');
            json.append("{\"tenantId\":").append(json(source.tenantId())).append(",\"artifactId\":")
                    .append(json(source.artifactId())).append(",\"versionId\":").append(json(source.versionId())).append('}');
        }
        json.append("],\"exactKeyframeTimes\":[");
        List<Map.Entry<String, List<PoseKeyframe>>> tracks = rig.tracks().entrySet().stream()
                .filter(entry -> !entry.getValue().isEmpty()).sorted(Map.Entry.comparingByKey()).toList();
        for (int trackIndex = 0; trackIndex < tracks.size(); trackIndex++) {
            if (trackIndex > 0) json.append(',');
            Map.Entry<String, List<PoseKeyframe>> entry = tracks.get(trackIndex);
            json.append("{\"boneId\":").append(json(entry.getKey())).append(",\"times\":[");
            for (int keyIndex = 0; keyIndex < entry.getValue().size(); keyIndex++) {
                if (keyIndex > 0) json.append(',');
                RationalTime time = entry.getValue().get(keyIndex).time();
                json.append('[').append(json(time.numerator().toString())).append(',')
                        .append(json(time.denominator().toString())).append(']');
            }
            json.append("]}");
        }
        json.append("]}}");
    }

    private static byte[] glb(String jsonDocument, byte[] binaryData) {
        byte[] jsonBytes = jsonDocument.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        int jsonLength = (jsonBytes.length + 3) & ~3;
        int binaryLength = binaryData.length == 0 ? 0 : (binaryData.length + 3) & ~3;
        int chunkCount = binaryData.length == 0 ? 1 : 2;
        long total = 12L + 8 + jsonLength + (binaryData.length == 0 ? 0 : 8L + binaryLength);
        if (total > MAX_GLB_BYTES) throw new SpatialExportBlockedException(ExportBlocker.OUTPUT_TOO_LARGE);
        ByteBuffer output = ByteBuffer.allocate((int) total).order(ByteOrder.LITTLE_ENDIAN);
        output.putInt(0x46546c67).putInt(2).putInt((int) total);
        output.putInt(jsonLength).putInt(0x4e4f534a).put(jsonBytes);
        while (output.position() % 4 != 0) output.put((byte) 0x20);
        if (chunkCount == 2) {
            output.putInt(binaryLength).putInt(0x004e4942).put(binaryData);
            while (output.position() % 4 != 0) output.put((byte) 0);
        }
        return output.array();
    }

    private static void writeFloat(ByteArrayOutputStream output, float value) {
        int bits = Float.floatToIntBits(value);
        output.write(bits & 0xff); output.write((bits >>> 8) & 0xff);
        output.write((bits >>> 16) & 0xff); output.write((bits >>> 24) & 0xff);
    }

    private static String json(String value) {
        StringBuilder escaped = new StringBuilder(value.length() + 2).append('"');
        for (int index = 0; index < value.length(); index++) {
            char ch = value.charAt(index);
            switch (ch) {
                case '"' -> escaped.append("\\\""); case '\\' -> escaped.append("\\\\");
                case '\b' -> escaped.append("\\b"); case '\f' -> escaped.append("\\f");
                case '\n' -> escaped.append("\\n"); case '\r' -> escaped.append("\\r");
                case '\t' -> escaped.append("\\t");
                default -> {
                    // Escape UTF-16 surrogate code units so malformed pairs survive UTF-8
                    // encoding as JSON data instead of being replaced by the encoder.
                    if (ch < 0x20 || Character.isSurrogate(ch)) escaped.append(String.format("\\u%04x", (int) ch));
                    else escaped.append(ch);
                }
            }
        }
        return escaped.append('"').toString();
    }

    private static String sha256(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    private static void evaluateBone(Bone bone, Map<String, Bone> byId, Map<String, List<PoseKeyframe>> tracks,
            RationalTime time, Map<String, WorldPose> worlds, int depth) {
        if (depth > MAX_DEPTH) throw new IllegalArgumentException("rig hierarchy depth exceeds ceiling");
        if (worlds.containsKey(bone.id())) return;
        LocalTransform local = interpolate(bone.restPose(), tracks.getOrDefault(bone.id(), List.of()), time);
        double deviation = bone.restPose().orientation().angularDistance(local.orientation());
        if (deviation > bone.constraint().maxAngularDeviationRadians() + EPSILON) {
            throw new IllegalArgumentException("joint angular constraint exceeded for bone " + bone.id());
        }
        if (bone.parentId() == null) {
            worlds.put(bone.id(), new WorldPose(local.position(), local.orientation()));
        } else {
            Bone parent = byId.get(bone.parentId());
            if (parent == null) throw new IllegalArgumentException("bone parent does not exist");
            evaluateBone(parent, byId, tracks, time, worlds, depth + 1);
            WorldPose parentPose = worlds.get(parent.id());
            worlds.put(bone.id(), new WorldPose(parentPose.position().add(parentPose.orientation().rotate(local.position())), parentPose.orientation().multiply(local.orientation())));
        }
    }

    private static LocalTransform interpolate(LocalTransform rest, List<PoseKeyframe> track, RationalTime time) {
        if (track.isEmpty() || time.compareTo(track.get(0).time()) <= 0) return track.isEmpty() ? rest : track.get(0).localPose();
        if (time.compareTo(track.get(track.size() - 1).time()) >= 0) return track.get(track.size() - 1).localPose();
        int high = 1;
        while (track.get(high).time().compareTo(time) < 0) high++;
        PoseKeyframe left = track.get(high - 1), right = track.get(high);
        double alpha = time.fractionBetween(left.time(), right.time());
        Vec3 position = left.localPose().position().scale(1 - alpha).add(right.localPose().position().scale(alpha));
        return new LocalTransform(position, left.localPose().orientation().slerp(right.localPose().orientation(), alpha));
    }

    private static void validateHierarchy(List<Bone> bones) {
        Map<String, Bone> byId = new HashMap<>(); bones.forEach(bone -> byId.put(bone.id(), bone));
        for (Bone bone : bones) {
            HashSet<String> seen = new HashSet<>(); Bone current = bone; int depth = 0;
            while (current != null) {
                if (!seen.add(current.id())) throw new IllegalArgumentException("rig hierarchy contains a cycle");
                if (++depth > MAX_DEPTH) throw new IllegalArgumentException("rig hierarchy depth exceeds ceiling");
                current = current.parentId() == null ? null : byId.get(current.parentId());
                if (current == null && bone.parentId() != null && !byId.containsKey(bone.parentId())) throw new IllegalArgumentException("bone parent does not exist");
            }
        }
    }

    private static double[][] basis(AxisDirection x, AxisDirection y, AxisDirection z) {
        double[][] result = new double[3][3];
        AxisDirection[] dirs = { x, y, z };
        for (int column = 0; column < 3; column++) result[dirs[column].axis][column] = dirs[column].sign;
        return result;
    }
    private static int determinant(double[][] m) {
        return (int) Math.round(m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
                - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]));
    }
    private static double[] applyBasis(double[][] m, Vec3 p) {
        return new double[] { m[0][0] * p.x() + m[0][1] * p.y() + m[0][2] * p.z(), m[1][0] * p.x() + m[1][1] * p.y() + m[1][2] * p.z(), m[2][0] * p.x() + m[2][1] * p.y() + m[2][2] * p.z() };
    }
    private static Vec3 applyTranspose(double[][] m, double[] p) {
        return new Vec3(m[0][0] * p[0] + m[1][0] * p[1] + m[2][0] * p[2], m[0][1] * p[0] + m[1][1] * p[1] + m[2][1] * p[2], m[0][2] * p[0] + m[1][2] * p[1] + m[2][2] * p[2]);
    }
    private static String required(String value, String label) {
        if (value == null || value.isBlank() || value.length() > 384 || !value.equals(value.trim())) throw new IllegalArgumentException(label + " must be nonblank, trimmed and bounded");
        return value;
    }

    private static <T> List<T> copyBounded(Iterable<? extends T> values, int maximum,
            String limitMessage, String elementLabel) {
        ArrayList<T> copy = new ArrayList<>(Math.min(maximum, 8));
        Iterator<? extends T> iterator = values.iterator();
        while (iterator.hasNext()) {
            if (copy.size() >= maximum) throw new IllegalArgumentException(limitMessage);
            copy.add(Objects.requireNonNull(iterator.next(), elementLabel));
        }
        return List.copyOf(copy);
    }
}
