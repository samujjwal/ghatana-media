package com.ghatana.audio.video.vision.video;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.TimeUnit;

/**
 * Extracts frames from video files using FFmpeg.
 *
 * <p>Supports various video formats and provides options for:
 * <ul>
 *   <li>Frame rate control (extract every Nth frame)</li>
 *   <li>Time-based extraction (specific timestamps)</li>
 *   <li>Resolution control</li>
 *   <li>Format conversion (JPEG, PNG)</li>
 * </ul>
 *
 * <p><strong>Security:</strong> {@code ProcessBuilder} is used directly (no shell), so shell
 * injection is impossible by construction. Path inputs are normalised and validated to be
 * canonical absolute paths, preventing path-traversal attacks. The output format is
 * restricted to an allow-list of image extensions.
 *
 * @doc.type class
 * @doc.purpose Video frame extraction using FFmpeg with input validation
 * @doc.layer product
 * @doc.pattern Service
 */
public class VideoFrameExtractor {

    private static final Logger LOG = LoggerFactory.getLogger(VideoFrameExtractor.class);

    private static final String FFMPEG_COMMAND = "ffmpeg";
    private static final int DEFAULT_TIMEOUT_SECONDS = 300;
    private static final int MAX_DIAGNOSTIC_CHARS = 16_384;

    /** Allow-listed image formats that may be used as output extensions. */
    private static final java.util.Set<String> ALLOWED_FORMATS =
        java.util.Set.of("jpg", "jpeg", "png", "bmp", "tiff");

    /**
     * Configuration for frame extraction.
     */
    public static class ExtractionConfig {
        private final int fps;
        private final int maxFrames;
        private final int width;
        private final int height;
        private final String format;
        private final int quality;

        private ExtractionConfig(Builder builder) {
            this.fps = builder.fps;
            this.maxFrames = builder.maxFrames;
            this.width = builder.width;
            this.height = builder.height;
            this.format = builder.format;
            this.quality = builder.quality;
        }

        public static Builder builder() {
            return new Builder();
        }

        public static class Builder {
            private int fps = 1; // Extract 1 frame per second by default
            private int maxFrames = 100;
            private int width = -1; // -1 means keep original
            private int height = -1;
            private String format = "jpg";
            private int quality = 2; // FFmpeg quality scale (2-31, lower is better)

            public Builder fps(int fps) {
                if (fps < 1 || fps > 60) throw new IllegalArgumentException("fps must be between 1 and 60");
                this.fps = fps;
                return this;
            }

            public Builder maxFrames(int maxFrames) {
                if (maxFrames < 1 || maxFrames > 10_000) {
                    throw new IllegalArgumentException("maxFrames must be between 1 and 10000");
                }
                this.maxFrames = maxFrames;
                return this;
            }

            public Builder resolution(int width, int height) {
                if (!validDimension(width) || !validDimension(height)
                        || ((width == -1) != (height == -1))) {
                    throw new IllegalArgumentException("resolution must be -1/-1 or between 1 and 8192 per axis");
                }
                this.width = width;
                this.height = height;
                return this;
            }

            public Builder format(String format) {
                if (format == null || !ALLOWED_FORMATS.contains(format.toLowerCase(java.util.Locale.ROOT))) {
                    throw new IllegalArgumentException(
                        "Unsupported output format '%s'. Allowed: %s".formatted(format, ALLOWED_FORMATS));
                }
                this.format = format.toLowerCase(java.util.Locale.ROOT);
                return this;
            }

            public Builder quality(int quality) {
                if (quality < 1 || quality > 31) throw new IllegalArgumentException("quality must be between 1 and 31");
                this.quality = quality;
                return this;
            }

            private static boolean validDimension(int value) {
                return value == -1 || (value >= 1 && value <= 8192);
            }

            public ExtractionConfig build() {
                return new ExtractionConfig(this);
            }
        }

