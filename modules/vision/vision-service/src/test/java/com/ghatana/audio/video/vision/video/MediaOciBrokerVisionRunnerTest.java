package com.ghatana.audio.video.vision.video;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Deterministic per-invocation OCI lifecycle checks; no Docker daemon required. */
class MediaOciBrokerVisionRunnerTest {
    private static final String ID = "a".repeat(64);

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
