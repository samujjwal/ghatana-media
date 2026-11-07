package com.ghatana.media.provider.aws;

import tools.jackson.core.type.TypeReference;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaStreamSessionStore;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSession;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamState;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Clock;
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
    private final MediaAwsPostgresqlRuntimeState state;
    private final Clock clock;
    private final AtomicBoolean closed = new AtomicBoolean(false);

    public PostgresqlMediaStreamSessionStore() {
        this(Clock.systemUTC());
    }

    PostgresqlMediaStreamSessionStore(Clock clock) {
        this.clock = java.util.Objects.requireNonNull(clock, "clock");
        this.state = MediaAwsPostgresqlRuntimeState.acquire();
    }

    @Override public String storeId() { return "postgresql"; }

    @Override
    public StreamSession create(StreamSession session, String connectionTokenHash) {
        ensureOpen();
        java.util.Objects.requireNonNull(session, "session");
        requireHash(connectionTokenHash);
        if (session.finality() != StreamFinality.NONE || session.inFlightSequence() != null) {
            throw new IllegalArgumentException("New Media stream sessions cannot contain provider outcome state");
        }
        if (session.leaseExpiresAt() == null) {
            throw new IllegalArgumentException("New Media stream sessions require a connection lease");
        }
        StreamSession persistable = persistedPrecision(new StreamSession(
                session.tenantId(), session.sessionId(), session.principalId(), session.streamKind(),
                session.providerId(), session.state(), session.lastSequence(), session.bufferedBytes(),
                session.maximumBufferedBytes(), session.reconnectCount(), session.leaseExpiresAt(),
                session.createdAt(), session.updatedAt(), session.closedAt(), session.metadata(),
                session.version(), connectionTokenHash, session.acknowledgementRevision(), session.finality(),
                session.inFlightSequence(), session.inFlightAttemptId()));
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "INSERT INTO media_stream_sessions "
                             + "(tenant_id,session_id,principal_id,stream_kind,provider_id,state,connection_token_hash,"
                             + "lease_owner,lease_expires_at,last_sequence,buffered_bytes,maximum_buffered_bytes,"
                             + "reconnect_count,created_at,updated_at,closed_at,metadata_json,version,"
                             + "sequence_token_hash,acknowledgement_revision,finality,in_flight_sequence,"
                             + "in_flight_attempt_id) "
                             + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")) {
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
        if (!leaseExpiresAt.isAfter(clock.instant())) {
            throw new IllegalArgumentException("Media stream lease must expire in the future");
        }
        if (!tokenMatches(expected.tenantId(), expected.sessionId(), tokenHash)) {
            throw new SecurityException("Invalid media stream connection token");
        }
        if (expected.inFlightSequence() != null) {
            // A reconnect can be retried after the first recovery persisted UNKNOWN. Keep that
            // durable observation and attempt identity stable; never rewrite UNKNOWN or replay.
            if (expected.finality() == StreamFinality.NONE) {
                try {
                    markFrameOutcomeUnknown(expected);
                } catch (IllegalStateException failure) {
                    if (!"Media stream session version or ownership changed".equals(failure.getMessage())
                            || !sameUnknownReservation(expected)) {
                        throw failure;
                    }
                }
            }
            throw new IllegalStateException("Media stream provider outcome is unknown; frame replay is blocked");
        }
        if (expected.state() != StreamState.OPEN
                && expected.state() != StreamState.CONNECTED
                && expected.state() != StreamState.DEGRADED) {
            throw new IllegalStateException("Media stream state cannot connect: " + expected.state());
        }
        try (Connection connection = state.connection()) {
            boolean originalAutoCommit = connection.getAutoCommit();
            connection.setAutoCommit(false);
            try {
                StreamRow current = read(connection, expected.tenantId(), expected.sessionId(), true);
                if (current == null || !current.session().equals(expected)) {
                    throw new IllegalStateException("Media stream session version or ownership changed");
                }
                if (!MessageDigest.isEqual(
                        current.tokenHash().getBytes(StandardCharsets.UTF_8),
                        tokenHash.getBytes(StandardCharsets.UTF_8))) {
                    throw new SecurityException("Invalid media stream connection token");
                }
                // The row lock serializes this sample after any competing writer. The SQL
                // UPDATE also applies PostgreSQL's wall clock after the lock is acquired.
                Instant now = currentDatabaseTime(connection);
                if (!leaseExpiresAt.isAfter(now)) {
                    throw new IllegalArgumentException("Media stream lease must expire in the future");
                }
                if (current.session().leaseExpiresAt() == null
                        || !current.session().leaseExpiresAt().isAfter(now)) {
                    throw new IllegalStateException("Media stream connection lease is absent or expired");
                }
                StreamSession updated = persistedPrecision(new StreamSession(
                        expected.tenantId(), expected.sessionId(), expected.principalId(), expected.streamKind(),
                        expected.providerId(), StreamState.CONNECTED, expected.lastSequence(), expected.bufferedBytes(),
                        expected.maximumBufferedBytes(), expected.reconnectCount() + 1, leaseExpiresAt,
                        expected.createdAt(), now, null, expected.metadata(), expected.version() + 1,
                        expected.sequenceTokenHash(), expected.acknowledgementRevision() + 1, expected.finality(),
                        null, ""));
                update(connection, expected, updated, "connection_token_hash=?",
                        statement -> statement.setString(1, tokenHash), true, now,
                        "Media stream connection lease is absent or expired");
                StreamRow committed = read(connection, expected.tenantId(), expected.sessionId(), false);
                if (committed == null) {
                    throw new IllegalStateException("Media stream session disappeared during connection");
                }
                connection.commit();
                return committed.session();
            } catch (SQLException | RuntimeException failure) {
                try {
                    connection.rollback();
                } catch (SQLException rollbackFailure) {
                    failure.addSuppressed(rollbackFailure);
                }
                throw failure;
            } finally {
                connection.setAutoCommit(originalAutoCommit);
            }
        } catch (SQLException failure) {
            throw databaseFailure("connect Media stream session", failure);
        }
    }

    private Instant currentDatabaseTime(Connection connection) throws SQLException {
        if (connection.getMetaData().getDatabaseProductName().toLowerCase(java.util.Locale.ROOT)
                .contains("postgresql")) {
            try (PreparedStatement statement = connection.prepareStatement("SELECT clock_timestamp()");
                 ResultSet result = statement.executeQuery()) {
                if (!result.next()) throw new SQLException("PostgreSQL clock query returned no row");
                return result.getTimestamp(1).toInstant().truncatedTo(java.time.temporal.ChronoUnit.MILLIS);
            }
        }
        return clock.instant().truncatedTo(java.time.temporal.ChronoUnit.MILLIS);
    }

    @Override
    public StreamSession renewLease(
            StreamSession expected,
            String tokenHash,
            long sequenceStart,
            Instant leaseExpiresAt) {
        ensureOpen();
        java.util.Objects.requireNonNull(expected, "expected");
        java.util.Objects.requireNonNull(leaseExpiresAt, "leaseExpiresAt");
        requireHash(tokenHash);
        Instant persistedLeaseExpiry = persistedMillis(leaseExpiresAt, "leaseExpiresAt");
        try (Connection connection = state.connection()) {
            boolean originalAutoCommit = connection.getAutoCommit();
            connection.setAutoCommit(false);
            try {
                // Serialize renewal with frame/reconnect writes, then sample the owning store's
                // clock. Sampling before the row lock would let a renewal waiting on another
                // writer pass an already-expired lease using a stale application timestamp.
                StreamRow currentRow = read(connection, expected.tenantId(), expected.sessionId(), true);
                Instant now = currentDatabaseTime(connection);
                if (currentRow == null || !currentRow.session().equals(expected)) {
                    throw new IllegalStateException("Media stream lease version or ownership changed");
                }
                if (!MessageDigest.isEqual(
                        currentRow.tokenHash().getBytes(StandardCharsets.UTF_8),
                        tokenHash.getBytes(StandardCharsets.UTF_8))) {
                    throw new SecurityException("Invalid media stream connection token");
                }
                validateLeaseRenewal(currentRow.session(), sequenceStart, persistedLeaseExpiry, now);
                StreamSession renewedSession = persistedPrecision(new StreamSession(
                        expected.tenantId(), expected.sessionId(), expected.principalId(), expected.streamKind(),
                        expected.providerId(), expected.state(), expected.lastSequence(), expected.bufferedBytes(),
                        expected.maximumBufferedBytes(), expected.reconnectCount(), persistedLeaseExpiry,
                        expected.createdAt(), now, expected.closedAt(), expected.metadata(), expected.version() + 1,
                        expected.sequenceTokenHash(), expected.acknowledgementRevision(), expected.finality(),
                        expected.inFlightSequence(), expected.inFlightAttemptId()));
                update(connection, expected, renewedSession, null, null, true, now,
                        "Expired Media stream lease cannot be renewed");
                StreamRow renewed = read(connection, expected.tenantId(), expected.sessionId(), false);
                if (renewed == null) {
                    throw new IllegalStateException("Media stream session disappeared during lease renewal");
                }
                connection.commit();
                return renewed.session();
            } catch (SQLException | RuntimeException failure) {
                try {
                    connection.rollback();
                } catch (SQLException rollbackFailure) {
                    failure.addSuppressed(rollbackFailure);
                }
                throw failure;
            } finally {
                connection.setAutoCommit(originalAutoCommit);
            }
        } catch (SQLException failure) {
            throw databaseFailure("renew Media stream lease", failure);
        }
    }

    private static void validateLeaseRenewal(
            StreamSession current, long sequenceStart, Instant leaseExpiresAt, Instant now) {
        if (current.state() != StreamState.CONNECTED && current.state() != StreamState.DEGRADED) {
            throw new IllegalStateException("Only a connected Media stream lease can be renewed");
        }
        if (current.leaseExpiresAt() == null || !current.leaseExpiresAt().isAfter(now)) {
            throw new IllegalStateException("Expired Media stream lease cannot be renewed");
        }
        if (current.finality() != StreamFinality.NONE || current.inFlightSequence() != null) {
            throw new IllegalStateException("Media stream with terminal or unresolved frame state cannot renew");
        }
        if (current.lastSequence() == Long.MAX_VALUE || sequenceStart != current.lastSequence() + 1) {
            throw new IllegalArgumentException("Media stream renewal sequence must be the exact next sequence");
        }
        if (!leaseExpiresAt.isAfter(current.leaseExpiresAt())) {
            throw new IllegalArgumentException("Renewed Media stream lease must extend the current expiry");
        }
        try {
            if (!leaseExpiresAt.isAfter(now)
                    || java.time.Duration.between(now, leaseExpiresAt)
                            .compareTo(java.time.Duration.ofHours(1)) > 0
                    || leaseExpiresAt.isAfter(current.createdAt().plus(java.time.Duration.ofHours(24)))) {
                throw new IllegalArgumentException("Renewed Media stream lease exceeds its bounded horizon");
            }
        } catch (java.time.DateTimeException | ArithmeticException overflow) {
            throw new IllegalArgumentException("Renewed Media stream lease exceeds its bounded horizon", overflow);
        }
    }

    private static Instant persistedMillis(Instant value, String field) {
        try {
            return Instant.ofEpochMilli(value.toEpochMilli());
        } catch (ArithmeticException overflow) {
            throw new IllegalArgumentException(field + " is outside the supported epoch-millisecond range", overflow);
        }
    }

    private boolean sameUnknownReservation(StreamSession expected) {
        StreamSession current = find(expected.tenantId(), expected.sessionId()).orElse(null);
        return current != null
                && current.tenantId().equals(expected.tenantId())
                && current.sessionId().equals(expected.sessionId())
                && current.finality() == StreamFinality.UNKNOWN
                && java.util.Objects.equals(current.inFlightSequence(), expected.inFlightSequence())
                && current.inFlightAttemptId().equals(expected.inFlightAttemptId());
    }

    @Override
    public StreamSession beginFrame(StreamSession expected, long sequence, String attemptId) {
        ensureOpen();
        java.util.Objects.requireNonNull(expected, "expected");
        if (expected.state() != StreamState.CONNECTED && expected.state() != StreamState.DEGRADED) {
            throw new IllegalStateException("Media stream must be connected before reserving a frame");
        }
        if (expected.leaseExpiresAt() == null || !expected.leaseExpiresAt().isAfter(Instant.now())) {
            throw new IllegalStateException("Media stream lease is absent or expired");
        }
        if (expected.finality() != StreamFinality.NONE) {
            throw new IllegalStateException("Media stream finality is already terminal");
        }
        if (expected.inFlightSequence() != null) {
            throw new IllegalStateException("Media stream already has an unresolved provider attempt");
        }
        if (sequence != expected.lastSequence() + 1) {
            throw new IllegalArgumentException("Media stream frame sequence is not contiguous");
        }
        String boundedAttemptId = requireAttemptId(attemptId);
        StreamSession updated = persistedPrecision(new StreamSession(
                expected.tenantId(), expected.sessionId(), expected.principalId(), expected.streamKind(),
                expected.providerId(), expected.state(), expected.lastSequence(), expected.bufferedBytes(),
                expected.maximumBufferedBytes(), expected.reconnectCount(), expected.leaseExpiresAt(),
                expected.createdAt(), Instant.now(), expected.closedAt(), expected.metadata(),
                expected.version() + 1, expected.sequenceTokenHash(), expected.acknowledgementRevision(),
                expected.finality(), sequence, boundedAttemptId));
        updateWithLeaseFence(expected, updated);
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
        if (!java.util.Objects.equals(expected.inFlightSequence(), sequence)
                || expected.inFlightAttemptId().isBlank()) {
            throw new IllegalStateException("Media stream frame has no durable provider reservation");
        }
        if (bufferedBytes < 0 || bufferedBytes > expected.maximumBufferedBytes()) {
            throw new IllegalStateException("Media stream buffered bytes exceed the configured limit");
        }
        StreamState target = endOfStream ? StreamState.DRAINING : expected.state();
        StreamSession updated = persistedPrecision(new StreamSession(
                expected.tenantId(), expected.sessionId(), expected.principalId(), expected.streamKind(),
                expected.providerId(), target, sequence, bufferedBytes, expected.maximumBufferedBytes(),
                expected.reconnectCount(), expected.leaseExpiresAt(), expected.createdAt(), Instant.now(),
                expected.closedAt(), expected.metadata(), expected.version() + 1,
                expected.sequenceTokenHash(), expected.acknowledgementRevision() + 1, expected.finality(),
                null, ""));
        updateWithLeaseFence(expected, updated);
        return updated;
    }

    @Override
    public StreamSession markFrameOutcomeUnknown(StreamSession expected) {
        ensureOpen();
        java.util.Objects.requireNonNull(expected, "expected");
        if (expected.inFlightSequence() == null || expected.inFlightAttemptId().isBlank()) {
            throw new IllegalStateException("Media stream has no unresolved provider attempt");
        }
        if (expected.finality() != StreamFinality.NONE) {
            throw new IllegalStateException("Media stream finality cannot be upgraded or rewritten");
        }
        Instant now = Instant.now();
        StreamSession updated = persistedPrecision(new StreamSession(
                expected.tenantId(), expected.sessionId(), expected.principalId(), expected.streamKind(),
                expected.providerId(), StreamState.FAILED, expected.lastSequence(), expected.bufferedBytes(),
                expected.maximumBufferedBytes(), expected.reconnectCount(), expected.leaseExpiresAt(),
                expected.createdAt(), now, now, expected.metadata(), expected.version() + 1,
                expected.sequenceTokenHash(), expected.acknowledgementRevision() + 1,
                StreamFinality.UNKNOWN, expected.inFlightSequence(), expected.inFlightAttemptId()));
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
                expected.metadata(), expected.version() + 1, expected.sequenceTokenHash(),
                expected.acknowledgementRevision() + 1,
                (target == StreamState.CLOSED || target == StreamState.FAILED)
                        && (expected.finality() == StreamFinality.NONE || expected.inFlightSequence() != null)
                        ? StreamFinality.UNKNOWN : expected.finality(),
                expected.inFlightSequence(), expected.inFlightAttemptId()));
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
        update(expected, updated, extraPredicate, extraBinder, false, null);
    }

    private void update(
            StreamSession expected,
            StreamSession updated,
            String extraPredicate,
            SqlBinder extraBinder,
            boolean databaseClockLeaseFence,
            Instant applicationClockFallback) {
        try (Connection connection = state.connection()) {
            update(connection, expected, updated, extraPredicate, extraBinder,
                    databaseClockLeaseFence, applicationClockFallback);
        } catch (SQLException failure) {
            throw databaseFailure("prepare Media stream session update", failure);
        }
    }

    /** Locks and revalidates the session lease before reserving or acknowledging a frame. */
    private void updateWithLeaseFence(StreamSession expected, StreamSession updated) {
        try (Connection connection = state.connection()) {
            boolean originalAutoCommit = connection.getAutoCommit();
            connection.setAutoCommit(false);
            try {
                StreamRow row = read(connection, expected.tenantId(), expected.sessionId(), true);
                Instant now = currentDatabaseTime(connection);
                if (row == null || !row.session().equals(expected)) {
                    throw new IllegalStateException("Media stream session version or ownership changed");
                }
                if (row.session().leaseExpiresAt() == null || !row.session().leaseExpiresAt().isAfter(now)) {
                    throw new IllegalStateException("Media stream connection lease is absent or expired");
                }
                update(connection, expected, updated, null, null, true, now);
                connection.commit();
            } catch (SQLException | RuntimeException failure) {
                try {
                    connection.rollback();
                } catch (SQLException rollbackFailure) {
                    failure.addSuppressed(rollbackFailure);
                }
                throw failure;
            } finally {
                connection.setAutoCommit(originalAutoCommit);
            }
        } catch (SQLException failure) {
            throw databaseFailure("fence Media stream frame update", failure);
        }
    }

    private void update(
            Connection connection,
            StreamSession expected,
            StreamSession updated,
            String extraPredicate,
            SqlBinder extraBinder,
            boolean databaseClockLeaseFence,
            Instant applicationClockFallback) throws SQLException {
        update(connection, expected, updated, extraPredicate, extraBinder,
                databaseClockLeaseFence, applicationClockFallback,
                "Media stream session version or ownership changed");
    }

    private void update(
            Connection connection,
            StreamSession expected,
            StreamSession updated,
            String extraPredicate,
            SqlBinder extraBinder,
            boolean databaseClockLeaseFence,
            Instant applicationClockFallback,
            String noRowsMessage) throws SQLException {
        if (databaseClockLeaseFence) {
            java.util.Objects.requireNonNull(applicationClockFallback, "applicationClockFallback");
        }
        boolean postgresClock = databaseClockLeaseFence
                && connection.getMetaData().getDatabaseProductName().toLowerCase(java.util.Locale.ROOT)
                        .contains("postgresql");
        boolean bindApplicationClock = databaseClockLeaseFence && !postgresClock;
        String sql = "UPDATE media_stream_sessions SET state=?,lease_expires_at=?,last_sequence=?,"
                + "buffered_bytes=?,reconnect_count=?,updated_at=?,closed_at=?,metadata_json=?,version=?,"
                + "sequence_token_hash=?,acknowledgement_revision=?,finality=?,in_flight_sequence=?,"
                + "in_flight_attempt_id=? "
                + "WHERE tenant_id=? AND session_id=? AND version=?"
                + (extraPredicate == null ? "" : " AND " + extraPredicate)
                + (databaseClockLeaseFence
                        ? " AND lease_expires_at>" + (postgresClock
                                ? "CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT)" : "?")
                        : "");
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, updated.state().name());
            nullableLong(statement, 2, updated.leaseExpiresAt());
            statement.setLong(3, updated.lastSequence());
            statement.setLong(4, updated.bufferedBytes());
            statement.setInt(5, updated.reconnectCount());
            statement.setLong(6, updated.updatedAt().toEpochMilli());
            nullableLong(statement, 7, updated.closedAt());
            statement.setString(8, json(updated.metadata()));
            statement.setLong(9, updated.version());
            statement.setString(10, updated.sequenceTokenHash());
            statement.setLong(11, updated.acknowledgementRevision());
            statement.setString(12, updated.finality().name());
            nullableLongValue(statement, 13, updated.inFlightSequence());
            statement.setString(14, updated.inFlightAttemptId());
            statement.setString(15, expected.tenantId());
            statement.setString(16, expected.sessionId());
            statement.setLong(17, expected.version());
            OffsetPreparedStatement extras = new OffsetPreparedStatement(statement, 17);
            if (extraBinder != null) extraBinder.bind(extras);
            if (bindApplicationClock) {
                statement.setLong(extras.nextIndex(), applicationClockFallback.toEpochMilli());
            }
            if (statement.executeUpdate() != 1) {
                throw new IllegalStateException(noRowsMessage);
            }
        }
    }

    private StreamRow read(Connection connection, String tenantId, String sessionId, boolean lock)
            throws SQLException {
        String sql = "SELECT principal_id,stream_kind,provider_id,state,connection_token_hash,lease_expires_at,"
                + "last_sequence,buffered_bytes,maximum_buffered_bytes,reconnect_count,created_at,updated_at,"
                + "closed_at,metadata_json,version,sequence_token_hash,acknowledgement_revision,finality,"
                + "in_flight_sequence,in_flight_attempt_id "
                + "FROM media_stream_sessions "
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
                                objectMap(result.getString("metadata_json")), result.getLong("version"),
                                result.getString("sequence_token_hash"), result.getLong("acknowledgement_revision"),
                                StreamFinality.valueOf(result.getString("finality")),
                                nullable(result, "in_flight_sequence"), result.getString("in_flight_attempt_id")),
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
        statement.setString(19, session.sequenceTokenHash());
        statement.setLong(20, session.acknowledgementRevision());
        statement.setString(21, session.finality().name());
        nullableLongValue(statement, 22, session.inFlightSequence());
        statement.setString(23, session.inFlightAttemptId());
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
                session.metadata(), session.version(), session.sequenceTokenHash(),
                session.acknowledgementRevision(), session.finality(),
                session.inFlightSequence(), session.inFlightAttemptId());
    }

    private static Instant millis(Instant value) {
        return value == null ? null : Instant.ofEpochMilli(value.toEpochMilli());
    }

    private static void requireHash(String value) {
        if (value == null || !value.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("connection token hash must be SHA-256");
        }
    }

    private static String requireAttemptId(String value) {
        if (value == null || value.isBlank() || value.length() > 128
                || value.chars().anyMatch(Character::isISOControl)) {
            throw new IllegalArgumentException("Media stream attempt ID must be bounded and nonblank");
        }
        return value;
    }

    private static void nullableLongValue(PreparedStatement statement, int index, Long value) throws SQLException {
        if (value == null) statement.setNull(index, java.sql.Types.BIGINT);
        else statement.setLong(index, value);
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
        private int highestRelativeIndex;
        private OffsetPreparedStatement(PreparedStatement statement, int offset) {
            this.statement = statement;
            this.offset = offset;
        }
        void setString(int relativeIndex, String value) throws SQLException {
            remember(relativeIndex);
            statement.setString(offset + relativeIndex, value);
        }
        void setLong(int relativeIndex, long value) throws SQLException {
            remember(relativeIndex);
            statement.setLong(offset + relativeIndex, value);
        }
        int nextIndex() { return offset + highestRelativeIndex + 1; }
        private void remember(int relativeIndex) {
            if (relativeIndex < 1) throw new IllegalArgumentException("SQL parameter index must be positive");
            highestRelativeIndex = Math.max(highestRelativeIndex, relativeIndex);
        }
    }

    private record StreamRow(StreamSession session, String tokenHash) { }
}
