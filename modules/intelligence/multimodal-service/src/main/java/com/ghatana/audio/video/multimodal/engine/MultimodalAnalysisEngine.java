package com.ghatana.audio.video.multimodal.engine;

import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.ColorSpace;
import com.ghatana.media.common.ImageData;
import com.ghatana.media.common.ImageFormat;
import com.ghatana.media.sync.AudioVideoSyncPipeline;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Combined multimodal analysis engine.
 *
 * <p>Coordinates parallel calls to STT, Vision, and TTS services and fuses
 * the results into a single cohesive analysis. All upstream calls are made
 * concurrently to minimise total latency.
 *
 * @doc.type class
 * @doc.purpose Combined audio-visual analysis pipeline
 * @doc.layer intelligence
  * @doc.pattern Component
*/
public class MultimodalAnalysisEngine implements AutoCloseable {

    private static final Logger LOG = LoggerFactory.getLogger(MultimodalAnalysisEngine.class);

    private static final int ANALYSIS_TIMEOUT_SECONDS = 60;

    private final MultimodalMediaGateway mediaGateway;
    private final AudioVideoRuntimeSettings settings;
    private final ExecutorService executor;

    public MultimodalAnalysisEngine(MultimodalMediaGateway mediaGateway) {
        this(mediaGateway, AudioVideoRuntimeSettings.load());
    }

