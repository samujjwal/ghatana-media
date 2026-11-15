package com.ghatana.media.launcher;

import com.ghatana.media.production.spatial.SpatialRigEngine;
import com.ghatana.media.production.spatial.SpatialRigEngine.AxisDirection;
import com.ghatana.media.production.spatial.SpatialRigEngine.Bone;
import com.ghatana.media.production.spatial.SpatialRigEngine.CoordinateFrame;
import com.ghatana.media.production.spatial.SpatialRigEngine.Handedness;
import com.ghatana.media.production.spatial.SpatialRigEngine.JointConstraint;
import com.ghatana.media.production.spatial.SpatialRigEngine.JointKind;
import com.ghatana.media.production.spatial.SpatialRigEngine.LocalTransform;
import com.ghatana.media.production.spatial.SpatialRigEngine.PoseKeyframe;
import com.ghatana.media.production.spatial.SpatialRigEngine.Quaternion;
import com.ghatana.media.production.spatial.SpatialRigEngine.RationalTime;
import com.ghatana.media.production.spatial.SpatialRigEngine.RightsOutcome;
import com.ghatana.media.production.spatial.SpatialRigEngine.Rig;
import com.ghatana.media.production.spatial.SpatialRigEngine.SourceVersionRef;
import com.ghatana.media.production.spatial.SpatialRigEngine.SpatialExportBlockedException;
import com.ghatana.media.production.spatial.SpatialRigEngine.Vec3;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * Strict parser and budget gate of the DEV_ONLY 3D rig render spec ({@code media.dev.rig-render-spec.v1}). Every
 * refusal carries the JSON path of the offending value ({@code $.bones[1].keyframes[2].rotation}). A structural or
 * value error is {@code RIG_SPEC_INVALID}, a ceiling is {@code RIG_BUDGET_EXCEEDED}, a convention other than
 * right-handed / Y-up / metres is {@code COORDINATE_PROFILE_UNSUPPORTED} and a rotation beyond a joint limit
 * (at a keyframe, or anywhere between two keyframes) is {@code JOINT_LIMIT_EXCEEDED}. Nothing here reads a source,
 * calls the rights authority or starts a process.
 *
 * <p>Rotations in the spec are axis-angle deltas <em>relative to the bone's rest orientation</em>; the limit is the
 * ball-joint angular deviation from rest, the same quantity the verified {@link SpatialRigEngine} enforces. Keyframe
 * times are frame indices, so every sample time is the exact rational {@code frame * fpsDen / fpsNum} seconds.</p>
 */
final class MediaDevRigSpec {
    static final String SCHEMA = "media.dev.rig-render-spec.v1";
    static final int MIN_SIDE = 64;
    static final int MAX_WIDTH = 960;
    static final int MAX_HEIGHT = 540;
    static final int MAX_FRAMES = 240;
    static final int MAX_FPS = 60;
    static final int MAX_BONES = 16;
    static final int MAX_KEYFRAMES_PER_BONE = 64;
    static final int MAX_ASSETS = 4;
    static final int MAX_FLOOR_TILES = 32;
    static final long MAX_PIXELS = 33_554_432L;
    static final double MAX_COORDINATE = 1_000.0;
    static final String FRAME_REF = "frame:media-dev-rig";
    static final String FRAME_VERSION = "v1";
    private static final ObjectMapper JSON = JsonMapper.builder().build();

    /** A named image asset (floor texture): the exact artifact version that holds its pixels. */
    record AssetRef(String id, String artifactId, String artifactVersionId, String path) { }

    record Key(int frame, Vec3 axis, double degrees, Vec3 position, String path) { }

    record BoneSpec(String id, String parent, Vec3 restPosition, Vec3 restAxis, double restDegrees, Vec3 tip,
                    double radius, int rgb, double maxDeviationDegrees, List<Key> keys, String path) { }

    record CameraSpec(Vec3 position, Vec3 lookAt, double fovDegrees, double near, double far) { }

    record MarkerSpec(String bone, Vec3 offset, double radius, int rgb) { }

    record FloorSpec(double y, double halfExtent, int tiles, int rgbA, int rgbB, String textureAssetId) { }

