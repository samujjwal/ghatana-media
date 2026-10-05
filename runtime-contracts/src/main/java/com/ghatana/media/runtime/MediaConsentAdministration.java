package com.ghatana.media.runtime;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/**
 * Service-owned self-service consent mutation contract.
 *
 * <p>Tenant/principal identity is supplied by the authenticated transport, not by an untrusted body.
 * Implementations own consent IDs, versions, grant/revocation timestamps, and durable storage.
 * This contract deliberately exposes no caller-controlled "verified" or approval flag.
 *
 * @doc.type interface
 * @doc.purpose Grant, list, read, and revoke principal-owned Media consent
 * @doc.layer product
 * @doc.pattern SPI, Repository, PrivacyControl
 */
public interface MediaConsentAdministration extends AutoCloseable {
    String administrationId();

    boolean ready();

    boolean productionEligible();

    ConsentRecord grant(GrantRequest request);

    Optional<ConsentRecord> find(String tenantId, String principalId, String consentId);

    List<ConsentRecord> list(String tenantId, String principalId, int limit);

    Optional<ConsentRecord> revoke(
            String tenantId,
            String principalId,
            String consentId,
            String correlationId);

    @Override
    default void close() { }

    record GrantRequest(
            String tenantId,
            String principalId,
            String correlationId,
            Set<String> purposes,
            Set<String> allowedRegions,
            boolean externalProcessingAllowed,
            boolean biometricProcessingAllowed,
            Instant expiresAt) {
        public GrantRequest {
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            correlationId = required(correlationId, "correlationId");
            purposes = normalizedRequired(purposes, "purposes");
            allowedRegions = normalized(allowedRegions);
            if (externalProcessingAllowed && allowedRegions.isEmpty()) {
                throw new IllegalArgumentException(
                        "allowedRegions must not be empty when external processing is allowed");
            }
            if (expiresAt != null && !expiresAt.isAfter(Instant.now())) {
                throw new IllegalArgumentException("expiresAt must be in the future");
            }
        }
    }

    record ConsentRecord(
            String tenantId,
            String consentId,
            String principalId,
            Set<String> purposes,
            Set<String> allowedRegions,
            boolean externalProcessingAllowed,
            boolean biometricProcessingAllowed,
            Instant grantedAt,
            Instant expiresAt,
            Instant revokedAt,
            long version) {
        public ConsentRecord {
            tenantId = required(tenantId, "tenantId");
            consentId = required(consentId, "consentId");
            principalId = required(principalId, "principalId");
            purposes = normalizedRequired(purposes, "purposes");
            allowedRegions = normalized(allowedRegions);
            grantedAt = java.util.Objects.requireNonNull(grantedAt, "grantedAt");
            if (expiresAt != null && !expiresAt.isAfter(grantedAt)) {
                throw new IllegalArgumentException("expiresAt must be after grantedAt");
            }
            if (revokedAt != null && revokedAt.isBefore(grantedAt)) {
                throw new IllegalArgumentException("revokedAt must not precede grantedAt");
            }
            if (version < 1) throw new IllegalArgumentException("version must be positive");
        }

        public boolean activeAt(Instant instant) {
            return revokedAt == null && (expiresAt == null || expiresAt.isAfter(instant));
        }
    }

    private static Set<String> normalizedRequired(Set<String> values, String field) {
        Set<String> normalized = normalized(values);
        if (normalized.isEmpty()) throw new IllegalArgumentException(field + " must not be empty");
        return normalized;
    }

    private static Set<String> normalized(Set<String> values) {
        if (values == null || values.isEmpty()) return Set.of();
        java.util.LinkedHashSet<String> result = new java.util.LinkedHashSet<>();
        for (String value : values) {
            String item = required(value, "consent value").toLowerCase(java.util.Locale.ROOT);
            if (item.length() > 255) throw new IllegalArgumentException("consent value exceeds 255 characters");
            result.add(item);
        }
        return Set.copyOf(result);
    }

    private static String required(String value, String field) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(field + " is required");
        return value.trim();
    }
}
