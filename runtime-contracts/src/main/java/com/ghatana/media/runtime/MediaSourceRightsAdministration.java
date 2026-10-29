package com.ghatana.media.runtime;

import java.time.Instant;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * Trusted source-rights ingress for owner-created Media source records.
 *
 * <p>A registered record binds an immutable artifact version (bytes digest) to its authenticated
 * producer/owner, allowed operations, purposes, processing regions, provider retentions and the
 * consent disposition the source kind requires. Caller-supplied metadata is never treated as
 * rights: the registering principal is supplied by the authenticated transport, and the
 * provenance reference must identify an independently created owner/producer record.
 * Revocation advances the record's revocation epoch so authority-issued evidence fails closed.
 *
 * @doc.type interface
 * @doc.purpose Register, read, and revoke authenticated Media source-rights records
 * @doc.layer product
 * @doc.pattern SPI, Repository, PrivacyControl
 */
public interface MediaSourceRightsAdministration extends AutoCloseable {
    String administrationId();

    boolean ready();

    boolean productionEligible();

    SourceRecord register(RegisterRequest request);

    Optional<SourceRecord> record(String tenantId, String artifactId, String sourceVersion);

    Optional<SourceRecord> revoke(
            String tenantId,
            String artifactId,
            String sourceVersion,
            String principalId,
            String correlationId);

    @Override
    default void close() { }

    record RegisterRequest(
            String tenantId,
            String principalId,
            String artifactId,
            String sourceVersion,
            String sourceSha256,
            String sourceOwnerId,
            MediaSourceAuthorizationContracts.SourceKind sourceKind,
            MediaSourceAuthorizationContracts.HumanConsentDisposition humanConsentDisposition,
            String consentDecisionId,
            Set<String> allowedOperations,
            Set<String> allowedPurposes,
            Set<String> allowedRegions,
            Set<MediaRuntimeContracts.ProviderDataRetention> allowedProviderRetentions,
            String sourceClockEvidenceRef,
            String provenanceRef,
            Instant expiresAt,
            String correlationId) {
        public RegisterRequest {
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            artifactId = required(artifactId, "artifactId");
            sourceVersion = required(sourceVersion, "sourceVersion");
            sourceSha256 = required(sourceSha256, "sourceSha256").toLowerCase(Locale.ROOT);
            if (!sourceSha256.matches("[0-9a-f]{64}")
                    || !sourceVersion.equals("sha256:" + sourceSha256)) {
                throw new IllegalArgumentException(
                        "source version and digest must identify the same bytes");
            }
            sourceOwnerId = required(sourceOwnerId, "sourceOwnerId");
            Objects.requireNonNull(sourceKind, "sourceKind");
            Objects.requireNonNull(humanConsentDisposition, "humanConsentDisposition");
            consentDecisionId = optional(consentDecisionId, "consentDecisionId");
            if (sourceKind == MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN) {
                if (humanConsentDisposition
                        != MediaSourceAuthorizationContracts.HumanConsentDisposition
                                .NOT_APPLICABLE_HUMAN_CONSENT
                        || !consentDecisionId.isBlank()) {
                    throw new IllegalArgumentException(
                            "nonhuman source records must explicitly exclude a human-consent decision");
                }
            } else if (humanConsentDisposition
                            != MediaSourceAuthorizationContracts.HumanConsentDisposition.REQUIRED
                    || consentDecisionId.isBlank()) {
                throw new IllegalArgumentException(
                        "human or third-party source records require a real consent decision reference");
            }
            allowedOperations = normalizedRequired(allowedOperations, "allowedOperations");
            allowedPurposes = normalizedRequired(allowedPurposes, "allowedPurposes");
            allowedRegions = normalizedRequired(allowedRegions, "allowedRegions");
            allowedProviderRetentions = Set.copyOf(
                    Objects.requireNonNull(allowedProviderRetentions, "allowedProviderRetentions"));
            if (allowedProviderRetentions.isEmpty()) {
                throw new IllegalArgumentException("allowedProviderRetentions must not be empty");
            }
            sourceClockEvidenceRef = required(sourceClockEvidenceRef, "sourceClockEvidenceRef");
            provenanceRef = required(provenanceRef, "provenanceRef");
            correlationId = required(correlationId, "correlationId");
            Objects.requireNonNull(expiresAt, "expiresAt");
            if (!expiresAt.isAfter(Instant.now())) {
                throw new IllegalArgumentException("expiresAt must be in the future");
            }
        }
    }

