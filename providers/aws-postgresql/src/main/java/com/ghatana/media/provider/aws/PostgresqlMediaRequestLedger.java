package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRequestLedgerContracts;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Acquired;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Claim;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Entry;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.InProgress;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Key;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Mismatch;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Replay;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.RequestLedger;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.State;
import tools.jackson.core.type.TypeReference;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Durable DEV_ONLY request ledger over the canonical Media PostgreSQL schema (V038). A claim locks the key's row
 * ({@code SELECT ... FOR UPDATE} after an {@code INSERT ... ON CONFLICT DO NOTHING}), so concurrent claimants of
 * one key, in this process or another, are serialised and exactly one receives the run. Completion and release are
 * fenced by the lease token: a run that lost its lease (a stale-lease takeover) cannot complete, release or
 * overwrite the new owner's row. Rows are never deleted by this store.
 */
public final class PostgresqlMediaRequestLedger implements RequestLedger {
    private static final String COLUMNS = """
            tenant_id,principal_id,lane,request_id,request_fingerprint,state,lease_owner,lease_token,
            lease_expires_at,attempts,outputs_json,last_failure_code,created_at,updated_at,completed_at""";
    private static final String WHERE_KEY = " WHERE tenant_id=? AND principal_id=? AND lane=? AND request_id=?";
    private static final TypeReference<List<Map<String, String>>> OUTPUTS = new TypeReference<>() { };

    private final MediaAwsPostgresqlRuntimeState state;
    private final Clock clock;
    private final AtomicBoolean closed = new AtomicBoolean();

    public PostgresqlMediaRequestLedger() { this(MediaAwsPostgresqlRuntimeState.acquire(), Clock.systemUTC()); }