    record Parsed(int width, int height, int backgroundRgb, int fpsNumerator, int fpsDenominator, int frameCount,
                  CameraSpec camera, List<BoneSpec> bones, MarkerSpec marker, FloorSpec floor, List<AssetRef> assets,
                  Map<String, Object> canonical, String specSha256) {
        /** Engine rig for this spec. Rig source versions: the authored spec digest plus every asset version. */
        Rig rig(String tenantId, String requestId) {
            List<SourceVersionRef> sources = new ArrayList<>();
            sources.add(authoredSource(tenantId));
            for (AssetRef asset : assets) sources.add(new SourceVersionRef(tenantId, asset.artifactId(), asset.artifactVersionId()));
            List<Bone> engineBones = new ArrayList<>();
            Map<String, List<PoseKeyframe>> tracks = new HashMap<>();
            for (BoneSpec bone : bones) {
                Quaternion rest = axisAngle(bone.restAxis(), bone.restDegrees());
                LocalTransform restPose = new LocalTransform(bone.restPosition(), rest);
                engineBones.add(new Bone(bone.id(), bone.parent(), restPose,
                        new JointConstraint(JointKind.BALL, StrictMath.toRadians(bone.maxDeviationDegrees()))));
                if (!bone.keys().isEmpty()) {
                    List<PoseKeyframe> keys = new ArrayList<>();
                    for (Key key : bone.keys()) {
                        Vec3 position = key.position() == null ? bone.restPosition() : key.position();
                        keys.add(new PoseKeyframe(time(key.frame()),
                                new LocalTransform(position, rest.multiply(axisAngle(key.axis(), key.degrees())))));
                    }
                    tracks.put(bone.id(), keys);
                }
            }
            return new Rig("rig-" + specSha256.substring(0, 16), frame(), "UNIT_QUATERNION_XYZW", sources, engineBones,
                    tracks, "rig-render:" + requestId + ":" + specSha256);
        }

        SourceVersionRef authoredSource(String tenantId) {
            return new SourceVersionRef(tenantId, "authored-rig-spec", "sha256:" + specSha256);
        }

        RationalTime time(int frameIndex) {
            return RationalTime.of((long) frameIndex * fpsDenominator, fpsNumerator);
        }
    }

    private MediaDevRigSpec() { }

    static CoordinateFrame frame() {
        return new CoordinateFrame(FRAME_REF, FRAME_VERSION, Handedness.RIGHT_HANDED, AxisDirection.POS_X,
                AxisDirection.POS_Y, AxisDirection.POS_Z, SpatialRigEngine.GLB_METRE_UNIT_REF,
                SpatialRigEngine.GLB_QUATERNION_UNIT_REF);
    }

    static Quaternion axisAngle(Vec3 axis, double degrees) {
        double half = StrictMath.toRadians(degrees) / 2.0;
        Vec3 unit = axis.normalized();
        double s = StrictMath.sin(half);
        return new Quaternion(unit.x() * s, unit.y() * s, unit.z() * s, StrictMath.cos(half));
    }

    /** Camera-to-world orientation for a camera that looks from {@code position} at {@code lookAt} with +Y as up. */
    static Quaternion lookAt(Vec3 position, Vec3 target) {
        Vec3 forward = target.subtract(position).normalized();
        Vec3 right = forward.cross(new Vec3(0, 1, 0)).normalized();
        Vec3 up = right.cross(forward);
        // columns of the camera-to-world rotation: x = right, y = up, z = -forward
        double m00 = right.x(), m01 = up.x(), m02 = -forward.x();
        double m10 = right.y(), m11 = up.y(), m12 = -forward.y();
        double m20 = right.z(), m21 = up.z(), m22 = -forward.z();
        double trace = m00 + m11 + m22;
        double x, y, z, w;
        if (trace > 0) {
            double s = StrictMath.sqrt(trace + 1.0) * 2;
            w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
        } else if (m00 > m11 && m00 > m22) {
            double s = StrictMath.sqrt(1.0 + m00 - m11 - m22) * 2;
            w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
        } else if (m11 > m22) {
            double s = StrictMath.sqrt(1.0 + m11 - m00 - m22) * 2;
            w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
        } else {
            double s = StrictMath.sqrt(1.0 + m22 - m00 - m11) * 2;
            w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
        }
        return new Quaternion(x, y, z, w);
    }

