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
import java.math.BigInteger;
import java.util.stream.Collectors;

/**
 * Video analysis service with source-timestamped per-frame detections.
 *
 * <p>Orchestrates frame extraction ({@link VideoFrameExtractor}) and
 * per-frame object detection ({@link VisionDetector}) to produce a temporal
 * object-tracking timeline from a video file.
 *
 * <p>Local box association is explicitly heuristic and uncalibrated. It does not establish
 * identity, shot boundaries, camera motion, or tracker quality.
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
            if (frames.size() > config.getMaxFrames()) {
                throw new IOException("Frame extraction exceeded the configured frame-count limit");
            }

            LOG.info("Analysing {} frames from video", frames.size());

            List<ObservedFrame> observedFrames = new ArrayList<>();
            for (VideoFrameExtractor.ExtractedFrame frame : frames) {
                byte[] imageBytes = Files.readAllBytes(frame.getPath());
                List<DetectedObject> detections = detector.detectObjects(imageBytes, options);
                observedFrames.add(new ObservedFrame(
                        frame.getFrameNumber(), frame.getTimestampMs(), frame.getSourceTimestamp(),
                        new ArrayList<>(detections)
                ));
            }

            Duration elapsed = Duration.between(startTime, Instant.now());
            TrackAssignment assignments = assignHeuristicTracks(observedFrames, config.getFps());
            List<FrameDetections> frameDetections = assignments.frames();

            LOG.info("Video analysis complete: frames={}, temporalTracking=HEURISTIC_UNCALIBRATED, elapsed={}ms",
                    frames.size(), elapsed.toMillis());

            return new VideoAnalysisResult(
                    videoPath.getFileName().toString(),
                    Instant.now(), frames.size(), assignments.uniqueTracks(),
                    frameDetections, elapsed, "HEURISTIC_UNCALIBRATED"
            );

        } catch (IOException e) {
            throw new VideoAnalysisException("Video analysis failed: " + e.getMessage(), e);
        } finally {
            cleanupTempDir(tempDir);
        }
    }

    /** Greedy, one-frame-memory IoU association. IDs are scoped to this analysis call. */
    private TrackAssignment assignHeuristicTracks(List<ObservedFrame> frames, int samplingFps) {
        Map<Integer, DetectedObject> previous = Map.of();
        SourceMediaTimestamp previousTimestamp = null;
        Integer previousFrameNumber = null;
        int nextId = 1;
        List<FrameDetections> assignedFrames = new ArrayList<>(frames.size());
        for (int frameIndex = 0; frameIndex < frames.size(); frameIndex++) {
            ObservedFrame frame = frames.get(frameIndex);
            SourceMediaTimestamp timestamp = frame.sourceTimestamp();
            boolean reset = previousTimestamp == null || !timestamp.isKnown()
                    || !previousTimestamp.isKnown() || comparePts(timestamp, previousTimestamp) <= 0
                    || exceedsGap(timestamp, previousTimestamp, samplingFps)
                    // The extractor preserves emitted sequence ordinals. A hole means one or more
                    // observations are missing; do not bridge identity across that uncertainty.
                    || (previousFrameNumber != null
                        && (long) frame.frameNumber() != (long) previousFrameNumber + 1L);
            if (reset) previous = Map.of();
            List<Integer> ids = new ArrayList<>(frame.detections().size());
            Map<Integer, DetectedObject> current = new java.util.LinkedHashMap<>();
            java.util.Set<Integer> usedPrevious = new java.util.HashSet<>();
            for (DetectedObject detection : frame.detections()) {
                int bestId = -1;
                double bestIou = iouThreshold;
                boolean tied = false;
                if (!reset && detection.getBoundingBox() != null) {
                    for (Map.Entry<Integer, DetectedObject> candidate : previous.entrySet()) {
                        if (usedPrevious.contains(candidate.getKey()) || candidate.getValue().getBoundingBox() == null
                                || !Objects.equals(detection.getClassName(), candidate.getValue().getClassName())) continue;
                        double iou = detection.getBoundingBox().calculateIoU(candidate.getValue().getBoundingBox());
                        if (iou > bestIou) { bestIou = iou; bestId = candidate.getKey(); tied = false; }
                        else if (iou == bestIou && bestId != -1) tied = true;
                    }
                }
                if (bestId == -1 || tied) bestId = nextId++;
                else usedPrevious.add(bestId);
                ids.add(bestId);
                current.put(bestId, detection);
            }
            assignedFrames.add(new FrameDetections(frame.frameNumber(), frame.timestampMs(), timestamp,
                    frame.detections(), ids));
            previous = current;
            previousTimestamp = timestamp;
            previousFrameNumber = frame.frameNumber();
        }
        return new TrackAssignment(List.copyOf(assignedFrames), nextId - 1);
    }

    private record ObservedFrame(
            int frameNumber,
            Long timestampMs,
            SourceMediaTimestamp sourceTimestamp,
            List<DetectedObject> detections) {}

    private record TrackAssignment(List<FrameDetections> frames, int uniqueTracks) {}

    private static int comparePts(SourceMediaTimestamp a, SourceMediaTimestamp b) {
        BigInteger left = BigInteger.valueOf(a.pts()).multiply(BigInteger.valueOf(a.timeBaseNumerator()))
                .multiply(BigInteger.valueOf(b.timeBaseDenominator()));
        BigInteger right = BigInteger.valueOf(b.pts()).multiply(BigInteger.valueOf(b.timeBaseNumerator()))
                .multiply(BigInteger.valueOf(a.timeBaseDenominator()));
        return left.compareTo(right);
    }

    private static boolean exceedsGap(SourceMediaTimestamp current, SourceMediaTimestamp previous, int fps) {
        BigInteger deltaN = BigInteger.valueOf(current.pts()).multiply(BigInteger.valueOf(current.timeBaseNumerator()))
                .multiply(BigInteger.valueOf(previous.timeBaseDenominator()))
                .subtract(BigInteger.valueOf(previous.pts()).multiply(BigInteger.valueOf(previous.timeBaseNumerator()))
                        .multiply(BigInteger.valueOf(current.timeBaseDenominator())));
        BigInteger deltaD = BigInteger.valueOf(current.timeBaseDenominator())
                .multiply(BigInteger.valueOf(previous.timeBaseDenominator()));
        return deltaN.multiply(BigInteger.valueOf(fps)).compareTo(deltaD.multiply(BigInteger.TWO)) > 0;
    }

    private void cleanupTempDir(Path dir) {
        if (dir == null) return;
        try {
            Files.walk(dir)
                    .sorted(java.util.Comparator.reverseOrder())
                    .map(Path::toFile)
                    .forEach(java.io.File::delete);
        } catch (IOException e) {
            LOG.warn("Failed to clean up temporary directory ({})", e.getClass().getSimpleName());
        }
    }

    // ── Nested types ──────────────────────────────────────────────────────────

    /**
     * Detections for a single video frame.
     *
     * @param frameNumber  0-based emitted frame sequence, not media or wall time
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
            if (frameNumber < 0) {
                throw new IllegalArgumentException("Frame number must be a non-negative emitted-frame ordinal");
            }
            detections = List.copyOf(Objects.requireNonNull(detections, "detections"));
            trackIds = List.copyOf(Objects.requireNonNull(trackIds, "trackIds"));
            if (trackIds.size() != detections.size()) {
                throw new IllegalArgumentException("Each detection must have exactly one track ID");
            }
            if (trackIds.stream().anyMatch(trackId -> trackId == null || trackId <= 0)
                    || trackIds.stream().distinct().count() != trackIds.size()) {
                throw new IllegalArgumentException("Track IDs must be positive and unique within a frame");
            }
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
     * @param uniqueTracks   number of ephemeral IDs assigned by local heuristic association
     * @param frameDetections per-frame detection timeline
     * @param processingTime total analysis duration
     * @param trackingStatus HEURISTIC_UNCALIBRATED for local IoU association; never a quality claim
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
        public VideoAnalysisResult {
            frameDetections = List.copyOf(Objects.requireNonNull(frameDetections, "frameDetections"));
            if (framesAnalysed != frameDetections.size() || uniqueTracks < 0) {
                throw new IllegalArgumentException("Video analysis counts must match the frame timeline");
            }
            long observedTrackCount = frameDetections.stream()
                    .flatMap(frame -> frame.trackIds().stream())
                    .distinct()
                    .count();
            if (uniqueTracks != observedTrackCount) {
                throw new IllegalArgumentException("Unique track count must match the frame timeline");
            }
        }

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
