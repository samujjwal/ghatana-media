package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;

import java.time.Clock;
import java.time.Instant;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;

/**
 * Source-version-bound Media authorization contracts for irreversible processing effects.
 *
 * <p>An {@link Authority} is an orchestration boundary over the actual Media source-rights
 * authority and Shared PolicyEngine. An ALLOWED result therefore represents an authenticated
 * source-owner decision and a current, authoritative Shared policy ALLOW for this exact request.
 * Media consent remains a separate authority and is checked by the runtime. Implementations must
 * resolve caller identifiers against trusted Media records; fields in a processing request are
 * lookup inputs, never rights or policy evidence.</p>
 */
public final class MediaSourceAuthorizationContracts {
    private MediaSourceAuthorizationContracts() { }

    public enum Status { ALLOWED, DENIED, REVOKED, STALE, UNAVAILABLE }

    public enum SourceKind { ORIGINAL_NONHUMAN, HUMAN_RECORDING, THIRD_PARTY, UNKNOWN }

    public enum HumanConsentDisposition { REQUIRED, NOT_APPLICABLE_HUMAN_CONSENT, UNRESOLVED }

    /** Exact processing identity passed to a trusted source/policy authority. */
    public record Request(
            String tenantId,
            String principalId,
            String artifactId,
            ArtifactVersion sourceVersion,
            String sourceSha256,
            String operation,
            String purpose,
            String providerId,
            String providerVersion,
            ProcessingBoundary processingBoundary,
            String processingRegion,
            ProviderDataRetention providerRetention) {
        public Request {
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            artifactId = required(artifactId, "artifactId");
            sourceVersion = Objects.requireNonNull(sourceVersion, "sourceVersion");
            sourceSha256 = digest(sourceSha256, "sourceSha256");
            if (!sourceVersion.value().equals("sha256:" + sourceSha256)) {
                throw new IllegalArgumentException("source version and digest must identify the same bytes");
            }
            operation = token(operation, "operation");
            purpose = required(purpose, "purpose").toLowerCase(Locale.ROOT);
            providerId = required(providerId, "providerId");
            providerVersion = required(providerVersion, "providerVersion");
            processingBoundary = Objects.requireNonNull(processingBoundary, "processingBoundary");
            processingRegion = required(processingRegion, "processingRegion").toLowerCase(Locale.ROOT);
            providerRetention = Objects.requireNonNull(providerRetention, "providerRetention");
        }
    }

