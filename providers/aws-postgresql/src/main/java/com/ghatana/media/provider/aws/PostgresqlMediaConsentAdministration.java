package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaConsentAdministration;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * PostgreSQL self-service consent administration over the canonical Media consent table.
 *
 * <p>Consent identity/version/timestamps are provider-owned. Revocation is optimistic and
 * idempotent; grant/revoke transitions are emitted to the dedicated audit logger without exposing
 * media content or credential material.
 *
 * @doc.type class
 * @doc.purpose Persist principal-owned Media consent grant/revoke lifecycle
 * @doc.layer provider
 * @doc.pattern RepositoryAdapter, PrivacyControl
 */
public final class PostgresqlMediaConsentAdministration implements MediaConsentAdministration {
    private static final Logger audit = LoggerFactory.getLogger("media.auditTrail");
    private static final String ADMINISTRATION_ID = "postgresql-media-consent";

    private final MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
    private final AtomicBoolean closed = new AtomicBoolean(false);

    @Override public String administrationId() { return ADMINISTRATION_ID; }

    @Override
    public ConsentRecord grant(GrantRequest request) {
        ensureOpen();
        java.util.Objects.requireNonNull(request, "request");
        String consentId = UUID.randomUUID().toString();
        Instant grantedAt = Instant.now();
        ConsentRecord record = new ConsentRecord(
                request.tenantId(),
                consentId,
                request.principalId(),
                request.purposes(),
                request.allowedRegions(),
                request.externalProcessingAllowed(),
                request.biometricProcessingAllowed(),
                grantedAt,
                request.expiresAt(),
                null,
                1L);
        String sql = """
                INSERT INTO media_consents
                    (tenant_id,consent_id,principal_id,purposes_csv,allowed_regions_csv,
                     external_processing_allowed,biometric_processing_allowed,granted_at,
                     expires_at,revoked_at,version)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
                """;
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(sql)) {
            bindInsert(statement, record);
            statement.executeUpdate();
        } catch (SQLException failure) {
            throw databaseFailure("grant Media consent", failure);
        }
        audit.info(
                "MEDIA_CONSENT_GRANTED tenantId={} principalId={} consentId={} purposes={} regions={} externalAllowed={} biometricAllowed={} correlationId={}",
                record.tenantId(), record.principalId(), record.consentId(), record.purposes(),
                record.allowedRegions(), record.externalProcessingAllowed(),
                record.biometricProcessingAllowed(), request.correlationId());
        return record;
    }

    @Override
    public Optional<ConsentRecord> find(String tenantId, String principalId, String consentId) {
        ensureOpen();
        required(tenantId, "tenantId");
        required(principalId, "principalId");
        required(consentId, "consentId");
        String sql = """
                SELECT purposes_csv,allowed_regions_csv,external_processing_allowed,
                       biometric_processing_allowed,granted_at,expires_at,revoked_at,version
                  FROM media_consents
                 WHERE tenant_id=? AND principal_id=? AND consent_id=?
                """;
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, tenantId.trim());
            statement.setString(2, principalId.trim());
            statement.setString(3, consentId.trim());
            try (ResultSet result = statement.executeQuery()) {
                return result.next()
                        ? Optional.of(read(tenantId.trim(), consentId.trim(), principalId.trim(), result))
                        : Optional.empty();
            }
        } catch (SQLException failure) {
            throw databaseFailure("read Media consent", failure);
        }
    }

    @Override
    public List<ConsentRecord> list(String tenantId, String principalId, int limit) {
        ensureOpen();
        required(tenantId, "tenantId");
        required(principalId, "principalId");
        if (limit < 1 || limit > 1000) throw new IllegalArgumentException("limit must be between 1 and 1000");
        String sql = """
                SELECT consent_id,purposes_csv,allowed_regions_csv,external_processing_allowed,
                       biometric_processing_allowed,granted_at,expires_at,revoked_at,version
                  FROM media_consents
                 WHERE tenant_id=? AND principal_id=?
                 ORDER BY granted_at DESC, consent_id
                 LIMIT ?
                """;
        List<ConsentRecord> values = new ArrayList<>();
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, tenantId.trim());
            statement.setString(2, principalId.trim());
            statement.setInt(3, limit);
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) {
                    values.add(read(
                            tenantId.trim(), result.getString("consent_id"), principalId.trim(), result));
                }
            }
            return List.copyOf(values);
        } catch (SQLException failure) {
            throw databaseFailure("list Media consents", failure);
        }
    }

    @Override
    public Optional<ConsentRecord> revoke(
            String tenantId,
            String principalId,
            String consentId,
            String correlationId) {
        ensureOpen();
        tenantId = required(tenantId, "tenantId");
        principalId = required(principalId, "principalId");
        consentId = required(consentId, "consentId");
        correlationId = required(correlationId, "correlationId");
        Optional<ConsentRecord> existing = find(tenantId, principalId, consentId);
        if (existing.isEmpty()) return Optional.empty();
        ConsentRecord current = existing.orElseThrow();
        if (current.revokedAt() != null) return existing;

        Instant revokedAt = Instant.now();
        String sql = """
                UPDATE media_consents
                   SET revoked_at=?, version=version+1
                 WHERE tenant_id=? AND principal_id=? AND consent_id=?
                   AND version=? AND revoked_at IS NULL
                """;
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setLong(1, revokedAt.toEpochMilli());
            statement.setString(2, tenantId);
            statement.setString(3, principalId);
            statement.setString(4, consentId);
            statement.setLong(5, current.version());
            if (statement.executeUpdate() != 1) {
                Optional<ConsentRecord> reconciled = find(tenantId, principalId, consentId);
                if (reconciled.isPresent() && reconciled.orElseThrow().revokedAt() != null) {
                    return reconciled;
                }
                throw new IllegalStateException("Media consent version changed concurrently");
            }
        } catch (SQLException failure) {
            throw databaseFailure("revoke Media consent", failure);
        }
        ConsentRecord revoked = new ConsentRecord(
                current.tenantId(), current.consentId(), current.principalId(), current.purposes(),
                current.allowedRegions(), current.externalProcessingAllowed(),
                current.biometricProcessingAllowed(), current.grantedAt(), current.expiresAt(),
                revokedAt, current.version() + 1);
        audit.info(
                "MEDIA_CONSENT_REVOKED tenantId={} principalId={} consentId={} correlationId={}",
                tenantId, principalId, consentId, correlationId);
        return Optional.of(revoked);
    }

    @Override
    public boolean ready() {
        if (closed.get() || !state.ready()) return false;
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "SELECT tenant_id FROM media_consents WHERE 1=0");
             var result = statement.executeQuery()) {
            return true;
        } catch (Exception failure) {
            return false;
        }
    }

    @Override public boolean productionEligible() { return !closed.get() && state.productionEligible(); }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) state.release();
    }

    private static void bindInsert(PreparedStatement statement, ConsentRecord record) throws SQLException {
        statement.setString(1, record.tenantId());
        statement.setString(2, record.consentId());
        statement.setString(3, record.principalId());
        statement.setString(4, csv(record.purposes()));
        statement.setString(5, csv(record.allowedRegions()));
        statement.setBoolean(6, record.externalProcessingAllowed());
        statement.setBoolean(7, record.biometricProcessingAllowed());
        statement.setLong(8, record.grantedAt().toEpochMilli());
        nullableLong(statement, 9, record.expiresAt());
        nullableLong(statement, 10, record.revokedAt());
        statement.setLong(11, record.version());
    }

    private static ConsentRecord read(
            String tenantId,
            String consentId,
            String principalId,
            ResultSet result) throws SQLException {
        Long expiresAt = nullableLong(result, "expires_at");
        Long revokedAt = nullableLong(result, "revoked_at");
        return new ConsentRecord(
                tenantId,
                consentId,
                principalId,
                parseCsv(result.getString("purposes_csv")),
                parseCsv(result.getString("allowed_regions_csv")),
                result.getBoolean("external_processing_allowed"),
                result.getBoolean("biometric_processing_allowed"),
                Instant.ofEpochMilli(result.getLong("granted_at")),
                expiresAt == null ? null : Instant.ofEpochMilli(expiresAt),
                revokedAt == null ? null : Instant.ofEpochMilli(revokedAt),
                result.getLong("version"));
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("Media consent administration is closed");
        if (!state.configured()) throw new IllegalStateException("Media consent administration is not configured");
    }

    private static Set<String> parseCsv(String value) {
        LinkedHashSet<String> result = new LinkedHashSet<>();
        if (value == null || value.isBlank()) return Set.of();
        for (String item : value.split(",")) {
            String normalized = item.trim().toLowerCase(java.util.Locale.ROOT);
            if (!normalized.isBlank()) result.add(normalized);
        }
        return Set.copyOf(result);
    }

    private static String csv(Set<String> values) {
        return String.join(",", values.stream().sorted().toList());
    }

    private static void nullableLong(PreparedStatement statement, int index, Instant value) throws SQLException {
        if (value == null) statement.setNull(index, java.sql.Types.BIGINT);
        else statement.setLong(index, value.toEpochMilli());
    }

    private static Long nullableLong(ResultSet result, String column) throws SQLException {
        long value = result.getLong(column);
        return result.wasNull() ? null : value;
    }

    private static String required(String value, String field) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(field + " is required");
        return value.trim();
    }

    private static IllegalStateException databaseFailure(String operation, SQLException failure) {
        return new IllegalStateException("Unable to " + operation, failure);
    }
}
