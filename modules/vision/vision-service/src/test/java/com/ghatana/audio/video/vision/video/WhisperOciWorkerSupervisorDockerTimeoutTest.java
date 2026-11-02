package com.ghatana.audio.video.vision.video;

import com.ghatana.media.runtime.WhisperComputeContracts.Status;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Opt-in real-container timeout regression. The bundle contents are synthetic and
 * the test-only ARM64 image must only block; this exercises OCI lifecycle/deadline
 * handling and makes no model inference, quality, licensing, or rights claim.
 */
class WhisperOciWorkerSupervisorDockerTimeoutTest {
    private static final String IMAGE_ID_ENV = "MEDIA_WHISPER_DOCKER_TIMEOUT_TEST_IMAGE_ID";
    private static final String TOKEN = "docker-timeout-regression-secret-0123456789abcdef";
    private static final String PROFILE = "whisper.en.reference.v1";
    private static final String WAV = "RIFF synthetic timeout fixture";
    private static final String INPUT_SHA = sha256(WAV.getBytes(StandardCharsets.UTF_8));
    private static final long UID = 501;
    private static final long GID = 20;
    private static final Map<String, byte[]> MODEL_ASSETS = Map.of(
            "encoder_model_quantized.onnx", bytes("synthetic encoder"),
            "decoder_model_merged_quantized.onnx", bytes("synthetic decoder"),
            "mel_filters.npz", bytes("synthetic mel filters"),
            "multilingual.tiktoken", bytes("synthetic tokenizer"));

    @TempDir Path temp;

    @Test
    void monotonicDeadlineKillsAndRemovesBlockedContainerAndDuplicateDoesNotRelaunch() throws Exception {
        String imageId = System.getenv(IMAGE_ID_ENV);
        assumeTrue(imageId != null, IMAGE_ID_ENV + " is unset; opt-in Docker test skipped");
        assertThat(imageId).matches("sha256:[0-9a-f]{64}");

        Path modelRoot = privateDirectory("synthetic-four-file-model");
        for (var asset : MODEL_ASSETS.entrySet()) Files.write(modelRoot.resolve(asset.getKey()), asset.getValue());
        Path journalRoot = privateDirectory("journal");
        String modelSha = sha256(MODEL_ASSETS.get("encoder_model_quantized.onnx"));
        Map<String, String> environment = Map.of(
                "MEDIA_OCI_BROKER_WHISPER_PROFILE_ID", PROFILE,
                "MEDIA_OCI_BROKER_WHISPER_IMAGE", imageId,
                "MEDIA_OCI_BROKER_WHISPER_MODEL_SHA256", modelSha,
                "MEDIA_OCI_BROKER_WHISPER_MODEL_BUNDLE_SHA256",
                        WhisperWorkerServerConfig.bundleSha256(modelRoot),
                "MEDIA_OCI_BROKER_WHISPER_MODEL_REVISION", "synthetic-timeout-fixture-r1",
                "MEDIA_OCI_BROKER_WHISPER_MODEL_ROOT", modelRoot.toString(),
                "MEDIA_OCI_BROKER_WHISPER_LOCALES", "en,en-US",
                "MEDIA_OCI_BROKER_WHISPER_JOURNAL_DIR", journalRoot.toString());
        WhisperWorkerServerConfig config = WhisperWorkerServerConfig.load(environment, Set.of(imageId))
                .orElseThrow(() -> new AssertionError("Synthetic pinned OCI test configuration was rejected"));

        String docker = System.getenv().getOrDefault("DOCKER", "docker");
        var processRunner = new WhisperOciWorkerSupervisor.ProcessBuilderCommandRunner();
        var imageInfo = processRunner.run(List.of(docker, "image", "inspect", "--format",
                "{{.Id}}|{{.Architecture}}|{{json .Config.Entrypoint}}", imageId),
                null, Duration.ofSeconds(10), 4096, 1024);
        assertThat(imageInfo.timedOut()).isFalse();
        assertThat(imageInfo.exitCode()).isZero();
        assertThat(new String(imageInfo.stdout(), StandardCharsets.UTF_8).trim())
                .isEqualTo(imageId + "|arm64|[\"/bin/sh\",\"-c\",\"exec sleep 600\"]");

        RecordingRunner runner = new RecordingRunner(processRunner);
        try (MediaOciBrokerWhisperJournal journal = MediaOciBrokerWhisperJournal.open(journalRoot, TOKEN, 20)) {
            WhisperOciWorkerSupervisor supervisor = new WhisperOciWorkerSupervisor(
                    docker, UID, GID, config, journal, runner);
            try {
                UUID invocationId = UUID.randomUUID();
                var result = supervisor.execute(invocationId, PROFILE, "en-US", INPUT_SHA,
                        WAV.getBytes(StandardCharsets.UTF_8), 20_000);

                assertThat(result.status()).isEqualTo(Status.UNKNOWN_OUTCOME);
                assertThat(supervisor.status(invocationId, PROFILE, "en-US", INPUT_SHA).status())
                        .isEqualTo(Status.UNKNOWN_OUTCOME);
                var journalEntry = journal.lookup(invocationId);
                assertThat(journalEntry).isNotNull();
                assertThat(journalEntry.status()).isEqualTo(MediaOciBrokerWhisperJournal.Status.UNKNOWN_OUTCOME);

                List<String> create = runner.commands().stream()
                        .filter(command -> command.size() > 1 && command.get(1).equals("create"))
                        .findFirst().orElseThrow(() -> new AssertionError("No real OCI create command ran"));
                String containerId = runner.resultFor(create).stdoutText().trim();
                assertThat(containerId).matches("[a-f0-9]{64}");
                assertThat(runner.commands()).anySatisfy(command -> assertThat(command)
                        .containsExactly(docker, "start", "--attach", "--interactive", containerId));
                List<String> start = runner.commands().stream()
                        .filter(command -> command.size() > 1 && command.get(1).equals("start"))
                        .findFirst().orElseThrow(() -> new AssertionError("No real OCI start command ran"));
                assertThat(runner.resultFor(start).result().timedOut())
                        .as("the attached Docker worker must hit the supervisor deadline")
                        .isTrue();
                List<String> kill = List.of(docker, "kill", "--signal=KILL", containerId);
                var killed = runner.callExactly(kill);
                assertThat(killed).isNotNull();
                assertThat(killed.timedOut()).isFalse();
                assertThat(killed.exitCode()).isZero();
                var removal = runner.callExactly(List.of(docker, "rm", "--force", containerId));
                assertThat(removal).isNotNull();
                assertThat(removal.exitCode()).isZero();

                int createCountBeforeDuplicate = runner.countOperation("create");
                int startCountBeforeDuplicate = runner.countOperation("start");
                var duplicate = supervisor.execute(invocationId, PROFILE, "en-US", INPUT_SHA,
                        WAV.getBytes(StandardCharsets.UTF_8), 5_000);
                assertThat(duplicate.status()).isEqualTo(Status.UNKNOWN_OUTCOME);
                assertThat(runner.countOperation("create")).isEqualTo(createCountBeforeDuplicate);
                assertThat(runner.countOperation("start")).isEqualTo(startCountBeforeDuplicate);

                String brokerLabel = create.stream()
                        .filter(value -> value.startsWith("com.ghatana.media.oci.broker-instance="))
                        .findFirst().orElseThrow()
                        .substring("com.ghatana.media.oci.broker-instance=".length());
                var leftovers = processRunner.run(List.of(docker, "ps", "--all", "--quiet",
                        "--filter", "label=com.ghatana.media.whisper.worker=true",
                        "--filter", "label=com.ghatana.media.oci.broker-instance=" + brokerLabel),
                        null, Duration.ofSeconds(10), 4096, 1024);
                assertThat(leftovers.timedOut()).isFalse();
                assertThat(leftovers.exitCode()).isZero();
                assertThat(new String(leftovers.stdout(), StandardCharsets.UTF_8).trim()).isEmpty();
            } finally {
                supervisor.close();
            }
        }
    }

