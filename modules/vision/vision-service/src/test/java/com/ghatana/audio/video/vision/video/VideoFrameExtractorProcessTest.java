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
    void enforcesTimeoutEvenWhenChildKeepsItsOutputPipeOpen() throws Exception {
        long startedAt = System.nanoTime();
        var result = VideoFrameExtractor.runProcess(childCommand("sleep"), Duration.ofMillis(100), 128);
        long elapsedMillis = (System.nanoTime() - startedAt) / 1_000_000;

        assertThat(result.timedOut()).isTrue();
        assertThat(elapsedMillis).isLessThan(3_000);
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
        assertThat(command).noneMatch(value -> value.contains("http:") || value.contains("concat:"));
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
    void outputByteBudgetStopsChildAndReportsOverflow() throws Exception {
        Path output = Files.createDirectory(tempDir.resolve("bounded-output"));
        var result = VideoFrameExtractor.runProcess(childCommand("write", output.toString()),
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
                System.out.write(bytes);
                System.out.flush();
            }
        } else if ("sleep".equals(args[0])) {
            System.out.write("waiting".getBytes(StandardCharsets.UTF_8));
            System.out.flush();
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
        } else {
            throw new IllegalArgumentException("unknown child mode");
        }
    }
}
