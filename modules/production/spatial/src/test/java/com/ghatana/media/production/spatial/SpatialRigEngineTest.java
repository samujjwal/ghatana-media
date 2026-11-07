package com.ghatana.media.production.spatial;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.security.MessageDigest;
import java.util.List;
import java.util.Map;
import java.util.AbstractList;
import java.util.HexFormat;
import java.util.concurrent.atomic.AtomicInteger;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
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
        var versionBoundRig = new SpatialRigEngine.Rig("version-bound", canonicalFrame(), "UNIT_QUATERNION_XYZW",
                List.of(assetA, assetB), List.of(root), Map.of(), "project:revision:v2");
        var pose = engine.evaluateWithAuthority(versionBoundRig, SpatialRigEngine.RationalTime.of(0, 1),
                (SpatialRigEngine.SourceRightsPort) source -> SpatialRigEngine.RightsOutcome.ELIGIBLE);
        assertThat(pose.sourceProjectRevisionRef()).isEqualTo("project:revision:v2");
        assertThat(pose.sourceVersions()).containsExactly(assetA, assetB);
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
    void rejectsOverlongSourceIdentityBeforeItCanReachSpatialOutput() {
        String oversizedArtifactId = "a".repeat(385);

        assertThatIllegalArgumentException().isThrownBy(() -> new SpatialRigEngine.SourceVersionRef(
                "tenant-a", oversizedArtifactId, "version-v1"))
                .withMessageContaining("artifactId")
                .withMessageContaining("bounded");
    }

    @Test
    void rigCapsConsumeActualCollectionEntriesInsteadOfTrustingReportedSize() {
        var frame = glbFrame();
        var root = bone("root", null, SpatialRigEngine.LocalTransform.identity(), Math.PI);

        AtomicInteger sourceReads = new AtomicInteger();
        List<SpatialRigEngine.SourceVersionRef> sources = new java.util.ArrayList<>();
        for (int index = 0; index <= SpatialRigEngine.MAX_SOURCE_VERSIONS; index++) {
            sources.add(new SpatialRigEngine.SourceVersionRef("tenant", "artifact-" + index, "v1"));
        }
        assertThatThrownBy(() -> new SpatialRigEngine.Rig("too-many-sources", frame,
                "UNIT_QUATERNION_XYZW", underreported(sources, sourceReads), List.of(root), Map.of()))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("source-version count");
        assertThat(sourceReads).hasValue(SpatialRigEngine.MAX_SOURCE_VERSIONS);

        AtomicInteger boneReads = new AtomicInteger();
        List<SpatialRigEngine.Bone> bones = new java.util.ArrayList<>();
        for (int index = 0; index <= SpatialRigEngine.MAX_BONES; index++) {
            bones.add(bone("bone-" + index, null, SpatialRigEngine.LocalTransform.identity(), Math.PI));
        }
        assertThatThrownBy(() -> new SpatialRigEngine.Rig("too-many-bones", frame,
                "UNIT_QUATERNION_XYZW", List.of(), underreported(bones, boneReads), Map.of()))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("bone count");
        assertThat(boneReads).hasValue(SpatialRigEngine.MAX_BONES);

        AtomicInteger keyframeReads = new AtomicInteger();
        List<SpatialRigEngine.PoseKeyframe> keyframes = new java.util.ArrayList<>();
        for (int index = 0; index <= SpatialRigEngine.MAX_TRACKS_PER_BONE; index++) {
            keyframes.add(key(index, 1, SpatialRigEngine.Vec3.ZERO, SpatialRigEngine.Quaternion.IDENTITY));
        }
        assertThatThrownBy(() -> new SpatialRigEngine.Rig("too-many-keyframes", frame,
                "UNIT_QUATERNION_XYZW", List.of(), List.of(root), Map.of("root", underreported(keyframes, keyframeReads))))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("keyframe ceiling");
        assertThat(keyframeReads).hasValue(SpatialRigEngine.MAX_TRACKS_PER_BONE);
    }

    @Test
    void poseResultCapsSourceVersionsWhileConsumingActualEntries() {
        List<SpatialRigEngine.SourceVersionRef> sources = java.util.stream.IntStream
                .range(0, SpatialRigEngine.MAX_SOURCE_VERSIONS + 1)
                .mapToObj(index -> new SpatialRigEngine.SourceVersionRef("tenant", "artifact-" + index, "v1"))
                .toList();
        AtomicInteger consumed = new AtomicInteger();

        assertThatThrownBy(() -> new SpatialRigEngine.PoseResult("rig", "frame", "frame:v1",
                SpatialRigEngine.RationalTime.of(0, 1), Map.of(), "POSE_ONLY", false,
                null, underreported(sources, consumed)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("pose source-version count");
        assertThat(consumed).hasValue(SpatialRigEngine.MAX_SOURCE_VERSIONS);
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

    @Test
    void cameraProjectionRejectsConcatenatedFrameIdentityCollision() {
        var worldFrame = new SpatialRigEngine.CoordinateFrame("a@b", "c",
                SpatialRigEngine.Handedness.RIGHT_HANDED, SpatialRigEngine.AxisDirection.POS_X,
                SpatialRigEngine.AxisDirection.POS_Y, SpatialRigEngine.AxisDirection.POS_Z, METER, RADIAN_PROFILE);
        var cameraFrame = new SpatialRigEngine.CoordinateFrame("a", "b@c",
                SpatialRigEngine.Handedness.RIGHT_HANDED, SpatialRigEngine.AxisDirection.POS_X,
                SpatialRigEngine.AxisDirection.POS_Y, SpatialRigEngine.AxisDirection.POS_Z, METER, RADIAN_PROFILE);
        assertThat(worldFrame.identity()).isEqualTo(cameraFrame.identity());
        var camera = new SpatialRigEngine.PerspectiveCamera(cameraFrame, SpatialRigEngine.Vec3.ZERO,
                SpatialRigEngine.Quaternion.IDENTITY, Math.PI / 2, 0.1, 100, 640, 480);

        assertThatIllegalArgumentException().isThrownBy(() -> engine.project(
                new SpatialRigEngine.Vec3(0, 0, -2), worldFrame, camera))
                .withMessageContaining("same exact coordinate-frame");
    }

    @Test
    void exportsDecodableRevisionAndRightsBoundGlbWithRationalTimingAndSpatialMetadata() throws Exception {
        var frame = glbFrame();
        var root = bone("root", null, SpatialRigEngine.LocalTransform.identity(), Math.PI);
        var child = bone("child", "root", new SpatialRigEngine.LocalTransform(
                new SpatialRigEngine.Vec3(0, 1, 0), SpatialRigEngine.Quaternion.IDENTITY), Math.PI);
        var source = new SpatialRigEngine.SourceVersionRef("tenant-a", "artifact-rig", "version-4");
        var q90 = axisAngle(new SpatialRigEngine.Vec3(0, 0, 1), Math.PI / 2);
        var rig = new SpatialRigEngine.Rig("rig-export", frame, "UNIT_QUATERNION_XYZW", List.of(source),
                List.of(root, child), Map.of("root", List.of(
                        key(0, 1, SpatialRigEngine.Vec3.ZERO, SpatialRigEngine.Quaternion.IDENTITY),
                        key(1, 3, new SpatialRigEngine.Vec3(1.0 / 3.0, 0, 0), axisAngle(
                                new SpatialRigEngine.Vec3(0, 0, 1), Math.PI / 6)),
                        key(1, 1, new SpatialRigEngine.Vec3(1, 0, 0), q90))), "project:edit:revision-8");
        AtomicInteger checks = new AtomicInteger();

        var artifact = engine.exportGlb(rig, exact -> {
            checks.incrementAndGet();
            assertThat(exact).isEqualTo(source);
            return SpatialRigEngine.RightsOutcome.ELIGIBLE;
        });

        assertThat(checks.get()).isEqualTo(1);
        assertThat(artifact.rigId()).isEqualTo("rig-export");
        assertThat(artifact.sourceProjectRevisionRef()).isEqualTo("project:edit:revision-8");
        assertThat(artifact.sourceVersions()).containsExactly(source);
        assertThat(artifact.mimeType()).isEqualTo("model/gltf-binary");
        assertThat(artifact.lossDisposition()).isEqualTo("FLOAT32_APPROXIMATION");
        assertThat(artifact.sha256()).hasSize(64);
        byte[] exposedBytes = artifact.bytes();
        exposedBytes[0] = 0;
        assertThat(artifact.bytes()[0]).isEqualTo((byte) 0x67);
        assertThatIllegalArgumentException().isThrownBy(() -> new SpatialRigEngine.GlbArtifact(
                artifact.rigId(), artifact.sourceProjectRevisionRef(), artifact.frameRef(), artifact.frameVersionRef(),
                artifact.sourceVersions(), artifact.mimeType(), artifact.timeEncoding(), artifact.lossDisposition(),
                artifact.sha256(), exposedBytes));

        byte[] wrongDeclaredLength = artifact.bytes();
        ByteBuffer.wrap(wrongDeclaredLength).order(ByteOrder.LITTLE_ENDIAN)
                .putInt(8, wrongDeclaredLength.length - 4);
        String wrongLengthDigest = HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(wrongDeclaredLength));
        assertThatIllegalArgumentException().isThrownBy(() -> new SpatialRigEngine.GlbArtifact(
                artifact.rigId(), artifact.sourceProjectRevisionRef(), artifact.frameRef(), artifact.frameVersionRef(),
                artifact.sourceVersions(), artifact.mimeType(), artifact.timeEncoding(), artifact.lossDisposition(),
                wrongLengthDigest, wrongDeclaredLength))
                .withMessageContaining("GLB header is invalid");

        ByteBuffer glb = ByteBuffer.wrap(artifact.bytes()).order(ByteOrder.LITTLE_ENDIAN);
        assertThat(glb.getInt()).isEqualTo(0x46546c67);
        assertThat(glb.getInt()).isEqualTo(2);
        assertThat(glb.getInt()).isEqualTo(glb.capacity());
        int jsonLength = glb.getInt();
        assertThat(glb.getInt()).isEqualTo(0x4e4f534a);
        byte[] jsonBytes = new byte[jsonLength];
        glb.get(jsonBytes);
        JsonNode document = new ObjectMapper().readTree(jsonBytes);
        assertThat(document.path("asset").path("version").asString()).isEqualTo("2.0");
        assertThat(document.path("nodes").size()).isEqualTo(2);
        assertThat(document.path("scenes").get(0).path("nodes").get(0).intValue()).isEqualTo(1);
        assertThat(document.path("nodes").get(1).path("children").get(0).intValue()).isEqualTo(0);
        JsonNode metadata = document.path("extras").path("mediaSpatial");
        assertThat(metadata.path("frameRef").asString()).isEqualTo(frame.frameRef());
        assertThat(metadata.path("frameVersionRef").asString()).isEqualTo(frame.frameVersionRef());
        assertThat(metadata.path("handedness").asString()).isEqualTo(frame.handedness().name());
        assertThat(metadata.path("axisDirections").get(0).asString()).isEqualTo(frame.xAxis().name());
        assertThat(metadata.path("axisDirections").get(1).asString()).isEqualTo(frame.yAxis().name());
        assertThat(metadata.path("axisDirections").get(2).asString()).isEqualTo(frame.zAxis().name());
        assertThat(metadata.path("positionUnitRef").asString()).isEqualTo(frame.positionUnitRef());
        assertThat(metadata.path("orientationUnitRef").asString()).isEqualTo(frame.orientationUnitRef());
        assertThat(metadata.has("calibration")).isFalse();
        assertThat(metadata.has("worldFrameRef")).isFalse();
        assertThat(metadata.path("sourceProjectRevisionRef").asString()).isEqualTo("project:edit:revision-8");
        JsonNode float32LossFields = metadata.path("float32LossFields");
        assertThat(float32LossFields.size()).isEqualTo(3);
        assertThat(float32LossFields.get(0).asString()).isEqualTo("animation.inputTimeSeconds");
        assertThat(float32LossFields.get(1).asString()).isEqualTo("animation.outputTranslation");
        assertThat(float32LossFields.get(2).asString()).isEqualTo("animation.outputRotation");
        assertThat(metadata.path("exactKeyframeTimes").get(0).path("times").get(1).get(0).asString()).isEqualTo("1");
        assertThat(metadata.path("exactKeyframeTimes").get(0).path("times").get(1).get(1).asString()).isEqualTo("3");
        assertThat(metadata.path("exactKeyframeTimes").get(0).path("times").get(2).get(0).asString()).isEqualTo("1");
        assertThat(metadata.path("exactKeyframeTimes").get(0).path("times").get(2).get(1).asString()).isEqualTo("1");

        int binLength = glb.getInt();
        assertThat(glb.getInt()).isEqualTo(0x004e4942);
        byte[] bin = new byte[binLength];
        glb.get(bin);
        JsonNode animation = document.path("animations").get(0);
        assertThat(animation.path("channels").size()).isEqualTo(2);
        assertThat(animation.path("channels").get(0).path("target").path("path").asString()).isEqualTo("translation");
        JsonNode translationAccessor = document.path("accessors").get(
                animation.path("samplers").get(0).path("output").intValue());
        JsonNode translationView = document.path("bufferViews").get(translationAccessor.path("bufferView").intValue());
        ByteBuffer binary = ByteBuffer.wrap(bin).order(ByteOrder.LITTLE_ENDIAN);
        int translationOffset = translationView.path("byteOffset").intValue();
        assertThat(binary.getFloat(translationOffset + 12)).isEqualTo(1.0f / 3.0f);
        assertThat(binary.getFloat(translationOffset + 24)).isEqualTo(1.0f);
        JsonNode rotationAccessor = document.path("accessors").get(
                animation.path("samplers").get(1).path("output").intValue());
        JsonNode rotationView = document.path("bufferViews").get(rotationAccessor.path("bufferView").intValue());
        int rotationOffset = rotationView.path("byteOffset").intValue();
        assertThat(binary.getFloat(rotationOffset + 40)).isCloseTo((float) Math.sin(Math.PI / 4),
                org.assertj.core.data.Offset.offset(1e-6f));
        assertThat(binary.getFloat(rotationOffset + 44)).isCloseTo((float) Math.cos(Math.PI / 4),
                org.assertj.core.data.Offset.offset(1e-6f));
        assertThat(StandardCharsets.UTF_8.decode(ByteBuffer.wrap(jsonBytes)).toString()).contains("FLOAT32_APPROXIMATION");
    }

    @Test
    void publicGlbArtifactConstructorEnforcesOutputAndSourceVersionBounds() {
        var source = new SpatialRigEngine.SourceVersionRef("tenant-a", "artifact-rig", "version-4");
        var rig = new SpatialRigEngine.Rig("rig-bounds", glbFrame(), "UNIT_QUATERNION_XYZW", List.of(source),
                List.of(bone("root", null, SpatialRigEngine.LocalTransform.identity(), Math.PI)), Map.of(),
                "project:edit:revision-8");
        var artifact = engine.exportGlb(rig, ignored -> SpatialRigEngine.RightsOutcome.ELIGIBLE);

        assertThatIllegalArgumentException().isThrownBy(() -> copyArtifact(artifact,
                artifact.sourceVersions(), new byte[SpatialRigEngine.MAX_GLB_BYTES + 1]));
        assertThatIllegalArgumentException().isThrownBy(() -> copyArtifact(artifact, List.of(), artifact.bytes()));

        List<SpatialRigEngine.SourceVersionRef> tooManySources = java.util.stream.IntStream
                .range(0, SpatialRigEngine.MAX_SOURCE_VERSIONS + 1)
                .mapToObj(index -> new SpatialRigEngine.SourceVersionRef("tenant-a", "artifact-" + index, "version-1"))
                .toList();
        assertThatIllegalArgumentException().isThrownBy(() -> copyArtifact(artifact, tooManySources, artifact.bytes()));
        assertThatIllegalArgumentException().isThrownBy(() -> copyArtifact(artifact, List.of(source, source), artifact.bytes()));
    }

    @Test
    void publicGlbArtifactRejectsMalformedUtf8InJsonChunkEvenWhenDigestMatches() throws Exception {
        var source = new SpatialRigEngine.SourceVersionRef("tenant-a", "artifact-rig", "version-4");
        var rig = new SpatialRigEngine.Rig("rig-utf8", glbFrame(), "UNIT_QUATERNION_XYZW", List.of(source),
                List.of(bone("root", null, SpatialRigEngine.LocalTransform.identity(), Math.PI)), Map.of(),
                "project:edit:revision-8");
        var artifact = engine.exportGlb(rig, ignored -> SpatialRigEngine.RightsOutcome.ELIGIBLE);
        byte[] malformed = artifact.bytes();
        // GLB header (12) + JSON chunk header (8): corrupt the first UTF-8 JSON byte.
        malformed[20] = (byte) 0xff;
        String matchingDigest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(malformed));

        assertThatIllegalArgumentException().isThrownBy(() -> new SpatialRigEngine.GlbArtifact(
                artifact.rigId(), artifact.sourceProjectRevisionRef(), artifact.frameRef(), artifact.frameVersionRef(),
                artifact.sourceVersions(), artifact.mimeType(), artifact.timeEncoding(), artifact.lossDisposition(),
                matchingDigest, malformed))
                .withMessageContaining("valid UTF-8");
    }

    private static SpatialRigEngine.GlbArtifact copyArtifact(SpatialRigEngine.GlbArtifact source,
            List<SpatialRigEngine.SourceVersionRef> sourceVersions, byte[] bytes) {
        return new SpatialRigEngine.GlbArtifact(source.rigId(), source.sourceProjectRevisionRef(),
                source.frameRef(), source.frameVersionRef(), sourceVersions, source.mimeType(),
                source.timeEncoding(), source.lossDisposition(), source.sha256(), bytes);
    }

    @Test
    void spatialExportFailsClosedForMissingRightsRevisionAndUnrepresentableTime() {
        var source = new SpatialRigEngine.SourceVersionRef("tenant-a", "artifact-rig", "version-4");
        var bone = bone("root", null, SpatialRigEngine.LocalTransform.identity(), Math.PI);
        var keyedTrack = Map.of("root", List.of(
                key(16_777_216, 1, SpatialRigEngine.Vec3.ZERO, SpatialRigEngine.Quaternion.IDENTITY),
                key(16_777_217, 1, SpatialRigEngine.Vec3.ZERO, SpatialRigEngine.Quaternion.IDENTITY)));
        var rig = new SpatialRigEngine.Rig("rig-export", glbFrame(), "UNIT_QUATERNION_XYZW", List.of(source),
                List.of(bone), keyedTrack, "project:edit:revision-8");

        assertThatThrownBy(() -> engine.exportGlb(rig, (SpatialRigEngine.SourceRightsPort) null))
                .isInstanceOf(SpatialRigEngine.SourceRightsDeniedException.class)
                .satisfies(failure -> assertThat(((SpatialRigEngine.SourceRightsDeniedException) failure).outcome())
                        .isEqualTo(SpatialRigEngine.RightsOutcome.UNKNOWN));
        assertThatThrownBy(() -> engine.exportGlb(rig, ignored -> SpatialRigEngine.RightsOutcome.REVOKED))
                .isInstanceOf(SpatialRigEngine.SourceRightsDeniedException.class)
                .satisfies(failure -> assertThat(((SpatialRigEngine.SourceRightsDeniedException) failure).outcome())
                        .isEqualTo(SpatialRigEngine.RightsOutcome.REVOKED));
        assertThatThrownBy(() -> engine.exportGlb(rig, ignored -> { throw new IllegalStateException("authority unavailable"); }))
                .isInstanceOf(SpatialRigEngine.SourceRightsDeniedException.class)
                .satisfies(failure -> assertThat(((SpatialRigEngine.SourceRightsDeniedException) failure).outcome())
                        .isEqualTo(SpatialRigEngine.RightsOutcome.UNKNOWN));
        assertThatThrownBy(() -> engine.exportGlb(new SpatialRigEngine.Rig("no-revision", glbFrame(),
                "UNIT_QUATERNION_XYZW", List.of(source), List.of(bone), Map.of()),
                ignored -> SpatialRigEngine.RightsOutcome.ELIGIBLE))
                .isInstanceOf(SpatialRigEngine.SpatialExportBlockedException.class)
                .satisfies(failure -> assertThat(((SpatialRigEngine.SpatialExportBlockedException) failure).blocker())
                        .isEqualTo(SpatialRigEngine.ExportBlocker.PROJECT_REVISION_MISSING));
        assertThatThrownBy(() -> engine.exportGlb(new SpatialRigEngine.Rig("no-source-version", glbFrame(),
                "UNIT_QUATERNION_XYZW", List.of(), List.of(bone), Map.of(), "project:edit:revision-8"),
                ignored -> SpatialRigEngine.RightsOutcome.ELIGIBLE))
                .isInstanceOf(SpatialRigEngine.SpatialExportBlockedException.class)
                .satisfies(failure -> assertThat(((SpatialRigEngine.SpatialExportBlockedException) failure).blocker())
                        .isEqualTo(SpatialRigEngine.ExportBlocker.SOURCE_VERSION_MISSING));
        var unsupportedFrameRig = new SpatialRigEngine.Rig("unsupported-frame", canonicalFrame(),
                "UNIT_QUATERNION_XYZW", List.of(source), List.of(bone), Map.of(), "project:revision:v1");
        assertThatThrownBy(() -> engine.exportGlb(unsupportedFrameRig,
                ignored -> SpatialRigEngine.RightsOutcome.ELIGIBLE))
                .isInstanceOf(SpatialRigEngine.SpatialExportBlockedException.class)
                .satisfies(failure -> assertThat(((SpatialRigEngine.SpatialExportBlockedException) failure).blocker())
                        .isEqualTo(SpatialRigEngine.ExportBlocker.COORDINATE_PROFILE_UNSUPPORTED));
        assertThatThrownBy(() -> engine.exportGlb(rig, ignored -> SpatialRigEngine.RightsOutcome.ELIGIBLE))
                .isInstanceOf(SpatialRigEngine.SpatialExportBlockedException.class)
                .satisfies(failure -> assertThat(((SpatialRigEngine.SpatialExportBlockedException) failure).blocker())
                        .isEqualTo(SpatialRigEngine.ExportBlocker.NON_MONOTONIC_FLOAT_TIME));
    }

    @Test
    void glbJsonPreservesMalformedUtf16InExactSourceIdentity() throws Exception {
        String unpairedSurrogate = "artifact-" + (char) 0xd800;
        var source = new SpatialRigEngine.SourceVersionRef("tenant-a", unpairedSurrogate, "version-v1");
        var rig = new SpatialRigEngine.Rig("rig-utf16", glbFrame(), "UNIT_QUATERNION_XYZW",
                List.of(source), List.of(bone("root", null, SpatialRigEngine.LocalTransform.identity(), Math.PI)),
                Map.of(), "project:revision:utf16");

        var artifact = engine.exportGlb(rig, ignored -> SpatialRigEngine.RightsOutcome.ELIGIBLE);
        ByteBuffer glb = ByteBuffer.wrap(artifact.bytes()).order(ByteOrder.LITTLE_ENDIAN);
        glb.position(12);
        int jsonLength = glb.getInt();
        assertThat(glb.getInt()).isEqualTo(0x4e4f534a);
        byte[] jsonBytes = new byte[jsonLength];
        glb.get(jsonBytes);
        JsonNode metadata = new ObjectMapper().readTree(jsonBytes).path("extras").path("mediaSpatial");

        assertThat(metadata.path("sourceVersions").get(0).path("artifactId").asString())
                .isEqualTo(unpairedSurrogate);
    }

    private static SpatialRigEngine.CoordinateFrame canonicalFrame() {
        return frame("world", "world:v1", SpatialRigEngine.Handedness.RIGHT_HANDED,
                SpatialRigEngine.AxisDirection.POS_X, SpatialRigEngine.AxisDirection.POS_Y, SpatialRigEngine.AxisDirection.POS_Z);
    }
    private static SpatialRigEngine.CoordinateFrame glbFrame() {
        return new SpatialRigEngine.CoordinateFrame("urn:media:frame:glb", "v1",
                SpatialRigEngine.Handedness.RIGHT_HANDED, SpatialRigEngine.AxisDirection.POS_X,
                SpatialRigEngine.AxisDirection.POS_Y, SpatialRigEngine.AxisDirection.POS_Z,
                SpatialRigEngine.GLB_METRE_UNIT_REF, SpatialRigEngine.GLB_QUATERNION_UNIT_REF);
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

    private static <T> List<T> underreported(List<T> values, AtomicInteger consumed) {
        return new AbstractList<>() {
            @Override public T get(int index) { return values.get(index); }
            @Override public int size() { return 0; }
            @Override public java.util.Iterator<T> iterator() {
                java.util.Iterator<T> delegate = values.iterator();
                return new java.util.Iterator<>() {
                    @Override public boolean hasNext() { return delegate.hasNext(); }
                    @Override public T next() {
                        consumed.incrementAndGet();
                        return delegate.next();
                    }
                };
            }
        };
    }
}
