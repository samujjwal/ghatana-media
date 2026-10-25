package com.ghatana.media.provider.aws;

import com.ghatana.core.async.AsyncOperation;
import com.ghatana.messaging.outbox.OutboxPublicationSource;
import tools.jackson.core.type.TypeReference;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;

/** PostgreSQL implementation of Shared's claim-aware publication source for Media events. */
public final class PostgresqlMediaOutboxPublicationSource implements OutboxPublicationSource, AutoCloseable {
    private final MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
    private final AtomicBoolean closed = new AtomicBoolean();

    @Override
    public AsyncOperation<Claim> claimBatch(
            String ownerId, int maximumEvents, Instant observedAt, Duration claimDuration) {
        if (ownerId == null || ownerId.isBlank()) return AsyncOperation.failure(new IllegalArgumentException("ownerId is required"));
        if (maximumEvents < 1 || maximumEvents > 256) return AsyncOperation.failure(new IllegalArgumentException("maximumEvents must be between 1 and 256"));
        if (observedAt == null || claimDuration == null || claimDuration.isNegative() || claimDuration.isZero()) {
            return AsyncOperation.failure(new IllegalArgumentException("claim time and positive duration are required"));
        }
        return async(() -> {
            ensureOpen();
            UUID token = UUID.randomUUID();
            Instant expiresAt = observedAt.plus(claimDuration);
            try (Connection connection = state.connection()) {
                connection.setAutoCommit(false);
                try {
                    try (PreparedStatement lease = connection.prepareStatement(
                            "SELECT claim_token,claim_expires_at FROM media_lifecycle_outbox_publisher_lease "
                                    + "WHERE publisher_key='media-lifecycle' FOR UPDATE");
                         ResultSet activeLease = lease.executeQuery()) {
                        if (!activeLease.next()) throw new SQLException("Media lifecycle publisher lease row is missing");
                        String activeToken = activeLease.getString("claim_token");
                        long activeExpiry = activeLease.getLong("claim_expires_at");
                        if (activeToken != null && activeExpiry > observedAt.toEpochMilli()) {
                            connection.commit();
                            return new Claim(ownerId, token, expiresAt, List.of());
                        }
                    }
                    List<OutboundEvent> events = new ArrayList<>();
                    String selectSql = "SELECT event_id,tenant_id,subject_id,event_type,payload_json,occurred_at,publication_attempts,correlation_id,created_at "
                            + "FROM media_lifecycle_outbox WHERE published_at IS NULL AND (claim_expires_at IS NULL OR claim_expires_at<=?) "
                            + "ORDER BY created_at,event_id LIMIT ? FOR UPDATE SKIP LOCKED";
                    try (PreparedStatement select = connection.prepareStatement(selectSql)) {
                        select.setLong(1, observedAt.toEpochMilli());
                        select.setInt(2, maximumEvents);
                        try (ResultSet rows = select.executeQuery()) {
                            while (rows.next()) {
                                UUID eventId = UUID.fromString(rows.getString("event_id"));
                                int previousAttempts = rows.getInt("publication_attempts");
                                int attemptNumber = Math.addExact(previousAttempts, 1);
                                String payloadJson = rows.getString("payload_json");
                                String fingerprint = deliveryFingerprint(eventId,
                                        rows.getString("tenant_id"), rows.getString("subject_id"),
                                        rows.getString("event_type"), payloadJson,
                                        rows.getLong("occurred_at"), rows.getString("correlation_id"));
                                try (PreparedStatement update = connection.prepareStatement(
                                        "UPDATE media_lifecycle_outbox SET claim_owner=?,claim_token=?,claim_expires_at=?,publication_attempts=? WHERE event_id=?")) {
                                    update.setString(1, ownerId);
                                    update.setObject(2, token);
                                    update.setLong(3, expiresAt.toEpochMilli());
                                    update.setInt(4, attemptNumber);
                                    update.setObject(5, eventId);
                                    if (update.executeUpdate() != 1) throw new SQLException("Media outbox claim was lost");
                                }
                                // An expired claim without a persisted acknowledgement has an unknown broker outcome.
                                // Preserve that fact before recording the next immutable delivery attempt.
                                try (PreparedStatement expired = connection.prepareStatement(
                                        "UPDATE media_lifecycle_outbox_delivery_attempts SET status='OUTCOME_UNKNOWN',failure_code='CLAIM_EXPIRED_WITHOUT_ACK' "
                                                + "WHERE event_id=? AND status='CLAIMED' AND claim_expires_at<=?")) {
                                    expired.setObject(1, eventId);
                                    expired.setLong(2, observedAt.toEpochMilli());
                                    expired.executeUpdate();
                                }
                                try (PreparedStatement attempt = connection.prepareStatement(
                                        "INSERT INTO media_lifecycle_outbox_delivery_attempts "
                                                + "(event_id,attempt_number,claim_owner,claim_token,payload_fingerprint,claimed_at,claim_expires_at,status) "
                                                + "VALUES (?,?,?,?,?,?,?,'CLAIMED')")) {
                                    attempt.setObject(1, eventId);
                                    attempt.setInt(2, attemptNumber);
                                    attempt.setString(3, ownerId);
                                    attempt.setObject(4, token);
                                    attempt.setString(5, fingerprint);
                                    attempt.setLong(6, observedAt.toEpochMilli());
                                    attempt.setLong(7, expiresAt.toEpochMilli());
                                    if (attempt.executeUpdate() != 1) throw new SQLException("Media outbox delivery attempt was not recorded");
                                }
                                events.add(new OutboundEvent(eventId, rows.getString("tenant_id"),
                                        rows.getString("subject_id"), rows.getString("event_type"),
                                        state.mapper().readValue(payloadJson, new TypeReference<>() { }),
                                        Instant.ofEpochMilli(rows.getLong("occurred_at")), previousAttempts,
                                        rows.getString("correlation_id")));
                            }
                        }
                    }
                    if (!events.isEmpty()) {
                        try (PreparedStatement lease = connection.prepareStatement(
                                "UPDATE media_lifecycle_outbox_publisher_lease SET claim_owner=?,claim_token=?,claim_expires_at=? "
                                        + "WHERE publisher_key='media-lifecycle'")) {
                            lease.setString(1, ownerId);
                            lease.setObject(2, token);
                            lease.setLong(3, expiresAt.toEpochMilli());
                            if (lease.executeUpdate() != 1) throw new SQLException("Media lifecycle publisher lease was not persisted");
                        }
                    }
                    connection.commit();
                    return new Claim(ownerId, token, expiresAt, events);
                } catch (Exception failure) {
                    rollback(connection, failure);
                    throw failure instanceof RuntimeException runtime ? runtime : databaseFailure("claim Media lifecycle outbox", (Exception) failure);
                }
            } catch (SQLException failure) {
                throw databaseFailure("open Media lifecycle outbox claim transaction", failure);
            }
        });
    }