    /**
     * Authority-issued evidence. Its constructor enforces the binding and scope invariants;
     * authenticity and current revocation are established by the trusted {@link Authority}.
     */
    public record Evidence(
            String authorityId,
            String decisionId,
            String tenantId,
            String principalId,
            String sourceOwnerId,
            String artifactId,
            ArtifactVersion sourceVersion,
            String sourceSha256,
            String operation,
            String purpose,
            String providerId,
            String providerVersion,
            ProcessingBoundary processingBoundary,
            String processingRegion,
            ProviderDataRetention providerRetention,
            Set<String> allowedOperations,
            Set<String> allowedRegions,
            Set<ProviderDataRetention> allowedProviderRetentions,
            String rightsDecisionId,
            String policyDecisionId,
            String policyVersion,
            SourceKind sourceKind,
            HumanConsentDisposition humanConsentDisposition,
            String consentDecisionId,
            String sourceClockEvidenceRef,
            long revocationEpoch,
            Instant verifiedAt,
            Instant expiresAt) {
        public Evidence {
            authorityId = required(authorityId, "authorityId");
            decisionId = required(decisionId, "decisionId");
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            sourceOwnerId = required(sourceOwnerId, "sourceOwnerId");
            artifactId = required(artifactId, "artifactId");
            sourceVersion = Objects.requireNonNull(sourceVersion, "sourceVersion");
            sourceSha256 = digest(sourceSha256, "sourceSha256");
            if (!sourceVersion.value().equals("sha256:" + sourceSha256)) {
                throw new IllegalArgumentException("source version and digest must identify the same bytes");
            }
            operation = token(operation, "operation");
            purpose = required(purpose, "purpose").toLowerCase(Locale.ROOT);
            providerId = required(providerId, "providerId");
            providerVersion = required(providerVersion, "providerVersion");
            processingBoundary = Objects.requireNonNull(processingBoundary, "processingBoundary");
            processingRegion = required(processingRegion, "processingRegion").toLowerCase(Locale.ROOT);
            providerRetention = Objects.requireNonNull(providerRetention, "providerRetention");
            allowedOperations = normalizedSet(allowedOperations);
            allowedRegions = normalizedSet(allowedRegions);
            allowedProviderRetentions = Set.copyOf(allowedProviderRetentions == null
                    ? Set.of() : allowedProviderRetentions);
            rightsDecisionId = required(rightsDecisionId, "rightsDecisionId");
            policyDecisionId = required(policyDecisionId, "policyDecisionId");
            policyVersion = required(policyVersion, "policyVersion");
            sourceKind = Objects.requireNonNull(sourceKind, "sourceKind");
            humanConsentDisposition = Objects.requireNonNull(
                    humanConsentDisposition, "humanConsentDisposition");
            consentDecisionId = optional(consentDecisionId);
            sourceClockEvidenceRef = required(sourceClockEvidenceRef, "sourceClockEvidenceRef");
            if (revocationEpoch < 0) throw new IllegalArgumentException("revocationEpoch cannot be negative");
            verifiedAt = Objects.requireNonNull(verifiedAt, "verifiedAt");
            expiresAt = Objects.requireNonNull(expiresAt, "expiresAt");
            if (!expiresAt.isAfter(verifiedAt)) {
                throw new IllegalArgumentException("authorization evidence must expire after verification");
            }
            if (!allowedOperations.contains(operation.toLowerCase(Locale.ROOT))) {
                throw new IllegalArgumentException("authorization evidence does not permit this operation");
            }
            if (!allowedRegions.contains("*") && !allowedRegions.contains(processingRegion)) {
                throw new IllegalArgumentException("authorization evidence does not permit this processing region");
            }
            if (!allowedProviderRetentions.contains(providerRetention)) {
                throw new IllegalArgumentException("authorization evidence does not permit this provider retention");
            }
            if (sourceKind == SourceKind.ORIGINAL_NONHUMAN) {
                if (humanConsentDisposition != HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT
                        || !consentDecisionId.isBlank()) {
                    throw new IllegalArgumentException(
                            "nonhuman source evidence must explicitly exclude a human-consent decision");
                }
            } else if (sourceKind == SourceKind.HUMAN_RECORDING || sourceKind == SourceKind.THIRD_PARTY) {
                if (humanConsentDisposition != HumanConsentDisposition.REQUIRED || consentDecisionId.isBlank()) {
                    throw new IllegalArgumentException(
                            "human or third-party source evidence requires a separate consent decision");
                }
            } else {
                throw new IllegalArgumentException("unknown source kind cannot produce ALLOWED evidence");
            }
        }

        public boolean matches(Request request) {
            return request != null
                    && tenantId.equals(request.tenantId())
                    && principalId.equals(request.principalId())
                    && artifactId.equals(request.artifactId())
                    && sourceVersion.equals(request.sourceVersion())
                    && sourceSha256.equals(request.sourceSha256())
                    && operation.equals(request.operation())
                    && purpose.equals(request.purpose())
                    && providerId.equals(request.providerId())
                    && providerVersion.equals(request.providerVersion())
                    && processingBoundary == request.processingBoundary()
                    && processingRegion.equals(request.processingRegion())
                    && providerRetention == request.providerRetention();
        }

        public boolean currentAt(Clock clock) {
            Instant now = Objects.requireNonNull(clock, "clock").instant();
            return !verifiedAt.isAfter(now) && expiresAt.isAfter(now);
        }
    }

    /** Status wrapper prevents an absent/denied authority from being mistaken for evidence. */
    public record Decision(Status status, Evidence evidence) {
        public Decision {
            status = Objects.requireNonNull(status, "status");
            if ((status == Status.ALLOWED) != (evidence != null)) {
                throw new IllegalArgumentException("ALLOWED requires exact authority evidence only");
            }
        }
    }

    /**
     * Runtime SPI. Production compositions must implement this by calling the real Media source
     * rights authority and Shared PolicyEngine. Revalidation must re-read source ownership,
     * current rights/revocation and current Shared policy for the same immutable request.
     */
    public interface Authority extends AutoCloseable {
        String authorityId();
        boolean ready();
        boolean productionEligible();
        Decision resolve(Request request);
        Decision revalidate(Request request, Evidence expectedEvidence);
        @Override default void close() { }
    }

    private static Set<String> normalizedSet(Set<String> values) {
        return Set.copyOf(values == null ? Set.of() : values.stream()
                .map(value -> required(value, "scope value").toLowerCase(Locale.ROOT))
                .collect(java.util.stream.Collectors.toSet()));
    }

    private static String token(String value, String field) {
        String normalized = required(value, field);
        if (!normalized.matches("[A-Za-z][A-Za-z0-9_.:-]{0,254}")) {
            throw new IllegalArgumentException(field + " must be a bounded authority token");
        }
        return normalized;
    }

    private static String digest(String value, String field) {
        String normalized = required(value, field).toLowerCase(Locale.ROOT);
        if (!normalized.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException(field + " must be a SHA-256 digest");
        }
        return normalized;
    }

    private static String required(String value, String field) {
        Objects.requireNonNull(value, field);
        String normalized = value.trim();
        if (normalized.isBlank() || normalized.length() > 512
                || normalized.chars().anyMatch(Character::isISOControl)) {
            throw new IllegalArgumentException(field + " must be bounded and nonblank");
        }
        return normalized;
    }

    private static String optional(String value) {
        if (value == null) return "";
        String normalized = value.trim();
        if (normalized.length() > 512 || normalized.chars().anyMatch(Character::isISOControl)) {
            throw new IllegalArgumentException("optional authorization reference is malformed");
        }
        return normalized;
    }
}
