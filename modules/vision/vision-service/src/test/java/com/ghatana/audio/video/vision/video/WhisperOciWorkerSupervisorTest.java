package com.ghatana.audio.video.vision.video;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;
import com.ghatana.media.runtime.WhisperComputeContracts;
import com.ghatana.media.runtime.WhisperComputeContracts.Status;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

class WhisperOciWorkerSupervisorTest {
    private static final String TOKEN = "supervisor-test-secret-material-0123456789abcdef";
    private static final String PROFILE = "whisper.en.reference.v1";
    private static final String IMAGE = "worker@sha256:" + "a".repeat(64);
    private static final String WAV = "RIFF test wav";
    private static final String INPUT_SHA = digest(WAV.getBytes(StandardCharsets.UTF_8));
    private static final String TRANSCRIPT = "deterministic transcript";
    private static final long UID = 501;
    private static final long GID = 20;
    private static final ObjectMapper JSON = new ObjectMapper(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build());
    private static final Map<String, byte[]> ASSETS = Map.of(
            "encoder_model_quantized.onnx", bytes("encoder"),
            "decoder_model_merged_quantized.onnx", bytes("decoder"),
            "mel_filters.npz", bytes("mel"), "multilingual.tiktoken", bytes("tokenizer"));

    @TempDir Path temp;

    private static byte[] bytes(String text) { return text.getBytes(StandardCharsets.UTF_8); }

    private Context context(String name, FakeRunner runner) throws Exception {
        Path model = privateDirectory(name + "-model");
        for (var asset : ASSETS.entrySet()) Files.write(model.resolve(asset.getKey()), asset.getValue());
        Path journalPath = privateDirectory(name + "-journal");
        Map<String, String> env = new HashMap<>();
        env.put("MEDIA_OCI_BROKER_WHISPER_PROFILE_ID", PROFILE);
        env.put("MEDIA_OCI_BROKER_WHISPER_IMAGE", IMAGE);
        env.put("MEDIA_OCI_BROKER_WHISPER_MODEL_SHA256", digest(ASSETS.get("encoder_model_quantized.onnx")));
        env.put("MEDIA_OCI_BROKER_WHISPER_MODEL_BUNDLE_SHA256", WhisperWorkerServerConfig.bundleSha256(model));
        env.put("MEDIA_OCI_BROKER_WHISPER_MODEL_REVISION", "reference-r1");
        env.put("MEDIA_OCI_BROKER_WHISPER_MODEL_ROOT", model.toString());
        env.put("MEDIA_OCI_BROKER_WHISPER_LOCALES", "en,en-US");
        env.put("MEDIA_OCI_BROKER_WHISPER_JOURNAL_DIR", journalPath.toString());
        WhisperWorkerServerConfig config = WhisperWorkerServerConfig.load(env, Set.of(IMAGE)).orElseThrow();
        MediaOciBrokerWhisperJournal journal = MediaOciBrokerWhisperJournal.open(journalPath, TOKEN, 20);
        WhisperOciWorkerSupervisor supervisor = new WhisperOciWorkerSupervisor(
                "docker", UID, GID, config, journal, runner);
        return new Context(config, journal, supervisor);
    }

    private Path privateDirectory(String name) throws IOException {
        Path directory = temp.resolve(name);
        Files.createDirectory(directory);
        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
        return directory;
    }

    @Test
    void generatedCommandUsesOnlyPinnedImageModelIdentityAndFixedSandbox() throws Exception {
        FakeRunner runner = new FakeRunner();
        try (Context context = context("argv", runner)) {
            List<String> args = WhisperOciWorkerSupervisor.commandForTest(context.config(), "docker",
                    "123e4567-e89b-12d3-a456-426614174000", UID, GID);
            assertThat(args).startsWith("docker", "create", "--name", "media-whisper-123e4567xe89bx12d3xa456x426614174000");
            assertThat(args).contains("--pull=never", "--platform=linux/arm64",
                    "--memory=1610612736", "--memory-swap=1610612736", "--cpus=2",
                    "--pids-limit=32", "--ulimit=nofile=64:64", "--network=none", "--read-only",
                    "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
                    "--interactive",
                    "--tmpfs", "/tmp:rw,nosuid,nodev,exec,size=128m,nr_inodes=4096",
                    "--user=501:20", "--env=MEDIA_WHISPER_WORKER_MODEL_REVISION=reference-r1",
                    "--env=MEDIA_WHISPER_WORKER_MODEL_PATH=/models/encoder_model_quantized.onnx",
                    "type=bind,source=" + context.config().modelRoot() + ",target=/models,readonly", IMAGE);
            assertThat(args).doesNotContain("/bin/sh", "sh", "-c", "--entrypoint");
            assertThat(args.getLast()).isEqualTo(IMAGE);
        }
    }

