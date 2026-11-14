package com.ghatana.media.launcher;

import com.ghatana.media.production.AnimationSpecCompiler;
import com.ghatana.media.production.animation.AnimationRenderer;
import com.ghatana.media.production.rendering.FfmpegMultitrackRenderer;
import com.ghatana.media.production.rendering.MultitrackRenderPlanner;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Clip;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Revision;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.TimelineSnapshot;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Track;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.TrackKind;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadSession;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadStatus;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * DEV_ONLY project-to-media-output workflow: reads one exact immutable project revision, resolves every
 * referenced source image at its exact artifact version, renders a deterministic storyboard animation with
 * the existing {@link AnimationRenderer}, and registers the decoded-output bytes as an immutable Media
 * artifact through the durable idempotent upload path with full source lineage.
 *
 * <p>The render is a pure function of (revision graph, exact source bytes, profile). A retry with the same
 * requestId after a crash therefore re-derives identical bytes and resumes the same durable upload session;
 * a reused requestId with a different payload is rejected by the upload idempotency fingerprint.
 * Only still images (PNG/GIF/JPEG first frame) on VIDEO or OVERLAY tracks are supported; audio, caption and
 * time-based video sources are a typed {@link RenderNotSupportedException}, never silently dropped.
 */
public final class MediaDevProjectRenderRuntime {
    public static final String RENDER_SCHEMA = "media.dev.project-render.v1";
    public static final String ENGINE = "production.animation.AnimationRenderer/gif";
    public static final String MP4_ENGINE = "production.rendering.FfmpegMultitrackRenderer/mp4";
    static final int MAX_SOURCE_BYTES = 8 * 1024 * 1024;
    static final int MAX_SOURCE_DIMENSION = 2_048;
    static final int MAX_CLIPS = 64;
    private static final Set<String> SUPPORTED_SOURCE_TYPES = Set.of("image/png", "image/gif", "image/jpeg");
    /** Lineage fields; store-added artifact metadata (classification, retention, ...) is not lineage. */
    private static final List<String> LINEAGE_KEYS = List.of("renderSchema", "scope", "engine", "projectId",
            "revisionId", "timelineId", "timelineSemanticVersionId", "requestId", "width", "height",
            "framesPerSecond", "frameCount", "sources", "format", "encoding", "audioMix");
    private static final Set<TrackKind> VISUAL_TRACKS = Set.of(TrackKind.VIDEO, TrackKind.OVERLAY);

    /** Port onto the canonical artifact registration path; replaceable only for failure-injection tests. */
    interface OutputRegistrar {
        Registered register(String tenantId, String principalId, UploadRequest request,
                            String idempotencyKey, byte[] bytes);
    }

    /** Registered artifact and whether a durable completed registration already existed for this request. */
    record Registered(MediaArtifact artifact, boolean replayed) {
        Registered { Objects.requireNonNull(artifact, "artifact"); }
    }

    /** Output container: deterministic GIF storyboard, or a verified H.264/AAC MP4 through FFmpeg. */
    public enum Format { GIF, MP4 }

    /** Request for one render of one timeline at one exact revision. */
    public record RenderRequest(String requestId, String revisionId, String timelineId,
                                int width, int height, int framesPerSecond, Format format) {
        public RenderRequest(String requestId, String revisionId, String timelineId,
                             int width, int height, int framesPerSecond) {
            this(requestId, revisionId, timelineId, width, height, framesPerSecond, Format.GIF);
        }

        public RenderRequest {
            Objects.requireNonNull(format, "format");
            requestId = boundedId(requestId, "requestId");
            revisionId = boundedId(revisionId, "revisionId");
            timelineId = boundedId(timelineId, "timelineId");
            if (width < 1 || width > AnimationRenderer.MAX_WIDTH || height < 1 || height > AnimationRenderer.MAX_HEIGHT) {
                throw new IllegalArgumentException("render dimensions must be within [1, 2048]");
            }
            if (framesPerSecond < 1 || framesPerSecond > 100 || 100 % framesPerSecond != 0) {
                throw new IllegalArgumentException("framesPerSecond must divide 100 so the GIF clock is exact");
            }
        }
    }

    /** Durable view of a registered render output, reconstructible from the artifact alone after restart. */
    public record RenderResult(MediaArtifact artifact, Map<String, Object> lineage, boolean replayed) { }

    public static final class RenderNotSupportedException extends IllegalArgumentException {
        private final String code;
        RenderNotSupportedException(String code, String message) { super(message); this.code = code; }
        public String code() { return code; }
    }

