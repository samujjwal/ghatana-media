package com.ghatana.audiovideo.adapter.ledger;

import com.ghatana.audiovideo.adapter.ledger.RunLedgerProjection.ProjectionStateBacking;
import com.ghatana.datacloud.delivery.ledger.RunLedger;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.channels.FileChannel;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Optional;
import java.util.UUID;

/**
 * Filesystem-backed {@link ProjectionStateBacking}: one JSON document per
 * run holding the latest-truth, pre-dispatch-unavailable and uncertain-fence
 * slots. Writes are atomic (fsync + rename); reads of corrupt documents fail
 * closed because a silently dropped reconciliation fence is unsafe. This is
 * single-node durable state — it preserves projection truth across process
 * restart on one host and is not a replicated store.
 *
 * <p>Single-writer policy: the plain constructor preserves the documented
 * single-host, single-owner assumption. {@link #forExclusiveWriter(Path)}
 * durably claims a writer fence via an atomic create-if-absent hard link —
 * the same primitive as the invocation claim — so a second projector instance
 * on shared storage fails closed instead of dispatching a stale or duplicate
 * update. Ownership is re-verified on every load and save; a reclaimed or
 * rewritten fence makes the holder fail closed too. On filesystems without
 * hard-link support the claim fails closed. Multi-host/shared storage
 * requires a transactional CAS backing (a database compare-and-set plus
 * destination readback); a file rename is never distributed compare-and-set.</p>
 */
public final class FileRunLedgerProjectionState implements ProjectionStateBacking, AutoCloseable {

    /** Raised when another instance already holds the exclusive writer fence. */
    public static final class ProjectionWriterConflictException extends IllegalStateException {
        public ProjectionWriterConflictException(String message) { super(message); }
        public ProjectionWriterConflictException(String message, Throwable cause) { super(message, cause); }
    }

    /** Raised when this instance's writer fence was lost or reclaimed. */
    public static final class ProjectionWriterLostException extends IllegalStateException {
        public ProjectionWriterLostException(String message) { super(message); }
    }

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SCHEMA = "run-ledger-projection-state/v1";
    private static final String WRITER_LOCK_SCHEMA = "run-ledger-projection-writer/v1";
    private static final String WRITER_LOCK_NAME = "writer.lock";

    private final Path directory;
    private final Path ownerLockFile;
    private final String ownerToken;
    private volatile boolean closed;

    /** Shared mode: caller upholds the documented single-host single-writer rule. */
    public FileRunLedgerProjectionState(Path directory) {
        this.directory = prepareDirectory(directory);
        this.ownerLockFile = null;
        this.ownerToken = null;
    }

    private FileRunLedgerProjectionState(Path directory, Path ownerLockFile, String ownerToken) {
        this.directory = directory;
        this.ownerLockFile = ownerLockFile;
        this.ownerToken = ownerToken;
    }

    /**
     * Exclusive-writer mode: atomically claims the durable writer fence in
     * {@code directory} and throws {@link ProjectionWriterConflictException}
     * when another live owner holds it. The returned instance must be closed
     * to release the fence; a crashed owner leaves the fence durably claimed
     * (fail closed) until an operator removes {@code writer.lock} by hand.
     */
    public static FileRunLedgerProjectionState forExclusiveWriter(Path directory) {
        Path prepared = prepareDirectory(directory);
        Path lock = prepared.resolve(WRITER_LOCK_NAME);
        String token = UUID.randomUUID().toString();
        ObjectNode body = JSON.createObjectNode();
        body.put("schema", WRITER_LOCK_SCHEMA);
        body.put("ownerToken", token);
        Path temp;
        try {
            temp = Files.createTempFile(prepared, ".wrk-", ".tmp");
        } catch (IOException e) {
            throw new UncheckedIOException("cannot stage projection writer fence", e);
        }
        try {
            Files.writeString(temp, body.toString());
            try (FileChannel channel = FileChannel.open(temp, StandardOpenOption.WRITE)) {
                channel.force(true);
            }
            // createLink is an atomic create-if-absent directory entry: a
            // concurrent projector loses here instead of racing a dispatch.
            Files.createLink(lock, temp);
        } catch (FileAlreadyExistsException e) {
            deleteQuietly(temp);
            throw new ProjectionWriterConflictException(
                    "projection writer fence already held at " + lock, e);
        } catch (IOException | UnsupportedOperationException | SecurityException e) {
            deleteQuietly(temp);
            throw new ProjectionWriterConflictException(
                    "projection writer fence cannot be established on this filesystem", e);
        }
        deleteQuietly(temp);
        try (FileChannel channel = FileChannel.open(prepared, StandardOpenOption.READ)) {
            channel.force(true);
        } catch (IOException | UnsupportedOperationException ignored) {
            // Directory fsync is best-effort; the fence body was already forced.
        }
        return new FileRunLedgerProjectionState(prepared, lock, token);
    }

