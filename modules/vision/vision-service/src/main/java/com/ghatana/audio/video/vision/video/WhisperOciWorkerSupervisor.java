package com.ghatana.audio.video.vision.video;

import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;
import com.ghatana.media.runtime.WhisperComputeContracts;
import com.ghatana.media.runtime.WhisperComputeContracts.Result;
import com.ghatana.media.runtime.WhisperComputeContracts.Status;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.LongSupplier;

/** One fixed OCI Whisper worker at a time; no caller-supplied command or mount authority. */
final class WhisperOciWorkerSupervisor {
    private static final long MEMORY_BYTES = 1_610_612_736L;
    private static final int PID_LIMIT = 32;
    private static final int FD_LIMIT = 64;
    private static final int MAX_STDERR_BYTES = 8192;
    private static final int MAX_COMMAND_CHILDREN = 128;
    private static final Duration COMMAND_CLEANUP_BUDGET = Duration.ofSeconds(2);
    private static final int MAX_WORKER_OUTPUT_BYTES = 1_048_576;
    private static final Duration CREATE_TIMEOUT = Duration.ofSeconds(15);
    private static final Duration CONTROL_TIMEOUT = Duration.ofSeconds(5);
    private static final String WORKER = "com.ghatana.stt.provider.WhisperComputeWorkerMain";
    private static final ObjectMapper JSON = new ObjectMapper(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build());

    private final String docker;
    private final long workerUid;
    private final long workerGid;
    private final WhisperWorkerServerConfig config;
    private final MediaOciBrokerWhisperJournal journal;
    private final CommandRunner runner;
    private final LongSupplier monotonicClock;
    private final String brokerInstanceLabel;
    private final java.util.concurrent.Semaphore oneWorker = new java.util.concurrent.Semaphore(1);
    private final Object dispatchLock = new Object();
    private final Object registryLock = new Object();
    private final ConcurrentHashMap<UUID, Active> active = new ConcurrentHashMap<>();
    private volatile boolean closed;

    static Startup start(String docker, long workerUid, long workerGid,
            WhisperWorkerServerConfig config, String brokerSecret, CommandRunner runner) {
        if (!cleanupOrphans(docker, config, runner)) return new Startup(null, null);
        MediaOciBrokerWhisperJournal journal = null;
        try {
            journal = MediaOciBrokerWhisperJournal.open(config.journalDirectory(), brokerSecret);
            WhisperOciWorkerSupervisor supervisor = new WhisperOciWorkerSupervisor(
                    docker, workerUid, workerGid, config, journal, runner);
            return new Startup(supervisor, journal);
        } catch (IOException | RuntimeException unavailable) {
            if (journal != null) {
                try { journal.close(); } catch (IOException ignored) { }
            }
            return new Startup(null, null);
        }
    }

    record Startup(WhisperOciWorkerSupervisor supervisor, MediaOciBrokerWhisperJournal journal) {
        boolean admitted() { return supervisor != null && journal != null; }
    }

    WhisperOciWorkerSupervisor(String docker, long workerUid, long workerGid,
            WhisperWorkerServerConfig config, MediaOciBrokerWhisperJournal journal) {
        this(docker, workerUid, workerGid, config, journal, new ProcessBuilderCommandRunner());
    }

    WhisperOciWorkerSupervisor(String docker, long workerUid, long workerGid,
            WhisperWorkerServerConfig config, MediaOciBrokerWhisperJournal journal,
            CommandRunner runner) {
        this(docker, workerUid, workerGid, config, journal, runner, System::nanoTime);
    }

    WhisperOciWorkerSupervisor(String docker, long workerUid, long workerGid,
            WhisperWorkerServerConfig config, MediaOciBrokerWhisperJournal journal,
            CommandRunner runner, LongSupplier monotonicClock) {
        if (docker == null || docker.isBlank() || docker.chars().anyMatch(Character::isWhitespace)) {
            throw new IllegalArgumentException("A single trusted OCI CLI executable is required");
        }
        if (workerUid <= 0 || workerGid < 0 || workerUid > Integer.MAX_VALUE || workerGid > Integer.MAX_VALUE) {
            throw new IllegalArgumentException("Unprivileged server-owned worker identity is required");
        }
        this.docker = docker;
        this.workerUid = workerUid;
        this.workerGid = workerGid;
        this.config = java.util.Objects.requireNonNull(config, "config");
        this.journal = java.util.Objects.requireNonNull(journal, "journal");
        this.runner = java.util.Objects.requireNonNull(runner, "runner");
        this.monotonicClock = java.util.Objects.requireNonNull(monotonicClock, "monotonicClock");
        this.brokerInstanceLabel = labelForJournal(config.journalDirectory());
    }

