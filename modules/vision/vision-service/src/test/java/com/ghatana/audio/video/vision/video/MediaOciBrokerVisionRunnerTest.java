package com.ghatana.audio.video.vision.video;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Deterministic per-invocation OCI lifecycle checks; no Docker daemon required. */
class MediaOciBrokerVisionRunnerTest {
    private static final String ID = "a".repeat(64);

    @org.junit.jupiter.api.io.TempDir Path temp;

    @Test
    void snapshotMountIsExactAndCallerMutationAfterCopyCannotChangeWorkerInput() throws Exception {
        Path sourceRoot = Files.createDirectory(temp.resolve("source"));
        Path outputRoot = Files.createDirectory(temp.resolve("output"));
        Path stage = Files.createDirectory(temp.resolve("stage"));
        Files.setPosixFilePermissions(stage, PosixFilePermissions.fromString("rwx------"));
        Path source = sourceRoot.resolve("input.media");
        byte[] original = "pinned-source".getBytes();
        Files.write(source, original);
        String sha = sha(original);
        List<List<String>> commands = new ArrayList<>();
        MediaOciBrokerDaemon.WorkerCommandRunner runner = (command, timeout) -> {
            commands.add(List.copyOf(command));
            if (command.get(1).equals("create")) {
                Files.write(source, "caller-mutated".getBytes());
                String mount = command.get(command.indexOf("--mount") + 1);
                String snapshotPath = mount.substring("type=bind,source=".length(), mount.indexOf(",target="));
                assertThat(Files.readString(Path.of(snapshotPath))).isEqualTo("pinned-source");
                assertThat(sha(Files.readAllBytes(Path.of(snapshotPath)))).isEqualTo(sha);
                assertThat(Files.getPosixFilePermissions(Path.of(snapshotPath)))
                        .isEqualTo(PosixFilePermissions.fromString("r--r--r--"));
                return new MediaOciBrokerDaemon.CommandResult(0, ID, false);
            }
            return switch (command.get(1)) {
                case "start" -> new MediaOciBrokerDaemon.CommandResult(0, "", false);
                case "inspect" -> new MediaOciBrokerDaemon.CommandResult(0, "false", false);
                case "rm" -> new MediaOciBrokerDaemon.CommandResult(0, "", false);
                default -> throw new AssertionError("unexpected OCI operation " + command);
            };
        };
        String result = MediaOciBrokerDaemon.runWorkerWithSnapshot("docker", "worker@sha256:" + "b".repeat(64),
                "vision-snapshot", "ffmpeg", List.of("-nostdin", "-hide_banner", "-loglevel", "error",
                        "-i", "/source/input", "-y", "/output/frame.png"), source, sha, stage,
                outputRoot, 501, 20, Duration.ofSeconds(3), 1024, runner);

        assertThat(result).contains("\"exitCode\":0");
        assertThat(commands.getFirst()).anySatisfy(arg -> assertThat(arg).startsWith("type=bind,source="));
        assertThat(Files.list(stage).toList()).isEmpty();
    }

    @Test
    void unknownContainerRemovalRetainsSnapshotForLaterReconciliation() throws Exception {
        Path sourceRoot = Files.createDirectory(temp.resolve("source2"));
        Path outputRoot = Files.createDirectory(temp.resolve("output2"));
        Path stage = Files.createDirectory(temp.resolve("stage2"));
        Files.setPosixFilePermissions(stage, PosixFilePermissions.fromString("rwx------"));
        Path source = sourceRoot.resolve("input.media");
        byte[] bytes = "pinned".getBytes();
        Files.write(source, bytes);
        String sha = sha(bytes);
        MediaOciBrokerDaemon.WorkerCommandRunner runner = (command, timeout) -> switch (command.get(1)) {
            case "create" -> new MediaOciBrokerDaemon.CommandResult(0, ID, false);
            case "start" -> new MediaOciBrokerDaemon.CommandResult(0, "", false);
            case "inspect" -> new MediaOciBrokerDaemon.CommandResult(0, "false", false);
            case "rm" -> new MediaOciBrokerDaemon.CommandResult(-1, "", true);
            default -> throw new AssertionError("unexpected OCI operation " + command);
        };
        assertThatThrownBy(() -> MediaOciBrokerDaemon.runWorkerWithSnapshot("docker",
                "worker@sha256:" + "b".repeat(64), "vision-snapshot", "ffmpeg",
                List.of("-nostdin", "-hide_banner", "-loglevel", "error", "-i", "/source/input",
                        "-y", "/output/frame.png"), source, sha, stage, outputRoot, 501, 20,
                Duration.ofSeconds(3), 1024, runner)).isInstanceOf(IOException.class);
        assertThat(Files.list(stage)).hasSize(1);
        assertThatThrownBy(() -> MediaOciBrokerDaemon.stageSnapshot(source, sha, stage))
                .isInstanceOf(IOException.class).hasMessageContaining("retained snapshots");
        assertThat(Files.list(stage)).hasSize(1);
    }

