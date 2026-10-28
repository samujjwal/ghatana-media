package com.ghatana.audio.video.vision.video;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.EnumSet;
import java.util.Comparator;

import static org.assertj.core.api.Assertions.assertThat;

/** Runs a pinned, test-only worker through the real host OCI supervisor when configured. */
@EnabledIfEnvironmentVariable(named = HostOciVisionWorkerSupervisor.IMAGE_ENV,
        matches = "(?:[^\\s,@]+@)?sha256:[a-f0-9]{64}")
class HostOciVisionWorkerDockerIntegrationTest {
    @Test
    void enforcesContainerLimitsAndPrivateMountsBeforeRunningTheWorker() throws Exception {
        try (Fixture fixture = fixture("run")) {
            VideoFrameExtractor.ProcessResult result = VideoFrameExtractor.runProcess(
                    List.of("ffmpeg", "-nostdin", "-i", fixture.source().toString(),
                            fixture.output().resolve("frame.jpg").toString()),
                    Duration.ofSeconds(20), 4096, fixture.output(), 1024);

            assertThat(result.exitCode()).as(result.output()).isZero();
            assertThat(result.timedOut()).isFalse();
            assertThat(result.output()).contains("HOST_OCI_BOUNDARY_OK");
            assertThat(Files.readString(fixture.output().resolve("frame.jpg")))
                    .isEqualTo("host-oci-limits-and-mounts-verified\n");
        }
    }

    @Test
    void timeoutKillsTheContainerizedWorkerAndReturnsATruthfulTimeout() throws Exception {
        try (Fixture fixture = fixture("sleep")) {
            VideoFrameExtractor.ProcessResult result = VideoFrameExtractor.runProcess(
                    List.of("ffmpeg", "-nostdin", "-i", fixture.source().toString(),
                            fixture.output().resolve("frame.jpg").toString()),
                    Duration.ofSeconds(5), 4096, fixture.output(), 1024);

            assertThat(result.exitCode()).as(result.output()).isEqualTo(-1);
            assertThat(result.timedOut()).isTrue();
            assertThat(Files.exists(fixture.output().resolve("frame.jpg"))).isFalse();
        }
    }

    private static Fixture fixture(String sourceContents) throws IOException {
        Path temp = Path.of(System.getProperty("java.io.tmpdir")).toAbsolutePath().normalize();
        Path root = Files.createTempDirectory(temp, "media-vision-oci-test-");
        ownerOnly(root);
        Path workspace = Files.createDirectory(root.resolve(".media-video-codec-test-" + UUID.randomUUID()));
        ownerOnly(workspace);
        Path source = workspace.resolve("input.mp4");
        Files.writeString(source, sourceContents);
        Files.setPosixFilePermissions(source, EnumSet.of(PosixFilePermission.OWNER_READ));
        Path output = Files.createDirectory(root.resolve("output"));
        ownerOnly(output);
        return new Fixture(root, source, output);
    }

    private static void ownerOnly(Path path) throws IOException {
        Files.setPosixFilePermissions(path, EnumSet.of(
                PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE,
                PosixFilePermission.OWNER_EXECUTE));
    }

    private record Fixture(Path root, Path source, Path output) implements AutoCloseable {
        @Override public void close() throws IOException {
            try (var paths = Files.walk(root)) {
                for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
            }
        }
    }
}