    Result execute(UUID invocationId, String profileId, String locale, String sourceSha256,
            byte[] wav, long budgetMillis) {
        long entryNanos = monotonicClock.getAsLong();
        IdentityRequest request;
        try {
            request = validateRequest(invocationId, profileId, locale, sourceSha256, wav, budgetMillis);
        } catch (RuntimeException invalid) {
            return result(invocationId, safeProfile(profileId), safeDigest(sourceSha256),
                    Status.INVALID_REQUEST);
        }
        long deadline = entryNanos + TimeUnit.MILLISECONDS.toNanos(budgetMillis);

        Active operation = new Active(request.identity());
        Active prior;
        synchronized (registryLock) {
            if (closed) return result(invocationId, profileId, sourceSha256, Status.NOT_ADMITTED);
            prior = active.putIfAbsent(invocationId, operation);
        }
        if (prior != null) {
            if (!prior.identity().equals(request.identity())) {
                return result(invocationId, profileId, sourceSha256, Status.INVALID_REQUEST);
            }
            return prior.successResult != null ? prior.successResult
                    : result(invocationId, profileId, sourceSha256, Status.UNKNOWN_OUTCOME);
        }

        boolean acquired = false;
        boolean startExecution = false;
        try {
            synchronized (dispatchLock) {
                if (closed || operation.cancelled.get()) {
                    return result(invocationId, profileId, sourceSha256, Status.NOT_ADMITTED);
                }
                MediaOciBrokerWhisperJournal.Entry old = journal.lookup(invocationId);
                if (old != null) return existingResult(old, request.identity());
                if (operation.cancelled.get()) {
                    return result(invocationId, profileId, sourceSha256, Status.NOT_ADMITTED);
                }
                if (!oneWorker.tryAcquire()) {
                    return result(invocationId, profileId, sourceSha256, Status.RESOURCE_EXHAUSTED);
                }
                acquired = true;
                if (operation.cancelled.get()) {
                    return result(invocationId, profileId, sourceSha256, Status.NOT_ADMITTED);
                }
                boolean preflight = workerPreflight(deadline);
                if (operation.cancelled.get()) {
                    return result(invocationId, profileId, sourceSha256, Status.NOT_ADMITTED);
                }
                if (deadlineExpired(deadline)) {
                    // No journal STARTED record or container exists yet, so this is provably pre-dispatch.
                    return result(invocationId, profileId, sourceSha256, Status.DEADLINE_EXCEEDED);
                }
                if (!preflight) {
                    return result(invocationId, profileId, sourceSha256, Status.NOT_ADMITTED);
                }
                if (deadlineExpired(deadline)) {
                    return result(invocationId, profileId, sourceSha256, Status.DEADLINE_EXCEEDED);
                }
                MediaOciBrokerWhisperJournal.BeginResult reserved;
                synchronized (operation) {
                    // Cancellation and durable dispatch share one linearization point. If cancel
                    // wins during preflight, no STARTED record or container may be created.
                    if (operation.cancelled.get()) {
                        return result(invocationId, profileId, sourceSha256, Status.NOT_ADMITTED);
                    }
                    reserved = journal.begin(request.identity());
                    if (reserved.kind() == MediaOciBrokerWhisperJournal.BeginKind.RESERVED) {
                        operation.dispatchStarted = true;
                        startExecution = true;
                    }
                }
                if (reserved.kind() == MediaOciBrokerWhisperJournal.BeginKind.CAPACITY) {
                    return result(invocationId, profileId, sourceSha256, Status.RESOURCE_EXHAUSTED);
                }
                if (reserved.kind() == MediaOciBrokerWhisperJournal.BeginKind.IDENTITY_CONFLICT) {
                    return result(invocationId, profileId, sourceSha256, Status.INVALID_REQUEST);
                }
                if (reserved.kind() == MediaOciBrokerWhisperJournal.BeginKind.EXISTING) {
                    return existingResult(reserved.entry(), request.identity());
                }
            }
        } catch (IOException journalFailure) {
            return result(invocationId, profileId, sourceSha256, Status.NOT_ADMITTED);
        } finally {
            if (!startExecution) {
                if (acquired) oneWorker.release();
                active.remove(invocationId, operation);
                operation.finished.countDown();
            }
        }

        Result response = result(invocationId, profileId, sourceSha256, Status.UNKNOWN_OUTCOME);
        String containerId = null;
        boolean cleanupConfirmed = false;
        boolean createAttempted = false;
        try {
            List<String> create = createCommand(config, docker, operation.identity().invocationId().toString(),
                    workerUid, workerGid);
            createAttempted = true;
            CommandResult created = runner.run(create, null,
                    bounded(CREATE_TIMEOUT, deadline, monotonicClock), 8192, MAX_STDERR_BYTES);
            if (created.timedOut() || created.exitCode() != 0 || created.outputExceeded()
                    || !created.cleanupConfirmed()) {
                cleanupConfirmed = removeByName(operation.identity().invocationId().toString());
                markUnknownQuietly(operation.identity());
                return response;
            }
            containerId = stdoutText(created).trim();
            if (!containerId.matches("[a-f0-9]{64}")) {
                cleanupConfirmed = removeByName(operation.identity().invocationId().toString());
                markUnknownQuietly(operation.identity());
                return response;
            }
            operation.containerId = containerId;
            if (operation.cancelled.get()) {
                cleanupConfirmed = killAndRemove(containerId);
                markUnknownQuietly(operation.identity());
                return response;
            }

            Duration remaining = remaining(deadline, monotonicClock);
            byte[] workerInput = workerRequest(operation.identity(), wav, Math.max(1, remaining.toMillis()));
            CommandResult started = runner.run(List.of(docker, "start", "--attach", "--interactive", containerId),
                    workerInput, remaining, MAX_WORKER_OUTPUT_BYTES, MAX_STDERR_BYTES);
            if (started.timedOut() || operation.cancelled.get() || started.outputExceeded()
                    || !started.cleanupConfirmed()
                    || started.exitCode() != 0) {
                kill(containerId);
                cleanupConfirmed = remove(containerId);
                markUnknownQuietly(operation.identity());
                return response;
            }

            boolean oomKilled = inspectOomKilled(containerId);
            cleanupConfirmed = remove(containerId);
            if (!cleanupConfirmed || oomKilled || operation.cancelled.get()) {
                markUnknownQuietly(operation.identity());
                return response;
            }
            Result workerResult = parseWorkerResult(started.stdout(), operation.identity());
            if (workerResult.status() != Status.SUCCESS) {
                markUnknownQuietly(operation.identity());
                return response;
            }
            synchronized (operation) {
                if (operation.cancelled.get() || deadlineExpired(deadline)) {
                    // The worker has already run; a late commit is ambiguous and stays UNKNOWN.
                    markUnknownQuietly(operation.identity());
                    return response;
                }
                MediaOciBrokerWhisperJournal.Entry saved = journal.completeSuccess(operation.identity(),
                        workerResult.modelSha256(), workerResult.transcript());
                operation.successResult = toResult(saved);
                response = operation.successResult;
                return response;
            }
        } catch (Exception uncertain) {
            if (containerId != null) {
                kill(containerId);
                cleanupConfirmed = remove(containerId);
            }
            markUnknownQuietly(operation.identity());
            return response;
        } finally {
            if (containerId != null && !cleanupConfirmed) {
                // A failed cleanup is never allowed to produce or preserve SUCCESS.
                kill(containerId);
                cleanupConfirmed = remove(containerId);
                markUnknownQuietly(operation.identity());
            }
            if (containerId == null && createAttempted && !cleanupConfirmed) {
                // A timed-out/ambiguous create may have left a named container behind.
                cleanupConfirmed = removeByName(operation.identity().invocationId().toString());
                markUnknownQuietly(operation.identity());
            }
            active.remove(invocationId, operation);
            operation.finished.countDown();
            // Do not admit another worker while this one may still be consuming host
            // resources. A daemon restart can release the slot only after orphan sweep.
            if (!createAttempted || cleanupConfirmed || operation.cleanupConfirmed) oneWorker.release();
        }
    }

