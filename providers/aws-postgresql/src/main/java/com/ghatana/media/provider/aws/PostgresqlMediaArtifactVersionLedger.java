package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaArtifactVersionLedgerContracts.LineageOwnershipException;
import com.ghatana.media.runtime.MediaArtifactVersionLedgerContracts.Registration;
import com.ghatana.media.runtime.MediaArtifactVersionLedgerContracts.Version;
import com.ghatana.media.runtime.MediaArtifactVersionLedgerContracts.VersionLedger;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Durable DEV_ONLY artifact version ledger (V040). Version numbers are allocated inside one transaction as
 * {@code MAX(version_number)+1} and protected by the primary key: two concurrent registrants cannot both take a
 * number, and the loser retries and then sees the winner's row (deduplicating when it holds the same content).
 */
public final class PostgresqlMediaArtifactVersionLedger implements VersionLedger {
    private static final int ATTEMPTS = 5;
    private static final String COLUMNS = "tenant_id,principal_id,lineage_id,version_number,artifact_id,"
            + "artifact_version_id,content_sha256,size_bytes,parent_artifact_version_id,probe_json,created_at";

    private final MediaAwsPostgresqlRuntimeState state;
    private final Clock clock;
    private final AtomicBoolean closed = new AtomicBoolean();

    public PostgresqlMediaArtifactVersionLedger() { this(MediaAwsPostgresqlRuntimeState.acquire(), Clock.systemUTC()); }

    PostgresqlMediaArtifactVersionLedger(MediaAwsPostgresqlRuntimeState state, Clock clock) {
        this.state = Objects.requireNonNull(state, "state");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    @Override public String ledgerId() { return "postgresql-media-artifact-version-ledger"; }

    @Override public boolean ready() { return !closed.get() && state.ready(); }

    @Override
    public Registration register(String tenantId, String principalId, String lineageId, String artifactId,
                                 String artifactVersionId, String contentSha256, long sizeBytes, String probeJson) {
        ensureOpen();
        SQLException last = null;
        for (int attempt = 0; attempt < ATTEMPTS; attempt++) {
            try (Connection connection = state.connection()) {
                connection.setAutoCommit(false);
                try {
                    Registration result = registerOnce(connection, tenantId, principalId, lineageId, artifactId,
                            artifactVersionId, contentSha256, sizeBytes, probeJson);
                    connection.commit();
                    return result;
                } catch (SQLException | RuntimeException failure) {
                    try { connection.rollback(); } catch (SQLException ignored) { }
                    throw failure;
                }
            } catch (SQLException failure) {
                last = failure;
                // 23xxx: integrity violation (a concurrent registrant took the number); anything else is not retried.
                if (failure.getSQLState() == null || !failure.getSQLState().startsWith("23")) break;
            }
        }
        throw new IllegalStateException("artifact version ledger register failed", last);
    }

    private Registration registerOnce(Connection connection, String tenantId, String principalId, String lineageId,
                                      String artifactId, String artifactVersionId, String contentSha256,
                                      long sizeBytes, String probeJson) throws SQLException {
        List<Version> existing = load(connection, tenantId, lineageId);
        if (!existing.isEmpty()) {
            if (!existing.get(0).principalId().equals(principalId)) throw new LineageOwnershipException();
            for (Version version : existing) {
                if (version.artifactVersionId().equals(artifactVersionId)) return new Registration(version, true);
            }
        }
        int next = existing.isEmpty() ? 1 : existing.get(existing.size() - 1).versionNumber() + 1;
        String parent = existing.isEmpty() ? null : existing.get(existing.size() - 1).artifactVersionId();
        Timestamp now = Timestamp.from(clock.instant());
        try (PreparedStatement insert = connection.prepareStatement(
                "INSERT INTO media_dev_artifact_versions (" + COLUMNS + ") VALUES (?,?,?,?,?,?,?,?,?,?,?)")) {
            insert.setString(1, tenantId);
            insert.setString(2, principalId);
            insert.setString(3, lineageId);
            insert.setInt(4, next);
            insert.setString(5, artifactId);
            insert.setString(6, artifactVersionId);
            insert.setString(7, contentSha256);
            insert.setLong(8, sizeBytes);
            insert.setString(9, parent);
            insert.setString(10, probeJson);
            insert.setTimestamp(11, now);
            insert.executeUpdate();
        }
        return new Registration(new Version(tenantId, principalId, lineageId, next, artifactId, artifactVersionId,
                contentSha256, sizeBytes, parent, probeJson, now.toInstant()), false);
    }

    @Override
    public List<Version> versions(String tenantId, String principalId, String lineageId) {
        ensureOpen();
        try (Connection connection = state.connection()) {
            List<Version> all = load(connection, tenantId, lineageId);
            return all.isEmpty() || !all.get(0).principalId().equals(principalId) ? List.of() : all;
        } catch (SQLException failure) {
            throw new IllegalStateException("artifact version ledger read failed", failure);
        }
    }

    @Override
    public Optional<Version> find(String tenantId, String principalId, String lineageId, String artifactVersionId) {
        return versions(tenantId, principalId, lineageId).stream()
                .filter(version -> version.artifactVersionId().equals(artifactVersionId)).findFirst();
    }

    @Override
    public List<String> lineagesHolding(String tenantId, String principalId, String artifactId,
                                        String artifactVersionId) {
        ensureOpen();
        try (Connection connection = state.connection();
             PreparedStatement select = connection.prepareStatement("SELECT DISTINCT lineage_id FROM "
                     + "media_dev_artifact_versions WHERE tenant_id=? AND principal_id=? AND artifact_id=? "
                     + "AND artifact_version_id=? ORDER BY lineage_id")) {
            select.setString(1, tenantId);
            select.setString(2, principalId);
            select.setString(3, artifactId);
            select.setString(4, artifactVersionId);
            List<String> out = new ArrayList<>();
            try (ResultSet rows = select.executeQuery()) {
                while (rows.next()) out.add(rows.getString(1));
            }
            return out;
        } catch (SQLException failure) {
            throw new IllegalStateException("artifact version ledger read failed", failure);
        }
    }

    private static List<Version> load(Connection connection, String tenantId, String lineageId) throws SQLException {
        List<Version> out = new ArrayList<>();
        try (PreparedStatement select = connection.prepareStatement("SELECT " + COLUMNS
                + " FROM media_dev_artifact_versions WHERE tenant_id=? AND lineage_id=? ORDER BY version_number")) {
            select.setString(1, tenantId);
            select.setString(2, lineageId);
            try (ResultSet rows = select.executeQuery()) {
                while (rows.next()) {
                    out.add(new Version(rows.getString(1), rows.getString(2), rows.getString(3), rows.getInt(4),
                            rows.getString(5), rows.getString(6), rows.getString(7).trim(), rows.getLong(8),
                            rows.getString(9), rows.getString(10), rows.getTimestamp(11).toInstant()));
                }
            }
        }
        return out;
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("artifact version ledger is closed");
    }

    @Override public void close() {
        if (closed.compareAndSet(false, true)) state.release();
    }
}