    private static Path prepareDirectory(Path directory) {
        Path prepared = directory.toAbsolutePath().normalize();
        try {
            Files.createDirectories(prepared);
        } catch (IOException e) {
            throw new UncheckedIOException("cannot create projection state directory", e);
        }
        if (!Files.isDirectory(prepared)) {
            throw new IllegalArgumentException("projection state path is not a directory");
        }
        return prepared;
    }

    /** Whether this instance holds an exclusive writer fence. */
    public boolean exclusiveWriter() { return ownerToken != null; }

    public Path directory() { return directory; }

    /**
     * Releases the writer fence only when the recorded owner token still
     * matches — never deletes another projector's claim. Idempotent.
     */
    @Override
    public void close() {
        if (closed) return;
        closed = true;
        if (ownerToken == null) return;
        if (heldByThisInstance()) deleteQuietly(ownerLockFile);
    }

    private boolean heldByThisInstance() {
        try {
            if (!Files.exists(ownerLockFile)) return false;
            JsonNode node = JSON.readTree(Files.readString(ownerLockFile));
            return ownerToken.equals(node.path("ownerToken").asText())
                    && WRITER_LOCK_SCHEMA.equals(node.path("schema").asText());
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    private void verifyWriterOwnership() {
        if (ownerToken == null) return;
        if (closed) throw new ProjectionWriterLostException("projection writer fence released");
        if (!heldByThisInstance()) {
            throw new ProjectionWriterLostException(
                    "projection writer fence at " + ownerLockFile + " is missing, corrupt, or owned by another instance");
        }
    }

    private static void deleteQuietly(Path path) {
        try { Files.deleteIfExists(path); } catch (IOException ignored) { }
    }

    @Override
    public Optional<RunProjectionState> load(String runId) {
        verifyWriterOwnership();
        Path file = recordPath(runId);
        if (!Files.exists(file)) return Optional.empty();
        final String json;
        try {
            json = Files.readString(file);
        } catch (IOException e) {
            throw new UncheckedIOException("projection state unreadable", e);
        }
        JsonNode root;
        try {
            root = JSON.readTree(json);
        } catch (RuntimeException e) {
            throw new IllegalStateException("projection state corrupt", e);
        }
        if (!SCHEMA.equals(root.path("schema").asText())) {
            throw new IllegalStateException("projection state schema mismatch");
        }
        RunProjectionState state = new RunProjectionState(
                ledgerAt(root, "latest"), ledgerAt(root, "unavailable"), ledgerAt(root, "uncertain"));
        validateRunId(runId, state);
        return Optional.of(state);
    }

    @Override
    public void save(String runId, RunProjectionState state) {
        verifyWriterOwnership();
        validateRunId(runId, state);
        ObjectNode root = JSON.createObjectNode();
        root.put("schema", SCHEMA);
        putLedger(root, "latest", state.latest());
        putLedger(root, "unavailable", state.unavailable());
        putLedger(root, "uncertain", state.uncertain());
        try {
            atomicWrite(recordPath(runId), root.toString());
        } catch (IOException e) {
            throw new UncheckedIOException("projection state write failed", e);
        }
    }

    private static RunLedger ledgerAt(JsonNode root, String field) {
        JsonNode node = root.get(field);
        if (node == null || node.isNull()) return null;
        try {
            return RunLedgerJson.decode(node.toString());
        } catch (RuntimeException e) {
            throw new IllegalStateException("projection state member corrupt", e);
        }
    }

    private static void putLedger(ObjectNode root, String field, RunLedger ledger) {
        if (ledger == null) root.putNull(field);
        else {
            try {
                root.set(field, JSON.readTree(RunLedgerJson.encode(ledger)));
            } catch (RuntimeException e) {
                throw new IllegalStateException("projection state encode failed", e);
            }
        }
    }

    private static void validateRunId(String runId, RunProjectionState state) {
        if (runId == null || runId.isBlank() || state == null) {
            throw new IllegalArgumentException("projection requires nonblank runId and state");
        }
        for (RunLedger record : new RunLedger[] {state.latest(), state.unavailable(), state.uncertain()}) {
            if (record != null && !runId.equals(record.runId())) {
                throw new IllegalStateException("projection state record has mismatched runId");
            }
        }
    }

    private Path recordPath(String runId) {
        return directory.resolve(fileKey(runId) + ".json");
    }

    /** Digest filename keeps run identifiers out of the filesystem namespace. */
    private static String fileKey(String runId) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(runId.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    private static void atomicWrite(Path target, String content) throws IOException {
        Path temp = Files.createTempFile(target.getParent(), ".prs-", ".tmp");
        try {
            Files.writeString(temp, content);
            try (FileChannel channel = FileChannel.open(temp, StandardOpenOption.WRITE)) {
                channel.force(true);
            }
            try {
                Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (RuntimeException | IOException e) {
            Files.deleteIfExists(temp);
            throw e;
        }
        try (FileChannel channel = FileChannel.open(target.getParent(), StandardOpenOption.READ)) {
            channel.force(true);
        } catch (IOException | UnsupportedOperationException ignored) {
            // Directory fsync is best-effort; record content was already forced.
        }
    }
}
