package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaHeadLedgerContracts.Applied;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.Event;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.HeadLedger;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.HeadState;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.Kind;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.Planner;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Durable DEV_ONLY head ledger (V041). Every operation reads the lineage log, decides with the shared
 * {@link Planner}, and appends at {@code max(seq)+1}; the primary key and the per-lineage request-id uniqueness make
 * concurrent writers lose with an integrity violation, after which they re-read and (when the same request already
 * won) replay it.
 */
public final class PostgresqlMediaHeadLedger implements HeadLedger {
    private static final int ATTEMPTS = 5;
    private static final String COLUMNS = "tenant_id,principal_id,lineage_id,seq,kind,request_id,artifact_id,"
            + "artifact_version_id,report_artifact_id,undoes_seq,created_at";

    private final MediaAwsPostgresqlRuntimeState state;
    private final Clock clock;
    private final AtomicBoolean closed = new AtomicBoolean();

    public PostgresqlMediaHeadLedger() { this(MediaAwsPostgresqlRuntimeState.acquire(), Clock.systemUTC()); }

    PostgresqlMediaHeadLedger(MediaAwsPostgresqlRuntimeState state, Clock clock) {
        this.state = Objects.requireNonNull(state, "state");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    @Override public String ledgerId() { return "postgresql-media-head-ledger"; }

    @Override public boolean ready() { return !closed.get() && state.ready(); }

    private interface Decision { Planner.Plan decide(List<Event> log); }

    @Override
    public Applied apply(String tenantId, String principalId, String lineageId, String requestId,
                         String baseArtifactId, String baseVersion, String artifactId, String version,
                         String reportArtifactId) {
        return execute(tenantId, lineageId, log -> Planner.apply(log, tenantId, principalId, lineageId, requestId,
                baseArtifactId, baseVersion, artifactId, version, reportArtifactId, clock.instant()));
    }

    @Override
    public Applied undo(String tenantId, String principalId, String lineageId, String requestId,
                        String expectedHeadVersionId) {
        return execute(tenantId, lineageId, log -> Planner.undo(log, tenantId, principalId, lineageId, requestId,
                expectedHeadVersionId, clock.instant()));
    }

    private Applied execute(String tenantId, String lineageId, Decision decision) {
        ensureOpen();
        SQLException last = null;
        for (int attempt = 0; attempt < ATTEMPTS; attempt++) {
            try (Connection connection = state.connection()) {
                connection.setAutoCommit(false);
                try {
                    List<Event> log = load(connection, tenantId, lineageId);
                    Planner.Plan plan = decision.decide(log);
                    if (plan.replayed()) {
                        connection.rollback();
                        return new Applied(plan.recorded(), HeadState.of(log), true);
                    }
                    for (Event event : plan.toAppend()) insert(connection, event);
                    connection.commit();
                    List<Event> after = new ArrayList<>(log);
                    after.addAll(plan.toAppend());
                    return new Applied(after.getLast(), HeadState.of(after), false);
                } catch (SQLException | RuntimeException failure) {
                    try { connection.rollback(); } catch (SQLException ignored) { }
                    throw failure;
                }
            } catch (SQLException failure) {
                last = failure;
                // 23xxx: a concurrent writer took the sequence number or the requestId; re-read and decide again.
                if (failure.getSQLState() == null || !failure.getSQLState().startsWith("23")) break;
            }
        }
        throw new IllegalStateException("head ledger write failed", last);
    }

    private static void insert(Connection connection, Event event) throws SQLException {
        try (PreparedStatement insert = connection.prepareStatement(
                "INSERT INTO media_dev_head_events (" + COLUMNS + ") VALUES (?,?,?,?,?,?,?,?,?,?,?)")) {
            insert.setString(1, event.tenantId());
            insert.setString(2, event.principalId());
            insert.setString(3, event.lineageId());
            insert.setInt(4, event.seq());
            insert.setString(5, event.kind().name());
            insert.setString(6, event.requestId());
            insert.setString(7, event.artifactId());
            insert.setString(8, event.artifactVersionId());
            insert.setString(9, event.reportArtifactId());
            if (event.undoesSeq() == null) insert.setNull(10, java.sql.Types.INTEGER);
            else insert.setInt(10, event.undoesSeq());
            insert.setTimestamp(11, Timestamp.from(event.createdAt()));
            insert.executeUpdate();
        }
    }

    @Override
    public List<Event> events(String tenantId, String principalId, String lineageId) {
        ensureOpen();
        try (Connection connection = state.connection()) {
            List<Event> all = load(connection, tenantId, lineageId);
            return all.isEmpty() || !all.getFirst().principalId().equals(principalId) ? List.of() : all;
        } catch (SQLException failure) {
            throw new IllegalStateException("head ledger read failed", failure);
        }
    }

    private static List<Event> load(Connection connection, String tenantId, String lineageId) throws SQLException {
        List<Event> out = new ArrayList<>();
        try (PreparedStatement select = connection.prepareStatement("SELECT " + COLUMNS
                + " FROM media_dev_head_events WHERE tenant_id=? AND lineage_id=? ORDER BY seq")) {
            select.setString(1, tenantId);
            select.setString(2, lineageId);
            try (ResultSet rows = select.executeQuery()) {
                while (rows.next()) {
                    int undoes = rows.getInt(10);
                    Integer undoesSeq = rows.wasNull() ? null : undoes;
                    out.add(new Event(rows.getString(1), rows.getString(2), rows.getString(3), rows.getInt(4),
                            Kind.valueOf(rows.getString(5)), rows.getString(6), rows.getString(7), rows.getString(8),
                            rows.getString(9), undoesSeq, rows.getTimestamp(11).toInstant()));
                }
            }
        }
        return out;
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("head ledger is closed");
    }

    @Override public void close() {
        if (closed.compareAndSet(false, true)) state.release();
    }
}
