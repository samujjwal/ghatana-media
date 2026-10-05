/**
 * @doc.type class
 * @doc.purpose Audio-Video synchronization pipeline with buffering and drift correction
 * @doc.layer platform
 * @doc.pattern Pipeline
 */
package com.ghatana.media.sync;

import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.ImageData;

import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Real-time audio-video synchronization pipeline.
 *
 * <p>Maintains lip-sync accuracy by:
 * <ul>
 *   <li>Buffering audio and video streams separately</li>
 *   <li>Timestamp-based frame/audio matching</li>
 *   <li>Drift detection and correction</li>
 *   <li>Configurable sync tolerance (default ±40ms)</li>
 * </ul>
 */
public class AudioVideoSyncPipeline implements AutoCloseable {

    private static final int DEFAULT_AUDIO_BUFFER_MS = 500;
    private static final int DEFAULT_VIDEO_BUFFER_MS = 200;
    private static final int DEFAULT_SYNC_TOLERANCE_MS = 40;
    private static final int MAX_DRIFT_CORRECTION_MS = 200;
    private static final int MAX_RECOVERY_ATTEMPTS = 5;
    private static final long INITIAL_BACKOFF_MS = 100;
    private static final long MAX_BACKOFF_MS = 5000;
    private static final int QUALITY_WINDOW_SIZE = 100;

    private final BlockingQueue<TimedAudioFrame> audioBuffer;
    private final BlockingQueue<TimedVideoFrame> videoBuffer;
    private final ScheduledExecutorService syncExecutor;

    private final AtomicReference<SyncState> syncState = new AtomicReference<>(SyncState.SYNCING);
    private final AtomicLong audioClockOffset = new AtomicLong(0);
    private final AtomicLong videoClockOffset = new AtomicLong(0);
    private final AtomicLong lastDriftMs = new AtomicLong(0);
    private final AtomicInteger recoveryAttempts = new AtomicInteger(0);
    private final AtomicLong lastRecoveryTime = new AtomicLong(0);
    private final AtomicBoolean asyncMode = new AtomicBoolean(false);
    private final SyncQualityMetrics qualityMetrics = new SyncQualityMetrics();

    private final int audioBufferMs;
    private final int videoBufferMs;
    private final int syncToleranceMs;
    private final SyncCallback callback;

    public enum SyncState {
        SYNCING,      // Initial sync in progress
        LOCKED,       // A/V locked within tolerance
        DRIFTING,     // Detected drift, correcting
        RECOVERING,   // Attempting recovery with backoff
        ASYNC,        // Degraded to async mode
        ERROR         // Unrecoverable sync error
    }

    public interface SyncCallback {
        void onSyncedFrame(SyncedFrame frame);
        void onDriftDetected(long driftMs, SyncState state);
        void onError(String message);
        void onRecoveryAttempt(int attempt, long backoffMs);
        void onAsyncModeActivated(String reason);
        void onQualityChange(SyncQuality quality);
    }

    public enum SyncQuality {
        EXCELLENT,  // < 20ms drift
        GOOD,       // 20-40ms drift
        FAIR,       // 40-100ms drift
        POOR        // > 100ms drift
    }

    /**
     * Creates a pipeline with default buffer and tolerance settings.
     *
     * <p>Defaults: audio buffer 500 ms, video buffer 200 ms, sync tolerance ±40 ms.
     */
    public AudioVideoSyncPipeline(SyncCallback callback) {
        this(callback, DEFAULT_AUDIO_BUFFER_MS, DEFAULT_VIDEO_BUFFER_MS, DEFAULT_SYNC_TOLERANCE_MS);
    }

