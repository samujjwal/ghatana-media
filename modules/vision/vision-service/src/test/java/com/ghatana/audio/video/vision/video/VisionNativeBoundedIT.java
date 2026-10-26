package com.ghatana.audio.video.vision.video;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.ghatana.audio.video.vision.image.BoundedImageDecoder;
import org.opencv.core.CvType;
import org.opencv.core.Mat;
import nu.pattern.OpenCV;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Development-only native codec regression using generated, synthetic media fixtures.
 *
 * <p>The test refuses tools other than the verified platform-specific FFmpeg/FFprobe 8.1.2
 * executables. The Linux pins identify GPL test tools used only as external processes; no tool
 * binaries are bundled or exercised in the Media runtime. This does not exercise model inference:
 * no admitted Vision model is needed or implied by these codec checks.
 */
class VisionNativeBoundedIT {
    private static final Path FFMPEG = configuredToolPath("media.vision.ffmpeg", "GHATANA_MEDIA_FFMPEG", "ffmpeg");
    private static final Path FFPROBE = configuredToolPath("media.vision.ffprobe", "GHATANA_MEDIA_FFPROBE", "ffprobe");
    private static final Map<String, NativeToolPins> VERIFIED_TOOL_PINS = Map.of(
            "macos/aarch64", new NativeToolPins(
                    "5bea4e7be361c9557334f5ae50640c82944304eb5f97d8c248622cf8d1e9bb33",
                    "b1065dd4a8d4a39b0617818117dadf0502c6bded4314bea3d74bd98b57fa5f7f"),
            "linux/amd64", new NativeToolPins(
                    "ad7a8c8e8fe4f50972f32f63705cfcc57f44cd3531f57aa8defe388372242f5e",
                    "150bfd75016992a8d495a5f5c16cd93387a21c059f4309ed1e6342659aef48b3"),
            "linux/aarch64", new NativeToolPins(
                    "1b216dbbe46adf213945d357ef958404eed1632e7fb38a85f7f030ed9c212bcf",
                    "67efa97371fb54199f23a4d33c9b1dbb389089b2d36b4ebab8ebc6eca68a51c4"));
    private static final long MAX_FIXTURE_BYTES = 2L * 1024 * 1024;
    // Sampled peak RSS is evidence only; the portable child limits below do not enforce RSS.
    private static final long MAX_CHILD_RSS_BYTES = 512L * 1024 * 1024;

    @TempDir Path temp;

