package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolActionClass;
import com.ghatana.agent.framework.tools.ToolExecutionFailure;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.agent.framework.tools.ToolExecutionStatus;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.ClaimResult;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.InvocationLedger;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.LogicalAction;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.LogicalOutcome;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.RequestIdentity;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;

/**
 AT-05 durable backing: one JSON record per invocation on the local filesystem.
 *
 * <p>Claim durability comes from an atomic no-replace rename of a fully
 * written fence file; completion durability comes from a lock-file-serialized
 * read-verify-atomic-replace. Records survive process restart because state
 * lives on disk, not in memory. This is a single-node durable backing: it
 * does not provide tenant-scoped access control, classification-aware
 * encryption, retention, or multi-host replication — those remain host
 * responsibilities around this store. Replay authorization stays with
 * {@link MediaToolExecutionBinder}, which re-verifies full request identity
 * on every replay.
 *
 * <p>Corrupt or unreadable records fail closed: reads throw and claims on an
 * existing-but-unreadable record resolve to {@link ClaimResult#ALREADY_CLAIMED}
 * so the binder's readback path reports unavailability rather than dispatching.
 */
public final class FileInvocationLedger implements InvocationLedger {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final int SCHEMA_VERSION = 1;
    private static final int LOCK_STRIPE_COUNT = 64;

    private final Path directory;
    private final ReentrantLock[] stripes = new ReentrantLock[LOCK_STRIPE_COUNT];

    /**
     * @param directory durable directory for invocation records; created if
     *                  absent. Must be on a filesystem supporting atomic rename
     *                  (all supported deployments do); if atomic move is
     *                  unsupported the ledger fails closed with UNAVAILABLE.
     */
    public FileInvocationLedger(Path directory) {
        this.directory = directory.toAbsolutePath().normalize();
        for (int i = 0; i < LOCK_STRIPE_COUNT; i++) stripes[i] = new ReentrantLock();
        try {
            Files.createDirectories(this.directory);
        } catch (IOException e) {
            throw new UncheckedIOException("cannot create invocation ledger directory", e);
        }
        if (!Files.isDirectory(this.directory)) {
            throw new IllegalArgumentException("invocation ledger path is not a directory");
        }
    }

    public Path directory() { return directory; }

    @Override
    public Optional<LogicalAction> find(String invocationId) {
        Path file = recordPath(invocationId);
        if (!Files.exists(file)) return Optional.empty();
        try {
            return Optional.of(readAction(Files.readString(file)));
        } catch (IOException e) {
            throw new UncheckedIOException("invocation record unreadable", e);
        }
    }

    /**
     * Deprecated compatibility entrypoint. It may create only a new UNKNOWN
     * claim; it cannot overwrite an existing fence or inject a terminal
     * result without the compare-and-set completion protocol.
     */
    @Override
    public void record(LogicalAction action) {
        Objects.requireNonNull(action, "action");
        if (action.outcome() != LogicalOutcome.OUTCOME_UNKNOWN || action.result() != null) {
            throw new IllegalArgumentException("legacy record cannot bypass claim/complete");
        }
        if (claim(action) != ClaimResult.CLAIMED) {
            throw new IllegalStateException("exclusive invocation claim unavailable or already exists");
        }
    }

    @Override
    public ClaimResult claim(LogicalAction unknownFence) {
        Objects.requireNonNull(unknownFence, "unknownFence");
        if (unknownFence.outcome() != LogicalOutcome.OUTCOME_UNKNOWN || unknownFence.result() != null) {
            throw new IllegalArgumentException("claim requires an UNKNOWN fence without result");
        }
        Path target = recordPath(unknownFence.invocationId());
        if (Files.exists(target)) return ClaimResult.ALREADY_CLAIMED;
        try {
            atomicWrite(target, encode(unknownFence), false);
            return ClaimResult.CLAIMED;
        } catch (FileAlreadyExistsMarker exists) {
            return ClaimResult.ALREADY_CLAIMED;
        } catch (IOException | RuntimeException e) {
            // Lost or ambiguous acknowledgment: never report CLAIMED.
            return ClaimResult.UNAVAILABLE;
        }
    }

