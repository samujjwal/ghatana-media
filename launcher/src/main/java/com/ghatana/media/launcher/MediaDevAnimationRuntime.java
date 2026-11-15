package com.ghatana.media.launcher;

import com.ghatana.media.production.animation.AnimationRenderer;
import com.ghatana.media.production.animation.AnimationRenderer.RasterAsset;
import com.ghatana.media.production.AnimationSpecCompiler;
import com.ghatana.media.production.rendering.BoundedProcessRunner;
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
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.stream.Stream;

/**
 * DEV_ONLY deterministic 2D animation render (J-12 {@code media.dev.outcome-two-dimensional-animation}): a typed
 * animation spec (keyframed shapes with the renderer's four easing curves, seeded particle fields and optional image
 * assets) is rendered by the verified {@link AnimationRenderer} into PNG frames and encoded by the real FFmpeg into
 * an H.264 MP4. Two NEW immutable artifacts are registered: the MP4 and a frame manifest (per-frame exact PTS, PNG and
 * decoded-pixel digests, the digest of the whole frame set, the verified encode and the rights decision per asset).
 *
 * <p><b>Determinism.</b> The renderer is deterministic (no antialiasing, seeded particles, exact-rational story time),
 * so identical specs yield identical frame digests before encoding, in one process, across processes and across a
 * launcher restart. The encode is single-threaded and bit-exact, with the request id in the container comment so two
 * requests never share bytes (the store refuses a second artifact with identical bytes in a tenant).</p>
 *
 * <p><b>Verification before registration.</b> The MP4 is re-probed with ffprobe: codec, pixel format, geometry, exact
 * frame count, average frame rate as the exact rational, track time base and every frame's PTS (exact integer ticks).
 * Any disagreement registers nothing.</p>
 *
 * <p><b>Rights.</b> Every image asset must resolve ADMITTED for {@link Scope#PROCESSING} on every call, a replay
 * included; a missing or revoked statement is a typed 403 and nothing is read, rendered or registered. The durable
 * request ledger maps a requestId to its outputs: the same fingerprint replays them, a different body is 409, and a
 * run killed mid-render is UNKNOWN until a retry (or a takeover after a launcher restart) completes it exactly once.</p>
 */
final class MediaDevAnimationRuntime {
    static final String SCHEMA = "media.dev.animation-render.v1";
    static final String MANIFEST_SCHEMA = "media.dev.animation-manifest.v1";
    static final String KIND_VIDEO = "ANIMATION_RENDER_VIDEO";
    static final String KIND_MANIFEST = "ANIMATION_RENDER_MANIFEST";
    static final String LANE = "animation.render";
    static final int DEFAULT_CRF = 14;
    static final int MIN_CRF = 10;
    static final int MAX_CRF = 30;
    static final long MAX_OUTPUT_BYTES = 64L * 1024 * 1024;
    static final int MAX_ASSET_BYTES = 2 * 1024 * 1024;
    static final long MAX_ASSET_PIXELS = 1_048_576L;
    static final int MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
    static final String COLOR_MATRIX = "bt709";
    private static final Duration ENCODE_TIMEOUT = Duration.ofMinutes(5);
    private static final Duration PROBE_TIMEOUT = Duration.ofSeconds(60);
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final List<String> LINEAGE_KEYS = List.of("animationSchema", "scope", "kind", "requestId", "specSha256",
            "frameSetSha256", "frameCount", "width", "height", "fps", "sources", "parent", "siblings", "encoder",
            "rightsDecision", "resultSha256", "claims");

    static {
        // The renderer uses java.awt only for off-screen rasters; never touch a display.
        System.setProperty("java.awt.headless", "true");
    }

    /** A typed refusal with an HTTP status; carries no request content or process output. */
    static final class AnimationRefusedException extends RuntimeException {
        private final int status;
        private final String code;
        private final Map<String, Object> details;

