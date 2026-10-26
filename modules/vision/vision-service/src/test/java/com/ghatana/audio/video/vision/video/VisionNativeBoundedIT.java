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
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Development-only native codec regression using generated, synthetic media fixtures.
 *
 * <p>The test refuses tools other than the exact R4 pinned executables. It does not exercise
 * model inference: no admitted Vision model is needed or implied by these codec checks.
 */
class VisionNativeBoundedIT {
    private static final Path FFMPEG = Path.of("/tmp/ghatana-media-r5-ffmpeg-8.1.2/extracted/ffmpeg");
    private static final Path FFPROBE = Path.of("/tmp/ghatana-media-r5-ffmpeg-8.1.2/extracted/ffprobe");
    private static final String FFMPEG_SHA256 = "5bea4e7be361c9557334f5ae50640c82944304eb5f97d8c248622cf8d1e9bb33";
    private static final String FFPROBE_SHA256 = "b1065dd4a8d4a39b0617818117dadf0502c6bded4314bea3d74bd98b57fa5f7f";
    private static final long MAX_FIXTURE_BYTES = 2L * 1024 * 1024;
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
                "-c:v", "h264_videotoolbox", "-pix_fmt", "yuv420p",
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
                "-vf", "setpts='N/(10*TB)+gte(N,5)*0.2/TB'", "-fps_mode", "vfr",
                "-c:v", "h264_videotoolbox", "-pix_fmt", "yuv420p", vfr.toString()),
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

        // This pinned LGPL build has no WebP encoder. Keep a tiny deterministic WebP fixture
        // generated locally with Pillow so the Java decoder path remains exercised without adding
        // a runtime dependency or fetching media.
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
        assertThat(Files.isExecutable(FFMPEG)).as("R4 pinned FFmpeg executable exists").isTrue();
        assertThat(Files.isExecutable(FFPROBE)).as("R4 pinned FFprobe executable exists").isTrue();
        assertThat(sha256(FFMPEG)).isEqualTo(FFMPEG_SHA256);
        assertThat(sha256(FFPROBE)).isEqualTo(FFPROBE_SHA256);
        System.out.printf("VISION_NATIVE_ENV host=%s os=%s arch=%s ffmpegSha256=%s ffprobeSha256=%s%n",
                java.lang.management.ManagementFactory.getRuntimeMXBean().getName(),
                System.getProperty("os.name"), System.getProperty("os.arch"),
                sha256(FFMPEG), sha256(FFPROBE));
        assertThat(runNative(List.of(FFMPEG.toString(), "-version"), Duration.ofSeconds(3), 4096)
                .output()).contains("ffmpeg version 8.1.2");
        assertThat(runNative(List.of(FFPROBE.toString(), "-version"), Duration.ofSeconds(3), 4096)
                .output()).contains("ffprobe version 8.1.2");
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
        java.util.ArrayList<String> timedCommand = new java.util.ArrayList<>(List.of("/usr/bin/time", "-lp"));
        timedCommand.addAll(boundedCommand(command));
        Process process = new ProcessBuilder(timedCommand).redirectErrorStream(true).start();
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
        long peakRssBytes = 0;
        boolean timedOut = false;
        List<Long> childPids = new java.util.ArrayList<>();
        while (process.isAlive() && System.nanoTime() < deadline) {
            peakRssBytes = Math.max(peakRssBytes, rssBytes(process.pid()));
            for (ProcessHandle child : process.toHandle().descendants().toList()) {
                peakRssBytes = Math.max(peakRssBytes, rssBytes(child.pid()));
            }
            process.waitFor(25, TimeUnit.MILLISECONDS);
        }
        if (process.isAlive()) {
            timedOut = true;
            childPids = process.toHandle().descendants().map(ProcessHandle::pid).toList();
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
        long elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos);
        long cpuMillis = -1;
        if (!timedOut) {
            Matcher user = Pattern.compile("(?m)^user\\s+([0-9.]+)$").matcher(captured);
            Matcher sys = Pattern.compile("(?m)^sys\\s+([0-9.]+)$").matcher(captured);
            if (!user.find() || !sys.find()) throw new AssertionError("/usr/bin/time did not report child CPU time");
            cpuMillis = (long) ((Double.parseDouble(user.group(1)) + Double.parseDouble(sys.group(1))) * 1000.0);
        }
        return new NativeRun(timedOut ? -1 : process.exitValue(), timedOut, captured,
                peakRssBytes, elapsedMillis, cpuMillis, process.pid(), childPids, outputExceeded.get());
    }

    private static long rssBytes(long pid) {
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

    private static void assertBounded(NativeRun run, int maxSeconds) {
        assertBounded(run, maxSeconds, true);
    }

    private static void assertBounded(NativeRun run, int maxSeconds, boolean requireObservedRss) {
        assertThat(run.timedOut()).isFalse();
        assertThat(run.elapsedMillis()).isLessThanOrEqualTo(maxSeconds * 1000L);
        assertThat(run.cpuMillis()).isLessThanOrEqualTo(maxSeconds * 1000L);
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
        java.util.ArrayList<String> bounded = new java.util.ArrayList<>(List.of("/bin/zsh", "-c",
                "ulimit -t 15 || exit 91; ulimit -f 4096 || exit 92; exec \"$@\"", "vision-native"));
        bounded.addAll(command);
        return List.copyOf(bounded);
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
}
