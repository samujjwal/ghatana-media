package com.ghatana.media.launcher;

import com.ghatana.media.production.AnimationSpecCompiler;
import com.ghatana.media.production.animation.AnimationRenderer;
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
    static final int MAX_SOURCE_BYTES = 8 * 1024 * 1024;
    static final int MAX_SOURCE_DIMENSION = 2_048;
    static final int MAX_CLIPS = 64;
    private static final Set<String> SUPPORTED_SOURCE_TYPES = Set.of("image/png", "image/gif", "image/jpeg");
    /** Lineage fields; store-added artifact metadata (classification, retention, ...) is not lineage. */
    private static final List<String> LINEAGE_KEYS = List.of("renderSchema", "scope", "engine", "projectId",
            "revisionId", "timelineId", "timelineSemanticVersionId", "requestId", "width", "height",
            "framesPerSecond", "frameCount", "sources");
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

    /** Request for one render of one timeline at one exact revision. */
    public record RenderRequest(String requestId, String revisionId, String timelineId,
                                int width, int height, int framesPerSecond) {
        public RenderRequest {
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

    private final MediaRuntime runtime;
    private final MediaDevProjectTimelineRuntime projects;
    private final OutputRegistrar registrar;

    MediaDevProjectRenderRuntime(MediaRuntime runtime, MediaDevProjectTimelineRuntime projects) {
        this(runtime, projects, canonicalRegistrar(runtime));
    }

    MediaDevProjectRenderRuntime(MediaRuntime runtime, MediaDevProjectTimelineRuntime projects,
                                 OutputRegistrar registrar) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.projects = Objects.requireNonNull(projects, "projects");
        this.registrar = Objects.requireNonNull(registrar, "registrar");
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

        Map<String, Object> lineage = new LinkedHashMap<>();
        lineage.put("renderSchema", RENDER_SCHEMA);
        lineage.put("scope", "DEV_ONLY");
        lineage.put("engine", ENGINE);
        lineage.put("projectId", projectId);
        lineage.put("revisionId", revision.revisionId());
        lineage.put("timelineId", timeline.timelineId());
        lineage.put("timelineSemanticVersionId", timeline.semanticVersionId());
        lineage.put("requestId", request.requestId());
        lineage.put("width", request.width());
        lineage.put("height", request.height());
        lineage.put("framesPerSecond", fps);
        lineage.put("frameCount", frameCount);
        lineage.put("sources", sources);
        Map<String, Object> metadata = new LinkedHashMap<>(lineage);
        metadata.put("purpose", "project-render");

        UploadRequest upload = new UploadRequest(tenantId, principalId,
                "render-" + revision.revisionId().replaceAll("[^A-Za-z0-9._-]", "_") + ".gif",
                "image/gif", bytes.length, encoded.sha256(), "INTERNAL", Duration.ofDays(30), metadata);
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
        if (!artifact.sha256().equals(encoded.sha256())) {
            throw new RenderRegistrationFailedException(
                    new IllegalStateException("registered artifact digest does not match rendered bytes"));
        }
        return new RenderResult(artifact, lineage, registered.replayed());
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
        MediaArtifact artifact = runtime.artifact(tenantId, principalId, clip.source().artifactId())
                .filter(found -> found.version().value().equals(clip.source().artifactVersionId()))
                .orElseThrow(SourceVersionUnavailableException::new);
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

    static String sha256Hex(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }
}