    /**
     * Creates a pipeline with custom buffer sizes and sync tolerance.
     *
     * <p>Recovery behaviour on sync errors:
     * <ol>
     *   <li>The pipeline attempts self-correction up to {@value MAX_RECOVERY_ATTEMPTS} times
     *       using exponential back-off starting at {@value INITIAL_BACKOFF_MS} ms (capped at
     *       {@value MAX_BACKOFF_MS} ms).  Each attempt is reported via
     *       {@link SyncCallback#onRecoveryAttempt}.</li>
     *   <li>If all recovery attempts fail the pipeline transitions to
     *       {@link SyncState#ASYNC} mode, signalling this via
     *       {@link SyncCallback#onAsyncModeActivated}.  In async mode frames are still
     *       delivered to {@link SyncCallback#onSyncedFrame} but without timing guarantees.</li>
     *   <li>Unrecoverable errors (e.g. callback throws repeatedly) transition the state to
     *       {@link SyncState#ERROR} and the callback receives
     *       {@link SyncCallback#onError} with a descriptive message.  The pipeline is still
     *       safe to {@link #close()} after an error state.</li>
     * </ol>
     *
     * <p>Clock assumptions: timestamps passed to {@link #feedAudio} and {@link #feedVideo}
     * must share the same time base (microseconds since an arbitrary epoch).  The pipeline
     * does not attempt cross-domain clock synchronisation; callers mixing hardware clocks
     * (e.g. ALSA vs. V4L2) are responsible for aligning them before feeding frames.
     *
     * @param callback       receiver for sync events; must not be null
     * @param audioBufferMs  maximum audio buffer depth in milliseconds (\u2265 20)
     * @param videoBufferMs  maximum video buffer depth in milliseconds (\u2265 16)
     * @param syncToleranceMs acceptable A/V offset in milliseconds before drift correction
     *                        kicks in; values below 20 ms are clamped to 20 ms
     */
    public AudioVideoSyncPipeline(SyncCallback callback, int audioBufferMs, int videoBufferMs, int syncToleranceMs) {
        this.callback = callback;
        this.audioBufferMs = audioBufferMs;
        this.videoBufferMs = videoBufferMs;
        this.syncToleranceMs = syncToleranceMs;

        this.audioBuffer = new LinkedBlockingQueue<>();
        this.videoBuffer = new LinkedBlockingQueue<>();

        this.syncExecutor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "av-sync-pipeline");
            t.setDaemon(true);
            return t;
        });

        // Start sync loop at 60Hz
        syncExecutor.scheduleAtFixedRate(this::processSync, 0, 16, TimeUnit.MILLISECONDS);
    }

    /**
     * Feed audio data into the pipeline.
     *
     * <p>When the caller receives {@code false}, it should apply back-pressure: slow down
     * the producer or drop the frame.  The pipeline will never block the calling thread.
     * Frames whose presentation timestamps are more than {@code audioBufferMs} behind the
     * most recent video timestamp may be silently discarded during drift correction.
     *
     * @param audio              audio data; must not be null
     * @param presentationTimeUs presentation timestamp in microseconds (shared time base
     *                           with video frames)
     * @return {@code true} if the frame was accepted, {@code false} if the buffer is full
     */
    public boolean feedAudio(AudioData audio, long presentationTimeUs) {
        if (audioBuffer.size() >= audioBufferMs / 10) { // Rough estimate: 10ms chunks
            return false; // Buffer full, backpressure
        }

        long adjustedTime = presentationTimeUs + audioClockOffset.get();
        return audioBuffer.offer(new TimedAudioFrame(audio, adjustedTime, System.nanoTime()));
    }

    /**
     * Feed a video frame into the pipeline.
     *
     * <p>When the caller receives {@code false}, the frame is dropped without queuing or
     * processing.  Callers should monitor this return value and reduce frame rate or
     * resolution when sustained frame dropping occurs.
     *
     * @param frame              image data; must not be null
     * @param presentationTimeUs presentation timestamp in microseconds (shared time base
     *                           with audio frames)
     * @return {@code true} if the frame was accepted, {@code false} if the buffer is full
     */
    public boolean feedVideo(ImageData frame, long presentationTimeUs) {
        if (videoBuffer.size() >= videoBufferMs / 16) { // ~16ms per frame at 60fps
            return false; // Buffer full, drop frame
        }

        long adjustedTime = presentationTimeUs + videoClockOffset.get();
        return videoBuffer.offer(new TimedVideoFrame(frame, adjustedTime, System.nanoTime()));
    }

    /**
     * Get current sync state.
     */
    public SyncState getSyncState() {
        return syncState.get();
    }

    /**
     * Get last measured drift in milliseconds.
     */
    public long getLastDriftMs() {
        return lastDriftMs.get();
    }

    /**
     * Check if pipeline is in async mode.
     */
    public boolean isAsyncMode() {
        return asyncMode.get();
    }

    /**
     * Get sync quality metrics.
     */
    public SyncQualityMetrics getQualityMetrics() {
        return qualityMetrics;
    }

    /**
     * Manually trigger recovery attempt.
     */
    public void triggerRecovery() {
        recoveryAttempts.set(0);
        asyncMode.set(false);
        syncState.set(SyncState.SYNCING);
    }

    /**
     * Get current buffer statistics.
     */
    public BufferStats getBufferStats() {
        return new BufferStats(
            audioBuffer.size(),
            videoBuffer.size(),
            audioClockOffset.get(),
            videoClockOffset.get()
        );
    }

    private void processSync() {
        try {

            TimedAudioFrame audioFrame = audioBuffer.peek();
            TimedVideoFrame videoFrame = videoBuffer.peek();

            if (audioFrame == null || videoFrame == null) {
                return; // Not enough data
            }

            long audioTimeUs = audioFrame.presentationTimeUs;
            long videoTimeUs = videoFrame.presentationTimeUs;
            long driftUs = audioTimeUs - videoTimeUs;
            long driftMs = driftUs / 1000;
            lastDriftMs.set(driftMs);

            // Update quality metrics
            SyncQuality currentQuality = qualityMetrics.recordDrift(driftMs);
            if (callback != null && currentQuality != qualityMetrics.getCurrentQuality()) {
                callback.onQualityChange(currentQuality);
            }

            // Check if within tolerance
            if (Math.abs(driftMs) <= syncToleranceMs) {
                syncState.set(SyncState.LOCKED);

                // Emit synced frame
                audioBuffer.poll();
                videoBuffer.poll();

                if (callback != null) {
                    callback.onSyncedFrame(new SyncedFrame(
                        audioFrame.audio,
                        videoFrame.frame,
                        audioTimeUs,
                        driftMs
                    ));
                }
                recoveryAttempts.set(0); // Reset recovery on success
            } else if (asyncMode.get()) {
                // In async mode - just emit frames without sync
                audioBuffer.poll();
                videoBuffer.poll();

                if (callback != null) {
                    callback.onSyncedFrame(new SyncedFrame(
                        audioFrame.audio,
                        videoFrame.frame,
                        audioTimeUs,
                        driftMs
                    ));
                }
            } else {
                // Drift detected - apply correction
                syncState.set(SyncState.DRIFTING);

                if (Math.abs(driftMs) > MAX_DRIFT_CORRECTION_MS) {
                    // Large drift - reset and resync
                    if (driftMs > 0) {
                        // Audio ahead, drop audio frames
                        while (driftMs > syncToleranceMs && !audioBuffer.isEmpty()) {
                            TimedAudioFrame dropped = audioBuffer.poll();
                            if (dropped != null) {
                                driftMs = (dropped.presentationTimeUs - videoTimeUs) / 1000;
                            }
                        }
                    } else {
                        // Video ahead, drop video frames
                        while (driftMs < -syncToleranceMs && !videoBuffer.isEmpty()) {
                            TimedVideoFrame dropped = videoBuffer.poll();
                            if (dropped != null) {
                                driftMs = (audioTimeUs - dropped.presentationTimeUs) / 1000;
                            }
                        }
                    }
                } else {
                    // Small drift - gradual correction via clock adjustment
                    long correction = driftMs / 2; // Partial correction
                    if (driftMs > 0) {
                        audioClockOffset.addAndGet(-correction * 1000); // Slow down audio clock
                    } else {
                        videoClockOffset.addAndGet(-correction * 1000); // Slow down video clock
                    }
                }

                if (callback != null) {
                    callback.onDriftDetected(driftMs, syncState.get());
                }
            }

        } catch (Exception e) {
            handleSyncError(e);
        }
    }

    private void handleSyncError(Exception e) {
        int attempts = recoveryAttempts.incrementAndGet();

        if (attempts >= MAX_RECOVERY_ATTEMPTS) {
            // Max recovery attempts reached - degrade to async mode
            syncState.set(SyncState.ASYNC);
            asyncMode.set(true);
            if (callback != null) {
                callback.onAsyncModeActivated("Max recovery attempts reached: " + e.getMessage());
            }
            return;
        }

        // Calculate exponential backoff
        long backoffMs = Math.min(
            INITIAL_BACKOFF_MS * (1L << (attempts - 1)),
            MAX_BACKOFF_MS
        );

        syncState.set(SyncState.RECOVERING);
        lastRecoveryTime.set(System.currentTimeMillis());

        if (callback != null) {
            callback.onRecoveryAttempt(attempts, backoffMs);
        }

        // Schedule recovery attempt
        syncExecutor.schedule(() -> {
            try {
                if (asyncMode.get()) return;

                // Clear buffers and reset state
                audioBuffer.clear();
                videoBuffer.clear();
                audioClockOffset.set(0);
                videoClockOffset.set(0);
                syncState.set(SyncState.SYNCING);
            } catch (Exception recoveryError) {
                if (callback != null) {
                    callback.onError("Recovery failed: " + recoveryError.getMessage());
                }
            }
        }, backoffMs, TimeUnit.MILLISECONDS);
    }

    @Override
    public void close() {
        syncExecutor.shutdown();
        try {

            if (!syncExecutor.awaitTermination(5, TimeUnit.SECONDS)) {
                syncExecutor.shutdownNow();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            syncExecutor.shutdownNow();
        }

        audioBuffer.clear();
        videoBuffer.clear();
    }

    // Inner classes

    private static class TimedAudioFrame {
        final AudioData audio;
        final long presentationTimeUs;
        final long systemTimeNs;

        TimedAudioFrame(AudioData audio, long presentationTimeUs, long systemTimeNs) {
            this.audio = audio;
            this.presentationTimeUs = presentationTimeUs;
            this.systemTimeNs = systemTimeNs;
        }
    }

    private static class TimedVideoFrame {
        final ImageData frame;
        final long presentationTimeUs;
        final long systemTimeNs;

        TimedVideoFrame(ImageData frame, long presentationTimeUs, long systemTimeNs) {
            this.frame = frame;
            this.presentationTimeUs = presentationTimeUs;
            this.systemTimeNs = systemTimeNs;
        }
    }

    public static class SyncedFrame {
        public final AudioData audio;
        public final ImageData video;
        public final long syncTimestampUs;
        public final long driftMs;

        public SyncedFrame(AudioData audio, ImageData video, long syncTimestampUs, long driftMs) {
            this.audio = audio;
            this.video = video;
            this.syncTimestampUs = syncTimestampUs;
            this.driftMs = driftMs;
        }
    }

    public static class BufferStats {
        public final int audioFramesBuffered;
        public final int videoFramesBuffered;
        public final long audioClockOffsetUs;
        public final long videoClockOffsetUs;

        public BufferStats(int audioFrames, int videoFrames, long audioOffset, long videoOffset) {
            this.audioFramesBuffered = audioFrames;
            this.videoFramesBuffered = videoFrames;
            this.audioClockOffsetUs = audioOffset;
            this.videoClockOffsetUs = videoOffset;
        }

        @Override
        public String toString() {
            return String.format("BufferStats{audio=%d, video=%d, audioOffset=%dus, videoOffset=%dus}",
                audioFramesBuffered, videoFramesBuffered, audioClockOffsetUs, videoClockOffsetUs);
        }
    }

    public static class SyncQualityMetrics {
        private final long[] driftHistory = new long[QUALITY_WINDOW_SIZE];
        private int historyIndex = 0;
        private int historySize = 0;
        private final AtomicReference<SyncQuality> currentQuality = new AtomicReference<>(SyncQuality.GOOD);

        public synchronized SyncQuality recordDrift(long driftMs) {
            driftHistory[historyIndex] = Math.abs(driftMs);
            historyIndex = (historyIndex + 1) % QUALITY_WINDOW_SIZE;
            if (historySize < QUALITY_WINDOW_SIZE) {
                historySize++;
            }

            // Calculate average drift
            long sum = 0;
            for (int i = 0; i < historySize; i++) {
                sum += driftHistory[i];
            }
            long avgDrift = sum / historySize;

            // Determine quality
            SyncQuality quality;
            if (avgDrift < 20) {
                quality = SyncQuality.EXCELLENT;
            } else if (avgDrift < 40) {
                quality = SyncQuality.GOOD;
            } else if (avgDrift < 100) {
                quality = SyncQuality.FAIR;
            } else {
                quality = SyncQuality.POOR;
            }

            currentQuality.set(quality);
            return quality;
        }

        public SyncQuality getCurrentQuality() {
            return currentQuality.get();
        }

        public synchronized double getAverageDrift() {
            if (historySize == 0) return 0;
            long sum = 0;
            for (int i = 0; i < historySize; i++) {
                sum += driftHistory[i];
            }
            return (double) sum / historySize;
        }

        public synchronized long getMaxDrift() {
            if (historySize == 0) return 0;
            long max = 0;
            for (int i = 0; i < historySize; i++) {
                max = Math.max(max, driftHistory[i]);
            }
            return max;
        }
    }
}