    @Override
    public boolean complete(LogicalAction terminalAction) {
        Objects.requireNonNull(terminalAction, "terminalAction");
        if (terminalAction.outcome() == LogicalOutcome.OUTCOME_UNKNOWN) {
            throw new IllegalArgumentException("complete requires a terminal action");
        }
        return withKeyLock(terminalAction.invocationId(), () -> {
            Path lockFile = lockPath(terminalAction.invocationId());
            try (FileChannel channel = FileChannel.open(lockFile,
                    StandardOpenOption.CREATE, StandardOpenOption.WRITE);
                 FileLock ignored = channel.tryLock()) {
                if (ignored == null) return false;
                Path target = recordPath(terminalAction.invocationId());
                if (!Files.exists(target)) return false;
                LogicalAction current;
                try {
                    current = readAction(Files.readString(target));
                } catch (IOException | RuntimeException corrupt) {
                    return false; // unreadable fence can never be safely replaced
                }
                if (current.outcome() != LogicalOutcome.OUTCOME_UNKNOWN
                        || current.result() != null
                        || !current.requestIdentity().equals(terminalAction.requestIdentity())) {
                    return false;
                }
                try {
                    atomicWrite(target, encode(terminalAction), true);
                    return true;
                } catch (IOException e) {
                    return false;
                }
            } catch (IOException | OverlappingFileLockException e) {
                return false;
            }
        });
    }

    // ---- filesystem primitives ----

    private <T> T withKeyLock(String invocationId, Supplier<T> supplier) {
        ReentrantLock lock = stripeFor(invocationId);
        lock.lock();
        try {
            return supplier.get();
        } finally {
            lock.unlock();
        }
    }

    private ReentrantLock stripeFor(String invocationId) {
        return stripes[Math.floorMod(invocationId.hashCode(), LOCK_STRIPE_COUNT)];
    }

    /** Marker for atomic no-replace collision; keeps claim() free of checked exceptions. */
    private static final class FileAlreadyExistsMarker extends RuntimeException {
        FileAlreadyExistsMarker(Throwable cause) { super(cause); }
    }

    private static void atomicWrite(Path target, String content, boolean replace) throws IOException {
        Path temp = Files.createTempFile(target.getParent(), ".inv-", ".tmp");
        try {
            Files.writeString(temp, content);
            try (FileChannel channel = FileChannel.open(temp, StandardOpenOption.WRITE)) {
                channel.force(true);
            }
            if (replace) {
                // Completion occurs only under the per-invocation OS file lock.
                // Never weaken the atomic replace contract on unsupported filesystems.
                Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } else {
                // ATOMIC_MOVE without REPLACE_EXISTING is NOT an exclusive claim:
                // Java permits replacing an existing target (reproduced on Linux).
                // A hard link to the fully fsynced temp file is an atomic,
                // create-if-absent directory entry; collision rejects the claim.
                // Filesystems without hard-link support fail closed.
                Files.createLink(target, temp);
                Files.delete(temp);
            }
        } catch (FileAlreadyExistsMarker marker) {
            Files.deleteIfExists(temp);
            throw marker;
        } catch (java.nio.file.FileAlreadyExistsException collision) {
            Files.deleteIfExists(temp);
            throw new FileAlreadyExistsMarker(collision);
        } catch (RuntimeException | IOException e) {
            Files.deleteIfExists(temp);
            throw e;
        }
        forceDirectory(target.getParent());
    }

    private static void forceDirectory(Path dir) {
        try (FileChannel channel = FileChannel.open(dir, StandardOpenOption.READ)) {
            channel.force(true);
        } catch (IOException | UnsupportedOperationException ignored) {
            // Directory fsync is best-effort; file content was already forced.
        }
    }

    private Path recordPath(String invocationId) {
        return directory.resolve(fileKey(invocationId) + ".json");
    }

    private Path lockPath(String invocationId) {
        return directory.resolve(fileKey(invocationId) + ".lock");
    }