    Result status(UUID invocationId, String profileId, String locale, String sourceSha256) {
        IdentityRequest identity;
        try {
            identity = validateIdentity(invocationId, profileId, locale, sourceSha256);
            MediaOciBrokerWhisperJournal.Entry entry = journal.lookup(invocationId);
            if (entry == null) return result(invocationId, profileId, sourceSha256, Status.NOT_ADMITTED);
            return existingResult(entry, identity.identity());
        } catch (RuntimeException invalid) {
            return result(invocationId, safeProfile(profileId), safeDigest(sourceSha256), Status.INVALID_REQUEST);
        } catch (IOException failure) {
            return result(invocationId, safeProfile(profileId), safeDigest(sourceSha256), Status.NOT_ADMITTED);
        }
    }

    Result cancel(UUID invocationId, String profileId, String locale, String sourceSha256) {
        IdentityRequest identity;
        try {
            identity = validateIdentity(invocationId, profileId, locale, sourceSha256);
        } catch (RuntimeException invalid) {
            return result(invocationId, safeProfile(profileId), safeDigest(sourceSha256), Status.INVALID_REQUEST);
        }
        Active operation = active.get(invocationId);
        if (operation == null) return status(invocationId, profileId, locale, sourceSha256);
        if (!operation.identity().equals(identity.identity())) {
            return result(invocationId, profileId, sourceSha256, Status.INVALID_REQUEST);
        }
        boolean preDispatch;
        synchronized (operation) {
            if (operation.successResult != null) return operation.successResult;
            MediaOciBrokerWhisperJournal.Entry persisted = journal.lookupSnapshot(invocationId);
            if (persisted != null && (!operation.dispatchStarted
                    || persisted.status() == MediaOciBrokerWhisperJournal.Status.SUCCESS)) {
                return existingResult(persisted, identity.identity());
            }
            operation.cancelled.set(true);
            preDispatch = !operation.dispatchStarted;
        }
        if (preDispatch) {
            // The flag and execute's journal.begin are fenced by the same monitor, so once
            // this branch wins the invocation cannot cross into provider dispatch. Return
            // without acquiring dispatchLock or waiting for another invocation to release it.
            return result(invocationId, profileId, sourceSha256, Status.NOT_ADMITTED);
        }
        String containerId = operation.containerId;
        if (containerId != null) {
            kill(containerId);
            if (remove(containerId)) operation.cleanupConfirmed = true;
        }
        try {
            operation.finished.await(CONTROL_TIMEOUT.toMillis() + 10_000, TimeUnit.MILLISECONDS);
            journal.markUnknown(operation.identity());
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        } catch (IOException ignored) { }
        return result(invocationId, profileId, sourceSha256, Status.UNKNOWN_OUTCOME);
    }