    static MediaDevRigRuntime.RigRefusedException invalid(String path, String message) {
        return new MediaDevRigRuntime.RigRefusedException(422, "RIG_SPEC_INVALID", message, Map.of("path", path));
    }

    static MediaDevRigRuntime.RigRefusedException budget(String path, String limit, long ceiling, long requested) {
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("path", path);
        details.put("limit", limit);
        details.put("ceiling", ceiling);
        details.put("requested", requested);
        return new MediaDevRigRuntime.RigRefusedException(422, "RIG_BUDGET_EXCEEDED",
                limit + " exceeds its ceiling; nothing was rendered", details);
    }

    static MediaDevRigRuntime.RigRefusedException jointLimit(String path, String bone, double limitDegrees,
                                                             double requestedDegrees, Integer frame) {
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("path", path);
        details.put("bone", bone);
        details.put("limitDegrees", limitDegrees);
        if (!Double.isNaN(requestedDegrees)) details.put("requestedDegrees", requestedDegrees);
        if (frame != null) details.put("frame", frame);
        return new MediaDevRigRuntime.RigRefusedException(422, "JOINT_LIMIT_EXCEEDED",
                "the motion exceeds the joint limit of bone " + bone + "; nothing was rendered", details);
    }

    static Parsed parse(String tenantId, Object rawSpec) {
        Map<String, Object> spec = object(rawSpec, "$");
        keys(spec, "$", Set.of("width", "height", "background", "fps", "frameCount", "coordinateFrame", "camera",
                "bones", "endEffector"), Set.of("floor", "assets"));
        int width = integer(spec.get("width"), "$.width");
        int height = integer(spec.get("height"), "$.height");
        if (width < MIN_SIDE) throw invalid("$.width", "frame sides must be at least " + MIN_SIDE + " pixels");
        if (height < MIN_SIDE) throw invalid("$.height", "frame sides must be at least " + MIN_SIDE + " pixels");
        if (width % 2 != 0) throw invalid("$.width", "width must be even (yuv420p video)");
        if (height % 2 != 0) throw invalid("$.height", "height must be even (yuv420p video)");
        if (width > MAX_WIDTH) throw budget("$.width", "width", MAX_WIDTH, width);
        if (height > MAX_HEIGHT) throw budget("$.height", "height", MAX_HEIGHT, height);
        int background = color(spec.get("background"), "$.background");
        Map<String, Object> fps = object(spec.get("fps"), "$.fps");
        keys(fps, "$.fps", Set.of("numerator", "denominator"), Set.of());
        int fpsNumerator = integer(fps.get("numerator"), "$.fps.numerator");
        int fpsDenominator = integer(fps.get("denominator"), "$.fps.denominator");
        if (fpsDenominator < 1 || fpsDenominator > 10_000) {
            throw invalid("$.fps.denominator", "denominator must be within [1, 10000]");
        }
        if (fpsNumerator < fpsDenominator) throw invalid("$.fps", "the frame rate must be at least 1 frame per second");
        if ((long) fpsNumerator > (long) MAX_FPS * fpsDenominator) {
            throw budget("$.fps", "frames per second", MAX_FPS, Math.round((double) fpsNumerator / fpsDenominator));
        }
        int frameCount = integer(spec.get("frameCount"), "$.frameCount");
        if (frameCount < 1) throw invalid("$.frameCount", "frameCount must be at least 1");
        if (frameCount > MAX_FRAMES) throw budget("$.frameCount", "frameCount", MAX_FRAMES, frameCount);
        long pixels = (long) width * height * frameCount;
        if (pixels > MAX_PIXELS) {
            throw budget("$", "total render pixels (width x height x frameCount)", MAX_PIXELS, pixels);
        }

        // ---- coordinate conventions: only the right-handed, Y-up, metre profile is supported ----
        Map<String, Object> frame = object(spec.get("coordinateFrame"), "$.coordinateFrame");
        keys(frame, "$.coordinateFrame", Set.of("handedness", "upAxis", "unit"), Set.of());
        if (!"RIGHT_HANDED".equals(string(frame.get("handedness"), "$.coordinateFrame.handedness"))) {
            throw unsupported("$.coordinateFrame.handedness", "only RIGHT_HANDED is supported");
        }
        if (!"Y".equals(string(frame.get("upAxis"), "$.coordinateFrame.upAxis"))) {
            throw unsupported("$.coordinateFrame.upAxis", "only Y-up is supported");
        }
        if (!"METRE".equals(string(frame.get("unit"), "$.coordinateFrame.unit"))) {
            throw unsupported("$.coordinateFrame.unit", "only METRE is supported");
        }

        // ---- assets ----
        Set<String> assetIds = new HashSet<>();
        List<AssetRef> assets = new ArrayList<>();
        List<Object> rawAssets = list(spec.getOrDefault("assets", List.of()), "$.assets");
        if (rawAssets.size() > MAX_ASSETS) throw budget("$.assets", "assets", MAX_ASSETS, rawAssets.size());
        for (int i = 0; i < rawAssets.size(); i++) {
            String path = "$.assets[" + i + "]";
            Map<String, Object> asset = object(rawAssets.get(i), path);
            keys(asset, path, Set.of("id", "artifactId", "artifactVersionId"), Set.of());
            String id = id(asset.get("id"), path + ".id");
            if (!assetIds.add(id)) throw invalid(path + ".id", "asset ids must be unique");
            assets.add(new AssetRef(id, string(asset.get("artifactId"), path + ".artifactId"),
                    string(asset.get("artifactVersionId"), path + ".artifactVersionId"), path));
        }

        // ---- camera ----
        Map<String, Object> cam = object(spec.get("camera"), "$.camera");
        keys(cam, "$.camera", Set.of("position", "lookAt", "verticalFovDegrees", "near", "far"), Set.of());
        Vec3 position = vec(cam.get("position"), "$.camera.position");
        Vec3 target = vec(cam.get("lookAt"), "$.camera.lookAt");
        Vec3 view = target.subtract(position);
        if (view.length() < 1e-6) throw invalid("$.camera.lookAt", "lookAt must differ from the camera position");
        if (Math.abs(view.normalized().y()) > 0.999) {
            throw invalid("$.camera.lookAt", "the camera must not look straight up or down (Y is its up axis)");
        }
        double fov = number(cam.get("verticalFovDegrees"), "$.camera.verticalFovDegrees");
        if (fov <= 5 || fov >= 150) throw invalid("$.camera.verticalFovDegrees", "must be within (5, 150) degrees");
        double near = number(cam.get("near"), "$.camera.near");
        double far = number(cam.get("far"), "$.camera.far");
        if (near <= 0.001) throw invalid("$.camera.near", "must be greater than 0.001 metres");
        if (far <= near || far > MAX_COORDINATE) throw invalid("$.camera.far", "must be greater than near and at most 1000");
        CameraSpec camera = new CameraSpec(position, target, fov, near, far);

        // ---- bones ----
        List<Object> rawBones = list(spec.get("bones"), "$.bones");
        if (rawBones.isEmpty()) throw invalid("$.bones", "at least one bone is required");
        if (rawBones.size() > MAX_BONES) throw budget("$.bones", "bones", MAX_BONES, rawBones.size());
        Set<String> boneIds = new HashSet<>();
        List<BoneSpec> bones = new ArrayList<>();
        for (int i = 0; i < rawBones.size(); i++) {
            String path = "$.bones[" + i + "]";
            Map<String, Object> bone = object(rawBones.get(i), path);
            keys(bone, path, Set.of("id", "parent", "restPosition", "tip", "radius", "color", "maxDeviationDegrees"),
                    Set.of("restRotation", "keyframes"));
            String id = id(bone.get("id"), path + ".id");
            if (!boneIds.add(id)) throw invalid(path + ".id", "bone ids must be unique");
            String parent = null;
            if (bone.get("parent") != null) parent = id(bone.get("parent"), path + ".parent");
            else if (!bone.containsKey("parent")) throw invalid(path + ".parent", "is required (null for a root bone)");
            Vec3 restPosition = vec(bone.get("restPosition"), path + ".restPosition");
            Vec3 restAxis = new Vec3(0, 0, 1);
            double restDegrees = 0;
            if (bone.containsKey("restRotation")) {
                Map<String, Object> rest = object(bone.get("restRotation"), path + ".restRotation");
                keys(rest, path + ".restRotation", Set.of("axis", "degrees"), Set.of());
                restAxis = axis(rest.get("axis"), path + ".restRotation.axis");
                restDegrees = number(rest.get("degrees"), path + ".restRotation.degrees");
            }
            Vec3 tip = vec(bone.get("tip"), path + ".tip");
            double radius = number(bone.get("radius"), path + ".radius");
            if (radius < 0.001 || radius > 10) throw invalid(path + ".radius", "must be within [0.001, 10] metres");
            int rgb = color(bone.get("color"), path + ".color");
            double maxDeviation = number(bone.get("maxDeviationDegrees"), path + ".maxDeviationDegrees");
            if (maxDeviation < 0 || maxDeviation > 180) {
                throw invalid(path + ".maxDeviationDegrees", "must be within [0, 180] degrees");
            }
            List<Object> rawKeys = list(bone.getOrDefault("keyframes", List.of()), path + ".keyframes");
            if (rawKeys.size() > MAX_KEYFRAMES_PER_BONE) {
                throw budget(path + ".keyframes", "keyframes per bone", MAX_KEYFRAMES_PER_BONE, rawKeys.size());
            }
            List<Key> keyList = new ArrayList<>();
            int previous = -1;
            for (int k = 0; k < rawKeys.size(); k++) {
                String keyPath = path + ".keyframes[" + k + "]";
                Map<String, Object> key = object(rawKeys.get(k), keyPath);
                keys(key, keyPath, Set.of("frame"), Set.of("rotation", "position"));
                int frameIndex = integer(key.get("frame"), keyPath + ".frame");
                if (frameIndex < 0 || frameIndex >= frameCount) {
                    throw invalid(keyPath + ".frame", "frame must be within [0, frameCount - 1]");
                }
                if (frameIndex <= previous) throw invalid(keyPath + ".frame", "keyframes must have strictly increasing frames");
                previous = frameIndex;
                Vec3 keyAxis = new Vec3(0, 0, 1);
                double degrees = 0;
                if (key.containsKey("rotation")) {
                    Map<String, Object> rotation = object(key.get("rotation"), keyPath + ".rotation");
                    keys(rotation, keyPath + ".rotation", Set.of("axis", "degrees"), Set.of());
                    keyAxis = axis(rotation.get("axis"), keyPath + ".rotation.axis");
                    degrees = number(rotation.get("degrees"), keyPath + ".rotation.degrees");
                    if (Math.abs(degrees) > 720) throw invalid(keyPath + ".rotation.degrees", "must be within [-720, 720]");
                }
                Vec3 keyPosition = key.containsKey("position") ? vec(key.get("position"), keyPath + ".position") : null;
                double deviation = deviationDegrees(keyAxis, degrees);
                if (deviation > maxDeviation + 1e-9) {
                    throw jointLimit(keyPath + ".rotation", id, maxDeviation, deviation, frameIndex);
                }
                keyList.add(new Key(frameIndex, keyAxis, degrees, keyPosition, keyPath));
            }
            bones.add(new BoneSpec(id, parent, restPosition, restAxis, restDegrees, tip, radius, rgb, maxDeviation,
                    List.copyOf(keyList), path));
        }
        for (int i = 0; i < bones.size(); i++) {
            BoneSpec bone = bones.get(i);
            if (bone.parent() != null && !boneIds.contains(bone.parent())) {
                throw invalid("$.bones[" + i + "].parent", "parent does not name a bone");
            }
        }

        // ---- end effector ----
        Map<String, Object> effector = object(spec.get("endEffector"), "$.endEffector");
        keys(effector, "$.endEffector", Set.of("bone", "offset", "markerRadius", "color"), Set.of());
        String effectorBone = id(effector.get("bone"), "$.endEffector.bone");
        if (!boneIds.contains(effectorBone)) throw invalid("$.endEffector.bone", "bone does not name a bone");
        double markerRadius = number(effector.get("markerRadius"), "$.endEffector.markerRadius");
        if (markerRadius <= 0 || markerRadius > 10) throw invalid("$.endEffector.markerRadius", "must be within (0, 10] metres");
        MarkerSpec marker = new MarkerSpec(effectorBone, vec(effector.get("offset"), "$.endEffector.offset"), markerRadius,
                color(effector.get("color"), "$.endEffector.color"));

        // ---- floor ----
        FloorSpec floor = null;
        if (spec.containsKey("floor")) {
            Map<String, Object> raw = object(spec.get("floor"), "$.floor");
            keys(raw, "$.floor", Set.of("y", "halfExtent", "tiles", "colorA", "colorB"), Set.of("textureAssetId"));
            double y = number(raw.get("y"), "$.floor.y");
            double half = number(raw.get("halfExtent"), "$.floor.halfExtent");
            if (half <= 0 || half > 100) throw invalid("$.floor.halfExtent", "must be within (0, 100] metres");
            int tiles = integer(raw.get("tiles"), "$.floor.tiles");
            if (tiles < 1) throw invalid("$.floor.tiles", "tiles must be at least 1");
            if (tiles > MAX_FLOOR_TILES) throw budget("$.floor.tiles", "floor tiles per side", MAX_FLOOR_TILES, tiles);
            String texture = null;
            if (raw.containsKey("textureAssetId")) {
                texture = id(raw.get("textureAssetId"), "$.floor.textureAssetId");
                if (!assetIds.contains(texture)) throw invalid("$.floor.textureAssetId", "does not name a declared asset");
            }
            floor = new FloorSpec(y, half, tiles, color(raw.get("colorA"), "$.floor.colorA"),
                    color(raw.get("colorB"), "$.floor.colorB"), texture);
        }
        if (floor == null && !assets.isEmpty()) {
            throw invalid("$.assets", "assets are only used as the floor texture; declare a floor that names one");
        }
        if (floor != null && !assets.isEmpty() && floor.textureAssetId() == null) {
            throw invalid("$.assets", "declared assets must be used: set $.floor.textureAssetId");
        }

        Map<String, Object> canonical = canonical(spec);
        String specSha;
        try {
            specSha = MediaDevProjectRenderRuntime.sha256Hex(JSON.writeValueAsString(canonical));
        } catch (RuntimeException failure) {
            throw invalid("$", "the spec could not be serialized");
        }
        Parsed parsed = new Parsed(width, height, background, fpsNumerator, fpsDenominator, frameCount, camera,
                List.copyOf(bones), marker, floor, List.copyOf(assets), canonical, specSha);
        validateMotion(tenantId, parsed);
        return parsed;
    }

