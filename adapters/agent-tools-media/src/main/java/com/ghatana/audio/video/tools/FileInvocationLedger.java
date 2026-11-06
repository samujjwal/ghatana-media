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
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.nio.file.attribute.UserPrincipal;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;

/**
 AT-05 durable backing: one JSON record per invocation on the local filesystem.
 *
 * <p>Claim exclusivity comes from an atomic create-if-absent hard link to a fully
 * fsynced temporary fence file; completion durability comes from a lock-file-serialized
 * read-verify-atomic-replace. Records survive process restart because state
 * lives on disk, not in memory. This is a single-host development backing. The
 * host injects the AES key and result-retention policy, and the binder requires
 * a freshly authenticated principal plus an injected replay authorizer before
 * it can return a stored result. The store never persists its encryption key.
 *
 * <p>Corrupt or unreadable records fail closed: reads throw and claims on an
 * existing-but-unreadable record resolve to {@link ClaimResult#ALREADY_CLAIMED}
 * so the binder's readback path reports unavailability rather than dispatching.
 */
public final class FileInvocationLedger implements InvocationLedger {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final int SCHEMA_VERSION = 2;
    private static final int GCM_NONCE_BYTES = 12;
    private static final int GCM_TAG_BITS = 128;
    private static final int LOCK_STRIPE_COUNT = 64;
    private static final Set<PosixFilePermission> DIRECTORY_PERMISSIONS =
            PosixFilePermissions.fromString("rwx------");
    private static final Set<PosixFilePermission> FILE_PERMISSIONS =
            PosixFilePermissions.fromString("rw-------");

    private final Path directory;
    private final UserPrincipal expectedOwner;
    private final SecretKey resultEncryptionKey;
    private final Duration resultRetention;
    private final Clock clock;
    private final SecureRandom secureRandom = new SecureRandom();
    private final ReentrantLock[] stripes = new ReentrantLock[LOCK_STRIPE_COUNT];

    /**
     * @param directory durable POSIX directory for invocation records; created
     *                  owner-only if absent. Existing directories must be owned
     *                  by the current user and have mode 0700. Requires same-filesystem
     *                  hard-link support for exclusive claims and
     *                  atomic replace support for terminal completion; when
     *                  unsupported, operations fail closed rather than risk
     *                  overwriting another invocation's fence.
     * @param resultEncryptionKey host-provided AES key; never stored by this ledger
     * @param resultRetention positive lifetime for encrypted terminal result bodies
     * @param clock host clock used to enforce the configured result lifetime
     */
    public FileInvocationLedger(Path directory, SecretKey resultEncryptionKey,
            Duration resultRetention, Clock clock) {
        this.directory = directory.toAbsolutePath().normalize();
        this.resultEncryptionKey = requireAesKey(resultEncryptionKey);
        this.resultRetention = Objects.requireNonNull(resultRetention, "resultRetention");
        if (resultRetention.isNegative() || resultRetention.isZero()) {
            throw new IllegalArgumentException("result retention must be positive");
        }
        this.clock = Objects.requireNonNull(clock, "clock");
        for (int i = 0; i < LOCK_STRIPE_COUNT; i++) stripes[i] = new ReentrantLock();
        this.expectedOwner = currentUser(this.directory);
        try {
            createPrivateDirectoryIfAbsent(this.directory);
            validatePrivateDirectory();
        } catch (IOException | UnsupportedOperationException e) {
            throw new IllegalStateException("invocation ledger directory is not securely usable", e);
        }
    }

    private static SecretKey requireAesKey(SecretKey key) {
        Objects.requireNonNull(key, "resultEncryptionKey");
        if (!"AES".equalsIgnoreCase(key.getAlgorithm()) || key.getEncoded() == null
                || !Set.of(16, 24, 32).contains(key.getEncoded().length)) {
            throw new IllegalArgumentException("invocation result key must be a 128, 192, or 256-bit AES key");
        }
        return key;
    }

    private static UserPrincipal currentUser(Path path) {
        String user = System.getProperty("user.name");
        if (user == null || user.isBlank()) {
            throw new IllegalStateException("cannot determine invocation ledger owner");
        }
        try {
            return path.getFileSystem().getUserPrincipalLookupService().lookupPrincipalByName(user);
        } catch (IOException | UnsupportedOperationException e) {
            throw new IllegalStateException("cannot resolve invocation ledger owner", e);
        }
    }

    private static void createPrivateDirectoryIfAbsent(Path directory) throws IOException {
        if (Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) return;
        Path parent = directory.getParent();
        if (parent != null) Files.createDirectories(parent);
        try {
            Files.createDirectory(directory, PosixFilePermissions.asFileAttribute(DIRECTORY_PERMISSIONS));
        } catch (java.nio.file.FileAlreadyExistsException raced) {
            // Validate the winning entry below; never follow or repair it silently.
        }
    }