    @Override public AsyncOperation<Void> markPublished(UUID claimToken, UUID eventId, Instant publishedAt) {
        if (claimToken == null || eventId == null || publishedAt == null) return AsyncOperation.failure(new IllegalArgumentException("claim token, event ID, and timestamp are required"));
        return async(() -> {
            ensureOpen();
            try (Connection connection = state.connection()) {
                connection.setAutoCommit(false);
                try {
                    try (PreparedStatement event = connection.prepareStatement(
                            "UPDATE media_lifecycle_outbox SET published_at=?,failed_at=NULL,failure_code=NULL,claim_owner=NULL,claim_token=NULL,claim_expires_at=NULL "
                                    + "WHERE event_id=? AND claim_token=? AND published_at IS NULL AND claim_expires_at>?")) {
                        event.setLong(1, publishedAt.toEpochMilli());
                        event.setObject(2, eventId);
                        event.setObject(3, claimToken);
                        event.setLong(4, publishedAt.toEpochMilli());
                        if (event.executeUpdate() != 1) throw new IllegalStateException("Media outbox claim is stale, expired, or event is already final");
                    }
                    try (PreparedStatement attempt = connection.prepareStatement(
                            "UPDATE media_lifecycle_outbox_delivery_attempts SET status='PUBLISHED',broker_accepted_at=?,failure_code=NULL "
                                    + "WHERE event_id=? AND claim_token=? AND status='CLAIMED'")) {
                        attempt.setLong(1, publishedAt.toEpochMilli());
                        attempt.setObject(2, eventId);
                        attempt.setObject(3, claimToken);
                        if (attempt.executeUpdate() != 1) throw new SQLException("Media outbox delivery attempt acknowledgement was not persisted");
                    }
                    connection.commit();
                    return null;
                } catch (Exception failure) {
                    rollback(connection, failure);
                    throw failure instanceof RuntimeException runtime ? runtime
                            : databaseFailure("persist Media outbox publication acknowledgement", (Exception) failure);
                }
            } catch (SQLException failure) {
                throw databaseFailure("open Media outbox acknowledgement transaction", failure);
            }
        });
    }

