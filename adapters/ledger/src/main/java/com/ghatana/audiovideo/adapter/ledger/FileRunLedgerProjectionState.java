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
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Optional;

/**
 * Filesystem-backed {@link ProjectionStateBacking}: one JSON document per
 * run holding the latest-truth, pre-dispatch-unavailable and uncertain-fence
 * slots. Writes are atomic (fsync + rename); reads of corrupt documents fail
 * closed because a silently dropped reconciliation fence is unsafe. This is
 * single-node durable state — it preserves projection truth across process
 * restart on one host and is not a replicated store.
 */
public final class FileRunLedgerProjectionState implements ProjectionStateBacking {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SCHEMA = "run-ledger-projection-state/v1";

    private final Path directory;

    public FileRunLedgerProjectionState(Path directory) {
        this.directory = directory.toAbsolutePath().normalize();
        try {
            Files.createDirectories(this.directory);
        } catch (IOException e) {
            throw new UncheckedIOException("cannot create projection state directory", e);
        }
        if (!Files.isDirectory(this.directory)) {
            throw new IllegalArgumentException("projection state path is not a directory");
        }
    }

    public Path directory() { return directory; }

    @Override
    public Optional<RunProjectionState> load(String runId) {
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
        return Optional.of(new RunProjectionState(
                ledgerAt(root, "latest"), ledgerAt(root, "unavailable"), ledgerAt(root, "uncertain")));
    }

    @Override
    public void save(String runId, RunProjectionState state) {
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
