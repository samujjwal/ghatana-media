package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.ConsentDecision;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaConsentAuthority;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;

import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Durable tenant/principal-bound Media consent authority over the canonical Media PostgreSQL state.
 *
 * <p>Consent permissions are read from durable state and never inferred from caller governance.
 * Revoked or expired records fail closed. This provider owns verification only; grant/revoke
 * mutation remains an administrative consent-management concern and must write the same schema.
 *
 * @doc.type class
 * @doc.purpose Verify durable Media consent without creating a second consent datastore
 * @doc.layer provider
 * @doc.pattern Provider, RepositoryAdapter
 */
public final class PostgresqlMediaConsentAuthority implements MediaConsentAuthority {
    private static final String AUTHORITY_ID = "postgresql-media-consent";
    private final MediaAwsPostgresqlRuntimeState state;
    private final AtomicBoolean closed = new AtomicBoolean(false);

    public PostgresqlMediaConsentAuthority() {
        this.state = MediaAwsPostgresqlRuntimeState.acquire();
    }

    @Override public String authorityId() { return AUTHORITY_ID; }

    @Override
    public ConsentDecision verify(
            String tenantId,
            String principalId,
            MediaGovernanceContext governance,
            String operation) {
        ensureOpen();
        if (tenantId == null || tenantId.isBlank()
                || principalId == null || principalId.isBlank()
                || governance == null || governance.consentId().isBlank()) {
            return ConsentDecision.unverified();
        }
        long now = Instant.now().toEpochMilli();
        String sql = """
                SELECT purposes_csv, allowed_regions_csv, external_processing_allowed,
                       biometric_processing_allowed, granted_at, expires_at, revoked_at
                  FROM media_consents
                 WHERE tenant_id=? AND consent_id=? AND principal_id=?
                """;
        try (var connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, tenantId.trim());
            statement.setString(2, governance.consentId());
            statement.setString(3, principalId.trim());
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next()) return ConsentDecision.unverified();
                Long expiresAt = nullableLong(result, "expires_at");
                Long revokedAt = nullableLong(result, "revoked_at");
                if (revokedAt != null || expiresAt != null && expiresAt <= now) {
                    return ConsentDecision.unverified();
                }
                Instant verifiedAt = Instant.ofEpochMilli(now);
                Instant expiry = expiresAt == null ? null : Instant.ofEpochMilli(expiresAt);
                return new ConsentDecision(
                        true,
                        AUTHORITY_ID,
                        governance.consentId(),
                        verifiedAt,
                        expiry,
                        csv(result.getString("purposes_csv")),
                        csv(result.getString("allowed_regions_csv")),
                        result.getBoolean("external_processing_allowed"),
                        result.getBoolean("biometric_processing_allowed"));
            }
        } catch (Exception failure) {
            throw new IllegalStateException(
                    "Media consent authority lookup failed closed for operation "
                            + (operation == null ? "unknown" : operation), failure);
        }
    }

    @Override
    public boolean ready() {
        if (closed.get() || !state.ready()) return false;
        try (var connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "SELECT tenant_id FROM media_consents WHERE 1=0");
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
        if (closed.get()) throw new IllegalStateException("Media consent authority is closed");
        if (!state.configured()) throw new IllegalStateException("Media consent authority is not configured");
    }

    private static Long nullableLong(ResultSet result, String column) throws Exception {
        long value = result.getLong(column);
        return result.wasNull() ? null : value;
    }

    private static Set<String> csv(String value) {
        LinkedHashSet<String> values = new LinkedHashSet<>();
        if (value == null) return Set.of();
        for (String item : value.split(",")) {
            String normalized = item.trim().toLowerCase(java.util.Locale.ROOT);
            if (!normalized.isBlank()) values.add(normalized);
        }
        return Set.copyOf(values);
    }
}