        public int getFps() { return fps; }
        public int getMaxFrames() { return maxFrames; }
        public int getWidth() { return width; }
        public int getHeight() { return height; }
        public String getFormat() { return format; }
        public int getQuality() { return quality; }
    }

    /**
     * Extracted frame information.
     */
    public static class ExtractedFrame {
        private final Path path;
        private final long timestampMs;
        private final int frameNumber;

        public ExtractedFrame(Path path, long timestampMs, int frameNumber) {
            this.path = path;
            this.timestampMs = timestampMs;
            this.frameNumber = frameNumber;
        }

        public Path getPath() { return path; }
        public long getTimestampMs() { return timestampMs; }
        public int getFrameNumber() { return frameNumber; }
    }

    /**
     * Extract frames from a video file.
     *
     * @param videoPath Path to the video file
     * @param outputDir Directory to store extracted frames
     * @param config Extraction configuration
     * @return List of extracted frames
     * @throws IOException If extraction fails
     */
    public List<ExtractedFrame> extractFrames(Path videoPath, Path outputDir, ExtractionConfig config)
            throws IOException {

        // Normalise to absolute canonical paths to prevent path-traversal attacks.
        // toRealPath() resolves symlinks and ".." components.  It also verifies the
        // file actually exists for videoPath.
        Path canonicalVideo;
        try {
            canonicalVideo = videoPath.toRealPath();
        } catch (IOException e) {
            throw new IOException("Video file not found or inaccessible: " + videoPath, e);
        }

        Path canonicalOutput = outputDir.toAbsolutePath().normalize();

        List<String> command = buildFFmpegCommand(canonicalVideo, canonicalOutput, config);

        Files.createDirectories(canonicalOutput);

        LOG.info("Extracting frames from video: {} with fps={}, maxFrames={}",
            canonicalVideo.getFileName(), config.getFps(), config.getMaxFrames());

        ProcessResult result = runProcess(command, Duration.ofSeconds(DEFAULT_TIMEOUT_SECONDS), MAX_DIAGNOSTIC_CHARS);
        if (result.timedOut()) {
            throw new IOException("FFmpeg process timed out after " + DEFAULT_TIMEOUT_SECONDS + " seconds");
        }
        int exitCode = result.exitCode();
        if (exitCode != 0) {
            // Child output is untrusted and may include source paths or attacker-controlled
            // media metadata. Keep only a bounded diagnostic length and never log it verbatim.
            LOG.error("FFmpeg frame extraction failed (exitCode={}, diagnosticChars={})",
                exitCode, result.output().length());
            throw new IOException("FFmpeg failed with exit code: " + exitCode);
        }

        LOG.info("Frame extraction completed successfully");

        return collectExtractedFrames(canonicalOutput, config);
    }

    /**
     * Extract a single frame at a specific timestamp.
     *
     * @param videoPath Path to the video file
     * @param timestampMs Timestamp in milliseconds
     * @param outputPath Output path for the frame
     * @throws IOException If extraction fails
     */
    public void extractFrameAtTimestamp(Path videoPath, long timestampMs, Path outputPath)
            throws IOException {

        if (timestampMs < 0) throw new IllegalArgumentException("timestampMs must not be negative");
        Path canonicalVideo;
        try {
            canonicalVideo = videoPath.toRealPath();
        } catch (IOException e) {
            throw new IOException("Video file not found or inaccessible: " + videoPath, e);
        }
        Path canonicalOutput = outputPath.toAbsolutePath().normalize();
        double timestampSec = timestampMs / 1000.0;

        List<String> command = List.of(
            FFMPEG_COMMAND,
            "-ss", String.format(Locale.ROOT, "%.3f", timestampSec),
            "-i", canonicalVideo.toString(),
            "-frames:v", "1",
            "-q:v", "2",
            canonicalOutput.toString(),
            "-y" // Overwrite output file
        );

        LOG.info("Extracting frame at timestamp {}ms from: {}", timestampMs, videoPath.getFileName());

        ProcessResult result = runProcess(command, Duration.ofSeconds(30), MAX_DIAGNOSTIC_CHARS);
        if (result.timedOut()) {
            throw new IOException("FFmpeg process timed out");
        }
        int exitCode = result.exitCode();
        if (exitCode != 0) {
            throw new IOException("FFmpeg failed with exit code: " + exitCode);
        }
    }