    private void validatePrivateDirectory() throws IOException {
        if (Files.isSymbolicLink(directory)
                || !Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) {
            throw new IllegalStateException("invocation ledger path must be a real directory, not a symlink");
        }
        if (!Files.getOwner(directory, LinkOption.NOFOLLOW_LINKS).equals(expectedOwner)) {
            throw new IllegalStateException("invocation ledger directory is not owned by the current user");
        }
        Set<PosixFilePermission> permissions = Files.getPosixFilePermissions(directory, LinkOption.NOFOLLOW_LINKS);
        if (!permissions.containsAll(DIRECTORY_PERMISSIONS)
                || permissions.stream().anyMatch(permission -> permission.name().startsWith("GROUP_")
                        || permission.name().startsWith("OTHERS_"))) {
            throw new IllegalStateException("invocation ledger directory must have owner-only permissions (0700)");
        }
    }

    private void validatePrivateRegularFile(Path file) throws IOException {
        if (Files.isSymbolicLink(file)
                || !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
            throw new IllegalStateException("invocation ledger entry must be a regular file, not a symlink");
        }
        if (!Files.getOwner(file, LinkOption.NOFOLLOW_LINKS).equals(expectedOwner)) {
            throw new IllegalStateException("invocation ledger file is not owned by the current user");
        }
        Set<PosixFilePermission> permissions = Files.getPosixFilePermissions(file, LinkOption.NOFOLLOW_LINKS);
        if (!permissions.contains(PosixFilePermission.OWNER_READ)
                || !permissions.contains(PosixFilePermission.OWNER_WRITE)
                || permissions.stream().anyMatch(permission -> permission.name().startsWith("GROUP_")
                        || permission.name().startsWith("OTHERS_"))) {
            throw new IllegalStateException("invocation ledger files must have owner-only permissions (0600)");
        }
    }

