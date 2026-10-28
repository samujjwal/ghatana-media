package com.ghatana.audio.video.multimodal.engine;

import com.ghatana.audiovideo.observability.MediaWorkflowMetrics;
import io.opentelemetry.context.Context;
import io.grpc.Context.CancellationListener;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.RejectedExecutionException;

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
    private static final int MAX_ANALYSIS_ADMISSIONS = 64;
    private static final int MAX_MODALITY_BYTES = 32 * 1024 * 1024;
    private static final String SOURCE_GROUNDING_ABSTENTION = "ABSTAIN: SOURCE_REFERENCES_INCOMPLETE";

    private final MultimodalMediaGateway mediaGateway;
    private final ExecutorService executor;
    private final Semaphore admissions;
    private final long analysisTimeoutNanos;
    private final MediaWorkflowMetrics metrics;

    public MultimodalAnalysisEngine(MultimodalMediaGateway mediaGateway) {
        this(mediaGateway, AudioVideoRuntimeSettings.load(),
                new MediaWorkflowMetrics(io.micrometer.core.instrument.Metrics.globalRegistry, "multimodal"));
    }

    public MultimodalAnalysisEngine(MultimodalMediaGateway mediaGateway, MediaWorkflowMetrics metrics) {
        this(mediaGateway, AudioVideoRuntimeSettings.load(), metrics);
    }

    private MultimodalAnalysisEngine(MultimodalMediaGateway mediaGateway, AudioVideoRuntimeSettings settings,
                                     MediaWorkflowMetrics metrics) {
        this(mediaGateway, settings, TimeUnit.SECONDS.toNanos(ANALYSIS_TIMEOUT_SECONDS), metrics);
    }

    MultimodalAnalysisEngine(MultimodalMediaGateway mediaGateway, AudioVideoRuntimeSettings settings) {
        this(mediaGateway, settings, TimeUnit.SECONDS.toNanos(ANALYSIS_TIMEOUT_SECONDS),
                new MediaWorkflowMetrics(io.micrometer.core.instrument.Metrics.globalRegistry, "multimodal"));
    }

    MultimodalAnalysisEngine(MultimodalMediaGateway mediaGateway, AudioVideoRuntimeSettings settings,
                             long analysisTimeoutNanos) {
        this(mediaGateway, settings, analysisTimeoutNanos,
                new MediaWorkflowMetrics(io.micrometer.core.instrument.Metrics.globalRegistry, "multimodal"));
    }

    MultimodalAnalysisEngine(MultimodalMediaGateway mediaGateway, AudioVideoRuntimeSettings settings,
                             long analysisTimeoutNanos, MediaWorkflowMetrics metrics) {
        this.mediaGateway = java.util.Objects.requireNonNull(mediaGateway, "mediaGateway");
        this.metrics = java.util.Objects.requireNonNull(metrics, "metrics");
        java.util.Objects.requireNonNull(settings, "settings");
        if (analysisTimeoutNanos <= 0) throw new IllegalArgumentException("analysis timeout must be positive");
        this.analysisTimeoutNanos = analysisTimeoutNanos;
        int permits = Math.max(1, Math.min(MAX_ANALYSIS_ADMISSIONS, settings.maxInputStreams()));
        this.admissions = new Semaphore(permits, true);
        AtomicInteger threadNumber = new AtomicInteger();
        this.executor = new ThreadPoolExecutor(permits, permits, 0L, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(permits * 3), runnable -> {
                    Thread thread = new Thread(runnable, "media-multimodal-" + threadNumber.incrementAndGet());
                    thread.setDaemon(true);
                    return thread;
                }, new ThreadPoolExecutor.AbortPolicy());
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
        List<Future<?>> children = new ArrayList<>();
        RequestCancellation cancellation = null;
        boolean admissionAcquired = false;

        try {
            cancellation = new RequestCancellation(io.grpc.Context.current(), Thread.currentThread());
            cancellation.preflight();
            acquireAdmission();
            admissionAcquired = true;
            long startMs = System.currentTimeMillis();
            Future<AudioResult> audioFuture = request.hasAudio()
                    ? submit(children, cancellation, () -> transcribeAudio(request.getAudioData())) : null;
            Future<VisualResult> imageFuture = request.hasImage()
                    ? submit(children, cancellation, () -> analyseImage(request.getImageData())) : null;
            Future<VisualResult> videoFuture = request.hasVideo()
                    ? submit(children, cancellation, () -> analyseVideo(request.getVideoData(),
                            request.getVideoSampleFps(), request.getVideoMaxFrames())) : null;
            long deadline = System.nanoTime() + analysisTimeoutNanos;
            AudioResult audio = await(audioFuture, deadline);
            VisualResult image = await(imageFuture, deadline);
            VisualResult video = await(videoFuture, deadline);

            // Merge image + video visual results
            VisualResult visual = mergeVisualResults(image, video);
            MultimodalResult.Outcome outcome = modalityOutcome(
                    request.hasAudio(), audio,
                    request.hasImage(), image,
                    request.hasVideo(), video);

            String combined = fuse(audio, visual, request.getText());
            long elapsed = System.currentTimeMillis() - startMs;

            LOG.info("Multimodal analysis complete in {}ms (audio={}, image={}, video={}, text={})",
                    elapsed,
                    request.hasAudio(), request.hasImage(), request.hasVideo(),
                    !request.getText().isEmpty());

            MultimodalResult result = MultimodalResult.builder()
                    .audioResult(audio)
                    .visualResult(visual)
                    .combinedAnalysis(combined)
                    .processingTimeMs(elapsed)
                    .outcome(outcome)
                    .build();
            cancellation.finishNormally();
            return result;

        } catch (InterruptedException e) {
            if (cancellation != null) cancellation.finishFailure();
            cancel(children);
            Thread.currentThread().interrupt();
            throw new MultimodalException("Analysis interrupted");
        } catch (TimeoutException e) {
            boolean cancellationWon = cancellation != null && cancellation.finishFailure();
            cancel(children);
            if (cancellationWon) {
                Thread.currentThread().interrupt();
                throw new MultimodalException("Analysis interrupted");
            }
            throw new MultimodalException("Analysis outcome unavailable: deadline exceeded");
        } catch (ExecutionException | RejectedExecutionException e) {
            boolean cancellationWon = cancellation != null && cancellation.finishFailure();
            cancel(children);
            if (cancellationWon) {
                Thread.currentThread().interrupt();
                throw new MultimodalException("Analysis interrupted");
            }
            throw new MultimodalException("Analysis outcome unavailable");
        } catch (RuntimeException e) {
            boolean cancellationWon = cancellation != null && cancellation.finishFailure();
            cancel(children);
            if (cancellationWon) {
                Thread.currentThread().interrupt();
                throw new MultimodalException("Analysis interrupted");
            }
            throw e;
        } finally {
            if (cancellation != null) cancellation.close();
            if (admissionAcquired) admissions.release();
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
        List<Future<?>> children = new ArrayList<>();
        RequestCancellation cancellation = null;
        boolean admissionAcquired = false;

        try {
            cancellation = new RequestCancellation(io.grpc.Context.current(), Thread.currentThread());
            cancellation.preflight();
            acquireAdmission();
            admissionAcquired = true;
            long startMs = System.currentTimeMillis();
            Future<AudioResult> audioFuture = extractAudio
                    ? submit(children, cancellation, () -> transcribeVideoAudio(videoData)) : null;
            Future<VisualResult> videoFuture = analyseFrames
                    ? submit(children, cancellation, () -> analyseVideo(videoData, sampleFps, 100)) : null;
            long deadline = System.nanoTime() + analysisTimeoutNanos;
            AudioResult audio = await(audioFuture, deadline);
            VisualResult video = await(videoFuture, deadline);

            List<TemporalAlignment> alignments = buildTemporalAlignments(audio, video);
            String narrative = buildNarrative(audio, video, alignments);
            long elapsed = System.currentTimeMillis() - startMs;

            VideoAudioResult result = VideoAudioResult.builder()
                    .audioResult(audio)
                    .videoResult(video)
                    .temporalAlignments(alignments)
                    .combinedNarrative(narrative)
                    .processingTimeMs(elapsed)
                    .build();
            cancellation.finishNormally();
            return result;

        } catch (InterruptedException e) {
            if (cancellation != null) cancellation.finishFailure();
            cancel(children);
            Thread.currentThread().interrupt();
            throw new MultimodalException("Video-audio analysis interrupted");
        } catch (TimeoutException e) {
            boolean cancellationWon = cancellation != null && cancellation.finishFailure();
            cancel(children);
            if (cancellationWon) {
                Thread.currentThread().interrupt();
                throw new MultimodalException("Video-audio analysis interrupted");
            }
            throw new MultimodalException("Video-audio analysis outcome unavailable: deadline exceeded");
        } catch (ExecutionException | RejectedExecutionException e) {
            boolean cancellationWon = cancellation != null && cancellation.finishFailure();
            cancel(children);
            if (cancellationWon) {
                Thread.currentThread().interrupt();
                throw new MultimodalException("Video-audio analysis interrupted");
            }
            throw new MultimodalException("Video-audio analysis outcome unavailable");
        } catch (RuntimeException e) {
            boolean cancellationWon = cancellation != null && cancellation.finishFailure();
            cancel(children);
            if (cancellationWon) {
                Thread.currentThread().interrupt();
                throw new MultimodalException("Video-audio analysis interrupted");
            }
            throw e;
        } finally {
            if (cancellation != null) cancellation.close();
            if (admissionAcquired) admissions.release();
        }
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private ProviderMeasurement providerMeasurement(MediaWorkflowMetrics.Modality modality) {
        return new ProviderMeasurement(metrics.startModalityTimer(modality,
                MediaWorkflowMetrics.Boundary.PROVIDER));
    }

    /** Single-use provider scope; an exception or cancellation that escapes stays UNKNOWN. */
    private final class ProviderMeasurement implements AutoCloseable {
        private final MediaWorkflowMetrics.ModalityTimingSample sample;
        private MediaWorkflowMetrics.Outcome outcome;

        private ProviderMeasurement(MediaWorkflowMetrics.ModalityTimingSample sample) {
            this.sample = sample;
        }

        private void complete(MediaWorkflowMetrics.Outcome observedOutcome) {
            outcome = observedOutcome;
        }

        @Override
        public void close() {
            metrics.stopModalityTimer(sample, outcome == null ? MediaWorkflowMetrics.Outcome.UNKNOWN : outcome);
        }
    }

    private AudioResult transcribeAudio(byte[] audioData) {
        LOG.debug("Transcribing {} bytes of audio", audioData.length);
        try (ProviderMeasurement boundary = providerMeasurement(MediaWorkflowMetrics.Modality.STT)) {
            AudioResult result = mediaGateway.transcribe(audioData);
            if (result == null || result.isError()) {
                boundary.complete(MediaWorkflowMetrics.Outcome.FAILURE);
                return AudioResult.error("Audio transcription unavailable");
            }
            boundary.complete(MediaWorkflowMetrics.Outcome.SUCCESS);
            return result;
        }
    }

    /** Decode a bounded audio stream before STT. Video-container bytes are never sent to STT. */
    private AudioResult transcribeVideoAudio(byte[] videoData) {
        final com.ghatana.audio.video.vision.video.VideoFrameExtractor.ExtractedAudioTrack track;
        try {
            track = mediaGateway.extractAudioTrack(videoData);
        } catch (java.io.IOException | UnsupportedOperationException unavailable) {
            LOG.info("Video audio track is unavailable or not admitted ({})", unavailable.getClass().getSimpleName());
            return AudioResult.error("Video audio track unavailable");
        }
        if (track == null) return AudioResult.error("Video audio track unavailable");
        return transcribeAudio(track.pcmS16le());
    }

    private VisualResult analyseImage(byte[] imageData) {
        LOG.debug("Analysing image ({} bytes)", imageData.length);
        try (ProviderMeasurement boundary = providerMeasurement(MediaWorkflowMetrics.Modality.VISION)) {
            VisualResult result = mediaGateway.analyseImage(imageData);
            if (result == null || result.isError()) {
                boundary.complete(MediaWorkflowMetrics.Outcome.FAILURE);
                return VisualResult.error("Image analysis unavailable");
            }
            boundary.complete(MediaWorkflowMetrics.Outcome.SUCCESS);
            return result;
        }
    }

    private VisualResult analyseVideo(byte[] videoData, int sampleFps, int maxFrames) {
        if (sampleFps < 0 || sampleFps > 60 || maxFrames < 0 || maxFrames > 100) {
            throw new IllegalArgumentException("Video sampling is outside configured limits");
        }
        LOG.debug("Analysing video ({} bytes, {}fps, max {} frames)",
                videoData.length, sampleFps, maxFrames);
        try (ProviderMeasurement boundary = providerMeasurement(MediaWorkflowMetrics.Modality.VISION)) {
            VisualResult result = mediaGateway.analyseVideo(videoData, sampleFps, maxFrames);
            if (result == null || result.isError()) {
                boundary.complete(MediaWorkflowMetrics.Outcome.FAILURE);
                return VisualResult.error("Video analysis unavailable");
            }
            boundary.complete(MediaWorkflowMetrics.Outcome.SUCCESS);
            return result;
        }
    }

    private VisualResult mergeVisualResults(VisualResult image, VisualResult video) {
        if (image == null && video == null) return null;
        if ((image != null && image.isError()) || (video != null && video.isError())) {
            // VisualResult has no PARTIAL disposition. Do not expose the successful child as an
            // aggregate success; the available child is intentionally dropped pending that contract.
            return VisualResult.error("Visual analysis unavailable");
        }
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
                .build();
    }

    private static MultimodalResult.Outcome modalityOutcome(
            boolean audioRequested, AudioResult audio,
            boolean imageRequested, VisualResult image,
            boolean videoRequested, VisualResult video) {
        int requested = 0;
        int succeeded = 0;
        int failed = 0;
        if (audioRequested) {
            requested++;
            if (audio == null || audio.isError()) failed++;
            else succeeded++;
        }
        if (imageRequested) {
            requested++;
            if (image == null || image.isError()) failed++;
            else succeeded++;
        }
        if (videoRequested) {
            requested++;
            if (video == null || video.isError()) failed++;
            else succeeded++;
        }
        if (requested == 0) return MultimodalResult.Outcome.NO_MODALITY;
        if (failed == 0) return MultimodalResult.Outcome.COMPLETE;
        return succeeded == 0 ? MultimodalResult.Outcome.FAILED : MultimodalResult.Outcome.PARTIAL;
    }

    private void acquireAdmission() {
        if (!admissions.tryAcquire()) {
            throw new MultimodalException("Analysis capacity unavailable");
        }
    }

    private <T> Future<T> submit(List<Future<?>> children, RequestCancellation cancellation,
                                 java.util.concurrent.Callable<T> task) throws InterruptedException {
        return cancellation.submit(() -> {
            Future<T> child = executor.submit(Context.current().wrap(task));
            children.add(child);
            return child;
        });
    }

    /** Serializes request cancellation with child dispatch and successful completion. */
    static final class RequestCancellation implements AutoCloseable {
        private final io.grpc.Context context;
        private final Thread caller;
        private final Object lock = new Object();
        private final CancellationListener listener;
        private boolean active = true;
        private boolean cancelled;

        RequestCancellation(io.grpc.Context context, Thread caller) {
            this.context = java.util.Objects.requireNonNull(context, "context");
            this.caller = java.util.Objects.requireNonNull(caller, "caller");
            this.listener = ignored -> {
                synchronized (lock) {
                    if (active) {
                        cancelled = true;
                        caller.interrupt();
                    }
                }
            };
            context.addListener(listener, Runnable::run);
        }

        void preflight() throws InterruptedException {
            synchronized (lock) {
                rejectIfCancelled();
            }
        }

        <T> T submit(java.util.concurrent.Callable<T> dispatch) throws InterruptedException {
            synchronized (lock) {
                rejectIfCancelled();
                try {
                    return dispatch.call();
                } catch (InterruptedException interrupted) {
                    throw interrupted;
                } catch (RuntimeException | Error failure) {
                    throw failure;
                } catch (Exception failure) {
                    throw new java.util.concurrent.RejectedExecutionException(failure);
                }
            }
        }

        void finishNormally() throws InterruptedException {
            synchronized (lock) {
                rejectIfCancelled();
                active = false;
            }
        }

        /** Return true when cancellation won against an exceptional terminal result. */
        boolean finishFailure() {
            synchronized (lock) {
                boolean cancellationWon = cancelled || context.isCancelled();
                active = false;
                return cancellationWon;
            }
        }

        private void rejectIfCancelled() throws InterruptedException {
            if (cancelled || context.isCancelled()) {
                cancelled = true;
                throw new InterruptedException("gRPC request cancelled");
            }
        }

        @Override
        public void close() {
            synchronized (lock) {
                active = false;
            }
            context.removeListener(listener);
        }
    }

    private static <T> T await(Future<T> future, long deadlineNanos)
            throws InterruptedException, ExecutionException, TimeoutException {
        if (future == null) return null;
        long remaining = deadlineNanos - System.nanoTime();
        if (remaining <= 0) throw new TimeoutException();
        return future.get(remaining, TimeUnit.NANOSECONDS);
    }

    private static void cancel(List<Future<?>> children) {
        for (Future<?> child : children) child.cancel(true);
    }

    private String fuse(AudioResult audio, VisualResult visual, String text) {
        // Current result contracts do not carry source version, stable frame/word/region
        // references, or claim-level uncertainty. Do not turn provider text or caller context
        // into a generated description until those references and qualified semantics exist.
        return SOURCE_GROUNDING_ABSTENTION;
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
            String activeText = transcriptionAtFrameTimestamp(audio, frame.getTimestamp());
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

    /** Match only within the same explicit clock identity and exact transcript window. */
    private static String transcriptionAtFrameTimestamp(AudioResult audio, MediaClockTimestamp timestamp) {
        if (audio == null || audio.isError() || timestamp == null || !timestamp.isKnown()) return "";
        List<AudioResult.TimedSegment> segments = audio.getTimedSegments();
        if (segments == null || segments.isEmpty()) return "";
        for (AudioResult.TimedSegment segment : segments) {
            if (TemporalAlignment.isWithinClockWindow(timestamp, segment.getStartTime(), segment.getEndTime())) {
                return segment.getText();
            }
        }
        return "";
    }

    private String buildNarrative(AudioResult audio, VisualResult video,
                                   List<TemporalAlignment> alignments) {
        // Timestamps alone do not provide frame/word/region version references or establish
        // shared-clock semantics. Keep the structured temporal associations separately and abstain
        // from composing them into a descriptive claim.
        return SOURCE_GROUNDING_ABSTENTION;
    }

    @Override
    public void close() {
        try {
            mediaGateway.close();
        } finally {
            // A provider/channel close failure must not leave the bounded worker pool live.
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

}
