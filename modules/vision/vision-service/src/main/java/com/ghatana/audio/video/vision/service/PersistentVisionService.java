package com.ghatana.audio.video.vision.service;

import com.ghatana.audio.video.infrastructure.persistence.entity.AudioFileEntity;
import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.model.DetectedObject;
import com.ghatana.audio.video.vision.model.DetectionOptions;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import io.activej.promise.Promise;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * @doc.type class
 * @doc.purpose Vision service with persistence integration.
 *              Detects objects in video/audio files and persists results.
 * @doc.layer product
 * @doc.pattern Service
 */
public class PersistentVisionService {

    private static final Logger LOG = LoggerFactory.getLogger(PersistentVisionService.class);

    private final VisionDetector detector;
    private final VideoFrameExtractor frameExtractor;
    private final AudioFileService audioFileService;
    private final Timer detectTimer;

    public PersistentVisionService(
            VisionDetector detector,
            VideoFrameExtractor frameExtractor,
            AudioFileService audioFileService,
            MeterRegistry meterRegistry) {
        this.detector = Objects.requireNonNull(detector, "detector cannot be null");
        this.frameExtractor = Objects.requireNonNull(frameExtractor, "frameExtractor cannot be null");
        this.audioFileService = Objects.requireNonNull(audioFileService, "audioFileService cannot be null");
        this.detectTimer = Timer.builder("vision.persistent.detect")
            .description("Vision detection latency with persistence")
            .publishPercentiles(0.50, 0.95, 0.99)
            .publishPercentileHistogram()
            .register(meterRegistry);
    }

    /**
     * Detect objects in a video file and persist results.
     *
     * @param tenantId   the tenant ID
     * @param userId       the user ID
     * @param fileName     the video file name
     * @param videoData    the video binary data
     * @param confidenceThreshold minimum confidence for detections (0.0-1.0)
     * @return Promise containing detection results with persisted file ID
     */
    public Promise<DetectionResult> detectAndPersist(
            String tenantId,
            UUID userId,
            String fileName,
            byte[] videoData,
            double confidenceThreshold) {

        Objects.requireNonNull(tenantId, "tenantId cannot be null");
        Objects.requireNonNull(userId, "userId cannot be null");
        Objects.requireNonNull(videoData, "videoData cannot be null");

        long startTime = System.currentTimeMillis();

        // Step 1: Persist video file metadata
        return persistVideoFile(tenantId, userId, fileName, videoData.length)
            .then(audioFile -> {
                LOG.info("[tenant={}] Video file persisted: id={}, file={}",
                    tenantId, audioFile.getId(), fileName);

                // Step 2: Extract frames and detect objects
                return performDetection(videoData, confidenceThreshold)
                    .map(detectionResult -> {
                        long elapsedMs = System.currentTimeMillis() - startTime;
                        detectTimer.record(Duration.ofMillis(elapsedMs));

                        int detectionCount = detectionResult.detections().size();
                        LOG.info("[tenant={}] Vision detection completed: audioId={}, detections={}, elapsedMs={}",
                            tenantId, audioFile.getId(), detectionCount, elapsedMs);

                        return detectionResult;
                    });
            })
            .whenException(e -> {
                LOG.error("[tenant={}] Vision detection failed: {}", tenantId, e.getMessage(), e);
            });
    }

    /**
     * Detect objects in a single frame/image.
     */
    public Promise<DetectionResult> detectFrame(byte[] imageData, double confidenceThreshold) {
        List<DetectedObject> detections = detector.detectObjects(imageData, detectionOptions(confidenceThreshold));
        return Promise.of(new DetectionResult(detections, detections.size(), Duration.ofMillis(0)));
    }

    /**
     * Stream detection results for video frames.
     */
    public void detectStream(
            byte[] videoData,
            double confidenceThreshold,
            java.util.function.Consumer<FrameDetection> onFrame) {
        List<DetectedObject> detections = detector.detectObjects(videoData, detectionOptions(confidenceThreshold));
        onFrame.accept(new FrameDetection(0.0d, 0, detections));
    }

    /**
     * Analyze vision by artifact ID for Data Cloud integration.
     *
     * <p>Artifact-backed analysis must load and authorize artifact bytes through
     * the Data Cloud media repository before invoking {@link #detectAndPersist}.
     *
     * @param artifactId the artifact ID
     * @param tenantId the tenant ID
     * @param analysisType the analysis type
     * @param parameters additional parameters
     * @return Promise containing the frame index ID
     */
    public Promise<String> analyze(String artifactId, String tenantId, String analysisType, Map<String, String> parameters) {
        return Promise.ofException(new IllegalStateException(
            "Artifact-backed vision analysis requires a MediaArtifactRepository-backed adapter; "
                + "PersistentVisionService cannot analyze artifact IDs without loading artifact bytes"));
    }

    private Promise<AudioFileEntity> persistVideoFile(
            String tenantId,
            UUID userId,
            String fileName,
            int fileSize) {

        String extension = getExtension(fileName);

        AudioFileEntity entity = new AudioFileEntity(
            UUID.randomUUID(),
            tenantId,
            userId,
            fileName,
            "/storage/video/" + tenantId + "/" + UUID.randomUUID() + "." + extension,
            extension
        );
        entity.setFileSizeBytes((long) fileSize);
        entity.setStatus(AudioFileEntity.ProcessingStatus.PROCESSING);
        entity.setCreatedAt(Instant.now());
        entity.setUpdatedAt(Instant.now());

        return audioFileService.save(tenantId, entity);
    }

    private Promise<DetectionResult> performDetection(byte[] videoData, double confidenceThreshold) {
        long startTime = System.currentTimeMillis();
        List<DetectedObject> detections = detector.detectObjects(videoData, detectionOptions(confidenceThreshold));
        return Promise.of(new DetectionResult(
            detections,
            detections.size(),
            Duration.ofMillis(System.currentTimeMillis() - startTime)
        ));
    }

    private boolean isImageData(byte[] data) {
        // Simple check: if data is small, assume it's an image
        // In production, use proper mime type detection
        return data.length < 10 * 1024 * 1024; // < 10MB = image
    }

    private String getExtension(String fileName) {
        if (fileName == null || !fileName.contains(".")) {
            return "mp4";
        }
        return fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase();
    }

    /**
     * Detection result for a single video frame.
     */
    public record FrameDetection(
        double timestamp,
        int frameNumber,
        List<DetectedObject> detections
    ) {}

    /**
     * Aggregate detection result for persistence workflows.
     */
    public record DetectionResult(
        List<DetectedObject> detections,
        int detectionCount,
        Duration processingTime
    ) {}

    private DetectionOptions detectionOptions(double confidenceThreshold) {
        return DetectionOptions.builder()
            .confidenceThreshold(confidenceThreshold)
            .build();
    }
}
