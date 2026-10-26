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
import java.nio.file.SimpleFileVisitor;
import java.nio.file.FileVisitResult;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.function.Consumer;
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
    private static final long MAX_MULTIMODAL_VIDEO_BYTES = 32L * 1024 * 1024;
    private static final int MAX_DEMUXED_AUDIO_DURATION_SECONDS = 300;
    // 16 kHz mono S16LE is 32,000 bytes/second; keep decoded output below the
    // 300-second duration ceiling even if container duration metadata is false.
    private static final long MAX_DEMUXED_AUDIO_BYTES = 16_000L * 2L * MAX_DEMUXED_AUDIO_DURATION_SECONDS;
    private static final long MAX_EXTRACTED_BYTES = 512L * 1024 * 1024;
    private static final long MAX_FRAME_BYTES = 32L * 1024 * 1024;
    private static final long MAX_SINGLE_FRAME_BYTES = 32L * 1024 * 1024;
    private static final long MAX_PIXELS = 16_000_000L;
    /** Bound aggregate codec/probe processes so per-child limits cannot multiply without bound. */
    private static final java.util.concurrent.Semaphore MEDIA_PROCESS_SLOTS =
            new java.util.concurrent.Semaphore(2, true);
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
     * Bounded first audio track decoded to the STT client's canonical mono S16LE input.
     * Source stream timing is retained separately; it is not an audio/video clock mapping.
     */
    public record ExtractedAudioTrack(byte[] pcmS16le, int sampleRate, int channels, int sourceStreamIndex,
                                      long sourceStartPts, long sourceTimeBaseNumerator,
                                      long sourceTimeBaseDenominator, boolean sourceStartKnown) {
        public ExtractedAudioTrack {
            if (pcmS16le == null || pcmS16le.length == 0 || (pcmS16le.length & 1) != 0
                    || pcmS16le.length > MAX_DEMUXED_AUDIO_BYTES || sampleRate != 16_000 || channels != 1
                    || sourceStreamIndex < 0
                    || sourceTimeBaseNumerator <= 0 || sourceTimeBaseDenominator <= 0
                    || (!sourceStartKnown && sourceStartPts != 0)) {
                throw new IllegalArgumentException("Extracted audio track is outside the admitted PCM/timebase bounds");
            }
            pcmS16le = pcmS16le.clone();
        }

        @Override
        public byte[] pcmS16le() { return pcmS16le.clone(); }

        public long sampleCount() { return pcmS16le.length / 2L; }
    }

    record AudioStreamMetadata(int streamIndex, int sampleRate, int channels,
                                       long startPts, boolean startKnown,
                                       long timeBaseNumerator, long timeBaseDenominator,
                                       long durationTicks) { }

    /**
     * Extract frames from a video file.
     *
     * @param videoPath Path to the video file
     * @param outputDir Directory to store extracted frames
     * @param config Extraction configuration
     * @return List of extracted frames
     * @throws IOException if extraction or staging cleanup fails. If cleanup fails after frame
     *         publication, complete output frames may already exist in the private output directory.
     */
    public List<ExtractedFrame> extractFrames(Path videoPath, Path outputDir, ExtractionConfig config)
            throws IOException {

        // `outputDir` is an exclusive per-invocation publication root. Its POSIX mode is
        // tightened to 0700, and every writable ancestor must be private or a sticky temp root.
        if (config == null) throw new IllegalArgumentException("Extraction config is required");
        Path canonicalVideo = validateInput(videoPath);
        Path canonicalOutput = prepareOutputDirectory(outputDir);
        VideoMetadata metadata = getVideoMetadata(canonicalVideo);
        Path staging = createIsolatedStagingDirectory(canonicalOutput);
        List<String> command = buildFFmpegCommand(canonicalVideo, staging, config);

        LOG.info("Extracting frames from video with fps={}, maxFrames={}",
            config.getFps(), config.getMaxFrames());

        int timestampDiagnosticBudget = (int) Math.min(MAX_FRAME_TIMESTAMP_DIAGNOSTIC_BYTES,
                MAX_DIAGNOSTIC_BYTES + (long) config.getMaxFrames() * 512L);
        try {
            ProcessResult result = runFFmpegProcess(command, Duration.ofSeconds(DEFAULT_TIMEOUT_SECONDS), timestampDiagnosticBudget,
                    staging, MAX_EXTRACTED_BYTES);
            if (result.timedOut()) throw new IOException("FFmpeg process timed out after " + DEFAULT_TIMEOUT_SECONDS + " seconds");
            if (result.outputExceeded()) throw new IOException("FFmpeg exceeded the extracted-output byte limit");
            if (result.diagnosticExceeded()) throw new IOException("FFmpeg diagnostic output exceeded its byte budget");
            int exitCode = result.exitCode();
            if (exitCode != 0) {
                // Child output is untrusted and may include source paths or attacker-controlled
                // media metadata. Keep only a bounded diagnostic length and never log it verbatim.
                LOG.error("FFmpeg frame extraction failed (exitCode={}, diagnosticChars={})",
                    exitCode, result.output().length());
                throw new IOException("FFmpeg failed with exit code: " + exitCode);
            }
            List<ExtractedFrame> stagedFrames = collectExtractedFrames(
                    staging, config, metadata.getTimeBase(), result.output());
            List<ExtractedFrame> publishedFrames = publishStagedFrames(stagedFrames, canonicalOutput);
            cleanupStagingDirectory(staging);
            LOG.info("Frame extraction completed successfully");
            return publishedFrames;
        } catch (IOException | RuntimeException failure) {
            cleanupStagingDirectory(staging, failure);
            throw failure;
        }
    }

    /**
     * Demux and decode the first audio stream from a bounded video-container payload.
     * The payload is staged in an owner-only directory and processed through the same bounded
     * FFmpeg runner, process semaphore, protocol allowlist, and cleanup policy as frame decoding.
     * A missing or unbounded duration is rejected. Missing stream start PTS is preserved as
     * unknown; stream-local timebases do not establish a shared audio/video source origin.
     */
    public ExtractedAudioTrack extractAudioTrack(byte[] videoData) throws IOException {
        if (videoData == null || videoData.length == 0 || videoData.length > MAX_MULTIMODAL_VIDEO_BYTES) {
            throw new IOException("Video input size is outside the supported audio-demux bounds");
        }
        String extension = sniffVideoExtension(videoData);
        Path workspace = createPrivateWorkspace();
        Path staging = null;
        IOException failure = null;
        try {
            Path source = workspace.resolve("source." + extension);
            writeOwnerOnlyInput(source, videoData);
            Path canonicalSource = validateInput(source);
            String format = inputFormat(canonicalSource);
            AudioStreamMetadata metadata = probeFirstAudioStream(canonicalSource, format);
            if (metadata == null) throw new IOException("VIDEO_AUDIO_TRACK_UNAVAILABLE: no audio stream exists");
            if (!durationWithinLimit(metadata)) {
                throw new IOException("VIDEO_AUDIO_DURATION_NOT_ADMITTED: audio duration is missing or exceeds 300 seconds");
            }

            staging = createIsolatedStagingDirectory(workspace);
            Path decoded = staging.resolve("audio.pcm");
            List<String> command = List.of(
                    FFMPEG_COMMAND, "-nostdin", "-v", "error", "-protocol_whitelist", "file",
                    "-max_alloc", "268435456", "-i", canonicalSource.toString(),
                    "-map", "0:" + metadata.streamIndex(), "-vn", "-sn", "-dn",
                    "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "s16le",
                    "-fs", Long.toString(MAX_DEMUXED_AUDIO_BYTES), decoded.toString(), "-n");
            ProcessResult result = runFFmpegProcess(command, Duration.ofSeconds(120), MAX_DIAGNOSTIC_BYTES,
                    staging, MAX_DEMUXED_AUDIO_BYTES);
            if (result.timedOut()) throw new IOException("FFmpeg audio demux timed out");
            if (result.outputExceeded()) throw new IOException("FFmpeg audio output exceeded its byte limit");
            if (result.diagnosticExceeded()) throw new IOException("FFmpeg audio diagnostics exceeded their byte limit");
            if (result.exitCode() != 0) throw new IOException("FFmpeg audio demux failed with exit code: " + result.exitCode());
            validateAudioOutput(decoded, staging);
            byte[] pcm = Files.readAllBytes(decoded);
            return new ExtractedAudioTrack(pcm, 16_000, 1, metadata.streamIndex(), metadata.startPts(),
                    metadata.timeBaseNumerator(), metadata.timeBaseDenominator(), metadata.startKnown());
        } catch (IOException | RuntimeException caught) {
            if (caught instanceof IOException io) {
                failure = io;
            } else {
                failure = new IOException("Video audio demux failed within configured limits", caught);
            }
            throw failure;
        } finally {
            IOException cleanupFailure = null;
            if (staging != null) {
                try {
                    cleanupStagingDirectory(staging);
                } catch (IOException cleanup) {
                    cleanupFailure = cleanup;
                }
            }
            try {
                cleanupStagingDirectory(workspace);
            } catch (IOException cleanup) {
                if (cleanupFailure == null) cleanupFailure = cleanup;
                else cleanupFailure.addSuppressed(cleanup);
            }
            if (cleanupFailure != null) {
                if (failure != null) failure.addSuppressed(cleanupFailure);
                else throw cleanupFailure;
            }
        }
    }

    static String sniffVideoExtension(byte[] bytes) throws IOException {
        if (bytes.length >= 12 && bytes[0] == 'R' && bytes[1] == 'I' && bytes[2] == 'F' && bytes[3] == 'F') {
            if (bytes[8] == 'A' && bytes[9] == 'V' && bytes[10] == 'I' && bytes[11] == ' ') return "avi";
        }
        if (bytes.length >= 12 && bytes[4] == 'f' && bytes[5] == 't' && bytes[6] == 'y' && bytes[7] == 'p') {
            return "mp4";
        }
        if (bytes.length >= 4 && (bytes[0] & 0xff) == 0x1a && (bytes[1] & 0xff) == 0x45
                && (bytes[2] & 0xff) == 0xdf && (bytes[3] & 0xff) == 0xa3) {
            return "mkv";
        }
        throw new IOException("Video container signature is not allow-listed");
    }

    private static Path createPrivateWorkspace() throws IOException {
        Path temp = Path.of(System.getProperty("java.io.tmpdir")).toRealPath(LinkOption.NOFOLLOW_LINKS);
        requireSafeWritableAncestors(temp);
        Path workspace = Files.createTempDirectory(temp, ".media-video-audio-");
        try {
            enforceOwnerOnlyDirectory(workspace);
            return workspace.toRealPath(LinkOption.NOFOLLOW_LINKS);
        } catch (IOException | RuntimeException failure) {
            try { Files.deleteIfExists(workspace); } catch (IOException cleanup) { failure.addSuppressed(cleanup); }
            throw failure;
        }
    }

    private static void writeOwnerOnlyInput(Path source, byte[] bytes) throws IOException {
        Files.write(source, bytes, java.nio.file.StandardOpenOption.CREATE_NEW,
                java.nio.file.StandardOpenOption.WRITE);
        java.nio.file.attribute.PosixFileAttributeView view = Files.getFileAttributeView(
                source, java.nio.file.attribute.PosixFileAttributeView.class, LinkOption.NOFOLLOW_LINKS);
        if (view == null) throw new IOException("Filesystem cannot enforce private video input permissions");
        view.setPermissions(java.util.EnumSet.of(java.nio.file.attribute.PosixFilePermission.OWNER_READ,
                java.nio.file.attribute.PosixFilePermission.OWNER_WRITE));
        if (Files.isSymbolicLink(source) || !Files.isRegularFile(source, LinkOption.NOFOLLOW_LINKS)
                || Files.size(source) != bytes.length) {
            throw new IOException("Staged video input is not a private regular file");
        }
    }

    private AudioStreamMetadata probeFirstAudioStream(Path video, String format) throws IOException {
        List<String> command = List.of("ffprobe", "-v", "error", "-protocol_whitelist", "file",
                "-f", format, "-max_alloc", "268435456", "-select_streams", "a:0",
                "-show_entries", "stream=index,time_base,start_pts,sample_rate,channels,duration_ts",
                "-of", "default=noprint_wrappers=1", video.toString());
        ProcessResult result = runProbeProcess(command, Duration.ofSeconds(10), MAX_DIAGNOSTIC_BYTES);
        if (result.timedOut()) throw new IOException("FFprobe audio-stream inspection timed out");
        if (result.outputExceeded() || result.diagnosticExceeded()) {
            throw new IOException("FFprobe audio-stream output exceeded its byte budget");
        }
        if (result.exitCode() != 0) throw new IOException("FFprobe audio-stream inspection failed");
        return parseAudioStreamMetadata(result.output());
    }

    ProcessResult runProbeProcess(List<String> command, Duration timeout, int maxDiagnosticBytes) throws IOException {
        return runProcess(command, timeout, maxDiagnosticBytes);
    }

    static AudioStreamMetadata parseAudioStreamMetadata(String output) throws IOException {
        if (output == null || output.isBlank()) return null;
        java.util.Map<String, String> values = new java.util.HashMap<>();
        for (String line : output.split("\\R")) {
            int separator = line.indexOf('=');
            if (separator > 0) {
                String key = line.substring(0, separator).trim();
                String value = line.substring(separator + 1).trim();
                if (values.putIfAbsent(key, value) != null) {
                    throw new IOException("FFprobe returned multiple audio stream records");
                }
            }
        }
        try {
            int index = Integer.parseInt(values.get("index"));
            int sampleRate = Integer.parseInt(values.get("sample_rate"));
            int channels = Integer.parseInt(values.get("channels"));
            String[] timeBase = values.get("time_base").split("/", -1);
            long numerator = Long.parseLong(timeBase[0]);
            long denominator = Long.parseLong(timeBase[1]);
            long duration = Long.parseLong(values.get("duration_ts"));
            String rawStart = values.get("start_pts");
            boolean startKnown = rawStart != null && !rawStart.equalsIgnoreCase("N/A");
            long start = startKnown ? Long.parseLong(rawStart) : 0L;
            if (index < 0 || sampleRate < 8_000 || sampleRate > 192_000 || channels < 1 || channels > 8
                    || numerator < 1 || numerator > 1_000_000_000L || denominator < 1
                    || denominator > 1_000_000_000L || duration <= 0) {
                throw new IOException("Audio stream metadata is outside configured bounds");
            }
            return new AudioStreamMetadata(index, sampleRate, channels, start, startKnown,
                    numerator, denominator, duration);
        } catch (IOException known) {
            throw known;
        } catch (RuntimeException invalid) {
            throw new IOException("Audio stream metadata is incomplete or invalid", invalid);
        }
    }

    private static boolean durationWithinLimit(AudioStreamMetadata metadata) {
        java.math.BigInteger ticksNanos = java.math.BigInteger.valueOf(metadata.durationTicks())
                .multiply(java.math.BigInteger.valueOf(metadata.timeBaseNumerator()))
                .multiply(java.math.BigInteger.valueOf(1_000_000_000L));
        java.math.BigInteger maxNanos = java.math.BigInteger.valueOf(MAX_DEMUXED_AUDIO_DURATION_SECONDS)
                .multiply(java.math.BigInteger.valueOf(1_000_000_000L))
                .multiply(java.math.BigInteger.valueOf(metadata.timeBaseDenominator()));
        return ticksNanos.compareTo(maxNanos) <= 0;
    }

    static void validateAudioOutput(Path output, Path expectedParent) throws IOException {
        Path normalized = output.toAbsolutePath().normalize();
        if (!normalized.getParent().equals(expectedParent) || Files.isSymbolicLink(normalized)
                || !Files.isRegularFile(normalized, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("FFmpeg produced an unsafe audio output path");
        }
        long size = Files.size(normalized);
        // FFmpeg's -fs stops output without guaranteeing that the stream was fully decoded.
        // Treat a file that reaches the cap as truncated/unknown rather than a valid transcript input.
        if (size <= 0 || (size & 1L) != 0 || size >= MAX_DEMUXED_AUDIO_BYTES) {
            throw new IOException("FFmpeg audio output is outside the bounded S16LE sample limits");
        }
    }

    /**
     * Extract a single frame at a specific timestamp.
     *
     * @param videoPath Path to the video file
     * @param timestampMs Timestamp in milliseconds
     * @param outputPath Output path for the frame; its existing parent must be owner-only/private
     *                   so another principal cannot read or replace published media
     * @throws IOException if extraction or staging cleanup fails. If cleanup fails after publication,
     *         the requested output frame may already exist.
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
        if (outputParent == null) {
            throw new IOException("Output frame path is unsafe");
        }
        rejectSymlinkComponents(requestedOutput, "Output frame path is unsafe");
        requireSafeWritableAncestors(outputParent);
        Files.createDirectories(outputParent);
        Path realOutputParent = outputParent.toRealPath();
        requireSafeWritableAncestors(realOutputParent);
        requireOwnerOnlyDirectory(realOutputParent);
        Path canonicalOutput = realOutputParent.resolve(outputName);
        if (Files.exists(canonicalOutput, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Output frame already exists");
        Path staging = createIsolatedStagingDirectory(realOutputParent);
        Path stagedOutput = staging.resolve("frame." + suffix);
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
            stagedOutput.toString(),
            "-n"
        );

        LOG.info("Extracting frame at timestamp {}ms", timestampMs);

        try {
            ProcessResult result = runFFmpegProcess(command, Duration.ofSeconds(30), MAX_DIAGNOSTIC_BYTES,
                    staging, MAX_SINGLE_FRAME_BYTES);
            if (result.timedOut()) throw new IOException("FFmpeg process timed out");
            if (result.diagnosticExceeded()) throw new IOException("FFmpeg diagnostic output exceeded its byte budget");
            if (result.outputExceeded()) throw new IOException("FFmpeg output exceeded its byte budget");
            if (result.exitCode() != 0) throw new IOException("FFmpeg failed with exit code: " + result.exitCode());
            validateSingleFrameOutput(stagedOutput, staging);
            Files.move(stagedOutput, canonicalOutput);
            cleanupStagingDirectory(staging);
        } catch (IOException | RuntimeException failure) {
            cleanupStagingDirectory(staging, failure);
            throw failure;
        }
    }

    ProcessResult runFFmpegProcess(List<String> command, Duration timeout, int maxDiagnosticBytes,
            Path monitoredOutput, long maxOutputBytes) throws IOException {
        return runProcess(command, timeout, maxDiagnosticBytes, monitoredOutput, maxOutputBytes);
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

        // Validate every candidate before sorting. A file inserted into the isolated output
        // directory with a frame-like but malformed name must fail as an I/O error and must
        // not escape the failure cleanup path through the comparator.
        try {
            for (File file : files) frameSequenceNumber(file.getName());
        } catch (IllegalArgumentException invalidSequence) {
            cleanupFrames(outputDir, config.getFormat());
            throw new IOException("FFmpeg produced an invalid frame sequence number", invalidSequence);
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
            "-v", "error", "-protocol_whitelist", "file",
            "-f", inputFormat(canonicalVideo),
            "-max_alloc", "268435456",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,duration,nb_frames,r_frame_rate,time_base",
            "-of", "default=noprint_wrappers=1",
            canonicalVideo.toString()
        );

        ProcessResult result = runProcess(command, Duration.ofSeconds(10), MAX_DIAGNOSTIC_BYTES);
        return parseProbeResult(result);
    }

    static VideoMetadata parseProbeResult(ProcessResult result) throws IOException {
        if (result.timedOut()) throw new IOException("FFprobe process timed out");
        if (result.outputExceeded()) throw new IOException("FFprobe output exceeded its byte budget");
        if (result.diagnosticExceeded()) {
            throw new IOException("FFprobe diagnostic output exceeded its byte budget");
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
        if (!MEDIA_PROCESS_SLOTS.tryAcquire()) {
            throw new IOException("Media process capacity is exhausted");
        }
        Process process;
        try {
            process = new ProcessBuilder(command).redirectErrorStream(true).start();
        } catch (IOException | RuntimeException | Error failure) {
            MEDIA_PROCESS_SLOTS.release();
            throw failure;
        }
        try {
            ByteArrayOutputStream captured = new ByteArrayOutputStream(Math.min(maxOutputChars, 1024));
            AtomicReference<IOException> drainFailure = new AtomicReference<>();
            java.util.concurrent.atomic.AtomicBoolean diagnosticExceeded = new java.util.concurrent.atomic.AtomicBoolean();
            Thread drain = new Thread(() -> drainBounded(process.getInputStream(), captured, maxOutputChars,
                    diagnosticExceeded, process, drainFailure),
                "media-child-output-drain");
            drain.setDaemon(true);
            drain.start();
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
            MEDIA_PROCESS_SLOTS.release();
        }
    }

    private static Path validateInput(Path input) throws IOException {
        if (input == null) throw new IOException("Video input path is unsafe");
        for (Path component : input) {
            if (component.toString().equals("..")) throw new IOException("Video input traversal is not allowed");
        }
        Path absolute = input.toAbsolutePath().normalize();
        rejectSymlinkComponents(absolute, "Video input path is unsafe");
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

    /** Prepare an exclusive per-call batch output root and enforce owner-only POSIX permissions. */
    static Path prepareOutputDirectory(Path requested) throws IOException {
        if (requested == null) throw new IOException("Output directory is required");
        for (Path component : requested) {
            if (component.toString().equals("..")) throw new IOException("Output traversal is not allowed");
        }
        Path output = requested.toAbsolutePath().normalize();
        rejectSymlinkComponents(output, "Output directory cannot contain symlinks");
        requireSafeWritableAncestors(output.getParent());
        Files.createDirectories(output);
        Path real = output.toRealPath(LinkOption.NOFOLLOW_LINKS);
        if (!Files.isDirectory(real, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(real)) {
            throw new IOException("Output directory is unsafe");
        }
        requireSafeWritableAncestors(real.getParent());
        try (var entries = Files.list(real)) {
            if (entries.findAny().isPresent()) throw new IOException("Output directory must be empty and isolated");
        }
        enforceOwnerOnlyDirectory(real);
        return real;
    }

    private static void requireSafeWritableAncestors(Path parent) throws IOException {
        if (parent == null) throw new IOException("FFmpeg output parent is not a safe directory");
        Path requested = parent.toAbsolutePath().normalize();
        Path existing = requested;
        while (existing != null && !Files.exists(existing, LinkOption.NOFOLLOW_LINKS)) existing = existing.getParent();
        if (existing == null || !Files.isDirectory(existing)) {
            throw new IOException("FFmpeg output parent is not a safe directory");
        }
        // Symlink aliases have already been checked by rejectSymlinkComponents. Inspect the
        // canonical chain so platform aliases such as macOS /var -> /private/var are handled
        // consistently with that allow-list.
        Path canonical = existing.toRealPath();
        for (Path ancestor = canonical; ancestor != null; ancestor = ancestor.getParent()) {
            if (!Files.isDirectory(ancestor, LinkOption.NOFOLLOW_LINKS)) {
                throw new IOException("FFmpeg output parent is not a safe directory");
            }
            int mode = unixMode(ancestor);
            boolean sharedWritable = (mode & 0022) != 0;
            boolean sticky = (mode & 01000) != 0;
            if (sharedWritable && (!sticky || !isTrustedStickyTempRoot(ancestor))) {
                throw new IOException("FFmpeg output parent is shared-writable without sticky protection");
            }
        }
    }

    private static boolean isTrustedStickyTempRoot(Path path) throws IOException {
        Path real = path.toRealPath(LinkOption.NOFOLLOW_LINKS);
        for (String candidate : List.of("/tmp", "/var/tmp")) {
            Path root = Path.of(candidate);
            if (Files.exists(root, LinkOption.NOFOLLOW_LINKS) && real.equals(root.toRealPath())) return true;
        }
        return false;
    }

    private static void requireOwnerOnlyDirectory(Path directory) throws IOException {
        java.nio.file.attribute.PosixFileAttributeView view = Files.getFileAttributeView(
                directory, java.nio.file.attribute.PosixFileAttributeView.class, LinkOption.NOFOLLOW_LINKS);
        if (view == null) {
            throw new IOException("Filesystem cannot verify owner-only FFmpeg output directories");
        }
        java.util.Set<java.nio.file.attribute.PosixFilePermission> actual;
        try {
            actual = view.readAttributes().permissions();
        } catch (UnsupportedOperationException | SecurityException unsupported) {
            throw new IOException("Filesystem cannot verify owner-only FFmpeg output directories", unsupported);
        }
        if (actual.stream().anyMatch(permission -> switch (permission) {
            case GROUP_READ, GROUP_WRITE, GROUP_EXECUTE, OTHERS_READ, OTHERS_WRITE, OTHERS_EXECUTE -> true;
            default -> false;
        }) || !actual.contains(java.nio.file.attribute.PosixFilePermission.OWNER_WRITE)
                || !actual.contains(java.nio.file.attribute.PosixFilePermission.OWNER_EXECUTE)) {
            throw new IOException("Single-frame output parent must be owner-only to protect extracted media");
        }
    }

    private static void enforceOwnerOnlyDirectory(Path directory) throws IOException {
        java.nio.file.attribute.PosixFileAttributeView view = Files.getFileAttributeView(
                directory, java.nio.file.attribute.PosixFileAttributeView.class, LinkOption.NOFOLLOW_LINKS);
        if (view == null) {
            throw new IOException("Filesystem cannot enforce owner-only FFmpeg output directories");
        }
        java.util.Set<java.nio.file.attribute.PosixFilePermission> ownerOnly = java.util.EnumSet.of(
                java.nio.file.attribute.PosixFilePermission.OWNER_READ,
                java.nio.file.attribute.PosixFilePermission.OWNER_WRITE,
                java.nio.file.attribute.PosixFilePermission.OWNER_EXECUTE);
        try {
            view.setPermissions(ownerOnly);
            java.util.Set<java.nio.file.attribute.PosixFilePermission> actual = view.readAttributes().permissions();
            if (!ownerOnly.containsAll(actual)
                    || !actual.contains(java.nio.file.attribute.PosixFilePermission.OWNER_READ)
                    || !actual.contains(java.nio.file.attribute.PosixFilePermission.OWNER_WRITE)
                    || !actual.contains(java.nio.file.attribute.PosixFilePermission.OWNER_EXECUTE)) {
                throw new IOException("Filesystem did not enforce owner-only FFmpeg output permissions");
            }
        } catch (UnsupportedOperationException | SecurityException unsupported) {
            throw new IOException("Filesystem cannot enforce owner-only FFmpeg output directories", unsupported);
        }
    }

    private static int unixMode(Path path) throws IOException {
        try {
            Object value = Files.getAttribute(path, "unix:mode", LinkOption.NOFOLLOW_LINKS);
            if (value instanceof Integer mode) return mode;
            throw new IOException("Filesystem returned an invalid Unix permission mode");
        } catch (UnsupportedOperationException | IllegalArgumentException unsupported) {
            throw new IOException("Filesystem cannot verify FFmpeg output parent permissions", unsupported);
        }
    }

    private static Path createIsolatedStagingDirectory(Path sameFilesystemParent) throws IOException {
        Path parent = sameFilesystemParent.toRealPath(LinkOption.NOFOLLOW_LINKS);
        if (!Files.isDirectory(parent, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(parent)) {
            throw new IOException("FFmpeg staging parent is unsafe");
        }
        Path staging = Files.createTempDirectory(parent, ".media-ffmpeg-");
        return staging.toRealPath(LinkOption.NOFOLLOW_LINKS);
    }

    static List<ExtractedFrame> publishStagedFrames(List<ExtractedFrame> stagedFrames, Path outputDirectory)
            throws IOException {
        return publishStagedFrames(stagedFrames, outputDirectory, ignored -> { });
    }

    static List<ExtractedFrame> publishStagedFrames(List<ExtractedFrame> stagedFrames, Path outputDirectory,
            Consumer<Path> afterPublish) throws IOException {
        List<PublishedFrame> published = new ArrayList<>();
        List<ExtractedFrame> result = new ArrayList<>(stagedFrames.size());
        try {
            for (ExtractedFrame frame : stagedFrames) {
                Path destination = outputDirectory.resolve(frame.getPath().getFileName());
                if (!destination.normalize().getParent().equals(outputDirectory)
                        || Files.exists(destination, LinkOption.NOFOLLOW_LINKS)) {
                    throw new IOException("FFmpeg frame destination is unsafe or already exists");
                }
                Object stagedIdentity = fileIdentity(frame.getPath());
                // Plain move preserves the no-replace behavior; ATOMIC_MOVE may replace an
                // existing target on some providers even without REPLACE_EXISTING.
                Files.move(frame.getPath(), destination);
                // Record the staged identity immediately after the move so a failed post-move
                // identity read still enters the ownership-checked rollback path.
                published.add(new PublishedFrame(destination, stagedIdentity));
                Object publishedIdentity = fileIdentity(destination);
                if (!stagedIdentity.equals(publishedIdentity)) {
                    throw new IOException("FFmpeg frame destination changed during publication");
                }
                result.add(new ExtractedFrame(destination, frame.getSourceTimestamp(), frame.getFrameNumber()));
                afterPublish.accept(destination);
            }
        } catch (IOException | RuntimeException failure) {
            // Roll back only entries this invocation successfully published.
            for (PublishedFrame frame : published) {
                try {
                    if (Files.exists(frame.path(), LinkOption.NOFOLLOW_LINKS)
                            && frame.identity().equals(fileIdentity(frame.path()))) {
                        Files.delete(frame.path());
                    }
                } catch (IOException | RuntimeException rollbackFailure) {
                    failure.addSuppressed(new IOException("Could not safely roll back a published FFmpeg frame", rollbackFailure));
                }
            }
            throw failure;
        }
        return result;
    }

    private record PublishedFrame(Path path, Object identity) { }

    private static Object fileIdentity(Path path) throws IOException {
        BasicFileAttributes attributes = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        Object identity = attributes.fileKey();
        if (!attributes.isRegularFile() || identity == null) {
            throw new IOException("Filesystem does not provide a safe regular-file identity for FFmpeg output");
        }
        return identity;
    }

    static void cleanupStagingDirectory(Path staging) throws IOException {
        if (staging == null || !Files.exists(staging, LinkOption.NOFOLLOW_LINKS)) return;
        if (!Files.isDirectory(staging, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(staging)) {
            throw new IOException("FFmpeg staging path changed or is not a private directory");
        }
        Files.walkFileTree(staging, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                Files.delete(file);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path directory, IOException failure) throws IOException {
                if (failure != null) throw failure;
                Files.delete(directory);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    private static void cleanupStagingDirectory(Path staging, Throwable primaryFailure) {
        try {
            cleanupStagingDirectory(staging);
        } catch (IOException | RuntimeException cleanupFailure) {
            primaryFailure.addSuppressed(new IOException("FFmpeg staging cleanup failed", cleanupFailure));
        }
    }

    /** Reject aliases in any existing component so validation and child-process access share one path. */
    private static void rejectSymlinkComponents(Path absolute, String message) throws IOException {
        Path current = absolute.getRoot();
        if (current == null) throw new IOException(message);
        Path systemTemp = Path.of(System.getProperty("java.io.tmpdir")).toRealPath();
        for (Path component : absolute) {
            current = current.resolve(component);
            // Some platforms expose the configured system temp directory through a
            // stable OS alias (for example /var -> /private/var on macOS). Permit
            // only symlinks whose real targets are ancestors of that trusted temp root.
            if (Files.isSymbolicLink(current)) {
                Path realComponent = current.toRealPath();
                if (!systemTemp.startsWith(realComponent)) throw new IOException(message);
            }
        }
    }

    private static void cleanupFrames(Path directory, String format) {
        if (directory == null || !Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) return;
        try (var paths = Files.list(directory)) {
            paths.filter(path -> path.getFileName().toString().matches("frame_[^/]*\\." + java.util.regex.Pattern.quote(format)))
                    // deleteIfExists removes a symbolic link itself; it does not follow it.
                    // Clean frame-like links from this isolated output directory so failed
                    // extraction cannot poison its next use while leaving link targets intact.
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
