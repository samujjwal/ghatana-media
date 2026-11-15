package com.ghatana.media.launcher;

import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.media.production.spatial.SpatialRigEngine;
import com.ghatana.media.production.spatial.SpatialRigEngine.GlbArtifact;
import com.ghatana.media.production.spatial.SpatialRigEngine.PerspectiveCamera;
import com.ghatana.media.production.spatial.SpatialRigEngine.PoseResult;
import com.ghatana.media.production.spatial.SpatialRigEngine.Quaternion;
import com.ghatana.media.production.spatial.SpatialRigEngine.RightsOutcome;
import com.ghatana.media.production.spatial.SpatialRigEngine.SourceVersionRef;
import com.ghatana.media.production.spatial.SpatialRigEngine.SpatialExportBlockedException;
import com.ghatana.media.production.spatial.SpatialRigEngine.Vec3;
import com.ghatana.media.production.spatial.SpatialRigEngine.WorldPose;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Verdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import java.awt.image.BufferedImage;
import java.io.BufferedOutputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Stream;

/**
 * DEV_ONLY deterministic 3D rig render (J-13 {@code media.dev.outcome-three-dimensional-animation}): a typed rig and
 * animation spec (bones with ball-joint limits, keyframed rotations, a perspective camera, an end-effector marker and
 * an optional textured floor) is solved by the verified {@link SpatialRigEngine} (forward kinematics, joint limits,
 * right-handed Y-up metre frame), rasterized by the deterministic software rasterizer {@link MediaDevRigRaster} and
 * encoded by the real FFmpeg into an H.264 MP4. The same rig is exported to a bounded GLB 2.0 node/animation file by
 * the engine's exporter. Three NEW immutable artifacts are registered with lineage: the MP4, the GLB and a frame
 * manifest (per-frame exact PTS, pre-encode pixel digest, joint angles, bone world transforms, end-effector world
 * position and projected pixel, per-frame PSNR of the decoded video against the pre-encode frame).
 *
 * <p><b>Verification before registration.</b> The MP4 is re-probed with ffprobe (codec, pixel format, geometry, exact
 * frame count, rational frame rate, time base, every frame's PTS), fully decoded and compared with the pre-encode
 * frames (PSNR gate), and the GLB's embedded coordinate declaration is read back and compared with the declared
 * frame. Any disagreement registers nothing.</p>
 *
 * <p><b>Rights.</b> Every floor-texture asset must resolve ADMITTED for {@link Scope#PROCESSING} on every call, a
 * replay included. The procedural rig itself is authored by the calling principal: it enters the GLB as the authored
 * source version {@code authored-rig-spec@sha256:<spec digest>} (not an approval, not a rights statement). The
 * durable request ledger maps a requestId to its outputs; a run killed mid-render is UNKNOWN until a retry completes
 * it exactly once.</p>
 */
final class MediaDevRigRuntime {
    static final String SCHEMA = "media.dev.rig-render.v1";
    static final String MANIFEST_SCHEMA = "media.dev.rig-manifest.v1";
    static final String KIND_VIDEO = "RIG_RENDER_VIDEO";
    static final String KIND_GLB = "RIG_RENDER_GLB";
    static final String KIND_MANIFEST = "RIG_RENDER_MANIFEST";
    static final String LANE = "rig.render";
    static final int DEFAULT_CRF = 14;
    static final int MIN_CRF = 10;
    static final int MAX_CRF = 30;
    static final double MIN_PSNR_DB = 20.0;
    static final long MAX_OUTPUT_BYTES = 64L * 1024 * 1024;
    static final int MAX_ASSET_BYTES = 2 * 1024 * 1024;
    static final long MAX_ASSET_PIXELS = 1_048_576L;
    static final int MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
    static final String COLOR_MATRIX = "bt709";
    private static final Duration ENCODE_TIMEOUT = Duration.ofMinutes(5);
    private static final Duration PROBE_TIMEOUT = Duration.ofSeconds(60);
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final List<String> LINEAGE_KEYS = List.of("rigSchema", "scope", "kind", "requestId", "specSha256",
            "frameSetSha256", "frameCount", "width", "height", "fps", "coordinateFrame", "sources", "parent", "siblings",
            "encoder", "rightsDecision", "resultSha256", "glb", "claims");

    static {
        System.setProperty("java.awt.headless", "true");
    }

    /** A typed refusal with an HTTP status; carries no request content or process output. */
    static final class RigRefusedException extends RuntimeException {
        private final int status;
        private final String code;
        private final Map<String, Object> details;

        RigRefusedException(int status, String code, String message, Map<String, Object> details) {
            super(message, null, false, false);
            this.status = status;
            this.code = code;
            this.details = details;
        }

        int status() { return status; }
        String code() { return code; }
        Map<String, Object> details() { return details; }
    }

    /** The FFmpeg run did not finish (killed, timed out): the outcome is UNKNOWN and nothing was registered. */
    static final class RigOutcomeUnknownException extends RuntimeException {
        RigOutcomeUnknownException(String phase) {
            super("the " + phase + " process did not finish; the outcome is unknown", null, false, false);
        }
    }

    static final class RigRequestReusedException extends IllegalStateException {
        RigRequestReusedException() { super("rig requestId was already used for a different request"); }
    }

    static final class RigRegistrationFailedException extends IllegalStateException {
        RigRegistrationFailedException(Throwable cause) {
            super("rig output could not be registered as an immutable artifact", cause);
        }
    }

    record RenderRequest(String requestId, Object spec, int crf) {
        RenderRequest {
            requestId = MediaDevDubSupport.boundedId(requestId, "requestId");
            if (crf < MIN_CRF || crf > MAX_CRF) {
                throw MediaDevRigSpec.invalid("$.encoder.crf", "crf must be within [" + MIN_CRF + ", " + MAX_CRF + "]");
            }
        }
    }

    /** The three registered artifacts of one render plus the manifest read back from the stored manifest artifact. */
    record Render(MediaArtifact video, MediaArtifact glb, MediaArtifact manifest, Map<String, Object> manifestDocument,
                  Map<String, Object> videoLineage, Map<String, Object> glbLineage, boolean replayed)
            implements MediaDevRenderAdmission.ReplayAware {
        @Override public boolean replayedResult() { return replayed; }
    }

    private record ResolvedAsset(MediaDevRigSpec.AssetRef ref, MediaArtifact artifact, Resolution resolution) { }

    private final MediaRuntime runtime;
    private final Path ffmpeg;
    private final Path ffprobe;
    private final RightsConsentResolver rights;
    private final MediaDevProjectRenderRuntime.OutputRegistrar registrar;
    private final MediaDevRequestLedger ledger;
    private volatile String ffmpegVersion;

