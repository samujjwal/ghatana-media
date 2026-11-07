package com.ghatana.media.provider.aws;

import com.ghatana.media.production.delivery.DeliveryOperationStore;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * PostgreSQL idempotency ledger and exact-scope cross-process dispatch claim store for Media delivery.
 * Claims fence operation state and are passed to destination ports; they are not an authorization
 * source or destination-finality verifier, and a real destination must enforce stale-token rejection.
 */
public final class PostgresqlMediaDeliveryOperationStore implements DeliveryOperationStore, AutoCloseable {
    private final MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
    private final AtomicBoolean closed = new AtomicBoolean();

    @Override public boolean supportsDurableDispatchClaims() { return true; }

    @Override public Optional<Operation> find(String tenantId, String requestId) {
        ensureOpen();
        try (Connection connection = state.connection();
             PreparedStatement select = connection.prepareStatement("""
                     SELECT principal_id,artifact_id,version_ref,artifact_digest,destination_ref,
                            request_fingerprint,status,acknowledged_bytes,destination_receipt_ref
                     FROM media_delivery_operations WHERE tenant_id=? AND request_id=?
                     """)) {
            select.setString(1, tenantId); select.setString(2, requestId);
            try (ResultSet row = select.executeQuery()) {
                if (!row.next()) return Optional.empty();
                return Optional.of(new Operation(tenantId, row.getString(1), requestId,
                        row.getString(2), row.getString(3), row.getString(4), row.getString(5),
                        row.getString(6), com.ghatana.media.production.delivery.MediaDeliveryEngine.Status.valueOf(row.getString(7)),
                        row.getInt(8), row.getString(9)));
            }
        } catch (SQLException failure) {
            throw new IllegalStateException("delivery operation readback failed", failure);
        }
    }

    @Override public boolean insertIfAbsent(Operation operation) {
        ensureOpen();
        try (Connection connection = state.connection();
             PreparedStatement insert = connection.prepareStatement("""
                     INSERT INTO media_delivery_operations
                       (tenant_id,request_id,principal_id,artifact_id,version_ref,artifact_digest,
                        destination_ref,request_fingerprint,status,acknowledged_bytes,destination_receipt_ref)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (tenant_id,request_id) DO NOTHING
                     """)) {
            bind(insert, operation);
            return insert.executeUpdate() == 1;
        } catch (SQLException failure) {
            throw new IllegalStateException("delivery operation insert failed", failure);
        }
    }

    @Override public boolean update(Operation operation) {
        ensureOpen();
        try (Connection connection = state.connection();
             PreparedStatement update = connection.prepareStatement("""
                     UPDATE media_delivery_operations
                     SET status=?,acknowledged_bytes=?,destination_receipt_ref=?,updated_at=CURRENT_TIMESTAMP
                     WHERE tenant_id=? AND request_id=? AND request_fingerprint=?
                     AND principal_id=? AND artifact_id=? AND version_ref=? AND artifact_digest=? AND destination_ref=?
                       AND (dispatch_claim_owner_id IS NULL OR dispatch_claim_expires_at <= CURRENT_TIMESTAMP)
                       AND (
                         (? IN ('REVOKED','UNAVAILABLE') AND status='QUEUED' AND acknowledged_bytes=0 AND ?=0)
                         OR (?='OUTCOME_UNKNOWN' AND status IN ('QUEUED','OUTCOME_UNKNOWN','SENT')
                             AND ? >= acknowledged_bytes AND (status <> 'QUEUED' OR ?=0))
                         OR (? IN ('SENT','DESTINATION_CONFIRMED') AND status IN ('OUTCOME_UNKNOWN','SENT')
                             AND ? >= acknowledged_bytes)
                       )
                     """)) {
            update.setString(1, operation.status().name()); update.setInt(2, operation.acknowledgedBytes());
            update.setString(3, operation.destinationReceiptRef()); update.setString(4, operation.tenantId());
            update.setString(5, operation.requestId()); update.setString(6, operation.requestFingerprint());
            update.setString(7, operation.principalId()); update.setString(8, operation.artifactId());
            update.setString(9, operation.versionRef()); update.setString(10, operation.artifactDigest());
            update.setString(11, operation.destinationRef());
            bindTransition(update, operation, 12);
            return update.executeUpdate() == 1;
        } catch (SQLException failure) {
            throw new IllegalStateException("delivery operation update failed", failure);
        }
    }