    /**
     * Interval-wise joint-limit check (the engine's analytic slerp bound, applied through its GLB export gate) and a
     * per-frame forward-kinematics pass, both before any rights call, process or registration.
     */
    private static void validateMotion(String tenantId, Parsed parsed) {
        final Rig rig;
        try {
            rig = parsed.rig(tenantId, "validation");
        } catch (IllegalArgumentException refused) {
            throw invalid("$.bones", refused.getMessage());
        }
        try {
            new SpatialRigEngine().exportGlb(rig, source -> RightsOutcome.ELIGIBLE);
        } catch (SpatialExportBlockedException blocked) {
            if (blocked.blocker() == SpatialRigEngine.ExportBlocker.MOTION_CONSTRAINT_INVALID) {
                throw intervalViolation(parsed, rig);
            }
            throw invalid("$.bones", "the rig cannot be exported: " + blocked.blocker().name());
        } catch (IllegalArgumentException refused) {
            throw invalid("$.bones", refused.getMessage());
        }
    }

    /** Names the bone and the keyframe interval whose interpolation leaves the joint limit. */
    private static MediaDevRigRuntime.RigRefusedException intervalViolation(Parsed parsed, Rig rig) {
        SpatialRigEngine engine = new SpatialRigEngine();
        for (int i = 0; i < parsed.bones().size(); i++) {
            BoneSpec bone = parsed.bones().get(i);
            for (int frame = 0; frame < parsed.frameCount(); frame++) {
                try {
                    engine.evaluate(rig, parsed.time(frame), source -> true);
                } catch (IllegalArgumentException exceeded) {
                    String message = exceeded.getMessage() == null ? "" : exceeded.getMessage();
                    if (message.endsWith("bone " + bone.id())) {
                        return jointLimit("$.bones[" + i + "].keyframes", bone.id(), bone.maxDeviationDegrees(),
                                Double.NaN, frame);
                    }
                }
            }
            if (!bone.keys().isEmpty()) {
                // between two keyframes without a sampled frame violating: the analytic bound still refused it
                return jointLimit("$.bones[" + i + "].keyframes", bone.id(), bone.maxDeviationDegrees(), Double.NaN, null);
            }
        }
        return jointLimit("$.bones", "unknown", 0, Double.NaN, null);
    }

