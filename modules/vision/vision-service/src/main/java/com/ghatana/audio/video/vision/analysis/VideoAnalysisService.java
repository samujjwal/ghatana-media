package com.ghatana.audio.video.vision.analysis;

import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.model.DetectedObject;
import com.ghatana.audio.video.vision.model.DetectionOptions;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;

/**
 * Video analysis service with temporal object tracking (AV-009.4).
 *
 * <p>Orchestrates frame extraction ({@link VideoFrameExtractor}) and
 * per-frame object detection ({@link VisionDetector}) to produce a temporal
 * object-tracking timeline from a video file.
 *
 * <p>Objects detected across consecutive frames are associated into tracks using
 * a simple IoU-based (Intersection-over-Union) greedy matching strategy.
 *
 * @doc.type    class
 * @doc.purpose Video frame analysis with temporal object tracking
 * @doc.layer   product
 * @doc.pattern Service
 */
public final class VideoAnalysisService {

    private static final Logger LOG = LoggerFactory.getLogger(VideoAnalysisService.class);

    private final VisionDetector detector;
    private final VideoFrameExtractor frameExtractor;
    private final double iouThreshold;

    private VideoAnalysisService(Builder builder) {
        this.detector       = builder.detector;
        this.frameExtractor = builder.frameExtractor;
        this.iouThreshold   = builder.iouThreshold;
    }

    // ── Analysis ─────────────────────────────────────────────────────────────

    /**
     * Analyses a video file and produces a temporal detection timeline.
     *
     * @param videoPath video file to analyse
     * @param config    frame extraction configuration
     * @param options   detection options (confidence threshold, labels, etc.)
     * @return video analysis result; never {@code null}
     * @throws VideoAnalysisException if frame extraction or detection fails
     */
    public VideoAnalysisResult analyze(Path videoPath, VideoFrameExtractor.ExtractionConfig config,
                                        DetectionOptions options) {
        Objects.requireNonNull(videoPath, "videoPath must not be null");
        Objects.requireNonNull(config,    "config must not be null");
        Objects.requireNonNull(options,   "options must not be null");

        Instant startTime = Instant.now();
        Path tempDir = null;

        try {
            tempDir = Files.createTempDirectory("avc-frames-");
            List<VideoFrameExtractor.ExtractedFrame> frames =
                    frameExtractor.extractFrames(videoPath, tempDir, config);

            LOG.info("Analysing {} frames from video: {}", frames.size(), videoPath.getFileName());

            List<FrameDetections> frameDetections = new ArrayList<>();
            int trackIdCounter = 0;
            Map<Integer, DetectedObject> previousTracks = new LinkedHashMap<>();

            for (VideoFrameExtractor.ExtractedFrame frame : frames) {
                byte[] imageBytes = Files.readAllBytes(frame.getPath());
                List<DetectedObject> detections = detector.detectObjects(imageBytes, options);

                // Associate detections to existing tracks via greedy IoU matching
                Map<Integer, DetectedObject> currentTracks = associateTracks(
                        previousTracks, detections, iouThreshold, trackIdCounter);
                trackIdCounter = currentTracks.keySet().stream()
                        .mapToInt(Integer::intValue).max().orElse(trackIdCounter) + 1;

                frameDetections.add(new FrameDetections(
                        frame.getFrameNumber(), frame.getTimestampMs(),
                        new ArrayList<>(currentTracks.values()),
                        new ArrayList<>(currentTracks.keySet())
                ));

                previousTracks = currentTracks;
            }

            Duration elapsed = Duration.between(startTime, Instant.now());
            int uniqueTracks = frameDetections.stream()
                    .flatMapToInt(fd -> fd.trackIds().stream().mapToInt(Integer::intValue))
                    .distinct().max().orElse(-1) + 1;

            LOG.info("Video analysis complete: frames={}, tracks={}, elapsed={}ms",
                    frames.size(), uniqueTracks, elapsed.toMillis());

            return new VideoAnalysisResult(
                    videoPath.getFileName().toString(),
                    Instant.now(), frames.size(), uniqueTracks,
                    frameDetections, elapsed
            );

        } catch (IOException e) {
            throw new VideoAnalysisException("Video analysis failed: " + e.getMessage(), e);
        } finally {
            cleanupTempDir(tempDir);
        }
    }

    // ── Tracking ─────────────────────────────────────────────────────────────

