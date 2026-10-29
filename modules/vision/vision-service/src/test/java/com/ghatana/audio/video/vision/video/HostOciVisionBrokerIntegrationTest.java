package com.ghatana.audio.video.vision.video;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

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
 * Authenticated host/CRI broker boundary. The Media JVM holds neither a Docker
 * socket nor a usable Docker CLI: the run script deliberately points
 * GHATANA_MEDIA_VISION_DOCKER_CLI at a nonexistent executable, so any direct CLI
 * attempt would fail the test. A privileged broker subprocess owns the engine.
 */
@EnabledIfEnvironmentVariable(named = HostOciVisionWorkerSupervisor.BROKER_SOCKET_ENV, matches = ".+")
@EnabledIfEnvironmentVariable(named = HostOciVisionWorkerSupervisor.BROKER_TOKEN_ENV, matches = ".+")
@EnabledIfEnvironmentVariable(named = HostOciVisionWorkerSupervisor.IMAGE_ENV,
        matches = "(?:[^\\s,@]+@)?sha256:[a-f0-9]{64}")
class HostOciVisionBrokerIntegrationTest {

    private static Process brokerDaemon;
    private static Path sandboxRoot;

    @BeforeAll
    static void startBroker() throws Exception {
        Path socket = Path.of(System.getenv(HostOciVisionWorkerSupervisor.BROKER_SOCKET_ENV));
        Path token = Path.of(System.getenv(HostOciVisionWorkerSupervisor.BROKER_TOKEN_ENV));
        assertThat(Files.size(token)).as("broker token must be at least 32 bytes").isGreaterThanOrEqualTo(32L);
        sandboxRoot = Files.createTempDirectory(
                Path.of(System.getProperty("java.io.tmpdir")).toRealPath(), "vision-broker-sandbox-");
        String javaBin = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        ProcessBuilder builder = new ProcessBuilder(javaBin, "-cp", System.getProperty("java.class.path"),
                "com.ghatana.audio.video.vision.video.MediaOciBrokerDaemon");
        builder.environment().put("MEDIA_OCI_BROKER_SOCKET", socket.toString());
        builder.environment().put("MEDIA_OCI_BROKER_TOKEN_FILE", token.toString());
        builder.environment().put("MEDIA_OCI_BROKER_SOURCE_ROOT", sandboxRoot.toString());
        builder.environment().put("MEDIA_OCI_BROKER_OUTPUT_ROOT", sandboxRoot.toString());
        builder.environment().put("MEDIA_OCI_BROKER_DOCKER_CLI", "docker");
        builder.environment().put("MEDIA_OCI_BROKER_IMAGE_ALLOWLIST",
                System.getenv(HostOciVisionWorkerSupervisor.IMAGE_ENV));
        builder.environment().put("MEDIA_OCI_BROKER_WORKER_UID",
                String.valueOf(Files.getAttribute(sandboxRoot, "unix:uid")));
        builder.environment().put("MEDIA_OCI_BROKER_WORKER_GID",
                String.valueOf(Files.getAttribute(sandboxRoot, "unix:gid")));
        builder.redirectErrorStream(true);
        builder.redirectOutput(ProcessBuilder.Redirect.appendTo(Files.createTempFile("broker-", ".log").toFile()));
        brokerDaemon = builder.start();
        long deadline = System.nanoTime() + Duration.ofSeconds(20).toNanos();
        while (!Files.exists(socket) && System.nanoTime() < deadline) {
            assertThat(brokerDaemon.isAlive()).as("broker daemon must remain alive").isTrue();
            Thread.sleep(100);
        }
        assertThat(Files.exists(socket)).as("broker must bind its owner-only socket").isTrue();
    }

    @AfterAll
    static void stopBroker() throws IOException {
        if (brokerDaemon != null) {
            brokerDaemon.destroyForcibly();
            try { brokerDaemon.waitFor(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }
        if (sandboxRoot != null) {
            try (var files = Files.walk(sandboxRoot)) {
                for (Path p : files.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(p);
            }
        }
    }

    @Test
    void brokerRunsBoundedWorkerWithoutAnyLocalDockerAccess() throws Exception {
        try (Fixture fixture = new Fixture()) {
            Path input = fixture.stageSource("verify".getBytes());
            Path output = fixture.output.resolve("result.out");
            var result = VideoFrameExtractor.runProcess(List.of(
                    "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-i", input.toString(), "-y", output.toString()),
                    Duration.ofSeconds(60), 8192, fixture.output, 2_000_000L);
            assertThat(result.exitCode()).as(result.output()).isZero();
            assertThat(result.timedOut()).isFalse();
            assertThat(result.outputExceeded()).isFalse();
            assertThat(result.output()).contains("HOST_OCI_BOUNDARY_OK");
            assertThat(Files.readString(output)).isEqualTo("host-oci-limits-and-mounts-verified\n");
        }
    }

    @Test
    void brokerReportsWorkerTimeoutTruthfullyAndKillsIt() throws Exception {
        try (Fixture fixture = new Fixture()) {
            Path input = fixture.stageSource("sleep".getBytes());
            Path output = fixture.output.resolve("result.out");
            var result = VideoFrameExtractor.runProcess(List.of(
                    "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-i", input.toString(), "-y", output.toString()),
                    Duration.ofSeconds(4), 8192, fixture.output, 2_000_000L);
            assertThat(result.timedOut()).isTrue();
            assertThat(result.exitCode()).isEqualTo(-1);
            assertThat(Files.exists(output)).isFalse();
        }
    }

    @Test
    void brokerEnforcesKernelPidLimitInsideWorker() throws Exception {
        try (Fixture fixture = new Fixture()) {
            Path input = fixture.stageSource("pid-limit".getBytes());
            Path output = fixture.output.resolve("result.out");
            var result = VideoFrameExtractor.runProcess(List.of(
                    "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-i", input.toString(), "-y", output.toString()),
                    Duration.ofSeconds(60), 8192, fixture.output, 2_000_000L);
            assertThat(result.timedOut()).isFalse();
            assertThat(result.exitCode()).as(result.output()).isEqualTo(85);
            assertThat(result.output()).contains("HOST_OCI_PID_LIMIT_HIT");
        }
    }

    private static final class Fixture implements AutoCloseable {
        private final Path root;
        private final Path workspace;
        private final Path output;
        Fixture() throws IOException {
            root = Files.createTempDirectory(sandboxRoot, "worker-");
            ownerOnly(root);
            workspace = Files.createDirectory(root.resolve(".media-video-codec-original"));
            ownerOnly(workspace);
            output = Files.createDirectory(root.resolve("output"));
            ownerOnly(output);
        }
        Path stageSource(byte[] value) throws IOException {
            Path target = workspace.resolve("input.bin");
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
