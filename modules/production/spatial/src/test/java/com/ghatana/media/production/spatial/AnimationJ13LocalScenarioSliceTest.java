package com.ghatana.media.production.spatial;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * J-13 source-free local scenario slice. It exercises the bounded spatial
 * engine and local GLB candidate only; it is not a hosted/product terminal result.
 */
class AnimationJ13LocalScenarioSliceTest {
    private static final SpatialRigEngine.SourceVersionRef SOURCE =
            new SpatialRigEngine.SourceVersionRef("tenant-j13", "rig-source", "rig-source:v3");
    private static final SpatialRigEngine.CoordinateFrame GLB_FRAME =
            new SpatialRigEngine.CoordinateFrame("urn:media:frame:glb", "v1",
                    SpatialRigEngine.Handedness.RIGHT_HANDED,
                    SpatialRigEngine.AxisDirection.POS_X,
                    SpatialRigEngine.AxisDirection.POS_Y,
                    SpatialRigEngine.AxisDirection.POS_Z,
                    SpatialRigEngine.GLB_METRE_UNIT_REF,
                    SpatialRigEngine.GLB_QUATERNION_UNIT_REF);

    @Test
    void authoredRigPreservesWorldCoordinatesAndKinematicsForExactAuthorizedSource() {
        var engine = new SpatialRigEngine();
        var rig = authoredRig();
        var checkedSources = new java.util.ArrayList<SpatialRigEngine.SourceVersionRef>();

        var result = engine.evaluateWithAuthority(rig, SpatialRigEngine.RationalTime.of(1, 1), source -> {
            checkedSources.add(source);
            return SpatialRigEngine.RightsOutcome.ELIGIBLE;
        });

        assertThat(checkedSources).containsExactly(SOURCE);
        assertThat(result.sourceProjectRevisionRef()).isEqualTo("project:j13:revision-7");
        assertThat(result.sourceVersions()).containsExactly(SOURCE);
        assertThat(result.frameRef()).isEqualTo(GLB_FRAME.frameRef());
        assertThat(result.frameVersionRef()).isEqualTo(GLB_FRAME.frameVersionRef());
        assertThat(result.outputScope()).isEqualTo("POSE_ONLY");
        assertThat(result.encodedSpatialOutputAvailable()).isFalse();

        var root = result.bones().get("root");
        assertThat(root.position().x()).isCloseTo(2.0, org.assertj.core.data.Offset.offset(1e-12));
        assertThat(root.position().y()).isCloseTo(0.0, org.assertj.core.data.Offset.offset(1e-12));
        var hand = result.bones().get("hand");
        // The parent's 90-degree Z rotation moves the child's local +Y offset to world -X.
        assertThat(hand.position().x()).isCloseTo(1.0, org.assertj.core.data.Offset.offset(1e-12));
        assertThat(hand.position().y()).isCloseTo(0.0, org.assertj.core.data.Offset.offset(1e-12));
        assertThat(hand.orientation().angularDistance(root.orientation()))
                .isCloseTo(0.0, org.assertj.core.data.Offset.offset(1e-12));
    }

