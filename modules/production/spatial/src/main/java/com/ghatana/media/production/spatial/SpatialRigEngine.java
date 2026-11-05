package com.ghatana.media.production.spatial;

import java.math.BigInteger;
import java.util.HashMap;
import java.util.HashSet;
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
    public static final double MAX_POSITION = 1_000_000.0;
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
    @FunctionalInterface public interface ExactFrameResolver {
        CoordinateFrame resolve(String frameRef, String frameVersionRef);
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
            List<SourceVersionRef> sourceVersions, List<Bone> bones, Map<String, List<PoseKeyframe>> tracks) {
        public Rig {
            id = required(id, "rig.id"); Objects.requireNonNull(coordinateFrame, "coordinateFrame");
            if (!"UNIT_QUATERNION_XYZW".equals(orientationRepresentation)) throw new IllegalArgumentException("orientation representation must be explicit UNIT_QUATERNION_XYZW");
            sourceVersions = List.copyOf(Objects.requireNonNull(sourceVersions, "sourceVersions"));
            if (sourceVersions.size() > MAX_SOURCE_VERSIONS) throw new IllegalArgumentException("rig source-version count exceeds ceiling");
            if (new HashSet<>(sourceVersions).size() != sourceVersions.size()) throw new IllegalArgumentException("rig source versions must be unique");
            bones = List.copyOf(Objects.requireNonNull(bones, "bones"));
            if (bones.isEmpty() || bones.size() > MAX_BONES) throw new IllegalArgumentException("rig bone count is outside bounds");
            HashSet<String> ids = new HashSet<>();
            for (Bone bone : bones) if (!ids.add(Objects.requireNonNull(bone, "bones[]").id())) throw new IllegalArgumentException("bone ids must be unique");
            HashMap<String, List<PoseKeyframe>> copied = new HashMap<>();
            Objects.requireNonNull(tracks, "tracks").forEach((boneId, values) -> {
                if (!ids.contains(boneId)) throw new IllegalArgumentException("pose track references an unknown bone");
                List<PoseKeyframe> track = List.copyOf(Objects.requireNonNull(values, "track"));
                if (track.size() > MAX_TRACKS_PER_BONE) throw new IllegalArgumentException("pose track exceeds keyframe ceiling");
                RationalTime prior = null;
                for (PoseKeyframe keyframe : track) {
                    Objects.requireNonNull(keyframe, "track[]");
                    if (prior != null && keyframe.time().compareTo(prior) <= 0) throw new IllegalArgumentException("pose track times must be strictly increasing");
                    prior = keyframe.time();
                }
                copied.put(boneId, track);
            });
            tracks = Map.copyOf(copied);
            validateHierarchy(bones);
        }
    }
    public record WorldPose(Vec3 position, Quaternion orientation) { }
    public record PoseResult(String rigId, String frameRef, String frameVersionRef, RationalTime sampleTime,
            Map<String, WorldPose> bones, String outputScope, boolean encodedSpatialOutputAvailable) {
        public PoseResult { bones = java.util.Collections.unmodifiableMap(new TreeMap<>(bones)); }
    }
    public record ProjectedPoint(double xPixels, double yPixels, double depth) { }
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
        public SourceRightsDeniedException() { super("one or more exact spatial source versions are not currently eligible"); }
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
        Objects.requireNonNull(rig, "rig"); Objects.requireNonNull(time, "time"); Objects.requireNonNull(currentlyEligible, "currentlyEligible");
        for (SourceVersionRef source : rig.sourceVersions()) if (!currentlyEligible.test(source)) throw new SourceRightsDeniedException();
        Map<String, Bone> byId = new HashMap<>(); rig.bones().forEach(bone -> byId.put(bone.id(), bone));
        Map<String, WorldPose> worlds = new HashMap<>();
        for (Bone bone : rig.bones()) evaluateBone(bone, byId, rig.tracks(), time, worlds, 0);
        return new PoseResult(rig.id(), rig.coordinateFrame().frameRef(), rig.coordinateFrame().frameVersionRef(), time,
                worlds, "POSE_ONLY", false);
    }

    /** Projects a point into the explicitly bounded camera profile (camera looks along local -Z). */
    public ProjectedPoint project(Vec3 worldPoint, CoordinateFrame worldFrame, PerspectiveCamera camera) {
        Objects.requireNonNull(worldPoint, "worldPoint"); Objects.requireNonNull(worldFrame, "worldFrame"); Objects.requireNonNull(camera, "camera");
        if (!worldFrame.identity().equals(camera.coordinateFrame().identity())) throw new IllegalArgumentException("camera and point must use the same exact coordinate-frame version");
        if (!worldFrame.positionUnitRef().equals(camera.coordinateFrame().positionUnitRef())) throw new IllegalArgumentException("camera and point position units differ");
        Vec3 local = camera.orientation().inverse().rotate(worldPoint.subtract(camera.position()));
        double depth = -local.z();
        if (depth < camera.nearPlane() || depth > camera.farPlane()) throw new IllegalArgumentException("point is outside camera clip range");
        double focal = camera.height() / (2.0 * Math.tan(camera.verticalFovRadians() / 2.0));
        return new ProjectedPoint(camera.width() / 2.0 + focal * local.x() / depth,
                camera.height() / 2.0 - focal * local.y() / depth, depth);
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
}