    public static final class SourceVersionUnavailableException extends SecurityException {
        SourceVersionUnavailableException() {
            super("an exact source artifact version is not available to this principal");
        }
    }

    public static final class RenderRegistrationFailedException extends IllegalStateException {
        RenderRegistrationFailedException(Throwable cause) {
            super("rendered output could not be registered as an immutable artifact", cause);
        }
    }

    /** The configured MP4 codec pipeline is absent, not admitted or its tools are not runnable. */
    public static final class RenderCodecUnavailableException extends IllegalStateException {
        RenderCodecUnavailableException(String message) { super(message); }
    }

    /** The codec process ran but produced no verified output (timeout, crash, verification failure). */
    public static final class RenderExecutionFailedException extends IllegalStateException {
        private final String reason;
        RenderExecutionFailedException(String reason) {
            super("render execution did not produce a verified output: " + reason);
            this.reason = reason;
        }
        public String reason() { return reason; }
    }

    public static final String FFMPEG_ENV = "MEDIA_DEV_RENDER_FFMPEG";
    public static final String FFPROBE_ENV = "MEDIA_DEV_RENDER_FFPROBE";
    static final long MAX_MP4_OUTPUT_BYTES = 64L * 1024 * 1024;
    static final int MAX_AUDIO_SOURCE_BYTES = 64 * 1024 * 1024;

    private final MediaRuntime runtime;
    private final MediaDevProjectTimelineRuntime projects;
    private final OutputRegistrar registrar;
    private final FfmpegMultitrackRenderer mp4Renderer;

    MediaDevProjectRenderRuntime(MediaRuntime runtime, MediaDevProjectTimelineRuntime projects) {
        this(runtime, projects, canonicalRegistrar(runtime), null);
    }

    MediaDevProjectRenderRuntime(MediaRuntime runtime, MediaDevProjectTimelineRuntime projects,
                                 OutputRegistrar registrar) {
        this(runtime, projects, registrar, null);
    }