    /** Filename is the invocation-id digest: path-safe and free of caller identity. */
    private static String fileKey(String invocationId) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(invocationId.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    // ---- serialization ----

    private static String encode(LogicalAction action) {
        ObjectNode root = JSON.createObjectNode();
        root.put("schemaVersion", SCHEMA_VERSION);
        root.put("invocationId", action.invocationId());
        root.set("requestIdentity", encodeIdentity(action.requestIdentity()));
        root.put("outcome", action.outcome().name());
        if (action.result() != null) root.set("result", encodeResult(action.result()));
        else root.putNull("result");
        return root.toString();
    }

    private static LogicalAction decode(JsonNode root) {
        if (root.path("schemaVersion").asInt(-1) != SCHEMA_VERSION) {
            throw new IllegalStateException("unsupported invocation record schema");
        }
        String invocationId = requiredText(root, "invocationId");
        RequestIdentity identity = decodeIdentity(root.required("requestIdentity"));
        LogicalOutcome outcome = LogicalOutcome.valueOf(requiredText(root, "outcome"));
        JsonNode resultNode = root.get("result");
        ToolExecutionResult result = resultNode == null || resultNode.isNull()
                ? null : decodeResult(resultNode);
        return new LogicalAction(invocationId, identity, outcome, result);
    }

    private static LogicalAction readAction(String json) {
        try {
            return decode(JSON.readTree(json));
        } catch (RuntimeException e) {
            throw new IllegalStateException("invocation record corrupt", e);
        }
    }

    private static ObjectNode encodeIdentity(RequestIdentity id) {
        ObjectNode node = JSON.createObjectNode();
        node.put("toolId", id.toolId());
        if (id.toolVersion() != null) node.put("toolVersion", id.toolVersion());
        if (id.callerAgentId() != null) node.put("callerAgentId", id.callerAgentId());
        if (id.callerReleaseId() != null) node.put("callerReleaseId", id.callerReleaseId());
        if (id.tenantId() != null) node.put("tenantId", id.tenantId());
        if (id.actionClass() != null) node.put("actionClass", id.actionClass().name());
        if (id.requestSchemaVersion() != null) node.put("requestSchemaVersion", id.requestSchemaVersion());
        node.put("inputFingerprint", id.inputFingerprint());
        node.put("bound", id.bound());
        return node;
    }

    private static RequestIdentity decodeIdentity(JsonNode node) {
        ToolActionClass actionClass = node.hasNonNull("actionClass")
                ? ToolActionClass.valueOf(node.get("actionClass").asText()) : null;
        return new RequestIdentity(
                requiredText(node, "toolId"),
                textOrNull(node, "toolVersion"),
                textOrNull(node, "callerAgentId"),
                textOrNull(node, "callerReleaseId"),
                textOrNull(node, "tenantId"),
                actionClass,
                textOrNull(node, "requestSchemaVersion"),
                node.path("inputFingerprint").asText(""),
                node.path("bound").asBoolean(false));
    }

    private static ObjectNode encodeResult(ToolExecutionResult result) {
        ObjectNode node = JSON.createObjectNode();
        node.put("invocationId", result.invocationId());
        node.put("status", result.status().name());
        node.set("output", result.output() == null ? JSON.nullNode() : JSON.valueToTree(result.output()));
        node.put("policyDecision", result.policyDecision());
        node.put("approvalDecision", result.approvalDecision());
        node.set("sideEffectSummary", JSON.valueToTree(result.sideEffectSummary()));
        if (result.errorMessage() != null) node.put("errorMessage", result.errorMessage());
        if (result.correlationId() != null) node.put("correlationId", result.correlationId());
        node.put("completedAt", result.completedAt().toString());
        node.put("executionDuration", result.executionDuration().toString());
        if (result.failure() != null) {
            ObjectNode failure = JSON.createObjectNode();
            failure.put("kind", result.failure().kind().name());
            failure.put("stage", result.failure().stage().name());
            failure.put("code", result.failure().code());
            failure.put("retryable", result.failure().retryable());
            failure.put("observedAt", result.failure().observedAt().toString());
            node.set("failure", failure);
        } else {
            node.putNull("failure");
        }
        if (result.operationId() != null) node.put("operationId", result.operationId());
        if (result.attemptId() != null) node.put("attemptId", result.attemptId());
        return node;
    }

    @SuppressWarnings("unchecked")
    private static ToolExecutionResult decodeResult(JsonNode node) {
        ToolExecutionFailure failure = null;
        JsonNode failureNode = node.get("failure");
        if (failureNode != null && !failureNode.isNull()) {
            failure = new ToolExecutionFailure(
                    ToolExecutionFailure.Kind.valueOf(failureNode.required("kind").asText()),
                    ToolExecutionFailure.Stage.valueOf(failureNode.required("stage").asText()),
                    requiredText(failureNode, "code"),
                    failureNode.path("retryable").asBoolean(false),
                    Instant.parse(requiredText(failureNode, "observedAt")));
        }
        JsonNode outputNode = node.get("output");
        Object output = outputNode == null || outputNode.isNull()
                ? null : JSON.treeToValue(outputNode, Object.class);
        JsonNode summaryNode = node.get("sideEffectSummary");
        Map<String, Object> summary = summaryNode == null || summaryNode.isNull()
                ? Map.of() : JSON.treeToValue(summaryNode, Map.class);
        return new ToolExecutionResult(
                requiredText(node, "invocationId"),
                ToolExecutionStatus.valueOf(requiredText(node, "status")),
                output,
                requiredText(node, "policyDecision"),
                requiredText(node, "approvalDecision"),
                summary,
                textOrNull(node, "errorMessage"),
                textOrNull(node, "correlationId"),
                Instant.parse(requiredText(node, "completedAt")),
                Duration.parse(requiredText(node, "executionDuration")),
                failure,
                textOrNull(node, "operationId"),
                textOrNull(node, "attemptId"));
    }

    private static String requiredText(JsonNode node, String field) {
        JsonNode value = node.get(field);
        if (value == null || value.isNull() || !value.isTextual()) {
            throw new IllegalStateException("invocation record missing field: " + field);
        }
        return value.asText();
    }

    private static String textOrNull(JsonNode node, String field) {
        JsonNode value = node.get(field);
        return value == null || value.isNull() ? null : value.asText();
    }
}