    @Test
    void executePersistsExactSuccessAndStatusOrDuplicateReturnsItWithoutSecondLaunch() throws Exception {
        FakeRunner runner = new FakeRunner();
        try (Context context = context("success", runner)) {
            var executed = context.supervisor().execute(id(0), PROFILE, "en-US", INPUT_SHA,
                    WAV.getBytes(StandardCharsets.UTF_8), 30_000);
            assertThat(executed.status()).isEqualTo(Status.SUCCESS);
            assertThat(executed.transcript()).isEqualTo(TRANSCRIPT);
            assertThat(context.supervisor().status(id(0), PROFILE, "en-US", INPUT_SHA))
                    .isEqualTo(executed);
            assertThat(context.supervisor().execute(id(0), PROFILE, "en-US", INPUT_SHA,
                    WAV.getBytes(StandardCharsets.UTF_8), 30_000)).isEqualTo(executed);
            assertThat(runner.commands.stream().filter(command -> command.get(1).equals("create"))).hasSize(1);
            assertThat(runner.commands).anySatisfy(command -> assertThat(command)
                    .contains("image", "inspect", "--format", "{{.Id}}|{{json .RepoDigests}}"));
            assertThat(new String(runner.lastStdin, StandardCharsets.UTF_8))
                    .contains("\"wavBase64\":\"" + Base64.getEncoder()
                            .encodeToString(WAV.getBytes(StandardCharsets.UTF_8)) + "\"");
            assertThat(context.journal().lookup(id(0)).status())
                    .isEqualTo(MediaOciBrokerWhisperJournal.Status.SUCCESS);
        }
    }

    @Test
    void inputDigestMismatchDoesNotReachDocker() throws Exception {
        FakeRunner runner = new FakeRunner();
        try (Context context = context("digest", runner)) {
            var response = context.supervisor().execute(id(0), PROFILE, "en-US", "0".repeat(64),
                    WAV.getBytes(StandardCharsets.UTF_8), 30_000);
            assertThat(response.status()).isEqualTo(Status.INVALID_REQUEST);
            assertThat(runner.commands).isEmpty();
            assertThat(context.journal().recordCount()).isZero();
        }
    }

    @Test
    void missingPinnedImageOrModelDriftIsNotAdmittedBeforeDurableDispatch() throws Exception {
        FakeRunner runner = new FakeRunner();
        runner.imageMissing = true;
        try (Context context = context("image-missing", runner)) {
            assertThat(context.supervisor().execute(id(0), PROFILE, "en-US", INPUT_SHA,
                    WAV.getBytes(StandardCharsets.UTF_8), 30_000).status()).isEqualTo(Status.NOT_ADMITTED);
            assertThat(context.journal().recordCount()).isZero();
            assertThat(runner.commands).noneMatch(command -> command.contains("create"));
        }

        FakeRunner modelDrift = new FakeRunner();
        try (Context context = context("model-drift", modelDrift)) {
            Files.writeString(context.config().modelRoot().resolve("mel_filters.npz"), "changed after startup");
            assertThat(context.supervisor().execute(id(0), PROFILE, "en-US", INPUT_SHA,
                    WAV.getBytes(StandardCharsets.UTF_8), 30_000).status()).isEqualTo(Status.NOT_ADMITTED);
            assertThat(context.journal().recordCount()).isZero();
            assertThat(modelDrift.commands).noneMatch(command -> command.contains("create"));
        }
    }

    @Test
    void preflightThatConsumesBudgetReturnsDeadlineBeforeJournalOrContainerDispatch() throws Exception {
        FakeRunner runner = new FakeRunner();
        AtomicLong clock = new AtomicLong();
        runner.advanceClock = clock;
        runner.advanceOnImageInspectNanos = TimeUnit.MILLISECONDS.toNanos(100);
        try (Context context = context("preflight-deadline", runner)) {
            WhisperOciWorkerSupervisor supervisor = new WhisperOciWorkerSupervisor(
                    "docker", UID, GID, context.config(), context.journal(), runner, clock::get);
            var result = supervisor.execute(id(0), PROFILE, "en-US", INPUT_SHA,
                    WAV.getBytes(StandardCharsets.UTF_8), 100);
            assertThat(result.status()).isEqualTo(Status.DEADLINE_EXCEEDED);
            assertThat(context.journal().recordCount()).isZero();
            assertThat(runner.commands).noneMatch(command -> command.contains("create") || command.contains("start"));
        }
    }