    private Map<Integer, DetectedObject> associateTracks(
            Map<Integer, DetectedObject> previousTracks,
            List<DetectedObject> newDetections,
            double iouThreshold,
            int nextTrackId) {

        Map<Integer, DetectedObject> result = new LinkedHashMap<>();
        boolean[] matched = new boolean[newDetections.size()];

        // Try to match each previous track to the best new detection
        for (Map.Entry<Integer, DetectedObject> prev : previousTracks.entrySet()) {
            int bestIdx = -1;
            double bestIou = iouThreshold;

            for (int i = 0; i < newDetections.size(); i++) {
                if (matched[i]) continue;
                double iou = computeIou(prev.getValue(), newDetections.get(i));
                if (iou > bestIou) {
                    bestIou = iou;
                    bestIdx = i;
                }
            }

            if (bestIdx >= 0) {
                result.put(prev.getKey(), newDetections.get(bestIdx));
                matched[bestIdx] = true;
            }
            // else: track lost — not carried forward
        }

        // Assign new IDs to unmatched detections
        for (int i = 0; i < newDetections.size(); i++) {
            if (!matched[i]) {
                result.put(nextTrackId++, newDetections.get(i));
            }
        }

        return result;
    }

    private double computeIou(DetectedObject a, DetectedObject b) {
        if (a.getBoundingBox() == null || b.getBoundingBox() == null) return 0.0;

        double ax1 = a.getBoundingBox().getX(), ay1 = a.getBoundingBox().getY();
        double ax2 = ax1 + a.getBoundingBox().getWidth();
        double ay2 = ay1 + a.getBoundingBox().getHeight();

        double bx1 = b.getBoundingBox().getX(), by1 = b.getBoundingBox().getY();
        double bx2 = bx1 + b.getBoundingBox().getWidth();
        double by2 = by1 + b.getBoundingBox().getHeight();

        double interX1 = Math.max(ax1, bx1), interY1 = Math.max(ay1, by1);
        double interX2 = Math.min(ax2, bx2), interY2 = Math.min(ay2, by2);

        if (interX2 <= interX1 || interY2 <= interY1) return 0.0;

        double inter  = (interX2 - interX1) * (interY2 - interY1);
        double aArea  = (ax2 - ax1) * (ay2 - ay1);
        double bArea  = (bx2 - bx1) * (by2 - by1);
        double union  = aArea + bArea - inter;
        return union == 0 ? 0.0 : inter / union;
    }

    private void cleanupTempDir(Path dir) {
        if (dir == null) return;
        try {
            Files.walk(dir)
                    .sorted(java.util.Comparator.reverseOrder())
                    .map(Path::toFile)
                    .forEach(java.io.File::delete);
        } catch (IOException e) {
            LOG.warn("Failed to clean up temp dir {}: {}", dir, e.getMessage());
        }
    }

    // ── Nested types ──────────────────────────────────────────────────────────

    /**
     * Detections for a single video frame.
     *
     * @param frameNumber  0-based frame index
     * @param timestampMs  frame timestamp in milliseconds
     * @param detections   detected objects in this frame
     * @param trackIds     track IDs corresponding to each detection (parallel list)
     */
    public record FrameDetections(
            int frameNumber,
            long timestampMs,
            List<DetectedObject> detections,
            List<Integer> trackIds
    ) {}

    /**
     * Complete video analysis result.
     *
     * @param videoName     file name of the analysed video
     * @param analysedAt    when the analysis was performed
     * @param framesAnalysed total number of frames processed
     * @param uniqueTracks   total distinct object tracks found
     * @param frameDetections per-frame detection timeline
     * @param processingTime total analysis duration
     */
    public record VideoAnalysisResult(
            String videoName,
            Instant analysedAt,
            int framesAnalysed,
            int uniqueTracks,
            List<FrameDetections> frameDetections,
            Duration processingTime
    ) {
        /** Returns a summary of object classes detected across all frames. */
        public Map<String, Long> classCounts() {
            return frameDetections.stream()
                    .flatMap(fd -> fd.detections().stream())
                    .collect(Collectors.groupingBy(DetectedObject::getClassName, Collectors.counting()));
        }
    }

    /** Thrown when video analysis fails. */
    public static class VideoAnalysisException extends RuntimeException {
        public VideoAnalysisException(String message, Throwable cause) { super(message, cause); }
    }

    // ── Builder ────────────────────────────────────────────────────────────────

    /** Returns a new builder. */
    public static Builder builder() { return new Builder(); }

    /**
     * Builder for {@link VideoAnalysisService}.
     */
    public static final class Builder {
        private VisionDetector detector;
        private VideoFrameExtractor frameExtractor;
        private double iouThreshold = 0.5;

        private Builder() {}

        public Builder detector(VisionDetector detector) {
            this.detector = Objects.requireNonNull(detector, "detector must not be null");
            return this;
        }

        public Builder frameExtractor(VideoFrameExtractor extractor) {
            this.frameExtractor = Objects.requireNonNull(extractor, "frameExtractor must not be null");
            return this;
        }

        public Builder iouThreshold(double threshold) {
            if (threshold < 0 || threshold > 1) throw new IllegalArgumentException("iouThreshold must be in [0, 1]");
            this.iouThreshold = threshold;
            return this;
        }

        public VideoAnalysisService build() {
            Objects.requireNonNull(detector, "detector must be set");
            Objects.requireNonNull(frameExtractor, "frameExtractor must be set");
            return new VideoAnalysisService(this);
        }
    }
}