    private List<String> buildFFmpegCommand(Path videoPath, Path outputDir, ExtractionConfig config) {
        List<String> command = new ArrayList<>();
        command.add(FFMPEG_COMMAND);
        command.add("-i");
        command.add(videoPath.toString());

        // Frame rate filter
        command.add("-vf");
        StringBuilder filter = new StringBuilder();
        filter.append("fps=").append(config.getFps());

        // Resolution scaling if specified
        if (config.getWidth() > 0 && config.getHeight() > 0) {
            filter.append(",scale=").append(config.getWidth()).append(":").append(config.getHeight());
        }

        command.add(filter.toString());

        // Limit number of frames
        command.add("-frames:v");
        command.add(String.valueOf(config.getMaxFrames()));

        // Quality
        command.add("-q:v");
        command.add(String.valueOf(config.getQuality()));

        // Output pattern
        String outputPattern = outputDir.resolve("frame_%04d." + config.getFormat()).toString();
        command.add(outputPattern);

        // Overwrite existing files
        command.add("-y");

        return command;
    }

    private List<ExtractedFrame> collectExtractedFrames(Path outputDir, ExtractionConfig config)
            throws IOException {

        List<ExtractedFrame> frames = new ArrayList<>();

        File[] files = outputDir.toFile().listFiles((dir, name) ->
            name.startsWith("frame_") && name.endsWith("." + config.getFormat()));

        if (files == null || files.length == 0) {
            LOG.warn("No frames extracted to directory: {}", outputDir);
            return frames;
        }

        // Sort files by name to ensure correct order
        java.util.Arrays.sort(files);

        for (int i = 0; i < files.length; i++) {
            long timestampMs = (i * 1000L) / config.getFps();
            frames.add(new ExtractedFrame(files[i].toPath(), timestampMs, i));
        }

        LOG.info("Collected {} extracted frames", frames.size());
        return frames;
    }