    @Test
    void cancellationDuringPreflightWinsBeforeJournalReservationOrWorkerLaunch() throws Exception {
        FakeRunner runner = new FakeRunner();
        runner.blockImageInspect = true;
        try (Context context = context("cancel-preflight", runner)) {
            CompletableFuture<com.ghatana.media.runtime.WhisperComputeContracts.Result> execution =
                    CompletableFuture.supplyAsync(() -> context.supervisor().execute(id(0), PROFILE, "en-US",
                            INPUT_SHA, WAV.getBytes(StandardCharsets.UTF_8), 30_000));
            assertThat(runner.imageInspectEntered.await(5, TimeUnit.SECONDS)).isTrue();
            var cancellation = context.supervisor().cancel(id(0), PROFILE, "en-US", INPUT_SHA);
            assertThat(cancellation.status()).isEqualTo(Status.NOT_ADMITTED);
            runner.finishImageInspect.countDown();

            assertThat(execution.get(5, TimeUnit.SECONDS).status()).isEqualTo(Status.NOT_ADMITTED);
            assertThat(context.journal().recordCount()).isZero();
            assertThat(runner.commands).noneMatch(command -> command.size() > 1
                    && (command.get(1).equals("create") || command.get(1).equals("start")));
            assertThat(context.supervisor().status(id(0), PROFILE, "en-US", INPUT_SHA).status())
                    .isEqualTo(Status.NOT_ADMITTED);
        }
    }

    @Test
    void cancellationWhileExecuteWaitsForDispatchLockReturnsImmediatelyAndPreventsAdmission() throws Exception {
        FakeRunner runner = new FakeRunner();
        try (Context context = context("cancel-before-lock", runner)) {
            assertThat(context.journal().begin(new MediaOciBrokerWhisperJournal.Identity(
                    id(0), PROFILE, "en-US", INPUT_SHA)).kind())
                    .isEqualTo(MediaOciBrokerWhisperJournal.BeginKind.RESERVED);
            AtomicReference<com.ghatana.media.runtime.WhisperComputeContracts.Result> firstResult =
                    new AtomicReference<>();
            Thread first = new Thread(() -> firstResult.set(context.supervisor().execute(
                    id(0), PROFILE, "en-US", INPUT_SHA, WAV.getBytes(StandardCharsets.UTF_8), 30_000)),
                    "whisper-execute-holding-dispatch-lock-test");
            AtomicReference<com.ghatana.media.runtime.WhisperComputeContracts.Result> pendingResult =
                    new AtomicReference<>();
            Thread pending = new Thread(() -> pendingResult.set(context.supervisor().execute(
                    id(1), PROFILE, "en-US", INPUT_SHA, WAV.getBytes(StandardCharsets.UTF_8), 30_000)),
                    "whisper-execute-waiting-for-dispatch-lock-test");
            try {
                synchronized (context.journal()) {
                    first.start();
                    awaitBlocked(first);
                    pending.start();
                    // The pending call is now blocked behind the first call's dispatch lock.
                    // Its registry entry must already be visible to cancel().
                    awaitBlocked(pending);
                    var cancellation = CompletableFuture.supplyAsync(() -> context.supervisor().cancel(
                            id(1), PROFILE, "en-US", INPUT_SHA));
                    assertThat(cancellation.get(1, TimeUnit.SECONDS).status())
                            .isEqualTo(Status.NOT_ADMITTED);
                    assertThat(runner.commands).isEmpty();
                }

                first.join(5_000);
                pending.join(5_000);
                assertThat(first.isAlive()).isFalse();
                assertThat(pending.isAlive()).isFalse();
                assertThat(firstResult.get().status()).isEqualTo(Status.UNKNOWN_OUTCOME);
                assertThat(pendingResult.get().status()).isEqualTo(Status.NOT_ADMITTED);
                assertThat(context.journal().recordCount()).isEqualTo(1);
                assertThat(context.journal().lookup(id(1))).isNull();
                assertThat(runner.commands).noneMatch(command -> command.size() > 1
                        && (command.get(1).equals("create") || command.get(1).equals("start")));
            } finally {
                if (first.isAlive()) first.join(5_000);
                if (pending.isAlive()) pending.join(5_000);
            }
        }
    }

