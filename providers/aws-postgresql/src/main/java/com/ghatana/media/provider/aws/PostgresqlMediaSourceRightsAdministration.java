package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.HumanConsentDisposition;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.SourceKind;
import com.ghatana.media.runtime.MediaSourceRightsAdministration;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * PostgreSQL administration over the canonical Media source-rights records.
 *
 * <p>Registration writes exactly one immutable source-version record from authenticated producer
 * identity; revocation advances the revocation epoch and revokes every live processing decision
 * for that source so previously issued evidence fails closed. Registration, version, epoch and
 * timestamps are authority-owned; no caller flag can mark a source "rights verified".
 *
 * @doc.type class
 * @doc.purpose Persist authenticated Media source provenance, rights scope, and revocation
 * @doc.layer provider
 * @doc.pattern RepositoryAdapter, PrivacyControl
 */
public final class PostgresqlMediaSourceRightsAdministration implements MediaSourceRightsAdministration {
    private static final Logger audit = LoggerFactory.getLogger("media.auditTrail");
    private static final String ADMINISTRATION_ID = "postgresql-media-source-rights";

    private final MediaAwsPostgresqlRuntimeState state;
    private final AtomicBoolean closed = new AtomicBoolean(false);

    public PostgresqlMediaSourceRightsAdministration() {
        this(MediaAwsPostgresqlRuntimeState.acquire());
    }

    PostgresqlMediaSourceRightsAdministration(MediaAwsPostgresqlRuntimeState state) {
        this.state = state;
    }

    @Override public String administrationId() { return ADMINISTRATION_ID; }

