package com.ghatana.media.launcher;

import com.ghatana.audio.video.vision.local.LocalModelAdmission;
import com.ghatana.audio.video.vision.local.LocalVisionEngine;
import com.ghatana.audio.video.vision.local.LocalVisionSidecarClient;
import com.ghatana.audio.video.vision.tracking.GreedyIouTracker;
import com.ghatana.audio.video.vision.tracking.RegionOfInterest;
import com.ghatana.audio.video.vision.tracking.SourceBox;
import com.ghatana.audio.video.vision.tracking.VideoTimeline;
import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Verdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Stream;

/**
 * DEV_ONLY video detection and tracking, and region-of-interest analysis, over an exact owner-visible source
 * artifact version. Both register an immutable {@code application/json} artifact through the canonical idempotent
 * upload path, with lineage to the exact source version digest and the digest-qualified model identity.
 *
 * <p><b>Tracking</b> ({@link #track}): the exact frame timeline comes from {@code ffprobe -show_frames} (real source
 * PTS in the stream's rational time base, PTS order, so variable frame rate is handled); a deterministic subset of
 * frames is selected by PTS-order ordinal; those frames are decoded in one FFmpeg pass with
 * {@code select=eq(n,..)} and {@code -fps_mode passthrough}; Florence-2 object detection runs per frame in bounded
 * batches; and {@link GreedyIouTracker} links detections into tracks. Every box is validated inside the decoded frame
 * and the frame raster must equal the probed geometry. Nothing is registered unless every sampled frame was
 * processed: a sidecar failure part-way is {@link VisionOutcomeUnknownException} (outcome UNKNOWN, never success) and a
 * retry with the same requestId re-derives identical bytes, so the upload idempotency key makes it exactly-once.
 *
 * <p><b>ROI analysis</b> ({@link #analyzeRoi}): detection or scene-text inside a region. Structural ROI faults
 * (non-integer, negative, zero-size, overflowing) are refused when the request is parsed, before any source lookup or
 * byte read; an ROI outside the decoded frame is refused before any model call. The model sees only the crop, and the
 * results are translated back to source-frame pixel coordinates.
 *
 * <p>Rights: the exact source version/digest must resolve ADMITTED for {@code PROCESSING} before any byte is read.
 *
 * @doc.type class
 * @doc.purpose DEV_ONLY source-PTS video tracking and ROI analysis registered as lineage-bound JSON artifacts
 * @doc.layer product
 * @doc.pattern Service
 */
public final class MediaDevVisionTrackingRuntime {
    public static final String TRACKS_SCHEMA = "media.dev.vision-tracks.v1";
    public static final String ROI_SCHEMA = "media.dev.vision-roi.v1";
    public static final String KIND_TRACKS = "LOCAL_VISION_TRACKS";
    public static final String KIND_ROI = "LOCAL_VISION_ROI_ANALYSIS";
    public static final int DEFAULT_MAX_FRAMES = 16;
    public static final int MAX_FRAMES = 64;
    /** Frames sent to the sidecar before the batch's PNGs are released. */
    static final int BATCH_SIZE = 4;
    static final long MAX_PIXELS = 8_294_400L;
    static final long MAX_FRAME_DIR_BYTES = 1L << 30;
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final Duration PROBE_TIMEOUT = Duration.ofSeconds(120);
    private static final Duration EXTRACT_TIMEOUT = Duration.ofSeconds(300);

    /** Tracking request. {@code strideFrames} 0 means the deterministic automatic stride. */
    public record TrackRequest(String requestId, String artifactId, String artifactVersionId, int maxFrames,
                               int strideFrames, double minIou, int maxMissedFrames) {
        public TrackRequest {
            requestId = boundedId(requestId);
            Objects.requireNonNull(artifactId, "artifactId");
            Objects.requireNonNull(artifactVersionId, "artifactVersionId");
            if (maxFrames < 1 || maxFrames > MAX_FRAMES) {
                throw new IllegalArgumentException("maxFrames must be within [1, " + MAX_FRAMES + "]");
            }
            if (strideFrames < 0 || strideFrames > 100_000) {
                throw new IllegalArgumentException("strideFrames must be within [0, 100000]");
            }
            if (!(minIou >= 0.05 && minIou <= 0.9)) throw new IllegalArgumentException("minIou must be within [0.05, 0.9]");
            if (maxMissedFrames < 0 || maxMissedFrames > 4) {
                throw new IllegalArgumentException("maxMissedFrames must be within [0, 4]");
            }
        }
    }

    /** ROI request; {@code frameIndex} (PTS-order ordinal) applies to video sources and defaults to 0. */
    public record RoiRequest(String requestId, String artifactId, String artifactVersionId, Set<String> tasks,
                             RegionOfInterest roi, int frameIndex) {
        public RoiRequest {
            requestId = boundedId(requestId);
            Objects.requireNonNull(artifactId, "artifactId");
            Objects.requireNonNull(artifactVersionId, "artifactVersionId");
            Objects.requireNonNull(roi, "roi");
            if (tasks == null || tasks.isEmpty() || !Set.of("detect", "ocr").containsAll(tasks)) {
                throw new IllegalArgumentException("tasks must be a non-empty subset of detect, ocr");
            }
            tasks = Set.copyOf(tasks);
            if (frameIndex < 0) throw new IllegalArgumentException("frameIndex must not be negative");
        }
    }

