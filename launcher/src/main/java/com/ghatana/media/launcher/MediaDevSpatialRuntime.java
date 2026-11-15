package com.ghatana.media.launcher;

import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import javax.imageio.ImageIO;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * DEV_ONLY 360 / spatial video export and viewer readback (J-28 {@code media.dev.spatial-and-interactive-export}).
 *
 * <p><b>Export.</b> A stored video version becomes an MP4 that carries Spherical Video V2 metadata ({@code st3d} mono
 * stereo mode and an {@code sv3d} equirectangular projection) if, and only if, the user declared the source to be a
 * monoscopic equirectangular video AND the source geometry is consistent with that declaration (a decodable video stream
 * of exactly 2:1, no display rotation, no spherical or stereo metadata already present). A source that cannot be
 * equirectangular is refused with a typed 422 and no metadata is ever written for it. Nothing is invented: the written
 * values are the declared stereo mode, the declared initial view (default 0/0/0) and the full-sphere projection bounds.
 * The media is stream-copied (FFmpeg) so frame data, count and presentation timestamps are unchanged; before anything is
 * registered the output is re-probed: every frame's PTS equals the source's, the video packets hash identically, the
 * output decodes, and ffprobe reports exactly the declared side data.
 *
 * <p><b>Viewer.</b> {@link #viewport} behaves as a viewer: it reads the projection from the exported FILE (never from
 * the request), refuses a file that carries none, renders a rectilinear view of one decoded frame at a given yaw/pitch/
 * field of view with FFmpeg's {@code v360} filter and reports the source pixel the same direction maps to.
 *
 * <p>Rights: every call admits the source version for PROCESSING; a revoked source refuses a replay and a viewport read.
 */
final class MediaDevSpatialRuntime {
    static final String SCHEMA = "media.dev.spatial-export.v1";
    static final String KIND = "SPATIAL_VIDEO_EXPORT";
    static final String LANE = "spatial.export";
    static final long MAX_PIXELS = 4096L * 2048L;
    static final int MAX_FRAMES = 3_600;
    static final int MIN_WIDTH = 64;
    private static final Duration TOOL_TIMEOUT = Duration.ofMinutes(4);
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final Path NO_FILE = null;

    /** The user's declaration about the source; without it nothing is written. */
    record Declaration(String projection, String stereoMode, MediaDevMp4Spherical.Pose pose) { }

    record ExportRequest(String requestId, String artifactId, String artifactVersionId, Declaration declaration) {
        ExportRequest {
            requestId = MediaDevVideoRuntime.boundedId(requestId);
            Objects.requireNonNull(artifactId, "artifactId");
            Objects.requireNonNull(artifactVersionId, "artifactVersionId");
            Objects.requireNonNull(declaration, "declaration");
        }
    }

    record ViewportRequest(String artifactId, String artifactVersionId, int frameIndex, double yawDegrees,
                           double pitchDegrees, double fovDegrees, int width, int height) { }

    record Viewport(Map<String, Object> view, byte[] png) { }

    /** What ffprobe reports about the first video stream. */
    record Inspected(String codec, int width, int height, boolean rotated, JsonNode spherical, JsonNode stereo,
                     JsonNode sideData) { }

    private final MediaDevVideoRuntime video;
    private final MediaRuntime runtime;

