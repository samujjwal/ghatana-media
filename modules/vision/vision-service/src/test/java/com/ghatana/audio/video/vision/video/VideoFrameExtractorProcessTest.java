package com.ghatana.audio.video.vision.video;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Files;
import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class VideoFrameExtractorProcessTest {
    @TempDir Path tempDir;

    @Test
    void rejectsUnboundedFrameExtractionSettings() {
        assertThatThrownBy(() -> VideoFrameExtractor.ExtractionConfig.builder().fps(0))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> VideoFrameExtractor.ExtractionConfig.builder().maxFrames(10_001))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> VideoFrameExtractor.ExtractionConfig.builder().resolution(8193, 1080))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> VideoFrameExtractor.ExtractionConfig.builder().resolution(4096, 4096))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> VideoFrameExtractor.ExtractionConfig.builder().resolution(1920, -1))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void diagnosticSpamIsByteBoundedAndTerminatesChild() throws Exception {
        var result = VideoFrameExtractor.runProcess(childCommand("noise"), Duration.ofSeconds(5), 128);

        assertThat(result.diagnosticExceeded()).isTrue();
        assertThat(result.timedOut()).isFalse();
        assertThat(result.output()).hasSize(128);
        assertThat(result.output().chars().allMatch(character -> character == 'x')).isTrue();
    }

    @Test
    void ffprobeRejectsValidLookingMetadataWhenDiagnosticBudgetWasExceeded() {
        String plausibleMetadata = "width=640\nheight=480\nduration=1.0\nnb_frames=1\nr_frame_rate=1/1\ntime_base=1/1000\n";
        var result = new VideoFrameExtractor.ProcessResult(0, false, plausibleMetadata, false, true);

        assertThatThrownBy(() -> VideoFrameExtractor.parseProbeResult(result))
                .isInstanceOf(java.io.IOException.class)
                .hasMessageContaining("diagnostic output exceeded");
    }

    @Test
    void enforcesTimeoutEvenWhenChildKeepsItsOutputPipeOpen() throws Exception {
        long startedAt = System.nanoTime();
        var result = VideoFrameExtractor.runProcess(childCommand("sleep"), Duration.ofMillis(100), 128);
        long elapsedMillis = (System.nanoTime() - startedAt) / 1_000_000;

        assertThat(result.timedOut()).isTrue();
        assertThat(elapsedMillis).isLessThan(3_000);
    }

    @Test
    void rejectsConcurrentCodecProcessesOnceBoundedSlotsAreOccupied() throws Exception {
        Path firstMarker = tempDir.resolve("first.pid");
        Path secondMarker = tempDir.resolve("second.pid");
        java.util.concurrent.atomic.AtomicReference<Throwable> firstFailure = new java.util.concurrent.atomic.AtomicReference<>();
        java.util.concurrent.atomic.AtomicReference<Throwable> secondFailure = new java.util.concurrent.atomic.AtomicReference<>();
        Thread first = new Thread(() -> runMarkedChild(firstMarker, firstFailure), "first-media-child-test");
        Thread second = new Thread(() -> runMarkedChild(secondMarker, secondFailure), "second-media-child-test");
        first.start();
        second.start();
        try {
            awaitFile(firstMarker);
            awaitFile(secondMarker);

            assertThatThrownBy(() -> VideoFrameExtractor.runProcess(
                    childCommand("sleep"), Duration.ofSeconds(1), 128))
                    .isInstanceOf(java.io.IOException.class).hasMessageContaining("capacity is exhausted");
        } finally {
            first.interrupt();
            second.interrupt();
            first.join(3_000);
            second.join(3_000);
        }
        assertThat(first.isAlive()).isFalse();
        assertThat(second.isAlive()).isFalse();
        assertThat(firstFailure.get()).isInstanceOf(java.io.IOException.class).hasMessageContaining("interrupted");
        assertThat(secondFailure.get()).isInstanceOf(java.io.IOException.class).hasMessageContaining("interrupted");
    }

    private static void runMarkedChild(Path marker, java.util.concurrent.atomic.AtomicReference<Throwable> failure) {
        try {
            VideoFrameExtractor.runProcess(childCommand("sleep-mark", marker.toString()), Duration.ofSeconds(30), 128);
        } catch (Throwable thrown) {
            failure.set(thrown);
        }
    }

    private static void awaitFile(Path path) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos();
        while (!Files.exists(path) && System.nanoTime() < deadline) Thread.sleep(10);
        assertThat(path).exists();
    }

    @Test
    void rejectsSymlinkedVideoInputBeforeStartingFfmpeg() throws Exception {
        Path target = tempDir.resolve("source.mp4");
        Files.write(target, new byte[] {1});
        Path link = tempDir.resolve("linked.mp4");
        try {
            Files.createSymbolicLink(link, target);
        } catch (UnsupportedOperationException | java.nio.file.FileSystemException unavailable) {
            return;
        }
        assertThatThrownBy(() -> new VideoFrameExtractor().extractFrames(
                link, tempDir.resolve("out"), VideoFrameExtractor.ExtractionConfig.builder().build()))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("unsafe");
    }

    @Test
    void rejectsProtocolAndOptionLikeInputNamesBeforeStartingFfmpeg() throws Exception {
        for (String filename : List.of("http:evil.mp4", "-evil.mp4")) {
            Path file = tempDir.resolve(filename);
            Files.write(file, new byte[] {1});
            assertThatThrownBy(() -> new VideoFrameExtractor().extractFrames(
                    file, tempDir.resolve("out-" + filename.hashCode()), VideoFrameExtractor.ExtractionConfig.builder().build()))
                    .isInstanceOf(java.io.IOException.class).hasMessageContaining("allow-listed");
        }
    }

    @Test
    void rejectsSymlinkOutputDirectory() throws Exception {
        Path actual = Files.createDirectory(tempDir.resolve("actual"));
        Path link = tempDir.resolve("output-link");
        try {
            Files.createSymbolicLink(link, actual);
        } catch (UnsupportedOperationException | java.nio.file.FileSystemException unavailable) {
            return;
        }
        Path input = tempDir.resolve("ok.mp4");
        Files.write(input, new byte[] {1});
        assertThatThrownBy(() -> new VideoFrameExtractor().extractFrames(
                input, link, VideoFrameExtractor.ExtractionConfig.builder().build()))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("symlink");
    }

    @Test
    void extractSingleFrameRejectsSymlinkedParent() throws Exception {
        Path actual = Files.createDirectory(tempDir.resolve("single-frame-target"));
        Path link = tempDir.resolve("single-frame-link");
        try {
            Files.createSymbolicLink(link, actual);
        } catch (UnsupportedOperationException | java.nio.file.FileSystemException unavailable) {
            return;
        }
        Path input = tempDir.resolve("single-input.mp4");
        Files.write(input, new byte[] {1});
        assertThatThrownBy(() -> new VideoFrameExtractor().extractFrameAtTimestamp(
                input, 0, link.resolve("frame.jpg")))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("unsafe");
    }

    @Test
    void failedSingleFrameExtractionCleansPartialOutput() throws Exception {
        Path input = tempDir.resolve("bad.mp4");
        Files.write(input, new byte[] {1, 2, 3});
        Path output = tempDir.resolve("failed-frame.jpg");
        assertThatThrownBy(() -> new VideoFrameExtractor().extractFrameAtTimestamp(input, 0, output))
                .isInstanceOf(java.io.IOException.class);
        assertThat(Files.exists(output)).isFalse();
    }

    @Test
    void singleFrameOutputByteCapRejectsOversizedResult() throws Exception {
        Path output = tempDir.resolve("oversized.jpg");
        Files.write(output, new byte[32 * 1024 * 1024 + 1]);
        assertThatThrownBy(() -> VideoFrameExtractor.validateSingleFrameOutput(output, tempDir))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("byte budget");
    }

    @Test
    void ffmpegCommandUsesProtocolAllowlistAndBoundedDecodeOptions() throws Exception {
        var config = VideoFrameExtractor.ExtractionConfig.builder().maxFrames(3).resolution(640, 480).build();
        List<String> command = new VideoFrameExtractor().buildFFmpegCommand(
                tempDir.resolve("safe.mp4"), tempDir.resolve("frames"), config);
        assertThat(command).containsSubsequence("-protocol_whitelist", "file", "-max_alloc", "268435456",
                "-max_pixels", "16000000", "-f", "mov", "-i", tempDir.resolve("safe.mp4").toString());
        assertThat(command).containsSubsequence("-copyts", "-i", tempDir.resolve("safe.mp4").toString(),
                "-vf", "select='isnan(prev_selected_t)+gte(t-prev_selected_t,1/1)',showinfo,scale=640:480",
                "-fps_mode", "passthrough", "-enc_time_base", "demux");
        assertThat(command).noneMatch(value -> value.startsWith("fps="));
        assertThat(command).noneMatch(value -> value.contains("http:") || value.contains("concat:"));
    }

    @Test
    void mapsVariableRateAndReorderedFramesFromExactPtsInEmissionOrder() {
        String diagnostics = "[Parsed_showinfo_0] config in time_base: 1/90000, frame_rate: 30/1\n"
                + "[Parsed_showinfo_0] n: 0 pts: 90000 pts_time:1.0\n"
                + "[Parsed_showinfo_0] n: 1 pts: 121500 pts_time:1.35\n"
                + "[Parsed_showinfo_0] n: 2 pts: 81000 pts_time:0.9\n";
        var first = VideoFrameExtractor.timestampForOutputFrame(diagnostics, 0, "1/90000");
        var second = VideoFrameExtractor.timestampForOutputFrame(diagnostics, 1, "1/90000");
        var reordered = VideoFrameExtractor.timestampForOutputFrame(diagnostics, 2, "1/90000");
        assertThat(first.timestampMs()).isEqualTo(1000L);
        assertThat(second.timestampMs()).isEqualTo(1350L);
        assertThat(reordered.timestampMs()).isEqualTo(900L);
        assertThat(reordered.pts()).isEqualTo(81000L);
    }

    @Test
    void collectedFramesPreserveEmissionSequenceGapsAndExactSourcePts() throws Exception {
        Path output = Files.createDirectory(tempDir.resolve("sequence-gap"));
        Files.write(output.resolve("frame_0001.jpg"), new byte[] {1});
        Files.write(output.resolve("frame_0003.jpg"), new byte[] {3});
        String diagnostics = "[Parsed_showinfo_0] config in time_base: 1/90000, frame_rate: 30/1\n"
                + "[Parsed_showinfo_0] n: 0 pts: 90000 pts_time:1.0\n"
                + "[Parsed_showinfo_0] n: 1 pts: 121500 pts_time:1.35\n"
                + "[Parsed_showinfo_0] n: 2 pts: 81000 pts_time:0.9\n";

        List<VideoFrameExtractor.ExtractedFrame> frames = new VideoFrameExtractor().collectExtractedFrames(
                output, VideoFrameExtractor.ExtractionConfig.builder().maxFrames(3).build(),
                "1/90000", diagnostics);

        assertThat(frames).extracting(VideoFrameExtractor.ExtractedFrame::getFrameNumber)
                .containsExactly(0, 2);
        assertThat(frames).extracting(frame -> frame.getSourceTimestamp().pts())
                .containsExactly(90000L, 81000L);
        assertThat(frames).extracting(VideoFrameExtractor.ExtractedFrame::getTimestampMs)
                .containsExactly(1000L, 900L);
    }

    @Test
    void collectedFramesRejectAnInvalidZeroBasedSequence() throws Exception {
        Path output = Files.createDirectory(tempDir.resolve("zero-sequence"));
        Files.write(output.resolve("frame_0000.jpg"), new byte[] {1});

        assertThatThrownBy(() -> new VideoFrameExtractor().collectExtractedFrames(
                output, VideoFrameExtractor.ExtractionConfig.builder().build(), "1/1000", ""))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("sequence number");
    }

    @Test
    void preservesDiscontinuousPtsAndReturnsTypedUnknownForMissingOrInvalidTimebase() {
        String diagnostics = "[Parsed_showinfo_0] n: 0 pts: 45000 pts_time:0.5\n"
                + "[Parsed_showinfo_0] n: 1 pts: 0 pts_time:0\n"
                + "[Parsed_showinfo_0] n: 2 pts: NOPTS pts_time:NOPTS\n";
        var beforeDiscontinuity = VideoFrameExtractor.timestampForOutputFrame(diagnostics, 0, "1/90000");
        var afterDiscontinuity = VideoFrameExtractor.timestampForOutputFrame(diagnostics, 1, "1/90000");
        var noPts = VideoFrameExtractor.timestampForOutputFrame(diagnostics, 2, "1/90000");
        var invalidTimeBase = VideoFrameExtractor.timestampForOutputFrame(diagnostics, 0, "0/0");
        var missing = VideoFrameExtractor.timestampForOutputFrame(diagnostics, 4, "1/90000");
        assertThat(beforeDiscontinuity.timestampMs()).isEqualTo(500L);
        assertThat(afterDiscontinuity.timestampMs()).isZero();
        assertThat(noPts.status()).isEqualTo(SourceMediaTimestamp.Status.UNKNOWN);
        assertThat(noPts.timestampMs()).isNull();
        assertThat(invalidTimeBase.status()).isEqualTo(SourceMediaTimestamp.Status.UNKNOWN);
        assertThat(missing.status()).isEqualTo(SourceMediaTimestamp.Status.UNKNOWN);

        var mismatch = VideoFrameExtractor.timestampForOutputFrame(
                "[Parsed_showinfo_0] config in time_base: 1/1000, frame_rate: 30/1\n"
                        + "[Parsed_showinfo_0] n: 0 pts: 500 pts_time:0.5\n", 0, "1/90000");
        assertThat(mismatch.status()).isEqualTo(SourceMediaTimestamp.Status.UNKNOWN);
        assertThat(mismatch.reason()).isEqualTo("FFPROBE_FFMPEG_TIMEBASE_MISMATCH");
    }

    @Test
    void rationalTimebaseConversionRoundsToNearestMillisecondWithoutFpsSynthesis() {
        var timestamp = SourceMediaTimestamp.fromPts("1001", "1/30000");
        assertThat(timestamp.status()).isEqualTo(SourceMediaTimestamp.Status.KNOWN);
        assertThat(timestamp.timestampMs()).isEqualTo(33L);
        assertThatThrownBy(() -> SourceMediaTimestamp.parseTimeBase("1/0"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void ffprobeStreamTimebaseIsReadAsExactRationalMetadata() {
        var metadata = VideoFrameExtractor.parseVideoMetadata(
                "width=1280\nheight=720\nduration=4.0\nnb_frames=120\nr_frame_rate=30/1\ntime_base=1/90000\n");
        assertThat(metadata.getTimeBase()).isEqualTo("1/90000");
        assertThat(SourceMediaTimestamp.parseTimeBase(metadata.getTimeBase()))
                .isEqualTo(new SourceMediaTimestamp.RationalTimeBase(1, 90000));
        assertThat(VideoFrameExtractor.frameSequenceNumber("frame_10000.jpg"))
                .isGreaterThan(VideoFrameExtractor.frameSequenceNumber("frame_9999.jpg"));
    }

    @Test
    void timeoutKillsChildProcessTree() throws Exception {
        Path pidFile = tempDir.resolve("child.pid");
        var result = VideoFrameExtractor.runProcess(childCommand("tree", pidFile.toString()), Duration.ofSeconds(2), 128);
        assertThat(result.timedOut()).isTrue();
        long childPid = Long.parseLong(Files.readString(pidFile));
        Thread.sleep(100);
        assertThat(ProcessHandle.of(childPid).map(ProcessHandle::isAlive).orElse(false)).isFalse();
    }

    @Test
    void interruptionCancelsChildProcessTree() throws Exception {
        Path pidFile = tempDir.resolve("cancelled-child.pid");
        java.util.concurrent.atomic.AtomicReference<Throwable> failure = new java.util.concurrent.atomic.AtomicReference<>();
        Thread worker = new Thread(() -> {
            try {
                VideoFrameExtractor.runProcess(
                        childCommand("tree", pidFile.toString()), Duration.ofSeconds(30), 128);
            } catch (Throwable thrown) {
                failure.set(thrown);
            }
        }, "video-process-cancellation-test");
        worker.start();

        long deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos();
        while ((!Files.exists(pidFile) || Files.size(pidFile) == 0) && System.nanoTime() < deadline) {
            Thread.sleep(10);
        }
        assertThat(Files.exists(pidFile)).isTrue();
        assertThat(Files.size(pidFile)).isPositive();
        long childPid = Long.parseLong(Files.readString(pidFile));

        worker.interrupt();
        worker.join(3_000);

        assertThat(worker.isAlive()).isFalse();
        assertThat(failure.get()).isInstanceOf(java.io.IOException.class)
                .hasMessageContaining("interrupted");
        long childExitDeadline = System.nanoTime() + Duration.ofSeconds(2).toNanos();
        while (ProcessHandle.of(childPid).map(ProcessHandle::isAlive).orElse(false)
                && System.nanoTime() < childExitDeadline) Thread.sleep(20);
        assertThat(ProcessHandle.of(childPid).map(ProcessHandle::isAlive).orElse(false)).isFalse();
    }

    @Test
    void outputByteBudgetStopsChildAndReportsOverflow() throws Exception {
        Path output = Files.createDirectory(tempDir.resolve("bounded-output"));
        var result = VideoFrameExtractor.runProcess(childCommand("write", output.toString()),
                Duration.ofSeconds(5), 128, output, 1024);
        assertThat(result.outputExceeded()).isTrue();
        assertThat(result.timedOut()).isFalse();
    }

    @Test
    void detectsOutputBudgetOverflowWhenChildExitsBetweenPollingIntervals() throws Exception {
        Path output = Files.createDirectory(tempDir.resolve("fast-bounded-output"));
        var result = VideoFrameExtractor.runProcess(childCommand("write-once", output.toString()),
                Duration.ofSeconds(5), 128, output, 1024);

        assertThat(result.outputExceeded()).isTrue();
        assertThat(result.timedOut()).isFalse();
    }

    @Test
    void rejectsTraversalPathComponents() throws Exception {
        Path file = tempDir.resolve("source.mp4");
        Files.write(file, new byte[] {1});
        Path traversal = tempDir.resolve("sub").resolve("..").resolve("source.mp4");
        assertThatThrownBy(() -> new VideoFrameExtractor().extractFrames(
                traversal, tempDir.resolve("out"), VideoFrameExtractor.ExtractionConfig.builder().build()))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("traversal");
    }

    private static List<String> childCommand(String mode) {
        String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        return List.of(java, "-cp", System.getProperty("java.class.path"),
            VideoFrameExtractorProcessTest.class.getName(), mode);
    }

    private static List<String> childCommand(String mode, String argument) {
        String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        return List.of(java, "-cp", System.getProperty("java.class.path"),
                VideoFrameExtractorProcessTest.class.getName(), mode, argument);
    }

    public static void main(String[] args) throws Exception {
        if ("noise".equals(args[0])) {
            byte[] bytes = new byte[64 * 1024];
            java.util.Arrays.fill(bytes, (byte) 'x');
            while (true) {
                System.err.write(bytes);
                System.err.flush();
            }
        } else if ("sleep".equals(args[0])) {
            System.out.write("waiting".getBytes(StandardCharsets.UTF_8));
            System.out.flush();
            Thread.sleep(30_000);
        } else if ("sleep-mark".equals(args[0])) {
            Files.writeString(Path.of(args[1]), Long.toString(ProcessHandle.current().pid()));
            Thread.sleep(30_000);
        } else if ("tree".equals(args[0])) {
            String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
            Process child = new ProcessBuilder(java, "-cp", System.getProperty("java.class.path"),
                    VideoFrameExtractorProcessTest.class.getName(), "sleep").start();
            Files.writeString(Path.of(args[1]), Long.toString(child.pid()));
            Thread.sleep(30_000);
        } else if ("write".equals(args[0])) {
            Path output = Path.of(args[1]);
            Path file = output.resolve("frame_0000.jpg");
            try (var stream = Files.newOutputStream(file)) {
                byte[] block = new byte[4096];
                while (true) stream.write(block);
            }
        } else if ("write-once".equals(args[0])) {
            Files.write(Path.of(args[1]).resolve("frame_0000.jpg"), new byte[2048]);
        } else {
            throw new IllegalArgumentException("unknown child mode");
        }
    }
}