    @Test
    void exactRightsRevocationBlocksPoseAndLocalGlbWhileEligibleRightsProduceBoundedBytes() throws Exception {
        var engine = new SpatialRigEngine();
        var rig = authoredRig();
        var checkedSources = new java.util.ArrayList<SpatialRigEngine.SourceVersionRef>();
        SpatialRigEngine.SourceRightsPort revoked = source -> {
            checkedSources.add(source);
            return SpatialRigEngine.RightsOutcome.REVOKED;
        };

        assertThatThrownBy(() -> engine.evaluateWithAuthority(rig,
                SpatialRigEngine.RationalTime.of(1, 1), revoked))
                .isInstanceOf(SpatialRigEngine.SourceRightsDeniedException.class)
                .satisfies(failure -> assertThat(((SpatialRigEngine.SourceRightsDeniedException) failure).outcome())
                        .isEqualTo(SpatialRigEngine.RightsOutcome.REVOKED));
        assertThatThrownBy(() -> engine.exportGlb(rig, revoked))
                .isInstanceOf(SpatialRigEngine.SourceRightsDeniedException.class)
                .satisfies(failure -> assertThat(((SpatialRigEngine.SourceRightsDeniedException) failure).outcome())
                        .isEqualTo(SpatialRigEngine.RightsOutcome.REVOKED));
        assertThat(checkedSources).containsExactly(SOURCE, SOURCE);

        var artifact = engine.exportGlb(rig, source -> {
            assertThat(source).isEqualTo(SOURCE);
            return SpatialRigEngine.RightsOutcome.ELIGIBLE;
        });
        byte[] bytes = artifact.bytes();
        ByteBuffer glb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        assertThat(glb.getInt()).isEqualTo(0x46546c67);
        assertThat(glb.getInt()).isEqualTo(2);
        assertThat(glb.getInt()).isEqualTo(bytes.length);
        int jsonLength = glb.getInt();
        assertThat(glb.getInt()).isEqualTo(0x4e4f534a);
        byte[] jsonBytes = new byte[jsonLength];
        glb.get(jsonBytes);
        JsonNode document = new ObjectMapper().readTree(jsonBytes);

        assertThat(bytes.length).isLessThanOrEqualTo(SpatialRigEngine.MAX_GLB_BYTES);
        assertThat(artifact.mimeType()).isEqualTo("model/gltf-binary");
        assertThat(artifact.rigId()).isEqualTo("j13-rig");
        assertThat(artifact.sourceProjectRevisionRef()).isEqualTo("project:j13:revision-7");
        assertThat(artifact.sourceVersions()).containsExactly(SOURCE);
        assertThat(artifact.sha256()).isEqualTo(java.util.HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(bytes)));
        assertThat(document.path("asset").path("version").asString()).isEqualTo("2.0");
        JsonNode metadata = document.path("extras").path("mediaSpatial");
        assertThat(metadata.path("frameVersionRef").asString()).isEqualTo(GLB_FRAME.frameVersionRef());
        assertThat(metadata.path("sourceProjectRevisionRef").asString()).isEqualTo("project:j13:revision-7");
        assertThat(metadata.path("sourceVersions").get(0).path("tenantId").asString()).isEqualTo("tenant-j13");
        assertThat(metadata.path("exactKeyframeTimes").get(0).path("times").get(1).get(0).asString()).isEqualTo("1");
        assertThat(metadata.path("exactKeyframeTimes").get(0).path("times").get(1).get(1).asString()).isEqualTo("1");
        assertThat(StandardCharsets.UTF_8.decode(ByteBuffer.wrap(jsonBytes)).toString())
                .contains("FLOAT32_APPROXIMATION");
    }

    @Test
    void unknownCurrentRightsBlockPoseAndLocalGlbBeforeProducingAnEffect() {
        var engine = new SpatialRigEngine();
        var rig = authoredRig();
        var checkedSources = new java.util.ArrayList<SpatialRigEngine.SourceVersionRef>();
        SpatialRigEngine.SourceRightsPort unknown = source -> {
            checkedSources.add(source);
            return SpatialRigEngine.RightsOutcome.UNKNOWN;
        };

        assertThatThrownBy(() -> engine.evaluateWithAuthority(rig,
                SpatialRigEngine.RationalTime.of(1, 1), unknown))
                .isInstanceOf(SpatialRigEngine.SourceRightsDeniedException.class)
                .satisfies(failure -> assertThat(((SpatialRigEngine.SourceRightsDeniedException) failure).outcome())
                        .isEqualTo(SpatialRigEngine.RightsOutcome.UNKNOWN));
        assertThatThrownBy(() -> engine.exportGlb(rig, unknown))
                .isInstanceOf(SpatialRigEngine.SourceRightsDeniedException.class)
                .satisfies(failure -> assertThat(((SpatialRigEngine.SourceRightsDeniedException) failure).outcome())
                        .isEqualTo(SpatialRigEngine.RightsOutcome.UNKNOWN));
        assertThat(checkedSources).containsExactly(SOURCE, SOURCE);
    }

    @Test
    void unknownRightsForSecondExactSourceBlockMultiSourceGlbExport() {
        var engine = new SpatialRigEngine();
        var baseRig = authoredRig();
        var secondSource = new SpatialRigEngine.SourceVersionRef(
                "tenant-j13", "reference-source", "reference-source:v2");
        var rig = new SpatialRigEngine.Rig(baseRig.id(), baseRig.coordinateFrame(),
                baseRig.orientationRepresentation(), List.of(SOURCE, secondSource), baseRig.bones(),
                baseRig.tracks(), baseRig.sourceProjectRevisionRef());
        var checkedSources = new java.util.ArrayList<SpatialRigEngine.SourceVersionRef>();

        assertThatThrownBy(() -> engine.exportGlb(rig, source -> {
            checkedSources.add(source);
            return source.equals(SOURCE)
                    ? SpatialRigEngine.RightsOutcome.ELIGIBLE
                    : SpatialRigEngine.RightsOutcome.UNKNOWN;
        }))
                .isInstanceOf(SpatialRigEngine.SourceRightsDeniedException.class)
                .satisfies(failure -> assertThat(((SpatialRigEngine.SourceRightsDeniedException) failure).outcome())
                        .isEqualTo(SpatialRigEngine.RightsOutcome.UNKNOWN));

        assertThat(checkedSources).containsExactly(SOURCE, secondSource);
    }

    @Test
    void glbPreflightRejectsJointLimitExceededAwayFromKeyframesAndSegmentMidpoint() {
        var limitedRoot = new SpatialRigEngine.Bone("root", null,
                SpatialRigEngine.LocalTransform.identity(), new SpatialRigEngine.JointConstraint(
                        SpatialRigEngine.JointKind.BALL, Math.toRadians(170)));
        var rig = new SpatialRigEngine.Rig("j13-limited-rig", GLB_FRAME, "UNIT_QUATERNION_XYZW",
                List.of(SOURCE), List.of(limitedRoot), Map.of("root", List.of(
                        key(0, SpatialRigEngine.Vec3.ZERO, axisAngleX(Math.toRadians(100))),
                        key(1, SpatialRigEngine.Vec3.ZERO, axisAngleX(Math.toRadians(-140))))),
                "project:j13:revision-8");

        // Both keys (100/140 degrees) and the 1/2 s midpoint (160 degrees) pass,
        // while shortest-arc interpolation reaches 180 degrees at 2/3 s.
        assertThatThrownBy(() -> new SpatialRigEngine().exportGlb(rig,
                source -> SpatialRigEngine.RightsOutcome.ELIGIBLE))
                .isInstanceOf(SpatialRigEngine.SpatialExportBlockedException.class)
                .satisfies(failure -> assertThat(
                        ((SpatialRigEngine.SpatialExportBlockedException) failure).blocker())
                        .isEqualTo(SpatialRigEngine.ExportBlocker.MOTION_CONSTRAINT_INVALID));
    }

    private static SpatialRigEngine.Rig authoredRig() {
        var root = bone("root", null, SpatialRigEngine.LocalTransform.identity());
        var hand = bone("hand", "root", new SpatialRigEngine.LocalTransform(
                new SpatialRigEngine.Vec3(0, 1, 0), SpatialRigEngine.Quaternion.IDENTITY));
        var turn = axisAngleZ(Math.PI / 2);
        return new SpatialRigEngine.Rig("j13-rig", GLB_FRAME, "UNIT_QUATERNION_XYZW", List.of(SOURCE),
                List.of(root, hand), Map.of("root", List.of(
                        key(0, SpatialRigEngine.Vec3.ZERO, SpatialRigEngine.Quaternion.IDENTITY),
                        key(1, new SpatialRigEngine.Vec3(2, 0, 0), turn))), "project:j13:revision-7");
    }

    private static SpatialRigEngine.Bone bone(String id, String parent,
            SpatialRigEngine.LocalTransform rest) {
        return new SpatialRigEngine.Bone(id, parent, rest, new SpatialRigEngine.JointConstraint(
                SpatialRigEngine.JointKind.BALL, Math.PI));
    }

    private static SpatialRigEngine.PoseKeyframe key(long seconds, SpatialRigEngine.Vec3 position,
            SpatialRigEngine.Quaternion orientation) {
        return new SpatialRigEngine.PoseKeyframe(SpatialRigEngine.RationalTime.of(seconds, 1),
                new SpatialRigEngine.LocalTransform(position, orientation));
    }

    private static SpatialRigEngine.Quaternion axisAngleZ(double radians) {
        return new SpatialRigEngine.Quaternion(0, 0, Math.sin(radians / 2), Math.cos(radians / 2));
    }

    private static SpatialRigEngine.Quaternion axisAngleX(double radians) {
        return new SpatialRigEngine.Quaternion(Math.sin(radians / 2), 0, 0, Math.cos(radians / 2));
    }
}
