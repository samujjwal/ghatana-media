package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaErasureContracts.DeliveryRef;
import com.ghatana.media.runtime.MediaErasureContracts.ErasureAuthority;
import com.ghatana.media.runtime.MediaErasureContracts.ErasureOperation;
import com.ghatana.media.runtime.MediaErasureContracts.ErasurePlan;
import com.ghatana.media.runtime.MediaErasureContracts.ErasureReceipt;
import com.ghatana.media.runtime.MediaErasureContracts.ErasureRefusedException;
import com.ghatana.media.runtime.MediaErasureContracts.HoldState;
import com.ghatana.media.runtime.MediaErasureContracts.LegalHold;
import com.ghatana.media.runtime.MediaErasureContracts.LocalWork;
import com.ghatana.media.runtime.MediaErasureContracts.Phase;
import com.ghatana.media.runtime.MediaErasureContracts.ReceiptItem;
import com.ghatana.media.runtime.MediaErasureContracts.Tombstone;
import com.ghatana.media.runtime.MediaErasureContracts.TreeNode;
import com.ghatana.media.runtime.MediaVerifiedIdentityContracts.AssuranceSource;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.HeadObjectRequest;
import software.amazon.awssdk.services.s3.model.NoSuchKeyException;
import software.amazon.awssdk.services.s3.model.S3Exception;
import tools.jackson.core.type.TypeReference;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * PostgreSQL/S3 erasure and legal-hold authority over the canonical Media runtime state (V039).
 *
 * <p><b>Tree.</b> Erasing an artifact removes it and everything derived from it. Derivation is read from both
 * lineage sources the runtime writes: the {@code media_artifact_lineage} table, and the artifact-reference fields of
 * the lineage metadata that every DEV lane registers with its output ({@code source}, {@code parent},
 * {@code sources[]}, {@code machineVersion}, {@code inputReferences[]}). Only artifacts of the same tenant and the same
 * owning principal are considered.</p>
 *
 * <p><b>Order.</b> {@link #begin} removes every metadata row of the tree in one transaction under the tenant mutation
 * lock and records a manifest of identifiers and digests; from that commit nothing in the tree is readable. The stored
 * objects are then deleted and verified absent ({@link #eraseObjects}), and the host removes its local copies before
 * {@link #complete} finalises a content-free receipt. A crash between steps leaves a durable operation that
 * {@link #incomplete} reports and that the same erasure id resumes.</p>
 *
 * @doc.type class
 * @doc.purpose Request-driven all-copy erasure of a Media lineage tree with owner legal holds
 * @doc.layer product
 * @doc.pattern Provider, Authority
 */
public final class PostgresqlMediaErasureAuthority implements ErasureAuthority {
    private static final int MAX_TREE = 2_000;
    private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() { };
    private static final TypeReference<List<Map<String, Object>>> LIST = new TypeReference<>() { };

    private final MediaAwsPostgresqlRuntimeState state;
    private final PostgresqlDevProjectTimelinePersistenceState reviewState;
    private final Clock clock;
    private final boolean requireOidc;
    private final AtomicBoolean closed = new AtomicBoolean();

    public PostgresqlMediaErasureAuthority() {
        this(MediaAwsPostgresqlRuntimeState.acquire(), null, Clock.systemUTC(), false);
    }

    PostgresqlMediaErasureAuthority(MediaAwsPostgresqlRuntimeState state,
                                    PostgresqlDevProjectTimelinePersistenceState reviewState, Clock clock,
                                    boolean requireOidc) {
        this.state = Objects.requireNonNull(state, "state");
        this.reviewState = reviewState;
        this.clock = Objects.requireNonNull(clock, "clock");
        this.requireOidc = requireOidc;
    }

    @Override public String authorityId() { return "postgresql-s3-erasure-authority"; }

    @Override public boolean ready() { return !closed.get() && state.ready(); }

    // ------------------------------------------------------------------------------------------------ plan

    @Override
    public ErasurePlan plan(String tenantId, String principalId, String artifactId) {
        ensureOpen();
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                Map<String, Node> tree = closure(connection, tenantId, principalId, artifactId);
                if (tree.isEmpty()) throw missing(connection, tenantId, artifactId);
                requireBounded(tree);
                Map<String, LegalHold> blocking = blockingHolds(connection, tenantId, tree.keySet());
                Map<String, Integer> dependents = new TreeMap<>(countDependents(connection, tenantId, tree.keySet()));
                connection.commit();
                List<TreeNode> nodes = new ArrayList<>();
                for (Node node : tree.values()) {
                    nodes.add(new TreeNode(node.id(), node.kind(), node.contentType(), node.sha256(), node.size(),
                            List.copyOf(node.parents())));
                }
                return new ErasurePlan(artifactId, nodes, dependents, new ArrayList<>(blocking.values()),
                        blocking.isEmpty());
            } catch (SQLException | RuntimeException failure) {
                rollback(connection, failure);
                throw failure;
            }
        } catch (SQLException failure) {
            throw database("plan an erasure", failure);
        }
    }

    // ------------------------------------------------------------------------------------------------- holds

    @Override
    public LegalHold placeHold(String tenantId, String principalId, String requestId, String artifactId,
                               String reason, AssuranceSource assurance) {
        ensureOpen();
        requireAssurance(assurance);
        String cleanReason = requireText(reason, "reason", 1_000);
        String request = requireId(requestId, "requestId");
        String fingerprint = sha256Hex(artifactId + "\u0000" + cleanReason);
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                MediaArtifactObjectOwnership.lockTenantMutation(connection, tenantId);
                LegalHold existing = holdByRequest(connection, tenantId, principalId, request, fingerprint);
                if (existing != null) { connection.commit(); return existing; }
                Map<String, Node> tree = closure(connection, tenantId, principalId, artifactId);
                if (tree.isEmpty()) throw missing(connection, tenantId, artifactId);
                String holdId = "hold-" + UUID.randomUUID();
                Instant now = clock.instant();
                try (PreparedStatement insert = connection.prepareStatement(
                        "INSERT INTO media_legal_holds (tenant_id,hold_id,request_id,request_fingerprint,root_artifact_id,"
                                + "reason,placed_by,placed_assurance,placed_at,state) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')")) {
                    insert.setString(1, tenantId); insert.setString(2, holdId); insert.setString(3, request);
                    insert.setString(4, fingerprint); insert.setString(5, artifactId); insert.setString(6, cleanReason);
                    insert.setString(7, principalId); insert.setString(8, assurance.name());
                    insert.setTimestamp(9, Timestamp.from(now));
                    insert.executeUpdate();
                }
                syncHoldColumn(connection, tenantId, tree.keySet());
                connection.commit();
                return new LegalHold(holdId, artifactId, cleanReason, principalId, assurance, now, HoldState.ACTIVE,
                        null, null, null, null, false);
            } catch (SQLException | RuntimeException failure) {
                rollback(connection, failure);
                throw failure;
            }
        } catch (SQLException failure) {
            throw database("place a legal hold", failure);
        }
    }

    @Override
    public LegalHold releaseHold(String tenantId, String principalId, String holdId, String releaseReason,
                                 AssuranceSource assurance) {
        ensureOpen();
        requireAssurance(assurance);
        String cleanReason = requireText(releaseReason, "releaseReason", 1_000);
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                MediaArtifactObjectOwnership.lockTenantMutation(connection, tenantId);
                LegalHold current = loadHold(connection, tenantId, holdId, true);
                if (current == null || !current.placedBy().equals(principalId)) {
                    throw new ErasureRefusedException(404, "HOLD_NOT_FOUND",
                            "legal hold not found in this tenant and owner scope", Map.of());
                }
                if (current.state() == HoldState.RELEASED) {
                    connection.commit();
                    return new LegalHold(current.holdId(), current.rootArtifactId(), current.reason(),
                            current.placedBy(), current.placedAssurance(), current.placedAt(), current.state(),
                            current.releasedBy(), current.releasedAssurance(), current.releaseReason(),
                            current.releasedAt(), true);
                }
                Instant now = clock.instant();
                try (PreparedStatement update = connection.prepareStatement(
                        "UPDATE media_legal_holds SET state='RELEASED',released_by=?,released_assurance=?,release_reason=?,"
                                + "released_at=? WHERE tenant_id=? AND hold_id=? AND state='ACTIVE'")) {
                    update.setString(1, principalId); update.setString(2, assurance.name());
                    update.setString(3, cleanReason); update.setTimestamp(4, Timestamp.from(now));
                    update.setString(5, tenantId); update.setString(6, holdId);
                    update.executeUpdate();
                }
                Map<String, Node> tree = closure(connection, tenantId, principalId, current.rootArtifactId());
                syncHoldColumn(connection, tenantId, tree.keySet());
                connection.commit();
                return new LegalHold(holdId, current.rootArtifactId(), current.reason(), current.placedBy(),
                        current.placedAssurance(), current.placedAt(), HoldState.RELEASED, principalId, assurance,
                        cleanReason, now, false);
            } catch (SQLException | RuntimeException failure) {
                rollback(connection, failure);
                throw failure;
            }
        } catch (SQLException failure) {
            throw database("release a legal hold", failure);
        }
    }

    @Override
    public Optional<LegalHold> hold(String tenantId, String principalId, String holdId) {
        ensureOpen();
        try (Connection connection = state.connection()) {
            LegalHold hold = loadHold(connection, tenantId, holdId, false);
            return hold != null && hold.placedBy().equals(principalId) ? Optional.of(hold) : Optional.empty();
        } catch (SQLException failure) {
            throw database("read a legal hold", failure);
        }
    }

    @Override
    public List<LegalHold> holds(String tenantId, String principalId, String artifactId) {
        ensureOpen();
        try (Connection connection = state.connection();
             PreparedStatement select = connection.prepareStatement(HOLD_SELECT
                     + " WHERE tenant_id=? AND root_artifact_id=? AND placed_by=? ORDER BY placed_at, hold_id")) {
            select.setString(1, tenantId); select.setString(2, artifactId); select.setString(3, principalId);
            List<LegalHold> holds = new ArrayList<>();
            try (ResultSet rows = select.executeQuery()) {
                while (rows.next()) holds.add(hold(rows, false));
            }
            return holds;
        } catch (SQLException failure) {
            throw database("list legal holds", failure);
        }
    }

    // ------------------------------------------------------------------------------------------------ erase

    @Override
    public ErasureOperation begin(String tenantId, String principalId, String erasureId, String artifactId,
                                  AssuranceSource assurance) {
        ensureOpen();
        requireAssurance(assurance);
        String id = requireId(erasureId, "erasureId");
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                MediaArtifactObjectOwnership.lockTenantMutation(connection, tenantId);
                OperationRow existing = loadOperation(connection, tenantId, id);
                if (existing != null) {
                    if (!existing.principalId().equals(principalId) || !existing.rootArtifactId().equals(artifactId)) {
                        throw new ErasureRefusedException(409, "ERASURE_ID_REUSED",
                                "erasureId was already used for a different erasure", Map.of());
                    }
                    connection.commit();
                    return existing.operation(true);
                }
                Map<String, Node> tree = closure(connection, tenantId, principalId, artifactId);
                if (tree.isEmpty()) throw missing(connection, tenantId, artifactId);
                requireBounded(tree);
                Map<String, LegalHold> blocking = blockingHolds(connection, tenantId, tree.keySet());
                if (!blocking.isEmpty()) {
                    throw new ErasureRefusedException(409, "LEGAL_HOLD_ACTIVE",
                            "a legal hold covers part of this tree; nothing was erased",
                            Map.of("holdIds", List.copyOf(blocking.keySet()),
                                    "artifactCount", tree.size()));
                }
                Map<String, Object> manifest = removeMetadata(connection, tenantId, principalId, tree);
                Instant now = clock.instant();
                try (PreparedStatement insert = connection.prepareStatement(
                        "INSERT INTO media_erasure_operations (tenant_id,erasure_id,principal_id,root_artifact_id,"
                                + "requested_assurance,state,manifest_json,requested_at) VALUES (?,?,?,?,?,'DB_ERASED',?,?)")) {
                    insert.setString(1, tenantId); insert.setString(2, id); insert.setString(3, principalId);
                    insert.setString(4, artifactId); insert.setString(5, assurance.name());
                    insert.setString(6, state.mapper().writeValueAsString(manifest));
                    insert.setTimestamp(7, Timestamp.from(now));
                    insert.executeUpdate();
                }
                try (PreparedStatement tombstone = connection.prepareStatement(
                        "INSERT INTO media_erasure_tombstones (tenant_id,artifact_id,erasure_id,kind,sha256,erased_at) "
                                + "VALUES (?,?,?,?,?,?)")) {
                    for (Node node : tree.values()) {
                        tombstone.setString(1, tenantId); tombstone.setString(2, node.id()); tombstone.setString(3, id);
                        tombstone.setString(4, node.kind()); tombstone.setString(5, node.sha256());
                        tombstone.setTimestamp(6, Timestamp.from(now));
                        tombstone.addBatch();
                    }
                    tombstone.executeBatch();
                }
                connection.commit();
                return new OperationRow(tenantId, id, principalId, artifactId, Phase.DB_ERASED, manifest, now, null,
                        null).operation(false);
            } catch (SQLException | RuntimeException failure) {
                rollback(connection, failure);
                throw failure;
            }
        } catch (SQLException failure) {
            throw database("erase an artifact tree", failure);
        }
    }

    @Override
    public ErasureOperation eraseObjects(ErasureOperation operation) {
        ensureOpen();
        try (Connection connection = state.connection()) {
            OperationRow row = loadOperation(connection, operation.tenantId(), operation.erasureId());
            if (row == null) throw new IllegalStateException("erasure operation vanished");
            if (row.phase() != Phase.DB_ERASED) return row.operation(true);
            List<Map<String, Object>> objects = objects(row.manifest());
            for (Map<String, Object> object : objects) {
                String key = String.valueOf(object.get("key"));
                if (key.isBlank()) throw new IllegalStateException("Refusing to delete a Media object without a key");
                state.s3().deleteObject(DeleteObjectRequest.builder().bucket(state.bucket()).key(key).build());
                if (present(key)) {
                    throw new IllegalStateException("a Media object is still readable after its erasure");
                }
            }
            Map<String, Object> manifest = new LinkedHashMap<>(row.manifest());
            manifest.put("reviewDevRemoved", eraseDevReview(row.tenantId(), stringList(manifest.get("reviewSubjectIds"))));
            try (PreparedStatement update = connection.prepareStatement(
                    "UPDATE media_erasure_operations SET state='OBJECTS_ERASED',manifest_json=? "
                            + "WHERE tenant_id=? AND erasure_id=? AND state='DB_ERASED'")) {
                update.setString(1, state.mapper().writeValueAsString(manifest));
                update.setString(2, row.tenantId()); update.setString(3, row.erasureId());
                update.executeUpdate();
            }
            return new OperationRow(row.tenantId(), row.erasureId(), row.principalId(), row.rootArtifactId(),
                    Phase.OBJECTS_ERASED, manifest, row.requestedAt(), null, null).operation(true);
        } catch (SQLException failure) {
            throw database("delete the stored objects of an erasure", failure);
        }
    }

    @Override
    public ErasureReceipt complete(ErasureOperation operation, List<ReceiptItem> localItems) {
        ensureOpen();
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                OperationRow row = loadOperation(connection, operation.tenantId(), operation.erasureId());
                if (row == null) throw new IllegalStateException("erasure operation vanished");
                if (row.phase() == Phase.COMPLETED) { connection.commit(); return receiptOf(row); }
                if (row.phase() != Phase.OBJECTS_ERASED) {
                    throw new IllegalStateException("stored objects must be erased before completion");
                }
                Map<String, Object> manifest = new LinkedHashMap<>(row.manifest());
                List<Map<String, Object>> local = new ArrayList<>();
                for (ReceiptItem item : localItems) local.add(item(item.kind(), item.count(), item.digests()));
                manifest.put("local", local);
                Instant now = clock.instant();
                OperationRow finished = new OperationRow(row.tenantId(), row.erasureId(), row.principalId(),
                        row.rootArtifactId(), Phase.COMPLETED, manifest, row.requestedAt(), now, null);
                ErasureReceipt receipt = receiptOf(finished);
                try (PreparedStatement update = connection.prepareStatement(
                        "UPDATE media_erasure_operations SET state='COMPLETED',manifest_json=?,receipt_json=?,completed_at=? "
                                + "WHERE tenant_id=? AND erasure_id=? AND state='OBJECTS_ERASED'")) {
                    update.setString(1, state.mapper().writeValueAsString(manifest));
                    update.setString(2, state.mapper().writeValueAsString(receiptView(receipt)));
                    update.setTimestamp(3, Timestamp.from(now));
                    update.setString(4, row.tenantId()); update.setString(5, row.erasureId());
                    if (update.executeUpdate() != 1) throw new IllegalStateException("erasure completion lost a race");
                }
                connection.commit();
                return receipt;
            } catch (SQLException | RuntimeException failure) {
                rollback(connection, failure);
                throw failure;
            }
        } catch (SQLException failure) {
            throw database("complete an erasure", failure);
        }
    }

    @Override
    public Optional<ErasureReceipt> receipt(String tenantId, String principalId, String erasureId) {
        ensureOpen();
        try (Connection connection = state.connection()) {
            OperationRow row = loadOperation(connection, tenantId, erasureId);
            return row == null || !row.principalId().equals(principalId) ? Optional.empty() : Optional.of(receiptOf(row));
        } catch (SQLException failure) {
            throw database("read an erasure receipt", failure);
        }
    }

    @Override
    public List<ErasureOperation> incomplete() {
        ensureOpen();
        List<ErasureOperation> open = new ArrayList<>();
        try (Connection connection = state.connection();
             PreparedStatement select = connection.prepareStatement(
                     "SELECT tenant_id,erasure_id FROM media_erasure_operations WHERE state<>'COMPLETED' "
                             + "ORDER BY requested_at")) {
            List<String[]> keys = new ArrayList<>();
            try (ResultSet rows = select.executeQuery()) {
                while (rows.next()) keys.add(new String[] {rows.getString(1), rows.getString(2)});
            }
            for (String[] key : keys) {
                OperationRow row = loadOperation(connection, key[0], key[1]);
                if (row != null) open.add(row.operation(true));
            }
            return open;
        } catch (SQLException failure) {
            throw database("list incomplete erasures", failure);
        }
    }

    @Override
    public Optional<Tombstone> tombstone(String tenantId, String artifactId) {
        ensureOpen();
        try (Connection connection = state.connection()) {
            return Optional.ofNullable(tombstoneOf(connection, tenantId, artifactId));
        } catch (SQLException failure) {
            throw database("read an erasure tombstone", failure);
        }
    }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) {
            state.release();
            if (reviewState != null) reviewState.close();
        }
    }

    // ------------------------------------------------------------------------------ metadata removal (phase 1)

    private Map<String, Object> removeMetadata(Connection connection, String tenantId, String principalId,
                                               Map<String, Node> tree) throws SQLException {
        Set<String> ids = tree.keySet();
        Map<String, Object> manifest = new LinkedHashMap<>();
        manifest.put("version", 1);
        Map<String, Integer> records = new TreeMap<>();

        // Objects: only an object no surviving artifact still references is deleted.
        List<Map<String, Object>> objects = new ArrayList<>();
        Map<String, Long> treeReferences = new LinkedHashMap<>();
        Map<String, Node> firstByReference = new LinkedHashMap<>();
        for (Node node : tree.values()) {
            treeReferences.merge(node.objectReference(), 1L, Long::sum);
            firstByReference.putIfAbsent(node.objectReference(), node);
        }
        for (Map.Entry<String, Long> entry : treeReferences.entrySet()) {
            if (survivingReferences(connection, entry.getKey(), entry.getValue(), ids)) continue;
            Node node = firstByReference.get(entry.getKey());
            objects.add(item("S3_OBJECT", node.objectKey(), node.sha256()));
        }

        // Upload sessions of the tree and their staged chunk objects.
        List<String> uploadIds = new ArrayList<>();
        try (PreparedStatement sessions = connection.prepareStatement(
                "SELECT upload_id FROM media_upload_sessions WHERE tenant_id=? AND artifact_id=?")) {
            for (String id : ids) {
                sessions.setString(1, tenantId); sessions.setString(2, id);
                try (ResultSet rows = sessions.executeQuery()) {
                    while (rows.next()) uploadIds.add(rows.getString(1));
                }
            }
        }
        try (PreparedStatement chunks = connection.prepareStatement(
                "SELECT object_key,sha256 FROM media_upload_chunks WHERE tenant_id=? AND upload_id=?")) {
            for (String uploadId : uploadIds) {
                chunks.setString(1, tenantId); chunks.setString(2, uploadId);
                try (ResultSet rows = chunks.executeQuery()) {
                    while (rows.next()) objects.add(item("UPLOAD_CHUNK_OBJECT", rows.getString(1), rows.getString(2)));
                }
            }
        }

        // Delivery operations (and the delivered copies the host must remove).
        List<Map<String, Object>> deliveries = new ArrayList<>();
        try (PreparedStatement select = connection.prepareStatement(
                "SELECT principal_id,request_id FROM media_delivery_operations WHERE tenant_id=? AND artifact_id=?")) {
            for (String id : ids) {
                select.setString(1, tenantId); select.setString(2, id);
                try (ResultSet rows = select.executeQuery()) {
                    while (rows.next()) {
                        Map<String, Object> delivery = new LinkedHashMap<>();
                        delivery.put("principalId", rows.getString(1));
                        delivery.put("requestId", rows.getString(2));
                        deliveries.add(delivery);
                    }
                }
            }
        }
        records.put("DELIVERY_RECORD", deleteByIds(connection, "media_delivery_operations", "artifact_id", tenantId, ids));
        records.put("CAPTION_REGISTRATION",
                deleteByIds(connection, "media_caption_registrations", "source_artifact_id", tenantId, ids));
        records.put("TRANSCRIPT_REVISION",
                deleteByIds(connection, "media_transcript_revisions", "source_artifact_id", tenantId, ids));
        int lineage = deleteByIds(connection, "media_artifact_lineage", "source_artifact_id", tenantId, ids);
        lineage += deleteByIds(connection, "media_artifact_lineage", "derived_artifact_id", tenantId, ids);
        records.put("LINEAGE_RECORD", lineage);
        records.put("REQUEST_LEDGER_ROW", eraseLedgerRows(connection, tenantId, ids));
        records.put("REVIEW_RECORD", eraseReviewRows(connection, tenantId, ids));
        records.put("UPLOAD_SESSION", deleteByIds(connection, "media_upload_sessions", "artifact_id", tenantId, ids));
        // DEV_ONLY versioned-intake rows (ids, digest, media probe) must not outlive their erased artifact.
        deleteByIds(connection, "media_dev_artifact_versions", "artifact_id", tenantId, ids);

        // Artifacts last: lineage, transcripts and verifications no longer reference them.
        int removed = 0;
        try (PreparedStatement delete = connection.prepareStatement(
                "DELETE FROM media_artifacts WHERE tenant_id=? AND artifact_id=? AND principal_id=?")) {
            for (String id : ids) {
                delete.setString(1, tenantId); delete.setString(2, id); delete.setString(3, principalId);
                removed += delete.executeUpdate();
            }
        }
        if (removed != ids.size()) throw new IllegalStateException("artifact tree changed during its erasure");

        List<Map<String, Object>> artifacts = new ArrayList<>();
        for (Node node : tree.values()) {
            Map<String, Object> artifact = new LinkedHashMap<>();
            artifact.put("artifactId", node.id()); artifact.put("kind", node.kind());
            artifact.put("sha256", node.sha256()); artifact.put("contentType", node.contentType());
            artifact.put("sizeBytes", node.size());
            artifacts.add(artifact);
        }
        manifest.put("artifacts", artifacts);
        manifest.put("objects", objects);
        manifest.put("deliveries", deliveries);
        manifest.put("records", records);
        manifest.put("reviewSubjectIds", new ArrayList<>(ids));
        return manifest;
    }

    private boolean survivingReferences(Connection connection, String reference, long inTree, Set<String> ids)
            throws SQLException {
        try (PreparedStatement count = connection.prepareStatement(
                "SELECT COUNT(*) FROM media_artifacts WHERE object_reference=?")) {
            count.setString(1, reference);
            try (ResultSet rows = count.executeQuery()) {
                rows.next();
                return rows.getLong(1) > inTree;
            }
        }
    }

    private int deleteByIds(Connection connection, String table, String column, String tenantId, Collection<String> ids)
            throws SQLException {
        int removed = 0;
        try (PreparedStatement delete = connection.prepareStatement(
                "DELETE FROM " + table + " WHERE tenant_id=? AND " + column + "=?")) {
            for (String id : ids) {
                delete.setString(1, tenantId); delete.setString(2, id);
                removed += delete.executeUpdate();
            }
        }
        return removed;
    }

    /** Completed ledger rows whose registered output names an erased artifact now answer "erased" forever. */
    private int eraseLedgerRows(Connection connection, String tenantId, Set<String> ids) throws SQLException {
        Set<String> matched = new LinkedHashSet<>();
        List<String[]> rowKeys = new ArrayList<>();
        try (PreparedStatement select = connection.prepareStatement(
                "SELECT principal_id,lane,request_id,outputs_json FROM media_dev_request_ledger "
                        + "WHERE tenant_id=? AND state='COMPLETED' AND outputs_json LIKE ?")) {
            for (String id : ids) {
                select.setString(1, tenantId); select.setString(2, "%\"artifactId\":\"" + id + "\"%");
                try (ResultSet rows = select.executeQuery()) {
                    while (rows.next()) {
                        for (Map<String, Object> output : state.mapper().readValue(rows.getString(4), LIST)) {
                            if (ids.contains(String.valueOf(output.get("artifactId")))) {
                                String composite = rows.getString(1) + "\u0000" + rows.getString(2) + "\u0000" + rows.getString(3);
                                if (matched.add(composite)) rowKeys.add(new String[] {rows.getString(1), rows.getString(2), rows.getString(3)});
                            }
                        }
                    }
                }
            }
        }
        int changed = 0;
        try (PreparedStatement update = connection.prepareStatement(
                "UPDATE media_dev_request_ledger SET state='ERASED',outputs_json='[]',completed_at=NULL,updated_at=? "
                        + "WHERE tenant_id=? AND principal_id=? AND lane=? AND request_id=? AND state='COMPLETED'")) {
            for (String[] key : rowKeys) {
                update.setTimestamp(1, Timestamp.from(clock.instant()));
                update.setString(2, tenantId); update.setString(3, key[0]); update.setString(4, key[1]);
                update.setString(5, key[2]);
                changed += update.executeUpdate();
            }
        }
        return changed;
    }

    /** Review cases pointing at erased versions, with their records and idempotency rows (canonical schema, if present). */
    private int eraseReviewRows(Connection connection, String tenantId, Collection<String> ids) throws SQLException {
        return eraseReviews(connection, tenantId, ids);
    }

    private int eraseDevReview(String tenantId, List<String> ids) {
        if (reviewState == null) return 0;
        try (Connection connection = reviewState.connection()) {
            connection.setAutoCommit(false);
            try {
                int removed = eraseReviews(connection, tenantId, ids);
                connection.commit();
                return removed;
            } catch (SQLException | RuntimeException failure) {
                rollback(connection, failure);
                throw failure;
            }
        } catch (SQLException failure) {
            throw database("erase DEV_ONLY review records", failure);
        }
    }

    private static int eraseReviews(Connection connection, String tenantId, Collection<String> ids) throws SQLException {
        if (!hasTable(connection, "media_review_cases")) return 0;
        List<String> cases = new ArrayList<>();
        try (PreparedStatement select = connection.prepareStatement(
                "SELECT review_case_id FROM media_review_cases WHERE tenant_id=? AND subject_object_id=?")) {
            for (String id : ids) {
                select.setString(1, tenantId); select.setString(2, id);
                try (ResultSet rows = select.executeQuery()) {
                    while (rows.next()) cases.add(rows.getString(1));
                }
            }
        }
        int removed = cases.size();
        boolean assignments = hasTable(connection, "media_review_assignment_versions");
        for (String caseId : cases) {
            if (assignments) {
                removed += update(connection, "DELETE FROM media_review_assignment_requests WHERE tenant_id=? AND review_case_id=?", tenantId, caseId);
                removed += update(connection, "DELETE FROM media_review_assignment_versions WHERE tenant_id=? AND review_case_id=?", tenantId, caseId);
            }
            update(connection, "DELETE FROM media_review_idempotency WHERE tenant_id=? AND review_case_id=?", tenantId, caseId);
            removed += update(connection, "DELETE FROM media_review_records WHERE tenant_id=? AND review_case_id=?", tenantId, caseId);
            update(connection, "DELETE FROM media_review_cases WHERE tenant_id=? AND review_case_id=?", tenantId, caseId);
        }
        return removed;
    }

    private static int update(Connection connection, String sql, String tenantId, String caseId) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, tenantId); statement.setString(2, caseId);
            return statement.executeUpdate();
        }
    }

    private static boolean hasTable(Connection connection, String table) throws SQLException {
        DatabaseMetaData meta = connection.getMetaData();
        try (ResultSet rows = meta.getTables(connection.getCatalog(), connection.getSchema(), table, new String[] {"TABLE"})) {
            return rows.next();
        }
    }

    // ------------------------------------------------------------------------------------------- tree

    private record Node(String id, String contentType, long size, String sha256, String objectReference,
                        String objectKey, String kind, Set<String> parents) { }

    /** The artifact and everything derived from it, by lineage rows and by lineage metadata references. */
    private Map<String, Node> closure(Connection connection, String tenantId, String principalId, String rootId)
            throws SQLException {
        Map<String, Node> tree = new LinkedHashMap<>();
        Node root = load(connection, tenantId, principalId, rootId, true);
        if (root == null) return tree;
        tree.put(rootId, root);
        ArrayDeque<String> frontier = new ArrayDeque<>(List.of(rootId));
        while (!frontier.isEmpty()) {
            String id = frontier.poll();
            Set<String> children = new LinkedHashSet<>();
            try (PreparedStatement lineage = connection.prepareStatement(
                    "SELECT derived_artifact_id FROM media_artifact_lineage WHERE tenant_id=? AND source_artifact_id=?")) {
                lineage.setString(1, tenantId); lineage.setString(2, id);
                try (ResultSet rows = lineage.executeQuery()) {
                    while (rows.next()) children.add(rows.getString(1));
                }
            }
            try (PreparedStatement scan = connection.prepareStatement(
                    "SELECT artifact_id,metadata_json FROM media_artifacts WHERE tenant_id=? AND principal_id=? "
                            + "AND artifact_id<>? AND metadata_json LIKE ?")) {
                scan.setString(1, tenantId); scan.setString(2, principalId); scan.setString(3, id);
                scan.setString(4, "%" + id + "%");
                try (ResultSet rows = scan.executeQuery()) {
                    while (rows.next()) {
                        if (references(rows.getString(2), id)) children.add(rows.getString(1));
                    }
                }
            }
            for (String child : children) {
                Node known = tree.get(child);
                if (known != null) { known.parents().add(id); continue; }
                Node node = load(connection, tenantId, principalId, child, false);
                if (node == null) continue;
                node.parents().add(id);
                tree.put(child, node);
                frontier.add(child);
                if (tree.size() > MAX_TREE) requireBounded(tree);
            }
        }
        return tree;
    }

    private Node load(Connection connection, String tenantId, String principalId, String artifactId, boolean root)
            throws SQLException {
        try (PreparedStatement select = connection.prepareStatement(
                "SELECT content_type,size_bytes,sha256,object_reference,metadata_json FROM media_artifacts "
                        + "WHERE tenant_id=? AND artifact_id=? AND principal_id=?")) {
            select.setString(1, tenantId); select.setString(2, artifactId); select.setString(3, principalId);
            try (ResultSet rows = select.executeQuery()) {
                if (!rows.next()) return null;
                String reference = rows.getString(4);
                return new Node(artifactId, rows.getString(1), rows.getLong(2), rows.getString(3), reference,
                        objectKey(tenantId, artifactId, rows.getString(3), reference),
                        kind(rows.getString(1), metadata(rows.getString(5)), root), new LinkedHashSet<>());
            }
        }
    }

    private Map<String, Object> metadata(String json) {
        try {
            return json == null || json.isBlank() ? Map.of() : state.mapper().readValue(json, MAP);
        } catch (RuntimeException unreadable) {
            return Map.of();
        }
    }

    private boolean references(String metadataJson, String artifactId) {
        Map<String, Object> metadata = metadata(metadataJson);
        return referencedIds(metadata).contains(artifactId);
    }

    /** Values of artifact-reference fields anywhere in lineage metadata; never an arbitrary string. */
    static Set<String> referencedIds(Object value) {
        Set<String> found = new LinkedHashSet<>();
        collect(value, found);
        return found;
    }

    private static void collect(Object value, Set<String> found) {
        if (value instanceof Map<?, ?> map) {
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                String key = String.valueOf(entry.getKey()).toLowerCase(java.util.Locale.ROOT);
                if (entry.getValue() instanceof String text
                        && (key.endsWith("artifactid") || key.equals("identity"))) {
                    found.add(text);
                } else {
                    collect(entry.getValue(), found);
                }
            }
        } else if (value instanceof Collection<?> list) {
            for (Object item : list) collect(item, found);
        }
    }

    /** Kind taxonomy used in plans and receipts; derived from the lineage metadata the lane registered. */
    static String kind(String contentType, Map<String, Object> metadata, boolean root) {
        String laneKind = metadata.get("kind") instanceof String text ? text : "";
        if (metadata.containsKey("captionSchema")) return "CAPTION_VERSION";
        if (metadata.containsKey("renderSchema")) return "RENDER";
        if (metadata.containsKey("groundedSchema")) return "GROUNDED_ANSWER";
        if (metadata.containsKey("creativeSchema")) return "CREATIVE_OUTPUT";
        switch (laneKind) {
            case "LOCAL_STT_TRANSCRIPT": return "TRANSCRIPT";
            case "LOCAL_STT_WEBVTT_UNREVIEWED": return "WEBVTT";
            case "LOCAL_TTS_AUDIO": return "SYNTHESIZED_AUDIO";
            case "LOCAL_VISION_TRACKS": return "VISION_TRACKS";
            case "LOCAL_VISION_ROI_ANALYSIS": return "VISION_ROI";
            case "LOCAL_VISION_ANALYSIS", "LOCAL_VISION_QUESTION": return "VISION_ANALYSIS";
            default: break;
        }
        if (metadata.containsKey("visionSchema")) return "VISION_ANALYSIS";
        return root ? "SOURCE_ARTIFACT" : "DERIVED_ARTIFACT";
    }

    private static void requireBounded(Map<String, Node> tree) {
        if (tree.size() > MAX_TREE) {
            throw new ErasureRefusedException(422, "ERASURE_TREE_TOO_LARGE",
                    "the lineage tree exceeds the bounded erasure size; nothing was erased", Map.of("maximum", MAX_TREE));
        }
    }

    private ErasureRefusedException missing(Connection connection, String tenantId, String artifactId)
            throws SQLException {
        Tombstone tombstone = tombstoneOf(connection, tenantId, artifactId);
        connection.rollback();
        if (tombstone != null) {
            return new ErasureRefusedException(410, "ARTIFACT_ERASED", "the artifact was erased",
                    Map.of("erasureId", tombstone.erasureId()));
        }
        return new ErasureRefusedException(404, "ARTIFACT_NOT_FOUND",
                "artifact not found in this tenant and owner scope", Map.of());
    }

    private Tombstone tombstoneOf(Connection connection, String tenantId, String artifactId) throws SQLException {
        try (PreparedStatement select = connection.prepareStatement(
                "SELECT erasure_id,kind,sha256,erased_at FROM media_erasure_tombstones WHERE tenant_id=? AND artifact_id=?")) {
            select.setString(1, tenantId); select.setString(2, artifactId);
            try (ResultSet rows = select.executeQuery()) {
                return rows.next() ? new Tombstone(artifactId, rows.getString(1), rows.getString(2), rows.getString(3),
                        rows.getTimestamp(4).toInstant()) : null;
            }
        }
    }

    /** True when an active owner hold covers any of {@code ids}; expiry purge must not delete such a tree. */
    boolean heldByActiveHold(Connection connection, String tenantId, Set<String> ids) throws SQLException {
        return !blockingHolds(connection, tenantId, ids).isEmpty();
    }

    private Map<String, Integer> countDependents(Connection connection, String tenantId, Set<String> ids)
            throws SQLException {
        Map<String, Integer> counts = new LinkedHashMap<>();
        counts.put("DELIVERY_RECORD", countByIds(connection, "media_delivery_operations", "artifact_id", tenantId, ids));
        counts.put("CAPTION_REGISTRATION",
                countByIds(connection, "media_caption_registrations", "source_artifact_id", tenantId, ids));
        counts.put("TRANSCRIPT_REVISION",
                countByIds(connection, "media_transcript_revisions", "source_artifact_id", tenantId, ids));
        counts.put("UPLOAD_SESSION", countByIds(connection, "media_upload_sessions", "artifact_id", tenantId, ids));
        int ledger = 0;
        try (PreparedStatement select = connection.prepareStatement(
                "SELECT outputs_json FROM media_dev_request_ledger WHERE tenant_id=? AND state='COMPLETED' "
                        + "AND outputs_json LIKE ?")) {
            Set<String> seen = new LinkedHashSet<>();
            for (String id : ids) {
                select.setString(1, tenantId); select.setString(2, "%\"artifactId\":\"" + id + "\"%");
                try (ResultSet rows = select.executeQuery()) {
                    while (rows.next()) if (seen.add(rows.getString(1))) ledger++;
                }
            }
        }
        counts.put("REQUEST_LEDGER_ROW", ledger);
        return counts;
    }

    private int countByIds(Connection connection, String table, String column, String tenantId, Set<String> ids)
            throws SQLException {
        int total = 0;
        try (PreparedStatement count = connection.prepareStatement(
                "SELECT COUNT(*) FROM " + table + " WHERE tenant_id=? AND " + column + "=?")) {
            for (String id : ids) {
                count.setString(1, tenantId); count.setString(2, id);
                try (ResultSet rows = count.executeQuery()) {
                    rows.next();
                    total += rows.getInt(1);
                }
            }
        }
        return total;
    }

    // ------------------------------------------------------------------------------------------- holds

    private static final String HOLD_SELECT = "SELECT hold_id,root_artifact_id,reason,placed_by,placed_assurance,"
            + "placed_at,state,released_by,released_assurance,release_reason,released_at,request_fingerprint "
            + "FROM media_legal_holds";

    /** Active holds whose tree overlaps {@code ids}, keyed by hold id. */
    private Map<String, LegalHold> blockingHolds(Connection connection, String tenantId, Set<String> ids)
            throws SQLException {
        Map<String, LegalHold> blocking = new LinkedHashMap<>();
        for (LegalHold hold : activeHolds(connection, tenantId)) {
            Map<String, Node> covered = closure(connection, tenantId, hold.placedBy(), hold.rootArtifactId());
            for (String id : covered.keySet()) {
                if (ids.contains(id)) { blocking.put(hold.holdId(), hold); break; }
            }
        }
        return blocking;
    }

    private List<LegalHold> activeHolds(Connection connection, String tenantId) throws SQLException {
        List<LegalHold> holds = new ArrayList<>();
        try (PreparedStatement select = connection.prepareStatement(HOLD_SELECT
                + " WHERE tenant_id=? AND state='ACTIVE' ORDER BY placed_at")) {
            select.setString(1, tenantId);
            try (ResultSet rows = select.executeQuery()) {
                while (rows.next()) holds.add(hold(rows, false));
            }
        }
        return holds;
    }

    /** Keeps the artifact rows' legacy {@code legal_hold} flag (read by expiry purge) equal to hold coverage. */
    private void syncHoldColumn(Connection connection, String tenantId, Set<String> candidates) throws SQLException {
        Set<String> covered = new LinkedHashSet<>();
        for (LegalHold hold : activeHolds(connection, tenantId)) {
            covered.addAll(closure(connection, tenantId, hold.placedBy(), hold.rootArtifactId()).keySet());
        }
        try (PreparedStatement update = connection.prepareStatement(
                "UPDATE media_artifacts SET legal_hold=? WHERE tenant_id=? AND artifact_id=?")) {
            for (String id : candidates) {
                update.setBoolean(1, covered.contains(id));
                update.setString(2, tenantId); update.setString(3, id);
                update.executeUpdate();
            }
        }
    }

    private LegalHold holdByRequest(Connection connection, String tenantId, String principalId, String requestId,
                                    String fingerprint) throws SQLException {
        try (PreparedStatement select = connection.prepareStatement(HOLD_SELECT
                + " WHERE tenant_id=? AND placed_by=? AND request_id=?")) {
            select.setString(1, tenantId); select.setString(2, principalId); select.setString(3, requestId);
            try (ResultSet rows = select.executeQuery()) {
                if (!rows.next()) return null;
                if (!rows.getString("request_fingerprint").trim().equals(fingerprint)) {
                    throw new ErasureRefusedException(409, "HOLD_REQUEST_REUSED",
                            "requestId was already used for a different hold", Map.of());
                }
                return hold(rows, true);
            }
        }
    }

    private LegalHold loadHold(Connection connection, String tenantId, String holdId, boolean lock) throws SQLException {
        try (PreparedStatement select = connection.prepareStatement(HOLD_SELECT
                + " WHERE tenant_id=? AND hold_id=?" + (lock ? " FOR UPDATE" : ""))) {
            select.setString(1, tenantId); select.setString(2, holdId);
            try (ResultSet rows = select.executeQuery()) {
                return rows.next() ? hold(rows, false) : null;
            }
        }
    }

    private static LegalHold hold(ResultSet rows, boolean replayed) throws SQLException {
        Timestamp released = rows.getTimestamp("released_at");
        String releasedAssurance = rows.getString("released_assurance");
        return new LegalHold(rows.getString("hold_id"), rows.getString("root_artifact_id"), rows.getString("reason"),
                rows.getString("placed_by"), AssuranceSource.valueOf(rows.getString("placed_assurance")),
                rows.getTimestamp("placed_at").toInstant(), HoldState.valueOf(rows.getString("state")),
                rows.getString("released_by"),
                releasedAssurance == null ? null : AssuranceSource.valueOf(releasedAssurance),
                rows.getString("release_reason"), released == null ? null : released.toInstant(), replayed);
    }

    // -------------------------------------------------------------------------------- operation rows

    private record OperationRow(String tenantId, String erasureId, String principalId, String rootArtifactId, Phase phase,
                                Map<String, Object> manifest, Instant requestedAt, Instant completedAt,
                                String receiptJson) {
        ErasureOperation operation(boolean resumed) {
            List<String> artifactIds = new ArrayList<>();
            List<String> digests = new ArrayList<>();
            for (Map<String, Object> artifact : listOf(manifest.get("artifacts"))) {
                artifactIds.add(String.valueOf(artifact.get("artifactId")));
                digests.add(String.valueOf(artifact.get("sha256")));
            }
            for (Map<String, Object> object : objects(manifest)) digests.add(String.valueOf(object.get("sha256")));
            List<DeliveryRef> deliveries = new ArrayList<>();
            for (Map<String, Object> delivery : listOf(manifest.get("deliveries"))) {
                deliveries.add(new DeliveryRef(String.valueOf(delivery.get("principalId")),
                        String.valueOf(delivery.get("requestId"))));
            }
            return new ErasureOperation(tenantId, erasureId, principalId, rootArtifactId, phase,
                    new LocalWork(artifactIds, digests.stream().distinct().toList(), deliveries), resumed);
        }
    }

    private OperationRow loadOperation(Connection connection, String tenantId, String erasureId) throws SQLException {
        try (PreparedStatement select = connection.prepareStatement(
                "SELECT principal_id,root_artifact_id,state,manifest_json,requested_at,completed_at,receipt_json "
                        + "FROM media_erasure_operations WHERE tenant_id=? AND erasure_id=?")) {
            select.setString(1, tenantId); select.setString(2, erasureId);
            try (ResultSet rows = select.executeQuery()) {
                if (!rows.next()) return null;
                Timestamp completed = rows.getTimestamp(6);
                return new OperationRow(tenantId, erasureId, rows.getString(1), rows.getString(2),
                        Phase.valueOf(rows.getString(3)), state.mapper().readValue(rows.getString(4), MAP),
                        rows.getTimestamp(5).toInstant(), completed == null ? null : completed.toInstant(),
                        rows.getString(7));
            }
        }
    }

    // ------------------------------------------------------------------------------------- receipts

    private static ErasureReceipt receiptOf(OperationRow row) {
        Map<String, List<String>> digestsByKind = new TreeMap<>();
        Map<String, Integer> countsByKind = new TreeMap<>();
        for (Map<String, Object> artifact : listOf(row.manifest().get("artifacts"))) {
            String kind = String.valueOf(artifact.get("kind"));
            countsByKind.merge(kind, 1, Integer::sum);
            digestsByKind.computeIfAbsent(kind, ignored -> new ArrayList<>()).add(String.valueOf(artifact.get("sha256")));
        }
        List<ReceiptItem> items = new ArrayList<>();
        for (Map.Entry<String, Integer> entry : countsByKind.entrySet()) {
            items.add(new ReceiptItem(entry.getKey(), entry.getValue(), digestsByKind.get(entry.getKey())));
        }
        Map<String, List<String>> objectDigests = new TreeMap<>();
        for (Map<String, Object> object : objects(row.manifest())) {
            objectDigests.computeIfAbsent(String.valueOf(object.get("kind")), ignored -> new ArrayList<>())
                    .add(String.valueOf(object.get("sha256")));
        }
        for (Map.Entry<String, List<String>> entry : objectDigests.entrySet()) {
            items.add(new ReceiptItem(entry.getKey(), entry.getValue().size(), entry.getValue()));
        }
        if (row.manifest().get("records") instanceof Map<?, ?> records) {
            for (Map.Entry<?, ?> entry : new TreeMap<>(records).entrySet()) {
                int count = ((Number) entry.getValue()).intValue();
                if (count > 0) items.add(new ReceiptItem(String.valueOf(entry.getKey()), count, List.of()));
            }
        }
        Object devReview = row.manifest().get("reviewDevRemoved");
        if (devReview instanceof Number number && number.intValue() > 0) {
            items.add(new ReceiptItem("DEV_REVIEW_RECORD", number.intValue(), List.of()));
        }
        for (Map<String, Object> local : listOf(row.manifest().get("local"))) {
            items.add(new ReceiptItem(String.valueOf(local.get("kind")), ((Number) local.get("count")).intValue(),
                    stringList(local.get("digests"))));
        }
        return new ErasureReceipt(row.erasureId(), row.rootArtifactId(), row.phase(), row.principalId(),
                row.requestedAt(), row.completedAt(), items);
    }

    private static Map<String, Object> receiptView(ErasureReceipt receipt) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("erasureId", receipt.erasureId());
        view.put("rootArtifactId", receipt.rootArtifactId());
        view.put("phase", receipt.phase().name());
        List<Map<String, Object>> items = new ArrayList<>();
        for (ReceiptItem item : receipt.items()) items.add(item(item.kind(), item.count(), item.digests()));
        view.put("items", items);
        return view;
    }

    private static Map<String, Object> item(String kind, int count, List<String> digests) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("kind", kind); item.put("count", count); item.put("digests", digests);
        return item;
    }

    private static Map<String, Object> item(String kind, String key, String sha256) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("kind", kind); item.put("key", key); item.put("sha256", sha256);
        return item;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> listOf(Object value) {
        return value instanceof List<?> list ? (List<Map<String, Object>>) list : List.of();
    }

    private static List<Map<String, Object>> objects(Map<String, Object> manifest) {
        return listOf(manifest.get("objects"));
    }

    private static List<String> stringList(Object value) {
        List<String> list = new ArrayList<>();
        if (value instanceof List<?> items) for (Object item : items) list.add(String.valueOf(item));
        return list;
    }

    // ---------------------------------------------------------------------------------------- plumbing

    private boolean present(String key) {
        try {
            state.s3().headObject(HeadObjectRequest.builder().bucket(state.bucket()).key(key).build());
            return true;
        } catch (NoSuchKeyException absent) {
            return false;
        } catch (S3Exception failure) {
            if (failure.statusCode() == 404) return false;
            throw failure;
        }
    }

    private String objectKey(String tenantId, String artifactId, String sha256, String objectReference) {
        try {
            return MediaArtifactObjectOwnership.tenantOwnedArtifactKey(objectReference, state.bucket(),
                    state.key("quarantine/finalized/"), state.key("quarantine/derived/"),
                    tenantId, artifactId, sha256);
        } catch (SecurityException unowned) {
            throw new IllegalStateException(unowned.getMessage(), unowned);
        }
    }

    private void requireAssurance(AssuranceSource assurance) {
        Objects.requireNonNull(assurance, "assurance");
        if (requireOidc && assurance != AssuranceSource.OIDC_VERIFIED) {
            throw new ErasureRefusedException(403, "IDENTITY_ASSURANCE_REQUIRED",
                    "this profile requires an identity-provider verified principal for holds and erasure",
                    Map.of("required", AssuranceSource.OIDC_VERIFIED.name()));
        }
    }

    private static String requireText(String value, String name, int max) {
        if (value == null || value.isBlank() || value.length() > max) {
            throw new IllegalArgumentException(name + " must be 1-" + max + " characters");
        }
        return value.strip();
    }

    private static String requireId(String value, String name) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
            throw new IllegalArgumentException(name + " must be a 1-128 character opaque id");
        }
        return value;
    }

    private static String sha256Hex(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    private static void rollback(Connection connection, Exception failure) {
        try { connection.rollback(); } catch (SQLException rollbackFailure) { failure.addSuppressed(rollbackFailure); }
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("Media erasure authority is closed");
        if (!state.ready()) throw new IllegalStateException("Media erasure state is unavailable");
    }

    private static IllegalStateException database(String operation, SQLException failure) {
        return new IllegalStateException("Unable to " + operation, failure);
    }
}