        AnimationRefusedException(int status, String code, String message, Map<String, Object> details) {
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
    static final class AnimationOutcomeUnknownException extends RuntimeException {
        AnimationOutcomeUnknownException(String phase) {
            super("the " + phase + " process did not finish; the outcome is unknown", null, false, false);
        }
    }

    static final class AnimationRequestReusedException extends IllegalStateException {
        AnimationRequestReusedException() { super("animation requestId was already used for a different request"); }
    }

    static final class AnimationRegistrationFailedException extends IllegalStateException {
        AnimationRegistrationFailedException(Throwable cause) {
            super("animation output could not be registered as an immutable artifact", cause);
        }
    }

    record RenderRequest(String requestId, Object spec, int crf) {
        RenderRequest {
            requestId = MediaDevDubSupport.boundedId(requestId, "requestId");
            if (crf < MIN_CRF || crf > MAX_CRF) {
                throw MediaDevAnimationSpec.invalid("$.encoder.crf", "crf must be within [" + MIN_CRF + ", " + MAX_CRF + "]");
            }
        }
    }

    /** Both registered artifacts of one render plus the manifest read back from the stored manifest artifact. */
    record Render(MediaArtifact video, MediaArtifact manifest, Map<String, Object> manifestDocument,
                  Map<String, Object> videoLineage, boolean replayed) implements MediaDevRenderAdmission.ReplayAware {
        @Override public boolean replayedResult() { return replayed; }
    }

    private record ResolvedAsset(MediaDevAnimationSpec.AssetRef ref, MediaArtifact artifact, Resolution resolution) { }

    private final MediaRuntime runtime;
    private final Path ffmpeg;
    private final Path ffprobe;
    private final RightsConsentResolver rights;
    private final MediaDevProjectRenderRuntime.OutputRegistrar registrar;
    private final MediaDevRequestLedger ledger;
    private volatile String ffmpegVersion;

    MediaDevAnimationRuntime(MediaRuntime runtime, Path ffmpeg, Path ffprobe, RightsConsentResolver rights,
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
    static MediaDevAnimationRuntime compose(MediaRuntime runtime, Map<String, String> environment,
                                            RightsConsentResolver rights, MediaDevRequestLedger ledger) {
        String ffmpeg = environment.get(MediaDevProjectRenderRuntime.FFMPEG_ENV);
        String ffprobe = environment.get(MediaDevProjectRenderRuntime.FFPROBE_ENV);
        if (ffmpeg == null || ffmpeg.isBlank() || ffprobe == null || ffprobe.isBlank()) return null;
        return new MediaDevAnimationRuntime(runtime, Path.of(ffmpeg), Path.of(ffprobe), rights,
                MediaDevProjectRenderRuntime.canonicalRegistrar(runtime), ledger);
    }

    Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("scope", "DEV_ONLY");
        out.put("ready", true);
        out.put("specSchema", MediaDevAnimationSpec.SCHEMA);
        Map<String, Object> limits = new LinkedHashMap<>();
        limits.put("minSide", MediaDevAnimationSpec.MIN_SIDE);
        limits.put("maxWidth", MediaDevAnimationSpec.MAX_WIDTH);
        limits.put("maxHeight", MediaDevAnimationSpec.MAX_HEIGHT);
        limits.put("maxFrames", MediaDevAnimationSpec.MAX_FRAMES);
        limits.put("maxFramesPerSecond", MediaDevAnimationSpec.MAX_FPS);
        limits.put("maxAnimationPixels", MediaDevAnimationSpec.MAX_ANIMATION_PIXELS);
        limits.put("maxShapes", MediaDevAnimationSpec.MAX_SHAPES);
        limits.put("maxAssets", MediaDevAnimationSpec.MAX_ASSETS);
        limits.put("maxKeyframesPerShape", MediaDevAnimationSpec.MAX_KEYFRAMES_PER_SHAPE);
        limits.put("maxParticleFields", MediaDevAnimationSpec.MAX_PARTICLE_FIELDS);
        limits.put("maxParticlesPerField", AnimationRenderer.MAX_PARTICLES_PER_FIELD);
        limits.put("maxParticleDraws", MediaDevAnimationSpec.MAX_PARTICLE_DRAWS);
        limits.put("maxAssetBytes", MAX_ASSET_BYTES);
        limits.put("maxAssetPixels", MAX_ASSET_PIXELS);
        limits.put("maxOutputBytes", MAX_OUTPUT_BYTES);
        out.put("limits", limits);
        out.put("primitives", List.of("RECTANGLE", "ELLIPSE", "LINE", "RASTER_ASSET"));
        out.put("easings", List.of("LINEAR", "EASE_IN", "EASE_OUT", "EASE_IN_OUT"));
        out.put("text", "NOT_SUPPORTED");
        out.put("encoder", Map.of("codec", "libx264", "container", "mp4", "pixelFormat", "yuv420p",
                "colorMatrix", COLOR_MATRIX, "range", "tv", "defaultCrf", DEFAULT_CRF, "minCrf", MIN_CRF, "maxCrf", MAX_CRF));
        out.put("rightsAuthority", Map.of("resolverId", rights.resolverId(), "ready", rights.ready(),
                "scope", Scope.PROCESSING.name(), "appliesTo", "image assets"));
        return out;
    }

    // ------------------------------------------------------------------ read

    /** Reopens a render from its manifest artifact id; empty when it is not visible to this tenant and owner. */
    Optional<Render> reopen(String tenantId, String principalId, String manifestArtifactId) {
        Optional<MediaArtifact> manifest = runtime.artifact(tenantId, principalId, manifestArtifactId)
                .filter(artifact -> SCHEMA.equals(artifact.metadata().get("animationSchema"))
                        && KIND_MANIFEST.equals(artifact.metadata().get("kind")));
        if (manifest.isEmpty()) return Optional.empty();
        if (!(manifest.get().metadata().get("siblings") instanceof Map<?, ?> siblings)
                || !(siblings.get("video") instanceof Map<?, ?> videoRef)
                || !(videoRef.get("artifactId") instanceof String videoId)
                || !(videoRef.get("artifactVersionId") instanceof String videoVersion)) return Optional.empty();
        Optional<MediaArtifact> video = runtime.artifact(tenantId, principalId, videoId)
                .filter(artifact -> artifact.version().value().equals(videoVersion)
                        && KIND_VIDEO.equals(artifact.metadata().get("kind")));
        if (video.isEmpty()) return Optional.empty();
        return Optional.of(new Render(video.get(), manifest.get(), readManifest(tenantId, principalId, manifest.get()),
                lineageOf(video.get()), true));
    }

    private Map<String, Object> readManifest(String tenantId, String principalId, MediaArtifact manifest) {
        if (manifest.sizeBytes() > MAX_DOCUMENT_BYTES) {
            throw new AnimationRefusedException(422, "ANIMATION_MANIFEST_TOO_LARGE", "the manifest exceeds the byte ceiling",
                    Map.of());
        }
        ByteArrayOutputStream content = new ByteArrayOutputStream((int) Math.max(1, manifest.sizeBytes()));
        try {
            runtime.copyArtifactContent(tenantId, principalId, manifest.artifactId(), manifest.version(), content,
                    MAX_DOCUMENT_BYTES).orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
            return JSON.readValue(content.toByteArray(), new TypeReference<LinkedHashMap<String, Object>>() { });
        } catch (IOException | RuntimeException unreadable) {
            if (unreadable instanceof MediaDevProjectRenderRuntime.SourceVersionUnavailableException missing) throw missing;
            throw new AnimationRefusedException(422, "ANIMATION_MANIFEST_INVALID",
                    "the stored manifest is not a readable JSON document", Map.of());
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
        // Parse and budget first: an invalid or over-budget spec costs no permit, no lookup and no rights call.
        MediaDevAnimationSpec.Parsed parsed = MediaDevAnimationSpec.parse(request.spec());
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "animation_render", tenantId,
                () -> renderAdmitted(tenantId, principalId, request, parsed));
    }

    private Render renderAdmitted(String tenantId, String principalId, RenderRequest request,
                                  MediaDevAnimationSpec.Parsed parsed) {
        List<ResolvedAsset> assets = resolveAssets(tenantId, principalId, parsed);
        String specJson = canonicalJson(parsed.canonical());
        String specSha = MediaDevProjectRenderRuntime.sha256Hex(specJson);
        StringBuilder assetDigests = new StringBuilder();
        for (ResolvedAsset asset : assets) {
            assetDigests.append(asset.ref().id()).append('=').append(asset.artifact().artifactId()).append('@')
                    .append(asset.artifact().version().value()).append(';');
        }
        String fingerprint = MediaDevRequestLedger.fingerprint("media.dev.animation.render.v1", specSha, request.crf(),
                assetDigests.toString());
        return ledger.run(tenantId, principalId, LANE, request.requestId(), fingerprint,
                outputs -> replay(tenantId, principalId, outputs),
                () -> produce(tenantId, principalId, request, parsed, specSha, assets),
                render -> List.of(
                        new OutputRef("manifest", render.manifest().artifactId(), render.manifest().version().value()),
                        new OutputRef("video", render.video().artifactId(), render.video().version().value())),
                AnimationRequestReusedException::new);
    }

    private Render replay(String tenantId, String principalId, List<OutputRef> outputs) {
        OutputRef ref = outputs.stream().filter(candidate -> candidate.role().equals("manifest")).findFirst()
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(LANE));
        return reopen(tenantId, principalId, ref.artifactId())
                .filter(found -> found.manifest().version().value().equals(ref.versionId()))
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(LANE));
    }