    @Test
    void sourceBoundsDigestAndDockerPathSyntaxFailClosed() throws Exception {
        Path stage = Files.createDirectory(temp.resolve("stage3"));
        Files.setPosixFilePermissions(stage, PosixFilePermissions.fromString("rwx------"));
        Path source = temp.resolve("tiny");
        Files.writeString(source, "bytes");
        assertThatThrownBy(() -> MediaOciBrokerDaemon.stageSnapshot(source, "0".repeat(64), stage))
                .isInstanceOf(IOException.class).hasMessageContaining("digest mismatch");
        Path digestFailureStage = Files.createDirectory(temp.resolve("stage-digest-failure"));
        Files.setPosixFilePermissions(digestFailureStage, PosixFilePermissions.fromString("rwx------"));
        assertThatThrownBy(() -> MediaOciBrokerDaemon.stageSnapshot(source, sha(Files.readAllBytes(source)),
                digestFailureStage, ignored -> { throw new IOException("simulated digest read failure"); }))
                .isInstanceOf(IOException.class).hasMessageContaining("simulated digest read failure");
        assertThat(Files.list(digestFailureStage).toList()).isEmpty();
        assertThat(MediaOciBrokerDaemon.safeDockerPath(Path.of("/safe/path/input"))).isTrue();
        assertThat(MediaOciBrokerDaemon.safeDockerPath(Path.of("/safe/a,b"))).isFalse();
        assertThat(MediaOciBrokerDaemon.safeDockerPath(Path.of("/safe/a\npath"))).isFalse();
        assertThat(MediaOciBrokerDaemon.sourceProbePairValid(null, List.of("-version"))).isTrue();
        assertThat(MediaOciBrokerDaemon.sourceProbePairValid(null, List.of("-i", "/source/input"))).isFalse();
        assertThat(MediaOciBrokerDaemon.sourceProbePairValid("/source/input", List.of("-version"))).isFalse();
        assertThat(MediaOciBrokerDaemon.writableOutputTransferAdmitted(null)).isTrue();
        assertThat(MediaOciBrokerDaemon.writableOutputTransferAdmitted("/output/staging")).isFalse();
    }

    @Test
    void stageRootMustBeOwnerOnlySeparateAndNotSymlinked() throws Exception {
        Path source = Files.createDirectory(temp.resolve("src"));
        Path output = Files.createDirectory(temp.resolve("out"));
        Path stage = Files.createTempDirectory(Path.of("/tmp"), "media-private-stage-");
        try {
            Files.setPosixFilePermissions(stage, PosixFilePermissions.fromString("rwx------"));
            assertThat(MediaOciBrokerDaemon.validateStageRoot(stage, source, output)).isEqualTo(stage.toRealPath());
            assertThat(MediaOciBrokerDaemon.stageOwnerDistinctFromPeer(
                    stage, MediaOciBrokerDaemon.currentOsUserName())).isFalse();
            assertThat(MediaOciBrokerDaemon.stageOwnerDistinctFromPeer(stage, "root")).isFalse();
            Files.setPosixFilePermissions(stage, PosixFilePermissions.fromString("rwxr-x---"));
            assertThatThrownBy(() -> MediaOciBrokerDaemon.validateStageRoot(stage, source, output))
                    .isInstanceOf(IOException.class).hasMessageContaining("owner-only");
            Files.setPosixFilePermissions(stage, PosixFilePermissions.fromString("rwx------"));
            assertThatThrownBy(() -> MediaOciBrokerDaemon.validateStageRoot(stage, source, stage.toRealPath()))
                    .isInstanceOf(IOException.class).hasMessageContaining("overlap");
            Path alias = temp.resolve("stage-link");
            Files.createSymbolicLink(alias, stage);
            assertThatThrownBy(() -> MediaOciBrokerDaemon.validateStageRoot(alias, source, output))
                    .isInstanceOf(IOException.class);
            Files.delete(alias);

            Path sharedParent = Files.createDirectory(temp.resolve("shared-stage-parent"));
            Files.setPosixFilePermissions(sharedParent, PosixFilePermissions.fromString("rwxrwx---"));
            Path nestedStage = Files.createDirectory(sharedParent.resolve("stage"));
            Files.setPosixFilePermissions(nestedStage, PosixFilePermissions.fromString("rwx------"));
            assertThatThrownBy(() -> MediaOciBrokerDaemon.validateStageRoot(nestedStage, source, output,
                    MediaOciBrokerDaemon.currentOsUserName(), "other-media-peer"))
                    .isInstanceOf(IOException.class).hasMessageContaining("sticky directories");
        } finally {
            Files.deleteIfExists(stage);
        }
    }