    record SourceRecord(
            String tenantId,
            String artifactId,
            String sourceVersion,
            String sourceSha256,
            String principalId,
            String sourceOwnerId,
            MediaSourceAuthorizationContracts.SourceKind sourceKind,
            MediaSourceAuthorizationContracts.HumanConsentDisposition humanConsentDisposition,
            String consentDecisionId,
            Set<String> allowedOperations,
            Set<String> allowedPurposes,
            Set<String> allowedRegions,
            Set<MediaRuntimeContracts.ProviderDataRetention> allowedProviderRetentions,
            String sourceClockEvidenceRef,
            String provenanceRef,
            String registeredBy,
            Instant registeredAt,
            Instant expiresAt,
            long revocationEpoch,
            Instant revokedAt) {
        public SourceRecord {
            tenantId = required(tenantId, "tenantId");
            artifactId = required(artifactId, "artifactId");
            sourceVersion = required(sourceVersion, "sourceVersion");
            sourceSha256 = required(sourceSha256, "sourceSha256");
            principalId = required(principalId, "principalId");
            sourceOwnerId = required(sourceOwnerId, "sourceOwnerId");
            Objects.requireNonNull(sourceKind, "sourceKind");
            Objects.requireNonNull(humanConsentDisposition, "humanConsentDisposition");
            consentDecisionId = optional(consentDecisionId, "consentDecisionId");
            allowedOperations = normalizedRequired(allowedOperations, "allowedOperations");
            allowedPurposes = normalizedRequired(allowedPurposes, "allowedPurposes");
            allowedRegions = normalizedRequired(allowedRegions, "allowedRegions");
            allowedProviderRetentions = Set.copyOf(
                    Objects.requireNonNull(allowedProviderRetentions, "allowedProviderRetentions"));
            sourceClockEvidenceRef = required(sourceClockEvidenceRef, "sourceClockEvidenceRef");
            provenanceRef = required(provenanceRef, "provenanceRef");
            registeredBy = required(registeredBy, "registeredBy");
            Objects.requireNonNull(registeredAt, "registeredAt");
            Objects.requireNonNull(expiresAt, "expiresAt");
            if (revocationEpoch < 0) {
                throw new IllegalArgumentException("revocationEpoch cannot be negative");
            }
        }

        public boolean revoked() { return revokedAt != null; }

        public boolean expiredAt(Instant instant) {
            return !expiresAt.isAfter(Objects.requireNonNull(instant, "instant"));
        }
    }

    private static Set<String> normalizedRequired(Set<String> values, String field) {
        if (values == null || values.isEmpty()) {
            throw new IllegalArgumentException(field + " must not be empty");
        }
        java.util.LinkedHashSet<String> result = new java.util.LinkedHashSet<>();
        for (String value : values) {
            String item = required(value, field).toLowerCase(Locale.ROOT);
            if (item.length() > 255) {
                throw new IllegalArgumentException(field + " value exceeds 255 characters");
            }
            result.add(item);
        }
        return Set.copyOf(result);
    }

    private static String required(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(field + " is required");
        }
        return value.trim();
    }

    private static String optional(String value, String field) {
        if (value == null) return "";
        String normalized = value.trim();
        if (normalized.length() > 512 || normalized.chars().anyMatch(Character::isISOControl)) {
            throw new IllegalArgumentException(field + " is malformed");
        }
        return normalized;
    }
}
