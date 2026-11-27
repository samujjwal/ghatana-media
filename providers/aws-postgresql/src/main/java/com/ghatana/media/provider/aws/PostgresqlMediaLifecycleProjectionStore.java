package com.ghatana.media.provider.aws;

import com.ghatana.audio.video.infrastructure.messaging.MediaLifecycleEventConsumer;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

/** Durable, tenant-scoped replay receipt and aggregate-version fence for lifecycle observations. */
public final class PostgresqlMediaLifecycleProjectionStore
        implements MediaLifecycleEventConsumer.ProjectionStore, AutoCloseable {
    private static final Set<String> AGGREGATE_TYPES = Set.of("upload", "artifact", "job", "stream");
    private static final Pattern REDACTED_REF = Pattern.compile("r1_[0-9a-f]{64}");
    private static final Pattern SHA256 = Pattern.compile("[0-9a-f]{64}");

    private final MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
    private final AtomicBoolean closed = new AtomicBoolean(false);

    @Override
    public MediaLifecycleEventConsumer.ProjectionDisposition apply(
            String tenantId, String aggregateType, String aggregateRef, long aggregateVersion, String eventRef) {
        ensureOpen();
        throw new MediaLifecycleEventConsumer.FingerprintAwareReplayUnsupportedException();
    }

    @Override
    public MediaLifecycleEventConsumer.ProjectionDisposition apply(
            String tenantId, String aggregateType, String aggregateRef, long aggregateVersion,
            String eventRef, String payloadFingerprint) {
        ensureOpen();
        validate(tenantId, aggregateType, aggregateRef, aggregateVersion, eventRef, payloadFingerprint);
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                lockEventIdentity(connection, tenantId, eventRef);
                Receipt existing = findReceipt(connection, tenantId, eventRef);
                if (existing != null) {
                    connection.commit();
                    return existing.matches(aggregateType, aggregateRef, aggregateVersion, payloadFingerprint)
                            ? MediaLifecycleEventConsumer.ProjectionDisposition.DUPLICATE
                            : MediaLifecycleEventConsumer.ProjectionDisposition.CONFLICTING_REPLAY;
                }

                lockAggregateHead(connection, tenantId, aggregateType, aggregateRef);
                long currentVersion = currentAggregateVersion(connection, tenantId, aggregateType, aggregateRef);
                if (aggregateVersion <= currentVersion) {
                    connection.commit();
                    return MediaLifecycleEventConsumer.ProjectionDisposition.OUT_OF_ORDER;
                }

                insertReceipt(connection, tenantId, aggregateType, aggregateRef,
                        aggregateVersion, eventRef, payloadFingerprint);
                updateAggregateVersion(connection, tenantId, aggregateType, aggregateRef,
                        currentVersion, aggregateVersion);
                connection.commit();
                return MediaLifecycleEventConsumer.ProjectionDisposition.APPLIED;
            } catch (SQLException | RuntimeException failure) {
                rollback(connection, failure);
                if (failure instanceof SQLException sqlFailure) {
                    throw databaseFailure("apply lifecycle projection", sqlFailure);
                }
                throw failure;
            }
        } catch (SQLException failure) {
            throw databaseFailure("open lifecycle projection transaction", failure);
        }
    }

    /** Serialize even first-seen event IDs so a conflicting cross-aggregate replay creates no head row. */
    private static void lockEventIdentity(Connection connection, String tenantId, String eventRef)
            throws SQLException {
        String lockKey = tenantId.length() + ":" + tenantId + eventRef;
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))")) {
            statement.setString(1, lockKey);
            statement.execute();
        }
    }

    private static void lockAggregateHead(
            Connection connection, String tenantId, String aggregateType, String aggregateRef) throws SQLException {
        try (PreparedStatement insert = connection.prepareStatement("""
                INSERT INTO media_lifecycle_projection_heads
                    (tenant_id, aggregate_type, aggregate_ref, aggregate_version)
                VALUES (?, ?, ?, 0)
                ON CONFLICT (tenant_id, aggregate_type, aggregate_ref) DO NOTHING
                """)) {
            insert.setString(1, tenantId);
            insert.setString(2, aggregateType);
            insert.setString(3, aggregateRef);
            insert.executeUpdate();
        }
        try (PreparedStatement lock = connection.prepareStatement("""
                SELECT aggregate_version FROM media_lifecycle_projection_heads
                WHERE tenant_id=? AND aggregate_type=? AND aggregate_ref=? FOR UPDATE
                """)) {
            lock.setString(1, tenantId);
            lock.setString(2, aggregateType);
            lock.setString(3, aggregateRef);
            try (ResultSet rows = lock.executeQuery()) {
                if (!rows.next()) throw new SQLException("Lifecycle aggregate head was not created");
            }
        }
    }

    private static long currentAggregateVersion(
            Connection connection, String tenantId, String aggregateType, String aggregateRef) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement("""
                SELECT aggregate_version FROM media_lifecycle_projection_heads
                WHERE tenant_id=? AND aggregate_type=? AND aggregate_ref=?
                """)) {
            statement.setString(1, tenantId);
            statement.setString(2, aggregateType);
            statement.setString(3, aggregateRef);
            try (ResultSet rows = statement.executeQuery()) {
                if (!rows.next()) throw new SQLException("Lifecycle aggregate head disappeared while locked");
                return rows.getLong(1);
            }
        }
    }

    private static Receipt findReceipt(Connection connection, String tenantId, String eventRef) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement("""
                SELECT aggregate_type, aggregate_ref, aggregate_version, payload_fingerprint
                FROM media_lifecycle_projection_receipts WHERE tenant_id=? AND event_ref=?
                """)) {
            statement.setString(1, tenantId);
            statement.setString(2, eventRef);
            try (ResultSet rows = statement.executeQuery()) {
                return rows.next()
                        ? new Receipt(rows.getString(1), rows.getString(2), rows.getLong(3), rows.getString(4))
                        : null;
            }
        }
    }

    private static void insertReceipt(Connection connection, String tenantId, String aggregateType,
            String aggregateRef, long aggregateVersion, String eventRef, String payloadFingerprint)
            throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement("""
                INSERT INTO media_lifecycle_projection_receipts
                    (tenant_id, event_ref, aggregate_type, aggregate_ref, aggregate_version, payload_fingerprint)
                VALUES (?, ?, ?, ?, ?, ?)
                """)) {
            statement.setString(1, tenantId);
            statement.setString(2, eventRef);
            statement.setString(3, aggregateType);
            statement.setString(4, aggregateRef);
            statement.setLong(5, aggregateVersion);
            statement.setString(6, payloadFingerprint);
            statement.executeUpdate();
        }
    }

    private static void updateAggregateVersion(Connection connection, String tenantId, String aggregateType,
            String aggregateRef, long expectedVersion, long nextVersion) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement("""
                UPDATE media_lifecycle_projection_heads SET aggregate_version=?
                WHERE tenant_id=? AND aggregate_type=? AND aggregate_ref=? AND aggregate_version=?
                """)) {
            statement.setLong(1, nextVersion);
            statement.setString(2, tenantId);
            statement.setString(3, aggregateType);
            statement.setString(4, aggregateRef);
            statement.setLong(5, expectedVersion);
            if (statement.executeUpdate() != 1) throw new SQLException("Lifecycle aggregate head changed while locked");
        }
    }

    private static void validate(String tenantId, String aggregateType, String aggregateRef, long aggregateVersion,
            String eventRef, String payloadFingerprint) {
        if (tenantId == null || tenantId.isBlank() || tenantId.length() > 512) {
            throw new IllegalArgumentException("tenantId must be a bounded trusted identity");
        }
        if (!AGGREGATE_TYPES.contains(aggregateType)) {
            throw new IllegalArgumentException("aggregateType is outside the lifecycle ABI");
        }
        if (aggregateRef == null || !REDACTED_REF.matcher(aggregateRef).matches()) {
            throw new IllegalArgumentException("aggregateRef must be a public redacted reference");
        }
        if (eventRef == null || !REDACTED_REF.matcher(eventRef).matches()) {
            throw new IllegalArgumentException("eventRef must be a public redacted reference");
        }
        if (aggregateVersion < 1) throw new IllegalArgumentException("aggregateVersion must be positive");
        if (payloadFingerprint == null || !SHA256.matcher(payloadFingerprint).matches()) {
            throw new IllegalArgumentException("payloadFingerprint must be a lowercase SHA-256 value");
        }
    }

    private static RuntimeException databaseFailure(String operation, SQLException failure) {
        return new IllegalStateException("Unable to " + operation + " in Media PostgreSQL", failure);
    }

    private static void rollback(Connection connection, Throwable failure) {
        try {
            connection.rollback();
        } catch (SQLException rollbackFailure) {
            failure.addSuppressed(rollbackFailure);
        }
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("Media lifecycle projection store is closed");
    }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) state.release();
    }

    private record Receipt(String aggregateType, String aggregateRef, long aggregateVersion,
            String payloadFingerprint) {
        boolean matches(String type, String ref, long version, String fingerprint) {
            return Objects.equals(aggregateType, type) && Objects.equals(aggregateRef, ref)
                    && aggregateVersion == version && Objects.equals(payloadFingerprint, fingerprint);
        }
    }
}