    @Override public AsyncOperation<Void> markFailed(UUID claimToken, UUID eventId, String failureCode, Instant observedAt) {
        if (failureCode == null || failureCode.isBlank()) return AsyncOperation.failure(new IllegalArgumentException("failureCode is required"));
        if (claimToken == null || eventId == null || observedAt == null) return AsyncOperation.failure(new IllegalArgumentException("claim token, event ID, and timestamp are required"));
        return async(() -> {
            ensureOpen();
            try (Connection connection = state.connection()) {
                connection.setAutoCommit(false);
                try {
                    try (PreparedStatement event = connection.prepareStatement(
                            "UPDATE media_lifecycle_outbox SET failed_at=?,failure_code=? WHERE event_id=? AND claim_token=? AND published_at IS NULL AND claim_expires_at>?")) {
                        event.setLong(1, observedAt.toEpochMilli());
                        event.setString(2, failureCode);
                        event.setObject(3, eventId);
                        event.setObject(4, claimToken);
                        event.setLong(5, observedAt.toEpochMilli());
                        if (event.executeUpdate() != 1) throw new IllegalStateException("Media outbox claim is stale or expired");
                    }
                    try (PreparedStatement attempt = connection.prepareStatement(
                            "UPDATE media_lifecycle_outbox_delivery_attempts SET status='FAILED',failure_code=? "
                                    + "WHERE event_id=? AND claim_token=? AND status='CLAIMED'")) {
                        attempt.setString(1, failureCode);
                        attempt.setObject(2, eventId);
                        attempt.setObject(3, claimToken);
                        if (attempt.executeUpdate() != 1) throw new SQLException("Media outbox failure attempt was not persisted");
                    }
                    connection.commit();
                    return null;
                } catch (Exception failure) {
                    rollback(connection, failure);
                    throw failure instanceof RuntimeException runtime ? runtime
                            : databaseFailure("persist Media outbox delivery failure", (Exception) failure);
                }
            } catch (SQLException failure) {
                throw databaseFailure("open Media outbox failure transaction", failure);
            }
        });
    }

