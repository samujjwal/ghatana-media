package com.ghatana.audio.video.vision.video;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.LinkOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
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
    private static final int MAX_DIAGNOSTIC_BYTES = 16_384;
    private static final int MAX_FRAME_TIMESTAMP_DIAGNOSTIC_BYTES = 5 * 1024 * 1024;
    private static final Pattern SHOWINFO_PTS = Pattern.compile(
            "showinfo.*?\\bn:\\s*(\\d+)\\s+pts:\\s*(-?\\d+|NOPTS)", Pattern.CASE_INSENSITIVE);
    private static final Pattern SHOWINFO_TIMEBASE = Pattern.compile(
            "showinfo.*?config in time_base:\\s*(\\d+)/(\\d+)", Pattern.CASE_INSENSITIVE);
    private static final long MAX_INPUT_BYTES = 500L * 1024 * 1024;
    private static final long MAX_EXTRACTED_BYTES = 512L * 1024 * 1024;
    private static final long MAX_FRAME_BYTES = 32L * 1024 * 1024;
    private static final long MAX_SINGLE_FRAME_BYTES = 32L * 1024 * 1024;
    private static final long MAX_PIXELS = 16_000_000L;
    private static final java.util.Set<String> ALLOWED_VIDEO_EXTENSIONS =
            java.util.Set.of("mp4", "mov", "mkv", "avi", "webm");

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
                        || ((width == -1) != (height == -1))
                        || (width > 0 && (long) width * height > MAX_PIXELS)) {
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
        private final SourceMediaTimestamp sourceTimestamp;
        private final int frameNumber;

        public ExtractedFrame(Path path, long timestampMs, int frameNumber) {
            this(path, SourceMediaTimestamp.fromPts(Long.toString(timestampMs), "1/1000"), frameNumber);
        }

        public ExtractedFrame(Path path, SourceMediaTimestamp sourceTimestamp, int frameNumber) {
            this.path = path;
            this.sourceTimestamp = java.util.Objects.requireNonNull(sourceTimestamp, "sourceTimestamp");
            this.frameNumber = frameNumber;
        }

        public Path getPath() { return path; }
        /** Null when source PTS/timebase are absent or invalid; callers must check status first. */
        public Long getTimestampMs() { return sourceTimestamp.timestampMs(); }
        public SourceMediaTimestamp getSourceTimestamp() { return sourceTimestamp; }
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

        Path canonicalVideo = validateInput(videoPath);
        Path canonicalOutput = prepareOutputDirectory(outputDir);
        VideoMetadata metadata = getVideoMetadata(canonicalVideo);

        List<String> command = buildFFmpegCommand(canonicalVideo, canonicalOutput, config);

        Files.createDirectories(canonicalOutput);

        LOG.info("Extracting frames from video with fps={}, maxFrames={}",
            config.getFps(), config.getMaxFrames());

        ProcessResult result;
        int timestampDiagnosticBudget = (int) Math.min(MAX_FRAME_TIMESTAMP_DIAGNOSTIC_BYTES,
                MAX_DIAGNOSTIC_BYTES + (long) config.getMaxFrames() * 512L);
        try {
            result = runProcess(command, Duration.ofSeconds(DEFAULT_TIMEOUT_SECONDS), timestampDiagnosticBudget,
                    canonicalOutput, MAX_EXTRACTED_BYTES);
        } catch (IOException | RuntimeException failure) {
            cleanupFrames(canonicalOutput, config.getFormat());
            throw failure;
        }
        if (result.timedOut()) {
            cleanupFrames(canonicalOutput, config.getFormat());
            throw new IOException("FFmpeg process timed out after " + DEFAULT_TIMEOUT_SECONDS + " seconds");
        }
        if (result.outputExceeded()) {
            cleanupFrames(canonicalOutput, config.getFormat());
            throw new IOException("FFmpeg exceeded the extracted-output byte limit");
        }
        if (result.diagnosticExceeded()) {
            cleanupFrames(canonicalOutput, config.getFormat());
            throw new IOException("FFmpeg diagnostic output exceeded its byte budget");
        }
        int exitCode = result.exitCode();
        if (exitCode != 0) {
            // Child output is untrusted and may include source paths or attacker-controlled
            // media metadata. Keep only a bounded diagnostic length and never log it verbatim.
            LOG.error("FFmpeg frame extraction failed (exitCode={}, diagnosticChars={})",
                exitCode, result.output().length());
            cleanupFrames(canonicalOutput, config.getFormat());
            throw new IOException("FFmpeg failed with exit code: " + exitCode);
        }

        LOG.info("Frame extraction completed successfully");

        return collectExtractedFrames(canonicalOutput, config, metadata.getTimeBase(), result.output());
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
        Path canonicalVideo = validateInput(videoPath);
        for (Path component : outputPath) {
            if (component.toString().equals("..")) throw new IOException("Output traversal is not allowed");
        }
        Path requestedOutput = outputPath.toAbsolutePath().normalize();
        Path outputParent = requestedOutput.getParent();
        String outputName = requestedOutput.getFileName() == null ? "" : requestedOutput.getFileName().toString();
        String suffix = outputName.contains(".") ? outputName.substring(outputName.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
        if (!java.util.Set.of("jpg", "jpeg", "png", "bmp", "tiff").contains(suffix)
                || outputName.startsWith("-") || outputName.contains(":")) {
            throw new IOException("Output image format or name is not allow-listed");
        }
        if (outputParent == null || Files.isSymbolicLink(requestedOutput) || Files.isSymbolicLink(outputParent)) {
            throw new IOException("Output frame path is unsafe");
        }
        Files.createDirectories(outputParent);
        Path realOutputParent = outputParent.toRealPath();
        Path canonicalOutput = realOutputParent.resolve(outputName);
        if (Files.exists(canonicalOutput, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Output frame already exists");
        double timestampSec = timestampMs / 1000.0;

        List<String> command = List.of(
            FFMPEG_COMMAND,
            "-nostdin", "-v", "error", "-protocol_whitelist", "file",
            "-f", inputFormat(canonicalVideo),
            "-max_alloc", "268435456", "-max_pixels", Long.toString(MAX_PIXELS),
            "-ss", String.format(Locale.ROOT, "%.3f", timestampSec),
            "-i", canonicalVideo.toString(),
            "-frames:v", "1",
            "-vf", "scale='min(4096,iw)':'min(4096,ih)':force_original_aspect_ratio=decrease",
            "-q:v", "2",
            "-fs", Long.toString(MAX_SINGLE_FRAME_BYTES),
            canonicalOutput.toString(),
            "-n"
        );

        LOG.info("Extracting frame at timestamp {}ms", timestampMs);

        try {
            ProcessResult result = runProcess(command, Duration.ofSeconds(30), MAX_DIAGNOSTIC_BYTES);
            if (result.timedOut()) throw new IOException("FFmpeg process timed out");
            if (result.diagnosticExceeded()) throw new IOException("FFmpeg diagnostic output exceeded its byte budget");
            if (result.outputExceeded()) throw new IOException("FFmpeg output exceeded its byte budget");
            if (result.exitCode() != 0) throw new IOException("FFmpeg failed with exit code: " + result.exitCode());
            validateSingleFrameOutput(canonicalOutput, realOutputParent);
        } catch (IOException | RuntimeException failure) {
            Files.deleteIfExists(canonicalOutput);
            throw failure;
        }
    }

    List<String> buildFFmpegCommand(Path videoPath, Path outputDir, ExtractionConfig config) throws IOException {
        List<String> command = new ArrayList<>();
        command.add(FFMPEG_COMMAND);
        command.add("-nostdin");
        command.add("-v");
        command.add("info");
        command.add("-copyts");
        command.add("-protocol_whitelist");
        command.add("file");
        command.add("-max_alloc");
        command.add("268435456");
        command.add("-max_pixels");
        command.add(Long.toString(MAX_PIXELS));
        command.add("-f");
        command.add(inputFormat(videoPath));
        command.add("-i");
        command.add(videoPath.toString());

        // Select by source media time while retaining exact input PTS. An fps filter would
        // manufacture CFR timestamps for variable-rate input.
        command.add("-vf");
        StringBuilder filter = new StringBuilder();
        filter.append("select='isnan(prev_selected_t)+gte(t-prev_selected_t,1/")
                .append(config.getFps()).append(")',showinfo");

        // Resolution scaling if specified
        if (config.getWidth() > 0 && config.getHeight() > 0) {
            filter.append(",scale=").append(config.getWidth()).append(":").append(config.getHeight());
        } else {
            filter.append(",scale='min(4096,iw)':'min(4096,ih)':force_original_aspect_ratio=decrease");
        }

        command.add(filter.toString());
        command.add("-fps_mode");
        command.add("passthrough");
        command.add("-enc_time_base");
        command.add("demux");

        // Limit number of frames
        command.add("-frames:v");
        command.add(String.valueOf(config.getMaxFrames()));

        // Quality
        command.add("-q:v");
        command.add(String.valueOf(config.getQuality()));

        // Output pattern
        String outputPattern = outputDir.resolve("frame_%04d." + config.getFormat()).toString();
        command.add(outputPattern);

        // Isolated output directories must not overwrite any unexpected path.
        command.add("-n");

        return command;
    }

    List<ExtractedFrame> collectExtractedFrames(Path outputDir, ExtractionConfig config)
            throws IOException {
        return collectExtractedFrames(outputDir, config, null, "");
    }

    List<ExtractedFrame> collectExtractedFrames(Path outputDir, ExtractionConfig config,
            String timeBase, String diagnosticOutput) throws IOException {

        List<ExtractedFrame> frames = new ArrayList<>();

        File[] files = outputDir.toFile().listFiles((dir, name) ->
            name.startsWith("frame_") && name.endsWith("." + config.getFormat()));

        if (files == null || files.length == 0) {
            LOG.warn("No frames extracted");
            return frames;
        }

        // Sort by FFmpeg's numeric sequence so frames 9999 and 10000 remain in emission order.
        java.util.Arrays.sort(files, java.util.Comparator.comparingInt(file ->
                frameSequenceNumber(file.getName())));

        long totalBytes = 0;
        if (files.length > config.getMaxFrames()) {
            cleanupFrames(outputDir, config.getFormat());
            throw new IOException("FFmpeg produced more frames than the configured limit");
        }
        for (File file : files) {
            Path framePath = file.toPath().toAbsolutePath().normalize();
            if (Files.isSymbolicLink(framePath) || !framePath.startsWith(outputDir)
                    || !Files.isRegularFile(framePath, LinkOption.NOFOLLOW_LINKS)) {
                cleanupFrames(outputDir, config.getFormat());
                throw new IOException("FFmpeg produced an unsafe frame path");
            }
            long frameSize = Files.size(framePath);
            totalBytes += frameSize;
            if (frameSize <= 0 || frameSize > MAX_FRAME_BYTES || totalBytes > MAX_EXTRACTED_BYTES) {
                cleanupFrames(outputDir, config.getFormat());
                throw new IOException("Extracted frame output exceeded configured byte bounds");
            }
            int sourceSequence = frameSequenceNumber(framePath.getFileName().toString()) - 1;
            if (sourceSequence < 0) {
                cleanupFrames(outputDir, config.getFormat());
                throw new IOException("FFmpeg produced an invalid frame sequence number");
            }
            SourceMediaTimestamp timestamp = timestampForOutputFrame(diagnosticOutput, sourceSequence, timeBase);
            // Preserve the emitted sequence number so a missing frame remains visible as a gap;
            // do not renumber observations densely or infer media time from this ordinal.
            frames.add(new ExtractedFrame(framePath, timestamp, sourceSequence));
        }

        LOG.info("Collected {} extracted frames", frames.size());
        return frames;
    }

    static int frameSequenceNumber(String filename) {
        Matcher matcher = Pattern.compile("frame_(\\d+)\\.[A-Za-z0-9]+")
                .matcher(filename == null ? "" : filename);
        if (!matcher.matches()) throw new IllegalArgumentException("Unexpected extracted frame filename");
        try {
            return Integer.parseInt(matcher.group(1));
        } catch (NumberFormatException invalid) {
            throw new IllegalArgumentException("Extracted frame sequence is outside integer bounds", invalid);
        }
    }

    static SourceMediaTimestamp timestampForOutputFrame(String diagnostics, int frameNumber, String timeBase) {
        String source = diagnostics == null ? "" : diagnostics;
        String ffmpegTimeBase = null;
        Matcher timeBaseMatcher = SHOWINFO_TIMEBASE.matcher(source);
        if (timeBaseMatcher.find()) {
            ffmpegTimeBase = timeBaseMatcher.group(1) + "/" + timeBaseMatcher.group(2);
            if (timeBase != null) {
                try {
                    if (!SourceMediaTimestamp.parseTimeBase(timeBase)
                            .equals(SourceMediaTimestamp.parseTimeBase(ffmpegTimeBase))) {
                        return SourceMediaTimestamp.unknown("FFPROBE_FFMPEG_TIMEBASE_MISMATCH");
                    }
                } catch (IllegalArgumentException invalidTimeBase) {
                    return SourceMediaTimestamp.unknown("INVALID_SOURCE_TIMEBASE");
                }
            }
        }
        String effectiveTimeBase = ffmpegTimeBase == null ? timeBase : ffmpegTimeBase;
        Matcher matcher = SHOWINFO_PTS.matcher(source);
        while (matcher.find()) {
            try {
                int reportedFrame = Integer.parseInt(matcher.group(1));
                if (reportedFrame == frameNumber) {
                    String rawPts = matcher.group(2);
                    return "NOPTS".equalsIgnoreCase(rawPts)
                            ? SourceMediaTimestamp.unknown("SOURCE_PTS_MISSING")
                            : SourceMediaTimestamp.fromPts(rawPts, effectiveTimeBase);
                }
            } catch (NumberFormatException invalidFrameNumber) {
                return SourceMediaTimestamp.unknown("FRAME_SEQUENCE_INVALID");
            }
        }
        return SourceMediaTimestamp.unknown("SOURCE_PTS_MISSING");
    }

    /**
     * Check if FFmpeg is available on the system.
     *
     * @return true if FFmpeg is available, false otherwise
     */
    public static boolean isFFmpegAvailable() {
        try {
            ProcessResult result = runProcess(List.of(FFMPEG_COMMAND, "-version"),
                Duration.ofSeconds(5), MAX_DIAGNOSTIC_BYTES);
            return !result.timedOut() && !result.diagnosticExceeded() && result.exitCode() == 0;
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
        Path canonicalVideo = validateInput(videoPath);
        List<String> command = List.of(
            "ffprobe",
            "-nostdin", "-v", "error", "-protocol_whitelist", "file",
            "-f", inputFormat(canonicalVideo),
            "-max_alloc", "268435456",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,duration,nb_frames,r_frame_rate,time_base",
            "-of", "default=noprint_wrappers=1",
            canonicalVideo.toString()
        );

        ProcessResult result = runProcess(command, Duration.ofSeconds(10), MAX_DIAGNOSTIC_BYTES);
        if (result.timedOut()) {
            throw new IOException("FFprobe process timed out");
        }
        if (result.exitCode() != 0) throw new IOException("FFprobe failed with exit code: " + result.exitCode());
        VideoMetadata metadata = parseVideoMetadata(result.output());
        if (metadata.getWidth() < 1 || metadata.getHeight() < 1
                || metadata.getWidth() > 8192 || metadata.getHeight() > 8192
                || (long) metadata.getWidth() * metadata.getHeight() > MAX_PIXELS
                || !Double.isFinite(metadata.getDurationSeconds()) || metadata.getDurationSeconds() < 0
                || metadata.getDurationSeconds() > 86_400
                || !Double.isFinite(metadata.getFps()) || metadata.getFps() < 0 || metadata.getFps() > 240
                || metadata.getTotalFrames() < 0 || metadata.getTotalFrames() > 10_000_000) {
            throw new IOException("Video metadata exceeds supported dimension, duration, rate, or frame bounds");
        }
        return metadata;
    }

    record ProcessResult(int exitCode, boolean timedOut, String output, boolean outputExceeded,
            boolean diagnosticExceeded) {
        ProcessResult(int exitCode, boolean timedOut, String output) { this(exitCode, timedOut, output, false, false); }
        ProcessResult(int exitCode, boolean timedOut, String output, boolean outputExceeded) {
            this(exitCode, timedOut, output, outputExceeded, false);
        }
    }

    /**
     * Runs a media child process while draining output concurrently. The timeout therefore
     * applies even when the child never closes stdout, and diagnostic memory is bounded even
     * when an untrusted input causes the child to emit a large amount of text.
     */
    static ProcessResult runProcess(List<String> command, Duration timeout, int maxOutputChars) throws IOException {
        return runProcess(command, timeout, maxOutputChars, null, Long.MAX_VALUE);
    }

    static ProcessResult runProcess(List<String> command, Duration timeout, int maxOutputChars,
            Path monitoredOutput, long maxOutputBytes) throws IOException {
        if (timeout.isNegative() || timeout.isZero()) throw new IllegalArgumentException("timeout must be positive");
        if (maxOutputChars < 0) throw new IllegalArgumentException("maxOutputChars must not be negative");
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        ByteArrayOutputStream captured = new ByteArrayOutputStream(Math.min(maxOutputChars, 1024));
        AtomicReference<IOException> drainFailure = new AtomicReference<>();
        java.util.concurrent.atomic.AtomicBoolean diagnosticExceeded = new java.util.concurrent.atomic.AtomicBoolean();
        Thread drain = new Thread(() -> drainBounded(process.getInputStream(), captured, maxOutputChars,
                diagnosticExceeded, process, drainFailure),
            "media-child-output-drain");
        drain.setDaemon(true);
        drain.start();
        try {
            long deadline = System.nanoTime() + timeout.toNanos();
            boolean finished = false;
            boolean outputExceeded = false;
            while (!finished && System.nanoTime() < deadline) {
                finished = process.waitFor(Math.min(100L, Math.max(1L,
                        TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime()))), TimeUnit.MILLISECONDS);
                if (!finished) {
                    if (diagnosticExceeded.get()) break;
                    if (monitoredOutput != null && directoryBytes(monitoredOutput) > maxOutputBytes) {
                        outputExceeded = true;
                        break;
                    }
                }
            }
            // A short-lived child can finish and exit after producing more than the budget
            // between polling intervals. Check once after exit so that fast overflow cannot
            // be mistaken for a successful bounded extraction.
            if (finished && monitoredOutput != null && directoryBytes(monitoredOutput) > maxOutputBytes) {
                outputExceeded = true;
            }
            if (!finished) {
                terminateProcessTree(process);
                process.waitFor(2, TimeUnit.SECONDS);
            }
            drain.join(2_000);
            if (drain.isAlive()) {
                process.getInputStream().close();
                drain.join(250);
            }
            // Closing the pipe while terminating a timed-out child may interrupt the drain;
            // that expected cleanup error does not replace the timeout result.
            if (finished && !diagnosticExceeded.get() && drainFailure.get() != null) throw drainFailure.get();
            String output;
            synchronized (captured) {
                output = captured.toString(StandardCharsets.UTF_8);
            }
            boolean diagnosticsExceeded = diagnosticExceeded.get();
            return new ProcessResult(finished ? process.exitValue() : -1,
                    !finished && !outputExceeded && !diagnosticsExceeded, output, outputExceeded, diagnosticsExceeded);
        } catch (InterruptedException interrupted) {
            terminateProcessTree(process);
            Thread.currentThread().interrupt();
            throw new IOException("Media child process interrupted", interrupted);
        } finally {
            if (process.isAlive()) terminateProcessTree(process);
        }
    }

    private static Path validateInput(Path input) throws IOException {
        if (input == null || Files.isSymbolicLink(input)) throw new IOException("Video input path is unsafe");
        for (Path component : input) {
            if (component.toString().equals("..")) throw new IOException("Video input traversal is not allowed");
        }
        Path absolute = input.toAbsolutePath().normalize();
        String filename = absolute.getFileName() == null ? "" : absolute.getFileName().toString();
        int dot = filename.lastIndexOf('.');
        String extension = dot < 0 ? "" : filename.substring(dot + 1).toLowerCase(Locale.ROOT);
        if (!ALLOWED_VIDEO_EXTENSIONS.contains(extension) || filename.contains(":") || filename.startsWith("-")) {
            throw new IOException("Video container or protocol is not allow-listed");
        }
        if (!Files.isRegularFile(absolute, LinkOption.NOFOLLOW_LINKS) || !Files.isReadable(absolute)) {
            throw new IOException("Video input must be a readable regular file");
        }
        long size = Files.size(absolute);
        if (size <= 0 || size > MAX_INPUT_BYTES) throw new IOException("Video input size is outside supported bounds");
        return absolute.toRealPath(LinkOption.NOFOLLOW_LINKS);
    }

    private static Path prepareOutputDirectory(Path requested) throws IOException {
        if (requested == null) throw new IOException("Output directory is required");
        for (Path component : requested) {
            if (component.toString().equals("..")) throw new IOException("Output traversal is not allowed");
        }
        Path output = requested.toAbsolutePath().normalize();
        if (Files.isSymbolicLink(output)) throw new IOException("Output directory cannot be a symlink");
        Files.createDirectories(output);
        Path real = output.toRealPath(LinkOption.NOFOLLOW_LINKS);
        if (!Files.isDirectory(real, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(real)) {
            throw new IOException("Output directory is unsafe");
        }
        try (var entries = Files.list(real)) {
            if (entries.findAny().isPresent()) throw new IOException("Output directory must be empty and isolated");
        }
        return real;
    }

    private static void cleanupFrames(Path directory, String format) {
        if (directory == null || !Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) return;
        try (var paths = Files.list(directory)) {
            paths.filter(path -> path.getFileName().toString().matches("frame_[0-9]{4,}\\." + java.util.regex.Pattern.quote(format)))
                    .filter(path -> !Files.isSymbolicLink(path))
                    .forEach(path -> { try { Files.deleteIfExists(path); } catch (IOException ignored) { } });
        } catch (IOException ignored) { }
    }

    private static long directoryBytes(Path directory) throws IOException {
        if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) return 0;
        try (var paths = Files.list(directory)) {
            long total = 0;
            for (Path path : paths.toList()) {
                if (Files.isSymbolicLink(path)) return Long.MAX_VALUE;
                if (Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
                    total = Math.addExact(total, Files.size(path));
                }
                if (total > MAX_EXTRACTED_BYTES) return total;
            }
            return total;
        } catch (ArithmeticException overflow) {
            return Long.MAX_VALUE;
        }
    }

    static void validateSingleFrameOutput(Path output, Path expectedParent) throws IOException {
        Path normalized = output.toAbsolutePath().normalize();
        Path parentReal = expectedParent.toRealPath();
        if (Files.isSymbolicLink(normalized) || normalized.getParent() == null
                || !normalized.getParent().toRealPath().equals(parentReal)
                || !Files.isRegularFile(normalized, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("FFmpeg did not produce a safe frame file");
        }
        long size = Files.size(normalized);
        if (size <= 0 || size > MAX_SINGLE_FRAME_BYTES) {
            throw new IOException("Extracted single frame exceeded its byte budget");
        }
    }

    private static String inputFormat(Path videoPath) throws IOException {
        String name = videoPath.getFileName().toString();
        String extension = name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        return switch (extension) {
            case "mp4", "mov" -> "mov";
            case "mkv" -> "matroska";
            case "avi" -> "avi";
            case "webm" -> "webm";
            default -> throw new IOException("Video container is not allow-listed");
        };
    }

    private static void terminateProcessTree(Process process) {
        process.toHandle().descendants().forEach(handle -> { try { handle.destroy(); } catch (RuntimeException ignored) { } });
        process.destroy();
        try {
            if (!process.waitFor(250, TimeUnit.MILLISECONDS)) {
                process.toHandle().descendants().forEach(handle -> { try { handle.destroyForcibly(); } catch (RuntimeException ignored) { } });
                process.destroyForcibly();
            }
        } catch (InterruptedException interrupted) {
            process.toHandle().descendants().forEach(handle -> { try { handle.destroyForcibly(); } catch (RuntimeException ignored) { } });
            process.destroyForcibly();
            Thread.currentThread().interrupt();
        }
    }

    private static void drainBounded(InputStream stream, ByteArrayOutputStream captured, int maxBytes,
            java.util.concurrent.atomic.AtomicBoolean exceeded,
            Process process,
            AtomicReference<IOException> failure) {
        try (InputStream input = stream) {
            byte[] buffer = new byte[1024];
            int count;
            while ((count = input.read(buffer)) >= 0) {
                synchronized (captured) {
                    int remaining = maxBytes - captured.size();
                    if (remaining > 0) captured.write(buffer, 0, Math.min(remaining, count));
                    if (count > remaining && exceeded.compareAndSet(false, true)) terminateProcessTree(process);
                }
            }
        } catch (IOException error) {
            failure.set(error);
        }
    }

    static VideoMetadata parseVideoMetadata(String output) {
        int width = 0, height = 0, totalFrames = 0;
        double duration = 0.0, fps = 0.0;
        String timeBase = null;

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
                case "time_base" -> timeBase = value;
            }
        }

        return new VideoMetadata(width, height, duration, fps, totalFrames, timeBase);
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
        private final String timeBase;

        public VideoMetadata(int width, int height, double durationSeconds, double fps, int totalFrames) {
            this(width, height, durationSeconds, fps, totalFrames, null);
        }

        public VideoMetadata(int width, int height, double durationSeconds, double fps, int totalFrames,
                String timeBase) {
            this.width = width;
            this.height = height;
            this.durationSeconds = durationSeconds;
            this.fps = fps;
            this.totalFrames = totalFrames;
            this.timeBase = timeBase;
        }

        public int getWidth() { return width; }
        public int getHeight() { return height; }
        public double getDurationSeconds() { return durationSeconds; }
        public double getFps() { return fps; }
        public int getTotalFrames() { return totalFrames; }
        public String getTimeBase() { return timeBase; }

        @Override
        public String toString() {
            return String.format("VideoMetadata{%dx%d, %.2fs, %.2ffps, %d frames}",
                width, height, durationSeconds, fps, totalFrames);
        }
    }
}
