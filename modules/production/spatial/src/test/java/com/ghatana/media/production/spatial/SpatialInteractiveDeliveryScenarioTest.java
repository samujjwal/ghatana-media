package com.ghatana.media.production.spatial;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

/**
 * Source-free J-28 boundary scenario. It proves the current spatial API can
 * expose an exact versioned pose while keeping the export and viewer outcome
 * unavailable when current source rights cannot be established.
 *
 * <p>This does not establish a rendered package, browser viewer fidelity,
 * destination delivery, or consumer receipt.
 */
class SpatialInteractiveDeliveryScenarioTest {
    @Test
    void encodedCandidateRetainsExactInputsAndDisclosesFloat32LossWithoutClaimingDelivery() throws Exception {
        var source = new SpatialRigEngine.SourceVersionRef("tenant-j28", "scene-j28", "scene-version-6");
        var frame = new SpatialRigEngine.CoordinateFrame(
                "urn:media:frame:j28-world", "frame-version-2",
                SpatialRigEngine.Handedness.RIGHT_HANDED,
                SpatialRigEngine.AxisDirection.POS_X,
                SpatialRigEngine.AxisDirection.POS_Y,
                SpatialRigEngine.AxisDirection.POS_Z,
                SpatialRigEngine.GLB_METRE_UNIT_REF,
                SpatialRigEngine.GLB_QUATERNION_UNIT_REF);
        var root = new SpatialRigEngine.Bone("camera-root", null,
                SpatialRigEngine.LocalTransform.identity(),
                new SpatialRigEngine.JointConstraint(SpatialRigEngine.JointKind.BALL, Math.PI));
        var rig = new SpatialRigEngine.Rig("j28-spatial-scene", frame, "UNIT_QUATERNION_XYZW",
                List.of(source), List.of(root),
                Map.of("camera-root", List.of(
                        new SpatialRigEngine.PoseKeyframe(SpatialRigEngine.RationalTime.of(1, 3),
                                new SpatialRigEngine.LocalTransform(new SpatialRigEngine.Vec3(0.1, 0, 0),
                                        SpatialRigEngine.Quaternion.IDENTITY)),
                        new SpatialRigEngine.PoseKeyframe(SpatialRigEngine.RationalTime.of(2, 3),
                                new SpatialRigEngine.LocalTransform(new SpatialRigEngine.Vec3(0.2, 0, 0),
                                        SpatialRigEngine.Quaternion.IDENTITY)))),
                "project:revision:j28-9");

        var candidate = new SpatialRigEngine().exportGlb(rig,
                ignored -> SpatialRigEngine.RightsOutcome.ELIGIBLE);
        ByteBuffer glb = ByteBuffer.wrap(candidate.bytes()).order(ByteOrder.LITTLE_ENDIAN);
        assertThat(glb.getInt()).isEqualTo(0x46546c67);
        assertThat(glb.getInt()).isEqualTo(2);
        assertThat(glb.getInt()).isEqualTo(glb.capacity());
        int jsonLength = glb.getInt();
        assertThat(glb.getInt()).isEqualTo(0x4e4f534a);
        byte[] jsonBytes = new byte[jsonLength];
        glb.get(jsonBytes);
        JsonNode metadata = new ObjectMapper().readTree(jsonBytes).path("extras").path("mediaSpatial");

        assertThat(candidate.sourceProjectRevisionRef()).isEqualTo("project:revision:j28-9");
        assertThat(candidate.sourceVersions()).containsExactly(source);
        assertThat(candidate.frameRef()).isEqualTo(frame.frameRef());
        assertThat(candidate.frameVersionRef()).isEqualTo(frame.frameVersionRef());
        assertThat(candidate.timeEncoding()).isEqualTo("FLOAT32_SECONDS");
        assertThat(candidate.lossDisposition()).isEqualTo("FLOAT32_APPROXIMATION");
        assertThat(metadata.path("float32LossFields").size()).isEqualTo(3);
        assertThat(metadata.path("float32LossFields").get(0).asString()).isEqualTo("animation.inputTimeSeconds");
        assertThat(metadata.path("float32LossFields").get(1).asString()).isEqualTo("animation.outputTranslation");
        assertThat(metadata.path("float32LossFields").get(2).asString()).isEqualTo("animation.outputRotation");
        assertThat(metadata.path("exactKeyframeTimes").get(0).path("times").get(0).get(0).asString())
                .isEqualTo("1");
        assertThat(metadata.path("exactKeyframeTimes").get(0).path("times").get(0).get(1).asString())
                .isEqualTo("3");
        assertThat(metadata.path("exactKeyframeTimes").get(0).path("times").get(1).get(0).asString())
                .isEqualTo("2");
        assertThat(metadata.path("exactKeyframeTimes").get(0).path("times").get(1).get(1).asString())
                .isEqualTo("3");
        assertThat(metadata.has("destinationRef")).isFalse();
        assertThat(metadata.has("consumerReceiptRef")).isFalse();
        // J-28 completion requires a source/target-bound conversion report. This
        // bounded GLB candidate has no target profile, transform plan, field
        // dispositions, or integrity evidence, so it must not look like that report.
        assertThat(List.of("sourceArtifactRef", "sourceArtifactVersionRef", "targetFormatProfileRef",
                "targetFormatProfileVersionRef", "sourceGeometryPlanRef", "coordinateTransformRef",
                "unitTransformRef", "axisTransformRef", "handednessDisposition", "originDisposition",
                "fieldDispositionRecords", "unsupportedFieldDisposition", "integrityEvidenceRef"))
                .allSatisfy(field -> assertThat(metadata.has(field)).as("J-28 report field %s", field).isFalse());

        // Caller mutation of an exposed payload must not mutate the immutable candidate.
        byte[] exposedBytes = candidate.bytes();
        exposedBytes[0] = 0;
        assertThat(candidate.bytes()[0]).isEqualTo((byte) 'g');
        assertThat(candidate.sha256()).isEqualTo(candidateSha256(candidate.bytes()));

        byte[] malformedEnvelope = candidate.bytes();
        ByteBuffer.wrap(malformedEnvelope).order(ByteOrder.LITTLE_ENDIAN)
                .putInt(8, malformedEnvelope.length - 4);
        String recomputedDigest = candidateSha256(malformedEnvelope);
        assertThatThrownBy(() -> new SpatialRigEngine.GlbArtifact(
                candidate.rigId(), candidate.sourceProjectRevisionRef(), candidate.frameRef(),
                candidate.frameVersionRef(), candidate.sourceVersions(), candidate.mimeType(),
                candidate.timeEncoding(), candidate.lossDisposition(), recomputedDigest, malformedEnvelope))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("GLB header is invalid");
    }