    /**
     * The sidecar failed or vanished before every frame was processed. Nothing was registered; the outcome of the
     * run is UNKNOWN and the same requestId may be retried.
     */
    public static final class VisionOutcomeUnknownException extends RuntimeException {
        private final int framesCompleted;
        private final int framesPlanned;
        VisionOutcomeUnknownException(int framesCompleted, int framesPlanned, Throwable cause) {
            super("local vision outcome is unknown after " + framesCompleted + " of " + framesPlanned + " frames", cause);
            this.framesCompleted = framesCompleted;
            this.framesPlanned = framesPlanned;
        }
        public int framesCompleted() { return framesCompleted; }
        public int framesPlanned() { return framesPlanned; }
    }

    private final MediaRuntime runtime;
    private final MediaDevVisionRuntime vision;
    private final Path ffmpeg;
    private final Path ffprobe;
    private final MediaDevRequestLedger ledger;
    static final String LANE_TRACK = "vision.track";
    static final String LANE_ROI = "vision.roi";

    /** {@code ffmpeg} and {@code ffprobe} must be absolute; either may be null, in which case video is unavailable. */
    public MediaDevVisionTrackingRuntime(MediaRuntime runtime, MediaDevVisionRuntime vision, Path ffmpeg, Path ffprobe) {
        this(runtime, vision, ffmpeg, ffprobe, MediaDevRequestLedger.inMemory());
    }

    MediaDevVisionTrackingRuntime(MediaRuntime runtime, MediaDevVisionRuntime vision, Path ffmpeg, Path ffprobe,
                                  MediaDevRequestLedger ledger) {
        this.ledger = Objects.requireNonNull(ledger, "ledger");
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.vision = Objects.requireNonNull(vision, "vision");
        if ((ffmpeg != null && !ffmpeg.isAbsolute()) || (ffprobe != null && !ffprobe.isAbsolute())) {
            throw new IllegalArgumentException("ffmpeg and ffprobe paths must be absolute");
        }
        this.ffmpeg = ffmpeg;
        this.ffprobe = ffprobe;
    }

    /** Null when no absolute FFmpeg and FFprobe path pair is configured; tools are never resolved through PATH. */
    static MediaDevVisionTrackingRuntime compose(MediaRuntime runtime, MediaDevVisionRuntime vision,
                                                 Map<String, String> environment) {
        return compose(runtime, vision, environment, MediaDevRequestLedger.inMemory());
    }

    static MediaDevVisionTrackingRuntime compose(MediaRuntime runtime, MediaDevVisionRuntime vision,
                                                 Map<String, String> environment, MediaDevRequestLedger ledger) {
        String ffmpeg = environment.get(MediaDevProjectRenderRuntime.FFMPEG_ENV);
        String ffprobe = environment.get(MediaDevProjectRenderRuntime.FFPROBE_ENV);
        return new MediaDevVisionTrackingRuntime(runtime, vision,
                ffmpeg == null || ffmpeg.isBlank() ? null : Path.of(ffmpeg),
                ffprobe == null || ffprobe.isBlank() ? null : Path.of(ffprobe), ledger);
    }

    boolean videoAvailable() { return ffmpeg != null && ffprobe != null; }

    // ------------------------------------------------------------------ tracking

