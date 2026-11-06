package com.ghatana.media.provider.aws;

import com.ghatana.media.production.delivery.DeliveryOperationStore;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * PostgreSQL idempotency ledger for Media delivery operations. This persists operation snapshots only;
 * it is not a cross-process dispatch claim, authorization source, or destination-finality verifier.
 */
public final class PostgresqlMediaDeliveryOperationStore implements DeliveryOperationStore, AutoCloseable {
    private final MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
    private final AtomicBoolean closed = new AtomicBoolean();

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
                        row.getString(6).trim(), com.ghatana.media.production.delivery.MediaDeliveryEngine.Status.valueOf(row.getString(7)),
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
                     """)) {
            update.setString(1, operation.status().name()); update.setInt(2, operation.acknowledgedBytes());
            update.setString(3, operation.destinationReceiptRef()); update.setString(4, operation.tenantId());
            update.setString(5, operation.requestId()); update.setString(6, operation.requestFingerprint());
            update.setString(7, operation.principalId()); update.setString(8, operation.artifactId());
            update.setString(9, operation.versionRef()); update.setString(10, operation.artifactDigest());
            update.setString(11, operation.destinationRef());
            return update.executeUpdate() == 1;
        } catch (SQLException failure) {
            throw new IllegalStateException("delivery operation update failed", failure);
        }
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