    private static MediaDevRigRuntime.RigRefusedException unsupported(String path, String message) {
        return new MediaDevRigRuntime.RigRefusedException(422, "COORDINATE_PROFILE_UNSUPPORTED", message,
                Map.of("path", path, "supported", "RIGHT_HANDED, upAxis Y, unit METRE"));
    }

    /** Angular deviation from rest, in degrees within [0, 180], of a rotation about {@code axis} by {@code degrees}. */
    static double deviationDegrees(Vec3 axis, double degrees) {
        Quaternion delta = axisAngle(axis, degrees);
        return StrictMath.toDegrees(Quaternion.IDENTITY.angularDistance(delta));
    }

    // ---- strict JSON value helpers: each names its JSON path in the refusal ----

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object value, String path) {
        if (!(value instanceof Map<?, ?> map)) throw invalid(path, "must be an object");
        return (Map<String, Object>) map;
    }

    private static List<Object> list(Object value, String path) {
        if (!(value instanceof List<?> list)) throw invalid(path, "must be an array");
        return new ArrayList<>(list);
    }

    private static void keys(Map<String, Object> value, String path, Set<String> required, Set<String> optional) {
        for (String key : required) {
            if (!value.containsKey(key)) throw invalid(path + "." + key, "is required");
        }
        for (String key : value.keySet()) {
            if (!required.contains(key) && !optional.contains(key)) throw invalid(path + "." + key, "is not a known field");
        }
    }

    private static String string(Object value, String path) {
        if (!(value instanceof String text)) throw invalid(path, "must be a string");
        return text;
    }

    private static String id(Object value, String path) {
        String text = string(value, path);
        if (!text.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,63}")) throw invalid(path, "must be a 1-64 character opaque id");
        return text;
    }

    private static int integer(Object value, String path) {
        if (!(value instanceof Integer || value instanceof Long || value instanceof Short)) throw invalid(path, "must be an integer");
        long v = ((Number) value).longValue();
        if (v < Integer.MIN_VALUE || v > Integer.MAX_VALUE) throw invalid(path, "is out of the 32-bit integer range");
        return (int) v;
    }

    private static double number(Object value, String path) {
        if (!(value instanceof Number number) || value instanceof Boolean) throw invalid(path, "must be a number");
        double v = number.doubleValue();
        if (!Double.isFinite(v)) throw invalid(path, "must be finite");
        if (Math.abs(v) > 100_000) throw invalid(path, "is outside the supported magnitude");
        return v;
    }

    private static Vec3 vec(Object value, String path) {
        List<Object> items = list(value, path);
        if (items.size() != 3) throw invalid(path, "must be an array of three numbers [x, y, z] in metres");
        double[] c = new double[3];
        for (int i = 0; i < 3; i++) {
            c[i] = number(items.get(i), path + "[" + i + "]");
            if (Math.abs(c[i]) > MAX_COORDINATE) throw invalid(path + "[" + i + "]", "must be within +-1000 metres");
        }
        return new Vec3(c[0], c[1], c[2]);
    }

    private static Vec3 axis(Object value, String path) {
        Vec3 v = vec(value, path);
        if (v.length() < 1e-9) throw invalid(path, "the rotation axis must not be the zero vector");
        return v;
    }

    private static int color(Object value, String path) {
        String text = string(value, path);
        if (!text.matches("#[0-9A-Fa-f]{6}")) throw invalid(path, "must be #RRGGBB");
        return (int) Long.parseLong(text.substring(1), 16);
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> canonical(Map<String, Object> value) {
        return (Map<String, Object>) canonicalValue(value);
    }

    private static Object canonicalValue(Object value) {
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> sorted = new TreeMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) sorted.put(String.valueOf(entry.getKey()), canonicalValue(entry.getValue()));
            return sorted;
        }
        if (value instanceof List<?> list) {
            List<Object> copy = new ArrayList<>(list.size());
            for (Object item : list) copy.add(canonicalValue(item));
            return copy;
        }
        return value;
    }
}
