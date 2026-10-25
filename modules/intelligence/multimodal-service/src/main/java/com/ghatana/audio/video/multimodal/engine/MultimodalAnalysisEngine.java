package com.ghatana.audio.video.multimodal.engine;

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
    private static final int MAX_MODALITY_BYTES = 32 * 1024 * 1024;

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
        java.util.Objects.requireNonNull(request, "request");
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
        validatePayload(videoData);
        if (sampleFps < 0 || sampleFps > 60) {
            throw new IllegalArgumentException("sampleFps must be between 0 and 60");
        }
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
            validatePayload(audioData);
            LOG.debug("Transcribing {} bytes of audio", audioData.length);
            return mediaGateway.transcribe(audioData);
        } catch (Exception e) {
            LOG.error("STT transcription failed", e);
            return AudioResult.error(e.getMessage());
        }
    }

    private VisualResult analyseImage(byte[] imageData) {
        try {
            validatePayload(imageData);
            LOG.debug("Analysing image ({} bytes)", imageData.length);
            return mediaGateway.analyseImage(imageData);
        } catch (Exception e) {
            LOG.error("Image analysis failed", e);
            return VisualResult.error(e.getMessage());
        }
    }

    private VisualResult analyseVideo(byte[] videoData, int sampleFps, int maxFrames) {
        try {
            validatePayload(videoData);
            if (sampleFps < 0 || sampleFps > 60 || maxFrames < 0 || maxFrames > 100) {
                throw new IllegalArgumentException("Video sampling is outside configured limits");
            }
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

    private static void validatePayload(byte[] payload) {
        if (payload != null && payload.length > MAX_MODALITY_BYTES) {
            throw new IllegalArgumentException("Multimodal modality payload exceeds configured limit");
        }
    }

    /**
     * Associate frame and transcript content using their source timestamps.
     *
     * <p>This association does not measure acoustic/visual synchronization.
     * Until timestamped signal features and a qualified synchronization
     * algorithm are available, each result explicitly reports
     * {@code SYNC_UNDETERMINED} and omits offset/confidence values.
     */
    private List<TemporalAlignment> buildTemporalAlignments(AudioResult audio, VisualResult video) {
        List<TemporalAlignment> alignments = new ArrayList<>();

        if (audio == null || video == null || video.getFrameResults().isEmpty()) {
            return alignments;
        }

        for (FrameResult frame : video.getFrameResults()) {
            String activeText = audio.getTranscriptionAtTimestamp(frame.getTimestamp());
            alignments.add(new TemporalAlignment(
                    frame.getTimestamp(),
                    frame.getFrameNumber(),
                    activeText,
                    frame.getDetections(),
                    0L,
                    0.0,
                    TemporalAlignment.SyncStatus.SYNC_UNDETERMINED));
        }

        return alignments;
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
            if (a.hasTimestamp()) {
                long secs = a.getTimestampMs() / 1000;
                sb.append(String.format("[%ds] ", secs));
            } else {
                sb.append("[time unknown] ");
            }
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

}