    /**
     * Check if FFmpeg is available on the system.
     *
     * @return true if FFmpeg is available, false otherwise
     */
    public static boolean isFFmpegAvailable() {
        try {
            ProcessResult result = runProcess(List.of(FFMPEG_COMMAND, "-version"),
                Duration.ofSeconds(5), 1024);
            return !result.timedOut() && result.exitCode() == 0;
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    /**
     * Get video metadata using FFprobe.
     *
     * @param videoPath Path to the video file
     * @return Video metadata
     * @throws IOException If metadata extraction fails
     */
    public VideoMetadata getVideoMetadata(Path videoPath) throws IOException {
        List<String> command = List.of(
            "ffprobe",
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,duration,nb_frames,r_frame_rate",
            "-of", "default=noprint_wrappers=1",
            videoPath.toString()
        );

        ProcessResult result = runProcess(command, Duration.ofSeconds(10), MAX_DIAGNOSTIC_CHARS);
        if (result.timedOut()) {
            throw new IOException("FFprobe process timed out");
        }
        if (result.exitCode() != 0) throw new IOException("FFprobe failed with exit code: " + result.exitCode());
        return parseVideoMetadata(result.output());
    }

    record ProcessResult(int exitCode, boolean timedOut, String output) { }

    /**
     * Runs a media child process while draining output concurrently. The timeout therefore
     * applies even when the child never closes stdout, and diagnostic memory is bounded even
     * when an untrusted input causes the child to emit a large amount of text.
     */
    static ProcessResult runProcess(List<String> command, Duration timeout, int maxOutputChars) throws IOException {
        if (timeout.isNegative() || timeout.isZero()) throw new IllegalArgumentException("timeout must be positive");
        if (maxOutputChars < 0) throw new IllegalArgumentException("maxOutputChars must not be negative");
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        StringBuilder captured = new StringBuilder(Math.min(maxOutputChars, 1024));
        AtomicReference<IOException> drainFailure = new AtomicReference<>();
        Thread drain = new Thread(() -> drainBounded(process.getInputStream(), captured, maxOutputChars, drainFailure),
            "media-child-output-drain");
        drain.setDaemon(true);
        drain.start();
        try {
            boolean finished = process.waitFor(Math.max(1L, timeout.toMillis()), TimeUnit.MILLISECONDS);
            if (!finished) {
                process.destroy();
                if (!process.waitFor(250, TimeUnit.MILLISECONDS)) process.destroyForcibly();
                process.waitFor(2, TimeUnit.SECONDS);
            }
            drain.join(2_000);
            if (drain.isAlive()) {
                process.getInputStream().close();
                drain.join(250);
            }
            // Closing the pipe while terminating a timed-out child may interrupt the drain;
            // that expected cleanup error does not replace the timeout result.
            if (finished && drainFailure.get() != null) throw drainFailure.get();
            String output;
            synchronized (captured) {
                output = captured.toString();
            }
            return new ProcessResult(finished ? process.exitValue() : -1, !finished, output);
        } catch (InterruptedException interrupted) {
            process.destroyForcibly();
            Thread.currentThread().interrupt();
            throw new IOException("Media child process interrupted", interrupted);
        } finally {
            if (process.isAlive()) process.destroyForcibly();
        }
    }

    private static void drainBounded(InputStream stream, StringBuilder captured, int maxChars,
            AtomicReference<IOException> failure) {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            char[] buffer = new char[1024];
            int count;
            while ((count = reader.read(buffer)) >= 0) {
                synchronized (captured) {
                    int remaining = maxChars - captured.length();
                    if (remaining > 0) captured.append(buffer, 0, Math.min(remaining, count));
                }
            }
        } catch (IOException error) {
            failure.set(error);
        }
    }

    private VideoMetadata parseVideoMetadata(String output) {
        int width = 0, height = 0, totalFrames = 0;
        double duration = 0.0, fps = 0.0;

        for (String line : output.split("\n")) {
            String[] parts = line.split("=");
            if (parts.length != 2) continue;

            String key = parts[0].trim();
            String value = parts[1].trim();

            switch (key) {
                case "width" -> width = Integer.parseInt(value);
                case "height" -> height = Integer.parseInt(value);
                case "duration" -> duration = Double.parseDouble(value);
                case "nb_frames" -> totalFrames = Integer.parseInt(value);
                case "r_frame_rate" -> {
                    String[] fpsparts = value.split("/");
                    if (fpsparts.length == 2) {
                        fps = Double.parseDouble(fpsparts[0]) / Double.parseDouble(fpsparts[1]);
                    }
                }
            }
        }

        return new VideoMetadata(width, height, duration, fps, totalFrames);
    }

    /**
     * Video metadata information.
     */
    public static class VideoMetadata {
        private final int width;
        private final int height;
        private final double durationSeconds;
        private final double fps;
        private final int totalFrames;

        public VideoMetadata(int width, int height, double durationSeconds, double fps, int totalFrames) {
            this.width = width;
            this.height = height;
            this.durationSeconds = durationSeconds;
            this.fps = fps;
            this.totalFrames = totalFrames;
        }

        public int getWidth() { return width; }
        public int getHeight() { return height; }
        public double getDurationSeconds() { return durationSeconds; }
        public double getFps() { return fps; }
        public int getTotalFrames() { return totalFrames; }

        @Override
        public String toString() {
            return String.format("VideoMetadata{%dx%d, %.2fs, %.2ffps, %d frames}",
                width, height, durationSeconds, fps, totalFrames);
        }
    }
}