    @Test
    void brokerIdentityComesFromProcessNotOverridableJavaProperty() throws Exception {
        Path file = Files.createTempFile(temp, "owner", ".tmp");
        String expectedOwner = Files.getOwner(file).getName();
        String previous = System.getProperty("user.name");
        try {
            System.setProperty("user.name", "not-the-process-user");
            assertThat(MediaOciBrokerDaemon.currentOsUserName()).isEqualTo(expectedOwner);
            assertThat(MediaOciBrokerDaemon.distinctOsUsers(expectedOwner, expectedOwner)).isFalse();
            assertThat(MediaOciBrokerDaemon.distinctOsUsers(expectedOwner, "other-media-user")).isTrue();
        } finally {
            if (previous == null) System.clearProperty("user.name");
            else System.setProperty("user.name", previous);
        }
    }

    private static String sha(byte[] value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value)); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    @Test
    void timedOutInvocationIsKilledInspectedAndRemovedBeforeReturning() throws Exception {
        List<List<String>> commands = new ArrayList<>();
        MediaOciBrokerDaemon.WorkerCommandRunner runner = (command, timeout) -> {
            commands.add(List.copyOf(command));
            return switch (command.get(1)) {
                case "create" -> new MediaOciBrokerDaemon.CommandResult(0, ID, false);
                case "start" -> new MediaOciBrokerDaemon.CommandResult(-1, "", true);
                case "kill" -> new MediaOciBrokerDaemon.CommandResult(0, "", false);
                case "inspect" -> new MediaOciBrokerDaemon.CommandResult(0, "false", false);
                case "rm" -> new MediaOciBrokerDaemon.CommandResult(0, "", false);
                default -> throw new AssertionError("unexpected OCI operation " + command);
            };
        };

        String result = MediaOciBrokerDaemon.runWorker("docker", "worker@sha256:" + "b".repeat(64),
                "vision-test", "ffmpeg", List.of("-nostdin", "-hide_banner", "-loglevel", "error",
                        "-i", "/source/input", "-y", "/output/frame.png"), null, null,
                501, 20, Duration.ofSeconds(3), 1024 * 1024, runner);

        assertThat(result).contains("\"timedOut\":true", "\"exitCode\":-1");
        assertThat(commands).extracting(command -> command.get(1))
                .containsExactly("create", "start", "kill", "inspect", "rm");
        assertThat(commands.getFirst()).contains("--memory=1610612736", "--memory-swap=1610612736",
                "--cpus=2", "--pids-limit=32", "--network=none", "--read-only", "--cap-drop=ALL",
                "--security-opt=no-new-privileges:true", "--ulimit=nofile=64:64");
    }

    @Test
    void failedCleanupIsAnErrorAndNeverReturnsPartialSuccess() {
        List<String> operations = new ArrayList<>();
        MediaOciBrokerDaemon.WorkerCommandRunner runner = (command, timeout) -> {
            operations.add(command.get(1));
            return switch (command.get(1)) {
                case "create" -> new MediaOciBrokerDaemon.CommandResult(0, ID, false);
                case "start" -> new MediaOciBrokerDaemon.CommandResult(0, "partial", false);
                case "inspect" -> new MediaOciBrokerDaemon.CommandResult(0, "false", false);
                case "rm" -> new MediaOciBrokerDaemon.CommandResult(1, "", false);
                default -> throw new AssertionError("unexpected OCI operation " + command);
            };
        };

        assertThatThrownBy(() -> MediaOciBrokerDaemon.runWorker("docker", "worker@sha256:" + "b".repeat(64),
                "vision-test", "ffmpeg", List.of("-nostdin", "-hide_banner", "-loglevel", "error",
                        "-i", "/source/input", "-y", "/output/frame.png"), null, null,
                501, 20, Duration.ofSeconds(3), 1024 * 1024, runner))
                .isInstanceOf(IOException.class)
                .hasMessageContaining("could not confirm worker container cleanup");
        assertThat(operations).containsExactly("create", "start", "inspect", "rm", "rm");
    }
}