    public MediaDevVisionRuntime.VisionResult track(String tenantId, String principalId, TrackRequest request) {
        Objects.requireNonNull(request, "request");
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "vision_track", tenantId,
                () -> executeTrack(tenantId, principalId, request));
    }

    private MediaDevVisionRuntime.VisionResult executeTrack(String tenantId, String principalId, TrackRequest request) {
        MediaArtifact source = source(tenantId, principalId, request.artifactId(), request.artifactVersionId());
        Resolution resolution = admit(tenantId, source);
        if (!source.contentType().toLowerCase(Locale.ROOT).startsWith("video/")) {
            throw new MediaDevVisionRuntime.VisionUnsupportedException("SOURCE_FORMAT_NOT_SUPPORTED",
                    "tracking requires a video/* source artifact version");
        }
        if (!videoAvailable()) {
            throw new MediaDevVisionRuntime.VisionUnsupportedException("FRAME_EXTRACTION_UNAVAILABLE",
                    "video tracking requires MEDIA_DEV_RENDER_FFMPEG and MEDIA_DEV_RENDER_FFPROBE");
        }
        // Rights were re-checked above on every call (a revoked source refuses even a replay). The ledger maps the
        // requestId to its registered tracks, so the (nondeterministic) detector runs at most once per request.
        String fingerprint = MediaDevRequestLedger.fingerprint("media.dev.vision.track.v1", source.artifactId(),
                source.version().value(), source.sha256(), request.maxFrames(), request.strideFrames(),
                request.minIou(), request.maxMissedFrames());
        return ledger.run(tenantId, principalId, LANE_TRACK, request.requestId(), fingerprint,
                outputs -> replay(tenantId, principalId, outputs, resolution, LANE_TRACK),
                () -> produceTrack(tenantId, principalId, request, source, resolution),
                result -> List.of(new OutputRef("result", result.artifact().artifactId(),
                        result.artifact().version().value())),
                () -> new MediaDevVisionRuntime.VisionRequestReusedException(
                        new IllegalArgumentException("requestId used with a different request")));
    }

    private MediaDevVisionRuntime.VisionResult replay(String tenantId, String principalId, List<OutputRef> outputs,
                                                      Resolution resolution, String lane) {
        OutputRef ref = outputs.getFirst();
        return vision.reopen(tenantId, principalId, ref.artifactId())
                .filter(found -> found.artifact().version().value().equals(ref.versionId()))
                .map(found -> new MediaDevVisionRuntime.VisionResult(found.artifact(), found.lineage(), true, resolution))
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(lane));
    }

    private MediaDevVisionRuntime.VisionResult produceTrack(String tenantId, String principalId, TrackRequest request,
                                                            MediaArtifact source, Resolution resolution) {
        LocalVisionEngine engine = vision.engine();
        requireAdmitted(engine);
        Path dir = privateTempDirectory();
        try {
            Path video = dir.resolve("in.bin");
            stage(tenantId, principalId, source, video);
            VideoTimeline timeline = probe(video, dir);
            if ((long) timeline.width() * timeline.height() > MAX_PIXELS) {
                throw new MediaDevVisionRuntime.VisionUnsupportedException("VISION_LIMIT_EXCEEDED",
                        "video frame size exceeds the pixel ceiling");
            }
            List<Integer> sampled = timeline.sample(request.maxFrames(), request.strideFrames());
            Path frames = Files.createDirectory(dir.resolve("frames"),
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
            extractFrames(video, frames, sampled);

            GreedyIouTracker tracker = new GreedyIouTracker(request.minIou(), request.maxMissedFrames());
            List<Map<String, Object>> frameRecords = new ArrayList<>();
            Map<String, Object> model = null;
            int completed = 0;
            for (int batchStart = 0; batchStart < sampled.size(); batchStart += BATCH_SIZE) {
                int batchEnd = Math.min(sampled.size(), batchStart + BATCH_SIZE);
                for (int ordinal = batchStart; ordinal < batchEnd; ordinal++) {
                    int frameIndex = sampled.get(ordinal);
                    VideoTimeline.FrameTime time = timeline.frames().get(frameIndex);
                    Path png = frames.resolve(String.format("f%05d.png", ordinal + 1));
                    byte[] image = Files.readAllBytes(png);
                    requireRaster(image, timeline.width(), timeline.height());
                    String sha = MediaDevProjectRenderRuntime.sha256Hex(image);
                    Map<String, Object> inference;
                    try {
                        inference = engine.analyze(image, sha, Set.of("detect"));
                    } catch (LocalVisionSidecarClient.SidecarUnavailableException unavailable) {
                        throw MediaDevVisionRuntime.sidecarOutage(unavailable, completed, sampled.size());
                    } catch (LocalVisionEngine.NotAdmittedException refusal) {
                        throw new MediaDevVisionRuntime.VisionNotAdmittedException(refusal.modelId(), refusal.code());
                    } catch (LocalVisionSidecarClient.SidecarRejectedException rejected) {
                        if (MediaDevVisionRuntime.providerFailure(rejected)) {
                            throw new MediaDevVisionRuntime.VisionUnavailableException(rejected);
                        }
                        throw new MediaDevVisionRuntime.VisionUnsupportedException("LOCAL_VISION_REJECTED",
                                "the local vision sidecar rejected a frame (" + rejected.code() + ")");
                    }
                    model = modelOf(inference);
                    requireInputSize(inference, timeline.width(), timeline.height());
                    List<GreedyIouTracker.Detection> detections = new ArrayList<>();
                    int rejected = 0;
                    for (Object raw : objects(inference)) {
                        Map<?, ?> object = (Map<?, ?>) raw;
                        Map<?, ?> box = (Map<?, ?>) object.get("boundingBox");
                        SourceBox candidate = new SourceBox(number(box.get("x")), number(box.get("y")),
                                number(box.get("width")), number(box.get("height")))
                                .clampedToFrame(timeline.width(), timeline.height());
                        String label = String.valueOf(object.get("label")).strip();
                        if (candidate == null || label.isEmpty()
                                || !candidate.withinFrame(timeline.width(), timeline.height())) {
                            rejected++;
                        } else {
                            detections.add(new GreedyIouTracker.Detection(label, candidate));
                        }
                    }
                    tracker.update(frameIndex, time.pts(), detections);
                    Map<String, Object> record = new LinkedHashMap<>();
                    record.put("frameIndex", frameIndex);
                    record.put("pts", time.pts());
                    record.put("ptsMicros", timeline.ptsMicros(time.pts()));
                    record.put("frameSha256", sha);
                    record.put("detections", detections.size());
                    record.put("rejectedDetections", rejected);
                    frameRecords.add(record);
                    Files.deleteIfExists(png);
                    completed++;
                }
            }
            return registerTracks(tenantId, principalId, request, source, resolution, timeline, sampled, frameRecords,
                    tracker.tracks(), model);
        } catch (IOException failure) {
            throw new MediaDevVisionRuntime.VisionUnsupportedException("FRAME_EXTRACTION_FAILED",
                    "the exact video version could not be decoded into frames");
        } catch (VideoTimeline.TimelineException failure) {
            throw new MediaDevVisionRuntime.VisionUnsupportedException("VIDEO_TIMELINE_UNTRUSTED",
                    "the video frame timeline is not usable: " + failure.getMessage());
        } finally {
            deleteTree(dir);
        }
    }

    private MediaDevVisionRuntime.VisionResult registerTracks(String tenantId, String principalId, TrackRequest request,
                                                              MediaArtifact source, Resolution resolution,
                                                              VideoTimeline timeline, List<Integer> sampled,
                                                              List<Map<String, Object>> frameRecords,
                                                              List<GreedyIouTracker.Track> tracks,
                                                              Map<String, Object> model) {
        Map<String, Object> sourceRef = sourceRef(source);
        Map<String, Object> video = new LinkedHashMap<>();
        video.put("width", timeline.width());
        video.put("height", timeline.height());
        video.put("coordinateSpace", "SOURCE_FRAME_PIXELS_TOP_LEFT_ORIGIN");
        video.put("timeBase", timeBase(timeline));
        video.put("frameCount", timeline.frames().size());
        video.put("variableFrameRate", timeline.variableFrameRate());
        video.put("timeline", "ffprobe -show_frames, PTS order");
        Map<String, Object> tracking = new LinkedHashMap<>();
        tracking.put("algorithm", GreedyIouTracker.ALGORITHM);
        tracking.put("minIou", request.minIou());
        tracking.put("maxMissedFrames", request.maxMissedFrames());
        tracking.put("labelPolicy", "SAME_LABEL_ONLY");
        tracking.put("prediction", "CONSTANT_VELOCITY_IN_PTS_TIME");
        tracking.put("sampling", "UNIFORM_PTS_ORDER_STRIDE");
        tracking.put("maxFrames", request.maxFrames());
        tracking.put("strideFrames", request.strideFrames());
        tracking.put("sampledFrameIndices", sampled);
        tracking.put("batchSize", BATCH_SIZE);
        tracking.put("detector", "Florence-2 <OD>");
        List<Map<String, Object>> trackViews = new ArrayList<>();
        for (GreedyIouTracker.Track track : tracks) {
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("trackId", track.trackId());
            view.put("label", track.label());
            view.put("firstFrameIndex", track.firstFrameIndex());
            view.put("lastFrameIndex", track.lastFrameIndex());
            view.put("observationCount", track.observations().size());
            List<Map<String, Object>> observations = new ArrayList<>();
            for (GreedyIouTracker.Observation observation : track.observations()) {
                Map<String, Object> o = new LinkedHashMap<>();
                o.put("frameIndex", observation.frameIndex());
                o.put("pts", observation.pts());
                o.put("ptsMicros", timeline.ptsMicros(observation.pts()));
                o.put("box", boxView(observation.box()));
                observations.add(o);
            }
            view.put("observations", observations);
            trackViews.add(view);
        }
        Map<String, Object> document = new LinkedHashMap<>();
        document.put("schema", TRACKS_SCHEMA);
        document.put("scope", "DEV_ONLY");
        document.put("kind", KIND_TRACKS);
        document.put("requestId", request.requestId());
        document.put("source", sourceRef);
        document.put("video", video);
        document.put("tracking", tracking);
        document.put("frames", frameRecords);
        document.put("tracks", trackViews);
        document.put("model", model);
        document.put("claims", Map.of("quality", "NONE",
                "note", "Local open-model detections linked by a deterministic tracker; no accuracy, rights or production claim."));
        byte[] bytes = JSON.writeValueAsString(document).getBytes(StandardCharsets.UTF_8);

        Map<String, Object> lineage = baseLineage(KIND_TRACKS, request.requestId(), sourceRef, model, resolution, bytes);
        lineage.put("video", video);
        lineage.put("tracking", tracking);
        lineage.put("tasks", List.of("detect"));
        return register(tenantId, principalId, "vision-tracks", KIND_TRACKS, request.requestId(), bytes, lineage,
                resolution);
    }

    // ------------------------------------------------------------------ ROI analysis

    public MediaDevVisionRuntime.VisionResult analyzeRoi(String tenantId, String principalId, RoiRequest request) {
        Objects.requireNonNull(request, "request");
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "vision_roi", tenantId,
                () -> executeRoi(tenantId, principalId, request));
    }

    private MediaDevVisionRuntime.VisionResult executeRoi(String tenantId, String principalId, RoiRequest request) {
        MediaArtifact source = source(tenantId, principalId, request.artifactId(), request.artifactVersionId());
        Resolution resolution = admit(tenantId, source);
        String contentType = source.contentType().toLowerCase(Locale.ROOT);
        boolean isVideo = contentType.startsWith("video/");
        if (!isVideo && !contentType.startsWith("image/")) {
            throw new MediaDevVisionRuntime.VisionUnsupportedException("SOURCE_FORMAT_NOT_SUPPORTED",
                    "ROI analysis requires an image/* or video/* source artifact version");
        }
        if (isVideo && !videoAvailable()) {
            throw new MediaDevVisionRuntime.VisionUnsupportedException("FRAME_EXTRACTION_UNAVAILABLE",
                    "video ROI analysis requires MEDIA_DEV_RENDER_FFMPEG and MEDIA_DEV_RENDER_FFPROBE");
        }
        if (source.sizeBytes() > MediaDevVisionRuntime.MAX_SOURCE_BYTES) {
            throw new MediaDevVisionRuntime.VisionUnsupportedException("VISION_LIMIT_EXCEEDED",
                    "source exceeds the byte ceiling");
        }
        String fingerprint = MediaDevRequestLedger.fingerprint("media.dev.vision.roi.v1", source.artifactId(),
                source.version().value(), source.sha256(), request.tasks().stream().sorted().toList(),
                request.roi().x(), request.roi().y(), request.roi().width(), request.roi().height(),
                request.frameIndex());
        return ledger.run(tenantId, principalId, LANE_ROI, request.requestId(), fingerprint,
                outputs -> replay(tenantId, principalId, outputs, resolution, LANE_ROI),
                () -> produceRoi(tenantId, principalId, request, source, resolution, isVideo),
                result -> List.of(new OutputRef("result", result.artifact().artifactId(),
                        result.artifact().version().value())),
                () -> new MediaDevVisionRuntime.VisionRequestReusedException(
                        new IllegalArgumentException("requestId used with a different request")));
    }

    private MediaDevVisionRuntime.VisionResult produceRoi(String tenantId, String principalId, RoiRequest request,
                                                          MediaArtifact source, Resolution resolution,
                                                          boolean isVideo) {
        LocalVisionEngine engine = vision.engine();
        requireAdmitted(engine);
        Path dir = privateTempDirectory();
        try {
            Path file = dir.resolve("in.bin");
            stage(tenantId, principalId, source, file);
            byte[] frameImage;
            Map<String, Object> frame = new LinkedHashMap<>();
            int width;
            int height;
            if (isVideo) {
                VideoTimeline timeline = probe(file, dir);
                width = timeline.width();
                height = timeline.height();
                if (request.frameIndex() >= timeline.frames().size()) {
                    throw new MediaDevVisionRuntime.VisionUnsupportedException("FRAME_INDEX_OUT_OF_RANGE",
                            "frameIndex is not a frame of the exact video version");
                }
                // Geometry is known from the probe, so an out-of-frame ROI never reaches decoding or a model.
                request.roi().requireWithin(width, height);
                Path frames = Files.createDirectory(dir.resolve("frames"),
                        PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
                extractFrames(file, frames, List.of(request.frameIndex()));
                frameImage = Files.readAllBytes(frames.resolve("f00001.png"));
                requireRaster(frameImage, width, height);
                VideoTimeline.FrameTime time = timeline.frames().get(request.frameIndex());
                frame.put("frameIndex", request.frameIndex());
                frame.put("pts", time.pts());
                frame.put("ptsMicros", timeline.ptsMicros(time.pts()));
                frame.put("timeBase", timeBase(timeline));
            } else {
                frameImage = Files.readAllBytes(file);
                int[] size = imageSize(frameImage);
                width = size[0];
                height = size[1];
                request.roi().requireWithin(width, height);
            }
            frame.put("frameSha256", MediaDevProjectRenderRuntime.sha256Hex(frameImage));
            frame.put("width", width);
            frame.put("height", height);
            frame.put("coordinateSpace", "SOURCE_FRAME_PIXELS_TOP_LEFT_ORIGIN");

            byte[] crop = crop(frameImage, request.roi());
            String cropSha = MediaDevProjectRenderRuntime.sha256Hex(crop);
            Map<String, Object> inference;
            try {
                inference = engine.analyze(crop, cropSha, request.tasks());
            } catch (LocalVisionSidecarClient.SidecarUnavailableException unavailable) {
                throw MediaDevVisionRuntime.sidecarOutage(unavailable, 0, 1);
            } catch (LocalVisionEngine.NotAdmittedException refusal) {
                throw new MediaDevVisionRuntime.VisionNotAdmittedException(refusal.modelId(), refusal.code());
            } catch (LocalVisionSidecarClient.SidecarRejectedException rejected) {
                if (MediaDevVisionRuntime.providerFailure(rejected)) {
                    throw new MediaDevVisionRuntime.VisionUnavailableException(rejected);
                }
                throw new MediaDevVisionRuntime.VisionUnsupportedException("LOCAL_VISION_REJECTED",
                        "the local vision sidecar rejected the request (" + rejected.code() + ")");
            }
            Map<String, Object> results = translatedResults(inference, request.roi(), width, height);
            Map<String, Object> sourceRef = sourceRef(source);
            Map<String, Object> roi = new LinkedHashMap<>();
            roi.put("x", request.roi().x());
            roi.put("y", request.roi().y());
            roi.put("width", request.roi().width());
            roi.put("height", request.roi().height());
            roi.put("coordinateSpace", "SOURCE_FRAME_PIXELS_TOP_LEFT_ORIGIN");
            roi.put("cropSha256", cropSha);
            Map<String, Object> model = modelOf(inference);
            Map<String, Object> document = new LinkedHashMap<>();
            document.put("schema", ROI_SCHEMA);
            document.put("scope", "DEV_ONLY");
            document.put("kind", KIND_ROI);
            document.put("requestId", request.requestId());
            document.put("source", sourceRef);
            document.put("frame", frame);
            document.put("roi", roi);
            document.put("tasks", request.tasks().stream().sorted().toList());
            document.put("results", results);
            document.put("model", model);
            document.put("claims", Map.of("quality", "NONE",
                    "note", "Local open-model output over the crop only; no accuracy, rights or production claim."));
            byte[] bytes = JSON.writeValueAsString(document).getBytes(StandardCharsets.UTF_8);
            Map<String, Object> lineage = baseLineage(KIND_ROI, request.requestId(), sourceRef, model, resolution, bytes);
            lineage.put("frame", frame);
            lineage.put("roi", roi);
            lineage.put("tasks", request.tasks().stream().sorted().toList());
            return register(tenantId, principalId, "vision-roi", KIND_ROI, request.requestId(), bytes, lineage,
                    resolution);
        } catch (IOException failure) {
            throw new MediaDevVisionRuntime.VisionUnsupportedException("FRAME_EXTRACTION_FAILED",
                    "the exact source version could not be decoded");
        } catch (VideoTimeline.TimelineException failure) {
            throw new MediaDevVisionRuntime.VisionUnsupportedException("VIDEO_TIMELINE_UNTRUSTED",
                    "the video frame timeline is not usable: " + failure.getMessage());
        } finally {
            deleteTree(dir);
        }
    }

    /** Detection boxes and scene-text quads, shifted from crop to source-frame pixels and bounds-checked. */
    private static Map<String, Object> translatedResults(Map<String, Object> inference, RegionOfInterest roi,
                                                         int frameWidth, int frameHeight) {
        Map<String, Object> out = new LinkedHashMap<>();
        Map<?, ?> results = (Map<?, ?>) inference.get("results");
        if (results.containsKey("objects")) {
            List<Map<String, Object>> objects = new ArrayList<>();
            int rejected = 0;
            for (Object raw : (List<?>) results.get("objects")) {
                Map<?, ?> object = (Map<?, ?>) raw;
                Map<?, ?> box = (Map<?, ?>) object.get("boundingBox");
                SourceBox shifted = new SourceBox(number(box.get("x")) + roi.x(), number(box.get("y")) + roi.y(),
                        number(box.get("width")), number(box.get("height"))).clampedToFrame(frameWidth, frameHeight);
                if (shifted == null) { rejected++; continue; }
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("label", object.get("label"));
                entry.put("boundingBox", boxView(shifted));
                objects.add(entry);
            }
            out.put("objects", objects);
            out.put("rejectedObjects", rejected);
        }
        if (results.containsKey("sceneText")) {
            Map<?, ?> sceneText = (Map<?, ?>) results.get("sceneText");
            List<Map<String, Object>> regions = new ArrayList<>();
            for (Object raw : (List<?>) sceneText.get("regions")) {
                Map<?, ?> region = (Map<?, ?>) raw;
                List<?> quad = (List<?>) region.get("quad");
                List<Double> shifted = new ArrayList<>(quad.size());
                for (int i = 0; i < quad.size(); i++) {
                    double v = number(quad.get(i)) + (i % 2 == 0 ? roi.x() : roi.y());
                    double limit = i % 2 == 0 ? frameWidth : frameHeight;
                    shifted.add(Math.round(Math.max(0, Math.min(limit, v)) * 10.0) / 10.0);
                }
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("text", region.get("text"));
                entry.put("quad", shifted);
                regions.add(entry);
            }
            Map<String, Object> text = new LinkedHashMap<>();
            text.put("engine", sceneText.get("engine"));
            text.put("regions", regions);
            text.put("fullText", sceneText.get("fullText"));
            out.put("sceneText", text);
        }
        return out;
    }

    // ------------------------------------------------------------------ shared steps

    private MediaArtifact source(String tenantId, String principalId, String artifactId, String versionId) {
        return runtime.artifact(tenantId, principalId, artifactId)
                .filter(found -> found.version().value().equals(versionId))
                .orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
    }

    private Resolution admit(String tenantId, MediaArtifact source) {
        Resolution resolution;
        try {
            resolution = vision.rights().resolve(new ResolutionRequest(tenantId, source.artifactId(),
                    source.version().value(), source.sha256(), Scope.PROCESSING));
        } catch (RuntimeException failure) {
            resolution = Resolution.unavailable(vision.rights().resolverId());
        }
        if (!resolution.admitted()) {
            throw new MediaDevVisionRuntime.VisionRightsNotAdmittedException(
                    resolution.verdict() == Verdict.UNAVAILABLE ? "RIGHTS_AUTHORITY_UNAVAILABLE"
                            : "RIGHTS_" + resolution.verdict().name(), resolution);
        }
        return resolution;
    }

    /** Florence admission is digest-verified now, before any byte is read (weights altered means withdrawn). */
    private static void requireAdmitted(LocalVisionEngine engine) {
        LocalModelAdmission.Admission admission = engine.florenceAdmission();
        if (!admission.qualified()) {
            throw new MediaDevVisionRuntime.VisionNotAdmittedException(LocalVisionEngine.FLORENCE_MODEL_ID,
                    admission.reasonCode());
        }
    }

    private void stage(String tenantId, String principalId, MediaArtifact source, Path target) throws IOException {
        if (source.sizeBytes() > MediaDevVisionRuntime.MAX_SOURCE_BYTES) {
            throw new MediaDevVisionRuntime.VisionUnsupportedException("VISION_LIMIT_EXCEEDED",
                    "source exceeds the byte ceiling");
        }
        try (OutputStream out = Files.newOutputStream(target)) {
            runtime.copyArtifactContent(tenantId, principalId, source.artifactId(), source.version(), out,
                    MediaDevVisionRuntime.MAX_SOURCE_BYTES)
                    .orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
        }
    }

    private VideoTimeline probe(Path video, Path dir) throws IOException {
        BoundedProcessRunner.Result result = BoundedProcessRunner.run(
                List.of(ffprobe.toString(), "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "frame=pts,best_effort_timestamp:stream=width,height,time_base:stream_side_data=rotation",
                        "-of", "json", video.toString()),
                dir, Map.of(), PROBE_TIMEOUT, 24 * 1024 * 1024, 8192, BoundedProcessRunner.CancellationToken.NEVER,
                null, 0);
        if (!result.succeeded()) throw new IOException("ffprobe did not complete");
        return VideoTimeline.parse(new String(result.stdout(), StandardCharsets.UTF_8));
    }

    /** One decode pass writing {@code f00001.png ...} for exactly the given PTS-order ordinals (ascending). */
    private void extractFrames(Path video, Path frames, List<Integer> indices) throws IOException {
        StringBuilder select = new StringBuilder("select='");
        for (int i = 0; i < indices.size(); i++) {
            if (i > 0) select.append('+');
            select.append("eq(n\\,").append(indices.get(i)).append(')');
        }
        select.append('\'');
        BoundedProcessRunner.Result result = BoundedProcessRunner.run(
                List.of(ffmpeg.toString(), "-nostdin", "-v", "error", "-i", video.toString(), "-map", "0:v:0",
                        "-vf", select.toString(), "-fps_mode", "passthrough", "-f", "image2", "-c:v", "png",
                        "-y", frames.resolve("f%05d.png").toString()),
                frames, Map.of(), EXTRACT_TIMEOUT, 1024, 8192, BoundedProcessRunner.CancellationToken.NEVER, null, 0);
        if (!result.succeeded()) throw new IOException("ffmpeg frame extraction did not complete");
        long total = 0;
        int count = 0;
        try (Stream<Path> list = Files.list(frames)) {
            for (Path file : (Iterable<Path>) list::iterator) {
                total += Files.size(file);
                count++;
            }
        }
        if (count != indices.size() || total > MAX_FRAME_DIR_BYTES) {
            throw new IOException("extracted frame set does not match the selected frames");
        }
    }

    private static void requireRaster(byte[] png, int width, int height) throws IOException {
        int[] size = imageSize(png);
        if (size[0] != width || size[1] != height) throw new IOException("decoded frame geometry differs from the probe");
    }

    /** Raster size from the container header; never decodes pixels. */
    private static int[] imageSize(byte[] bytes) throws IOException {
        try (var input = ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
            var readers = ImageIO.getImageReaders(input);
            if (!readers.hasNext()) {
                throw new MediaDevVisionRuntime.VisionUnsupportedException("SOURCE_FORMAT_NOT_SUPPORTED",
                        "image format is not decodable (png, jpeg, gif, bmp)");
            }
            var reader = readers.next();
            try {
                reader.setInput(input, true, true);
                int width = reader.getWidth(0);
                int height = reader.getHeight(0);
                if ((long) width * height > MAX_PIXELS) {
                    throw new MediaDevVisionRuntime.VisionUnsupportedException("VISION_LIMIT_EXCEEDED",
                            "image size exceeds the pixel ceiling");
                }
                return new int[] {width, height};
            } finally {
                reader.dispose();
            }
        }
    }

    private static byte[] crop(byte[] image, RegionOfInterest roi) throws IOException {
        BufferedImage decoded = ImageIO.read(new ByteArrayInputStream(image));
        if (decoded == null) throw new IOException("image could not be decoded");
        BufferedImage rgb = new BufferedImage(roi.width(), roi.height(), BufferedImage.TYPE_INT_RGB);
        var graphics = rgb.createGraphics();
        try {
            graphics.drawImage(decoded.getSubimage(roi.x(), roi.y(), roi.width(), roi.height()), 0, 0, null);
        } finally {
            graphics.dispose();
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(rgb, "png", out);
        return out.toByteArray();
    }

    private static void requireInputSize(Map<String, Object> inference, int width, int height) {
        Map<?, ?> input = (Map<?, ?>) inference.get("input");
        if (((Number) input.get("width")).intValue() != width || ((Number) input.get("height")).intValue() != height) {
            throw new MediaDevVisionRuntime.VisionUnsupportedException("LOCAL_VISION_REJECTED",
                    "the sidecar reported a frame size that differs from the probed geometry");
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> modelOf(Map<String, Object> inference) {
        return (Map<String, Object>) inference.get("model");
    }

    private static List<?> objects(Map<String, Object> inference) {
        Map<?, ?> results = (Map<?, ?>) inference.get("results");
        return (List<?>) results.get("objects");
    }

    private static Map<String, Object> sourceRef(MediaArtifact source) {
        Map<String, Object> ref = new LinkedHashMap<>();
        ref.put("artifactId", source.artifactId());
        ref.put("artifactVersionId", source.version().value());
        ref.put("sha256", source.sha256());
        ref.put("contentType", source.contentType());
        return ref;
    }

    private static Map<String, Object> timeBase(VideoTimeline timeline) {
        Map<String, Object> base = new LinkedHashMap<>();
        base.put("num", timeline.timeBaseNum());
        base.put("den", timeline.timeBaseDen());
        return base;
    }

    private static Map<String, Object> boxView(SourceBox box) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("x", box.x());
        view.put("y", box.y());
        view.put("width", box.width());
        view.put("height", box.height());
        return view;
    }

    private static double number(Object value) {
        if (!(value instanceof Number n)) throw new IllegalStateException("model output is malformed");
        return n.doubleValue();
    }

    private static Map<String, Object> baseLineage(String kind, String requestId, Map<String, Object> sourceRef,
                                                   Map<String, Object> model, Resolution resolution, byte[] bytes) {
        Map<String, Object> lineage = new LinkedHashMap<>();
        lineage.put("visionSchema", MediaDevVisionRuntime.SCHEMA);
        lineage.put("scope", "DEV_ONLY");
        lineage.put("kind", kind);
        lineage.put("requestId", requestId);
        lineage.put("source", sourceRef);
        lineage.put("models", List.of(model));
        Map<String, Object> rightsDecision = new LinkedHashMap<>();
        rightsDecision.put("kind", "RIGHTS_CONSENT_ATTESTATION");
        rightsDecision.put("scope", Scope.PROCESSING.name());
        rightsDecision.put("verdict", resolution.verdict().name());
        rightsDecision.put("resolverId", resolution.resolverId());
        rightsDecision.put("productionGrant", false);
        lineage.put("rightsDecision", rightsDecision);
        lineage.put("resultSha256", MediaDevProjectRenderRuntime.sha256Hex(bytes));
        return lineage;
    }

    private MediaDevVisionRuntime.VisionResult register(String tenantId, String principalId, String name, String kind,
                                                        String requestId, byte[] bytes, Map<String, Object> lineage,
                                                        Resolution resolution) {
        String sha256 = MediaDevProjectRenderRuntime.sha256Hex(bytes);
        Map<String, Object> metadata = new LinkedHashMap<>(lineage);
        metadata.put("purpose", "vision-output");
        UploadRequest upload = new UploadRequest(tenantId, principalId, name + ".json", "application/json",
                bytes.length, sha256, "INTERNAL", Duration.ofDays(30), metadata);
        String idempotencyKey = "dev-vision:" + kind + ":" + MediaDevProjectRenderRuntime.sha256Hex(
                tenantId + "\u0000" + principalId + "\u0000" + requestId);
        MediaDevProjectRenderRuntime.Registered registered;
        try {
            registered = vision.registrar().register(tenantId, principalId, upload, idempotencyKey, bytes);
        } catch (IllegalArgumentException conflict) {
            if (conflict.getMessage() != null && conflict.getMessage().contains("Idempotency-Key")) {
                throw new MediaDevVisionRuntime.VisionRequestReusedException(conflict);
            }
            throw new MediaDevVisionRuntime.VisionRegistrationFailedException(conflict);
        } catch (RuntimeException failure) {
            throw new MediaDevVisionRuntime.VisionRegistrationFailedException(failure);
        }
        MediaArtifact artifact = registered.artifact();
        if (!artifact.sha256().equals(sha256)) {
            throw new MediaDevVisionRuntime.VisionRegistrationFailedException(
                    new IllegalStateException("registered artifact digest does not match produced bytes"));
        }
        return new MediaDevVisionRuntime.VisionResult(artifact, lineage, registered.replayed(), resolution);
    }

    private static Path privateTempDirectory() {
        try {
            return Files.createTempDirectory("media-dev-vision-track-",
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        } catch (IOException failure) {
            throw new IllegalStateException("private working directory could not be created", failure);
        }
    }

    private static void deleteTree(Path dir) {
        try (Stream<Path> walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder()).forEach(path -> path.toFile().delete());
        } catch (IOException ignored) {
            // best effort: the directory is private (0700) and under the OS temp root
        }
    }

    private static String boundedId(String value) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
            throw new IllegalArgumentException("requestId must be a 1-128 character opaque id");
        }
        return value;
    }
}