    void close() throws IOException {
        List<Active> snapshot;
        synchronized (dispatchLock) {
            synchronized (registryLock) {
                closed = true;
                snapshot = List.copyOf(active.values());
            }
        }
        for (Active operation : snapshot) {
            var identity = operation.identity();
            cancel(identity.invocationId(), identity.profileId(), identity.locale(), identity.inputSha256());
        }
        for (Active operation : snapshot) {
            try {
                if (!operation.finished.await(CONTROL_TIMEOUT.toMillis() + 10_000, TimeUnit.MILLISECONDS)) {
                    throw new IOException("Whisper worker invocation did not leave its pending state");
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IOException("Interrupted while waiting for Whisper worker shutdown", interrupted);
            }
        }
        if (!active.isEmpty()) throw new IOException("Whisper worker did not stop during broker shutdown");
        if (!cleanupOrphans()) throw new IOException("Whisper worker orphan cleanup was not confirmed");
    }

    private Result existingResult(MediaOciBrokerWhisperJournal.Entry entry,
            MediaOciBrokerWhisperJournal.Identity requestIdentity) {
        if (!entry.identity().equals(requestIdentity)) {
            return result(requestIdentity.invocationId(), requestIdentity.profileId(),
                    requestIdentity.inputSha256(), Status.INVALID_REQUEST);
        }
        return switch (entry.status()) {
            case STARTED, UNKNOWN_OUTCOME -> result(requestIdentity.invocationId(), requestIdentity.profileId(),
                    requestIdentity.inputSha256(), Status.UNKNOWN_OUTCOME);
            case SUCCESS -> toResult(entry);
        };
    }

    private static Result toResult(MediaOciBrokerWhisperJournal.Entry entry) {
        return new Result(entry.identity().invocationId(), entry.identity().profileId(),
                entry.identity().inputSha256(), entry.modelSha256(), entry.transcript(), Status.SUCCESS,
                true, true, false);
    }

    private IdentityRequest validateRequest(UUID id, String profile, String locale, String digest,
            byte[] wav, long budget) {
        IdentityRequest identity = validateIdentity(id, profile, locale, digest);
        if (wav == null || wav.length == 0 || wav.length > WhisperComputeContracts.MAX_WAV_BYTES
                || budget < 1 || budget > WhisperComputeContracts.MAX_REMAINING_BUDGET_MILLIS
                || !MediaOciBrokerPolicy.whisperInputAllowed(wav, digest)
                || !config.profileId().equals(profile) || !config.locales().contains(locale)) {
            throw new IllegalArgumentException("Whisper request is outside its pinned server profile");
        }
        return identity;
    }

    private IdentityRequest validateIdentity(UUID id, String profile, String locale, String digest) {
        if (id == null || profile == null || !config.profileId().equals(profile)
                || locale == null || !config.locales().contains(locale)
                || digest == null || !digest.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("Whisper request identity does not match the server profile");
        }
        return new IdentityRequest(new MediaOciBrokerWhisperJournal.Identity(id, profile, locale, digest));
    }

    private Result parseWorkerResult(byte[] bytes, MediaOciBrokerWhisperJournal.Identity identity) throws IOException {
        if (bytes == null || bytes.length == 0 || bytes.length > MAX_WORKER_OUTPUT_BYTES) {
            throw new IOException("Whisper worker output is outside its bound");
        }
        try {
            JsonNode node = JSON.readTree(bytes);
            Set<String> allowed = Set.of("invocationId", "profileId", "inputSha256", "modelSha256", "transcript",
                    "status", "complete", "endOfTask", "tokenLimitReached");
            if (node == null || !node.isObject() || node.size() != allowed.size()) throw new IOException("Malformed worker result");
            for (String field : allowed) {
                if (!node.has(field)) throw new IOException("Missing worker result field");
            }
            if (!node.get("invocationId").isTextual() || !node.get("profileId").isTextual()
                    || !node.get("inputSha256").isTextual() || !node.get("transcript").isTextual()
                    || !node.get("status").isTextual() || !node.get("complete").isBoolean()
                    || !node.get("endOfTask").isBoolean() || !node.get("tokenLimitReached").isBoolean()
                    || node.has("modelSha256") && !node.get("modelSha256").isTextual()
                    && !node.get("modelSha256").isNull()) {
                throw new IOException("Whisper worker result types are invalid");
            }
            if (!node.get("invocationId").asText().equals(identity.invocationId().toString())
                    || !node.get("profileId").asText().equals(identity.profileId())
                    || !node.get("inputSha256").asText().equals(identity.inputSha256())) {
                throw new IOException("Whisper worker result identity mismatch");
            }
            Status status = Status.valueOf(node.get("status").asText());
            String modelSha = nullableText(node.get("modelSha256"));
            String transcript = node.get("transcript").asText();
            boolean complete = node.get("complete").asBoolean();
            boolean end = node.get("endOfTask").asBoolean();
            boolean tokenLimit = node.get("tokenLimitReached").asBoolean();
            Result result = new Result(identity.invocationId(), identity.profileId(), identity.inputSha256(),
                    modelSha, transcript, status, complete, end, tokenLimit);
            if (result.status() == Status.SUCCESS && (!config.modelSha256().equals(result.modelSha256())
                    || transcript.length() > WhisperComputeContracts.MAX_TRANSCRIPT_CHARS)) {
                throw new IOException("Whisper worker result does not match the pinned model");
            }
            return result;
        } catch (IOException invalid) {
            throw invalid;
        } catch (Exception invalid) {
            throw new IOException("Whisper worker returned an invalid typed result", invalid);
        }
    }

    private boolean inspectOomKilled(String containerId) throws IOException {
        CommandResult inspected = runner.run(List.of(docker, "inspect", "--format", "{{.State.OOMKilled}}", containerId),
                null, CONTROL_TIMEOUT, 16, 256);
        if (inspected.timedOut() || inspected.exitCode() != 0 || inspected.outputExceeded()
                || !inspected.cleanupConfirmed()) {
            throw new IOException("Could not confirm Whisper worker OOM state");
        }
        return switch (stdoutText(inspected).trim()) {
            case "true" -> true;
            case "false" -> false;
            default -> throw new IOException("Whisper worker OOM state is malformed");
        };
    }

    private boolean workerPreflight(long deadline) {
        try {
            remaining(deadline, monotonicClock);
            WhisperWorkerServerConfig.validateModelRoot(config.modelRoot(),
                    config.modelSha256(), config.bundleSha256());
            Duration imageBudget = bounded(CREATE_TIMEOUT, deadline, monotonicClock);
            boolean localImageId = config.imageDigest().matches("sha256:[0-9a-f]{64}");
            String inspectFormat = localImageId
                    ? "{{.Id}}" : "{{.Id}}|{{json .RepoDigests}}";
            CommandResult image = runner.run(List.of(docker, "image", "inspect", "--format",
                    inspectFormat, config.imageDigest()),
                    null, imageBudget, 4096, 1024);
            if (image.timedOut() || image.exitCode() != 0 || image.outputExceeded()
                    || !image.cleanupConfirmed()) return false;
            String inspected = stdoutText(image).trim();
            if (localImageId) {
                return config.imageDigest().equals(inspected);
            }
            String[] pins = inspected.split("\\|", 2);
            if (pins.length != 2) return false;
            JsonNode repoDigests = JSON.readTree(pins[1]);
            if (!pins[0].matches("sha256:[0-9a-f]{64}") || !repoDigests.isArray()) return false;
            for (JsonNode repoDigest : repoDigests) {
                if (!repoDigest.isTextual()) return false;
                if (config.imageDigest().equals(repoDigest.asText())) return true;
            }
            return false;
        } catch (IOException unavailable) { return false; }
    }

    /** Remove only containers bearing this journal's stable broker-instance label. */
    boolean cleanupOrphans() {
        return cleanupOrphans(docker, config, runner);
    }

    /**
     * Remove labeled containers before opening/recovering the journal. The label is
     * derived only from the validated server-owned journal directory; this lets a
     * corrupt journal fail closed without leaving a previous worker alive.
     */
    static boolean cleanupOrphans(String docker, WhisperWorkerServerConfig config, CommandRunner runner) {
        if (docker == null || docker.isBlank() || docker.chars().anyMatch(Character::isWhitespace)
                || config == null || runner == null) return false;
        String brokerInstance = labelForJournal(config.journalDirectory());
        try {
            CommandResult listed = runner.run(List.of(docker, "ps", "--all", "--quiet",
                    "--filter", "label=com.ghatana.media.whisper.worker=true",
                    "--filter", "label=com.ghatana.media.oci.broker-instance=" + brokerInstance),
                    null, CONTROL_TIMEOUT, 64 * 1024, 2048);
            if (listed.timedOut() || listed.exitCode() != 0 || listed.outputExceeded()
                    || !listed.cleanupConfirmed()) return false;
            String output = stdoutText(listed).trim();
            if (output.isEmpty()) return true;
            for (String containerId : output.split("\\R")) {
                if (!containerId.matches("[a-f0-9]{64}")
                        || !remove(docker, runner, containerId)) return false;
            }
            return true;
        } catch (IOException unavailable) { return false; }
    }

    private boolean killAndRemove(String id) {
        kill(id);
        return remove(id);
    }

    private void kill(String id) {
        try {
            runner.run(List.of(docker, "kill", "--signal=KILL", id), null,
                    CONTROL_TIMEOUT, 256, 256);
        } catch (IOException ignored) { }
    }

    private boolean remove(String id) {
        return remove(docker, runner, id);
    }

    private static boolean remove(String docker, CommandRunner runner, String id) {
        try {
            CommandResult result = runner.run(List.of(docker, "rm", "--force", id), null,
                    CONTROL_TIMEOUT, 256, 256);
            return removeConfirmed(result);
        } catch (IOException failure) { return false; }
    }

    private boolean removeByName(String invocationId) {
        try {
            CommandResult result = runner.run(List.of(docker, "rm", "--force", name(invocationId)), null,
                    CONTROL_TIMEOUT, 256, 256);
            return removeConfirmed(result);
        } catch (IOException ignored) { return false; }
    }

    private void markUnknownQuietly(MediaOciBrokerWhisperJournal.Identity identity) {
        try { journal.markUnknown(identity); } catch (IOException ignored) { }
    }

    private static List<String> createCommand(WhisperWorkerServerConfig config, String docker,
            String invocationId, long uid, long gid) {
        if (docker == null || docker.isBlank() || !invocationId.matches("[a-f0-9-]{36}")) {
            throw new IllegalArgumentException("Invalid trusted worker launch input");
        }
        Path modelRoot = config.modelRoot();
        List<String> command = new ArrayList<>(List.of(docker, "create", "--name", name(invocationId),
                "--pull=never", "--platform=linux/arm64", "--label", "com.ghatana.media.whisper.worker=true",
                "--label", "com.ghatana.media.oci.broker-instance=" + labelForJournal(config.journalDirectory()),
                "--memory=" + MEMORY_BYTES, "--memory-swap=" + MEMORY_BYTES, "--cpus=2",
                "--pids-limit=" + PID_LIMIT, "--ulimit=nofile=" + FD_LIMIT + ":" + FD_LIMIT,
                "--network=none", "--read-only", "--cap-drop=ALL",
                "--security-opt=no-new-privileges:true", "--init", "--stop-timeout=2", "--interactive",
                "--tmpfs", "/tmp:rw,nosuid,nodev,exec,size=128m,nr_inodes=4096",
                "--user=" + uid + ":" + gid, "--workdir=/tmp",
                "--env=HOME=/tmp", "--env=TMPDIR=/tmp",
                "--env=MEDIA_WHISPER_WORKER_PROFILE_ID=" + config.profileId(),
                "--env=MEDIA_WHISPER_WORKER_MODEL_REVISION=" + config.modelRevision(),
                "--env=MEDIA_WHISPER_WORKER_MODEL_SHA256=" + config.modelSha256(),
                "--env=MEDIA_WHISPER_WORKER_MODEL_PATH=/models/encoder_model_quantized.onnx",
                "--mount", "type=bind,source=" + modelRoot + ",target=/models,readonly",
                config.imageDigest()));
        return List.copyOf(command);
    }

    static List<String> commandForTest(WhisperWorkerServerConfig config, String docker,
            String invocationId, long uid, long gid) {
        return createCommand(config, docker, invocationId, uid, gid);
    }

    private static byte[] workerRequest(MediaOciBrokerWhisperJournal.Identity identity, byte[] wav,
            long budgetMillis) throws IOException {
        ObjectNode request = JSON.createObjectNode();
        request.put("invocationId", identity.invocationId().toString());
        request.put("profileId", identity.profileId());
        request.put("locale", identity.locale());
        request.put("sourceSha256", identity.inputSha256());
        request.put("wavBase64", Base64.getEncoder().encodeToString(wav));
        request.put("remainingBudgetMillis", budgetMillis);
        byte[] bytes = JSON.writeValueAsBytes(request);
        if (bytes.length > WhisperComputeBrokerClientBound.MAX_REQUEST_BYTES) {
            throw new IOException("Whisper worker input exceeds its fixed bound");
        }
        return bytes;
    }

    private static boolean removeConfirmed(CommandResult result) {
        return result != null && !result.timedOut() && result.exitCode() == 0
                && !result.outputExceeded() && result.cleanupConfirmed();
    }

    private static Duration bounded(Duration maximum, long deadline, LongSupplier monotonicClock) throws IOException {
        long nanos = deadline - monotonicClock.getAsLong();
        if (nanos <= 0) throw new IOException("Whisper invocation deadline expired before launch");
        Duration remaining = Duration.ofNanos(nanos);
        return remaining.compareTo(maximum) < 0 ? remaining : maximum;
    }

    private static Duration remaining(long deadline, LongSupplier monotonicClock) throws IOException {
        long nanos = deadline - monotonicClock.getAsLong();
        if (nanos <= 0) throw new IOException("Whisper invocation deadline expired");
        return Duration.ofNanos(nanos);
    }

    private boolean deadlineExpired(long deadline) {
        return deadline - monotonicClock.getAsLong() <= 0;
    }

    private static Result result(UUID id, String profile, String digest, Status status) {
        return new Result(id, profile, digest, null, "", status, false, false, false);
    }

    private static String safeProfile(String profile) {
        return profile != null && profile.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}") ? profile : "invalid";
    }