    @Test
    void pinnedNativeToolsBoundSyntheticH264AacVfrAndWebpInputs() throws Exception {
        verifyPinnedTools();
        Path avc = temp.resolve("generated-avc-aac.mp4");
        VideoFrameExtractor extractor = new VideoFrameExtractor();
        NativeRun avcRun = runNative(List.of(
                FFMPEG.toString(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=24:duration=1",
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=1",
                "-c:v", h264Encoder(), "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-shortest", avc.toString()), Duration.ofSeconds(15), MAX_FIXTURE_BYTES);
        assertBounded(avcRun, 15);
        assertThat(Files.size(avc)).isBetween(1L, MAX_FIXTURE_BYTES);
        String streams = probe(avc, "-show_entries", "stream=codec_type,codec_name,width,height");
        assertThat(streams).contains("codec_name=h264", "codec_name=aac", "width=160", "height=120");
        VideoFrameExtractor.ExtractedAudioTrack audio = extractor.extractAudioTrack(Files.readAllBytes(avc));
        assertThat(audio.sampleRate()).isEqualTo(16_000);
        assertThat(audio.channels()).isEqualTo(1);
        assertThat(audio.sampleCount()).isPositive();
        assertPathCommandResolvesTo("ffmpeg", FFMPEG);
        assertPathCommandResolvesTo("ffprobe", FFPROBE);
        Path extracted = temp.resolve("frames-run-one");
        List<VideoFrameExtractor.ExtractedFrame> extractedFrames = extractor.extractFrames(
                avc, extracted, VideoFrameExtractor.ExtractionConfig.builder().fps(2).maxFrames(4).build());
        assertThat(extractedFrames).isNotEmpty();
        try (var files = Files.list(extracted)) { assertThat(files.count()).isEqualTo(extractedFrames.size()); }
        assertThat(Files.getPosixFilePermissions(extracted)).containsExactlyInAnyOrder(
                java.nio.file.attribute.PosixFilePermission.OWNER_READ,
                java.nio.file.attribute.PosixFilePermission.OWNER_WRITE,
                java.nio.file.attribute.PosixFilePermission.OWNER_EXECUTE);
        Path extractedAgain = temp.resolve("frames-run-two");
        assertThat(new VideoFrameExtractor().extractFrames(avc, extractedAgain,
                VideoFrameExtractor.ExtractionConfig.builder().fps(1).maxFrames(2).build())).isNotEmpty();
        try (var files = Files.list(extractedAgain)) { assertThat(files.count()).isPositive(); }

        Path vfr = temp.resolve("generated-vfr.mp4");
        NativeRun vfrRun = runNative(List.of(
                FFMPEG.toString(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=10:duration=1",
                "-vf", "setpts='N/(10*TB)+gte(N,5)*0.2/TB'", // FFmpeg filtergraph quoting, not shell escaping.
                "-fps_mode", "vfr",
                "-c:v", h264Encoder(), "-pix_fmt", "yuv420p", vfr.toString()),
                Duration.ofSeconds(15), MAX_FIXTURE_BYTES);
        assertBounded(vfrRun, 15);
        assertThat(Files.size(vfr)).isBetween(1L, MAX_FIXTURE_BYTES);
        String frames = probe(vfr, "-select_streams", "v:0", "-show_entries",
                "frame=best_effort_timestamp_time", "-of", "csv=p=0");
        List<Double> timestamps = frames.lines().map(String::trim)
                .filter(line -> line.matches("\\d+(?:\\.\\d+)?"))
                .map(Double::parseDouble).toList();
        assertThat(timestamps).hasSizeGreaterThan(2);
        List<Double> intervals = java.util.stream.IntStream.range(1, timestamps.size())
                .mapToObj(index -> timestamps.get(index) - timestamps.get(index - 1)).toList();
        assertThat(intervals.stream().distinct().count()).as("VFR fixture retains irregular frame intervals")
                .isGreaterThan(1);
        Path vfrFrames = temp.resolve("vfr-extracted-frames");
        List<VideoFrameExtractor.ExtractedFrame> extractedVfr = extractor.extractFrames(vfr, vfrFrames,
                VideoFrameExtractor.ExtractionConfig.builder().fps(60).maxFrames(20).build());
        List<SourceMediaTimestamp> sourceTimestamps = extractedVfr.stream()
                .map(VideoFrameExtractor.ExtractedFrame::getSourceTimestamp).toList();
        assertThat(sourceTimestamps).hasSizeGreaterThan(2)
                .allSatisfy(timestamp -> assertThat(timestamp.isKnown()).isTrue());
        List<Long> sourceIntervals = java.util.stream.IntStream.range(1, sourceTimestamps.size())
                .mapToObj(index -> sourceTimestamps.get(index).timestampMs()
                        - sourceTimestamps.get(index - 1).timestampMs()).toList();
        assertThat(sourceIntervals.stream().distinct().count())
                .as("extracted VFR timestamps preserve nonuniform source intervals").isGreaterThan(1);

        // The pinned macOS LGPL build has no WebP encoder; the Linux pins are GPL builds. Keep a
        // tiny deterministic WebP fixture generated locally with Pillow so the Java decoder path
        // remains exercised without adding a runtime dependency or fetching media.
        byte[] webp = java.util.Base64.getDecoder().decode(
                "UklGRnYAAABXRUJQVlA4IGoAAADQBwCdASqgAHgAPm02mUmkIyKhIGgAgA2JaW7hdUlwH4AAAO6HVUmyYh1VJsmIdVSbJiHVUmyYh1VJsmIdVSbJiHVUmyYh1VJsmIdVSbJiHVUmyYWAAD+/uB7///ILlhdcjX//5Af8gP+QH/8fFMrSlfcCAAAAAAA");
        Path webpPath = Files.write(temp.resolve("generated.webp"), webp);
        assertThat(Files.size(webpPath)).isLessThan(MAX_FIXTURE_BYTES);
        assertThat(probe(webpPath, "-show_entries", "stream=codec_name,width,height"))
                .contains("codec_name=webp", "width=160", "height=120");
        NativeRun webpDecode = runNative(List.of(FFMPEG.toString(), "-hide_banner", "-loglevel", "error",
                "-nostdin", "-i", webpPath.toString(), "-frames:v", "1", "-f", "null", "-"),
                Duration.ofSeconds(5), MAX_FIXTURE_BYTES);
        assertBounded(webpDecode, 5, false);
        assertThat(webpDecode.exitCode()).isZero();
        assertThatThrownBy(() -> BoundedImageDecoder.decode(webp))
                .isInstanceOfSatisfying(BoundedImageDecoder.ImageInputException.class,
                        failure -> assertThat(failure.reason())
                                .isEqualTo(BoundedImageDecoder.ImageInputException.Reason.MALFORMED_ENCODING));
        long extractedBytes;
        try (var files = Files.list(extracted)) {
            extractedBytes = files.mapToLong(path -> {
                try { return Files.size(path); } catch (IOException failure) { throw new java.io.UncheckedIOException(failure); }
            }).sum();
        }
        System.out.printf("VISION_NATIVE_FIXTURE_BYTES h264Aac=%d audioPcm=%d extractedFrames=%d "
                        + "extractedOutput=%d vfr=%d vfrExtractedFrames=%d webp=%d caps={fixture:%d,frame:%d,aggregate:%d}%n",
                Files.size(avc), audio.pcmS16le().length, extractedFrames.size(), extractedBytes,
                Files.size(vfr), extractedVfr.size(), Files.size(webpPath), MAX_FIXTURE_BYTES,
                32L * 1024 * 1024, 512L * 1024 * 1024);
        assertThatThrownBy(() -> BoundedImageDecoder.decode(pngHeader(8192, 8192)))
                .isInstanceOfSatisfying(BoundedImageDecoder.ImageInputException.class,
                        failure -> assertThat(failure.reason())
                                .isEqualTo(BoundedImageDecoder.ImageInputException.Reason.DECODED_SIZE_LIMIT));
    }

    @Test
    void nativeTimeoutOutputByteAndInputPathGuardsFailClosedAndCleanStaging() throws Exception {
        verifyPinnedTools();
        Path staging = Files.createDirectory(temp.resolve("bounded-native-output"));
        VideoFrameExtractor.ProcessResult outputCapped = VideoFrameExtractor.runProcess(
                boundedCommand(List.of(FFMPEG.toString(), "-hide_banner", "-loglevel", "error", "-nostdin",
                "-f", "lavfi", "-i", "color=c=blue:s=160x120", "-frames:v", "2",
                "-c:v", "bmp", "-f", "image2", staging.resolve("frame_%d.bmp").toString())),
                Duration.ofSeconds(10), 4096, staging, 1);
        assertThat(outputCapped.outputExceeded()).isTrue();
        long cappedOutputBytes;
        try (var files = Files.list(staging)) {
            cappedOutputBytes = files.mapToLong(path -> {
                try { return Files.size(path); } catch (IOException failure) { throw new java.io.UncheckedIOException(failure); }
            }).sum();
        }
        System.out.printf("VISION_NATIVE_OUTPUT_CAP configuredBytes=1 observedBytes=%d%n", cappedOutputBytes);
        VideoFrameExtractor.cleanupStagingDirectory(staging);
        assertThat(Files.exists(staging)).isFalse();

        VideoFrameExtractor.ProcessResult timeout = VideoFrameExtractor.runProcess(
                boundedCommand(List.of(FFMPEG.toString(), "-hide_banner", "-loglevel", "error", "-nostdin",
                "-f", "lavfi", "-i", "testsrc2=size=4096x2160:rate=60", "-f", "null", "-")),
                Duration.ofMillis(100), 4096);
        assertThat(timeout.timedOut()).isTrue();

        NativeRun killedTree = runNative(List.of(FFMPEG.toString(), "-hide_banner", "-loglevel", "error",
                "-nostdin", "-f", "lavfi", "-i", "testsrc2=size=4096x2160:rate=60", "-f", "null", "-"),
                Duration.ofMillis(100), 4096);
        assertThat(killedTree.timedOut()).isTrue();
        assertThat(killedTree.childPids()).allSatisfy(pid -> assertThat(ProcessHandle.of(pid)
                .map(ProcessHandle::isAlive).orElse(false)).isFalse());
        assertThat(ProcessHandle.of(killedTree.pid()).map(ProcessHandle::isAlive).orElse(false)).isFalse();

        Path validNameButTruncated = Files.write(temp.resolve("truncated.mp4"),
                new byte[] {0, 0, 0, 24, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm'});
        NativeRun malformed = runNative(List.of(FFPROBE.toString(), "-v", "error", "-show_format",
                validNameButTruncated.toString()), Duration.ofSeconds(5), 4096);
        assertThat(malformed.exitCode()).isNotZero();
        Path failedOutput = temp.resolve("truncated-extraction");
        assertThatThrownBy(() -> new VideoFrameExtractor().extractFrames(validNameButTruncated, failedOutput,
                VideoFrameExtractor.ExtractionConfig.builder().build())).isInstanceOf(IOException.class);
        try (var files = Files.list(failedOutput)) { assertThat(files.count()).isZero(); }

        Path target = Files.write(temp.resolve("target.mp4"), new byte[] {1});
        Path link = temp.resolve("linked.mp4");
        try {
            Files.createSymbolicLink(link, target);
            assertThatThrownBy(() -> new VideoFrameExtractor().extractFrames(link,
                    temp.resolve("symlink-output"), VideoFrameExtractor.ExtractionConfig.builder().build()))
                    .isInstanceOf(IOException.class).hasMessageContaining("unsafe");
        } catch (UnsupportedOperationException | SecurityException unsupported) {
            // Symlinks are a host capability; the production path rejects them where supported.
        }
    }

    @Test
    void repeatedOpenCvMatReleaseClearsNativeDataWithoutAProviderModel() throws Exception {
        verifyPinnedTools();
        OpenCV.loadLocally();
        for (int iteration = 0; iteration < 256; iteration++) {
            Mat mat = new Mat(64, 64, CvType.CV_8UC3);
            try {
                assertThat(mat.dataAddr()).as("allocated native Mat data at iteration %s", iteration).isPositive();
                mat.put(0, 0, new byte[64 * 64 * 3]);
            } finally {
                mat.release();
            }
            assertThat(mat.dataAddr()).as("released native Mat data at iteration %s", iteration).isZero();
        }
    }

    private static void verifyPinnedTools() throws Exception {
        assumeTrue("true".equalsIgnoreCase(System.getenv("GHATANA_MEDIA_NATIVE_VISION_REQUIRED")),
                "native Vision integration is opt-in; set GHATANA_MEDIA_NATIVE_VISION_REQUIRED=true");
        NativeToolPins pins = VERIFIED_TOOL_PINS.get(platformKey());
        if (pins == null) {
            throw new IllegalStateException("No trusted FFmpeg 8.1.2/FFprobe 8.1.2 SHA-256 pins for "
                    + platformKey() + "; add independently verified platform pins before running this test");
        }
        assertThat(Files.isExecutable(FFMPEG)).as("verified FFmpeg executable exists").isTrue();
        assertThat(Files.isExecutable(FFPROBE)).as("verified FFprobe executable exists").isTrue();
        assertThat(sha256(FFMPEG)).isEqualTo(pins.ffmpegSha256());
        assertThat(sha256(FFPROBE)).isEqualTo(pins.ffprobeSha256());
        System.out.printf("VISION_NATIVE_ENV host=%s os=%s arch=%s ffmpegSha256=%s ffprobeSha256=%s%n",
                java.lang.management.ManagementFactory.getRuntimeMXBean().getName(),
                System.getProperty("os.name"), System.getProperty("os.arch"),
                sha256(FFMPEG), sha256(FFPROBE));
        assertThat(runNative(List.of(FFMPEG.toString(), "-version"), Duration.ofSeconds(3), 4096)
                .output()).contains("8.1.2");
        assertThat(runNative(List.of(FFPROBE.toString(), "-version"), Duration.ofSeconds(3), 4096)
                .output()).contains("8.1.2");
        assertThat(runNative(List.of(FFMPEG.toString(), "-hide_banner", "-encoders"), Duration.ofSeconds(5),
                64 * 1024).output()).contains(h264Encoder());
    }

    private String probe(Path source, String... options) throws Exception {
        java.util.ArrayList<String> command = new java.util.ArrayList<>(List.of(FFPROBE.toString(), "-v", "error"));
        command.addAll(List.of(options));
        command.add(source.toString());
        NativeRun run = runNative(command, Duration.ofSeconds(5), 64 * 1024);
        assertBounded(run, 5, false);
        assertThat(run.exitCode()).isZero();
        return run.output();
    }

    private static NativeRun runNative(List<String> command, Duration timeout, long outputLimit) throws Exception {
        Process process = new ProcessBuilder(timedCommand(command)).redirectErrorStream(true).start();
        ProcessHandle processHandle = process.toHandle();
        long startedNanos = System.nanoTime();
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        java.util.concurrent.atomic.AtomicLong totalOutputBytes = new java.util.concurrent.atomic.AtomicLong();
        java.util.concurrent.atomic.AtomicBoolean outputExceeded = new java.util.concurrent.atomic.AtomicBoolean();
        Thread reader = new Thread(() -> {
            try (var stream = process.getInputStream()) {
                byte[] bytes = new byte[4096];
                int count;
                while ((count = stream.read(bytes)) >= 0) {
                    long total = totalOutputBytes.addAndGet(count);
                    if (total > outputLimit && outputExceeded.compareAndSet(false, true)) {
                        process.toHandle().descendants().forEach(ProcessHandle::destroyForcibly);
                        process.destroyForcibly();
                    }
                    synchronized (output) {
                        output.write(bytes, 0, Math.min(count, Math.max(0,
                                (int) Math.min(Integer.MAX_VALUE, outputLimit - output.size()))));
                    }
                }
            } catch (IOException ignored) { }
        }, "vision-native-output-drain");
        reader.setDaemon(true);
        reader.start();
        long deadline = System.nanoTime() + timeout.toNanos();
        long peakRssBytes = rssBytes(process.pid());
        long cpuMillis = isLinux() ? sampleCpuMillis(processHandle, -1) : -1;
        long sampleIntervalMillis = isLinux() ? 10 : 25;
        boolean timedOut = false;
        List<Long> childPids = new java.util.ArrayList<>();
        while (process.isAlive() && System.nanoTime() < deadline) {
            if (isLinux()) cpuMillis = sampleCpuMillis(processHandle, cpuMillis);
            peakRssBytes = Math.max(peakRssBytes, rssBytes(process.pid()));
            for (ProcessHandle child : processHandle.descendants().toList()) {
                peakRssBytes = Math.max(peakRssBytes, rssBytes(child.pid()));
            }
            // Linux reads /proc directly, so it can sample more frequently without helper-process
            // overhead. macOS uses `ps`, so keep that sampling cadence lower.
            process.waitFor(sampleIntervalMillis, TimeUnit.MILLISECONDS);
        }
        if (process.isAlive()) {
            timedOut = true;
            childPids = processHandle.descendants().map(ProcessHandle::pid).toList();
            process.descendants().forEach(handle -> handle.destroyForcibly());
            process.destroyForcibly();
            process.waitFor(2, TimeUnit.SECONDS);
            long cleanupDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
            while (System.nanoTime() < cleanupDeadline && childPids.stream()
                    .anyMatch(pid -> ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false))) {
                Thread.sleep(10);
            }
        }
        reader.join(2_000);
        String captured;
        synchronized (output) { captured = output.toString(StandardCharsets.UTF_8); }
        if (isMacOS()) cpuMillis = parsePosixCpuMillis(captured);
        long elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos);
        return new NativeRun(timedOut ? -1 : process.exitValue(), timedOut, captured,
                peakRssBytes, elapsedMillis, cpuMillis, process.pid(), childPids, outputExceeded.get());
    }

    private static long parsePosixCpuMillis(String output) {
        Matcher user = Pattern.compile("(?m)^user\\s+([0-9]+(?:\\.[0-9]+)?)$").matcher(output);
        Matcher system = Pattern.compile("(?m)^sys\\s+([0-9]+(?:\\.[0-9]+)?)$").matcher(output);
        if (!user.find() || !system.find()) return -1;
        return Math.round((Double.parseDouble(user.group(1)) + Double.parseDouble(system.group(1))) * 1000.0);
    }

    private static long sampleCpuMillis(ProcessHandle processHandle, long previousCpuMillis) {
        Optional<Duration> cpuDuration = processHandle.info().totalCpuDuration();
        return cpuDuration.map(Duration::toMillis).map(sampled -> Math.max(previousCpuMillis, sampled))
                .orElse(previousCpuMillis);
    }

    private static long rssBytes(long pid) {
        if (isLinux()) return linuxRssBytes(pid);
        try {
            Process ps = new ProcessBuilder("ps", "-o", "rss=", "-p", Long.toString(pid)).start();
            if (!ps.waitFor(250, TimeUnit.MILLISECONDS)) {
                ps.destroyForcibly();
                return 0;
            }
            String rss = new String(ps.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
            return rss.isEmpty() ? 0 : Long.parseLong(rss) * 1024L;
        } catch (Exception ignored) {
            return 0;
        }
    }

    private static long linuxRssBytes(long pid) {
        Path status = Path.of("/proc", Long.toString(pid), "status");
        try (var reader = Files.newBufferedReader(status, StandardCharsets.US_ASCII)) {
            for (String line; (line = reader.readLine()) != null;) {
                if (!line.startsWith("VmRSS:")) continue;
                String[] fields = line.trim().split("\\s+");
                return fields.length >= 2 ? Long.parseLong(fields[1]) * 1024L : 0;
            }
        } catch (IOException | NumberFormatException ignored) { }
        return 0;
    }

    private static void assertBounded(NativeRun run, int maxSeconds) {
        assertBounded(run, maxSeconds, true, true);
    }

    private static void assertBounded(NativeRun run, int maxSeconds, boolean requireObservedRss) {
        assertBounded(run, maxSeconds, requireObservedRss, false);
    }

    private static void assertBounded(NativeRun run, int maxSeconds, boolean requireObservedRss,
            boolean requireObservedCpu) {
        assertThat(run.timedOut()).isFalse();
        assertThat(run.elapsedMillis()).isLessThanOrEqualTo(maxSeconds * 1000L);
        if (requireObservedCpu) {
            assertThat(run.cpuMillis()).as("direct native process CPU time was observed")
                    .isGreaterThanOrEqualTo(0);
        }
        if (run.cpuMillis() >= 0) assertThat(run.cpuMillis()).isLessThanOrEqualTo(maxSeconds * 1000L);
        assertThat(run.outputExceeded()).isFalse();
        assertThat(run.output().getBytes(StandardCharsets.UTF_8).length).isLessThanOrEqualTo(64 * 1024);
        if (requireObservedRss) {
            assertThat(run.peakRssBytes()).as("sampled child RSS must be observable").isPositive()
                    .isLessThanOrEqualTo(MAX_CHILD_RSS_BYTES);
            System.out.printf("VISION_NATIVE_METRIC pid=%d wallMs=%d cpuMs=%d sampledPeakRssBytes=%d "
                            + "capturedOutputBytes=%d%n", run.pid(), run.elapsedMillis(), run.cpuMillis(),
                    run.peakRssBytes(), run.output().getBytes(StandardCharsets.UTF_8).length);
        } else if (run.peakRssBytes() > 0) {
            assertThat(run.peakRssBytes()).isLessThanOrEqualTo(MAX_CHILD_RSS_BYTES);
        }
    }

    private static List<String> boundedCommand(List<String> command) {
        java.util.ArrayList<String> bounded = new java.util.ArrayList<>(List.of("/bin/sh", "-c",
                "ulimit -t 15 || exit 91; ulimit -f " + fixtureFileLimitBlocks()
                        + " || exit 92; exec \"$@\"", "vision-native"));
        bounded.addAll(command);
        return List.copyOf(bounded);
    }

    private static List<String> timedCommand(List<String> command) {
        java.util.ArrayList<String> timed = new java.util.ArrayList<>();
        // macOS ProcessHandle does not expose child CPU duration; /usr/bin/time -p is available
        // there. Linux containers may omit the `time` package, so sample ProcessHandle while the
        // sustained fixture process is alive instead.
        if (isMacOS()) timed.addAll(List.of("/usr/bin/time", "-p"));
        timed.addAll(boundedCommand(command));
        return List.copyOf(timed);
    }

    private static boolean isLinux() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("linux");
    }

    private static boolean isMacOS() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("mac");
    }

    private static int fixtureFileLimitBlocks() {
        // Keep RLIMIT_FSIZE at or below 2 MiB across supported shells: Darwin reports 512-byte
        // blocks; Linux shell implementations differ (Temurin's /bin/sh applies 512-byte blocks,
        // while Bash uses 1 KiB). Explicit byte assertions remain the final fixture/output check.
        return switch (platformKey().split("/")[0]) {
            case "macos" -> 4096;
            case "linux" -> 2048;
            default -> throw new IllegalStateException("No native file-size limit configured for " + platformKey());
        };
    }

    private static Path configuredToolPath(String systemProperty, String environmentVariable, String executable) {
        // The selected binaries are hashed here; the service integration separately verifies that PATH resolves
        // to the same files so its production command names cannot silently use different tools.
        String configured = System.getProperty(systemProperty);
        if (configured == null || configured.isBlank()) configured = System.getenv(environmentVariable);
        if (configured != null && !configured.isBlank()) return Path.of(configured).toAbsolutePath().normalize();
        for (String entry : System.getenv().getOrDefault("PATH", "").split(java.io.File.pathSeparator)) {
            if (entry.isBlank()) continue;
            Path candidate = Path.of(entry).resolve(executable);
            if (Files.isExecutable(candidate)) return candidate.toAbsolutePath().normalize();
        }
        return Path.of(executable);
    }

    private static String platformKey() {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        String arch = System.getProperty("os.arch", "").toLowerCase(Locale.ROOT);
        String normalizedOs = os.contains("mac") ? "macos" : os.contains("linux") ? "linux" : os;
        String normalizedArch = switch (arch) {
            case "aarch64", "arm64" -> "aarch64";
            case "amd64", "x86_64", "x64" -> "amd64";
            default -> arch;
        };
        return normalizedOs + "/" + normalizedArch;
    }

    private static String h264Encoder() {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        if (os.contains("mac")) return "h264_videotoolbox";
        if (os.contains("linux")) return "libx264";
        throw new IllegalStateException("No verified H.264 fixture encoder selected for " + platformKey());
    }

    private static void assertPathCommandResolvesTo(String name, Path expected) throws IOException {
        for (String entry : System.getenv().getOrDefault("PATH", "").split(java.io.File.pathSeparator)) {
            Path candidate = Path.of(entry).resolve(name);
            if (Files.isExecutable(candidate)) {
                assertThat(candidate.toRealPath()).isEqualTo(expected.toRealPath());
                return;
            }
        }
        throw new AssertionError(name + " is not available on PATH for VideoFrameExtractor integration");
    }

    private static byte[] pngHeader(int width, int height) {
        java.nio.ByteBuffer png = java.nio.ByteBuffer.allocate(33).order(java.nio.ByteOrder.BIG_ENDIAN);
        png.put(new byte[] {(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'});
        png.putInt(13).put(new byte[] {'I', 'H', 'D', 'R'}).putInt(width).putInt(height);
        png.put(new byte[] {8, 2, 0, 0, 0});
        java.util.zip.CRC32 crc = new java.util.zip.CRC32();
        crc.update(png.array(), 12, 17);
        png.putInt((int) crc.getValue());
        return png.array();
    }

    private static String sha256(Path path) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (var input = Files.newInputStream(path)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) digest.update(buffer, 0, read);
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    private record NativeRun(int exitCode, boolean timedOut, String output, long peakRssBytes,
            long elapsedMillis, long cpuMillis, long pid, List<Long> childPids, boolean outputExceeded) { }

    private record NativeToolPins(String ffmpegSha256, String ffprobeSha256) { }
}
