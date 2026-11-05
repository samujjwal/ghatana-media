package com.ghatana.media.production.spatial;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class SpatialRigEngineTest {
    private final SpatialRigEngine engine = new SpatialRigEngine();
    private static final String METER = "fixture:unit:meter:v1";
    private static final String RADIAN_PROFILE = "fixture:orientation:quaternion-xyzw:v1";

    @Test
    void reexpressesCoordinatesOnlyThroughExplicitVersionedAxisPlanAndRoundTrips() {
        var right = frame("camera", "camera:v1", SpatialRigEngine.Handedness.RIGHT_HANDED,
                SpatialRigEngine.AxisDirection.POS_X, SpatialRigEngine.AxisDirection.POS_Y, SpatialRigEngine.AxisDirection.POS_Z);
        var left = frame("world", "world:v2", SpatialRigEngine.Handedness.LEFT_HANDED,
                SpatialRigEngine.AxisDirection.POS_X, SpatialRigEngine.AxisDirection.POS_Z, SpatialRigEngine.AxisDirection.POS_Y);
        var forward = declaration(right, left);
        var reverse = declaration(left, right);
        var source = new SpatialRigEngine.Vec3(1.25, -2.5, 3.75);
        var registry = (SpatialRigEngine.ExactFrameResolver) (id, version) -> {
            if (right.frameRef().equals(id) && right.frameVersionRef().equals(version)) return right;
            if (left.frameRef().equals(id) && left.frameVersionRef().equals(version)) return left;
            return null;
        };
        var converted = engine.reexpressPoint(source, forward, registry);
        assertThat(converted.x()).isEqualTo(1.25);
        assertThat(converted.y()).isEqualTo(3.75);
        assertThat(converted.z()).isEqualTo(-2.5);
        var roundTrip = engine.reexpressPoint(converted, reverse, registry);
        assertThat(roundTrip.x()).isCloseTo(source.x(), org.assertj.core.data.Offset.offset(1e-12));
        assertThat(roundTrip.y()).isCloseTo(source.y(), org.assertj.core.data.Offset.offset(1e-12));
        assertThat(roundTrip.z()).isCloseTo(source.z(), org.assertj.core.data.Offset.offset(1e-12));
    }

    @Test
    void rejectsIncompleteContradictoryAndUnsupportedTransformDeclarations() {
        assertThatIllegalArgumentException().isThrownBy(() -> frame("bad", "bad:v1", SpatialRigEngine.Handedness.RIGHT_HANDED,
                SpatialRigEngine.AxisDirection.POS_X, SpatialRigEngine.AxisDirection.POS_Z, SpatialRigEngine.AxisDirection.POS_Y));
        var source = frame("source", "source:v1", SpatialRigEngine.Handedness.RIGHT_HANDED,
                SpatialRigEngine.AxisDirection.POS_X, SpatialRigEngine.AxisDirection.POS_Y, SpatialRigEngine.AxisDirection.POS_Z);
        var differentUnit = new SpatialRigEngine.CoordinateFrame("target", "target:v1", SpatialRigEngine.Handedness.RIGHT_HANDED,
                SpatialRigEngine.AxisDirection.POS_X, SpatialRigEngine.AxisDirection.POS_Y, SpatialRigEngine.AxisDirection.POS_Z,
                "fixture:unit:millimeter:v1", RADIAN_PROFILE);
        assertThatIllegalArgumentException().isThrownBy(() -> declaration(source, differentUnit));
        assertThatIllegalArgumentException().isThrownBy(() -> new SpatialRigEngine.TransformDeclaration("plan", "plan:v1", source, source,
                List.of(), "mapping:v1"));
        assertThatIllegalArgumentException().isThrownBy(() -> new SpatialRigEngine.TransformDeclaration("plan", "plan:v1", source, source,
                List.of(SpatialRigEngine.TransformOperation.REEXPRESS_SIGNED_ORTHONORMAL_AXES,
                        SpatialRigEngine.TransformOperation.REEXPRESS_SIGNED_ORTHONORMAL_AXES), "mapping:v1"));
        var current = (SpatialRigEngine.ExactFrameResolver) (id, version) -> source;
        assertThatIllegalArgumentException().isThrownBy(() -> engine.reexpressPoint(new SpatialRigEngine.Vec3(1, 2, 3), declaration(source, source),
                (id, version) -> new SpatialRigEngine.CoordinateFrame(id, "stale:v0", source.handedness(), source.xAxis(), source.yAxis(), source.zAxis(), METER, RADIAN_PROFILE)));
        assertThat(engine.reexpressPoint(new SpatialRigEngine.Vec3(1, 2, 3), declaration(source, source), current).x()).isEqualTo(1);
    }

    @Test
    void interpolatesRationalKeyframesAndComposesParentChildWorldPoses() {
        var frame = canonicalFrame();
        var root = bone("root", null, new SpatialRigEngine.LocalTransform(SpatialRigEngine.Vec3.ZERO, SpatialRigEngine.Quaternion.IDENTITY), Math.PI);
        var child = bone("child", "root", new SpatialRigEngine.LocalTransform(new SpatialRigEngine.Vec3(0, 2, 0), SpatialRigEngine.Quaternion.IDENTITY), Math.PI);
        var q90 = axisAngle(new SpatialRigEngine.Vec3(0, 0, 1), Math.PI / 2);
        var rig = rig(frame, List.of(root, child), Map.of("root", List.of(
                key(0, 1, new SpatialRigEngine.Vec3(0, 0, 0), SpatialRigEngine.Quaternion.IDENTITY),
                key(2, 1, new SpatialRigEngine.Vec3(10, 0, 0), q90))));

        var result = engine.evaluate(rig, SpatialRigEngine.RationalTime.of(1, 1), source -> true);
        assertThat(result.outputScope()).isEqualTo("POSE_ONLY");
        assertThat(result.encodedSpatialOutputAvailable()).isFalse();
        assertThat(result.bones()).containsKeys("root", "child");
        assertThat(result.bones().get("root").position().x()).isCloseTo(5, org.assertj.core.data.Offset.offset(1e-10));
        assertThat(result.bones().get("child").position().x()).isCloseTo(5 - Math.sqrt(2), org.assertj.core.data.Offset.offset(1e-10));
        assertThat(result.bones().get("child").position().y()).isCloseTo(Math.sqrt(2), org.assertj.core.data.Offset.offset(1e-10));
        assertThat(result.bones().get("root").orientation().angularDistance(axisAngle(new SpatialRigEngine.Vec3(0, 0, 1), Math.PI / 4)))
                .isLessThan(1e-10);
    }

    @Test
    void enforcesJointBoundsAndRequiresCurrentRightsForEveryExactSourceVersion() {
        var root = bone("root", null, SpatialRigEngine.LocalTransform.identity(), Math.PI / 6);
        var assetA = new SpatialRigEngine.SourceVersionRef("tenant-a", "artifact-a", "version-a1");
        var assetB = new SpatialRigEngine.SourceVersionRef("tenant-a", "artifact-b", "version-b3");
        var rig = new SpatialRigEngine.Rig("rig", canonicalFrame(), "UNIT_QUATERNION_XYZW", List.of(assetA, assetB),
                List.of(root), Map.of("root", List.of(key(0, 1, SpatialRigEngine.Vec3.ZERO, SpatialRigEngine.Quaternion.IDENTITY),
                        key(1, 1, SpatialRigEngine.Vec3.ZERO, axisAngle(new SpatialRigEngine.Vec3(0, 1, 0), Math.PI / 2)))));
        assertThatIllegalArgumentException().isThrownBy(() -> engine.evaluate(rig, SpatialRigEngine.RationalTime.of(1, 1), source -> true))
                .withMessageContaining("joint angular constraint");

        var safeRig = rig(canonicalFrame(), List.of(root), Map.of());
        AtomicInteger checks = new AtomicInteger();
        assertThatThrownBy(() -> engine.evaluate(new SpatialRigEngine.Rig("rights", canonicalFrame(), "UNIT_QUATERNION_XYZW",
                List.of(assetA, assetB), List.of(root), Map.of()), SpatialRigEngine.RationalTime.of(0, 1), source -> {
                    checks.incrementAndGet(); return source.equals(assetA);
                })).isInstanceOf(SpatialRigEngine.SourceRightsDeniedException.class);
        assertThat(checks.get()).isEqualTo(2);
        assertThat(engine.evaluate(safeRig, SpatialRigEngine.RationalTime.of(0, 1), source -> true).bones()).containsKey("root");
    }

    @Test
    void rejectsMalformedRigTopologyTimeAndNonFiniteValues() {
        assertThatIllegalArgumentException().isThrownBy(() -> new SpatialRigEngine.Vec3(Double.NaN, 0, 0));
        assertThatIllegalArgumentException().isThrownBy(() -> new SpatialRigEngine.Vec3(SpatialRigEngine.MAX_POSITION + 1, 0, 0));
        assertThatIllegalArgumentException().isThrownBy(() -> SpatialRigEngine.RationalTime.of(1, 0));
        var root = bone("root", null, SpatialRigEngine.LocalTransform.identity(), Math.PI);
        var child = bone("child", "root", SpatialRigEngine.LocalTransform.identity(), Math.PI);
        assertThatIllegalArgumentException().isThrownBy(() -> rig(canonicalFrame(), List.of(root, child), Map.of("missing", List.of())));
        assertThatIllegalArgumentException().isThrownBy(() -> rig(canonicalFrame(), List.of(root, bone("root", null,
                SpatialRigEngine.LocalTransform.identity(), Math.PI)), Map.of()));
        assertThatIllegalArgumentException().isThrownBy(() -> rig(canonicalFrame(), List.of(
                bone("a", "b", SpatialRigEngine.LocalTransform.identity(), Math.PI),
                bone("b", "a", SpatialRigEngine.LocalTransform.identity(), Math.PI)), Map.of()));
    }

    @Test
    void cameraProjectionUsesAnExactFrameAndExplicitCameraConvention() {
        var frame = canonicalFrame();
        var camera = new SpatialRigEngine.PerspectiveCamera(frame, SpatialRigEngine.Vec3.ZERO,
                SpatialRigEngine.Quaternion.IDENTITY, Math.PI / 2, 0.1, 100, 640, 480);
        var center = engine.project(new SpatialRigEngine.Vec3(0, 0, -2), frame, camera);
        assertThat(center.xPixels()).isEqualTo(320.0);
        assertThat(center.yPixels()).isEqualTo(240.0);
        assertThat(center.depth()).isEqualTo(2.0);
        assertThatIllegalArgumentException().isThrownBy(() -> engine.project(new SpatialRigEngine.Vec3(0, 0, 2), frame, camera));
        var staleFrame = frame("world", "world:v0", SpatialRigEngine.Handedness.RIGHT_HANDED,
                SpatialRigEngine.AxisDirection.POS_X, SpatialRigEngine.AxisDirection.POS_Y, SpatialRigEngine.AxisDirection.POS_Z);
        assertThatIllegalArgumentException().isThrownBy(() -> engine.project(new SpatialRigEngine.Vec3(0, 0, -2), staleFrame, camera));
    }

    private static SpatialRigEngine.CoordinateFrame canonicalFrame() {
        return frame("world", "world:v1", SpatialRigEngine.Handedness.RIGHT_HANDED,
                SpatialRigEngine.AxisDirection.POS_X, SpatialRigEngine.AxisDirection.POS_Y, SpatialRigEngine.AxisDirection.POS_Z);
    }
    private static SpatialRigEngine.CoordinateFrame frame(String id, String version, SpatialRigEngine.Handedness handedness,
            SpatialRigEngine.AxisDirection x, SpatialRigEngine.AxisDirection y, SpatialRigEngine.AxisDirection z) {
        return new SpatialRigEngine.CoordinateFrame("fixture:frame:" + id, version, handedness, x, y, z, METER, RADIAN_PROFILE);
    }
    private static SpatialRigEngine.TransformDeclaration declaration(SpatialRigEngine.CoordinateFrame from, SpatialRigEngine.CoordinateFrame to) {
        return new SpatialRigEngine.TransformDeclaration("fixture:transform", "fixture:transform:v1", from, to,
                List.of(SpatialRigEngine.TransformOperation.REEXPRESS_SIGNED_ORTHONORMAL_AXES), "fixture:mapping:v1");
    }
    private static SpatialRigEngine.Bone bone(String id, String parent, SpatialRigEngine.LocalTransform rest, double limit) {
        return new SpatialRigEngine.Bone(id, parent, rest, new SpatialRigEngine.JointConstraint(SpatialRigEngine.JointKind.BALL, limit));
    }
    private static SpatialRigEngine.Rig rig(SpatialRigEngine.CoordinateFrame frame, List<SpatialRigEngine.Bone> bones,
            Map<String, List<SpatialRigEngine.PoseKeyframe>> tracks) {
        return new SpatialRigEngine.Rig("fixture:rig", frame, "UNIT_QUATERNION_XYZW", List.of(), bones, tracks);
    }
    private static SpatialRigEngine.PoseKeyframe key(long n, long d, SpatialRigEngine.Vec3 position, SpatialRigEngine.Quaternion q) {
        return new SpatialRigEngine.PoseKeyframe(SpatialRigEngine.RationalTime.of(n, d), new SpatialRigEngine.LocalTransform(position, q));
    }
    private static SpatialRigEngine.Quaternion axisAngle(SpatialRigEngine.Vec3 axis, double angle) {
        var unit = axis.normalized(); double s = Math.sin(angle / 2);
        return new SpatialRigEngine.Quaternion(unit.x() * s, unit.y() * s, unit.z() * s, Math.cos(angle / 2));
    }
}