    MediaDevSpatialRuntime(MediaRuntime runtime, MediaDevVideoRuntime video) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.video = Objects.requireNonNull(video, "video");
    }

    Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("scope", "DEV_ONLY");
        out.put("export", Map.of("projections", List.of("EQUIRECTANGULAR"), "stereoModes", List.of("MONO"),
                "metadata", "Spherical Video V2 st3d + sv3d (equirectangular)", "stream", "COPY",
                "sourceGeometry", "exactly 2:1, no display rotation, no existing spherical or stereo metadata"));
        out.put("viewer", Map.of("renderer", "ffmpeg v360 (rectilinear)", "fovDegrees", List.of(20, 120),
                "maxViewport", 1280, "convention", "yaw 0 = frame centre, + right; pitch 0 = frame centre, + up"));
        out.put("limits", Map.of("maxPixels", MAX_PIXELS, "maxFrames", MAX_FRAMES));
        return out;
    }

    // ------------------------------------------------------------------ export

    MediaDevVideoRuntime.VideoResult export(String tenantId, String principalId, ExportRequest request) {
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "spatial_export", tenantId,
                () -> exportAdmitted(tenantId, principalId, request));
    }

    private MediaDevVideoRuntime.VideoResult exportAdmitted(String tenantId, String principalId, ExportRequest request) {
        Declaration declaration = request.declaration();
        if (!"EQUIRECTANGULAR".equals(declaration.projection())) {
            throw refused(422, "PROJECTION_NOT_SUPPORTED", "only a declared EQUIRECTANGULAR source can be exported",
                    Map.of("path", "declaration.projection", "supported", List.of("EQUIRECTANGULAR")));
        }
        if (!"MONO".equals(declaration.stereoMode())) {
            throw refused(422, "STEREO_MODE_NOT_SUPPORTED", "only MONO (2D) spherical video is supported",
                    Map.of("path", "declaration.stereoMode", "supported", List.of("MONO")));
        }
        MediaArtifact source = video.source(tenantId, principalId, request.artifactId(), request.artifactVersionId());
        Resolution resolution = video.admit(tenantId, source);
        MediaDevVideoRuntime.requireVideo(source);
        if (source.sizeBytes() > MediaDevVideoRuntime.MAX_SOURCE_BYTES) {
            throw refused(422, "VIDEO_LIMIT_EXCEEDED", "the source exceeds the byte ceiling", Map.of());
        }
        String fingerprint = MediaDevRequestLedger.fingerprint("media.dev.spatial.export.v1", source.artifactId(),
                source.version().value(), source.sha256(), declaration.projection(), declaration.stereoMode(),
                Integer.toString(declaration.pose().yawFixed()), Integer.toString(declaration.pose().pitchFixed()),
                Integer.toString(declaration.pose().rollFixed()));
        return video.requestLedger().run(tenantId, principalId, LANE, request.requestId(), fingerprint,
                outputs -> replay(tenantId, principalId, outputs, resolution),
                () -> produce(tenantId, principalId, request, source, resolution),
                result -> List.of(new OutputRef("export", result.artifact().artifactId(),
                        result.artifact().version().value())),
                MediaDevVideoRuntime.VideoRequestReusedException::new);
    }

    private MediaDevVideoRuntime.VideoResult replay(String tenantId, String principalId, List<OutputRef> outputs,
                                                    Resolution resolution) {
        OutputRef ref = outputs.getFirst();
        return find(tenantId, principalId, ref.artifactId())
                .filter(found -> found.artifact().version().value().equals(ref.versionId()))
                .map(found -> new MediaDevVideoRuntime.VideoResult(found.artifact(), found.lineage(), true, resolution))
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(LANE));
    }

    private MediaDevVideoRuntime.VideoResult produce(String tenantId, String principalId, ExportRequest request,
                                                     MediaArtifact source, Resolution resolution) {
        Path dir = MediaDevVideoRuntime.privateTempDirectory();
        try {
            Path in = dir.resolve("in.bin");
            video.stage(tenantId, principalId, source, in);
            MediaDevVideoRuntime.Probe before = video.probe(in, dir, MAX_PIXELS, MAX_FRAMES,
                    BoundedProcessRunner.CancellationToken.NEVER);
            Inspected inspected = inspect(in, dir);
            requireEquirectangularGeometry(inspected, before.width, before.height);
            if (inspected.spherical() != null || inspected.stereo() != null) {
                throw refused(422, "SOURCE_ALREADY_HAS_SPATIAL_METADATA",
                        "the source already carries spherical or stereo metadata; it is not rewritten or duplicated",
                        Map.of("path", "source"));
            }
            decodeCheck(in, dir, "source");
            Path copied = dir.resolve("copied.mp4");
            List<String> command = new ArrayList<>(List.of(video.ffmpegPath().toString(), "-nostdin", "-hide_banner",
                    "-v", "error", "-xerror", "-i", in.toString(), "-map", "0:v:0", "-map", "0:a?", "-sn", "-dn",
                    "-c", "copy", "-map_metadata", "-1", "-metadata",
                    "comment=media.dev.spatial request=" + request.requestId() + " source=" + source.sha256(),
                    "-fflags", "+bitexact", "-flags:v", "+bitexact"));
            if (before.timeBaseNum == 1) {
                command.addAll(List.of("-video_track_timescale", Long.toString(before.timeBaseDen)));
            }
            command.addAll(List.of("-y", copied.toString()));
            BoundedProcessRunner.Result copy = video.runProcess(command, dir, TOOL_TIMEOUT, 1024, copied,
                    MediaDevVideoRuntime.MAX_OUTPUT_BYTES, "copy", BoundedProcessRunner.CancellationToken.NEVER);
            if (!copy.succeeded() && copy.end() == BoundedProcessRunner.End.EXITED && copy.exitCode() > 0
                    && copy.exitCode() < 128) {
                throw refused(422, "SOURCE_CODEC_NOT_MP4_COPYABLE",
                        "the source video or audio codec cannot be stream-copied into an MP4 container; it is not "
                                + "re-encoded by this lane", Map.of("codec", inspected.codec()));
            }
            MediaDevVideoRuntime.classify(copy, "copy", "SPATIAL_EXPORT_FAILED");
            byte[] spatial;
            try {
                spatial = MediaDevMp4Spherical.insert(Files.readAllBytes(copied), request.declaration().pose());
            } catch (MediaDevMp4Spherical.Mp4SphericalException unsupported) {
                throw refused(422, "SPATIAL_METADATA_NOT_WRITABLE", unsupported.getMessage(), Map.of());
            }
            Path out = dir.resolve("out.mp4");
            Files.write(out, spatial);
            Map<String, Object> verification = verify(in, out, dir, before, request.declaration(), spatial);
            return register(tenantId, principalId, request, source, resolution, spatial, before, verification);
        } catch (IOException failure) {
            throw new MediaDevVideoRuntime.VideoRefusedException(503, "VIDEO_TOOLS_UNAVAILABLE",
                    "the video tools could not be run; nothing was registered");
        } finally {
            MediaDevVideoRuntime.deleteTree(dir);
        }
    }

    private static void requireEquirectangularGeometry(Inspected inspected, int width, int height) {
        if (inspected.rotated()) {
            throw refused(422, "SOURCE_NOT_EQUIRECTANGULAR",
                    "a source with a display rotation cannot be a declared equirectangular frame; no metadata was written",
                    Map.of("path", "source", "reason", "DISPLAY_ROTATION"));
        }
        if (width < MIN_WIDTH || (long) width != 2L * height) {
            throw refused(422, "SOURCE_NOT_EQUIRECTANGULAR",
                    "a monoscopic equirectangular frame is exactly 2:1 (360 x 180 degrees); this source is "
                            + width + "x" + height + ". No spherical metadata was written",
                    Map.of("path", "source", "width", width, "height", height, "requiredAspect", "2:1",
                            "minimumWidth", MIN_WIDTH));
        }
    }

    private void decodeCheck(Path file, Path dir, String what) throws IOException {
        BoundedProcessRunner.Result decoded = video.runProcess(List.of(video.ffmpegPath().toString(), "-nostdin",
                "-hide_banner", "-v", "error", "-xerror", "-i", file.toString(), "-map", "0:v:0", "-f", "null", "-"),
                dir, TOOL_TIMEOUT, 4096, NO_FILE, 0, "decode", BoundedProcessRunner.CancellationToken.NEVER);
        if (!decoded.succeeded()) {
            if (decoded.end() != BoundedProcessRunner.End.EXITED || decoded.exitCode() >= 128) {
                throw new MediaDevVideoRuntime.VideoOutcomeUnknownException("decode");
            }
            throw refused(422, what.equals("source") ? "SOURCE_VIDEO_UNDECODABLE" : "SPATIAL_OUTPUT_UNDECODABLE",
                    "the " + what + " video does not decode cleanly", Map.of());
        }
    }

    /** ffprobe of the first video stream: codec, geometry, rotation and the spherical and stereo side data. */
    Inspected inspect(Path file, Path dir) throws IOException {
        BoundedProcessRunner.Result probed = video.runProcess(List.of(video.ffprobePath().toString(), "-v", "error",
                "-select_streams", "v:0", "-show_streams", "-of", "json", file.toString()), dir, TOOL_TIMEOUT,
                1024 * 1024, NO_FILE, 0, "probe", BoundedProcessRunner.CancellationToken.NEVER);
        if (!probed.succeeded()) {
            if (probed.end() != BoundedProcessRunner.End.EXITED || probed.exitCode() >= 128) {
                throw new MediaDevVideoRuntime.VideoOutcomeUnknownException("probe");
            }
            throw refused(422, "SOURCE_VIDEO_CORRUPT", "the video could not be probed", Map.of());
        }
        JsonNode stream = JSON.readTree(new String(probed.stdout(), StandardCharsets.UTF_8)).path("streams").path(0);
        if (stream.isMissingNode()) throw refused(422, "SOURCE_VIDEO_CORRUPT", "the file has no video stream", Map.of());
        JsonNode spherical = null;
        JsonNode stereo = null;
        boolean rotated = false;
        for (JsonNode side : stream.path("side_data_list")) {
            String type = side.path("side_data_type").asString("");
            if (type.equals("Spherical Mapping")) spherical = side;
            else if (type.equals("Stereo 3D")) stereo = side;
            else if (type.equals("Display Matrix") && Math.round(side.path("rotation").asDouble(0)) != 0) rotated = true;
        }
        return new Inspected(stream.path("codec_name").asString(""), stream.path("width").asInt(0),
                stream.path("height").asInt(0), rotated, spherical, stereo, stream.path("side_data_list"));
    }

    private Map<String, Object> verify(Path in, Path out, Path dir, MediaDevVideoRuntime.Probe before,
                                       Declaration declaration, byte[] outBytes) throws IOException {
        MediaDevVideoRuntime.Probe after = video.probe(out, dir, MAX_PIXELS, MAX_FRAMES,
                BoundedProcessRunner.CancellationToken.NEVER);
        Map<String, Object> timeline;
        try {
            timeline = video.verifyTimeline(before, after);
        } catch (MediaDevVideoRuntime.VideoRefusedException mismatch) {
            throw refused(422, "SPATIAL_TIMELINE_MISMATCH",
                    "the exported frame count or presentation timestamps differ from the source; nothing was registered",
                    mismatch.details());
        }
        decodeCheck(out, dir, "output");
        String sourceMd5 = videoPacketsMd5(in, dir);
        String outputMd5 = videoPacketsMd5(out, dir);
        if (!sourceMd5.equals(outputMd5)) {
            throw refused(422, "SPATIAL_VIDEO_PACKETS_CHANGED",
                    "the exported video packets differ from the source; nothing was registered", Map.of());
        }
        Inspected written = inspect(out, dir);
        Map<String, Object> sideData = sideDataMatches(written, declaration, after.width, after.height, outBytes);
        Map<String, Object> verification = new LinkedHashMap<>();
        verification.put("timeline", timeline);
        verification.put("videoPacketsMd5", sourceMd5);
        verification.put("sideData", sideData);
        verification.put("verifiedBy", "ffprobe -show_frames/-show_streams and ffmpeg -c copy -f md5 on source and output");
        return verification;
    }

    /**
     * The spherical metadata of the written file must equal the declaration exactly: ffprobe must report an equirectangular
     * mapping and 2D stereo with the declared pose (it prints whole degrees, truncated), and the boxes read straight from
     * the file bytes must carry the exact 16.16 pose, the full-sphere bounds and mono stereo mode.
     */
    static Map<String, Object> sideDataMatches(Inspected written, Declaration declaration, int width, int height,
                                               byte[] fileBytes) {
        JsonNode spherical = written.spherical();
        JsonNode stereo = written.stereo();
        if (spherical == null || !"equirectangular".equals(spherical.path("projection").asString(""))
                || stereo == null || !"2D".equals(stereo.path("type").asString(""))) {
            throw refused(422, "SPATIAL_METADATA_NOT_READ_BACK",
                    "the written spherical metadata was not read back as equirectangular mono; nothing was registered",
                    Map.of());
        }
        MediaDevMp4Spherical.Pose pose = declaration.pose();
        if (spherical.path("yaw").asLong(Long.MIN_VALUE) != (long) (pose.yawFixed() / 65536.0)
                || spherical.path("pitch").asLong(Long.MIN_VALUE) != (long) (pose.pitchFixed() / 65536.0)
                || spherical.path("roll").asLong(Long.MIN_VALUE) != (long) (pose.rollFixed() / 65536.0)) {
            throw refused(422, "SPATIAL_METADATA_MISMATCH",
                    "the pose ffprobe reads back differs from the declared initial view; nothing was registered", Map.of());
        }
        MediaDevMp4Spherical.ReadBack boxes = MediaDevMp4Spherical.readBack(fileBytes);
        if (!boxes.hasSt3d() || boxes.stereoMode() != 0 || !boxes.hasSv3d() || !boxes.equirectangular()
                || boxes.boundsSum() != 0 || boxes.yawFixed() != pose.yawFixed() || boxes.pitchFixed() != pose.pitchFixed()
                || boxes.rollFixed() != pose.rollFixed()) {
            throw refused(422, "SPATIAL_METADATA_MISMATCH",
                    "the boxes in the file differ from the declaration; nothing was registered", Map.of());
        }
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("projection", "equirectangular");
        view.put("stereoMode", "MONO");
        view.put("yawDegrees", boxes.yawDegrees());
        view.put("pitchDegrees", boxes.pitchDegrees());
        view.put("rollDegrees", boxes.rollDegrees());
        view.put("yawFixed1616", boxes.yawFixed());
        view.put("pitchFixed1616", boxes.pitchFixed());
        view.put("rollFixed1616", boxes.rollFixed());
        view.put("projectionBounds", "FULL_SPHERE");
        view.put("frame", Map.of("width", width, "height", height));
        view.put("readBackBy", "ffprobe side data and an independent box read of the file");
        return view;
    }

    private String videoPacketsMd5(Path file, Path dir) throws IOException {
        BoundedProcessRunner.Result result = video.runProcess(List.of(video.ffmpegPath().toString(), "-nostdin",
                "-hide_banner", "-v", "error", "-i", file.toString(), "-map", "0:v:0", "-c", "copy", "-f", "md5", "-"),
                dir, TOOL_TIMEOUT, 4096, NO_FILE, 0, "video check", BoundedProcessRunner.CancellationToken.NEVER);
        MediaDevVideoRuntime.classify(result, "video check", "SPATIAL_VIDEO_PACKETS_CHANGED");
        String text = new String(result.stdout(), StandardCharsets.US_ASCII).trim();
        if (!text.startsWith("MD5=") || text.length() != 36) {
            throw refused(422, "SPATIAL_VIDEO_PACKETS_CHANGED", "the video packets could not be hashed", Map.of());
        }
        return text.substring(4);
    }

    private MediaDevVideoRuntime.VideoResult register(String tenantId, String principalId, ExportRequest request,
                                                      MediaArtifact source, Resolution resolution, byte[] bytes,
                                                      MediaDevVideoRuntime.Probe before,
                                                      Map<String, Object> verification) {
        Declaration declaration = request.declaration();
        Map<String, Object> lineage = MediaDevVideoRuntime.baseLineage(SCHEMA, KIND, request.requestId(), resolution,
                bytes);
        lineage.put("source", MediaDevVideoRuntime.sourceRef(source));
        lineage.put("parent", MediaDevDubSupport.ref(source));
        Map<String, Object> declared = new LinkedHashMap<>();
        declared.put("projection", declaration.projection());
        declared.put("stereoMode", declaration.stereoMode());
        declared.put("initialView", Map.of("yawDegrees", declaration.pose().yawDegrees(),
                "pitchDegrees", declaration.pose().pitchDegrees(), "rollDegrees", declaration.pose().rollDegrees()));
        declared.put("declaredBy", principalId);
        lineage.put("declaration", declared);
        lineage.put("geometry", Map.of("width", before.width, "height", before.height, "aspect", "2:1"));
        lineage.put("writer", Map.of("kind", "mp4-box-insert", "boxes", List.of("st3d", "sv3d(svhd,proj(prhd,equi))"),
                "metadataSource", MediaDevMp4Spherical.METADATA_SOURCE, "stream", "COPY"));
        lineage.put("verification", verification);
        lineage.put("tools", Map.of("ffmpeg", video.ffmpegVersion()));
        lineage.put("claims", Map.of("spatialMetadata", "USER_DECLARED_EQUIRECTANGULAR_GEOMETRY_CHECKED",
                "note", "The projection is the user's declaration checked only against geometry (2:1, no rotation, no "
                        + "existing spatial metadata); the image content is not classified. No quality, rights, approval "
                        + "or production claim."));
        return video.register(tenantId, principalId, "spatial-" + MediaDevVideoRuntime.shortHash(request.requestId()) + ".mp4",
                "video/mp4", KIND, request.requestId(), bytes, lineage, resolution);
    }

    // ------------------------------------------------------------------ readback

    private static final List<String> LINEAGE_KEYS = List.of("videoSchema", "scope", "kind", "requestId", "source",
            "parent", "declaration", "geometry", "writer", "verification", "tools", "rightsDecision", "resultSha256",
            "claims");

    private Optional<MediaDevVideoRuntime.VideoResult> find(String tenantId, String principalId, String artifactId) {
        return runtime.artifact(tenantId, principalId, artifactId)
                .filter(artifact -> SCHEMA.equals(artifact.metadata().get("videoSchema")))
                .map(artifact -> {
                    Map<String, Object> lineage = new LinkedHashMap<>();
                    for (String key : LINEAGE_KEYS) {
                        if (artifact.metadata().containsKey(key)) lineage.put(key, artifact.metadata().get(key));
                    }
                    return new MediaDevVideoRuntime.VideoResult(artifact, lineage, true, null);
                });
    }

    /** Reopens an export for its owner; the source rights are re-admitted (a revoked source refuses the readback). */
    Optional<MediaDevVideoRuntime.VideoResult> reopen(String tenantId, String principalId, String artifactId) {
        Optional<MediaDevVideoRuntime.VideoResult> found = find(tenantId, principalId, artifactId);
        if (found.isEmpty()) return found;
        Resolution resolution = admitSourceOf(tenantId, principalId, found.get().artifact());
        return Optional.of(new MediaDevVideoRuntime.VideoResult(found.get().artifact(), found.get().lineage(), true,
                resolution));
    }

    private Resolution admitSourceOf(String tenantId, String principalId, MediaArtifact export) {
        if (!(export.metadata().get("source") instanceof Map<?, ?> ref) || !(ref.get("artifactId") instanceof String id)
                || !(ref.get("artifactVersionId") instanceof String version)) {
            throw refused(422, "SPATIAL_LINEAGE_INVALID", "the export names no source version", Map.of());
        }
        return video.admit(tenantId, video.source(tenantId, principalId, id, version));
    }

    // ------------------------------------------------------------------ viewer

    Viewport viewport(String tenantId, String principalId, ViewportRequest request) {
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "spatial_viewport", tenantId,
                () -> viewportAdmitted(tenantId, principalId, request));
    }

    private Viewport viewportAdmitted(String tenantId, String principalId, ViewportRequest request) {
        MediaArtifact export = video.source(tenantId, principalId, request.artifactId(), request.artifactVersionId());
        if (!SCHEMA.equals(export.metadata().get("videoSchema"))) {
            throw refused(422, "NOT_A_SPATIAL_EXPORT", "the artifact version is not a DEV_ONLY spatial export",
                    Map.of("path", "artifactId"));
        }
        admitSourceOf(tenantId, principalId, export);
        Path dir = MediaDevVideoRuntime.privateTempDirectory();
        try {
            Path file = dir.resolve("export.mp4");
            video.stage(tenantId, principalId, export, file);
            Inspected inspected = inspect(file, dir);
            // A viewer never guesses: no spherical metadata in the FILE, no 360 view.
            if (inspected.spherical() == null
                    || !"equirectangular".equals(inspected.spherical().path("projection").asString(""))) {
                throw refused(422, "NO_SPHERICAL_METADATA",
                        "the file carries no equirectangular spherical metadata, so it is not shown as a 360 video",
                        Map.of());
            }
            if (inspected.stereo() != null && !"2D".equals(inspected.stereo().path("type").asString(""))) {
                throw refused(422, "STEREO_MODE_NOT_SUPPORTED", "only mono spherical video is shown", Map.of());
            }
            MediaDevVideoRuntime.Probe probe = video.probe(file, dir, MAX_PIXELS, MAX_FRAMES,
                    BoundedProcessRunner.CancellationToken.NEVER);
            int frames = probe.timeline.frames().size();
            if (request.frameIndex() < 0 || request.frameIndex() >= frames) {
                throw refused(422, "FRAME_OUT_OF_RANGE", "frameIndex is outside the video",
                        Map.of("path", "frameIndex", "frameCount", frames));
            }
            MediaDevSphericalProjection.Pixel pixel = MediaDevSphericalProjection.toPixel(request.yawDegrees(),
                    request.pitchDegrees(), probe.width, probe.height);
            Path png = dir.resolve("view.png");
            String vf = String.format(Locale.ROOT,
                    "select=eq(n\\,%d),v360=input=equirect:output=flat:yaw=%s:pitch=%s:roll=0:h_fov=%s:v_fov=%s:w=%d:h=%d:interp=linear",
                    request.frameIndex(), fmt(request.yawDegrees()), fmt(request.pitchDegrees()),
                    fmt(request.fovDegrees()), fmt(verticalFov(request)),
                    request.width(), request.height());
            BoundedProcessRunner.Result rendered = video.runProcess(List.of(video.ffmpegPath().toString(), "-nostdin",
                    "-hide_banner", "-v", "error", "-xerror", "-i", file.toString(), "-map", "0:v:0", "-vf", vf,
                    "-frames:v", "1", "-fps_mode", "passthrough", "-y", png.toString()), dir, TOOL_TIMEOUT, 4096,
                    png, 32L * 1024 * 1024, "viewport", BoundedProcessRunner.CancellationToken.NEVER);
            MediaDevVideoRuntime.classify(rendered, "viewport", "VIEWPORT_RENDER_FAILED");
            byte[] bytes = Files.readAllBytes(png);
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("schema", SCHEMA);
            view.put("scope", "DEV_ONLY");
            view.put("exportArtifactId", export.artifactId());
            view.put("exportArtifactVersionId", export.version().value());
            Map<String, Object> metadata = new LinkedHashMap<>();
            metadata.put("projection", "equirectangular");
            metadata.put("source", "ffprobe and the boxes of the exported file");
            MediaDevMp4Spherical.ReadBack boxes = MediaDevMp4Spherical.readBack(Files.readAllBytes(file));
            metadata.put("yawDegrees", boxes.yawDegrees());
            metadata.put("pitchDegrees", boxes.pitchDegrees());
            metadata.put("rollDegrees", boxes.rollDegrees());
            view.put("fileMetadata", metadata);
            view.put("frame", Map.of("index", request.frameIndex(), "count", frames, "width", probe.width,
                    "height", probe.height, "ptsMicros", probe.timeline.ptsMicros(
                            probe.timeline.frames().get(request.frameIndex()).pts())));
            view.put("viewport", Map.of("yawDegrees", request.yawDegrees(), "pitchDegrees", request.pitchDegrees(),
                    "fovDegrees", request.fovDegrees(), "width", request.width(), "height", request.height()));
            view.put("sourcePixel", Map.of("x", pixel.x(), "y", pixel.y(), "xExact", pixel.xExact(),
                    "yExact", pixel.yExact()));
            view.put("viewportCentre", centre(bytes));
            view.put("pngSha256", MediaDevProjectRenderRuntime.sha256Hex(bytes));
            view.put("pngBase64", Base64.getEncoder().encodeToString(bytes));
            view.put("note", "DEV_ONLY ephemeral rectilinear view of one decoded frame; not registered as an artifact");
            return new Viewport(view, bytes);
        } catch (IOException failure) {
            throw new MediaDevVideoRuntime.VideoRefusedException(503, "VIDEO_TOOLS_UNAVAILABLE",
                    "the video tools could not be run");
        } finally {
            MediaDevVideoRuntime.deleteTree(dir);
        }
    }

    private static Map<String, Object> centre(byte[] png) throws IOException {
        var image = ImageIO.read(new ByteArrayInputStream(png));
        if (image == null) throw refused(422, "VIEWPORT_RENDER_FAILED", "the rendered view is not a decodable image", Map.of());
        int rgb = image.getRGB(image.getWidth() / 2, image.getHeight() / 2);
        return Map.of("x", image.getWidth() / 2, "y", image.getHeight() / 2, "r", (rgb >> 16) & 255,
                "g", (rgb >> 8) & 255, "b", rgb & 255);
    }

    /** Vertical field of view of a rectilinear view with the requested horizontal one and aspect. */
    static double verticalFov(ViewportRequest request) {
        double half = Math.toRadians(request.fovDegrees()) / 2.0;
        return Math.toDegrees(2.0 * Math.atan(Math.tan(half) * request.height() / request.width()));
    }

    private static String fmt(double value) {
        return String.format(Locale.ROOT, "%.6f", value);
    }

    private static MediaDevVideoRuntime.VideoRefusedException refused(int status, String code, String message,
                                                                      Map<String, Object> details) {
        return new MediaDevVideoRuntime.VideoRefusedException(status, code, message, details);
    }
}