    MediaDevProjectRenderRuntime(MediaRuntime runtime, MediaDevProjectTimelineRuntime projects,
                                 OutputRegistrar registrar, FfmpegMultitrackRenderer mp4Renderer) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.projects = Objects.requireNonNull(projects, "projects");
        this.registrar = Objects.requireNonNull(registrar, "registrar");
        this.mp4Renderer = mp4Renderer;
    }

    /**
     * Builds the DEV_ONLY MP4 pipeline from explicit absolute tool paths. Absent configuration yields null so MP4
     * requests return a typed unavailable result; tool paths are never resolved through PATH.
     */
    static FfmpegMultitrackRenderer mp4RendererFrom(Map<String, String> environment) {
        String ffmpeg = environment.get(FFMPEG_ENV);
        String ffprobe = environment.get(FFPROBE_ENV);
        if (ffmpeg == null || ffmpeg.isBlank() || ffprobe == null || ffprobe.isBlank()) return null;
        java.nio.file.Path ffmpegPath = java.nio.file.Path.of(ffmpeg);
        java.nio.file.Path ffprobePath = java.nio.file.Path.of(ffprobe);
        if (!ffmpegPath.isAbsolute() || !ffprobePath.isAbsolute()) {
            throw new IllegalArgumentException(FFMPEG_ENV + " and " + FFPROBE_ENV + " must be absolute paths");
        }
        java.nio.file.Path tempRoot = java.nio.file.Path.of(System.getProperty("java.io.tmpdir")).toAbsolutePath();
        return new FfmpegMultitrackRenderer(new FfmpegMultitrackRenderer.Config(ffmpegPath, ffprobePath, tempRoot,
                Map.of(), Duration.ofSeconds(10), Duration.ofMinutes(2), true));
    }

    public RenderResult render(String tenantId, String principalId, String projectId, RenderRequest request) {
        Objects.requireNonNull(request, "request");
        // Owner-scoped exact revision read; ProjectNotFound/AccessDenied propagate unchanged.
        Revision revision = projects.revision(tenantId, principalId, projectId, request.revisionId());
        TimelineSnapshot timeline = revision.timelines().stream()
                .filter(snapshot -> snapshot.timelineId().equals(request.timelineId()))
                .findFirst()
                .orElseThrow(() -> new RenderNotSupportedException("TIMELINE_NOT_FOUND",
                        "timeline is not part of the requested revision"));
        Map<String, Track> tracks = new LinkedHashMap<>();
        for (Track track : timeline.graph().tracks()) tracks.put(track.trackId(), track);
        List<Clip> clips = timeline.graph().clips();
        if (clips.isEmpty()) {
            throw new RenderNotSupportedException("RENDER_EMPTY_TIMELINE", "timeline has no clips to render");
        }
        if (clips.size() > MAX_CLIPS) {
            throw new RenderNotSupportedException("RENDER_LIMIT_EXCEEDED", "timeline exceeds the clip ceiling");
        }
        if (request.format() == Format.MP4) {
            return renderMp4(tenantId, principalId, projectId, revision, timeline, tracks, clips, request);
        }
        for (Clip clip : clips) {
            if (!VISUAL_TRACKS.contains(tracks.get(clip.trackId()).kind())) {
                throw new RenderNotSupportedException("TRACK_KIND_NOT_SUPPORTED",
                        "only VIDEO and OVERLAY still-image clips are supported by this DEV_ONLY renderer");
            }
        }

        int fps = request.framesPerSecond();
        int frameCount = 0;
        List<int[]> windows = new ArrayList<>(clips.size());
        for (Clip clip : clips) {
            int start = frameFloor(clip.storyStart(), fps);
            int end = frameCeil(clip.storyEnd(), fps);
            if (end <= start) end = start + 1;
            if (end > AnimationRenderer.MAX_FRAMES) {
                throw new RenderNotSupportedException("RENDER_LIMIT_EXCEEDED",
                        "timeline story duration exceeds the " + AnimationRenderer.MAX_FRAMES + "-frame ceiling");
            }
            windows.add(new int[] {start, end});
            frameCount = Math.max(frameCount, end);
        }

        List<AnimationRenderer.RasterAsset> assets = new ArrayList<>();
        List<AnimationRenderer.Shape> shapes = new ArrayList<>();
        List<Map<String, Object>> sources = new ArrayList<>();
        Map<String, AnimationRenderer.RasterAsset> assetBySource = new LinkedHashMap<>();
        for (int index = 0; index < clips.size(); index++) {
            Clip clip = clips.get(index);
            String sourceKey = clip.source().artifactId() + "@" + clip.source().artifactVersionId();
            AnimationRenderer.RasterAsset asset = assetBySource.get(sourceKey);
            if (asset == null) {
                asset = decodeSource(tenantId, principalId, clip, "asset-" + assetBySource.size());
                assetBySource.put(sourceKey, asset);
                assets.add(asset);
            }
            int[] window = windows.get(index);
            shapes.add(new AnimationRenderer.Shape("clip-" + index, AnimationRenderer.Primitive.RASTER_ASSET,
                    0, 0, request.width(), request.height(), 0, 0xffffffff,
                    visibility(window[0], window[1], frameCount), asset.id()));
            Map<String, Object> source = new LinkedHashMap<>();
            source.put("clipId", clip.clipId());
            source.put("trackId", clip.trackId());
            source.put("artifactId", clip.source().artifactId());
            source.put("artifactVersionId", clip.source().artifactVersionId());
            source.put("startFrame", window[0]);
            source.put("endFrameExclusive", window[1]);
            sources.add(source);
        }

        AnimationRenderer.Scene scene;
        try {
            scene = new AnimationRenderer.Scene(request.width(), request.height(), 0xff000000, shapes, List.of(), assets);
        } catch (IllegalArgumentException limit) {
            throw new RenderNotSupportedException("RENDER_LIMIT_EXCEEDED", "render exceeds a renderer ceiling");
        }
        String revisionRef = "project/" + projectId + "@" + revision.revisionId();
        String timelineRef = "timeline/" + timeline.timelineId() + "@" + timeline.semanticVersionId();
        AnimationSpecCompiler.AnimationSpec spec = new AnimationSpecCompiler.AnimationSpec(
                "media.declarative.value.animation-spec.v1", revisionRef, timelineRef,
                "operators/storyboard-still@v1", "assets/" + sha256Hex(String.join(",", assetBySource.keySet())) + "@v1",
                List.of(), new AnimationSpecCompiler.StoryTime("story", "timeline-story", "render-preview",
                        timelineRef, "0", new AnimationSpecCompiler.PositiveRational("1", Integer.toString(fps))),
                "render/gif@v1");
        AnimationRenderer.AnimationExport export;
        try {
            export = new AnimationRenderer().renderAnimated(spec, scene,
                    new AnimationRenderer.Profile(fps, 1, frameCount), AnimationRenderer.AnimatedFormat.GIF);
        } catch (IllegalArgumentException limit) {
            throw new RenderNotSupportedException("RENDER_LIMIT_EXCEEDED", "render exceeds a renderer ceiling");
        }
        AnimationRenderer.EncodedAnimation encoded = export.encoded().orElseThrow(() ->
                new RenderNotSupportedException("RENDER_CODEC_UNAVAILABLE",
                        "GIF encoding is unavailable: " + export.status()));
        byte[] bytes = encoded.bytes();

        Map<String, Object> lineage = baseLineage(projectId, revision, timeline, request);
        lineage.put("framesPerSecond", fps);
        lineage.put("frameCount", frameCount);
        lineage.put("sources", sources);
        lineage.put("format", "gif");
        return registerOutput(tenantId, principalId, projectId, revision, request, bytes, encoded.sha256(),
                "image/gif", "gif", lineage);
    }

    private static Map<String, Object> baseLineage(String projectId, Revision revision, TimelineSnapshot timeline,
                                                   RenderRequest request) {
        Map<String, Object> lineage = new LinkedHashMap<>();
        lineage.put("renderSchema", RENDER_SCHEMA);
        lineage.put("scope", "DEV_ONLY");
        lineage.put("engine", request.format() == Format.MP4 ? MP4_ENGINE : ENGINE);
        lineage.put("projectId", projectId);
        lineage.put("revisionId", revision.revisionId());
        lineage.put("timelineId", timeline.timelineId());
        lineage.put("timelineSemanticVersionId", timeline.semanticVersionId());
        lineage.put("requestId", request.requestId());
        lineage.put("width", request.width());
        lineage.put("height", request.height());
        return lineage;
    }

    private RenderResult registerOutput(String tenantId, String principalId, String projectId, Revision revision,
                                        RenderRequest request, byte[] bytes, String sha256, String contentType,
                                        String extension, Map<String, Object> lineage) {
        Map<String, Object> metadata = new LinkedHashMap<>(lineage);
        metadata.put("purpose", "project-render");
        UploadRequest upload = new UploadRequest(tenantId, principalId,
                "render-" + revision.revisionId().replaceAll("[^A-Za-z0-9._-]", "_") + "." + extension,
                contentType, bytes.length, sha256, "INTERNAL", Duration.ofDays(30), metadata);
        String idempotencyKey = "dev-render:" + sha256Hex(
                tenantId + "\u0000" + principalId + "\u0000" + projectId + "\u0000" + request.requestId());
        Registered registered;
        try {
            registered = registrar.register(tenantId, principalId, upload, idempotencyKey, bytes);
        } catch (IllegalArgumentException conflict) {
            if (conflict.getMessage() != null && conflict.getMessage().contains("Idempotency-Key")) {
                throw new IllegalStateException("render requestId was already used for a different render", conflict);
            }
            throw new RenderRegistrationFailedException(conflict);
        } catch (RuntimeException failure) {
            throw new RenderRegistrationFailedException(failure);
        }
        MediaArtifact artifact = registered.artifact();
        if (!artifact.sha256().equals(sha256)) {
            throw new RenderRegistrationFailedException(
                    new IllegalStateException("registered artifact digest does not match rendered bytes"));
        }
        return new RenderResult(artifact, lineage, registered.replayed());
    }

    /**
     * MP4 path: each VIDEO still clip becomes exactly one frame held for its story duration (normalized to the
     * requested even geometry). A single WAV clip on an AUDIO track starting at story time 0 becomes the AAC track
     * directly; any other AUDIO layout (several clips on any AUDIO tracks, overlapping or not, or a single clip not
     * starting at 0) is placed exactly and mixed by {@link MediaDevProjectAudioMix} into one timeline-length 16-bit
     * stereo WAV that becomes the AAC track, with each clip's exact version, offset and gain in lineage. The bounded FFmpeg renderer verifies the result with ffprobe before any registration.
     */
    private RenderResult renderMp4(String tenantId, String principalId, String projectId, Revision revision,
                                   TimelineSnapshot timeline, Map<String, Track> tracks, List<Clip> clips,
                                   RenderRequest request) {
        if (mp4Renderer == null) {
            throw new RenderCodecUnavailableException("MP4 rendering requires " + FFMPEG_ENV + " and " + FFPROBE_ENV);
        }
        if (request.width() % 2 != 0 || request.height() % 2 != 0) {
            throw new RenderNotSupportedException("RENDER_UNSUPPORTED_FRAME_GEOMETRY",
                    "MP4 rendering requires even width and height");
        }
        List<MultitrackRenderPlanner.Clip> planClips = new ArrayList<>();
        Map<String, byte[]> videoFrames = new LinkedHashMap<>();
        Map<String, byte[]> audio = new LinkedHashMap<>();
        List<MediaDevProjectAudioMix.Input> audioInputs = new ArrayList<>();
        List<MultitrackRenderPlanner.Clip> audioPlanClips = new ArrayList<>();
        List<Map<String, Object>> sources = new ArrayList<>();
        for (Clip clip : clips) {
            TrackKind kind = tracks.get(clip.trackId()).kind();
            MultitrackRenderPlanner.Time timelineStart = seconds(clip.storyStart());
            MultitrackRenderPlanner.Time duration = seconds(clip.storyDuration());
            Map<String, Object> source = new LinkedHashMap<>();
            source.put("clipId", clip.clipId());
            source.put("trackId", clip.trackId());
            source.put("trackKind", kind.name());
            source.put("artifactId", clip.source().artifactId());
            source.put("artifactVersionId", clip.source().artifactVersionId());
            if (kind == TrackKind.VIDEO) {
                byte[] frame = normalizedFrame(tenantId, principalId, clip, request.width(), request.height());
                String digest = sha256Hex(frame);
                videoFrames.put(clip.clipId(), frame);
                MultitrackRenderPlanner.Time zero = new MultitrackRenderPlanner.Time(0, 1);
                planClips.add(new MultitrackRenderPlanner.Clip(clip.clipId(), MultitrackRenderPlanner.Modality.VIDEO,
                        clip.source().artifactId(), clip.source().artifactVersionId(), digest, timelineStart,
                        zero, duration, List.of(zero)));
                source.put("normalizedFrameSha256", digest);
            } else if (kind == TrackKind.AUDIO) {
                MediaArtifact artifact = exactSource(tenantId, principalId, clip);
                String contentType = artifact.contentType().toLowerCase(Locale.ROOT);
                if (!Set.of("audio/wav", "audio/x-wav", "audio/wave").contains(contentType)) {
                    throw new RenderNotSupportedException("SOURCE_FORMAT_NOT_SUPPORTED",
                            "only 16-bit PCM WAV audio sources are supported for MP4 rendering");
                }
                MultitrackRenderPlanner.Time sourceStart = seconds(clip.sourceIn());
                MultitrackRenderPlanner.Time sourceEnd = seconds(clip.sourceOut());
                if (sourceEnd.minus(sourceStart).compareTo(duration) != 0) {
                    throw new RenderNotSupportedException("RENDER_UNSUPPORTED_AUDIO_LAYOUT",
                            "audio clips must not be retimed: source interval must equal story duration");
                }
                byte[] wavBytes = readExact(tenantId, principalId, artifact, MAX_AUDIO_SOURCE_BYTES);
                audio.put(clip.clipId(), wavBytes);
                audioInputs.add(new MediaDevProjectAudioMix.Input(clip.clipId(), clip.source().artifactId(),
                        clip.source().artifactVersionId(), artifact.sha256(), wavBytes, sourceStart, timelineStart,
                        duration));
                audioPlanClips.add(new MultitrackRenderPlanner.Clip(clip.clipId(), MultitrackRenderPlanner.Modality.AUDIO,
                        clip.source().artifactId(), clip.source().artifactVersionId(), artifact.sha256(),
                        timelineStart, sourceStart, sourceEnd, List.of(sourceStart)));
            } else {
                throw new RenderNotSupportedException("TRACK_KIND_NOT_SUPPORTED",
                        "MP4 rendering supports VIDEO still-image and AUDIO WAV clips only");
            }
            sources.add(source);
        }
        Map<String, Object> audioMixLineage = null;
        if (audioInputs.size() == 1 && audioInputs.get(0).storyStart().numerator() == 0) {
            planClips.addAll(audioPlanClips);
        } else if (!audioInputs.isEmpty()) {
            MultitrackRenderPlanner.Time end = new MultitrackRenderPlanner.Time(0, 1);
            for (MultitrackRenderPlanner.Clip planClip : planClips) {
                if (planClip.timelineEnd().compareTo(end) > 0) end = planClip.timelineEnd();
            }
            for (MediaDevProjectAudioMix.Input in : audioInputs) {
                MultitrackRenderPlanner.Time clipEnd = in.storyStart().plus(in.duration());
                if (clipEnd.compareTo(end) > 0) end = clipEnd;
            }
            MediaDevProjectAudioMix.Result mixed = MediaDevProjectAudioMix.mix(audioInputs, end);
            audio.clear();
            audio.put("audio-mix", mixed.wav());
            MultitrackRenderPlanner.Time zero = new MultitrackRenderPlanner.Time(0, 1);
            planClips.add(new MultitrackRenderPlanner.Clip("audio-mix", MultitrackRenderPlanner.Modality.AUDIO,
                    "dev-audio-mix", "sha256-" + mixed.wavSha256(), mixed.wavSha256(), zero, zero, end, List.of(zero)));
            audioMixLineage = mixed.lineage();
        }
        MultitrackRenderPlanner.PlanResult planned;
        try {
            planned = MultitrackRenderPlanner.plan(new MultitrackRenderPlanner.Graph(
                    planClips, List.of(), List.of(), MAX_MP4_OUTPUT_BYTES));
        } catch (IllegalArgumentException invalid) {
            throw new RenderNotSupportedException("RENDER_UNSUPPORTED_TIMELINE", "timeline is not a valid render graph");
        }
        if (planned.outcome() != MultitrackRenderPlanner.Outcome.PLAN_READY) {
            throw new RenderNotSupportedException("RENDER_UNSUPPORTED_TIMELINE", "render plan was not produced");
        }
        FfmpegMultitrackRenderer.SourceProvider provider = new FfmpegMultitrackRenderer.SourceProvider() {
            @Override public List<byte[]> readVideoFrames(FfmpegMultitrackRenderer.ClipSource clip) throws IOException {
                byte[] frame = videoFrames.get(clip.clipId());
                if (frame == null) throw new IOException("unknown video clip");
                return List.of(frame);
            }
            @Override public byte[] readAudio(FfmpegMultitrackRenderer.ClipSource clip) throws IOException {
                byte[] bytes = audio.get(clip.clipId());
                if (bytes == null) throw new IOException("unknown audio clip");
                return bytes;
            }
        };
        java.nio.file.Path outputDirectory = null;
        try {
            outputDirectory = java.nio.file.Files.createTempDirectory("media-dev-render-");
            FfmpegMultitrackRenderer.Result result = mp4Renderer.render(planned.plan(), provider, outputDirectory, null);
            switch (result.outcome()) {
                case COMPLETED -> { }
                case UNSUPPORTED -> throw new RenderNotSupportedException("RENDER_" + result.reason().name(),
                        "timeline uses a feature the MP4 renderer does not support exactly");
                case NOT_ADMITTED, UNAVAILABLE -> throw new RenderCodecUnavailableException(
                        "MP4 codec pipeline is unavailable: " + result.reason());
                default -> throw new RenderExecutionFailedException(String.valueOf(result.reason()));
            }
            byte[] bytes = java.nio.file.Files.readAllBytes(result.outputPath());
            if (!sha256Hex(bytes).equals(result.outputSha256())) {
                throw new RenderExecutionFailedException("OUTPUT_DIGEST_CHANGED");
            }
            FfmpegMultitrackRenderer.Verification verification = result.verification();
            Map<String, Object> encoding = new LinkedHashMap<>();
            encoding.put("manifestSha256", planned.plan().manifestSha256());
            encoding.put("videoCodec", verification.videoCodec());
            encoding.put("audioCodec", verification.audioCodec() == null ? "none" : verification.audioCodec());
            encoding.put("videoFrameCount", verification.videoFrameCount());
            encoding.put("videoPtsExact", verification.videoPtsExact());
            encoding.put("streamCount", verification.streamCount());
            encoding.put("expectedDurationSeconds", verification.expectedDurationSeconds());
            encoding.put("ffmpegVersion", result.ffmpegVersion());
            encoding.put("ffprobeVersion", result.ffprobeVersion());
            Map<String, Object> lineage = baseLineage(projectId, revision, timeline, request);
            lineage.put("sources", sources);
            lineage.put("format", "mp4");
            lineage.put("encoding", encoding);
            if (audioMixLineage != null) lineage.put("audioMix", audioMixLineage);
            return registerOutput(tenantId, principalId, projectId, revision, request, bytes, result.outputSha256(),
                    "video/mp4", "mp4", lineage);
        } catch (IOException failure) {
            throw new RenderExecutionFailedException("IO_ERROR");
        } finally {
            deleteQuietly(outputDirectory);
        }
    }

    private static MultitrackRenderPlanner.Time seconds(
            com.ghatana.media.runtime.MediaProjectTimelineContracts.RationalTime time) {
        // seconds = ticks * rateDenominator / rateNumerator
        return new MultitrackRenderPlanner.Time(
                Math.multiplyExact(time.ticks(), time.rateDenominator()), time.rateNumerator());
    }

    private byte[] normalizedFrame(String tenantId, String principalId, Clip clip, int width, int height) {
        AnimationRenderer.RasterAsset asset = decodeSource(tenantId, principalId, clip, "frame");
        BufferedImage source = new BufferedImage(asset.width(), asset.height(), BufferedImage.TYPE_INT_ARGB);
        source.setRGB(0, 0, asset.width(), asset.height(), asset.argbPixels(), 0, asset.width());
        BufferedImage frame = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        java.awt.Graphics2D graphics = frame.createGraphics();
        try {
            graphics.setRenderingHint(java.awt.RenderingHints.KEY_INTERPOLATION,
                    java.awt.RenderingHints.VALUE_INTERPOLATION_NEAREST_NEIGHBOR);
            graphics.drawImage(source, 0, 0, width, height, null);
        } finally {
            graphics.dispose();
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try {
            if (!ImageIO.write(frame, "png", out)) throw new IOException("PNG encoder unavailable");
        } catch (IOException failure) {
            throw new RenderExecutionFailedException("FRAME_ENCODING_FAILED");
        }
        return out.toByteArray();
    }

    private MediaArtifact exactSource(String tenantId, String principalId, Clip clip) {
        return runtime.artifact(tenantId, principalId, clip.source().artifactId())
                .filter(found -> found.version().value().equals(clip.source().artifactVersionId()))
                .orElseThrow(SourceVersionUnavailableException::new);
    }

    private byte[] readExact(String tenantId, String principalId, MediaArtifact artifact, int maxBytes) {
        if (artifact.sizeBytes() > maxBytes) {
            throw new RenderNotSupportedException("RENDER_LIMIT_EXCEEDED", "source exceeds the byte ceiling");
        }
        ByteArrayOutputStream staged = new ByteArrayOutputStream((int) artifact.sizeBytes());
        try {
            runtime.copyArtifactContent(tenantId, principalId, artifact.artifactId(), artifact.version(),
                    staged, maxBytes).orElseThrow(SourceVersionUnavailableException::new);
        } catch (IOException failure) {
            throw new IllegalStateException("source artifact content could not be read", failure);
        }
        return staged.toByteArray();
    }

    private static void deleteQuietly(java.nio.file.Path directory) {
        if (directory == null) return;
        try (var paths = java.nio.file.Files.walk(directory)) {
            paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                try { java.nio.file.Files.deleteIfExists(path); } catch (IOException ignored) { }
            });
        } catch (IOException ignored) {
            // best effort: the renderer's own private temp directory is already cleaned
        }
    }

    /** Reopens a registered render for its owner; anything that is not this project's render is absent. */
    public Optional<RenderResult> reopen(String tenantId, String principalId, String projectId, String artifactId) {
        projects.project(tenantId, principalId, projectId);
        return runtime.artifact(tenantId, principalId, artifactId)
                .filter(artifact -> RENDER_SCHEMA.equals(artifact.metadata().get("renderSchema"))
                        && projectId.equals(artifact.metadata().get("projectId")))
                .map(artifact -> {
                    Map<String, Object> lineage = new LinkedHashMap<>();
                    for (String key : LINEAGE_KEYS) {
                        if (artifact.metadata().containsKey(key)) lineage.put(key, artifact.metadata().get(key));
                    }
                    return new RenderResult(artifact, lineage, true);
                });
    }

    private AnimationRenderer.RasterAsset decodeSource(String tenantId, String principalId, Clip clip, String assetId) {
        MediaArtifact artifact = exactSource(tenantId, principalId, clip);
        String contentType = artifact.contentType().toLowerCase(Locale.ROOT);
        if (!SUPPORTED_SOURCE_TYPES.contains(contentType)) {
            throw new RenderNotSupportedException("SOURCE_FORMAT_NOT_SUPPORTED",
                    "only PNG, GIF and JPEG still-image sources are supported");
        }
        if (artifact.sizeBytes() > MAX_SOURCE_BYTES) {
            throw new RenderNotSupportedException("RENDER_LIMIT_EXCEEDED", "source image exceeds the byte ceiling");
        }
        ByteArrayOutputStream staged = new ByteArrayOutputStream((int) artifact.sizeBytes());
        try {
            runtime.copyArtifactContent(tenantId, principalId, artifact.artifactId(), artifact.version(),
                    staged, MAX_SOURCE_BYTES).orElseThrow(SourceVersionUnavailableException::new);
        } catch (IOException failure) {
            throw new IllegalStateException("source artifact content could not be read", failure);
        }
        BufferedImage image = boundedDecode(staged.toByteArray());
        int width = image.getWidth();
        int height = image.getHeight();
        int[] pixels = image.getRGB(0, 0, width, height, null, 0, width);
        return new AnimationRenderer.RasterAsset(assetId, width, height, pixels);
    }

    /** Reads dimensions from the header before allocating a raster, so a decompression bomb is refused cheaply. */
    static BufferedImage boundedDecode(byte[] bytes) {
        try (ImageInputStream input = ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
            Iterator<ImageReader> readers = input == null ? java.util.Collections.emptyIterator()
                    : ImageIO.getImageReaders(input);
            if (!readers.hasNext()) {
                throw new RenderNotSupportedException("SOURCE_NOT_DECODABLE", "source image is not decodable");
            }
            ImageReader reader = readers.next();
            try {
                reader.setInput(input, true, true);
                int width = reader.getWidth(0);
                int height = reader.getHeight(0);
                if (width < 1 || height < 1 || width > MAX_SOURCE_DIMENSION || height > MAX_SOURCE_DIMENSION
                        || (long) width * height > AnimationRenderer.MAX_ASSET_PIXELS) {
                    throw new RenderNotSupportedException("RENDER_LIMIT_EXCEEDED",
                            "source image dimensions exceed the decode ceiling");
                }
                BufferedImage image = reader.read(0);
                if (image == null) {
                    throw new RenderNotSupportedException("SOURCE_NOT_DECODABLE", "source image is not decodable");
                }
                return image;
            } finally {
                reader.dispose();
            }
        } catch (IOException | RuntimeException failure) {
            if (failure instanceof RenderNotSupportedException typed) throw typed;
            throw new RenderNotSupportedException("SOURCE_NOT_DECODABLE", "source image is not decodable");
        }
    }

    /** Hard on/off opacity steps at exact frame boundaries; linear easing between adjacent frames is a step. */
    static List<AnimationRenderer.Keyframe> visibility(int start, int end, int frameCount) {
        List<AnimationRenderer.Keyframe> keys = new ArrayList<>(4);
        if (start > 0) keys.add(key(start - 1, 0));
        keys.add(key(start, 1));
        if (end - 1 > start) keys.add(key(end - 1, 1));
        if (end < frameCount) keys.add(key(end, 0));
        return keys;
    }

    private static AnimationRenderer.Keyframe key(int frame, double opacity) {
        return new AnimationRenderer.Keyframe(frame, 0, 0, 1, 1, 0, opacity, AnimationRenderer.Easing.LINEAR);
    }

    /** floor(seconds * fps) using exact rational arithmetic. */
    static int frameFloor(com.ghatana.media.runtime.MediaProjectTimelineContracts.RationalTime time, int fps) {
        BigInteger[] division = scaled(time, fps);
        return clampFrame(division[0]);
    }

    /** ceil(seconds * fps) using exact rational arithmetic. */
    static int frameCeil(com.ghatana.media.runtime.MediaProjectTimelineContracts.RationalTime time, int fps) {
        BigInteger[] division = scaled(time, fps);
        BigInteger value = division[1].signum() == 0 ? division[0] : division[0].add(BigInteger.ONE);
        return clampFrame(value);
    }

    private static BigInteger[] scaled(com.ghatana.media.runtime.MediaProjectTimelineContracts.RationalTime time,
                                       int fps) {
        // seconds = ticks * rateDenominator / rateNumerator
        BigInteger numerator = BigInteger.valueOf(time.ticks()).multiply(BigInteger.valueOf(time.rateDenominator()))
                .multiply(BigInteger.valueOf(fps));
        return numerator.divideAndRemainder(BigInteger.valueOf(time.rateNumerator()));
    }

    private static int clampFrame(BigInteger value) {
        if (value.compareTo(BigInteger.valueOf(AnimationRenderer.MAX_FRAMES + 1L)) > 0) {
            return AnimationRenderer.MAX_FRAMES + 1;
        }
        return value.intValueExact();
    }

    static OutputRegistrar canonicalRegistrar(MediaRuntime runtime) {
        return (tenantId, principalId, request, idempotencyKey, bytes) -> {
            UploadSession session = runtime.beginUpload(request, idempotencyKey);
            boolean replayed = session.status() == UploadStatus.COMPLETED;
            if (session.status() == UploadStatus.OPEN) {
                int chunk = Math.max(1, runtime.config().maximumChunkBytes());
                int index = 0;
                for (int offset = 0; offset < bytes.length; offset += chunk, index++) {
                    byte[] part = java.util.Arrays.copyOfRange(bytes, offset, Math.min(bytes.length, offset + chunk));
                    // Chunks below nextChunkIndex are verified replays; the store refuses divergent bytes.
                    runtime.appendChunk(tenantId, principalId, session.uploadId(), index, part);
                }
            }
            return new Registered(runtime.completeUpload(tenantId, principalId, session.uploadId()), replayed);
        };
    }

    private static String boundedId(String value, String name) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
            throw new IllegalArgumentException(name + " must be a 1-128 character opaque id");
        }
        return value;
    }

    static String sha256Hex(byte[] value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    static String sha256Hex(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }
}
