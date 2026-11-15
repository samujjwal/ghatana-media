package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.Appended;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.Kind;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.LineageExistsException;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.Proposal;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.RegionEditLedger;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.StaleHeadException;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.Version;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Durable DEV_ONLY region edit ledger (V042). The version number is the compare-and-set: an append inserts
 * {@code expectedHead + 1} after reading the head in the same transaction, and the primary key makes a second
 * concurrent appender of the same head fail with an integrity violation; the loser then re-reads and reports the stale
 * head (or the version its own request id already produced).
 */
public final class PostgresqlMediaRegionEditLedger implements RegionEditLedger {
    private static final int ATTEMPTS = 5;
    private static final String COLUMNS = "tenant_id,principal_id,lineage_id,version_number,kind,request_id,artifact_id,"
            + "artifact_version_id,content_sha256,size_bytes,manifest_artifact_id,manifest_artifact_version_id,"
            + "parent_version_number,restores_version_number,detail_json,created_at";

    private final MediaAwsPostgresqlRuntimeState state;
    private final Clock clock;
    private final AtomicBoolean closed = new AtomicBoolean();

    public PostgresqlMediaRegionEditLedger() { this(MediaAwsPostgresqlRuntimeState.acquire(), Clock.systemUTC()); }

    PostgresqlMediaRegionEditLedger(MediaAwsPostgresqlRuntimeState state, Clock clock) {
        this.state = Objects.requireNonNull(state, "state");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    @Override public String ledgerId() { return "postgresql-media-region-edit-ledger"; }

    @Override public boolean ready() { return !closed.get() && state.ready(); }

    @Override
    public Appended createLineage(String tenantId, String principalId, String lineageId, String requestId,
                                  String artifactId, String artifactVersionId, String contentSha256, long sizeBytes,
                                  String detailJson) {
        ensureOpen();
        return transact(connection -> {
            List<Version> existing = load(connection, tenantId, lineageId);
            if (!existing.isEmpty()) {
                Version base = existing.get(0);
                if (!base.principalId().equals(principalId) || !base.artifactVersionId().equals(artifactVersionId)
                        || !base.artifactId().equals(artifactId)) {
                    throw new LineageExistsException();
                }
                return new Appended(base, true);
            }
            Version base = new Version(tenantId, principalId, lineageId, 1, Kind.BASE, requestId, artifactId,
                    artifactVersionId, contentSha256, sizeBytes, null, null, null, null, detailJson,
                    clock.instant());
            insert(connection, base);
            return new Appended(base, false);
        });
    }

    @Override
    public Appended append(String tenantId, String principalId, String lineageId, int expectedHead, Proposal proposal) {
        ensureOpen();
        return transact(connection -> {
            List<Version> rows = load(connection, tenantId, lineageId);
            if (rows.isEmpty() || !rows.get(0).principalId().equals(principalId)) {
                throw new IllegalStateException("lineage does not exist for this principal");
            }
            for (Version version : rows) {
                if (version.requestId().equals(proposal.requestId())) return new Appended(version, true);
            }
            int head = rows.get(rows.size() - 1).versionNumber();
            if (head != expectedHead) throw new StaleHeadException(expectedHead, head);
            Version next = new Version(tenantId, principalId, lineageId, head + 1, proposal.kind(),
                    proposal.requestId(), proposal.artifactId(), proposal.artifactVersionId(),
                    proposal.contentSha256(), proposal.sizeBytes(), proposal.manifestArtifactId(),
                    proposal.manifestArtifactVersionId(), head, proposal.restoresVersionNumber(),
                    proposal.detailJson(), clock.instant());
            insert(connection, next);
            return new Appended(next, false);
        });
    }

    /** Runs {@code work} in one transaction, retrying when a concurrent writer took the primary key (SQLState 23xxx). */
    private Appended transact(SqlWork work) {
        SQLException last = null;
        for (int attempt = 0; attempt < ATTEMPTS; attempt++) {
            try (Connection connection = state.connection()) {
                connection.setAutoCommit(false);
                try {
                    Appended result = work.run(connection);
                    connection.commit();
                    return result;
                } catch (SQLException | RuntimeException failure) {
                    try { connection.rollback(); } catch (SQLException ignored) { }
                    throw failure;
                }
            } catch (SQLException failure) {
                last = failure;
                if (failure.getSQLState() == null || !failure.getSQLState().startsWith("23")) break;
            }
        }
        throw new IllegalStateException("region edit ledger write failed", last);
    }

    private interface SqlWork {
        Appended run(Connection connection) throws SQLException;
    }

    private static void insert(Connection connection, Version version) throws SQLException {
        try (PreparedStatement insert = connection.prepareStatement(
                "INSERT INTO media_dev_region_edit_versions (" + COLUMNS + ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")) {
            insert.setString(1, version.tenantId());
            insert.setString(2, version.principalId());
            insert.setString(3, version.lineageId());
            insert.setInt(4, version.versionNumber());
            insert.setString(5, version.kind().name());
            insert.setString(6, version.requestId());
            insert.setString(7, version.artifactId());
            insert.setString(8, version.artifactVersionId());
            insert.setString(9, version.contentSha256());
            insert.setLong(10, version.sizeBytes());
            insert.setString(11, version.manifestArtifactId());
            insert.setString(12, version.manifestArtifactVersionId());
            setInt(insert, 13, version.parentVersionNumber());
            setInt(insert, 14, version.restoresVersionNumber());
            insert.setString(15, version.detailJson());
            insert.setTimestamp(16, Timestamp.from(version.createdAt()));
            insert.executeUpdate();
        }
    }

    private static void setInt(PreparedStatement statement, int index, Integer value) throws SQLException {
        if (value == null) statement.setNull(index, Types.INTEGER);
        else statement.setInt(index, value);
    }

    @Override
    public List<Version> versions(String tenantId, String principalId, String lineageId) {
        ensureOpen();
        try (Connection connection = state.connection()) {
            List<Version> all = load(connection, tenantId, lineageId);
            return all.isEmpty() || !all.get(0).principalId().equals(principalId) ? List.of() : all;
        } catch (SQLException failure) {
            throw new IllegalStateException("region edit ledger read failed", failure);
        }
    }

    private static List<Version> load(Connection connection, String tenantId, String lineageId) throws SQLException {
        List<Version> out = new ArrayList<>();
        try (PreparedStatement select = connection.prepareStatement("SELECT " + COLUMNS
                + " FROM media_dev_region_edit_versions WHERE tenant_id=? AND lineage_id=? ORDER BY version_number")) {
            select.setString(1, tenantId);
            select.setString(2, lineageId);
            try (ResultSet rows = select.executeQuery()) {
                while (rows.next()) {
                    int parent = rows.getInt(13);
                    Integer parentValue = rows.wasNull() ? null : parent;
                    int restores = rows.getInt(14);
                    Integer restoresValue = rows.wasNull() ? null : restores;
                    out.add(new Version(rows.getString(1), rows.getString(2), rows.getString(3), rows.getInt(4),
                            Kind.valueOf(rows.getString(5)), rows.getString(6), rows.getString(7), rows.getString(8),
                            rows.getString(9).trim(), rows.getLong(10), rows.getString(11), rows.getString(12),
                            parentValue, restoresValue, rows.getString(15), rows.getTimestamp(16).toInstant()));
                }
            }
        }
        return out;
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("region edit ledger is closed");
    }

    @Override public void close() {
        if (closed.compareAndSet(false, true)) state.release();
    }
}
