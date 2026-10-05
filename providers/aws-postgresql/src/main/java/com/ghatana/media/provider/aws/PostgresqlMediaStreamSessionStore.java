package com.ghatana.media.provider.aws;

import tools.jackson.core.type.TypeReference;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaStreamSessionStore;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSession;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamState;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * PostgreSQL-backed leased and ordered Media stream-session store.
 *
 * @doc.type class
 * @doc.purpose Provide Postgresql Media Stream Session Store behavior
 * @doc.layer product
 * @doc.pattern Repository
 */
public final class PostgresqlMediaStreamSessionStore implements MediaStreamSessionStore {
    private final MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
    private final AtomicBoolean closed = new AtomicBoolean(false);

    @Override public String storeId() { return "postgresql"; }

    @Override
    public StreamSession create(StreamSession session, String connectionTokenHash) {
        ensureOpen();
        requireHash(connectionTokenHash);
        StreamSession persistable = persistedPrecision(session);
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "INSERT INTO media_stream_sessions "
                             + "(tenant_id,session_id,principal_id,stream_kind,provider_id,state,connection_token_hash,"
                             + "lease_owner,lease_expires_at,last_sequence,buffered_bytes,maximum_buffered_bytes,"
                             + "reconnect_count,created_at,updated_at,closed_at,metadata_json,version) "
                             + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")) {
            bindInsert(statement, persistable, connectionTokenHash);
            statement.executeUpdate();
            return persistable;
        } catch (SQLException failure) {
            if ("23505".equals(failure.getSQLState())) {
                throw new IllegalStateException("Media stream session already exists", failure);
            }
            throw databaseFailure("create Media stream session", failure);
        }
    }

    @Override
    public Optional<StreamSession> find(String tenantId, String sessionId) {
        ensureOpen();
        try (Connection connection = state.connection()) {
            StreamRow row = read(connection, tenantId, sessionId, false);
            return row == null ? Optional.empty() : Optional.of(row.session());
        } catch (SQLException failure) {
            throw databaseFailure("find Media stream session", failure);
        }
    }

    @Override
    public StreamSession connect(StreamSession expected, String tokenHash, Instant leaseExpiresAt) {
        ensureOpen();
        java.util.Objects.requireNonNull(expected, "expected");
        java.util.Objects.requireNonNull(leaseExpiresAt, "leaseExpiresAt");
        requireHash(tokenHash);
        if (!leaseExpiresAt.isAfter(Instant.now())) {
            throw new IllegalArgumentException("Media stream lease must expire in the future");
        }
        if (!tokenMatches(expected.tenantId(), expected.sessionId(), tokenHash)) {
            throw new SecurityException("Invalid media stream connection token");
        }
        if (expected.state() != StreamState.OPEN
                && expected.state() != StreamState.CONNECTED
                && expected.state() != StreamState.DEGRADED) {
            throw new IllegalStateException("Media stream state cannot connect: " + expected.state());
        }
        StreamSession updated = persistedPrecision(new StreamSession(
                expected.tenantId(), expected.sessionId(), expected.principalId(), expected.streamKind(),
                expected.providerId(), StreamState.CONNECTED, expected.lastSequence(), expected.bufferedBytes(),
                expected.maximumBufferedBytes(), expected.reconnectCount() + 1, leaseExpiresAt,
                expected.createdAt(), Instant.now(), null, expected.metadata(), expected.version() + 1));
        update(expected, updated, "connection_token_hash=?", statement -> statement.setString(1, tokenHash));
        return updated;
    }

    @Override
    public StreamSession recordFrame(
            StreamSession expected, long sequence, long bufferedBytes, boolean endOfStream) {
        ensureOpen();
        java.util.Objects.requireNonNull(expected, "expected");
        if (expected.state() != StreamState.CONNECTED && expected.state() != StreamState.DEGRADED) {
            throw new IllegalStateException("Media stream must be connected before accepting frames");
        }
        if (expected.leaseExpiresAt() == null || !expected.leaseExpiresAt().isAfter(Instant.now())) {
            throw new IllegalStateException("Media stream lease is absent or expired");
        }
        if (sequence != expected.lastSequence() + 1) {
            throw new IllegalArgumentException("Media stream frame sequence is not contiguous");
        }
        if (bufferedBytes < 0 || bufferedBytes > expected.maximumBufferedBytes()) {
            throw new IllegalStateException("Media stream buffered bytes exceed the configured limit");
        }
        StreamState target = endOfStream ? StreamState.DRAINING : expected.state();
        StreamSession updated = persistedPrecision(new StreamSession(
                expected.tenantId(), expected.sessionId(), expected.principalId(), expected.streamKind(),
                expected.providerId(), target, sequence, bufferedBytes, expected.maximumBufferedBytes(),
                expected.reconnectCount(), expected.leaseExpiresAt(), expected.createdAt(), Instant.now(),
                expected.closedAt(), expected.metadata(), expected.version() + 1));
        update(expected, updated, null, null);
        return updated;
    }

    @Override
    public StreamSession transition(StreamSession expected, StreamState target) {
        ensureOpen();
        java.util.Objects.requireNonNull(expected, "expected");
        java.util.Objects.requireNonNull(target, "target");
        if (!allowed(expected.state(), target)) {
            throw new IllegalStateException(
                    "Invalid Media stream transition " + expected.state() + " -> " + target);
        }
        Instant now = Instant.now();
        StreamSession updated = persistedPrecision(new StreamSession(
                expected.tenantId(), expected.sessionId(), expected.principalId(), expected.streamKind(),
                expected.providerId(), target, expected.lastSequence(), expected.bufferedBytes(),
                expected.maximumBufferedBytes(), expected.reconnectCount(), expected.leaseExpiresAt(),
                expected.createdAt(), now,
                target == StreamState.CLOSED || target == StreamState.FAILED ? now : expected.closedAt(),
                expected.metadata(), expected.version() + 1));
        update(expected, updated, null, null);
        return updated;
    }

    @Override
    public boolean tokenMatches(String tenantId, String sessionId, String tokenHash) {
        ensureOpen();
        requireHash(tokenHash);
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "SELECT connection_token_hash FROM media_stream_sessions "
                             + "WHERE tenant_id=? AND session_id=?")) {
            statement.setString(1, tenantId);
            statement.setString(2, sessionId);
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next()) return false;
                return MessageDigest.isEqual(
                        result.getString(1).getBytes(StandardCharsets.UTF_8),
                        tokenHash.getBytes(StandardCharsets.UTF_8));
            }
        } catch (SQLException failure) {
            throw databaseFailure("verify Media stream token", failure);
        }
    }

    @Override public boolean durable() { return true; }
    @Override public boolean productionEligible() { return state.productionEligible(); }
    @Override public boolean ready() { return !closed.get() && state.ready(); }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) state.release();
    }

    private void update(
            StreamSession expected,
            StreamSession updated,
            String extraPredicate,
            SqlBinder extraBinder) {
        String sql = "UPDATE media_stream_sessions SET state=?,lease_expires_at=?,last_sequence=?,"
                + "buffered_bytes=?,reconnect_count=?,updated_at=?,closed_at=?,metadata_json=?,version=? "
                + "WHERE tenant_id=? AND session_id=? AND version=?"
                + (extraPredicate == null ? "" : " AND " + extraPredicate);
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, updated.state().name());
            nullableLong(statement, 2, updated.leaseExpiresAt());
            statement.setLong(3, updated.lastSequence());
            statement.setLong(4, updated.bufferedBytes());
            statement.setInt(5, updated.reconnectCount());
            statement.setLong(6, updated.updatedAt().toEpochMilli());
            nullableLong(statement, 7, updated.closedAt());
            statement.setString(8, json(updated.metadata()));
            statement.setLong(9, updated.version());
            statement.setString(10, expected.tenantId());
            statement.setString(11, expected.sessionId());
            statement.setLong(12, expected.version());
            if (extraBinder != null) extraBinder.bind(new OffsetPreparedStatement(statement, 12));
            if (statement.executeUpdate() != 1) {
                throw new IllegalStateException("Media stream session version or ownership changed");
            }
        } catch (SQLException failure) {
            throw databaseFailure("update Media stream session", failure);
        }
    }

    private StreamRow read(Connection connection, String tenantId, String sessionId, boolean lock)
            throws SQLException {
        String sql = "SELECT principal_id,stream_kind,provider_id,state,connection_token_hash,lease_expires_at,"
                + "last_sequence,buffered_bytes,maximum_buffered_bytes,reconnect_count,created_at,updated_at,"
                + "closed_at,metadata_json,version FROM media_stream_sessions "
                + "WHERE tenant_id=? AND session_id=?" + (lock ? " FOR UPDATE" : "");
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, tenantId);
            statement.setString(2, sessionId);
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next()) return null;
                Long lease = nullable(result, "lease_expires_at");
                Long closedAt = nullable(result, "closed_at");
                return new StreamRow(
                        new StreamSession(
                                tenantId, sessionId, result.getString("principal_id"),
                                StreamKind.valueOf(result.getString("stream_kind")),
                                result.getString("provider_id"),
                                StreamState.valueOf(result.getString("state")),
                                result.getLong("last_sequence"), result.getLong("buffered_bytes"),
                                result.getLong("maximum_buffered_bytes"), result.getInt("reconnect_count"),
                                lease == null ? null : Instant.ofEpochMilli(lease),
                                Instant.ofEpochMilli(result.getLong("created_at")),
                                Instant.ofEpochMilli(result.getLong("updated_at")),
                                closedAt == null ? null : Instant.ofEpochMilli(closedAt),
                                objectMap(result.getString("metadata_json")), result.getLong("version")),
                        result.getString("connection_token_hash"));
            }
        }
    }

    private void bindInsert(PreparedStatement statement, StreamSession session, String tokenHash)
            throws SQLException {
        statement.setString(1, session.tenantId());
        statement.setString(2, session.sessionId());
        statement.setString(3, session.principalId());
        statement.setString(4, session.streamKind().name());
        statement.setString(5, session.providerId());
        statement.setString(6, session.state().name());
        statement.setString(7, tokenHash);
        statement.setNull(8, java.sql.Types.VARCHAR);
        nullableLong(statement, 9, session.leaseExpiresAt());
        statement.setLong(10, session.lastSequence());
        statement.setLong(11, session.bufferedBytes());
        statement.setLong(12, session.maximumBufferedBytes());
        statement.setInt(13, session.reconnectCount());
        statement.setLong(14, session.createdAt().toEpochMilli());
        statement.setLong(15, session.updatedAt().toEpochMilli());
        nullableLong(statement, 16, session.closedAt());
        statement.setString(17, json(session.metadata()));
        statement.setLong(18, session.version());
    }

    private static boolean allowed(StreamState current, StreamState target) {
        if (current == target) return true;
        return switch (current) {
            case OPEN -> target == StreamState.CONNECTED || target == StreamState.CLOSED || target == StreamState.FAILED;
            case CONNECTED -> target == StreamState.DEGRADED || target == StreamState.DRAINING
                    || target == StreamState.CLOSED || target == StreamState.FAILED;
            case DEGRADED -> target == StreamState.CONNECTED || target == StreamState.DRAINING
                    || target == StreamState.CLOSED || target == StreamState.FAILED;
            case DRAINING -> target == StreamState.CLOSED || target == StreamState.FAILED;
            case CLOSED, FAILED -> false;
        };
    }

    private String json(Object value) {
        try { return state.mapper().writeValueAsString(value); }
        catch (Exception failure) { throw new IllegalArgumentException("Media stream metadata is not serializable", failure); }
    }

    private Map<String, Object> objectMap(String json) {
        try { return state.mapper().readValue(json, new TypeReference<>() { }); }
        catch (Exception failure) { throw new IllegalStateException("Stored Media stream metadata is malformed", failure); }
    }

    private static Long nullable(ResultSet result, String column) throws SQLException {
        return result.getObject(column) == null ? null : result.getLong(column);
    }

    private static void nullableLong(PreparedStatement statement, int index, Instant value) throws SQLException {
        if (value == null) statement.setNull(index, java.sql.Types.BIGINT);
        else statement.setLong(index, value.toEpochMilli());
    }

    private static StreamSession persistedPrecision(StreamSession session) {
        return new StreamSession(
                session.tenantId(), session.sessionId(), session.principalId(), session.streamKind(),
                session.providerId(), session.state(), session.lastSequence(), session.bufferedBytes(),
                session.maximumBufferedBytes(), session.reconnectCount(), millis(session.leaseExpiresAt()),
                millis(session.createdAt()), millis(session.updatedAt()), millis(session.closedAt()),
                session.metadata(), session.version());
    }

    private static Instant millis(Instant value) {
        return value == null ? null : Instant.ofEpochMilli(value.toEpochMilli());
    }

    private static void requireHash(String value) {
        if (value == null || !value.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("connection token hash must be SHA-256");
        }
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("Media stream store is closed");
        if (!state.configured()) throw new IllegalStateException("Media AWS/PostgreSQL providers are not configured");
    }

    private static IllegalStateException databaseFailure(String operation, SQLException failure) {
        return new IllegalStateException("Unable to " + operation, failure);
    }

    @FunctionalInterface
    private interface SqlBinder { void bind(OffsetPreparedStatement statement) throws SQLException; }

    private static final class OffsetPreparedStatement {
        private final PreparedStatement statement;
        private final int offset;
        private OffsetPreparedStatement(PreparedStatement statement, int offset) {
            this.statement = statement;
            this.offset = offset;
        }
        void setString(int relativeIndex, String value) throws SQLException {
            statement.setString(offset + relativeIndex, value);
        }
    }

    private record StreamRow(StreamSession session, String tokenHash) { }
}
