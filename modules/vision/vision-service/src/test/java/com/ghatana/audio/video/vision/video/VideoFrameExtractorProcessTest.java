package com.ghatana.audio.video.vision.video;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class VideoFrameExtractorProcessTest {
    @Test
    void rejectsUnboundedFrameExtractionSettings() {
        assertThatThrownBy(() -> VideoFrameExtractor.ExtractionConfig.builder().fps(0))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> VideoFrameExtractor.ExtractionConfig.builder().maxFrames(10_001))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> VideoFrameExtractor.ExtractionConfig.builder().resolution(8193, 1080))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> VideoFrameExtractor.ExtractionConfig.builder().resolution(1920, -1))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void drainsNoisyChildOutputButRetainsOnlyConfiguredDiagnosticLimit() throws Exception {
        var result = VideoFrameExtractor.runProcess(childCommand("noise"), Duration.ofSeconds(5), 128);

        assertThat(result.timedOut()).isFalse();
        assertThat(result.exitCode()).isZero();
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

    private static List<String> childCommand(String mode) {
        String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        return List.of(java, "-cp", System.getProperty("java.class.path"),
            VideoFrameExtractorProcessTest.class.getName(), mode);
    }

    public static void main(String[] args) throws Exception {
        if ("noise".equals(args[0])) {
            byte[] bytes = new byte[1_000_000];
            java.util.Arrays.fill(bytes, (byte) 'x');
            System.out.write(bytes);
            System.out.flush();
        } else if ("sleep".equals(args[0])) {
            System.out.write("waiting".getBytes(StandardCharsets.UTF_8));
            System.out.flush();
            Thread.sleep(30_000);
        } else {
            throw new IllegalArgumentException("unknown child mode");
        }
    }
}
