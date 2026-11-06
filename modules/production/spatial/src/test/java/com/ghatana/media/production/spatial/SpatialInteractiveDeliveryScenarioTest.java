package com.ghatana.media.production.spatial;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.Map;
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
}