    /** Exact visible version, image type and size, then the PROCESSING admission: no content is read before all pass. */
    private List<ResolvedAsset> resolveAssets(String tenantId, String principalId, MediaDevAnimationSpec.Parsed parsed) {
        List<ResolvedAsset> resolved = new ArrayList<>();
        for (MediaDevAnimationSpec.AssetRef ref : parsed.assets()) {
            MediaArtifact artifact = runtime.artifact(tenantId, principalId, ref.artifactId())
                    .filter(found -> found.version().value().equals(ref.artifactVersionId()))
                    .orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
            String type = artifact.contentType().toLowerCase(Locale.ROOT);
            if (!type.equals("image/png") && !type.equals("image/jpeg")) {
                throw new AnimationRefusedException(422, "ASSET_NOT_SUPPORTED",
                        "an asset must be an image/png or image/jpeg artifact version", Map.of("path", ref.path()));
            }
            if (artifact.sizeBytes() > MAX_ASSET_BYTES) {
                throw MediaDevAnimationSpec.budget(ref.path(), "asset bytes", MAX_ASSET_BYTES, artifact.sizeBytes());
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
        throw new AnimationRefusedException(unavailable ? 503 : 403,
                unavailable ? "RIGHTS_AUTHORITY_UNAVAILABLE" : "RIGHTS_NOT_ADMITTED",
                "an image asset has no current PROCESSING rights and consent admission; nothing was rendered", details);
    }

    private Render produce(String tenantId, String principalId, RenderRequest request,
                           MediaDevAnimationSpec.Parsed parsed, String specSha, List<ResolvedAsset> assets) {
        List<RasterAsset> raster = new ArrayList<>();
        for (ResolvedAsset asset : assets) raster.add(decodeAsset(tenantId, principalId, asset));
        AnimationRenderer.Scene scene;
        AnimationRenderer.RenderedAnimation rendered;
        try {
            scene = new AnimationRenderer.Scene(parsed.width(), parsed.height(), parsed.backgroundArgb(), parsed.shapes(),
                    parsed.particleFields(), raster);
            rendered = new AnimationRenderer().render(animationSpec(parsed, specSha), scene,
                    new AnimationRenderer.Profile(parsed.fpsNumerator(), parsed.fpsDenominator(), parsed.frameCount()));
        } catch (AnimationRenderer.RenderException failure) {
            throw new AnimationRefusedException(500, "ANIMATION_RENDER_FAILED", "the renderer failed; nothing was registered",
                    Map.of());
        } catch (IllegalArgumentException refused) {
            throw MediaDevAnimationSpec.invalid("$", refused.getMessage());
        }
        List<Map<String, Object>> frames = new ArrayList<>();
        StringBuilder frameSet = new StringBuilder();
        Path dir = privateTempDirectory();
        try {
            Path framesDir = Files.createDirectory(dir.resolve("frames"));
            for (AnimationRenderer.Frame frame : rendered.frames()) {
                byte[] png = frame.png();
                Files.write(framesDir.resolve(String.format(Locale.ROOT, "f%05d.png", frame.index())), png);
                String pngSha = MediaDevProjectRenderRuntime.sha256Hex(png);
                String pixelSha = pixelDigest(png);
                frameSet.append(frame.index()).append(':').append(pngSha).append(':').append(pixelSha).append('\n');
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("index", frame.index());
                entry.put("ptsNumerator", frame.ptsNumerator());
                entry.put("ptsDenominator", frame.ptsDenominator());
                entry.put("storyTicksNumerator", frame.storyTicksNumerator());
                entry.put("storyTicksDenominator", frame.storyTicksDenominator());
                entry.put("pngSha256", pngSha);
                entry.put("pixelSha256", pixelSha);
                entry.put("pngBytes", png.length);
                frames.add(entry);
            }
            String frameSetSha = MediaDevProjectRenderRuntime.sha256Hex(frameSet.toString());
            long timescale = timescale(parsed.fpsNumerator());
            long ticksPerFrame = timescale / parsed.fpsNumerator() * parsed.fpsDenominator();
            Path out = dir.resolve("out.mp4");
            List<String> command = new ArrayList<>(List.of(ffmpeg.toString(), "-nostdin", "-hide_banner", "-v", "error",
                    "-xerror", "-framerate", parsed.fpsNumerator() + "/" + parsed.fpsDenominator(), "-i",
                    framesDir.resolve("f%05d.png").toString(),
                    "-vf", "scale=out_color_matrix=" + COLOR_MATRIX + ":out_range=tv:flags=accurate_rnd+bitexact,format=yuv420p",
                    "-c:v", "libx264", "-preset", "medium", "-crf", Integer.toString(request.crf()), "-profile:v", "high",
                    "-bf", "0", "-threads", "1", "-colorspace", COLOR_MATRIX, "-color_primaries", COLOR_MATRIX,
                    "-color_trc", COLOR_MATRIX, "-color_range", "tv", "-movflags", "+faststart",
                    "-fflags", "+bitexact", "-flags:v", "+bitexact", "-map_metadata", "-1",
                    "-metadata", "comment=media.dev.animation request=" + request.requestId() + " spec=" + specSha,
                    "-video_track_timescale", Long.toString(timescale), "-fps_mode", "passthrough", "-an", "-y",
                    out.toString()));
            BoundedProcessRunner.Result result = BoundedProcessRunner.run(command, dir, Map.of(), ENCODE_TIMEOUT, 1024,
                    8192, BoundedProcessRunner.CancellationToken.NEVER, out, MAX_OUTPUT_BYTES);
            if (result.end() == BoundedProcessRunner.End.WATCHED_FILE_TOO_LARGE) {
                throw MediaDevAnimationSpec.budget("$", "encoded video bytes", MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES + 1);
            }
            classify(result, "encode", "ANIMATION_ENCODE_FAILED");
            Map<String, Object> verification = verify(out, dir, parsed, timescale, ticksPerFrame);
            for (Map<String, Object> entry : frames) {
                entry.put("ptsTicks", (long) (int) entry.get("index") * ticksPerFrame);
            }
            byte[] mp4 = Files.readAllBytes(out);
            return register(tenantId, principalId, request, parsed, specSha, frameSetSha, frames, verification, timescale,
                    assets, mp4);
        } catch (IOException failure) {
            throw new AnimationRefusedException(503, "ANIMATION_TOOLS_UNAVAILABLE",
                    "the video tools could not be run; nothing was registered", Map.of());
        } finally {
            deleteTree(dir);
        }
    }

    private static AnimationSpecCompiler.AnimationSpec animationSpec(MediaDevAnimationSpec.Parsed parsed, String specSha) {
        List<String> curves = new ArrayList<>();
        for (AnimationRenderer.Shape shape : parsed.shapes()) curves.add("curve:" + shape.id() + ":" + specSha);
        return new AnimationSpecCompiler.AnimationSpec(
                "media.declarative.value.animation-spec.v1",
                "scene:" + specSha,
                "animation:" + specSha,
                "operators:none",
                "assets:" + parsed.assets().size(),
                curves,
                new AnimationSpecCompiler.StoryTime("story", "dev-animation", "main", "origin:start", "0",
                        new AnimationSpecCompiler.PositiveRational("1", "1000")),
                "rendering:" + parsed.width() + "x" + parsed.height() + "@" + parsed.fpsNumerator() + "/"
                        + parsed.fpsDenominator() + "x" + parsed.frameCount());
    }

    /** Smallest multiple of the numerator that is at least 12800 ticks per second: exact integer ticks per frame. */
    static long timescale(int fpsNumerator) {
        return (long) fpsNumerator * ((12_800 + fpsNumerator - 1) / fpsNumerator);
    }

    private RasterAsset decodeAsset(String tenantId, String principalId, ResolvedAsset asset) {
        ByteArrayOutputStream content = new ByteArrayOutputStream((int) Math.max(1, asset.artifact().sizeBytes()));
        try {
            runtime.copyArtifactContent(tenantId, principalId, asset.artifact().artifactId(), asset.artifact().version(),
                    content, MAX_ASSET_BYTES).orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
        } catch (IOException unreadable) {
            throw new AnimationRefusedException(503, "ANIMATION_TOOLS_UNAVAILABLE",
                    "an asset could not be read; nothing was registered", Map.of("path", asset.ref().path()));
        }
        byte[] bytes = content.toByteArray();
        try (ImageInputStream input = ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
            Iterator<ImageReader> readers = ImageIO.getImageReaders(input);
            if (!readers.hasNext()) throw unsupported(asset, "the asset bytes are not a decodable image");
            ImageReader reader = readers.next();
            try {
                reader.setInput(input, true, true);
                long pixels = (long) reader.getWidth(0) * reader.getHeight(0);
                if (pixels > MAX_ASSET_PIXELS) {
                    throw MediaDevAnimationSpec.budget(asset.ref().path(), "asset pixels", MAX_ASSET_PIXELS, pixels);
                }
                BufferedImage image = reader.read(0);
                int width = image.getWidth();
                int height = image.getHeight();
                int[] argb = image.getRGB(0, 0, width, height, null, 0, width);
                image.flush();
                return new RasterAsset(asset.ref().id(), width, height, argb);
            } finally {
                reader.dispose();
            }
        } catch (IOException | RuntimeException failure) {
            if (failure instanceof AnimationRefusedException refused) throw refused;
            throw unsupported(asset, "the asset bytes are not a decodable image");
        }
    }

    private static AnimationRefusedException unsupported(ResolvedAsset asset, String message) {
        return new AnimationRefusedException(422, "ASSET_NOT_SUPPORTED", message, Map.of("path", asset.ref().path()));
    }

    // ------------------------------------------------------------------ verification

    /** Re-probes the MP4 and requires the exact count, rational frame rate, time base and per-frame PTS ticks. */
    private Map<String, Object> verify(Path file, Path dir, MediaDevAnimationSpec.Parsed parsed, long timescale,
                                       long ticksPerFrame) throws IOException {
        BoundedProcessRunner.Result probe = BoundedProcessRunner.run(List.of(ffprobe.toString(), "-v", "error",
                "-select_streams", "v:0", "-show_entries",
                "stream=codec_name,profile,pix_fmt,width,height,avg_frame_rate,r_frame_rate,time_base,start_pts,color_space:frame=pts",
                "-of", "json", file.toString()), dir, Map.of(), PROBE_TIMEOUT, 4 * 1024 * 1024, 8192,
                BoundedProcessRunner.CancellationToken.NEVER, null, 0);
        classify(probe, "probe", "ANIMATION_VERIFICATION_FAILED");
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
                throw new AnimationRefusedException(500, "ANIMATION_VERIFICATION_FAILED",
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
            if (unreadable instanceof AnimationRefusedException refused) throw refused;
            throw new AnimationRefusedException(500, "ANIMATION_VERIFICATION_FAILED",
                    "the encoded video could not be probed; nothing was registered", Map.of());
        }
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
            throw new AnimationOutcomeUnknownException(phase);
        }
        throw new AnimationRefusedException(422, failureCode,
                "the " + phase + " step failed; nothing was registered", Map.of());
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

    // ------------------------------------------------------------------ registration

    private Render register(String tenantId, String principalId, RenderRequest request,
                            MediaDevAnimationSpec.Parsed parsed, String specSha, String frameSetSha,
                            List<Map<String, Object>> frames, Map<String, Object> verification, long timescale,
                            List<ResolvedAsset> assets, byte[] mp4) {
        String mp4Sha = MediaDevProjectRenderRuntime.sha256Hex(mp4);
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
        rightsDecision.put("productionGrant", false);
        Map<String, Object> fps = Map.of("numerator", parsed.fpsNumerator(), "denominator", parsed.fpsDenominator());
        String claims = "DEV_ONLY deterministic 2D render: frames are the verified renderer's, the MP4 is a lossy YUV420 "
                + "H.264 encode of them. No quality, rights, approval or production claim";

        Map<String, Object> shared = new LinkedHashMap<>();
        shared.put("animationSchema", SCHEMA);
        shared.put("scope", "DEV_ONLY");
        shared.put("requestId", request.requestId());
        shared.put("specSha256", specSha);
        shared.put("frameSetSha256", frameSetSha);
        shared.put("frameCount", parsed.frameCount());
        shared.put("width", parsed.width());
        shared.put("height", parsed.height());
        shared.put("fps", fps);
        if (!assetRefs.isEmpty()) {
            shared.put("sources", assetRefs);
            shared.put("parent", assetRefs.getFirst()); // erasure and rights follow parent/sources to derived outputs
        }
        shared.put("encoder", encoder);
        shared.put("rightsDecision", rightsDecision);
        shared.put("claims", claims);

        Map<String, Object> videoLineage = new LinkedHashMap<>(shared);
        videoLineage.put("kind", KIND_VIDEO);
        videoLineage.put("resultSha256", mp4Sha);
        MediaArtifact video = registerOne(tenantId, principalId, "video", request.requestId(), mp4, "video/mp4", "mp4",
                "animation-" + MediaDevDubSupport.safeName(request.requestId()), videoLineage).artifact();

        Map<String, Object> manifest = new LinkedHashMap<>();
        manifest.put("schema", MANIFEST_SCHEMA);
        manifest.put("scope", "DEV_ONLY");
        manifest.put("requestId", request.requestId());
        manifest.put("specSha256", specSha);
        manifest.put("spec", parsed.canonical());
        manifest.put("video", MediaDevDubSupport.ref(video));
        Map<String, Object> profile = new LinkedHashMap<>();
        profile.put("width", parsed.width());
        profile.put("height", parsed.height());
        profile.put("fpsNumerator", parsed.fpsNumerator());
        profile.put("fpsDenominator", parsed.fpsDenominator());
        profile.put("frameCount", parsed.frameCount());
        profile.put("durationSecondsNumerator", Long.toString((long) parsed.frameCount() * parsed.fpsDenominator()));
        profile.put("durationSecondsDenominator", Integer.toString(parsed.fpsNumerator()));
        manifest.put("profile", profile);
        manifest.put("frames", frames);
        manifest.put("frameSetSha256", frameSetSha);
        manifest.put("frameSetDefinition", "SHA-256 over lines 'index:pngSha256:pixelSha256' (pixelSha256 = SHA-256 of the "
                + "big-endian ARGB ints of the decoded PNG)");
        manifest.put("encoder", encoder);
        manifest.put("verification", verification);
        manifest.put("assets", assetRefs);
        manifest.put("claims", claims);
        Map<String, Object> manifestLineage = new LinkedHashMap<>(shared);
        manifestLineage.put("kind", KIND_MANIFEST);
        manifestLineage.put("siblings", Map.of("video", MediaDevDubSupport.ref(video)));
        MediaArtifact manifestArtifact = registerOne(tenantId, principalId, "manifest", request.requestId(),
                MediaDevDubSupport.json(manifest), "application/json", "json",
                "animation-manifest-" + MediaDevDubSupport.safeName(request.requestId()), manifestLineage).artifact();
        return new Render(video, manifestArtifact, manifest, videoLineage, false);
    }

    private MediaDevDubSupport.Output registerOne(String tenantId, String principalId, String role, String requestId,
                                                  byte[] bytes, String contentType, String extension, String namePrefix,
                                                  Map<String, Object> lineage) {
        String sha256 = MediaDevProjectRenderRuntime.sha256Hex(bytes);
        Map<String, Object> metadata = new LinkedHashMap<>(lineage);
        metadata.put("purpose", "animation-render-output");
        UploadRequest upload = new UploadRequest(tenantId, principalId, namePrefix + "." + extension, contentType,
                bytes.length, sha256, "INTERNAL", Duration.ofDays(30), metadata);
        String idempotencyKey = "dev-anim:" + role + ":" + MediaDevProjectRenderRuntime.sha256Hex(
                tenantId + "\u0000" + principalId + "\u0000" + requestId);
        MediaDevProjectRenderRuntime.Registered registered;
        try {
            registered = registrar.register(tenantId, principalId, upload, idempotencyKey, bytes);
        } catch (IllegalArgumentException conflict) {
            if (conflict.getMessage() != null && conflict.getMessage().contains("Idempotency-Key")) {
                throw new AnimationRequestReusedException();
            }
            throw new AnimationRegistrationFailedException(conflict);
        } catch (RuntimeException failure) {
            throw new AnimationRegistrationFailedException(failure);
        }
        MediaArtifact artifact = registered.artifact();
        if (!artifact.sha256().equals(sha256)) {
            throw new AnimationRegistrationFailedException(
                    new IllegalStateException("registered artifact digest does not match produced bytes"));
        }
        return new MediaDevDubSupport.Output(artifact, lineage, registered.replayed());
    }

    // ------------------------------------------------------------------ helpers

    /** SHA-256 of the big-endian ARGB ints of the decoded PNG; also proves the frame decodes. */
    private static String pixelDigest(byte[] png) {
        try {
            BufferedImage image = ImageIO.read(new ByteArrayInputStream(png));
            if (image == null) throw new AnimationRefusedException(500, "ANIMATION_RENDER_FAILED",
                    "a rendered frame is not a decodable PNG; nothing was registered", Map.of());
            try {
                int width = image.getWidth();
                int height = image.getHeight();
                int[] argb = image.getRGB(0, 0, width, height, null, 0, width);
                ByteBuffer buffer = ByteBuffer.allocate(argb.length * 4);
                for (int value : argb) buffer.putInt(value);
                return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(buffer.array()));
            } finally {
                image.flush();
            }
        } catch (IOException | NoSuchAlgorithmException failure) {
            throw new AnimationRefusedException(500, "ANIMATION_RENDER_FAILED",
                    "a rendered frame could not be decoded; nothing was registered", Map.of());
        }
    }

    private static String canonicalJson(Object value) {
        try {
            return JSON.writeValueAsString(value);
        } catch (RuntimeException failure) {
            throw new IllegalStateException("animation spec could not be serialized", failure);
        }
    }

    private static Path privateTempDirectory() {
        try {
            return Files.createTempDirectory("media-dev-animation-",
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