    @Test
    void cancellationWhilePendingReconcilesPersistedSuccessWithoutWaitingForDispatchLock() throws Exception {
        FakeRunner runner = new FakeRunner();
        try (Context context = context("cancel-pending-existing-success", runner)) {
            var priorStarted = new MediaOciBrokerWhisperJournal.Identity(id(0), PROFILE, "en-US", INPUT_SHA);
            assertThat(context.journal().begin(priorStarted).kind())
                    .isEqualTo(MediaOciBrokerWhisperJournal.BeginKind.RESERVED);
            var completed = new MediaOciBrokerWhisperJournal.Identity(id(1), PROFILE, "en-US", INPUT_SHA);
            assertThat(context.journal().begin(completed).kind())
                    .isEqualTo(MediaOciBrokerWhisperJournal.BeginKind.RESERVED);
            context.journal().completeSuccess(completed,
                    digest(ASSETS.get("encoder_model_quantized.onnx")), TRANSCRIPT);
            var persistedSuccess = context.supervisor().status(id(1), PROFILE, "en-US", INPUT_SHA);
            assertThat(persistedSuccess.status()).isEqualTo(Status.SUCCESS);

            AtomicReference<com.ghatana.media.runtime.WhisperComputeContracts.Result> firstResult =
                    new AtomicReference<>();
            Thread first = new Thread(() -> firstResult.set(context.supervisor().execute(
                    id(0), PROFILE, "en-US", INPUT_SHA, WAV.getBytes(StandardCharsets.UTF_8), 30_000)),
                    "whisper-execute-holding-dispatch-lock-existing-success-test");
            AtomicReference<com.ghatana.media.runtime.WhisperComputeContracts.Result> pendingResult =
                    new AtomicReference<>();
            Thread pending = new Thread(() -> pendingResult.set(context.supervisor().execute(
                    id(1), PROFILE, "en-US", INPUT_SHA, WAV.getBytes(StandardCharsets.UTF_8), 30_000)),
                    "whisper-execute-pending-existing-success-test");
            try {
                synchronized (context.journal()) {
                    first.start();
                    awaitBlocked(first);
                    pending.start();
                    awaitBlocked(pending);

                    var cancellation = CompletableFuture.supplyAsync(() -> context.supervisor().cancel(
                            id(1), PROFILE, "en-US", INPUT_SHA));
                    assertThat(cancellation.get(1, TimeUnit.SECONDS)).isEqualTo(persistedSuccess);
                    assertThat(runner.commands).isEmpty();
                }

                first.join(5_000);
                pending.join(5_000);
                assertThat(first.isAlive()).isFalse();
                assertThat(pending.isAlive()).isFalse();
                assertThat(firstResult.get().status()).isEqualTo(Status.UNKNOWN_OUTCOME);
                assertThat(pendingResult.get()).isEqualTo(persistedSuccess);
                assertThat(context.journal().lookup(id(1)).status())
                        .isEqualTo(MediaOciBrokerWhisperJournal.Status.SUCCESS);
                assertThat(context.journal().recordCount()).isEqualTo(2);
                assertThat(runner.commands).isEmpty();
            } finally {
                if (first.isAlive()) first.join(5_000);
                if (pending.isAlive()) pending.join(5_000);
            }
        }
    }

