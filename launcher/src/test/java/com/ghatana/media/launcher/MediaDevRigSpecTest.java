package com.ghatana.media.launcher;

import com.ghatana.media.production.spatial.SpatialRigEngine;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** J-13 strict spec parser: every refusal names its JSON path and happens before any effect. */
class MediaDevRigSpecTest {
    static Map<String, Object> map(Object... pairs) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) out.put((String) pairs[i], pairs[i + 1]);
        return out;
    }

    static List<Object> list(Object... items) { return new ArrayList<>(List.of(items)); }

    static Map<String, Object> key(int frame, double degrees) {
        return map("frame", frame, "rotation", map("axis", list(0, 0, 1), "degrees", degrees));
    }

    static Map<String, Object> bone(String id, String parent, double[] rest, double[] tip, double maxDegrees, List<Object> keys) {
        return map("id", id, "parent", parent, "restPosition", list(rest[0], rest[1], rest[2]),
                "tip", list(tip[0], tip[1], tip[2]), "radius", 0.05, "color", "#4080FF",
                "maxDeviationDegrees", maxDegrees, "keyframes", keys);
    }

    /** Two-bone planar arm: shoulder (limit 120) and elbow (limit 150) about +Z, camera on +Z looking at the origin. */
    static Map<String, Object> arm() {
        Map<String, Object> spec = map("width", 320, "height", 240, "background", "#101828",
                "fps", map("numerator", 24, "denominator", 1), "frameCount", 24,
                "coordinateFrame", map("handedness", "RIGHT_HANDED", "upAxis", "Y", "unit", "METRE"),
                "camera", map("position", list(0.0, 0.5, 3.0), "lookAt", list(0.0, 0.5, 0.0), "verticalFovDegrees", 45.0,
                        "near", 0.1, "far", 20.0));
        spec.put("bones", list(
                bone("shoulder", null, new double[] {0, 0, 0}, new double[] {0.6, 0, 0}, 120,
                        list(key(0, 0), key(23, 90))),
                bone("elbow", "shoulder", new double[] {0.6, 0, 0}, new double[] {0.5, 0, 0}, 150,
                        list(key(0, 0), key(23, 100)))));
        spec.put("endEffector", map("bone", "elbow", "offset", list(0.5, 0, 0), "markerRadius", 0.06, "color", "#FF00FF"));
        return spec;
    }

    private static MediaDevRigRuntime.RigRefusedException refusal(Map<String, Object> spec) {
        Throwable thrown = org.assertj.core.api.Assertions.catchThrowable(() -> MediaDevRigSpec.parse("tenant-a", spec));
        assertThat(thrown).isInstanceOf(MediaDevRigRuntime.RigRefusedException.class);
        return (MediaDevRigRuntime.RigRefusedException) thrown;
    }

    @Test
    void validSpecParsesToARigWithTheAuthoredSourceAndExactRationalTimes() {
        MediaDevRigSpec.Parsed parsed = MediaDevRigSpec.parse("tenant-a", arm());
        assertThat(parsed.bones()).hasSize(2);
        assertThat(parsed.specSha256()).matches("[0-9a-f]{64}");
        SpatialRigEngine.Rig rig = parsed.rig("tenant-a", "r1");
        assertThat(rig.sourceVersions()).extracting(SpatialRigEngine.SourceVersionRef::artifactId)
                .containsExactly("authored-rig-spec");
        assertThat(parsed.time(7)).isEqualTo(SpatialRigEngine.RationalTime.of(7, 24));
        assertThat(rig.coordinateFrame().handedness()).isEqualTo(SpatialRigEngine.Handedness.RIGHT_HANDED);
        // canonical form is order independent: a re-ordered but equal spec has the same digest
        Map<String, Object> reordered = new LinkedHashMap<>();
        List<String> keys = new ArrayList<>(arm().keySet());
        java.util.Collections.reverse(keys);
        Map<String, Object> original = arm();
        for (String k : keys) reordered.put(k, original.get(k));
        assertThat(MediaDevRigSpec.parse("tenant-a", reordered).specSha256()).isEqualTo(parsed.specSha256());
    }

    @Test
    @SuppressWarnings("unchecked")
    void jointLimitViolationAtAKeyframeIs422WithTheKeyframePath() {
        Map<String, Object> spec = arm();
        ((List<Object>) ((Map<String, Object>) ((List<Object>) spec.get("bones")).get(1)).get("keyframes")).set(1, key(23, 151));
        MediaDevRigRuntime.RigRefusedException refused = refusal(spec);
        assertThat(refused.status()).isEqualTo(422);
        assertThat(refused.code()).isEqualTo("JOINT_LIMIT_EXCEEDED");
        assertThat(refused.details()).containsEntry("path", "$.bones[1].keyframes[1].rotation").containsEntry("bone", "elbow");
        assertThat((double) refused.details().get("requestedDegrees")).isEqualTo(151.0, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(refused.details()).containsEntry("limitDegrees", 150.0);
    }

    @Test
    @SuppressWarnings("unchecked")
    void jointLimitViolationBetweenKeyframesIsRefusedAtTheBoneWithTheInterval() {
        // +170 then -170 about Z are inside a 175 degree limit at both keys, but the shortest quaternion arc between them
        // swings through 180 degrees: the engine's analytic slerp bound refuses it and the spec names the bone.
        Map<String, Object> spec = arm();
        Map<String, Object> shoulder = (Map<String, Object>) ((List<Object>) spec.get("bones")).get(0);
        shoulder.put("maxDeviationDegrees", 175.0);
        shoulder.put("keyframes", list(key(0, 170), key(23, -170)));
        MediaDevRigRuntime.RigRefusedException refused = refusal(spec);
        assertThat(refused.code()).isEqualTo("JOINT_LIMIT_EXCEEDED");
        assertThat(refused.details().get("path").toString()).startsWith("$.bones[0].keyframes");
    }

    @Test
    void conventionsOtherThanRightHandedYUpMetreAreRefusedWithThePath() {
        for (String[] bad : new String[][] {{"handedness", "LEFT_HANDED"}, {"upAxis", "Z"}, {"unit", "MILLIMETRE"}}) {
            Map<String, Object> spec = arm();
            @SuppressWarnings("unchecked") Map<String, Object> frame = (Map<String, Object>) spec.get("coordinateFrame");
            frame.put(bad[0], bad[1]);
            MediaDevRigRuntime.RigRefusedException refused = refusal(spec);
            assertThat(refused.code()).isEqualTo("COORDINATE_PROFILE_UNSUPPORTED");
            assertThat(refused.details()).containsEntry("path", "$.coordinateFrame." + bad[0]);
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void structuralErrorsNameTheirPath() {
        Map<String, Object> unknown = arm();
        unknown.put("shaders", "none");
        assertThat(refusal(unknown).details()).containsEntry("path", "$.shaders");

        Map<String, Object> badParent = arm();
        ((Map<String, Object>) ((List<Object>) badParent.get("bones")).get(1)).put("parent", "missing");
        assertThat(refusal(badParent).details()).containsEntry("path", "$.bones[1].parent");

        Map<String, Object> zeroAxis = arm();
        ((Map<String, Object>) ((List<Object>) ((Map<String, Object>) ((List<Object>) zeroAxis.get("bones")).get(0))
                .get("keyframes")).get(1)).put("rotation", map("axis", list(0, 0, 0), "degrees", 10));
        assertThat(refusal(zeroAxis).details()).containsEntry("path", "$.bones[0].keyframes[1].rotation.axis");

        Map<String, Object> backwards = arm();
        ((Map<String, Object>) ((List<Object>) ((Map<String, Object>) ((List<Object>) backwards.get("bones")).get(0))
                .get("keyframes")).get(1)).put("frame", 0);
        assertThat(refusal(backwards).details()).containsEntry("path", "$.bones[0].keyframes[1].frame");

        Map<String, Object> badEffector = arm();
        ((Map<String, Object>) badEffector.get("endEffector")).put("bone", "wrist");
        assertThat(refusal(badEffector).details()).containsEntry("path", "$.endEffector.bone");

        Map<String, Object> lookDown = arm();
        ((Map<String, Object>) lookDown.get("camera")).put("lookAt", list(0.0, -5.0, 3.0));
        assertThat(refusal(lookDown).details()).containsEntry("path", "$.camera.lookAt");
    }

    @Test
    @SuppressWarnings("unchecked")
    void budgetsAreCeilingsWithDetails() {
        Map<String, Object> frames = arm();
        frames.put("frameCount", 241);
        MediaDevRigRuntime.RigRefusedException refused = refusal(frames);
        assertThat(refused.code()).isEqualTo("RIG_BUDGET_EXCEEDED");
        assertThat(refused.details()).containsEntry("path", "$.frameCount").containsEntry("requested", 241L)
                .containsEntry("ceiling", 240L);

        Map<String, Object> big = arm();
        big.put("width", 960);
        big.put("height", 540);
        big.put("frameCount", 100);
        assertThat(refusal(big).details()).containsEntry("limit", "total render pixels (width x height x frameCount)");

        Map<String, Object> bones = arm();
        List<Object> many = new ArrayList<>();
        for (int i = 0; i < 17; i++) many.add(bone("b" + i, null, new double[] {0, 0, 0}, new double[] {0.1, 0, 0}, 10, list()));
        bones.put("bones", many);
        assertThat(refusal(bones).details()).containsEntry("path", "$.bones").containsEntry("ceiling", 16L);

        Map<String, Object> keys = arm();
        List<Object> lots = new ArrayList<>();
        for (int i = 0; i < 65; i++) lots.add(map("frame", i % 24));
        ((Map<String, Object>) ((List<Object>) keys.get("bones")).get(0)).put("keyframes", lots);
        assertThat(refusal(keys).details()).containsEntry("path", "$.bones[0].keyframes");
        assertThatThrownBy(() -> MediaDevRigSpec.parse("tenant-a", "not an object")).isInstanceOf(MediaDevRigRuntime.RigRefusedException.class);
    }

    @Test
    @SuppressWarnings("unchecked")
    void assetsMustBeUsedAsTheFloorTexture() {
        Map<String, Object> spec = arm();
        spec.put("assets", list(map("id", "tex", "artifactId", "a1", "artifactVersionId", "v1")));
        assertThat(refusal(spec).details()).containsEntry("path", "$.assets");
        spec.put("floor", map("y", -0.5, "halfExtent", 2.0, "tiles", 4, "colorA", "#808080", "colorB", "#404040",
                "textureAssetId", "other"));
        assertThat(refusal(spec).details()).containsEntry("path", "$.floor.textureAssetId");
        ((Map<String, Object>) spec.get("floor")).put("textureAssetId", "tex");
        assertThat(MediaDevRigSpec.parse("tenant-a", spec).assets()).hasSize(1);
    }
}