    private static String safeDigest(String digest) { return digest != null && digest.matches("[0-9a-f]{64}") ? digest : "0".repeat(64); }
    private static String name(String id) { return "media-whisper-" + id.replace('-', 'x'); }
    private static String labelForJournal(Path path) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(path.toAbsolutePath().normalize()
                    .toString().getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hash, 0, 16);
        } catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    private static String nullableText(JsonNode node) { return node == null || node.isNull() ? null : node.asText(); }
    private static String stdoutText(CommandResult result) { return new String(result.stdout(), StandardCharsets.UTF_8); }

    private record IdentityRequest(MediaOciBrokerWhisperJournal.Identity identity) { }

    private static final class Active {
        private final MediaOciBrokerWhisperJournal.Identity identity;
        private final AtomicBoolean cancelled = new AtomicBoolean();
        private final CountDownLatch finished = new CountDownLatch(1);
        private boolean dispatchStarted;
        private volatile String containerId;
        private volatile Result successResult;
        private volatile boolean cleanupConfirmed;
        private Active(MediaOciBrokerWhisperJournal.Identity identity) { this.identity = identity; }
        private MediaOciBrokerWhisperJournal.Identity identity() { return identity; }
    }

    interface CommandRunner {
        CommandResult run(List<String> command, byte[] stdin, Duration timeout,
                int stdoutLimit, int stderrLimit) throws IOException;
    }

    record CommandResult(int exitCode, byte[] stdout, byte[] stderr,
            boolean timedOut, boolean outputExceeded, boolean cleanupConfirmed) {
        CommandResult(int exitCode, byte[] stdout, byte[] stderr,
                boolean timedOut, boolean outputExceeded) {
            this(exitCode, stdout, stderr, timedOut, outputExceeded, true);
        }
        CommandResult {
            stdout = stdout == null ? new byte[0] : stdout.clone();
            stderr = stderr == null ? new byte[0] : stderr.clone();
        }
        @Override public byte[] stdout() { return stdout.clone(); }
        @Override public byte[] stderr() { return stderr.clone(); }
    }

    static final class ProcessBuilderCommandRunner implements CommandRunner {
        private final int maxObservedChildren;

        ProcessBuilderCommandRunner() {
            this(MAX_COMMAND_CHILDREN);
        }

        ProcessBuilderCommandRunner(int maxObservedChildren) {
            if (maxObservedChildren < 1 || maxObservedChildren > MAX_COMMAND_CHILDREN) {
                throw new IllegalArgumentException("Command child observation bound is invalid");
            }
            this.maxObservedChildren = maxObservedChildren;
        }

        @Override
        public CommandResult run(List<String> command, byte[] stdin, Duration timeout,
                int stdoutLimit, int stderrLimit) throws IOException {
            Process process = new ProcessBuilder(command).start();
            BoundedCapture stdout = new BoundedCapture(stdoutLimit);
            BoundedCapture stderr = new BoundedCapture(stderrLimit);
            Thread stdoutThread = drainThread(process.getInputStream(), stdout, "whisper-stdout");
            Thread stderrThread = drainThread(process.getErrorStream(), stderr, "whisper-stderr");
            stdoutThread.start();
            stderrThread.start();
            AtomicBoolean stdinFailure = new AtomicBoolean();
            Thread writer = new Thread(() -> {
                try (OutputStream output = process.getOutputStream()) {
                    if (stdin != null) output.write(stdin);
                } catch (IOException failure) { stdinFailure.set(true); }
            }, "whisper-stdin");
            writer.setDaemon(true);
            writer.start();
            boolean completed;
            boolean timedOut = false;
            boolean cleanupAttempted = false;
            boolean cleanupConfirmed = true;
            boolean interrupted = false;
            long cleanupDeadline = 0;
            try {
                completed = process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS);
            } catch (InterruptedException caught) {
                completed = false;
                interrupted = true;
            }
            cleanupDeadline = System.nanoTime() + COMMAND_CLEANUP_BUDGET.toNanos();
            if (!completed) {
                timedOut = true;
                cleanupAttempted = true;
                CleanupResult cleanup = terminateProcessTree(process, cleanupDeadline, maxObservedChildren);
                cleanupConfirmed = cleanup.confirmed();
                interrupted |= cleanup.interrupted();
            }

            long joinDeadline = cleanupDeadline;
            ThreadWait writerWait = awaitThread(writer, joinDeadline);
            ThreadWait stdoutWait = awaitThread(stdoutThread, joinDeadline);
            ThreadWait stderrWait = awaitThread(stderrThread, joinDeadline);
            interrupted |= writerWait.interrupted() || stdoutWait.interrupted() || stderrWait.interrupted();
            if (writerWait.interrupted() || stdoutWait.interrupted() || stderrWait.interrupted()) {
                timedOut = true;
                if (!cleanupAttempted) {
                    cleanupAttempted = true;
                    if (System.nanoTime() < cleanupDeadline) {
                        CleanupResult cleanup = terminateProcessTree(process, cleanupDeadline, maxObservedChildren);
                        cleanupConfirmed = cleanup.confirmed();
                        interrupted |= cleanup.interrupted();
                    } else {
                        cleanupConfirmed = false;
                    }
                }
                closeQuietly(process.getInputStream());
                closeQuietly(process.getErrorStream());
                closeQuietly(process.getOutputStream());
                writerWait = awaitThread(writer, cleanupDeadline);
                stdoutWait = awaitThread(stdoutThread, cleanupDeadline);
                stderrWait = awaitThread(stderrThread, cleanupDeadline);
                interrupted |= writerWait.interrupted() || stdoutWait.interrupted() || stderrWait.interrupted();
            }

            boolean ioIncomplete = writer.isAlive() || stdoutThread.isAlive() || stderrThread.isAlive();
            if (ioIncomplete) {
                timedOut = true;
                cleanupConfirmed = false;
                if (!cleanupAttempted) {
                    cleanupAttempted = true;
                    if (System.nanoTime() < cleanupDeadline) {
                        CleanupResult cleanup = terminateProcessTree(process, cleanupDeadline, maxObservedChildren);
                        cleanupConfirmed = cleanup.confirmed();
                        interrupted |= cleanup.interrupted();
                    }
                }
                closeQuietly(process.getInputStream());
                closeQuietly(process.getErrorStream());
                closeQuietly(process.getOutputStream());
                writerWait = awaitThread(writer, cleanupDeadline);
                stdoutWait = awaitThread(stdoutThread, cleanupDeadline);
                stderrWait = awaitThread(stderrThread, cleanupDeadline);
                interrupted |= writerWait.interrupted() || stdoutWait.interrupted() || stderrWait.interrupted();
                ioIncomplete = writer.isAlive() || stdoutThread.isAlive() || stderrThread.isAlive();
                if (ioIncomplete) cleanupConfirmed = false;
            }
            if (interrupted) Thread.currentThread().interrupt();
            boolean succeeded = completed && !timedOut && !stdinFailure.get() && !ioIncomplete
                    && cleanupConfirmed && !stdout.exceeded() && !stderr.exceeded();
            return new CommandResult(succeeded ? process.exitValue() : -1,
                    stdout.bytes(), stderr.bytes(), timedOut || stdinFailure.get(),
                    stdout.exceeded() || stderr.exceeded(), cleanupConfirmed);
        }

        private static ThreadWait awaitThread(Thread thread, long deadline) {
            boolean interrupted = false;
            while (thread.isAlive()) {
                long remaining = deadline - System.nanoTime();
                if (remaining <= 0) break;
                try {
                    long millis = Math.max(1L, TimeUnit.NANOSECONDS.toMillis(remaining));
                    thread.join(millis);
                } catch (InterruptedException ignored) {
                    interrupted = true;
                    Thread.interrupted();
                }
            }
            return new ThreadWait(!thread.isAlive(), interrupted);
        }

        private static void closeQuietly(java.io.Closeable stream) {
            try { stream.close(); } catch (IOException ignored) { }
        }

        private static Thread drainThread(InputStream input, BoundedCapture capture, String name) {
            Thread thread = new Thread(() -> {
                try (input) {
                    byte[] buffer = new byte[8192];
                    int count;
                    while ((count = input.read(buffer)) != -1) capture.add(buffer, count);
                } catch (IOException ignored) { }
            }, name);
            thread.setDaemon(true);
            return thread;
        }

        /** A trusted CLI wrapper may have child processes; timeouts must stop those too. */
        private static CleanupResult terminateProcessTree(Process process, long deadline, int maxObservedChildren) {
            java.util.Set<ProcessHandle> observed = java.util.concurrent.ConcurrentHashMap.newKeySet();
            java.util.concurrent.atomic.AtomicBoolean discoveryComplete = new java.util.concurrent.atomic.AtomicBoolean(true);
            long forceDeadline = Math.min(deadline, System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(250));
            boolean interrupted = false;
            observeProcessTree(process, observed, discoveryComplete, maxObservedChildren);
            observed.forEach(WhisperOciWorkerSupervisor.ProcessBuilderCommandRunner::destroy);
            destroy(process.toHandle());
            while (System.nanoTime() < deadline) {
                observeProcessTree(process, observed, discoveryComplete, maxObservedChildren);
                boolean alive = process.isAlive();
                for (ProcessHandle handle : observed) alive |= handle.isAlive();
                if (!alive) return new CleanupResult(discoveryComplete.get(), interrupted);

                if (System.nanoTime() >= forceDeadline) {
                    observed.forEach(WhisperOciWorkerSupervisor.ProcessBuilderCommandRunner::destroyForcibly);
                    destroyForcibly(process.toHandle());
                }
                try {
                    Thread.sleep(10);
                } catch (InterruptedException ignored) {
                    // Keep cleanup within its fixed deadline; the runner restores interruption on return.
                    interrupted = true;
                    Thread.interrupted();
                }
            }
            boolean alive = process.isAlive();
            for (ProcessHandle handle : observed) alive |= handle.isAlive();
            return new CleanupResult(!alive && discoveryComplete.get(), interrupted);
        }

        private static void observeProcessTree(Process process, java.util.Set<ProcessHandle> observed,
                java.util.concurrent.atomic.AtomicBoolean discoveryComplete, int maxObservedChildren) {
            if (observed.size() >= maxObservedChildren) {
                discoveryComplete.set(false);
                return;
            }
            if (process.isAlive()) {
                observeDescendants(process.toHandle(), observed, discoveryComplete, maxObservedChildren);
                return;
            }
            // The command may exit while an observed child is still forking. Re-scan live
            // top-level observed handles until cleanup's fixed deadline.
            for (ProcessHandle handle : List.copyOf(observed)) {
                if (!handle.isAlive()) continue;
                boolean hasLiveObservedParent = handle.parent().filter(observed::contains)
                        .filter(ProcessHandle::isAlive).isPresent();
                if (!hasLiveObservedParent) observeDescendants(handle, observed, discoveryComplete,
                        maxObservedChildren);
            }
        }

        private static void observeDescendants(ProcessHandle parent, java.util.Set<ProcessHandle> observed,
                java.util.concurrent.atomic.AtomicBoolean discoveryComplete, int maxObservedChildren) {
            int remaining = maxObservedChildren - observed.size();
            if (remaining <= 0) return;
            try (var descendants = parent.descendants()) {
                List<ProcessHandle> found = descendants.limit(remaining + 1L).toList();
                if (found.size() > remaining) discoveryComplete.set(false);
                found.stream().limit(remaining).forEach(observed::add);
            } catch (RuntimeException ignored) {
                discoveryComplete.set(false);
            }
        }

        private record CleanupResult(boolean confirmed, boolean interrupted) { }
        private record ThreadWait(boolean complete, boolean interrupted) { }

        private static void destroy(ProcessHandle process) {
            try { if (process.isAlive()) process.destroy(); } catch (RuntimeException ignored) { }
        }

        private static void destroyForcibly(ProcessHandle process) {
            try { if (process.isAlive()) process.destroyForcibly(); } catch (RuntimeException ignored) { }
        }
    }

    private static final class BoundedCapture {
        private final int maximum;
        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        private boolean exceeded;
        private BoundedCapture(int maximum) { this.maximum = maximum; }
        private synchronized void add(byte[] input, int length) {
            int remaining = maximum - bytes.size();
            if (remaining > 0) bytes.write(input, 0, Math.min(remaining, length));
            if (length > remaining) exceeded = true;
        }
        private synchronized byte[] bytes() { return bytes.toByteArray(); }
        private synchronized boolean exceeded() { return exceeded; }
    }

    /** Local copy of the common client's frame ceiling without depending on client internals. */
    private static final class WhisperComputeBrokerClientBound {
        private static final int MAX_REQUEST_BYTES = 8 * 1024 * 1024;
    }
}