    private static void awaitBlocked(Thread thread) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (thread.getState() != Thread.State.BLOCKED && System.nanoTime() < deadline) {
            if (!thread.isAlive()) throw new AssertionError("execute returned before reaching the blocked gate");
            Thread.yield();
        }
        assertThat(thread.getState()).isEqualTo(Thread.State.BLOCKED);
    }

    @Test
    void workerSuccessThatExpiresDuringInspectAndRemovalCannotCommitLateSuccess() throws Exception {
        FakeRunner runner = new FakeRunner();
        AtomicLong clock = new AtomicLong();
        runner.advanceClock = clock;
        runner.advanceOnInspectNanos = TimeUnit.MILLISECONDS.toNanos(60);
        runner.advanceOnRemoveNanos = TimeUnit.MILLISECONDS.toNanos(41);
        try (Context context = context("late-success", runner)) {
            WhisperOciWorkerSupervisor supervisor = new WhisperOciWorkerSupervisor(
                    "docker", UID, GID, context.config(), context.journal(), runner, clock::get);
            var result = supervisor.execute(id(0), PROFILE, "en-US", INPUT_SHA,
                    WAV.getBytes(StandardCharsets.UTF_8), 100);
            assertThat(result.status()).isEqualTo(Status.UNKNOWN_OUTCOME);
            assertThat(context.journal().lookup(id(0)).status())
                    .isEqualTo(MediaOciBrokerWhisperJournal.Status.UNKNOWN_OUTCOME);
            assertThat(supervisor.status(id(0), PROFILE, "en-US", INPUT_SHA).status())
                    .isEqualTo(Status.UNKNOWN_OUTCOME);
            assertThat(supervisor.execute(id(0), PROFILE, "en-US", INPUT_SHA,
                    WAV.getBytes(StandardCharsets.UTF_8), 100).status()).isEqualTo(Status.UNKNOWN_OUTCOME);
            assertThat(runner.commands.stream().filter(command -> command.get(1).equals("create"))).hasSize(1);
        }
    }

    @Test
    void startupSweepTargetsOnlyStableBrokerInstanceAndRequiresConfirmedRemoval() throws Exception {
        FakeRunner runner = new FakeRunner();
        runner.orphanIds = "d".repeat(64) + "\n" + "e".repeat(64) + "\n";
        try (Context context = context("orphan-sweep", runner)) {
            assertThat(context.supervisor().cleanupOrphans()).isTrue();
            List<String> sweep = runner.commands.getFirst();
            assertThat(sweep).contains("ps", "--all", "--quiet", "--filter",
                    "label=com.ghatana.media.whisper.worker=true");
            assertThat(sweep.stream().filter(value -> value.startsWith(
                    "label=com.ghatana.media.oci.broker-instance=")).count()).isEqualTo(1);
            assertThat(runner.commands.stream().filter(command -> command.get(1).equals("rm"))).hasSize(2);
        }
        FakeRunner failed = new FakeRunner();
        failed.orphanIds = "f".repeat(64) + "\n";
        failed.failRemove = true;
        try (Context context = context("orphan-fail", failed)) {
            assertThat(context.supervisor().cleanupOrphans()).isFalse();
        }
    }

    @Test
    void startupSweepsBeforeCorruptJournalRecoveryAndFailsClosedWhenSweepFails() throws Exception {
        FakeRunner runner = new FakeRunner();
        runner.orphanIds = "a".repeat(64) + "\n";
        WhisperWorkerServerConfig config;
        Path journalDirectory;
        try (Context context = context("corrupt-startup", runner)) {
            config = context.config();
            journalDirectory = config.journalDirectory();
        }
        Files.write(journalDirectory.resolve("whisper-invocations.log"), bytes("torn record"));

        WhisperOciWorkerSupervisor.Startup unavailable = WhisperOciWorkerSupervisor.start(
                "docker", UID, GID, config, TOKEN, runner);
        assertThat(unavailable.admitted()).isFalse();
        assertThat(unavailable.supervisor()).isNull();
        assertThat(unavailable.journal()).isNull();
        assertThat(runner.commands.stream().map(command -> command.get(1)).toList())
                .containsSubsequence("ps", "rm");

        FakeRunner failedSweep = new FakeRunner();
        failedSweep.failList = true;
        WhisperOciWorkerSupervisor.Startup blocked = WhisperOciWorkerSupervisor.start(
                "docker", UID, GID, config, TOKEN, failedSweep);
        assertThat(blocked.admitted()).isFalse();
        assertThat(failedSweep.commands).hasSize(1);
        assertThat(failedSweep.commands.getFirst()).contains("ps");
    }

    @Test
    void timeoutKillsAndRemovesContainerThenDuplicateAndStatusStayUnknown() throws Exception {
        FakeRunner runner = new FakeRunner();
        runner.startTimedOut = true;
        try (Context context = context("timeout", runner)) {
            var result = context.supervisor().execute(id(0), PROFILE, "en-US", INPUT_SHA,
                    WAV.getBytes(StandardCharsets.UTF_8), 1000);
            assertThat(result.status()).isEqualTo(Status.UNKNOWN_OUTCOME);
            assertThat(runner.commands).anySatisfy(command -> assertThat(command)
                    .contains("kill", "--signal=KILL"));
            assertThat(runner.commands).anySatisfy(command -> assertThat(command).contains("rm", "--force"));
            assertThat(context.supervisor().status(id(0), PROFILE, "en-US", INPUT_SHA).status())
                    .isEqualTo(Status.UNKNOWN_OUTCOME);
            assertThat(context.supervisor().execute(id(0), PROFILE, "en-US", INPUT_SHA,
                    WAV.getBytes(StandardCharsets.UTF_8), 30_000).status())
                    .isEqualTo(Status.UNKNOWN_OUTCOME);
            assertThat(runner.commands.stream().filter(command -> command.get(1).equals("create"))).hasSize(1);
        }
    }

    @Test
    void activeStatusRemainsResponsiveAndSecondInvocationIsRejectedAtSingleFlightLimit() throws Exception {
        FakeRunner runner = new FakeRunner();
        runner.blockStart = true;
        try (Context context = context("active", runner)) {
            CompletableFuture<com.ghatana.media.runtime.WhisperComputeContracts.Result> first =
                    CompletableFuture.supplyAsync(() -> context.supervisor().execute(id(0), PROFILE, "en-US",
                            INPUT_SHA, WAV.getBytes(StandardCharsets.UTF_8), 30_000));
            assertThat(runner.startEntered.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(context.supervisor().status(id(0), PROFILE, "en-US", INPUT_SHA).status())
                    .isEqualTo(Status.UNKNOWN_OUTCOME);
            assertThat(context.supervisor().execute(id(1), PROFILE, "en-US", INPUT_SHA,
                    WAV.getBytes(StandardCharsets.UTF_8), 30_000).status()).isEqualTo(Status.RESOURCE_EXHAUSTED);
            runner.finishStart.countDown();
            assertThat(first.get(5, TimeUnit.SECONDS).status()).isEqualTo(Status.SUCCESS);
        }
    }

    @Test
    void cancelKillsActiveContainerAndReturnsUnknownWithoutBlindSuccess() throws Exception {
        FakeRunner runner = new FakeRunner();
        runner.blockStart = true;
        try (Context context = context("cancel", runner)) {
            CompletableFuture<com.ghatana.media.runtime.WhisperComputeContracts.Result> first =
                    CompletableFuture.supplyAsync(() -> context.supervisor().execute(id(0), PROFILE, "en-US",
                            INPUT_SHA, WAV.getBytes(StandardCharsets.UTF_8), 30_000));
            assertThat(runner.startEntered.await(5, TimeUnit.SECONDS)).isTrue();
            var cancelled = context.supervisor().cancel(id(0), PROFILE, "en-US", INPUT_SHA);
            assertThat(cancelled.status()).isEqualTo(Status.UNKNOWN_OUTCOME);
            assertThat(first.get(5, TimeUnit.SECONDS).status()).isEqualTo(Status.UNKNOWN_OUTCOME);
            assertThat(context.supervisor().status(id(0), PROFILE, "en-US", INPUT_SHA).status())
                    .isEqualTo(Status.UNKNOWN_OUTCOME);
            assertThat(runner.commands).anySatisfy(command -> assertThat(command).contains("kill", "--signal=KILL"));
        }
    }

    @Test
    void cancellationDuringCreateKillsCreatedContainerWithoutStartingWorker() throws Exception {
        FakeRunner runner = new FakeRunner();
        runner.blockCreate = true;
        try (Context context = context("cancel-during-create", runner)) {
            CompletableFuture<com.ghatana.media.runtime.WhisperComputeContracts.Result> execution =
                    CompletableFuture.supplyAsync(() -> context.supervisor().execute(id(0), PROFILE, "en-US",
                            INPUT_SHA, WAV.getBytes(StandardCharsets.UTF_8), 30_000));
            Thread cancelThread = null;
            try {
                assertThat(runner.createEntered.await(5, TimeUnit.SECONDS)).isTrue();

                AtomicReference<com.ghatana.media.runtime.WhisperComputeContracts.Result> cancellation =
                        new AtomicReference<>();
                CountDownLatch cancellationReturned = new CountDownLatch(1);
                cancelThread = new Thread(() -> {
                    try {
                        cancellation.set(context.supervisor().cancel(id(0), PROFILE, "en-US", INPUT_SHA));
                    } finally {
                        cancellationReturned.countDown();
                    }
                }, "whisper-cancel-during-create-test");
                cancelThread.start();

                // cancel() sets the operation's cancelled flag before waiting for execute() to finish.
                // Waiting for that bounded wait to begin establishes the race ordering without sleeps.
                awaitWaiting(cancelThread);
                runner.finishCreate.countDown();
                assertThat(execution.get(5, TimeUnit.SECONDS).status()).isEqualTo(Status.UNKNOWN_OUTCOME);
                assertThat(cancellationReturned.await(5, TimeUnit.SECONDS)).isTrue();
                cancelThread.join(1_000);
                assertThat(cancelThread.isAlive()).isFalse();
                assertThat(cancellation.get().status()).isEqualTo(Status.UNKNOWN_OUTCOME);

                assertThat(context.supervisor().status(id(0), PROFILE, "en-US", INPUT_SHA).status())
                        .isEqualTo(Status.UNKNOWN_OUTCOME);
                assertThat(context.journal().lookup(id(0)).status())
                        .isEqualTo(MediaOciBrokerWhisperJournal.Status.UNKNOWN_OUTCOME);
                assertThat(runner.commands).anySatisfy(command -> assertThat(command)
                        .contains("kill", "--signal=KILL", FakeRunner.CONTAINER));
                assertThat(runner.commands).anySatisfy(command -> assertThat(command)
                        .contains("rm", "--force", FakeRunner.CONTAINER));
                assertThat(runner.commands).noneMatch(command -> command.size() > 1 && command.get(1).equals("start"));
            } finally {
                runner.finishCreate.countDown();
                execution.get(5, TimeUnit.SECONDS);
                if (cancelThread != null) cancelThread.join(5_000);
            }
        }
    }

    private static void awaitWaiting(Thread thread) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (thread.getState() != Thread.State.TIMED_WAITING && System.nanoTime() < deadline) {
            if (!thread.isAlive()) throw new AssertionError("cancel returned before entering its wait");
            Thread.yield();
        }
        assertThat(thread.getState()).isEqualTo(Thread.State.TIMED_WAITING);
    }

    @Test
    void failedCleanupOrMalformedWorkerIdentityCannotProduceSuccess() throws Exception {
        FakeRunner failedCleanup = new FakeRunner();
        failedCleanup.failRemove = true;
        try (Context context = context("cleanup", failedCleanup)) {
            assertThat(context.supervisor().execute(id(0), PROFILE, "en-US", INPUT_SHA,
                    WAV.getBytes(StandardCharsets.UTF_8), 30_000).status()).isEqualTo(Status.UNKNOWN_OUTCOME);
            assertThat(context.supervisor().status(id(0), PROFILE, "en-US", INPUT_SHA).status())
                    .isEqualTo(Status.UNKNOWN_OUTCOME);
            assertThat(context.supervisor().execute(id(1), PROFILE, "en-US", INPUT_SHA,
                    WAV.getBytes(StandardCharsets.UTF_8), 30_000).status()).isEqualTo(Status.RESOURCE_EXHAUSTED);
            assertThat(failedCleanup.commands.stream().filter(command -> command.get(1).equals("create")))
                    .hasSize(1);
        }

        FakeRunner wrongIdentity = new FakeRunner();
        wrongIdentity.wrongInput = true;
        try (Context context = context("bad-result", wrongIdentity)) {
            assertThat(context.supervisor().execute(id(0), PROFILE, "en-US", INPUT_SHA,
                    WAV.getBytes(StandardCharsets.UTF_8), 30_000).status()).isEqualTo(Status.UNKNOWN_OUTCOME);
            assertThat(context.journal().lookup(id(0)).status())
                    .isEqualTo(MediaOciBrokerWhisperJournal.Status.UNKNOWN_OUTCOME);
        }
    }

    private static UUID id(int suffix) {
        return UUID.fromString("123e4567-e89b-12d3-a456-42661417400" + suffix);
    }

    private static String digest(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (Exception impossible) { throw new IllegalStateException(impossible); }
    }

    private record Context(WhisperWorkerServerConfig config,
            MediaOciBrokerWhisperJournal journal, WhisperOciWorkerSupervisor supervisor) implements AutoCloseable {
        @Override public void close() throws IOException { journal.close(); }
    }

    private static final class FakeRunner implements WhisperOciWorkerSupervisor.CommandRunner {
        private static final String CONTAINER = "c".repeat(64);
        private final List<List<String>> commands = new java.util.concurrent.CopyOnWriteArrayList<>();
        private final CountDownLatch createEntered = new CountDownLatch(1);
        private final CountDownLatch finishCreate = new CountDownLatch(1);
        private final CountDownLatch startEntered = new CountDownLatch(1);
        private final CountDownLatch finishStart = new CountDownLatch(1);
        private final CountDownLatch imageInspectEntered = new CountDownLatch(1);
        private final CountDownLatch finishImageInspect = new CountDownLatch(1);
        private final AtomicBoolean releaseOnKill = new AtomicBoolean(true);
        private volatile boolean blockCreate;
        private volatile boolean blockStart;
        private volatile boolean blockImageInspect;
        private volatile boolean startTimedOut;
        private volatile boolean failRemove;
        private volatile boolean wrongInput;
        private volatile boolean imageMissing;
        private volatile boolean failList;
        private volatile AtomicLong advanceClock;
        private volatile long advanceOnImageInspectNanos;
        private volatile long advanceOnInspectNanos;
        private volatile long advanceOnRemoveNanos;
        private volatile String orphanIds = "";
        private volatile byte[] lastStdin;

        @Override
        public WhisperOciWorkerSupervisor.CommandResult run(List<String> command, byte[] stdin,
                Duration timeout, int stdoutLimit, int stderrLimit) throws IOException {
            commands.add(List.copyOf(command));
            if (stdin != null) lastStdin = stdin.clone();
            String op = command.size() > 1 ? command.get(1) : "";
            if (op.equals("image") && advanceClock != null) advanceClock.addAndGet(advanceOnImageInspectNanos);
            if (op.equals("inspect") && advanceClock != null) advanceClock.addAndGet(advanceOnInspectNanos);
            if (op.equals("rm") && advanceClock != null) advanceClock.addAndGet(advanceOnRemoveNanos);
            if (op.equals("image") && blockImageInspect) {
                imageInspectEntered.countDown();
                try {
                    if (!finishImageInspect.await(10, TimeUnit.SECONDS)) {
                        return new WhisperOciWorkerSupervisor.CommandResult(-1,
                                new byte[0], new byte[0], true, false);
                    }
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return new WhisperOciWorkerSupervisor.CommandResult(-1,
                            new byte[0], new byte[0], true, false);
                }
            }
            return switch (op) {
                case "image" -> imageMissing
                        ? new WhisperOciWorkerSupervisor.CommandResult(1, new byte[0], bytes("missing"), false, false)
                        : ok("sha256:" + "d".repeat(64) + "|[\"" + IMAGE + "\"]");
                case "ps" -> failList ? new WhisperOciWorkerSupervisor.CommandResult(1,
                        new byte[0], bytes("docker unavailable"), false, false) : ok(orphanIds);
                case "create" -> create();
                case "start" -> start(stdin);
                case "inspect" -> ok("false\n");
                case "kill" -> {
                    if (releaseOnKill.get()) finishStart.countDown();
                    yield ok("");
                }
                case "rm" -> failRemove ? new WhisperOciWorkerSupervisor.CommandResult(1,
                        bytes("not removed"), bytes("failure"), false, false) : ok("");
                default -> throw new IOException("Unexpected fake command: " + command);
            };
        }

        private WhisperOciWorkerSupervisor.CommandResult create() throws IOException {
            createEntered.countDown();
            if (blockCreate) {
                try {
                    if (!finishCreate.await(10, TimeUnit.SECONDS)) return new WhisperOciWorkerSupervisor.CommandResult(
                            -1, new byte[0], new byte[0], true, false);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return new WhisperOciWorkerSupervisor.CommandResult(-1, new byte[0], new byte[0], true, false);
                }
            }
            return ok(CONTAINER + "\n");
        }

        private WhisperOciWorkerSupervisor.CommandResult start(byte[] stdin) throws IOException {
            startEntered.countDown();
            if (blockStart) {
                try {
                    if (!finishStart.await(10, TimeUnit.SECONDS)) return new WhisperOciWorkerSupervisor.CommandResult(
                            -1, new byte[0], new byte[0], true, false);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return new WhisperOciWorkerSupervisor.CommandResult(-1, new byte[0], new byte[0], true, false);
                }
            }
            if (startTimedOut) return new WhisperOciWorkerSupervisor.CommandResult(-1,
                    new byte[0], new byte[0], true, false);
            return ok(workerResponse(stdin, wrongInput));
        }

        private static String workerResponse(byte[] input, boolean wrongInput) throws IOException {
            try {
                var request = JSON.readTree(input);
                ObjectNode response = JSON.createObjectNode();
                response.put("invocationId", request.get("invocationId").asText());
                response.put("profileId", request.get("profileId").asText());
                response.put("inputSha256", wrongInput ? "0".repeat(64) : request.get("sourceSha256").asText());
                response.put("modelSha256", digest(ASSETS.get("encoder_model_quantized.onnx")));
                response.put("transcript", TRANSCRIPT);
                response.put("status", "SUCCESS");
                response.put("complete", true);
                response.put("endOfTask", true);
                response.put("tokenLimitReached", false);
                return JSON.writeValueAsString(response);
            } catch (Exception invalid) { throw new IOException(invalid); }
        }

        private static WhisperOciWorkerSupervisor.CommandResult ok(String stdout) {
            return new WhisperOciWorkerSupervisor.CommandResult(0, bytes(stdout), new byte[0], false, false);
        }
    }
}
