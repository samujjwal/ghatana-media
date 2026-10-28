package com.ghatana.audio.video.vision.video;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Duration;
import java.util.Comparator;
import java.util.EnumSet;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Optional *real FFmpeg* qualification boundary, distinct from the shell-based
 * OCI resource fixture. Use the pinned Linux ARM64 FFmpeg/FFprobe image produced
 * from the exact source-pinned archive in a dedicated JVM selection. That
 * archive disables PNG decode/encode, so the positive pixel-exact fixture uses
 * Java's lossless BMP encoder and compares the decoded BMP pixels exactly.
 * No remote media, camera, copyrighted content or model weights are needed.
 */
@EnabledIfEnvironmentVariable(named = "GHATANA_MEDIA_VISION_REAL_CODEC_TEST", matches = "RUN")
@EnabledIfEnvironmentVariable(named = HostOciVisionWorkerSupervisor.IMAGE_ENV,
        matches = "(?:[^\\s,@]+@)?sha256:[a-f0-9]{64}")
class HostOciVisionRealCodecIntegrationTest {
    @Test
    void pinnedRealFfmpegDecodesOriginalGeneratedBmpUnderHostOciLimits() throws Exception {
        try (Fixture fixture = new Fixture()) {
            BufferedImage source = new BufferedImage(32, 24, BufferedImage.TYPE_INT_RGB);
            for (int y = 0; y < source.getHeight(); y++) {
                for (int x = 0; x < source.getWidth(); x++) {
                    source.setRGB(x, y, ((x * 3) << 16) | ((y * 5) << 8) | 17);
                }
            }
            Path input = fixture.createBmp(source);
            Path output = fixture.output.resolve("frame.bmp");
            var result = VideoFrameExtractor.runProcess(List.of(
                    "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1",
                    "-i", input.toString(), "-frames:v", "1", "-c:v", "bmp",
                    "-y", output.toString()),
                    Duration.ofSeconds(30), 8192, fixture.output, 2_000_000L);

            assertThat(result.timedOut()).isFalse();
            assertThat(result.outputExceeded()).isFalse();
            assertThat(result.diagnosticExceeded()).isFalse();
            assertThat(result.exitCode()).as(result.output()).isZero();
            assertThat(Files.isRegularFile(output)).isTrue();
            BufferedImage decoded = ImageIO.read(output.toFile());
            assertThat(decoded).isNotNull();
            assertThat(decoded.getWidth()).isEqualTo(source.getWidth());
            assertThat(decoded.getHeight()).isEqualTo(source.getHeight());
            for (int y = 0; y < source.getHeight(); y++) {
                for (int x = 0; x < source.getWidth(); x++) {
                    assertThat(decoded.getRGB(x, y) & 0xffffff)
                            .isEqualTo(source.getRGB(x, y) & 0xffffff);
                }
            }
        }
    }

    @Test
    void pinnedRealFfmpegRejectsMalformedSourceWithoutCreatingAnOutput() throws Exception {
        try (Fixture fixture = new Fixture()) {
            Path input = fixture.createBytes("this-is-not-a-media-file".getBytes(java.nio.charset.StandardCharsets.UTF_8),
                    "input.mp4");
            Path output = fixture.output.resolve("frame.bmp");
            var result = VideoFrameExtractor.runProcess(List.of(
                    "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1",
                    "-i", input.toString(), "-frames:v", "1", "-c:v", "bmp",
                    "-y", output.toString()),
                    Duration.ofSeconds(30), 4096, fixture.output, 2_000_000L);
            assertThat(result.exitCode()).isNotZero();
            assertThat(result.timedOut()).isFalse();
            assertThat(Files.exists(output)).isFalse();
        }
    }

    @Test
    void pinnedRealFfmpegMarksExactOutputOverflowNotSuccessful() throws Exception {
        try (Fixture fixture = new Fixture()) {
            BufferedImage source = new BufferedImage(80, 80, BufferedImage.TYPE_INT_RGB);
            for (int y = 0; y < source.getHeight(); y++)
                for (int x = 0; x < source.getWidth(); x++)
                    source.setRGB(x, y, ((x * 7 % 256) << 16) | ((y * 11 % 256) << 8) | ((x * y) % 256));
            Path input = fixture.createBmp(source);
            Path output = fixture.output.resolve("frame.bmp");
            var result = VideoFrameExtractor.runProcess(List.of(
                    "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1",
                    "-i", input.toString(), "-frames:v", "1", "-c:v", "bmp",
                    "-y", output.toString()),
                    Duration.ofSeconds(30), 4096, fixture.output, 64L);
            assertThat(result.outputExceeded()).as("Fast completion must not bypass output-byte ceiling").isTrue();
        }
    }

    private static final class Fixture implements AutoCloseable {
        private final Path root;
        private final Path workspace;
        private final Path output;
        Fixture() throws IOException {
            Path tmp = Path.of(System.getProperty("java.io.tmpdir")).toRealPath();
            root = Files.createTempDirectory(tmp, "vision-oci-real-");
            ownerOnly(root);
            workspace = Files.createDirectory(root.resolve(".media-video-codec-original"));
            ownerOnly(workspace);
            output = Files.createDirectory(root.resolve("output"));
            ownerOnly(output);
        }
        Path createBmp(BufferedImage value) throws IOException {
            Path target = workspace.resolve("input.bmp");
            if (!ImageIO.write(value, "bmp", target.toFile())) {
                throw new IOException("Java BMP encoder unavailable");
            }
            Files.setPosixFilePermissions(target, EnumSet.of(PosixFilePermission.OWNER_READ));
            return target;
        }
        Path createBytes(byte[] value, String name) throws IOException {
            Path target = workspace.resolve(name);
            Files.write(target, value);
            Files.setPosixFilePermissions(target, EnumSet.of(PosixFilePermission.OWNER_READ));
            return target;
        }
        private static void ownerOnly(Path path) throws IOException {
            Files.setPosixFilePermissions(path, EnumSet.of(
                    PosixFilePermission.OWNER_READ,
                    PosixFilePermission.OWNER_WRITE,
                    PosixFilePermission.OWNER_EXECUTE));
        }
        @Override public void close() throws IOException {
            try (var files = Files.walk(root)) {
                for (Path p : files.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(p);
            }
        }
    }
}