    MediaDevRigRuntime(MediaRuntime runtime, Path ffmpeg, Path ffprobe, RightsConsentResolver rights,
                       MediaDevProjectRenderRuntime.OutputRegistrar registrar, MediaDevRequestLedger ledger) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        if (ffmpeg == null || ffprobe == null || !ffmpeg.isAbsolute() || !ffprobe.isAbsolute()) {
            throw new IllegalArgumentException("ffmpeg and ffprobe must be absolute paths");
        }
        this.ffmpeg = ffmpeg;
        this.ffprobe = ffprobe;
        this.rights = rights == null ? RightsConsentResolver.unavailable() : rights;
        this.registrar = Objects.requireNonNull(registrar, "registrar");
        this.ledger = Objects.requireNonNull(ledger, "ledger");
    }

    /** Null when no absolute FFmpeg and FFprobe pair is configured; tools are never resolved through PATH. */
    static MediaDevRigRuntime compose(MediaRuntime runtime, Map<String, String> environment,
                                      RightsConsentResolver rights, MediaDevRequestLedger ledger) {
        String ffmpeg = environment.get(MediaDevProjectRenderRuntime.FFMPEG_ENV);
        String ffprobe = environment.get(MediaDevProjectRenderRuntime.FFPROBE_ENV);
        if (ffmpeg == null || ffmpeg.isBlank() || ffprobe == null || ffprobe.isBlank()) return null;
        return new MediaDevRigRuntime(runtime, Path.of(ffmpeg), Path.of(ffprobe), rights,
                MediaDevProjectRenderRuntime.canonicalRegistrar(runtime), ledger);
    }

    Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("scope", "DEV_ONLY");
        out.put("ready", true);
        out.put("specSchema", MediaDevRigSpec.SCHEMA);
        Map<String, Object> limits = new LinkedHashMap<>();
        limits.put("minSide", MediaDevRigSpec.MIN_SIDE);
        limits.put("maxWidth", MediaDevRigSpec.MAX_WIDTH);
        limits.put("maxHeight", MediaDevRigSpec.MAX_HEIGHT);
        limits.put("maxFrames", MediaDevRigSpec.MAX_FRAMES);
        limits.put("maxFramesPerSecond", MediaDevRigSpec.MAX_FPS);
        limits.put("maxRenderPixels", MediaDevRigSpec.MAX_PIXELS);
        limits.put("maxBones", MediaDevRigSpec.MAX_BONES);
        limits.put("maxKeyframesPerBone", MediaDevRigSpec.MAX_KEYFRAMES_PER_BONE);
        limits.put("maxAssets", MediaDevRigSpec.MAX_ASSETS);
        limits.put("maxFloorTilesPerSide", MediaDevRigSpec.MAX_FLOOR_TILES);
        limits.put("maxAssetBytes", MAX_ASSET_BYTES);
        limits.put("maxAssetPixels", MAX_ASSET_PIXELS);
        limits.put("maxOutputBytes", MAX_OUTPUT_BYTES);
        limits.put("maxGlbBytes", SpatialRigEngine.MAX_GLB_BYTES);
        out.put("limits", limits);
        out.put("coordinateFrame", Map.of("handedness", "RIGHT_HANDED", "upAxis", "Y", "unit", "METRE",
                "cameraLooksAlong", "-Z"));
        out.put("primitives", List.of("CAPSULE_PER_BONE", "END_EFFECTOR_MARKER_DISC", "FLOOR_TRIANGLES"));
        out.put("jointModel", "BALL (angular deviation from the rest orientation, axis-angle keyframe deltas)");
        out.put("outputs", List.of("video/mp4", "model/gltf-binary", "application/json"));
        out.put("encoder", Map.of("codec", "libx264", "container", "mp4", "pixelFormat", "yuv420p",
                "colorMatrix", COLOR_MATRIX, "range", "tv", "defaultCrf", DEFAULT_CRF, "minCrf", MIN_CRF, "maxCrf", MAX_CRF,
                "minPsnrDb", MIN_PSNR_DB));
        out.put("rightsAuthority", Map.of("resolverId", rights.resolverId(), "ready", rights.ready(),
                "scope", Scope.PROCESSING.name(), "appliesTo", "floor texture assets"));
        return out;
    }

    // ------------------------------------------------------------------ read

    Optional<Render> reopen(String tenantId, String principalId, String manifestArtifactId) {
        Optional<MediaArtifact> manifest = runtime.artifact(tenantId, principalId, manifestArtifactId)
                .filter(artifact -> SCHEMA.equals(artifact.metadata().get("rigSchema"))
                        && KIND_MANIFEST.equals(artifact.metadata().get("kind")));
        if (manifest.isEmpty()) return Optional.empty();
        if (!(manifest.get().metadata().get("siblings") instanceof Map<?, ?> siblings)) return Optional.empty();
        Optional<MediaArtifact> video = sibling(tenantId, principalId, siblings.get("video"), KIND_VIDEO);
        Optional<MediaArtifact> glb = sibling(tenantId, principalId, siblings.get("glb"), KIND_GLB);
        if (video.isEmpty() || glb.isEmpty()) return Optional.empty();
        return Optional.of(new Render(video.get(), glb.get(), manifest.get(),
                readManifest(tenantId, principalId, manifest.get()), lineageOf(video.get()), lineageOf(glb.get()), true));
    }

    private Optional<MediaArtifact> sibling(String tenantId, String principalId, Object ref, String kind) {
        if (!(ref instanceof Map<?, ?> map) || !(map.get("artifactId") instanceof String id)
                || !(map.get("artifactVersionId") instanceof String version)) return Optional.empty();
        return runtime.artifact(tenantId, principalId, id)
                .filter(artifact -> artifact.version().value().equals(version) && kind.equals(artifact.metadata().get("kind")));
    }

    private Map<String, Object> readManifest(String tenantId, String principalId, MediaArtifact manifest) {
        if (manifest.sizeBytes() > MAX_DOCUMENT_BYTES) {
            throw new RigRefusedException(422, "RIG_MANIFEST_TOO_LARGE", "the manifest exceeds the byte ceiling", Map.of());
        }
        ByteArrayOutputStream content = new ByteArrayOutputStream((int) Math.max(1, manifest.sizeBytes()));
        try {
            runtime.copyArtifactContent(tenantId, principalId, manifest.artifactId(), manifest.version(), content,
                    MAX_DOCUMENT_BYTES).orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
            return JSON.readValue(content.toByteArray(), new TypeReference<LinkedHashMap<String, Object>>() { });
        } catch (IOException | RuntimeException unreadable) {
            if (unreadable instanceof MediaDevProjectRenderRuntime.SourceVersionUnavailableException missing) throw missing;
            throw new RigRefusedException(422, "RIG_MANIFEST_INVALID", "the stored manifest is not a readable JSON document",
                    Map.of());
        }
    }

    private static Map<String, Object> lineageOf(MediaArtifact artifact) {
        Map<String, Object> lineage = new LinkedHashMap<>();
        for (String key : LINEAGE_KEYS) {
            if (artifact.metadata().containsKey(key)) lineage.put(key, artifact.metadata().get(key));
        }
        return lineage;
    }

    // ------------------------------------------------------------------ render

    Render render(String tenantId, String principalId, RenderRequest request) {
        Objects.requireNonNull(request, "request");
        // Parse, joint limits and budgets first: an invalid spec costs no permit, no lookup and no rights call.
        MediaDevRigSpec.Parsed parsed = MediaDevRigSpec.parse(tenantId, request.spec());
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "rig_render", tenantId,
                () -> renderAdmitted(tenantId, principalId, request, parsed));
    }

    private Render renderAdmitted(String tenantId, String principalId, RenderRequest request,
                                  MediaDevRigSpec.Parsed parsed) {
        List<ResolvedAsset> assets = resolveAssets(tenantId, principalId, parsed);
        StringBuilder assetDigests = new StringBuilder();
        for (ResolvedAsset asset : assets) {
            assetDigests.append(asset.ref().id()).append('=').append(asset.artifact().artifactId()).append('@')
                    .append(asset.artifact().version().value()).append(';');
        }
        String fingerprint = MediaDevRequestLedger.fingerprint("media.dev.rig.render.v1", parsed.specSha256(),
                request.crf(), assetDigests.toString());
        return ledger.run(tenantId, principalId, LANE, request.requestId(), fingerprint,
                outputs -> replay(tenantId, principalId, outputs),
                () -> produce(tenantId, principalId, request, parsed, assets),
                render -> List.of(
                        new OutputRef("manifest", render.manifest().artifactId(), render.manifest().version().value()),
                        new OutputRef("video", render.video().artifactId(), render.video().version().value()),
                        new OutputRef("glb", render.glb().artifactId(), render.glb().version().value())),
                RigRequestReusedException::new);
    }

    private Render replay(String tenantId, String principalId, List<OutputRef> outputs) {
        OutputRef ref = outputs.stream().filter(candidate -> candidate.role().equals("manifest")).findFirst()
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(LANE));
        return reopen(tenantId, principalId, ref.artifactId())
                .filter(found -> found.manifest().version().value().equals(ref.versionId()))
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(LANE));
    }

    private List<ResolvedAsset> resolveAssets(String tenantId, String principalId, MediaDevRigSpec.Parsed parsed) {
        List<ResolvedAsset> resolved = new ArrayList<>();
        for (MediaDevRigSpec.AssetRef ref : parsed.assets()) {
            MediaArtifact artifact = runtime.artifact(tenantId, principalId, ref.artifactId())
                    .filter(found -> found.version().value().equals(ref.artifactVersionId()))
                    .orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
            String type = artifact.contentType().toLowerCase(Locale.ROOT);
            if (!type.equals("image/png") && !type.equals("image/jpeg")) {
                throw new RigRefusedException(422, "ASSET_NOT_SUPPORTED",
                        "an asset must be an image/png or image/jpeg artifact version", Map.of("path", ref.path()));
            }
            if (artifact.sizeBytes() > MAX_ASSET_BYTES) {
                throw MediaDevRigSpec.budget(ref.path(), "asset bytes", MAX_ASSET_BYTES, artifact.sizeBytes());
            }
            resolved.add(new ResolvedAsset(ref, artifact, admit(tenantId, artifact, ref.path())));
        }
        return resolved;
    }

    private Resolution admit(String tenantId, MediaArtifact artifact, String path) {
        Resolution resolution;
        try {
            resolution = rights.resolve(new ResolutionRequest(tenantId, artifact.artifactId(),
                    artifact.version().value(), artifact.sha256(), Scope.PROCESSING));
        } catch (RuntimeException failure) {
            resolution = Resolution.unavailable(rights.resolverId());
        }
        if (resolution.admitted()) return resolution;
        boolean unavailable = resolution.verdict() == Verdict.UNAVAILABLE;
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("scope", "PROCESSING");
        details.put("path", path);
        details.put("artifactId", artifact.artifactId());
        details.put("verdict", resolution.verdict().name());
        details.put("reasons", resolution.reasons().stream().map(Enum::name).sorted().toList());
        throw new RigRefusedException(unavailable ? 503 : 403,
                unavailable ? "RIGHTS_AUTHORITY_UNAVAILABLE" : "RIGHTS_NOT_ADMITTED",
                "a texture asset has no current PROCESSING rights and consent admission; nothing was rendered", details);
    }

    // ------------------------------------------------------------------ production

    private Render produce(String tenantId, String principalId, RenderRequest request, MediaDevRigSpec.Parsed parsed,
                           List<ResolvedAsset> assets) {
        MediaDevRigRaster.Texture texture = null;
        for (ResolvedAsset asset : assets) {
            MediaDevRigRaster.Texture decoded = decodeAsset(tenantId, principalId, asset);
            if (parsed.floor() != null && asset.ref().id().equals(parsed.floor().textureAssetId())) texture = decoded;
        }
        SpatialRigEngine engine = new SpatialRigEngine();
        SpatialRigEngine.Rig rig = parsed.rig(tenantId, request.requestId());
        Path dir = privateTempDirectory();
        try {
            Path raw = dir.resolve("frames.rgb");
            List<Map<String, Object>> frames = new ArrayList<>();
            String frameSetSha;
            try (OutputStream sink = new BufferedOutputStream(Files.newOutputStream(raw), 1 << 20)) {
                frameSetSha = rasterize(engine, rig, parsed, texture, sink, frames);
            }
            long timescale = MediaDevAnimationRuntime.timescale(parsed.fpsNumerator());
            long ticksPerFrame = timescale / parsed.fpsNumerator() * parsed.fpsDenominator();
            Path out = dir.resolve("out.mp4");
            List<String> encode = new ArrayList<>(List.of(ffmpeg.toString(), "-nostdin", "-hide_banner", "-v", "error",
                    "-xerror", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size",
                    parsed.width() + "x" + parsed.height(), "-framerate", parsed.fpsNumerator() + "/" + parsed.fpsDenominator(),
                    "-i", raw.toString(),
                    "-vf", "scale=out_color_matrix=" + COLOR_MATRIX + ":out_range=tv:flags=accurate_rnd+bitexact,format=yuv420p",
                    "-c:v", "libx264", "-preset", "medium", "-crf", Integer.toString(request.crf()), "-profile:v", "high",
                    "-bf", "0", "-threads", "1", "-colorspace", COLOR_MATRIX, "-color_primaries", COLOR_MATRIX,
                    "-color_trc", COLOR_MATRIX, "-color_range", "tv", "-movflags", "+faststart",
                    "-fflags", "+bitexact", "-flags:v", "+bitexact", "-map_metadata", "-1",
                    "-metadata", "comment=media.dev.rig request=" + request.requestId() + " spec=" + parsed.specSha256(),
                    "-video_track_timescale", Long.toString(timescale), "-fps_mode", "passthrough", "-an", "-y",
                    out.toString()));
            BoundedProcessRunner.Result result = BoundedProcessRunner.run(encode, dir, Map.of(), ENCODE_TIMEOUT, 1024,
                    8192, BoundedProcessRunner.CancellationToken.NEVER, out, MAX_OUTPUT_BYTES);
            if (result.end() == BoundedProcessRunner.End.WATCHED_FILE_TOO_LARGE) {
                throw MediaDevRigSpec.budget("$", "encoded video bytes", MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES + 1);
            }
            classify(result, "encode", "RIG_ENCODE_FAILED");
            Map<String, Object> verification = verify(out, dir, parsed, timescale, ticksPerFrame);
            Map<String, Object> quality = measureQuality(out, raw, dir, parsed, frames);
            for (Map<String, Object> entry : frames) entry.put("ptsTicks", (long) (int) entry.get("index") * ticksPerFrame);
            byte[] mp4 = Files.readAllBytes(out);

            Set<SourceVersionRef> eligible = new HashSet<>();
            eligible.add(parsed.authoredSource(tenantId));
            for (ResolvedAsset asset : assets) {
                eligible.add(new SourceVersionRef(tenantId, asset.artifact().artifactId(), asset.artifact().version().value()));
            }
            GlbArtifact glb = exportGlb(engine, rig, eligible);
            verifyGlbDeclaration(glb);
            return register(tenantId, principalId, request, parsed, frameSetSha, frames, verification, quality, timescale,
                    assets, mp4, glb);
        } catch (IOException failure) {
            throw new RigRefusedException(503, "RIG_TOOLS_UNAVAILABLE",
                    "the video tools could not be run; nothing was registered", Map.of());
        } finally {
            deleteTree(dir);
        }
    }

    /** Solves forward kinematics for every frame, rasterizes it into the raw file and fills the per-frame manifest. */
    static String rasterize(SpatialRigEngine engine, SpatialRigEngine.Rig rig, MediaDevRigSpec.Parsed parsed,
                            MediaDevRigRaster.Texture texture, OutputStream sink, List<Map<String, Object>> frames)
            throws IOException {
        MediaDevRigSpec.CameraSpec cam = parsed.camera();
        Quaternion orientation = MediaDevRigSpec.lookAt(cam.position(), cam.lookAt());
        double fov = StrictMath.toRadians(cam.fovDegrees());
        PerspectiveCamera camera = new PerspectiveCamera(MediaDevRigSpec.frame(), cam.position(), orientation, fov,
                cam.near(), cam.far(), parsed.width(), parsed.height());
        MediaDevRigRaster.Floor floor = parsed.floor() == null ? null : new MediaDevRigRaster.Floor(parsed.floor().y(),
                parsed.floor().halfExtent(), parsed.floor().tiles(), parsed.floor().rgbA(), parsed.floor().rgbB(), texture);
        MediaDevRigRaster raster = new MediaDevRigRaster(new MediaDevRigRaster.Camera(cam.position(), orientation, fov,
                cam.near(), cam.far(), parsed.width(), parsed.height()), parsed.backgroundRgb(), floor);
        double focal = parsed.height() / (2.0 * StrictMath.tan(fov / 2.0));
        MessageDigestHolder frameSet = new MessageDigestHolder();
        Map<String, MediaDevRigSpec.BoneSpec> byId = new LinkedHashMap<>();
        for (MediaDevRigSpec.BoneSpec bone : parsed.bones()) byId.put(bone.id(), bone);
        {
            OutputStream out = sink;
            for (int index = 0; index < parsed.frameCount(); index++) {
                PoseResult pose = engine.evaluate(rig, parsed.time(index), source -> true);
                List<MediaDevRigRaster.Capsule> capsules = new ArrayList<>();
                Map<String, Object> bonesView = new LinkedHashMap<>();
                Map<String, Object> angles = new LinkedHashMap<>();
                for (MediaDevRigSpec.BoneSpec bone : parsed.bones()) {
                    WorldPose world = pose.bones().get(bone.id());
                    Vec3 tipWorld = world.position().add(world.orientation().rotate(bone.tip()));
                    capsules.add(new MediaDevRigRaster.Capsule(world.position(), tipWorld, bone.radius(), bone.rgb()));
                    Quaternion local = bone.parent() == null ? world.orientation()
                            : pose.bones().get(bone.parent()).orientation().inverse().multiply(world.orientation());
                    Quaternion rest = MediaDevRigSpec.axisAngle(bone.restAxis(), bone.restDegrees());
                    angles.put(bone.id(), StrictMath.toDegrees(rest.angularDistance(local)));
                    Map<String, Object> view = new LinkedHashMap<>();
                    view.put("position", vec(world.position()));
                    view.put("rotation", quat(world.orientation()));
                    bonesView.put(bone.id(), view);
                }
                WorldPose effectorBone = pose.bones().get(parsed.marker().bone());
                Vec3 effector = effectorBone.position().add(effectorBone.orientation().rotate(parsed.marker().offset()));
                SpatialRigEngine.ProjectedPoint pixel;
                try {
                    pixel = engine.project(effector, MediaDevRigSpec.frame(), camera);
                } catch (IllegalArgumentException outside) {
                    throw endEffectorNotVisible(index, "is outside the camera clip range");
                }
                double radiusPixels = focal * parsed.marker().radius() / pixel.depth();
                if (pixel.xPixels() - radiusPixels < 0 || pixel.xPixels() + radiusPixels > parsed.width()
                        || pixel.yPixels() - radiusPixels < 0 || pixel.yPixels() + radiusPixels > parsed.height()) {
                    throw endEffectorNotVisible(index, "leaves the image");
                }
                byte[] rgb = raster.render(capsules, new MediaDevRigRaster.Marker(pixel.xPixels(), pixel.yPixels(),
                        radiusPixels, parsed.marker().rgb()));
                out.write(rgb);
                String pixelSha = MediaDevProjectRenderRuntime.sha256Hex(rgb);
                frameSet.line(index + ":" + pixelSha + "\n");
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("index", index);
                RationalTimeView.put(entry, parsed, index);
                entry.put("pixelSha256", pixelSha);
                entry.put("jointAnglesDegrees", angles);
                entry.put("bones", bonesView);
                Map<String, Object> effectorView = new LinkedHashMap<>();
                effectorView.put("bone", parsed.marker().bone());
                effectorView.put("world", vec(effector));
                effectorView.put("pixel", Map.of("x", pixel.xPixels(), "y", pixel.yPixels(), "depth", pixel.depth()));
                effectorView.put("markerRadiusPixels", radiusPixels);
                entry.put("endEffector", effectorView);
                frames.add(entry);
            }
        }
        return frameSet.sha256();
    }

    private static RigRefusedException endEffectorNotVisible(int frame, String reason) {
        return new RigRefusedException(422, "END_EFFECTOR_NOT_VISIBLE",
                "the end-effector marker " + reason + " at frame " + frame + "; nothing was registered",
                Map.of("path", "$.endEffector", "frame", frame));
    }

    private static final class RationalTimeView {
        static void put(Map<String, Object> entry, MediaDevRigSpec.Parsed parsed, int index) {
            entry.put("timeSecondsNumerator", Long.toString((long) index * parsed.fpsDenominator()));
            entry.put("timeSecondsDenominator", Long.toString(parsed.fpsNumerator()));
        }
    }

    private static final class MessageDigestHolder {
        private final java.security.MessageDigest digest;

        MessageDigestHolder() {
            try {
                digest = java.security.MessageDigest.getInstance("SHA-256");
            } catch (java.security.NoSuchAlgorithmException impossible) {
                throw new IllegalStateException(impossible);
            }
        }

        void line(String text) { digest.update(text.getBytes(StandardCharsets.UTF_8)); }

        String sha256() { return java.util.HexFormat.of().formatHex(digest.digest()); }
    }

    private static List<Double> vec(Vec3 v) { return List.of(v.x(), v.y(), v.z()); }

    private static List<Double> quat(Quaternion q) { return List.of(q.x(), q.y(), q.z(), q.w()); }

    // ------------------------------------------------------------------ GLB

    private static GlbArtifact exportGlb(SpatialRigEngine engine, SpatialRigEngine.Rig rig, Set<SourceVersionRef> eligible) {
        try {
            return engine.exportGlb(rig, source -> eligible.contains(source) ? RightsOutcome.ELIGIBLE : RightsOutcome.UNKNOWN);
        } catch (SpatialRigEngine.SourceRightsDeniedException denied) {
            throw new RigRefusedException(403, "RIGHTS_NOT_ADMITTED", "a rig source version is not eligible; nothing was rendered",
                    Map.of("outcome", denied.outcome().name()));
        } catch (SpatialExportBlockedException blocked) {
            throw new RigRefusedException(422, "RIG_EXPORT_BLOCKED", "the GLB export is blocked: " + blocked.blocker().name(),
                    Map.of("blocker", blocked.blocker().name()));
        }
    }

    /** Reads the GLB JSON chunk back and requires the embedded coordinate declaration to equal the declared frame. */
    private static void verifyGlbDeclaration(GlbArtifact glb) {
        try {
            ByteBuffer buffer = ByteBuffer.wrap(glb.bytes()).order(ByteOrder.LITTLE_ENDIAN);
            int jsonLength = buffer.getInt(12);
            JsonNode root = JSON.readTree(new String(glb.bytes(), 20, jsonLength, StandardCharsets.UTF_8));
            JsonNode spatial = root.path("extras").path("mediaSpatial");
            boolean ok = "RIGHT_HANDED".equals(spatial.path("handedness").asString())
                    && spatial.path("axisDirections").toString().equals("[\"POS_X\",\"POS_Y\",\"POS_Z\"]")
                    && SpatialRigEngine.GLB_METRE_UNIT_REF.equals(spatial.path("positionUnitRef").asString())
                    && SpatialRigEngine.GLB_QUATERNION_UNIT_REF.equals(spatial.path("orientationUnitRef").asString())
                    && MediaDevRigSpec.FRAME_REF.equals(spatial.path("frameRef").asString())
                    && "2.0".equals(root.path("asset").path("version").asString());
            if (!ok) throw new RigRefusedException(500, "RIG_VERIFICATION_FAILED",
                    "the exported GLB does not carry the declared coordinate frame; nothing was registered", Map.of());
        } catch (RuntimeException unreadable) {
            if (unreadable instanceof RigRefusedException refused) throw refused;
            throw new RigRefusedException(500, "RIG_VERIFICATION_FAILED",
                    "the exported GLB could not be read back; nothing was registered", Map.of());
        }
    }

    // ------------------------------------------------------------------ video verification

    private Map<String, Object> verify(Path file, Path dir, MediaDevRigSpec.Parsed parsed, long timescale,
                                       long ticksPerFrame) throws IOException {
        BoundedProcessRunner.Result probe = BoundedProcessRunner.run(List.of(ffprobe.toString(), "-v", "error",
                "-select_streams", "v:0", "-show_entries",
                "stream=codec_name,profile,pix_fmt,width,height,avg_frame_rate,r_frame_rate,time_base,start_pts,color_space:frame=pts",
                "-of", "json", file.toString()), dir, Map.of(), PROBE_TIMEOUT, 4 * 1024 * 1024, 8192,
                BoundedProcessRunner.CancellationToken.NEVER, null, 0);
        classify(probe, "probe", "RIG_VERIFICATION_FAILED");
        try {
            JsonNode root = JSON.readTree(new String(probe.stdout(), StandardCharsets.UTF_8));
            JsonNode stream = root.path("streams").path(0);
            List<Long> pts = new ArrayList<>();
            for (JsonNode frame : root.path("frames")) pts.add(frame.path("pts").asLong(Long.MIN_VALUE));
            String problem = null;
            if (!"h264".equals(stream.path("codec_name").asString())) problem = "codec";
            else if (!"yuv420p".equals(stream.path("pix_fmt").asString())) problem = "pixel format";
            else if (stream.path("width").asInt() != parsed.width() || stream.path("height").asInt() != parsed.height()) problem = "geometry";
            else if (pts.size() != parsed.frameCount()) problem = "frame count";
            else if (!rationalEquals(stream.path("avg_frame_rate").asString(""), parsed.fpsNumerator(), parsed.fpsDenominator())) problem = "frame rate";
            else if (!("1/" + timescale).equals(stream.path("time_base").asString())) problem = "time base";
            else if (stream.path("start_pts").asLong(-1) != 0) problem = "start pts";
            for (int i = 0; problem == null && i < pts.size(); i++) {
                if (pts.get(i) != (long) i * ticksPerFrame) problem = "frame " + i + " presentation timestamp";
            }
            if (problem != null) {
                throw new RigRefusedException(500, "RIG_VERIFICATION_FAILED",
                        "the encoded video does not match the requested timeline (" + problem + "); nothing was registered",
                        Map.of("mismatch", problem));
            }
            Map<String, Object> verification = new LinkedHashMap<>();
            verification.put("verifiedBy", "ffprobe -show_entries stream,frame=pts on the encoded MP4");
            verification.put("codec", "h264");
            verification.put("profile", stream.path("profile").asString(""));
            verification.put("pixelFormat", "yuv420p");
            verification.put("colorSpace", stream.path("color_space").asString(""));
            verification.put("width", parsed.width());
            verification.put("height", parsed.height());
            verification.put("frameCount", pts.size());
            verification.put("averageFrameRate", stream.path("avg_frame_rate").asString(""));
            verification.put("timeBase", "1/" + timescale);
            verification.put("ticksPerFrame", ticksPerFrame);
            verification.put("ptsExact", true);
            return verification;
        } catch (RuntimeException unreadable) {
            if (unreadable instanceof RigRefusedException refused) throw refused;
            throw new RigRefusedException(500, "RIG_VERIFICATION_FAILED",
                    "the encoded video could not be probed; nothing was registered", Map.of());
        }
    }

    /** Decodes the MP4 completely and compares every frame with its pre-encode RGB frame (PSNR over all channels). */
    private Map<String, Object> measureQuality(Path mp4, Path raw, Path dir, MediaDevRigSpec.Parsed parsed,
                                               List<Map<String, Object>> frames) throws IOException {
        Path decoded = dir.resolve("decoded.rgb");
        BoundedProcessRunner.Result result = BoundedProcessRunner.run(List.of(ffmpeg.toString(), "-nostdin", "-hide_banner",
                "-v", "error", "-xerror", "-i", mp4.toString(), "-vf",
                "scale=in_color_matrix=" + COLOR_MATRIX + ":in_range=tv:out_range=pc:flags=accurate_rnd+bitexact,format=rgb24",
                "-f", "rawvideo", "-fps_mode", "passthrough", "-y", decoded.toString()), dir, Map.of(), ENCODE_TIMEOUT, 1024,
                8192, BoundedProcessRunner.CancellationToken.NEVER, decoded, MAX_OUTPUT_BYTES * 2);
        classify(result, "decode", "RIG_VERIFICATION_FAILED");
        int frameBytes = parsed.width() * parsed.height() * 3;
        if (Files.size(decoded) != (long) frameBytes * parsed.frameCount()) {
            throw new RigRefusedException(500, "RIG_VERIFICATION_FAILED",
                    "the decoded video does not have the expected frame count; nothing was registered", Map.of());
        }
        double min = Double.POSITIVE_INFINITY;
        double sum = 0;
        int worst = -1;
        byte[] original = new byte[frameBytes];
        byte[] actual = new byte[frameBytes];
        try (InputStream a = new java.io.BufferedInputStream(Files.newInputStream(raw), 1 << 20);
             InputStream b = new java.io.BufferedInputStream(Files.newInputStream(decoded), 1 << 20)) {
            for (int index = 0; index < parsed.frameCount(); index++) {
                a.readNBytes(original, 0, frameBytes);
                b.readNBytes(actual, 0, frameBytes);
                double squares = 0;
                for (int i = 0; i < frameBytes; i++) {
                    double d = (original[i] & 0xff) - (actual[i] & 0xff);
                    squares += d * d;
                }
                double mse = squares / frameBytes;
                double psnr = mse == 0 ? 99.0 : 10 * StrictMath.log10(255.0 * 255.0 / mse);
                frames.get(index).put("psnrDb", psnr);
                sum += psnr;
                if (psnr < min) { min = psnr; worst = index; }
            }
        }
        if (min < MIN_PSNR_DB) {
            throw new RigRefusedException(500, "RIG_VERIFICATION_FAILED",
                    "the decoded video is too far from the rendered frames (PSNR gate); nothing was registered",
                    Map.of("minPsnrDb", min, "gateDb", MIN_PSNR_DB, "frame", worst));
        }
        Map<String, Object> quality = new LinkedHashMap<>();
        quality.put("measuredBy", "full FFmpeg decode of the stored MP4 compared with the pre-encode RGB24 frames");
        quality.put("minPsnrDb", min);
        quality.put("minPsnrFrame", worst);
        quality.put("meanPsnrDb", sum / parsed.frameCount());
        quality.put("gateDb", MIN_PSNR_DB);
        return quality;
    }

    private static boolean rationalEquals(String text, int numerator, int denominator) {
        String[] parts = text.split("/");
        if (parts.length != 2) return false;
        try {
            return BigInteger.valueOf(Long.parseLong(parts[0])).multiply(BigInteger.valueOf(denominator))
                    .equals(BigInteger.valueOf(Long.parseLong(parts[1])).multiply(BigInteger.valueOf(numerator)));
        } catch (NumberFormatException malformed) {
            return false;
        }
    }

    /** Throws unless FFmpeg exited 0. A signal exit or a timeout is UNKNOWN; any other exit is a typed failure. */
    private static void classify(BoundedProcessRunner.Result result, String phase, String failureCode) {
        if (result.succeeded()) return;
        boolean signalled = result.end() == BoundedProcessRunner.End.EXITED && (result.exitCode() >= 128 || result.exitCode() < 0);
        if (result.end() == BoundedProcessRunner.End.TIMED_OUT || result.end() == BoundedProcessRunner.End.CANCELLED || signalled) {
            throw new RigOutcomeUnknownException(phase);
        }
        throw new RigRefusedException(422, failureCode, "the " + phase + " step failed; nothing was registered", Map.of());
    }

    private String ffmpegVersion() {
        String known = ffmpegVersion;
        if (known != null) return known;
        try {
            BoundedProcessRunner.Result result = BoundedProcessRunner.run(List.of(ffmpeg.toString(), "-version"), null,
                    Map.of(), Duration.ofSeconds(20), 8192, 8192, BoundedProcessRunner.CancellationToken.NEVER, null, 0);
            String first = new String(result.stdout(), StandardCharsets.UTF_8).lines().findFirst().orElse("ffmpeg");
            known = first.length() > 120 ? first.substring(0, 120) : first;
        } catch (IOException failure) {
            known = "ffmpeg (version unavailable)";
        }
        ffmpegVersion = known;
        return known;
    }

    // ------------------------------------------------------------------ assets

    private MediaDevRigRaster.Texture decodeAsset(String tenantId, String principalId, ResolvedAsset asset) {
        ByteArrayOutputStream content = new ByteArrayOutputStream((int) Math.max(1, asset.artifact().sizeBytes()));
        try {
            runtime.copyArtifactContent(tenantId, principalId, asset.artifact().artifactId(), asset.artifact().version(),
                    content, MAX_ASSET_BYTES).orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
        } catch (IOException unreadable) {
            throw new RigRefusedException(503, "RIG_TOOLS_UNAVAILABLE",
                    "an asset could not be read; nothing was registered", Map.of("path", asset.ref().path()));
        }
        try (ImageInputStream input = ImageIO.createImageInputStream(new ByteArrayInputStream(content.toByteArray()))) {
            Iterator<ImageReader> readers = ImageIO.getImageReaders(input);
            if (!readers.hasNext()) throw unsupported(asset);
            ImageReader reader = readers.next();
            try {
                reader.setInput(input, true, true);
                long pixels = (long) reader.getWidth(0) * reader.getHeight(0);
                if (pixels > MAX_ASSET_PIXELS) {
                    throw MediaDevRigSpec.budget(asset.ref().path(), "asset pixels", MAX_ASSET_PIXELS, pixels);
                }
                BufferedImage image = reader.read(0);
                int width = image.getWidth();
                int height = image.getHeight();
                int[] argb = image.getRGB(0, 0, width, height, null, 0, width);
                image.flush();
                return new MediaDevRigRaster.Texture(width, height, argb);
            } finally {
                reader.dispose();
            }
        } catch (IOException | RuntimeException failure) {
            if (failure instanceof RigRefusedException refused) throw refused;
            throw unsupported(asset);
        }
    }

    private static RigRefusedException unsupported(ResolvedAsset asset) {
        return new RigRefusedException(422, "ASSET_NOT_SUPPORTED", "the asset bytes are not a decodable image",
                Map.of("path", asset.ref().path()));
    }

    // ------------------------------------------------------------------ registration

    private Render register(String tenantId, String principalId, RenderRequest request, MediaDevRigSpec.Parsed parsed,
                            String frameSetSha, List<Map<String, Object>> frames, Map<String, Object> verification,
                            Map<String, Object> quality, long timescale, List<ResolvedAsset> assets, byte[] mp4,
                            GlbArtifact glb) {
        List<Map<String, Object>> assetRefs = new ArrayList<>();
        List<String> attestations = new ArrayList<>();
        for (ResolvedAsset asset : assets) {
            Map<String, Object> ref = MediaDevDubSupport.ref(asset.artifact());
            ref.put("assetId", asset.ref().id());
            ref.put("contentType", asset.artifact().contentType());
            Map<String, Object> admission = new LinkedHashMap<>();
            admission.put("scope", "PROCESSING");
            admission.put("verdict", asset.resolution().verdict().name());
            admission.put("resolverId", asset.resolution().resolverId());
            admission.put("attestationIds", asset.resolution().attestationIds());
            ref.put("rights", admission);
            assetRefs.add(ref);
            attestations.addAll(asset.resolution().attestationIds());
        }
        Map<String, Object> encoder = new LinkedHashMap<>();
        encoder.put("videoCodec", "libx264");
        encoder.put("preset", "medium");
        encoder.put("crf", request.crf());
        encoder.put("profile", "high");
        encoder.put("bFrames", 0);
        encoder.put("threads", 1);
        encoder.put("pixelFormat", "yuv420p");
        encoder.put("colorMatrix", COLOR_MATRIX);
        encoder.put("range", "tv");
        encoder.put("timescale", timescale);
        encoder.put("tool", ffmpegVersion());
        Map<String, Object> rightsDecision = new LinkedHashMap<>();
        rightsDecision.put("kind", "RIGHTS_CONSENT_ATTESTATION");
        rightsDecision.put("scope", Scope.PROCESSING.name());
        rightsDecision.put("assetCount", assets.size());
        rightsDecision.put("attestationIds", attestations);
        rightsDecision.put("authoredSource", "authored-rig-spec@sha256:" + parsed.specSha256());
        rightsDecision.put("productionGrant", false);
        Map<String, Object> fps = Map.of("numerator", parsed.fpsNumerator(), "denominator", parsed.fpsDenominator());
        Map<String, Object> coordinateFrame = new LinkedHashMap<>();
        coordinateFrame.put("frameRef", MediaDevRigSpec.FRAME_REF);
        coordinateFrame.put("frameVersionRef", MediaDevRigSpec.FRAME_VERSION);
        coordinateFrame.put("handedness", "RIGHT_HANDED");
        coordinateFrame.put("axisDirections", List.of("POS_X", "POS_Y", "POS_Z"));
        coordinateFrame.put("upAxis", "Y");
        coordinateFrame.put("positionUnitRef", SpatialRigEngine.GLB_METRE_UNIT_REF);
        coordinateFrame.put("orientationUnitRef", SpatialRigEngine.GLB_QUATERNION_UNIT_REF);
        String claims = "DEV_ONLY deterministic 3D rig render: forward kinematics by the verified spatial rig engine, frames "
                + "by a CPU software rasterizer, the MP4 a lossy YUV420 H.264 encode of them, the GLB a float32 "
                + "approximation of the keyframes. No quality, rights, approval or production claim";

        Map<String, Object> shared = new LinkedHashMap<>();
        shared.put("rigSchema", SCHEMA);
        shared.put("scope", "DEV_ONLY");
        shared.put("requestId", request.requestId());
        shared.put("specSha256", parsed.specSha256());
        shared.put("frameSetSha256", frameSetSha);
        shared.put("frameCount", parsed.frameCount());
        shared.put("width", parsed.width());
        shared.put("height", parsed.height());
        shared.put("fps", fps);
        shared.put("coordinateFrame", coordinateFrame);
        if (!assetRefs.isEmpty()) {
            shared.put("sources", assetRefs);
            shared.put("parent", assetRefs.getFirst()); // erasure and rights follow parent/sources to derived outputs
        }
        shared.put("encoder", encoder);
        shared.put("rightsDecision", rightsDecision);
        shared.put("claims", claims);

        Map<String, Object> videoLineage = new LinkedHashMap<>(shared);
        videoLineage.put("kind", KIND_VIDEO);
        videoLineage.put("resultSha256", MediaDevProjectRenderRuntime.sha256Hex(mp4));
        MediaArtifact video = registerOne(tenantId, principalId, "video", request.requestId(), mp4, "video/mp4", "mp4",
                "rig-" + MediaDevDubSupport.safeName(request.requestId()), videoLineage);

        Map<String, Object> glbLineage = new LinkedHashMap<>(shared);
        glbLineage.put("kind", KIND_GLB);
        glbLineage.put("resultSha256", glb.sha256());
        Map<String, Object> glbInfo = new LinkedHashMap<>();
        glbInfo.put("format", "GLB 2.0 node/skeleton animation (translation + rotation channels, LINEAR)");
        glbInfo.put("sourceProjectRevisionRef", glb.sourceProjectRevisionRef());
        glbInfo.put("timeEncoding", glb.timeEncoding());
        glbInfo.put("lossDisposition", glb.lossDisposition());
        glbInfo.put("bytes", glb.bytes().length);
        glbInfo.put("sourceVersions", glb.sourceVersions().stream().map(source -> Map.of("tenantId", source.tenantId(),
                "artifactId", source.artifactId(), "versionId", source.versionId())).toList());
        glbLineage.put("glb", glbInfo);
        MediaArtifact glbArtifact = registerOne(tenantId, principalId, "glb", request.requestId(), glb.bytes(),
                "model/gltf-binary", "glb", "rig-" + MediaDevDubSupport.safeName(request.requestId()), glbLineage);

        Map<String, Object> manifest = new LinkedHashMap<>();
        manifest.put("schema", MANIFEST_SCHEMA);
        manifest.put("scope", "DEV_ONLY");
        manifest.put("requestId", request.requestId());
        manifest.put("specSha256", parsed.specSha256());
        manifest.put("spec", parsed.canonical());
        manifest.put("video", MediaDevDubSupport.ref(video));
        manifest.put("glb", MediaDevDubSupport.ref(glbArtifact));
        manifest.put("coordinateFrame", coordinateFrame);
        Map<String, Object> profile = new LinkedHashMap<>();
        profile.put("width", parsed.width());
        profile.put("height", parsed.height());
        profile.put("fpsNumerator", parsed.fpsNumerator());
        profile.put("fpsDenominator", parsed.fpsDenominator());
        profile.put("frameCount", parsed.frameCount());
        profile.put("durationSecondsNumerator", Long.toString((long) parsed.frameCount() * parsed.fpsDenominator()));
        profile.put("durationSecondsDenominator", Integer.toString(parsed.fpsNumerator()));
        manifest.put("profile", profile);
        MediaDevRigSpec.CameraSpec cam = parsed.camera();
        Map<String, Object> camera = new LinkedHashMap<>();
        camera.put("position", vec(cam.position()));
        camera.put("lookAt", vec(cam.lookAt()));
        camera.put("orientationXyzw", quat(MediaDevRigSpec.lookAt(cam.position(), cam.lookAt())));
        camera.put("verticalFovDegrees", cam.fovDegrees());
        camera.put("near", cam.near());
        camera.put("far", cam.far());
        camera.put("projection", "pinhole perspective; looks along local -Z; x_px = W/2 + f*x/depth, y_px = H/2 - f*y/depth, "
                + "f = H / (2 tan(fov/2)); pixel i covers [i, i+1)");
        manifest.put("camera", camera);
        manifest.put("frames", frames);
        manifest.put("frameSetSha256", frameSetSha);
        manifest.put("frameSetDefinition", "SHA-256 over lines 'index:pixelSha256' (pixelSha256 = SHA-256 of the pre-encode "
                + "RGB24 frame bytes, row 0 first)");
        manifest.put("encoder", encoder);
        manifest.put("verification", verification);
        manifest.put("quality", quality);
        manifest.put("glbExport", glbInfo);
        manifest.put("assets", assetRefs);
        manifest.put("claims", claims);
        Map<String, Object> manifestLineage = new LinkedHashMap<>(shared);
        manifestLineage.put("kind", KIND_MANIFEST);
        manifestLineage.put("siblings", Map.of("video", MediaDevDubSupport.ref(video), "glb", MediaDevDubSupport.ref(glbArtifact)));
        byte[] manifestBytes = MediaDevDubSupport.json(manifest);
        MediaArtifact manifestArtifact = registerOne(tenantId, principalId, "manifest", request.requestId(), manifestBytes,
                "application/json", "json", "rig-manifest-" + MediaDevDubSupport.safeName(request.requestId()), manifestLineage);
        return new Render(video, glbArtifact, manifestArtifact, manifest, videoLineage, glbLineage, false);
    }

    private MediaArtifact registerOne(String tenantId, String principalId, String role, String requestId, byte[] bytes,
                                      String contentType, String extension, String namePrefix, Map<String, Object> lineage) {
        String sha256 = MediaDevProjectRenderRuntime.sha256Hex(bytes);
        Map<String, Object> metadata = new LinkedHashMap<>(lineage);
        metadata.put("purpose", "rig-render-output");
        UploadRequest upload = new UploadRequest(tenantId, principalId, namePrefix + "." + extension, contentType,
                bytes.length, sha256, "INTERNAL", Duration.ofDays(30), metadata);
        String idempotencyKey = "dev-rig:" + role + ":" + MediaDevProjectRenderRuntime.sha256Hex(
                tenantId + "\u0000" + principalId + "\u0000" + requestId);
        MediaDevProjectRenderRuntime.Registered registered;
        try {
            registered = registrar.register(tenantId, principalId, upload, idempotencyKey, bytes);
        } catch (IllegalArgumentException conflict) {
            if (conflict.getMessage() != null && conflict.getMessage().contains("Idempotency-Key")) {
                throw new RigRequestReusedException();
            }
            throw new RigRegistrationFailedException(conflict);
        } catch (RuntimeException failure) {
            throw new RigRegistrationFailedException(failure);
        }
        MediaArtifact artifact = registered.artifact();
        if (!artifact.sha256().equals(sha256)) {
            throw new RigRegistrationFailedException(
                    new IllegalStateException("registered artifact digest does not match produced bytes"));
        }
        return artifact;
    }

    // ------------------------------------------------------------------ helpers

    private static Path privateTempDirectory() {
        try {
            return Files.createTempDirectory("media-dev-rig-",
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        } catch (IOException failure) {
            throw new IllegalStateException("private working directory could not be created", failure);
        }
    }

    private static void deleteTree(Path dir) {
        try (Stream<Path> walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder()).forEach(path -> path.toFile().delete());
        } catch (IOException ignored) {
            // best effort: the directory is private (0700) under the OS temp root
        }
    }
}