    @Override public Optional<DispatchClaim> acquireDispatchClaim(Operation operation, String ownerId, Duration lease) {
        ensureOpen();
        if (ownerId == null || ownerId.isBlank() || !ownerId.equals(ownerId.strip()) || ownerId.length() > 255) {
            throw new IllegalArgumentException("ownerId is invalid");
        }
        long leaseMillis = leaseMillis(lease);
        try (Connection connection = state.connection();
             PreparedStatement update = connection.prepareStatement("""
                     UPDATE media_delivery_operations
                     SET dispatch_claim_owner_id=?, dispatch_claim_fence=dispatch_claim_fence+1,
                         dispatch_claim_expires_at=CURRENT_TIMESTAMP + (? * INTERVAL '1 millisecond')
                     WHERE tenant_id=? AND request_id=? AND request_fingerprint=? AND principal_id=?
                       AND artifact_id=? AND version_ref=? AND artifact_digest=? AND destination_ref=?
                       AND status=? AND acknowledged_bytes=?
                       AND destination_receipt_ref IS NOT DISTINCT FROM ?
                       AND (dispatch_claim_owner_id IS NULL OR dispatch_claim_expires_at <= CURRENT_TIMESTAMP)
                       AND dispatch_claim_fence < 9223372036854775807
                     RETURNING dispatch_claim_fence, dispatch_claim_expires_at
                     """)) {
            update.setString(1, ownerId); update.setLong(2, leaseMillis);
            bindScope(update, operation, 3);
            update.setString(11, operation.status().name());
            update.setInt(12, operation.acknowledgedBytes());
            update.setString(13, operation.destinationReceiptRef());
            try (ResultSet row = update.executeQuery()) {
                if (!row.next()) return Optional.empty();
                return Optional.of(claim(operation, ownerId, row.getLong(1), row.getTimestamp(2).toInstant()));
            }
        } catch (SQLException failure) {
            throw new IllegalStateException("delivery dispatch claim acquisition failed", failure);
        }
    }

    @Override public Optional<DispatchClaim> renewDispatchClaim(DispatchClaim claim, Duration lease) {
        ensureOpen();
        long leaseMillis = leaseMillis(lease);
        try (Connection connection = state.connection();
             PreparedStatement update = connection.prepareStatement("""
                     UPDATE media_delivery_operations
                     SET dispatch_claim_expires_at=CURRENT_TIMESTAMP + (? * INTERVAL '1 millisecond')
                     WHERE tenant_id=? AND request_id=? AND request_fingerprint=? AND principal_id=?
                       AND artifact_id=? AND version_ref=? AND artifact_digest=? AND destination_ref=?
                       AND dispatch_claim_owner_id=? AND dispatch_claim_fence=?
                       AND dispatch_claim_expires_at > CURRENT_TIMESTAMP
                     RETURNING dispatch_claim_expires_at
                     """)) {
            update.setLong(1, leaseMillis); bindScope(update, claim, 2);
            update.setString(10, claim.ownerId()); update.setLong(11, claim.fence());
            try (ResultSet row = update.executeQuery()) {
                if (!row.next()) return Optional.empty();
                return Optional.of(claim(claim, row.getTimestamp(1).toInstant()));
            }
        } catch (SQLException failure) {
            throw new IllegalStateException("delivery dispatch claim renewal failed", failure);
        }
    }

    @Override public boolean isDispatchClaimCurrent(DispatchClaim claim) {
        ensureOpen();
        try (Connection connection = state.connection();
             PreparedStatement select = connection.prepareStatement("""
                     SELECT 1 FROM media_delivery_operations
                     WHERE tenant_id=? AND request_id=? AND request_fingerprint=? AND principal_id=?
                       AND artifact_id=? AND version_ref=? AND artifact_digest=? AND destination_ref=?
                       AND dispatch_claim_owner_id=? AND dispatch_claim_fence=?
                       AND dispatch_claim_expires_at > CURRENT_TIMESTAMP
                     """)) {
            bindScope(select, claim, 1);
            select.setString(9, claim.ownerId()); select.setLong(10, claim.fence());
            try (ResultSet row = select.executeQuery()) { return row.next(); }
        } catch (SQLException failure) {
            throw new IllegalStateException("delivery dispatch claim readback failed", failure);
        }
    }

    @Override public boolean releaseDispatchClaim(DispatchClaim claim) {
        ensureOpen();
        try (Connection connection = state.connection();
             PreparedStatement update = connection.prepareStatement("""
                     UPDATE media_delivery_operations
                     SET dispatch_claim_owner_id=NULL, dispatch_claim_expires_at=NULL
                     WHERE tenant_id=? AND request_id=? AND request_fingerprint=? AND principal_id=?
                       AND artifact_id=? AND version_ref=? AND artifact_digest=? AND destination_ref=?
                       AND dispatch_claim_owner_id=? AND dispatch_claim_fence=?
                       AND dispatch_claim_expires_at > CURRENT_TIMESTAMP
                     """)) {
            bindScope(update, claim, 1);
            update.setString(9, claim.ownerId()); update.setLong(10, claim.fence());
            return update.executeUpdate() == 1;
        } catch (SQLException failure) {
            throw new IllegalStateException("delivery dispatch claim release failed", failure);
        }
    }