    private Path privateDirectory(String name) throws IOException {
        Path directory = temp.resolve(name);
        Files.createDirectory(directory);
        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
        return directory;
    }

    private static byte[] bytes(String value) { return value.getBytes(StandardCharsets.UTF_8); }

    private static String sha256(byte[] value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value)); }
        catch (Exception impossible) { throw new IllegalStateException(impossible); }
    }

    private static final class RecordingRunner implements WhisperOciWorkerSupervisor.CommandRunner {
        private final WhisperOciWorkerSupervisor.CommandRunner delegate;
        private final List<Call> calls = new ArrayList<>();

        private RecordingRunner(WhisperOciWorkerSupervisor.CommandRunner delegate) { this.delegate = delegate; }

        @Override
        public synchronized WhisperOciWorkerSupervisor.CommandResult run(List<String> command, byte[] stdin,
                Duration timeout, int stdoutLimit, int stderrLimit) throws IOException {
            var result = delegate.run(command, stdin, timeout, stdoutLimit, stderrLimit);
            calls.add(new Call(List.copyOf(command), result));
            return result;
        }

        synchronized List<List<String>> commands() { return calls.stream().map(Call::command).toList(); }

        synchronized int countOperation(String operation) {
            return (int) calls.stream().filter(call -> call.command().size() > 1
                    && call.command().get(1).equals(operation)).count();
        }

        synchronized Call resultFor(List<String> command) {
            return calls.stream().filter(call -> call.command().equals(command)).findFirst().orElseThrow();
        }

        synchronized WhisperOciWorkerSupervisor.CommandResult callExactly(List<String> command) {
            return calls.stream().filter(call -> call.command().equals(command)).map(Call::result)
                    .findFirst().orElse(null);
        }

        private record Call(List<String> command, WhisperOciWorkerSupervisor.CommandResult result) {
            private String stdoutText() { return new String(result.stdout(), StandardCharsets.UTF_8); }
        }
    }
}