    @Test
    void unknownRightsKeepSpatialDeliveryUnavailableAndPoseIsNotAnEncodedExport() {
        var source = new SpatialRigEngine.SourceVersionRef("tenant-j28", "scene-j28", "scene-version-6");
        var frame = new SpatialRigEngine.CoordinateFrame(
                "urn:media:frame:j28-world", "frame-version-2",
                SpatialRigEngine.Handedness.RIGHT_HANDED,
                SpatialRigEngine.AxisDirection.POS_X,
                SpatialRigEngine.AxisDirection.POS_Y,
                SpatialRigEngine.AxisDirection.POS_Z,
                SpatialRigEngine.GLB_METRE_UNIT_REF,
                SpatialRigEngine.GLB_QUATERNION_UNIT_REF);
        var root = new SpatialRigEngine.Bone("camera-root", null,
                SpatialRigEngine.LocalTransform.identity(),
                new SpatialRigEngine.JointConstraint(SpatialRigEngine.JointKind.BALL, Math.PI));
        var rig = new SpatialRigEngine.Rig("j28-spatial-scene", frame, "UNIT_QUATERNION_XYZW",
                List.of(source), List.of(root), Map.of(), "project:revision:j28-9");
        var engine = new SpatialRigEngine();

        var pose = engine.evaluateWithAuthority(rig, SpatialRigEngine.RationalTime.of(3, 2),
                ignored -> SpatialRigEngine.RightsOutcome.ELIGIBLE);

        assertThat(pose.outputScope()).isEqualTo("POSE_ONLY");
        assertThat(pose.encodedSpatialOutputAvailable()).isFalse();
        assertThat(pose.sourceProjectRevisionRef()).isEqualTo("project:revision:j28-9");
        assertThat(pose.sourceVersions()).containsExactly(source);
        assertThat(pose.frameRef()).isEqualTo("urn:media:frame:j28-world");
        assertThat(pose.frameVersionRef()).isEqualTo("frame-version-2");

        assertThatThrownBy(() -> engine.exportGlb(rig,
                ignored -> SpatialRigEngine.RightsOutcome.UNKNOWN))
                .isInstanceOf(SpatialRigEngine.SourceRightsDeniedException.class)
                .satisfies(failure -> assertThat(((SpatialRigEngine.SourceRightsDeniedException) failure).outcome())
                        .isEqualTo(SpatialRigEngine.RightsOutcome.UNKNOWN));
    }