    MultimodalAnalysisEngine(MultimodalMediaGateway mediaGateway, AudioVideoRuntimeSettings settings) {
        this.mediaGateway = mediaGateway;
        this.settings = settings;
        this.executor = Executors.newVirtualThreadPerTaskExecutor();
        LOG.info("MultimodalAnalysisEngine initialised");
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Analyse audio, image, and/or text in parallel and return a fused result.
     *
     * @param request analysis request
     * @return fused multimodal result
     */
    public MultimodalResult analyse(MultimodalRequest request) {
        long startMs = System.currentTimeMillis();

        // Launch parallel tasks only for modalities that are present
        CompletableFuture<AudioResult> audioFuture = request.hasAudio()
                ? CompletableFuture.supplyAsync(() -> transcribeAudio(request.getAudioData()), executor)
                : CompletableFuture.completedFuture(null);

        CompletableFuture<VisualResult> imageFuture = request.hasImage()
                ? CompletableFuture.supplyAsync(() -> analyseImage(request.getImageData()), executor)
                : CompletableFuture.completedFuture(null);

        CompletableFuture<VisualResult> videoFuture = request.hasVideo()
                ? CompletableFuture.supplyAsync(() -> analyseVideo(request.getVideoData(),
                        request.getVideoSampleFps(), request.getVideoMaxFrames()), executor)
                : CompletableFuture.completedFuture(null);

        try {
            // Wait for all futures together
            CompletableFuture.allOf(audioFuture, imageFuture, videoFuture)
                    .get(ANALYSIS_TIMEOUT_SECONDS, TimeUnit.SECONDS);

            AudioResult audio  = audioFuture.get();
            VisualResult image  = imageFuture.get();
            VisualResult video  = videoFuture.get();

            // Merge image + video visual results
            VisualResult visual = mergeVisualResults(image, video);

            String combined = fuse(audio, visual, request.getText());
            long elapsed = System.currentTimeMillis() - startMs;

            LOG.info("Multimodal analysis complete in {}ms (audio={}, image={}, video={}, text={})",
                    elapsed,
                    request.hasAudio(), request.hasImage(), request.hasVideo(),
                    !request.getText().isEmpty());

            return MultimodalResult.builder()
                    .audioResult(audio)
                    .visualResult(visual)
                    .combinedAnalysis(combined)
                    .processingTimeMs(elapsed)
                    .build();

        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new MultimodalException("Analysis interrupted", e);
        } catch (Exception e) {
            throw new MultimodalException("Analysis failed: " + e.getMessage(), e);
        }
    }

    /**
     * Analyse a video together with its audio track.
     *
     * <p>Audio transcription and frame-level object detection run in parallel;
     * results are then temporally aligned so callers can correlate what was
     * said with what was visible at each moment.
     *
     * @param videoData   raw video bytes
     * @param extractAudio whether to transcribe audio
     * @param analyseFrames whether to run object detection on frames
     * @param sampleFps   frames per second to sample
     * @return video-audio result with optional temporal alignment
     */
    public VideoAudioResult analyseVideoWithAudio(byte[] videoData, boolean extractAudio,
                                                   boolean analyseFrames, int sampleFps) {
        long startMs = System.currentTimeMillis();

        CompletableFuture<AudioResult> audioFuture = extractAudio
                ? CompletableFuture.supplyAsync(
                        () -> transcribeAudio(videoData), executor)
                : CompletableFuture.completedFuture(null);

        CompletableFuture<VisualResult> videoFuture = analyseFrames
                ? CompletableFuture.supplyAsync(
                        () -> analyseVideo(videoData, sampleFps, 100), executor)
                : CompletableFuture.completedFuture(null);

        try {
            CompletableFuture.allOf(audioFuture, videoFuture)
                    .get(ANALYSIS_TIMEOUT_SECONDS, TimeUnit.SECONDS);

            AudioResult audio  = audioFuture.get();
            VisualResult video  = videoFuture.get();

            List<TemporalAlignment> alignments = buildTemporalAlignments(audio, video);
            String narrative = buildNarrative(audio, video, alignments);
            long elapsed = System.currentTimeMillis() - startMs;

            return VideoAudioResult.builder()
                    .audioResult(audio)
                    .videoResult(video)
                    .temporalAlignments(alignments)
                    .combinedNarrative(narrative)
                    .processingTimeMs(elapsed)
                    .build();

        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new MultimodalException("Video-audio analysis interrupted", e);
        } catch (Exception e) {
            throw new MultimodalException("Video-audio analysis failed: " + e.getMessage(), e);
        }
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private AudioResult transcribeAudio(byte[] audioData) {
        try {
            LOG.debug("Transcribing {} bytes of audio", audioData.length);
            return mediaGateway.transcribe(audioData);
        } catch (Exception e) {
            LOG.error("STT transcription failed", e);
            return AudioResult.error(e.getMessage());
        }
    }

    private VisualResult analyseImage(byte[] imageData) {
        try {
            LOG.debug("Analysing image ({} bytes)", imageData.length);
            return mediaGateway.analyseImage(imageData);
        } catch (Exception e) {
            LOG.error("Image analysis failed", e);
            return VisualResult.error(e.getMessage());
        }
    }

    private VisualResult analyseVideo(byte[] videoData, int sampleFps, int maxFrames) {
        try {
            LOG.debug("Analysing video ({} bytes, {}fps, max {} frames)",
                    videoData.length, sampleFps, maxFrames);
            return mediaGateway.analyseVideo(videoData, sampleFps, maxFrames);
        } catch (Exception e) {
            LOG.error("Video analysis failed", e);
            return VisualResult.error(e.getMessage());
        }
    }

    private VisualResult mergeVisualResults(VisualResult image, VisualResult video) {
        if (image == null && video == null) return null;
        if (image == null) return video;
        if (video == null) return image;

        // Combine detections from both
        List<DetectionResult> merged = new ArrayList<>(image.getDetections());
        merged.addAll(video.getDetections());

        String scene = image.getSceneDescription() != null
                ? image.getSceneDescription()
                : video.getSceneDescription();

        return VisualResult.builder()
                .sceneDescription(scene)
                .detections(merged)
                .frameResults(video.getFrameResults())
                .confidence(Math.max(
                        image.getConfidence() != null ? image.getConfidence() : 0.0,
                        video.getConfidence() != null ? video.getConfidence() : 0.0))
                .build();
    }

    private String fuse(AudioResult audio, VisualResult visual, String text) {
        StringBuilder sb = new StringBuilder("Multimodal analysis: ");
        int parts = 0;

        if (audio != null && !audio.isError()) {
            sb.append("Speech: \"").append(audio.getTranscription()).append("\"");
            parts++;
        }

        if (visual != null && !visual.isError()) {
            if (parts > 0) sb.append("; ");
            sb.append("Visual: ").append(visual.getSceneDescription());
            if (!visual.getDetections().isEmpty()) {
                sb.append(" [").append(summariseDetections(visual.getDetections())).append("]");
            }
            parts++;
        }

        if (text != null && !text.isEmpty()) {
            if (parts > 0) sb.append("; ");
            sb.append("Text context: ").append(text);
        }

        if (parts == 0) {
            sb.append("No content to analyse.");
        }

        return sb.toString();
    }

    private String summariseDetections(List<DetectionResult> detections) {
        Map<String, Long> counts = new HashMap<>();
        for (DetectionResult d : detections) {
            counts.merge(d.getClassName(), 1L, Long::sum);
        }
        List<String> parts = new ArrayList<>();
        counts.forEach((cls, cnt) -> parts.add(cnt + "x " + cls));
        return String.join(", ", parts);
    }

    /**
     * Align each video frame with its corresponding audio segment using PTS-based
     * drift correction.
     *
     * <p>Algorithm:
     * <ol>
     *   <li>Estimate a global audio/video drift via least-squares minimisation over
     *       all (audio-segment-mid-PTS, frame-PTS) pairs — O(F×S) but frame counts
     *       are small in practice.</li>
     *   <li>Apply the drift offset before querying the audio transcription so that
     *       a corrected video PTS is used.</li>
     *   <li>Compute per-frame sync confidence: 1 − min(1, |offsetMs| / MAX_DRIFT_MS).</li>
     * </ol>
     */
    private List<TemporalAlignment> buildTemporalAlignments(AudioResult audio, VisualResult video) {
        List<TemporalAlignment> alignments = new ArrayList<>();

        if (audio == null || video == null || video.getFrameResults().isEmpty()) {
            return alignments;
        }

        SyncAssessment syncAssessment = assessSync(audio, video);
        long driftMs = syncAssessment.driftMs();
        if (Math.abs(driftMs) > 1L) {
            LOG.debug("A/V drift estimated at {}ms — applying PTS correction", driftMs);
        }

        for (FrameResult frame : video.getFrameResults()) {
            // Corrected PTS: shift video timestamp by the measured drift
            long correctedPtsMs = frame.getTimestampMs() + driftMs;
            String activeText   = audio.getTranscriptionAtTimestamp(correctedPtsMs);
                double confidence   = computeSyncConfidence(syncAssessment.averageDriftMs(), syncAssessment.quality());
            alignments.add(new TemporalAlignment(
                    frame.getTimestampMs(),
                    frame.getFrameNumber(),
                    activeText,
                    frame.getDetections(),
                    driftMs,
                    confidence));
        }

        return alignments;
    }

    private SyncAssessment assessSync(AudioResult audio, VisualResult video) {
        long fallbackDriftMs = estimateDriftMs(audio, video);
        if (audio == null || video == null || video.getFrameResults().isEmpty()) {
            return new SyncAssessment(fallbackDriftMs, Math.abs(fallbackDriftMs), AudioVideoSyncPipeline.SyncQuality.GOOD);
        }

        try (AudioVideoSyncPipeline pipeline = new AudioVideoSyncPipeline(
                null,
                settings.syncAudioBufferMs(),
                settings.syncVideoBufferMs(),
                settings.syncToleranceMs())) {
            for (AudioResult.TimedSegment segment : audio.getTimedSegments()) {
                long midpointUs = ((segment.getStartMs() + segment.getEndMs()) / 2) * 1000;
                pipeline.feedAudio(dummyAudioFrame(), midpointUs);
            }
            for (FrameResult frame : video.getFrameResults()) {
                pipeline.feedVideo(dummyVideoFrame(), frame.getTimestampMs() * 1000);
            }
            try {
                Thread.sleep(Math.min(100L, Math.max(16L, video.getFrameResults().size() * 16L)));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return new SyncAssessment(
                    pipeline.getLastDriftMs(),
                    pipeline.getQualityMetrics().getAverageDrift(),
                    pipeline.getQualityMetrics().getCurrentQuality());
        } catch (Exception e) {
            LOG.debug("Falling back to local sync estimate after pipeline failure", e);
            return new SyncAssessment(fallbackDriftMs, Math.abs(fallbackDriftMs), AudioVideoSyncPipeline.SyncQuality.GOOD);
        }
    }

    /**
     * Estimate the audio-vs-video PTS drift via the median of per-segment offsets.
     * Returns 0 if no timed segments are available.
     */
    private long estimateDriftMs(AudioResult audio, VisualResult video) {
        List<AudioResult.TimedSegment> segments = audio.getTimedSegments();
        List<FrameResult> frames = video.getFrameResults();

        if (segments == null || segments.isEmpty() || frames.isEmpty()) {
            return 0L;
        }

        // For each segment, find the closest frame by PTS and record the delta
        List<Long> deltas = new ArrayList<>();
        for (AudioResult.TimedSegment seg : segments) {
            long segMid = (seg.getStartMs() + seg.getEndMs()) / 2;
            long bestDelta = Long.MAX_VALUE;
            long bestFramePts = 0;
            for (FrameResult f : frames) {
                long d = Math.abs(f.getTimestampMs() - segMid);
                if (d < bestDelta) { bestDelta = d; bestFramePts = f.getTimestampMs(); }
            }
            deltas.add(segMid - bestFramePts); // positive = audio leads
        }

        // Median is more robust than mean to outliers
        deltas.sort(Long::compare);
        return deltas.get(deltas.size() / 2);
    }

    /** Confidence decreases with average drift and is capped by platform sync quality. */
    private static double computeSyncConfidence(double averageDriftMs, AudioVideoSyncPipeline.SyncQuality quality) {
        double base = Math.max(0.0, 1.0 - averageDriftMs / 500.0);
        return switch (quality) {
            case EXCELLENT -> base;
            case GOOD -> Math.min(base, 0.9);
            case FAIR -> Math.min(base, 0.7);
            case POOR -> Math.min(base, 0.4);
        };
    }

    private String buildNarrative(AudioResult audio, VisualResult video,
                                   List<TemporalAlignment> alignments) {
        if (alignments.isEmpty()) {
            String audioText = (audio != null && !audio.isError())
                    ? audio.getTranscription() : "";
            String videoText = (video != null && !video.isError())
                    ? video.getSceneDescription() : "";
            return "Video: " + videoText + (audioText.isEmpty() ? "" : ". Audio: " + audioText);
        }

        // Build narrative from first few key alignment points
        StringBuilder sb = new StringBuilder();
        int shown = 0;
        for (TemporalAlignment a : alignments) {
            if (shown >= 5) {
                sb.append("... and ").append(alignments.size() - 5).append(" more moments.");
                break;
            }
            long secs = a.getTimestampMs() / 1000;
            sb.append(String.format("[%ds] ", secs));
            if (a.getSpeechText() != null && !a.getSpeechText().isEmpty()) {
                sb.append("\"").append(a.getSpeechText()).append("\" ");
            }
            if (!a.getDetections().isEmpty()) {
                sb.append("(").append(summariseDetections(a.getDetections())).append(") ");
            }
            shown++;
        }
        return sb.toString().trim();
    }

    @Override
    public void close() {
        mediaGateway.close();
        executor.shutdown();
        try {
            if (!executor.awaitTermination(5, TimeUnit.SECONDS)) {
                executor.shutdownNow();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            executor.shutdownNow();
        }
    }

    private static AudioData dummyAudioFrame() {
        return new AudioData(new byte[] {0, 0}, 16000, 1, 16);
    }

    private static ImageData dummyVideoFrame() {
        return new ImageData(new byte[] {0}, 1, 1, ImageFormat.PNG, ColorSpace.RGB);
    }

    private record SyncAssessment(long driftMs, double averageDriftMs,
                                  AudioVideoSyncPipeline.SyncQuality quality) {}
}