    private FileChannel openPrivateLockFile(Path lockFile) throws IOException {
        validatePrivateDirectory();
        try {
            Files.createFile(lockFile, PosixFilePermissions.asFileAttribute(FILE_PERMISSIONS));
        } catch (java.nio.file.FileAlreadyExistsException alreadyExists) {
            // Existing lock files are accepted only after ownership/mode validation.
        }
        validatePrivateRegularFile(lockFile);
        return FileChannel.open(lockFile, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
    }

    public Path directory() { return directory; }

    @Override
    public Optional<LogicalAction> find(String invocationId) {
        Path file = recordPath(invocationId);
        try {
            validatePrivateDirectory();
            if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS)) return Optional.empty();
            validatePrivateRegularFile(file);
            String serialized = Files.readString(file);
            JsonNode record = JSON.readTree(serialized);
            if (record.path("resultExpired").asBoolean(false) || resultExpired(record, clock.instant())) {
                purgeExpiredResult(invocationId, file);
                return Optional.empty();
            }
            return Optional.of(decode(record));
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
        try {
            validatePrivateDirectory();
            if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) return ClaimResult.ALREADY_CLAIMED;
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
            try (FileChannel channel = openPrivateLockFile(lockFile);
                 FileLock ignored = channel.tryLock()) {
                validatePrivateDirectory();
                if (ignored == null) return false;
                Path target = recordPath(terminalAction.invocationId());
                if (!Files.exists(target, LinkOption.NOFOLLOW_LINKS)) return false;
                validatePrivateRegularFile(target);
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
            } catch (IOException | IllegalStateException e) {
                return false;
            }
        });
    }

    private static boolean resultExpired(JsonNode record, Instant now) {
        JsonNode expiry = record.get("resultExpiresAt");
        return expiry != null && expiry.isTextual() && !Instant.parse(expiry.asText()).isAfter(now);
    }

    private void purgeExpiredResult(String invocationId, Path target) throws IOException {
        withKeyLock(invocationId, () -> {
            Path lockFile = lockPath(invocationId);
            try (FileChannel channel = openPrivateLockFile(lockFile);
                 FileLock lock = channel.tryLock()) {
                if (lock == null || !Files.exists(target, LinkOption.NOFOLLOW_LINKS)) return null;
                validatePrivateRegularFile(target);
                JsonNode current = JSON.readTree(Files.readString(target));
                if (resultExpired(current, clock.instant())) {
                    ObjectNode tombstone = JSON.createObjectNode();
                    tombstone.put("schemaVersion", SCHEMA_VERSION);
                    tombstone.put("resultExpired", true);
                    tombstone.put("resultPurgedAt", clock.instant().toString());
                    atomicWrite(target, tombstone.toString(), true);
                }
            } catch (IOException | RuntimeException ignored) {
                // Expiration readback is fail-closed; the durable claim remains present.
            }
            return null;
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

    /** Marker for exclusive hard-link collision; keeps claim() free of checked exceptions. */
    private static final class FileAlreadyExistsMarker extends RuntimeException {
        FileAlreadyExistsMarker(Throwable cause) { super(cause); }
    }

    private static void atomicWrite(Path target, String content, boolean replace) throws IOException {
        Path temp = Files.createTempFile(target.getParent(), ".inv-", ".tmp",
                PosixFilePermissions.asFileAttribute(FILE_PERMISSIONS));
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

    private String encode(LogicalAction action) {
        ObjectNode root = JSON.createObjectNode();
        root.put("schemaVersion", SCHEMA_VERSION);
        root.put("invocationId", action.invocationId());
        root.set("requestIdentity", encodeIdentity(action.requestIdentity()));
        root.put("outcome", action.outcome().name());
        if (action.result() != null) {
            byte[] nonce = new byte[GCM_NONCE_BYTES];
            secureRandom.nextBytes(nonce);
            String resultExpiresAt = clock.instant().plus(resultRetention).toString();
            byte[] ciphertext = encrypt(jsonBytes(encodeResult(action.result())), nonce,
                    authenticatedData(action.invocationId(), action.requestIdentity(), resultExpiresAt));
            root.put("resultNonce", java.util.Base64.getEncoder().encodeToString(nonce));
            root.put("resultCiphertext", java.util.Base64.getEncoder().encodeToString(ciphertext));
            root.put("resultExpiresAt", resultExpiresAt);
        } else {
            root.putNull("resultNonce");
            root.putNull("resultCiphertext");
            root.putNull("resultExpiresAt");
        }
        return root.toString();
    }

    private LogicalAction decode(JsonNode root) {
        if (root.path("schemaVersion").asInt(-1) != SCHEMA_VERSION) {
            throw new IllegalStateException("unsupported invocation record schema");
        }
        String invocationId = requiredText(root, "invocationId");
        RequestIdentity identity = decodeIdentity(root.required("requestIdentity"));
        LogicalOutcome outcome = LogicalOutcome.valueOf(requiredText(root, "outcome"));
        JsonNode ciphertext = root.get("resultCiphertext");
        JsonNode nonce = root.get("resultNonce");
        JsonNode expiry = root.get("resultExpiresAt");
        boolean hasCiphertext = ciphertext != null && !ciphertext.isNull();
        boolean hasNonce = nonce != null && !nonce.isNull();
        boolean hasExpiry = expiry != null && !expiry.isNull();
        if (hasCiphertext != hasNonce || hasCiphertext != hasExpiry) {
            throw new IllegalStateException("invocation result encryption metadata is incomplete");
        }
        ToolExecutionResult result = null;
        if (hasCiphertext) {
            if (!expiry.isTextual()) throw new IllegalStateException("invocation result expiry is malformed");
            String resultExpiresAt = expiry.asText();
            // Parse before decryption to reject malformed expiry metadata, and bind the original
            // value into GCM AAD so a local record edit cannot extend the retention period.
            java.time.Instant.parse(resultExpiresAt);
            result = decodeResult(decrypt(
                    java.util.Base64.getDecoder().decode(ciphertext.asText()),
                    java.util.Base64.getDecoder().decode(nonce.asText()),
                    authenticatedData(invocationId, identity, resultExpiresAt)));
        }
        return new LogicalAction(invocationId, identity, outcome, result);
    }

    private byte[] encrypt(byte[] cleartext, byte[] nonce, byte[] aad) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, resultEncryptionKey, new GCMParameterSpec(GCM_TAG_BITS, nonce));
            cipher.updateAAD(aad);
            return cipher.doFinal(cleartext);
        } catch (java.security.GeneralSecurityException failure) {
            throw new IllegalStateException("invocation result encryption failed", failure);
        }
    }

    private byte[] decrypt(byte[] ciphertext, byte[] nonce, byte[] aad) {
        try {
            if (nonce.length != GCM_NONCE_BYTES) throw new IllegalArgumentException("invalid result nonce");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, resultEncryptionKey, new GCMParameterSpec(GCM_TAG_BITS, nonce));
            cipher.updateAAD(aad);
            return cipher.doFinal(ciphertext);
        } catch (java.security.GeneralSecurityException failure) {
            throw new IllegalStateException("invocation result authentication failed", failure);
        }
    }

    private byte[] authenticatedData(String invocationId, RequestIdentity identity, String resultExpiresAt) {
        byte[] identityBytes = jsonBytes(encodeIdentity(identity));
        byte[] invocationBytes = invocationId.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        byte[] expiryBytes = resultExpiresAt.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        byte[] aad = java.util.Arrays.copyOf(invocationBytes,
                invocationBytes.length + 1 + identityBytes.length + 1 + expiryBytes.length);
        aad[invocationBytes.length] = 0;
        System.arraycopy(identityBytes, 0, aad, invocationBytes.length + 1, identityBytes.length);
        aad[invocationBytes.length + 1 + identityBytes.length] = 0;
        System.arraycopy(expiryBytes, 0, aad, invocationBytes.length + 2 + identityBytes.length, expiryBytes.length);
        return aad;
    }

    private ToolExecutionResult decodeResult(byte[] encryptedJson) {
        return decodeResult(JSON.readTree(encryptedJson));
    }

    private static byte[] jsonBytes(JsonNode node) {
        return JSON.writeValueAsBytes(node);
    }

    private LogicalAction readAction(String json) {
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