    @Override
    public SourceRecord register(RegisterRequest request) {
        ensureOpen();
        java.util.Objects.requireNonNull(request, "request");
        Instant registeredAt = Instant.now();
        SourceRecord record = new SourceRecord(
                request.tenantId(), request.artifactId(), request.sourceVersion(), request.sourceSha256(),
                request.principalId(), request.sourceOwnerId(), request.sourceKind(),
                request.humanConsentDisposition(), request.consentDecisionId(),
                request.allowedOperations(), request.allowedPurposes(), request.allowedRegions(),
                request.allowedProviderRetentions(), request.sourceClockEvidenceRef(),
                request.provenanceRef(), request.principalId(), registeredAt, request.expiresAt(),
                0L, null);
        String sql = """
                INSERT INTO media_source_records
                    (tenant_id,artifact_id,source_version,source_sha256,principal_id,source_owner_id,
                     source_kind,human_consent_disposition,consent_decision_id,allowed_operations_csv,
                     allowed_purposes_csv,allowed_regions_csv,allowed_provider_retentions_csv,
                     source_clock_evidence_ref,provenance_ref,registered_by,registered_at,expires_at,
                     revocation_epoch,revoked_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
                """;
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(sql)) {
            bind(statement, record);
            statement.executeUpdate();
        } catch (SQLException failure) {
            throw databaseFailure("register Media source record", failure);
        }
        audit.info(
                "MEDIA_SOURCE_REGISTERED tenantId={} artifactId={} sourceVersion={} sourceOwnerId={} kind={} correlationId={}",
                record.tenantId(), record.artifactId(), record.sourceVersion(), record.sourceOwnerId(),
                record.sourceKind(), request.correlationId());
        return record;
    }

    @Override
    public Optional<SourceRecord> record(String tenantId, String artifactId, String sourceVersion) {
        ensureOpen();
        String sql = """
                SELECT source_sha256,principal_id,source_owner_id,source_kind,human_consent_disposition,
                       consent_decision_id,allowed_operations_csv,allowed_purposes_csv,allowed_regions_csv,
                       allowed_provider_retentions_csv,source_clock_evidence_ref,provenance_ref,
                       registered_by,registered_at,expires_at,revocation_epoch,revoked_at
                  FROM media_source_records
                 WHERE tenant_id=? AND artifact_id=? AND source_version=?
                """;
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, tenantId);
            statement.setString(2, artifactId);
            statement.setString(3, sourceVersion);
            try (ResultSet row = statement.executeQuery()) {
                if (!row.next()) return Optional.empty();
                return Optional.of(readRecord(row, tenantId, artifactId, sourceVersion));
            }
        } catch (SQLException failure) {
            throw databaseFailure("read Media source record", failure);
        }
    }

    @Override
    public Optional<SourceRecord> revoke(
            String tenantId,
            String artifactId,
            String sourceVersion,
            String principalId,
            String correlationId) {
        ensureOpen();
        long now = Instant.now().toEpochMilli();
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                SourceRecord current;
                try (PreparedStatement select = connection.prepareStatement("""
                        SELECT source_sha256,principal_id,source_owner_id,source_kind,
                               human_consent_disposition,consent_decision_id,allowed_operations_csv,
                               allowed_purposes_csv,allowed_regions_csv,allowed_provider_retentions_csv,
                               source_clock_evidence_ref,provenance_ref,registered_by,registered_at,
                               expires_at,revocation_epoch,revoked_at
                          FROM media_source_records
                         WHERE tenant_id=? AND artifact_id=? AND source_version=? FOR UPDATE
                        """)) {
                    select.setString(1, tenantId);
                    select.setString(2, artifactId);
                    select.setString(3, sourceVersion);
                    try (ResultSet row = select.executeQuery()) {
                        if (!row.next()) {
                            connection.rollback();
                            return Optional.empty();
                        }
                        current = readRecord(row, tenantId, artifactId, sourceVersion);
                    }
                }
                if (!current.principalId().equals(principalId)) {
                    connection.rollback();
                    throw new SecurityException("Media source record is not owned by the authenticated principal");
                }
                if (current.revoked()) {
                    connection.commit();
                    return Optional.of(current);
                }
                try (PreparedStatement update = connection.prepareStatement("""
                        UPDATE media_source_records
                           SET revoked_at=?, revocation_epoch=revocation_epoch+1
                         WHERE tenant_id=? AND artifact_id=? AND source_version=? AND revoked_at IS NULL
                        """)) {
                    update.setLong(1, now);
                    update.setString(2, tenantId);
                    update.setString(3, artifactId);
                    update.setString(4, sourceVersion);
                    update.executeUpdate();
                }
                try (PreparedStatement revokeDecisions = connection.prepareStatement("""
                        UPDATE media_source_rights_decisions SET revoked_at=?
                         WHERE tenant_id=? AND artifact_id=? AND source_version=? AND revoked_at IS NULL
                        """)) {
                    revokeDecisions.setLong(1, now);
                    revokeDecisions.setString(2, tenantId);
                    revokeDecisions.setString(3, artifactId);
                    revokeDecisions.setString(4, sourceVersion);
                    revokeDecisions.executeUpdate();
                }
                connection.commit();
                SourceRecord revoked = new SourceRecord(
                        current.tenantId(), current.artifactId(), current.sourceVersion(),
                        current.sourceSha256(), current.principalId(), current.sourceOwnerId(),
                        current.sourceKind(), current.humanConsentDisposition(), current.consentDecisionId(),
                        current.allowedOperations(), current.allowedPurposes(), current.allowedRegions(),
                        current.allowedProviderRetentions(), current.sourceClockEvidenceRef(),
                        current.provenanceRef(), current.registeredBy(), current.registeredAt(),
                        current.expiresAt(), current.revocationEpoch() + 1, Instant.ofEpochMilli(now));
                audit.info(
                        "MEDIA_SOURCE_REVOKED tenantId={} artifactId={} sourceVersion={} epoch={} correlationId={}",
                        tenantId, artifactId, sourceVersion, revoked.revocationEpoch(), correlationId);
                return Optional.of(revoked);
            } catch (RuntimeException | SQLException failure) {
                rollback(connection, failure);
                if (failure instanceof RuntimeException runtime) throw runtime;
                throw databaseFailure("revoke Media source record", (SQLException) failure);
            }
        } catch (SQLException failure) {
            throw databaseFailure("open Media source revocation transaction", failure);
        }
    }

    @Override
    public boolean ready() {
        if (closed.get() || !state.ready()) return false;
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "SELECT tenant_id FROM media_source_records WHERE 1=0");
             var result = statement.executeQuery()) {
            return true;
        } catch (Exception failure) {
            return false;
        }
    }

    @Override
    public boolean productionEligible() {
        return !closed.get() && state.productionEligible();
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) return;
        state.release();
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("Media source-rights administration is closed");
        if (!state.configured()) {
            throw new IllegalStateException("Media source-rights administration is not configured");
        }
    }

    private static void bind(PreparedStatement statement, SourceRecord record) throws SQLException {
        statement.setString(1, record.tenantId());
        statement.setString(2, record.artifactId());
        statement.setString(3, record.sourceVersion());
        statement.setString(4, record.sourceSha256());
        statement.setString(5, record.principalId());
        statement.setString(6, record.sourceOwnerId());
        statement.setString(7, record.sourceKind().name());
        statement.setString(8, record.humanConsentDisposition().name());
        statement.setString(9, record.consentDecisionId());
        statement.setString(10, csv(record.allowedOperations()));
        statement.setString(11, csv(record.allowedPurposes()));
        statement.setString(12, csv(record.allowedRegions()));
        statement.setString(13, retentions(record.allowedProviderRetentions()));
        statement.setString(14, record.sourceClockEvidenceRef());
        statement.setString(15, record.provenanceRef());
        statement.setString(16, record.registeredBy());
        statement.setLong(17, record.registeredAt().toEpochMilli());
        statement.setLong(18, record.expiresAt().toEpochMilli());
        statement.setLong(19, record.revocationEpoch());
    }

    static SourceRecord readRecord(ResultSet row, String tenantId, String artifactId, String sourceVersion)
            throws SQLException {
        long revoked = row.getLong("revoked_at");
        Instant revokedAt = row.wasNull() ? null : Instant.ofEpochMilli(revoked);
        return new SourceRecord(
                tenantId, artifactId, sourceVersion,
                row.getString("source_sha256"),
                row.getString("principal_id"),
                row.getString("source_owner_id"),
                SourceKind.valueOf(row.getString("source_kind")),
                HumanConsentDisposition.valueOf(row.getString("human_consent_disposition")),
                row.getString("consent_decision_id"),
                csvSet(row.getString("allowed_operations_csv")),
                csvSet(row.getString("allowed_purposes_csv")),
                csvSet(row.getString("allowed_regions_csv")),
                retentionSet(row.getString("allowed_provider_retentions_csv")),
                row.getString("source_clock_evidence_ref"),
                row.getString("provenance_ref"),
                row.getString("registered_by"),
                Instant.ofEpochMilli(row.getLong("registered_at")),
                Instant.ofEpochMilli(row.getLong("expires_at")),
                row.getLong("revocation_epoch"),
                revokedAt);
    }

    private static String csv(Set<String> values) {
        return String.join(",", values);
    }

    private static String retentions(Set<ProviderDataRetention> values) {
        StringBuilder result = new StringBuilder();
        for (ProviderDataRetention value : values) {
            if (result.length() > 0) result.append(',');
            result.append(value.name());
        }
        return result.toString();
    }

    private static Set<String> csvSet(String value) {
        LinkedHashSet<String> values = new LinkedHashSet<>();
        if (value == null || value.isBlank()) return Set.of();
        for (String item : value.split(",")) {
            String normalized = item.trim().toLowerCase(java.util.Locale.ROOT);
            if (!normalized.isBlank()) values.add(normalized);
        }
        return Set.copyOf(values);
    }

    private static Set<ProviderDataRetention> retentionSet(String value) {
        LinkedHashSet<ProviderDataRetention> values = new LinkedHashSet<>();
        if (value == null || value.isBlank()) return Set.of();
        for (String item : value.split(",")) {
            String normalized = item.trim();
            if (!normalized.isBlank()) values.add(ProviderDataRetention.valueOf(normalized));
        }
        return Set.copyOf(values);
    }

    private static void rollback(Connection connection, Exception failure) {
        try { connection.rollback(); }
        catch (SQLException rollbackFailure) { failure.addSuppressed(rollbackFailure); }
    }

    private static IllegalStateException databaseFailure(String operation, SQLException failure) {
        return new IllegalStateException("Media source-rights storage failed to " + operation, failure);
    }
}
