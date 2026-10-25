package com.ghatana.audio.video.vision.analysis;

import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.model.DetectedObject;
import com.ghatana.audio.video.vision.model.DetectionOptions;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.ghatana.audio.video.vision.video.SourceMediaTimestamp;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;

/**
 * Video analysis service with source-timestamped per-frame detections.
 *
 * <p>Orchestrates frame extraction ({@link VideoFrameExtractor}) and
 * per-frame object detection ({@link VisionDetector}) to produce a temporal
 * object-tracking timeline from a video file.
 *
 * <p>Temporal tracking remains NOT_ADMITTED until a qualified tracking provider is wired.
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
            for (VideoFrameExtractor.ExtractedFrame frame : frames) {
                byte[] imageBytes = Files.readAllBytes(frame.getPath());
                List<DetectedObject> detections = detector.detectObjects(imageBytes, options);
                frameDetections.add(new FrameDetections(
                        frame.getFrameNumber(), frame.getTimestampMs(), frame.getSourceTimestamp(),
                        new ArrayList<>(detections), List.of()
                ));
            }

            Duration elapsed = Duration.between(startTime, Instant.now());
            int uniqueTracks = 0;

            LOG.info("Video analysis complete: frames={}, temporalTracking=NOT_ADMITTED, elapsed={}ms",
                    frames.size(), elapsed.toMillis());

            return new VideoAnalysisResult(
                    videoPath.getFileName().toString(),
                    Instant.now(), frames.size(), uniqueTracks,
                    frameDetections, elapsed, "NOT_ADMITTED"
            );

        } catch (IOException e) {
            throw new VideoAnalysisException("Video analysis failed: " + e.getMessage(), e);
        } finally {
            cleanupTempDir(tempDir);
        }
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
     * @param timestampMs  source timestamp in milliseconds, null when PTS/timebase are unknown
     * @param sourceTimestamp exact source PTS/timebase state
     * @param detections   detected objects in this frame
     * @param trackIds     track IDs corresponding to each detection (parallel list)
     */
    public record FrameDetections(
            int frameNumber,
            Long timestampMs,
            SourceMediaTimestamp sourceTimestamp,
            List<DetectedObject> detections,
            List<Integer> trackIds
    ) {
        public FrameDetections {
            Objects.requireNonNull(sourceTimestamp, "sourceTimestamp");
            if ((sourceTimestamp.isKnown() && !Objects.equals(timestampMs, sourceTimestamp.timestampMs()))
                    || (!sourceTimestamp.isKnown() && timestampMs != null)) {
                throw new IllegalArgumentException("Frame timestamp must match the source PTS status");
            }
        }
    }

    /**
     * Complete video analysis result.
     *
     * @param videoName     file name of the analysed video
     * @param analysedAt    when the analysis was performed
     * @param framesAnalysed total number of frames processed
     * @param uniqueTracks   zero until an admitted tracker is available
     * @param frameDetections per-frame detection timeline
     * @param processingTime total analysis duration
     * @param trackingStatus NOT_ADMITTED until a qualified temporal tracker is wired
     */
    public record VideoAnalysisResult(
            String videoName,
            Instant analysedAt,
            int framesAnalysed,
            int uniqueTracks,
            List<FrameDetections> frameDetections,
            Duration processingTime,
            String trackingStatus
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
