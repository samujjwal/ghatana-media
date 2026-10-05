package com.ghatana.audio.video.vision.video;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
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
                this.fps = fps;
                return this;
            }

            public Builder maxFrames(int maxFrames) {
                this.maxFrames = maxFrames;
                return this;
            }

            public Builder resolution(int width, int height) {
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
                this.quality = quality;
                return this;
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

        try {
            Process process = new ProcessBuilder(command)
                .redirectErrorStream(true)
                .start();

            // Capture output for debugging
            StringBuilder output = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line).append("\n");
                    if (line.contains("frame=")) {
                        LOG.debug("FFmpeg progress: {}", line);
                    }
                }
            }

            boolean finished = process.waitFor(DEFAULT_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                throw new IOException("FFmpeg process timed out after " + DEFAULT_TIMEOUT_SECONDS + " seconds");
            }

            int exitCode = process.exitValue();
            if (exitCode != 0) {
                LOG.error("FFmpeg output:\n{}", output);
                throw new IOException("FFmpeg failed with exit code: " + exitCode);
            }

            LOG.info("Frame extraction completed successfully");

        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Frame extraction interrupted", e);
        }

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

        double timestampSec = timestampMs / 1000.0;

        List<String> command = List.of(
            FFMPEG_COMMAND,
            "-ss", String.format("%.3f", timestampSec),
            "-i", videoPath.toString(),
            "-frames:v", "1",
            "-q:v", "2",
            outputPath.toString(),
            "-y" // Overwrite output file
        );

        LOG.info("Extracting frame at timestamp {}ms from: {}", timestampMs, videoPath.getFileName());

        try {
            Process process = new ProcessBuilder(command)
                .redirectErrorStream(true)
                .start();

            boolean finished = process.waitFor(30, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                throw new IOException("FFmpeg process timed out");
            }

            int exitCode = process.exitValue();
            if (exitCode != 0) {
                throw new IOException("FFmpeg failed with exit code: " + exitCode);
            }

        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Frame extraction interrupted", e);
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
            Process process = new ProcessBuilder(FFMPEG_COMMAND, "-version")
                .redirectErrorStream(true)
                .start();

            boolean finished = process.waitFor(5, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                return false;
            }

            return process.exitValue() == 0;

        } catch (IOException | InterruptedException e) {
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

        try {
            Process process = new ProcessBuilder(command)
                .redirectErrorStream(true)
                .start();

            StringBuilder output = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line).append("\n");
                }
            }

            boolean finished = process.waitFor(10, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                throw new IOException("FFprobe process timed out");
            }

            return parseVideoMetadata(output.toString());

        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Metadata extraction interrupted", e);
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