    PostgresqlMediaRequestLedger(MediaAwsPostgresqlRuntimeState state, Clock clock) {
        this.state = Objects.requireNonNull(state, "state");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    @Override public String ledgerId() { return "postgresql-media-request-ledger"; }

    @Override public boolean ready() { return !closed.get() && state.ready(); }

    @Override public Claim claim(Key key, String fingerprint, String owner, Duration lease) {
        ensureOpen();
        MediaRequestLedgerContracts.requireFingerprint(fingerprint);
        Objects.requireNonNull(owner, "owner");
        if (lease == null || lease.isZero() || lease.isNegative()) throw new IllegalArgumentException("lease must be positive");
        Instant now = clock.instant();
        Timestamp nowTs = Timestamp.from(now);
        Timestamp expiry = Timestamp.from(now.plus(lease));
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                try (PreparedStatement insert = connection.prepareStatement("INSERT INTO media_dev_request_ledger ("
                        + COLUMNS + ") VALUES (?,?,?,?,?,'IN_PROGRESS',?,1,?,1,'[]','',?,?,NULL) ON CONFLICT DO NOTHING")) {
                    bindKey(insert, key);
                    insert.setString(5, fingerprint);
                    insert.setString(6, owner);
                    insert.setTimestamp(7, expiry);
                    insert.setTimestamp(8, nowTs);
                    insert.setTimestamp(9, nowTs);
                    if (insert.executeUpdate() == 1) {
                        connection.commit();
                        return new Acquired(1, 1, false);
                    }
                }
                Entry current;
                try (PreparedStatement select = connection.prepareStatement(
                        "SELECT " + COLUMNS + " FROM media_dev_request_ledger" + WHERE_KEY + " FOR UPDATE")) {
                    bindKey(select, key);
                    try (ResultSet row = select.executeQuery()) {
                        if (!row.next()) throw new IllegalStateException("request ledger row vanished during a claim");
                        current = entry(row);
                    }
                }
                Claim decided;
                boolean takeover = false;
                if (current.state() == State.RELEASED) {
                    decided = null;
                } else if (!current.fingerprint().equals(fingerprint)) {
                    decided = new Mismatch();
                } else if (current.state() == State.COMPLETED) {
                    decided = new Replay(current.outputs());
                } else if (current.leaseExpiresAt().isAfter(now)) {
                    decided = new InProgress(current.leaseExpiresAt(), current.leaseOwner(), current.fence());
                } else {
                    decided = null;
                    takeover = true;
                }
                if (decided != null) {
                    connection.commit();
                    return decided;
                }
                long fence = current.fence() + 1;
                int attempt = current.attempts() + 1;
                try (PreparedStatement update = connection.prepareStatement("""
                        UPDATE media_dev_request_ledger SET request_fingerprint=?, state='IN_PROGRESS', lease_owner=?,
                               lease_token=?, lease_expires_at=?, attempts=?, outputs_json='[]', updated_at=?,
                               completed_at=NULL, last_failure_code=?""" + WHERE_KEY)) {
                    update.setString(1, fingerprint);
                    update.setString(2, owner);
                    update.setLong(3, fence);
                    update.setTimestamp(4, expiry);
                    update.setInt(5, attempt);
                    update.setTimestamp(6, nowTs);
                    update.setString(7, takeover ? current.lastFailureCode() : "");
                    update.setString(8, key.tenantId());
                    update.setString(9, key.principalId());
                    update.setString(10, key.lane());
                    update.setString(11, key.requestId());
                    update.executeUpdate();
                }
                connection.commit();
                return new Acquired(fence, attempt, takeover);
            } catch (SQLException | RuntimeException failure) {
                rollbackQuietly(connection);
                throw failure;
            }
        } catch (SQLException failure) {
            throw persistence("claim", failure);
        }
    }

    @Override public Claim reclaim(Key key, String fingerprint, String expectedOwner, long expectedFence,
                                   String newOwner, Duration lease) {
        ensureOpen();
        MediaRequestLedgerContracts.requireFingerprint(fingerprint);
        Objects.requireNonNull(expectedOwner, "expectedOwner");
        Objects.requireNonNull(newOwner, "newOwner");
        if (lease == null || lease.isZero() || lease.isNegative()) throw new IllegalArgumentException("lease must be positive");
        Instant now = clock.instant();
        try (Connection connection = state.connection();
             PreparedStatement update = connection.prepareStatement("""
                     UPDATE media_dev_request_ledger SET lease_owner=?, lease_token=lease_token+1, lease_expires_at=?,
                            attempts=attempts+1, outputs_json='[]', updated_at=?, completed_at=NULL""" + WHERE_KEY
                     + " AND state='IN_PROGRESS' AND request_fingerprint=? AND lease_owner=? AND lease_token=?"
                     + " RETURNING lease_token, attempts")) {
            update.setString(1, newOwner);
            update.setTimestamp(2, Timestamp.from(now.plus(lease)));
            update.setTimestamp(3, Timestamp.from(now));
            update.setString(4, key.tenantId());
            update.setString(5, key.principalId());
            update.setString(6, key.lane());
            update.setString(7, key.requestId());
            update.setString(8, fingerprint);
            update.setString(9, expectedOwner);
            update.setLong(10, expectedFence);
            try (ResultSet row = update.executeQuery()) {
                if (row.next()) return new Acquired(row.getLong("lease_token"), row.getInt("attempts"), true);
            }
        } catch (SQLException failure) {
            throw persistence("reclaim", failure);
        }
        return claim(key, fingerprint, newOwner, lease);
    }

    @Override public boolean complete(Key key, long fence, List<OutputRef> outputs) {
        ensureOpen();
        if (outputs == null || outputs.isEmpty()) throw new IllegalArgumentException("a completed request needs an output");
        List<Map<String, String>> encoded = new ArrayList<>();
        for (OutputRef output : outputs) {
            Map<String, String> item = new LinkedHashMap<>();
            item.put("role", output.role());
            item.put("artifactId", output.artifactId());
            item.put("versionId", output.versionId());
            encoded.add(item);
        }
        Timestamp now = Timestamp.from(clock.instant());
        try (Connection connection = state.connection();
             PreparedStatement update = connection.prepareStatement("""
                     UPDATE media_dev_request_ledger SET state='COMPLETED', outputs_json=?, updated_at=?, completed_at=?,
                            last_failure_code=''""" + WHERE_KEY + " AND state='IN_PROGRESS' AND lease_token=?")) {
            update.setString(1, state.mapper().writeValueAsString(encoded));
            update.setTimestamp(2, now);
            update.setTimestamp(3, now);
            update.setString(4, key.tenantId());
            update.setString(5, key.principalId());
            update.setString(6, key.lane());
            update.setString(7, key.requestId());
            update.setLong(8, fence);
            return update.executeUpdate() == 1;
        } catch (SQLException failure) {
            throw persistence("complete", failure);
        }
    }

    @Override public boolean release(Key key, long fence, String failureCode) {
        ensureOpen();
        String code = failureCode == null ? "" : failureCode.length() > 128 ? failureCode.substring(0, 128) : failureCode;
        try (Connection connection = state.connection();
             PreparedStatement update = connection.prepareStatement("""
                     UPDATE media_dev_request_ledger SET state='RELEASED', last_failure_code=?, updated_at=?""" + WHERE_KEY
                     + " AND state='IN_PROGRESS' AND lease_token=?")) {
            update.setString(1, code);
            update.setTimestamp(2, Timestamp.from(clock.instant()));
            update.setString(3, key.tenantId());
            update.setString(4, key.principalId());
            update.setString(5, key.lane());
            update.setString(6, key.requestId());
            update.setLong(7, fence);
            return update.executeUpdate() == 1;
        } catch (SQLException failure) {
            throw persistence("release", failure);
        }
    }

    @Override public Optional<Entry> find(Key key) {
        ensureOpen();
        try (Connection connection = state.connection();
             PreparedStatement select = connection.prepareStatement(
                     "SELECT " + COLUMNS + " FROM media_dev_request_ledger" + WHERE_KEY)) {
            bindKey(select, key);
            try (ResultSet row = select.executeQuery()) {
                return row.next() ? Optional.of(entry(row)) : Optional.empty();
            }
        } catch (SQLException failure) {
            throw persistence("read", failure);
        }
    }

    private Entry entry(ResultSet row) throws SQLException {
        Key key = new Key(row.getString("tenant_id"), row.getString("principal_id"), row.getString("lane"),
                row.getString("request_id"));
        List<OutputRef> outputs = new ArrayList<>();
        for (Map<String, String> item : state.mapper().readValue(row.getString("outputs_json"), OUTPUTS)) {
            outputs.add(new OutputRef(item.get("role"), item.get("artifactId"), item.get("versionId")));
        }
        Timestamp completed = row.getTimestamp("completed_at");
        return new Entry(key, row.getString("request_fingerprint").trim(), State.valueOf(row.getString("state")),
                row.getString("lease_owner"), row.getLong("lease_token"),
                row.getTimestamp("lease_expires_at").toInstant(), row.getInt("attempts"), outputs,
                row.getString("last_failure_code"), row.getTimestamp("created_at").toInstant(),
                row.getTimestamp("updated_at").toInstant(), completed == null ? null : completed.toInstant());
    }

    private static void bindKey(PreparedStatement statement, Key key) throws SQLException {
        // Positions 1-4 are the key for SELECT/INSERT statements that bind the key first.
        statement.setString(1, key.tenantId());
        statement.setString(2, key.principalId());
        statement.setString(3, key.lane());
        statement.setString(4, key.requestId());
    }

    private static void rollbackQuietly(Connection connection) {
        try { connection.rollback(); } catch (SQLException ignored) { /* the original failure is reported */ }
    }

    private static IllegalStateException persistence(String operation, SQLException failure) {
        return new IllegalStateException("request ledger " + operation + " failed", failure);
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("request ledger is closed");
    }

    @Override public void close() {
        if (closed.compareAndSet(false, true)) state.release();
    }
}