    @Test
    void oneUnknownSourceVersionBlocksExportAfterCheckingEveryExactVersion() {
        var firstSource = new SpatialRigEngine.SourceVersionRef("tenant-j28", "scene-j28", "scene-version-6");
        var secondSource = new SpatialRigEngine.SourceVersionRef("tenant-j28", "overlay-j28", "overlay-version-3");
        var frame = new SpatialRigEngine.CoordinateFrame(
                "urn:media:frame:j28-world", "frame-version-2",
                SpatialRigEngine.Handedness.RIGHT_HANDED,
                SpatialRigEngine.AxisDirection.POS_X,
                SpatialRigEngine.AxisDirection.POS_Y,
                SpatialRigEngine.AxisDirection.POS_Z,
                SpatialRigEngine.GLB_METRE_UNIT_REF,
                SpatialRigEngine.GLB_QUATERNION_UNIT_REF);
        var root = new SpatialRigEngine.Bone("camera-root", null,
                SpatialRigEngine.LocalTransform.identity(),
                new SpatialRigEngine.JointConstraint(SpatialRigEngine.JointKind.BALL, Math.PI));
        var rig = new SpatialRigEngine.Rig("j28-spatial-scene", frame, "UNIT_QUATERNION_XYZW",
                List.of(firstSource, secondSource), List.of(root), Map.of(), "project:revision:j28-9");
        List<SpatialRigEngine.SourceVersionRef> checked = new ArrayList<>();

        assertThatThrownBy(() -> new SpatialRigEngine().exportGlb(rig, source -> {
            checked.add(source);
            return source.equals(firstSource)
                    ? SpatialRigEngine.RightsOutcome.ELIGIBLE
                    : SpatialRigEngine.RightsOutcome.UNKNOWN;
        }))
                .isInstanceOf(SpatialRigEngine.SourceRightsDeniedException.class)
                .satisfies(failure -> assertThat(((SpatialRigEngine.SourceRightsDeniedException) failure).outcome())
                        .isEqualTo(SpatialRigEngine.RightsOutcome.UNKNOWN));
        assertThat(checked).containsExactly(firstSource, secondSource);
    }

    @Test
    void unsupportedCoordinateProfileBlocksSpatialExport() {
        var source = new SpatialRigEngine.SourceVersionRef("tenant-j28", "scene-j28", "scene-version-6");
        var unsupportedFrame = new SpatialRigEngine.CoordinateFrame(
                "urn:media:frame:j28-foot-units", "frame-version-1",
                SpatialRigEngine.Handedness.RIGHT_HANDED,
                SpatialRigEngine.AxisDirection.POS_X,
                SpatialRigEngine.AxisDirection.POS_Y,
                SpatialRigEngine.AxisDirection.POS_Z,
                "urn:media:unit:foot",
                SpatialRigEngine.GLB_QUATERNION_UNIT_REF);
        var root = new SpatialRigEngine.Bone("camera-root", null,
                SpatialRigEngine.LocalTransform.identity(),
                new SpatialRigEngine.JointConstraint(SpatialRigEngine.JointKind.BALL, Math.PI));
        var rig = new SpatialRigEngine.Rig("j28-spatial-scene", unsupportedFrame, "UNIT_QUATERNION_XYZW",
                List.of(source), List.of(root), Map.of(), "project:revision:j28-9");

        assertThatThrownBy(() -> new SpatialRigEngine().exportGlb(rig,
                ignored -> SpatialRigEngine.RightsOutcome.ELIGIBLE))
                .isInstanceOf(SpatialRigEngine.SpatialExportBlockedException.class)
                .satisfies(failure -> assertThat(
                        ((SpatialRigEngine.SpatialExportBlockedException) failure).blocker())
                        .isEqualTo(SpatialRigEngine.ExportBlocker.COORDINATE_PROFILE_UNSUPPORTED));
    }

    private static String candidateSha256(byte[] bytes) throws Exception {
        return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
    }
}
