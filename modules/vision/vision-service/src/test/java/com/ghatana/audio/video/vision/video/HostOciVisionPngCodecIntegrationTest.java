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
 * Optional *real PNG-capable FFmpeg* qualification boundary, distinct from the
 * BMP-only pinned worker. The pinned LGPL static FFmpeg build is verified by
 * PROVISION.json (archive/binary/license SHA-256) and decoded pixels are compared
 * exactly against an independently generated Java PNG encoder oracle. No remote
 * media, camera, copyrighted content or model weights are needed.
 */
@EnabledIfEnvironmentVariable(named = "GHATANA_MEDIA_VISION_PNG_CODEC_TEST", matches = "RUN")
@EnabledIfEnvironmentVariable(named = HostOciVisionWorkerSupervisor.IMAGE_ENV,
        matches = "(?:[^\\s,@]+@)?sha256:[a-f0-9]{64}")
class HostOciVisionPngCodecIntegrationTest {

    @Test
    void pinnedPngFfmpegDecodesJavaOraclePngToExactPixelsUnderHostOciLimits() throws Exception {
        try (Fixture fixture = new Fixture()) {
            BufferedImage source = oracleImage(32, 24);
            Path input = fixture.createImage(source, "png");
            Path output = fixture.output.resolve("decoded.bmp");
            var result = VideoFrameExtractor.runProcess(List.of(
                    "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1",
                    "-i", input.toString(), "-frames:v", "1", "-c:v", "bmp",
                    "-y", output.toString()),
                    Duration.ofSeconds(30), 8192, fixture.output, 8_000_000L);

            assertThat(result.timedOut()).isFalse();
            assertThat(result.outputExceeded()).isFalse();
            assertThat(result.diagnosticExceeded()).isFalse();
            assertThat(result.exitCode()).as(result.output()).isZero();
            assertThat(Files.isRegularFile(output)).isTrue();
            BufferedImage decoded = ImageIO.read(output.toFile());
            assertThat(decoded).isNotNull();
            assertPixelsExact(source, decoded);
        }
    }

    @Test
    void pinnedPngFfmpegEncodesExactPngReadableByIndependentJavaDecoder() throws Exception {
        try (Fixture fixture = new Fixture()) {
            BufferedImage source = oracleImage(48, 40);
            Path input = fixture.createImage(source, "bmp");
            Path output = fixture.output.resolve("encoded.png");
            var result = VideoFrameExtractor.runProcess(List.of(
                    "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-threads", "1", "-filter_threads", "1",
                    "-i", input.toString(), "-frames:v", "1", "-c:v", "png",
                    "-y", output.toString()),
                    Duration.ofSeconds(30), 8192, fixture.output, 8_000_000L);

            assertThat(result.timedOut()).isFalse();
            assertThat(result.outputExceeded()).isFalse();
            assertThat(result.diagnosticExceeded()).isFalse();
            assertThat(result.exitCode()).as(result.output()).isZero();
            BufferedImage decoded = ImageIO.read(output.toFile());
            assertThat(decoded).isNotNull();
            assertPixelsExact(source, decoded);
        }
    }

    @Test
    void pinnedPngFfmpegRejectsCorruptPngWithoutCreatingAnOutput() throws Exception {
        try (Fixture fixture = new Fixture()) {
            BufferedImage source = oracleImage(16, 16);
            Path valid = fixture.createImage(source, "png");
            byte[] bytes = Files.readAllBytes(valid);
            // Corrupt an IDAT chunk byte deep inside the payload, preserving the
            // PNG magic header so the failure is a decode failure, not a magic sniff.
            bytes[bytes.length / 2] = (byte) (bytes[bytes.length / 2] ^ (byte) 0x5a);
            Path corrupt = fixture.createBytes(bytes, "input-corrupt.png");
            Path output = fixture.output.resolve("decoded.bmp");
            var result = VideoFrameExtractor.runProcess(List.of(
                    "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1",
                    "-i", corrupt.toString(), "-frames:v", "1", "-c:v", "bmp",
                    "-y", output.toString()),
                    Duration.ofSeconds(30), 4096, fixture.output, 2_000_000L);
            assertThat(result.exitCode()).isNotZero();
            assertThat(result.timedOut()).isFalse();
            assertThat(Files.exists(output)).isFalse();
        }
    }

    @Test
    void pinnedPngFfmpegMarksExactOutputOverflowNotSuccessful() throws Exception {
        try (Fixture fixture = new Fixture()) {
            BufferedImage source = oracleImage(64, 64);
            Path input = fixture.createImage(source, "png");
            Path output = fixture.output.resolve("decoded.bmp");
            var result = VideoFrameExtractor.runProcess(List.of(
                    "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1",
                    "-i", input.toString(), "-frames:v", "1", "-c:v", "bmp",
                    "-y", output.toString()),
                    Duration.ofSeconds(30), 4096, fixture.output, 64L);
            assertThat(result.outputExceeded())
                    .as("Fast completion must not bypass output-byte ceiling").isTrue();
        }
    }

    private static BufferedImage oracleImage(int width, int height) {
        BufferedImage source = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                source.setRGB(x, y, ((x * 5 % 256) << 16) | ((y * 7 % 256) << 8) | ((x + 2 * y) % 256));
            }
        }
        return source;
    }

    private static void assertPixelsExact(BufferedImage expected, BufferedImage decoded) {
        assertThat(decoded.getWidth()).isEqualTo(expected.getWidth());
        assertThat(decoded.getHeight()).isEqualTo(expected.getHeight());
        for (int y = 0; y < expected.getHeight(); y++) {
            for (int x = 0; x < expected.getWidth(); x++) {
                assertThat(decoded.getRGB(x, y) & 0xffffff)
                        .as("pixel %d,%d", x, y)
                        .isEqualTo(expected.getRGB(x, y) & 0xffffff);
            }
        }
    }

    private static final class Fixture implements AutoCloseable {
        private final Path root;
        private final Path workspace;
        private final Path output;
        Fixture() throws IOException {
            Path tmp = Path.of(System.getProperty("java.io.tmpdir")).toRealPath();
            root = Files.createTempDirectory(tmp, "vision-oci-png-");
            ownerOnly(root);
            workspace = Files.createDirectory(root.resolve(".media-video-codec-original"));
            ownerOnly(workspace);
            output = Files.createDirectory(root.resolve("output"));
            ownerOnly(output);
        }
        Path createImage(BufferedImage value, String format) throws IOException {
            Path target = workspace.resolve("input." + format);
            if (!ImageIO.write(value, format, target.toFile())) {
                throw new IOException("Java " + format + " encoder unavailable");
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