    @Override public boolean update(Operation operation, DispatchClaim claim) {
        ensureOpen();
        if (!claim.matches(operation)) return false;
        try (Connection connection = state.connection();
             PreparedStatement update = connection.prepareStatement("""
                     UPDATE media_delivery_operations
                     SET status=?,acknowledged_bytes=?,destination_receipt_ref=?,updated_at=CURRENT_TIMESTAMP
                     WHERE tenant_id=? AND request_id=? AND request_fingerprint=? AND principal_id=?
                       AND artifact_id=? AND version_ref=? AND artifact_digest=? AND destination_ref=?
                       AND dispatch_claim_owner_id=? AND dispatch_claim_fence=?
                       AND dispatch_claim_expires_at > CURRENT_TIMESTAMP
                       AND (
                         (? IN ('REVOKED','UNAVAILABLE') AND status='QUEUED' AND acknowledged_bytes=0 AND ?=0)
                         OR (?='OUTCOME_UNKNOWN' AND status IN ('QUEUED','OUTCOME_UNKNOWN','SENT')
                             AND ? >= acknowledged_bytes AND (status <> 'QUEUED' OR ?=0))
                         OR (? IN ('SENT','DESTINATION_CONFIRMED') AND status IN ('OUTCOME_UNKNOWN','SENT')
                             AND ? >= acknowledged_bytes)
                       )
                     """)) {
            update.setString(1, operation.status().name()); update.setInt(2, operation.acknowledgedBytes());
            update.setString(3, operation.destinationReceiptRef()); bindScope(update, operation, 4);
            update.setString(12, claim.ownerId()); update.setLong(13, claim.fence());
            bindTransition(update, operation, 14);
            return update.executeUpdate() == 1;
        } catch (SQLException failure) {
            throw new IllegalStateException("fenced delivery operation update failed", failure);
        }
    }

    private static void bindScope(PreparedStatement statement, Operation operation, int offset) throws SQLException {
        statement.setString(offset, operation.tenantId()); statement.setString(offset + 1, operation.requestId());
        statement.setString(offset + 2, operation.requestFingerprint()); statement.setString(offset + 3, operation.principalId());
        statement.setString(offset + 4, operation.artifactId()); statement.setString(offset + 5, operation.versionRef());
        statement.setString(offset + 6, operation.artifactDigest()); statement.setString(offset + 7, operation.destinationRef());
    }

    private static void bindScope(PreparedStatement statement, DispatchClaim claim, int offset) throws SQLException {
        statement.setString(offset, claim.tenantId()); statement.setString(offset + 1, claim.requestId());
        statement.setString(offset + 2, claim.requestFingerprint()); statement.setString(offset + 3, claim.principalId());
        statement.setString(offset + 4, claim.artifactId()); statement.setString(offset + 5, claim.versionRef());
        statement.setString(offset + 6, claim.artifactDigest()); statement.setString(offset + 7, claim.destinationRef());
    }

    private static void bindTransition(PreparedStatement statement, Operation operation, int offset)
            throws SQLException {
        String status = operation.status().name();
        int acknowledgedBytes = operation.acknowledgedBytes();
        statement.setString(offset, status); statement.setInt(offset + 1, acknowledgedBytes);
        statement.setString(offset + 2, status); statement.setInt(offset + 3, acknowledgedBytes);
        statement.setInt(offset + 4, acknowledgedBytes);
        statement.setString(offset + 5, status); statement.setInt(offset + 6, acknowledgedBytes);
    }

    private static DispatchClaim claim(Operation operation, String ownerId, long fence, Instant expiresAt) {
        return new DispatchClaim(operation.tenantId(), operation.principalId(), operation.requestId(),
                operation.artifactId(), operation.versionRef(), operation.artifactDigest(), operation.destinationRef(),
                operation.requestFingerprint(), ownerId, fence, expiresAt);
    }

    /** PostgreSQL stores timestamptz at microsecond precision; never truncate a valid positive lease to zero. */
    private static long leaseMillis(Duration lease) {
        Duration checked = DeliveryOperationStore.checkedLease(lease);
        long millis = checked.toMillis();
        return checked.minusMillis(millis).isZero() ? millis : Math.addExact(millis, 1);
    }

    private static DispatchClaim claim(DispatchClaim current, Instant expiresAt) {
        return new DispatchClaim(current.tenantId(), current.principalId(), current.requestId(), current.artifactId(),
                current.versionRef(), current.artifactDigest(), current.destinationRef(), current.requestFingerprint(),
                current.ownerId(), current.fence(), expiresAt);
    }

    private static void bind(PreparedStatement statement, Operation operation) throws SQLException {
        statement.setString(1, operation.tenantId()); statement.setString(2, operation.requestId());
        statement.setString(3, operation.principalId()); statement.setString(4, operation.artifactId());
        statement.setString(5, operation.versionRef()); statement.setString(6, operation.artifactDigest());
        statement.setString(7, operation.destinationRef()); statement.setString(8, operation.requestFingerprint());
        statement.setString(9, operation.status().name()); statement.setInt(10, operation.acknowledgedBytes());
        statement.setString(11, operation.destinationReceiptRef());
    }

    private void ensureOpen() { if (closed.get()) throw new IllegalStateException("delivery operation store is closed"); }

    @Override public void close() {
        if (closed.compareAndSet(false, true)) state.release();
    }
}