    @Override
    public AsyncOperation<Integer> releaseClaim(UUID claimToken, Instant observedAt) {
        return async(() -> {
            ensureOpen();
            try (Connection connection = state.connection()) {
                connection.setAutoCommit(false);
                try {
                    try (PreparedStatement attempts = connection.prepareStatement(
                            "UPDATE media_lifecycle_outbox_delivery_attempts SET status='CLAIM_RELEASED' "
                                    + "WHERE claim_token=? AND status='CLAIMED'")) {
                        attempts.setObject(1, claimToken);
                        attempts.executeUpdate();
                    }
                    int released;
                    try (PreparedStatement statement = connection.prepareStatement(
                            "UPDATE media_lifecycle_outbox SET claim_owner=NULL,claim_token=NULL,claim_expires_at=NULL "
                                    + "WHERE claim_token=? AND published_at IS NULL")) {
                        statement.setObject(1, claimToken);
                        released = statement.executeUpdate();
                    }
                    try (PreparedStatement lease = connection.prepareStatement(
                            "UPDATE media_lifecycle_outbox_publisher_lease SET claim_owner=NULL,claim_token=NULL,claim_expires_at=NULL "
                                    + "WHERE publisher_key='media-lifecycle' AND claim_token=?")) {
                        lease.setObject(1, claimToken);
                        lease.executeUpdate();
                    }
                    connection.commit();
                    return released;
                } catch (Exception failure) {
                    rollback(connection, failure);
                    throw failure instanceof RuntimeException runtime ? runtime
                            : databaseFailure("release Media lifecycle outbox claim", (Exception) failure);
                }
            } catch (SQLException failure) { throw databaseFailure("release Media lifecycle outbox claim", failure); }
        });
    }

    /** Append through the caller's transaction so job state and event intent commit together. */
    static void append(Connection connection, MediaLifecycleEventRow event, MediaAwsPostgresqlRuntimeState state)
            throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "INSERT INTO media_lifecycle_outbox (event_id,tenant_id,subject_id,event_type,payload_json,occurred_at,correlation_id,created_at) "
                        + "VALUES (?,?,?,?,?,?,?,?)")) {
            statement.setObject(1, event.eventId());
            statement.setString(2, event.tenantId());
            statement.setString(3, event.subjectId());
            statement.setString(4, event.eventType());
            statement.setString(5, state.mapper().writeValueAsString(event.payload()));
            statement.setLong(6, event.occurredAt().toEpochMilli());
            statement.setString(7, event.correlationId());
            statement.setLong(8, event.occurredAt().toEpochMilli());
            statement.executeUpdate();
        } catch (tools.jackson.core.JacksonException failure) {
            throw new SQLException("Unable to serialize Media lifecycle outbox payload", failure);
        }
    }

    private <T> AsyncOperation<T> async(java.util.concurrent.Callable<T> action) {
        if (closed.get()) return AsyncOperation.failure(new IllegalStateException("Media outbox source is closed"));
        return AsyncOperation.from(CompletableFuture.supplyAsync(() -> {
            try { return action.call(); }
            catch (RuntimeException failure) { throw failure; }
            catch (Exception failure) { throw new IllegalStateException("Media outbox operation failed", failure); }
        }));
    }

    private void ensureOpen() { if (closed.get()) throw new IllegalStateException("Media outbox source is closed"); }
    @Override public void close() { if (closed.compareAndSet(false, true)) state.release(); }

    private static void rollback(Connection connection, Exception failure) {
        try { connection.rollback(); } catch (SQLException rollbackFailure) { failure.addSuppressed(rollbackFailure); }
    }
    private static IllegalStateException databaseFailure(String operation, Exception failure) {
        return new IllegalStateException("Unable to " + operation, failure);
    }

    private static String deliveryFingerprint(UUID eventId, String tenantId, String subjectId,
            String eventType, String payloadJson, long occurredAt, String correlationId) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            updateDigest(digest, eventId.toString());
            updateDigest(digest, tenantId);
            updateDigest(digest, subjectId);
            updateDigest(digest, eventType);
            updateDigest(digest, payloadJson);
            updateDigest(digest, Long.toString(occurredAt));
            updateDigest(digest, correlationId == null ? "" : correlationId);
            return java.util.HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is not available", impossible);
        }
    }

    private static void updateDigest(MessageDigest digest, String value) {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        digest.update((byte) (bytes.length >>> 24));
        digest.update((byte) (bytes.length >>> 16));
        digest.update((byte) (bytes.length >>> 8));
        digest.update((byte) bytes.length);
        digest.update(bytes);
    }

    record MediaLifecycleEventRow(UUID eventId, String tenantId, String subjectId, String eventType,
                                  Map<String, Object> payload, Instant occurredAt, String correlationId) { }
}
