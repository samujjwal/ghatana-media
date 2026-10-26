package com.ghatana.media.runtime;

import java.time.Duration;
import java.time.Instant;
import java.lang.reflect.Array;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Service-owned artifact, governance, consent, upload, job, stream, and provider contracts for Media Runtime.
 *
 * @doc.type class
 * @doc.purpose Provide Media Runtime Contracts behavior
 * @doc.layer product
 * @doc.pattern Component
 */
public final class MediaRuntimeContracts {
    private MediaRuntimeContracts() { }

    /** A compare-and-set conflict caused by a newer concurrent job transition. */
    public static final class MediaJobStoreConflictException extends IllegalStateException {
        public MediaJobStoreConflictException(String message) { super(message); }
    }

    public enum UploadStatus { OPEN, FINALIZING, COMPLETED, ABORTED, EXPIRED }
    public enum ArtifactScanVerdict { CLEAN, REJECT, UNAVAILABLE }
    /** Logical job outcome and observation; OUTCOME_UNKNOWN is never a replay or failure signal. */
    public enum JobStatus { ACCEPTED, RUNNING, OUTCOME_UNKNOWN, COMPLETED, FAILED, CANCELLED }
    public enum CancellationOutcome { CONFIRMED, REQUESTED_UNCONFIRMED, UNSUPPORTED }
    public enum JobType { TRANSCODE, SPEECH_TO_TEXT, TEXT_TO_SPEECH, VISION, MULTIMODAL }
    public enum JobAttemptStatus { DISPATCH_INTENT, RUNNING, COMPLETED, FAILED, OUTCOME_UNKNOWN }
    public enum StreamKind { AUDIO, VIDEO, MULTIMODAL }
    public enum StreamState { OPEN, CONNECTED, DEGRADED, DRAINING, CLOSED, FAILED }
    public enum ProcessingBoundary { LOCAL, EXTERNAL }
    public enum ProviderDataRetention { UNKNOWN, NONE, TRANSIENT, PERSISTENT }
    public enum ResultClassification { SENSITIVE, DEIDENTIFIED }
    public enum DataClassification {
        PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED;

        public boolean isAtLeast(DataClassification floor) {
            return ordinal() >= java.util.Objects.requireNonNull(floor, "floor").ordinal();
        }
    }
    public enum BiometricSensitivity { NONE, DERIVED, TEMPLATE }
    public enum AutomationRisk { ASSISTIVE, DECISION_SUPPORT, CONSEQUENTIAL }

    /**
     * Privacy/purpose envelope requested for media processing or streaming. This is intent, not
     * authority: an external provider must enforce the intersection of this request and the
     * permissions returned by a verified {@link ConsentDecision}.
     */
    public record MediaGovernanceContext(
            String consentId,
            String purpose,
            DataClassification classification,
            String residency,
            Set<String> allowedRegions,
            boolean externalProcessingAllowed,
            String retentionPolicy,
            boolean providerRetentionAllowed,
            boolean biometricProcessingAllowed,
            String biometricProcessingBasis,
            BiometricSensitivity biometricSensitivity,
            AutomationRisk automationRisk) {
        public MediaGovernanceContext {
            consentId = optional(consentId);
            purpose = normalizedRequired(purpose, "purpose");
            classification = classification == null ? DataClassification.INTERNAL : classification;
            residency = normalizedRequired(residency, "residency");
            allowedRegions = normalizedSet(allowedRegions);
            retentionPolicy = normalizedRequired(retentionPolicy, "retentionPolicy");
            biometricProcessingBasis = optional(biometricProcessingBasis);
            biometricSensitivity = biometricSensitivity == null
                    ? BiometricSensitivity.NONE : biometricSensitivity;
            automationRisk = automationRisk == null ? AutomationRisk.ASSISTIVE : automationRisk;
            if (biometricProcessingAllowed && biometricProcessingBasis.isBlank()) {
                throw new IllegalArgumentException(
                        "biometricProcessingBasis is required when biometric processing is allowed");
            }
            if (biometricProcessingAllowed && "service-default".equalsIgnoreCase(retentionPolicy)) {
                throw new IllegalArgumentException(
                        "explicit biometric retentionPolicy is required when biometric processing is allowed");
            }
            if (!biometricProcessingAllowed && biometricSensitivity != BiometricSensitivity.NONE) {
                throw new IllegalArgumentException(
                        "biometricSensitivity requires biometric processing permission");
            }
        }

        /** Compatibility constructor with conservative retention and classification defaults. */
        public MediaGovernanceContext(
                String consentId,
                String purpose,
                String residency,
                Set<String> allowedRegions,
                boolean externalProcessingAllowed,
                boolean biometricProcessingAllowed) {
            this(consentId, purpose, DataClassification.RESTRICTED, residency, allowedRegions,
                    externalProcessingAllowed, "service-default", false,
                    biometricProcessingAllowed,
                    biometricProcessingAllowed ? "explicit-consent" : "",
                    biometricProcessingAllowed ? BiometricSensitivity.DERIVED : BiometricSensitivity.NONE,
                    AutomationRisk.ASSISTIVE);
        }

        public static MediaGovernanceContext compatibilityDefault() {
            return new MediaGovernanceContext(
                    "", "unspecified", DataClassification.INTERNAL, "unspecified", Set.of(),
                    false, "service-default", false, false, "",
                    BiometricSensitivity.NONE, AutomationRisk.ASSISTIVE);
        }

        public boolean permitsRegion(String region) {
            String normalized = optional(region).toLowerCase(Locale.ROOT);
            return !normalized.isBlank() && (allowedRegions.contains("*") || allowedRegions.contains(normalized));
        }

        /** Derived data may preserve or raise, but never silently lower, its source floor. */
        public boolean permitsDerivedClassification(DataClassification derived) {
            return java.util.Objects.requireNonNull(derived, "derived").isAtLeast(classification);
        }
    }

    /**
     * Authenticated, revocation-aware consent outcome supplied by a real authority. Permission
     * fields are authority-owned; callers cannot widen them through {@link MediaGovernanceContext}.
     */
    public record ConsentDecision(
            boolean verified,
            String authorityId,
            String consentId,
            Instant verifiedAt,
            Instant expiresAt,
            Set<String> allowedPurposes,
            Set<String> allowedRegions,
            boolean externalProcessingAllowed,
            boolean biometricProcessingAllowed,
            Set<ProviderDataRetention> allowedProviderRetention) {
        public ConsentDecision {
            authorityId = optional(authorityId);
            consentId = optional(consentId);
            verifiedAt = verifiedAt == null ? Instant.EPOCH : verifiedAt;
            allowedPurposes = normalizedSet(allowedPurposes);
            allowedRegions = normalizedSet(allowedRegions);
            allowedProviderRetention = Set.copyOf(allowedProviderRetention == null
                    ? Set.of() : allowedProviderRetention);
            if (verified && (authorityId.isBlank() || consentId.isBlank())) {
                throw new IllegalArgumentException("verified consent requires authorityId and consentId");
            }
            if (verified && expiresAt != null && !expiresAt.isAfter(verifiedAt)) {
                throw new IllegalArgumentException("consent expiresAt must be after verifiedAt");
            }
        }

        /**
         * Compatibility bridge for authorities that have not yet published retention rights.
         * Such authorities can affirm no provider retention, but cannot authorize a retaining
         * provider by relying on caller-supplied governance intent.
         */
        public ConsentDecision(
                boolean verified,
                String authorityId,
                String consentId,
                Instant verifiedAt,
                Instant expiresAt,
                Set<String> allowedPurposes,
                Set<String> allowedRegions,
                boolean externalProcessingAllowed,
                boolean biometricProcessingAllowed) {
            this(verified, authorityId, consentId, verifiedAt, expiresAt,
                    allowedPurposes, allowedRegions, externalProcessingAllowed,
                    biometricProcessingAllowed, Set.of(ProviderDataRetention.NONE));
        }

        /** Compatibility bridge; intentionally grants no processing rights. */
        public ConsentDecision(
                boolean verified,
                String authorityId,
                String consentId,
                Instant verifiedAt,
                Instant expiresAt) {
            this(verified, authorityId, consentId, verifiedAt, expiresAt,
                    Set.of(), Set.of(), false, false);
        }

        public static ConsentDecision unverified() {
            return new ConsentDecision(
                    false, "", "", Instant.EPOCH, null,
                    Set.of(), Set.of(), false, false);
        }

        public boolean activeAt(Instant instant) {
            return verified && (expiresAt == null || expiresAt.isAfter(instant));
        }

        public boolean permitsPurpose(String purpose) {
            String normalized = optional(purpose).toLowerCase(Locale.ROOT);
            return !normalized.isBlank()
                    && (allowedPurposes.contains("*") || allowedPurposes.contains(normalized));
        }

        public boolean permitsRegion(String region) {
            String normalized = optional(region).toLowerCase(Locale.ROOT);
            return !normalized.isBlank()
                    && (allowedRegions.contains("*") || allowedRegions.contains(normalized));
        }

        public boolean permitsProviderRetention(ProviderDataRetention retention) {
            return retention != null && allowedProviderRetention.contains(retention);
        }
    }

    /** Provider boundary for authoritative, revocation-aware consent verification. */
    public interface MediaConsentAuthority extends AutoCloseable {
        String authorityId();
        ConsentDecision verify(
                String tenantId,
                String principalId,
                MediaGovernanceContext governance,
                String operation);
        boolean ready();
        boolean productionEligible();
        @Override default void close() { }
    }

    /**
     * Semantic de-identification request. Sensitive source text is passed only to the selected
     * provider and is never part of redaction provenance. The caller must still obey the request's
     * classification, residency, consent, and retention policy.
     */
    public record SemanticRedactionRequest(
            String tenantId,
            String principalId,
            String correlationId,
            String sourceText,
            String language,
            MediaGovernanceContext governanceContext) {
        public SemanticRedactionRequest {
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            correlationId = required(correlationId, "correlationId");
            sourceText = required(sourceText, "sourceText");
            language = optional(language);
            governanceContext = governanceContext == null
                    ? MediaGovernanceContext.compatibilityDefault() : governanceContext;
        }
    }

    /**
     * Proven de-identification outcome. A result can be promoted only when {@code safeForPromotion}
     * is true and the provider explicitly classifies it as {@link ResultClassification#DEIDENTIFIED}.
     */
    public record SemanticRedactionResult(
            String redactedText,
            ResultClassification classification,
            boolean safeForPromotion,
            String providerId,
            String policyVersion,
            Set<String> redactionCategories,
            Instant evaluatedAt,
            Map<String, Object> provenance) {
        public SemanticRedactionResult {
            redactedText = required(redactedText, "redactedText");
            classification = java.util.Objects.requireNonNull(classification, "classification");
            providerId = required(providerId, "providerId");
            policyVersion = required(policyVersion, "policyVersion");
            redactionCategories = normalizedSet(redactionCategories);
            evaluatedAt = evaluatedAt == null ? Instant.now() : evaluatedAt;
            provenance = Map.copyOf(provenance == null ? Map.of() : provenance);
            if (safeForPromotion && classification != ResultClassification.DEIDENTIFIED) {
                throw new IllegalArgumentException(
                        "safeForPromotion requires DEIDENTIFIED classification");
            }
        }
    }

    /**
     * Provider-neutral semantic redaction SPI. Production promotion must never substitute a
     * structural key filter, regex-only helper, or caller assertion for this provider decision.
     */
    public interface MediaSemanticRedactionProvider extends AutoCloseable {
        String providerId();
        boolean ready();
        boolean productionEligible();
        ProcessingBoundary processingBoundary();
        default String processingRegion() { return "unspecified"; }
        default ProviderDataRetention providerDataRetention() { return ProviderDataRetention.UNKNOWN; }
        CompletableFuture<SemanticRedactionResult> redact(SemanticRedactionRequest request);
        @Override default void close() { }
    }

    public record UploadRequest(
            String tenantId,
            String principalId,
            String fileName,
            String contentType,
            long expectedSizeBytes,
            String expectedSha256,
            String classification,
            Duration retention,
            Map<String, Object> metadata) {
        public UploadRequest {
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            fileName = required(fileName, "fileName");
            contentType = required(contentType, "contentType");
            if (expectedSizeBytes < 1) throw new IllegalArgumentException("expectedSizeBytes must be positive");
            expectedSha256 = requireSha256(expectedSha256);
            String requestedClassification = required(classification, "classification");
            if (!requestedClassification.equals(classification)
                    || !java.util.Set.of("PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED")
                            .contains(requestedClassification)) {
                throw new IllegalArgumentException(
                        "classification must be PUBLIC, INTERNAL, CONFIDENTIAL, or RESTRICTED");
            }
            classification = requestedClassification;
            if (retention == null || retention.isZero() || retention.isNegative()
                    || retention.compareTo(Duration.ofDays(3_650)) > 0) {
                throw new IllegalArgumentException("retention must be between 1 ms and 3650 days");
            }
            if (retention.getNano() % 1_000_000 != 0) {
                throw new IllegalArgumentException("retention must use millisecond precision");
            }
            metadata = immutableJsonObject(metadata == null ? Map.of() : metadata);
        }

        @Override
        public Map<String, Object> metadata() {
            return immutableJsonObject(metadata);
        }

        public String purpose() { return metadataPurpose(metadata); }
    }

    public record UploadSession(
            String uploadId,
            String tenantId,
            String principalId,
            String fileName,
            String contentType,
            long expectedSizeBytes,
            String expectedSha256,
            String classification,
            Instant createdAt,
            Instant expiresAt,
            long bytesReceived,
            int nextChunkIndex,
            UploadStatus status,
            Map<String, Object> metadata) {
        public UploadSession {
            uploadId = required(uploadId, "uploadId");
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            fileName = required(fileName, "fileName");
            contentType = required(contentType, "contentType");
            expectedSha256 = requireSha256(expectedSha256);
            classification = required(classification, "classification");
            createdAt = createdAt == null ? Instant.now() : createdAt;
            expiresAt = java.util.Objects.requireNonNull(expiresAt, "expiresAt");
            if (bytesReceived < 0 || nextChunkIndex < 0) throw new IllegalArgumentException("upload progress must not be negative");
            status = java.util.Objects.requireNonNull(status, "status");
            metadata = Map.copyOf(metadata == null ? Map.of() : metadata);
        }

        public String purpose() { return metadataPurpose(metadata); }
    }

    /** Exact, immutable identity presented to a scanner after quarantine finalization. */
    public record QuarantinedArtifact(
            String tenantId, String principalId, String uploadId, String sha256,
            long sizeBytes, String contentType, String objectReference) {
        public QuarantinedArtifact {
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            uploadId = required(uploadId, "uploadId");
            sha256 = requireSha256(sha256);
            if (sizeBytes < 1) throw new IllegalArgumentException("sizeBytes must be positive");
            contentType = required(contentType, "contentType");
            objectReference = required(objectReference, "objectReference");
        }
    }

    /** Scanner attestation is bound to the exact quarantined bytes and expires at a fixed time. */
    public record ArtifactScanDecision(
            String scannerId, String scannerVersion, String policyId, String policyVersion,
            String tenantId, String principalId, String uploadId, String sourceSha256,
            long sizeBytes, String contentType, ArtifactScanVerdict verdict,
            Instant evaluatedAt, Instant expiresAt) {
        public ArtifactScanDecision {
            scannerId = required(scannerId, "scannerId");
            scannerVersion = required(scannerVersion, "scannerVersion");
            policyId = required(policyId, "policyId");
            policyVersion = required(policyVersion, "policyVersion");
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            uploadId = required(uploadId, "uploadId");
            sourceSha256 = requireSha256(sourceSha256);
            if (sizeBytes < 1) throw new IllegalArgumentException("sizeBytes must be positive");
            contentType = required(contentType, "contentType");
            verdict = java.util.Objects.requireNonNull(verdict, "verdict");
            evaluatedAt = java.util.Objects.requireNonNull(evaluatedAt, "evaluatedAt");
            expiresAt = java.util.Objects.requireNonNull(expiresAt, "expiresAt");
            if (!expiresAt.isAfter(evaluatedAt)) throw new IllegalArgumentException("scan decision expiry must follow evaluation");
        }

        public boolean matches(QuarantinedArtifact artifact, Instant now) {
            return artifact != null && now != null && expiresAt.isAfter(now)
                    && tenantId.equals(artifact.tenantId()) && principalId.equals(artifact.principalId())
                    && uploadId.equals(artifact.uploadId()) && sourceSha256.equals(artifact.sha256())
                    && sizeBytes == artifact.sizeBytes() && contentType.equals(artifact.contentType());
        }
    }

    public interface MediaArtifactScanner extends AutoCloseable {
        String scannerId();
        boolean ready();
        boolean productionEligible();
        ArtifactScanDecision scan(QuarantinedArtifact artifact);
        @Override default void close() { }
    }

    /**
     * Immutable content version for a Media artifact. The artifact id locates a tenant-scoped
     * record; this value pins a caller to the bytes represented by that record.
     */
    public record ArtifactVersion(String value) {
        public ArtifactVersion {
            value = required(value, "value");
            if (!value.matches("sha256:[0-9a-f]{64}")) {
                throw new IllegalArgumentException("artifact version must be sha256:<64 lowercase hex>");
            }
        }

        public static ArtifactVersion fromSha256(String sha256) {
            return new ArtifactVersion("sha256:" + requireSha256(sha256));
        }
    }

    public record MediaArtifact(
            String tenantId,
            String principalId,
            String artifactId,
            String fileName,
            String contentType,
            long sizeBytes,
            String sha256,
            String objectReference,
            String classification,
            Instant createdAt,
            Instant expiresAt,
            Map<String, Object> metadata) {
        public MediaArtifact {
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            artifactId = required(artifactId, "artifactId");
            fileName = required(fileName, "fileName");
            contentType = required(contentType, "contentType");
            if (sizeBytes < 1) throw new IllegalArgumentException("sizeBytes must be positive");
            sha256 = requireSha256(sha256);
            objectReference = required(objectReference, "objectReference");
            classification = required(classification, "classification");
            createdAt = createdAt == null ? Instant.now() : createdAt;
            expiresAt = java.util.Objects.requireNonNull(expiresAt, "expiresAt");
            metadata = Map.copyOf(metadata == null ? Map.of() : metadata);
        }

        public String purpose() { return metadataPurpose(metadata); }

        /** Version of the immutable content stored for this artifact locator. */
        public ArtifactVersion version() { return ArtifactVersion.fromSha256(sha256); }
    }

    /** Provenance required to register a derived version without mutating its source. */
    public record ArtifactLineage(
            String tenantId, String sourceArtifactId, ArtifactVersion sourceVersion,
            String jobId, String profileId, String consentDecisionId,
            String rightsDecisionId, String policyVersion) {
        public ArtifactLineage {
            tenantId = required(tenantId, "tenantId");
            sourceArtifactId = required(sourceArtifactId, "sourceArtifactId");
            sourceVersion = java.util.Objects.requireNonNull(sourceVersion, "sourceVersion");
            jobId = required(jobId, "jobId");
            profileId = required(profileId, "profileId");
            consentDecisionId = required(consentDecisionId, "consentDecisionId");
            rightsDecisionId = required(rightsDecisionId, "rightsDecisionId");
            policyVersion = required(policyVersion, "policyVersion");
        }
    }

    public record ProcessingJobRequest(
            String requestId,
            String tenantId,
            String principalId,
            String correlationId,
            String artifactId,
            String expectedArtifactVersion,
            JobType jobType,
            String providerHint,
            Map<String, Object> parameters,
            MediaGovernanceContext governanceContext) {
        public ProcessingJobRequest {
            requestId = required(requestId, "requestId");
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            correlationId = required(correlationId, "correlationId");
            artifactId = required(artifactId, "artifactId");
            if (expectedArtifactVersion == null) {
                expectedArtifactVersion = "";
            } else {
                expectedArtifactVersion = required(expectedArtifactVersion, "expectedArtifactVersion");
                new ArtifactVersion(expectedArtifactVersion);
            }
            jobType = java.util.Objects.requireNonNull(jobType, "jobType");
            providerHint = optional(providerHint);
            parameters = immutableJsonObject(parameters == null ? Map.of() : parameters);
            governanceContext = governanceContext == null
                    ? MediaGovernanceContext.compatibilityDefault() : governanceContext;
        }

        /** Return a defensive snapshot; JSON arrays are copied because Java arrays remain mutable. */
        @Override
        public Map<String, Object> parameters() {
            return immutableJsonObject(parameters);
        }

        public ProcessingJobRequest(
                String requestId, String tenantId, String principalId, String correlationId,
                String artifactId, JobType jobType, String providerHint, Map<String, Object> parameters) {
            this(requestId, tenantId, principalId, correlationId, artifactId, null, jobType,
                    providerHint, parameters, MediaGovernanceContext.compatibilityDefault());
        }

        public ProcessingJobRequest(
                String requestId, String tenantId, String principalId, String correlationId,
                String artifactId, String expectedArtifactVersion, JobType jobType,
                String providerHint, Map<String, Object> parameters) {
            this(requestId, tenantId, principalId, correlationId, artifactId, expectedArtifactVersion,
                    jobType, providerHint, parameters, MediaGovernanceContext.compatibilityDefault());
        }

        public ProcessingJobRequest(
                String requestId, String tenantId, String principalId, String correlationId,
                String artifactId, JobType jobType, String providerHint, Map<String, Object> parameters,
                MediaGovernanceContext governanceContext) {
            this(requestId, tenantId, principalId, correlationId, artifactId, null, jobType,
                    providerHint, parameters, governanceContext);
        }

        public java.util.Optional<ArtifactVersion> requestedArtifactVersion() {
            return expectedArtifactVersion.isBlank()
                    ? java.util.Optional.empty()
                    : java.util.Optional.of(new ArtifactVersion(expectedArtifactVersion));
        }
    }

    public record ProcessingJob(
            String jobId,
            String requestId,
            String tenantId,
            String principalId,
            String artifactId,
            JobType jobType,
            String providerId,
            JobStatus status,
            Instant createdAt,
            Instant startedAt,
            Instant completedAt,
            Map<String, Object> result,
            String failureCode,
            long version,
            String expectedArtifactVersion,
            String requestFingerprint) {
        public ProcessingJob {
            jobId = required(jobId, "jobId");
            requestId = required(requestId, "requestId");
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            artifactId = required(artifactId, "artifactId");
            jobType = java.util.Objects.requireNonNull(jobType, "jobType");
            providerId = optional(providerId);
            status = java.util.Objects.requireNonNull(status, "status");
            createdAt = createdAt == null ? Instant.now() : createdAt;
            result = Map.copyOf(result == null ? Map.of() : result);
            failureCode = optional(failureCode);
            expectedArtifactVersion = optional(expectedArtifactVersion);
            if (!expectedArtifactVersion.isBlank()) new ArtifactVersion(expectedArtifactVersion);
            requestFingerprint = optional(requestFingerprint);
            if (version < 1) throw new IllegalArgumentException("version must be positive");
        }

        /** Compatibility constructor for historical jobs without a pinned content version. */
        public ProcessingJob(
                String jobId, String requestId, String tenantId, String principalId, String artifactId,
                JobType jobType, String providerId, JobStatus status, Instant createdAt, Instant startedAt,
                Instant completedAt, Map<String, Object> result, String failureCode, long version) {
            this(jobId, requestId, tenantId, principalId, artifactId, jobType, providerId, status,
                    createdAt, startedAt, completedAt, result, failureCode, version, "", "");
        }

        /** Compatibility constructor for jobs that pin a content version but predate request fingerprints. */
        public ProcessingJob(
                String jobId, String requestId, String tenantId, String principalId, String artifactId,
                JobType jobType, String providerId, JobStatus status, Instant createdAt, Instant startedAt,
                Instant completedAt, Map<String, Object> result, String failureCode, long version,
                String expectedArtifactVersion) {
            this(jobId, requestId, tenantId, principalId, artifactId, jobType, providerId, status,
                    createdAt, startedAt, completedAt, result, failureCode, version,
                    expectedArtifactVersion, "");
        }
    }

    /** Durable worker ownership; every re-claim advances the fencing token. */
    public record JobLease(
            String tenantId,
            String jobId,
            String ownerId,
            long fencingToken,
            Instant expiresAt) {
        public JobLease {
            tenantId = required(tenantId, "tenantId");
            jobId = required(jobId, "jobId");
            ownerId = required(ownerId, "ownerId");
            if (fencingToken < 1L) throw new IllegalArgumentException("fencingToken must be positive");
            expiresAt = java.util.Objects.requireNonNull(expiresAt, "expiresAt");
        }
    }

    public record RecoveryCursor(Instant createdAt, String tenantId, String jobId) {
        public RecoveryCursor {
            createdAt = java.util.Objects.requireNonNull(createdAt, "createdAt");
            tenantId = required(tenantId, "tenantId");
            jobId = required(jobId, "jobId");
        }
        public static RecoveryCursor after(ProcessingJob job) {
            return new RecoveryCursor(job.createdAt(), job.tenantId(), job.jobId());
        }
    }

    public enum AttemptFinality { SUCCEEDED, FAILED, NO_EFFECT_PROVEN, UNKNOWN }

    /** Exact identity used for an observation-only provider lookup. */
    public record ProviderAttemptQuery(
            String tenantId, String jobId, String requestId, int attemptNumber,
            long fencingToken, String requestFingerprint, String providerId,
            String providerOperationId, String providerReceiptId) {
        public ProviderAttemptQuery {
            tenantId = required(tenantId, "tenantId");
            jobId = required(jobId, "jobId");
            requestId = required(requestId, "requestId");
            if (attemptNumber < 1 || fencingToken < 1) throw new IllegalArgumentException("attempt and fencing token must be positive");
            requestFingerprint = requireSha256(requestFingerprint);
            providerId = required(providerId, "providerId");
            providerOperationId = required(providerOperationId, "providerOperationId");
            providerReceiptId = required(providerReceiptId, "providerReceiptId");
        }
    }

    public record ProviderAttemptContext(
            String tenantId, String jobId, String requestId, int attemptNumber,
            long fencingToken, String requestFingerprint) {
        public ProviderAttemptContext {
            tenantId = required(tenantId, "tenantId");
            jobId = required(jobId, "jobId");
            requestId = required(requestId, "requestId");
            if (attemptNumber < 1 || fencingToken < 1) throw new IllegalArgumentException("attempt and fencing token must be positive");
            requestFingerprint = requireSha256(requestFingerprint);
        }
        public static ProviderAttemptContext from(ProcessingAttempt attempt) {
            return new ProviderAttemptContext(attempt.tenantId(), attempt.jobId(), attempt.requestId(),
                    attempt.attemptNumber(), attempt.fencingToken(), attempt.requestFingerprint());
        }
    }

    /** Typed provider response; legacy maps are deliberately downgraded to UNKNOWN. */
    public record ProviderSubmission(
            AttemptFinality finality, String providerOperationId, String providerReceiptId,
            Map<String, Object> result, String provenanceDigest, Instant observedAt) {
        public ProviderSubmission {
            finality = java.util.Objects.requireNonNull(finality, "finality");
            providerOperationId = optional(providerOperationId);
            providerReceiptId = optional(providerReceiptId);
            result = Map.copyOf(result == null ? Map.of() : result);
            provenanceDigest = optional(provenanceDigest);
            if (finality == AttemptFinality.SUCCEEDED || finality == AttemptFinality.FAILED
                    || finality == AttemptFinality.NO_EFFECT_PROVEN) {
                if (providerOperationId.isBlank() || providerReceiptId.isBlank()
                        || !provenanceDigest.matches("[0-9a-f]{64}") || observedAt == null) {
                    throw new IllegalArgumentException("final submission requires provider receipt and provenance evidence");
                }
            }
            if (finality == AttemptFinality.UNKNOWN && !result.isEmpty()) {
                throw new IllegalArgumentException("unknown submission cannot expose an unverified result");
            }
            if (finality == AttemptFinality.NO_EFFECT_PROVEN && !result.isEmpty()) {
                throw new IllegalArgumentException("no-effect proof cannot carry a processing result");
            }
        }
        public static ProviderSubmission unknown() {
            return new ProviderSubmission(AttemptFinality.UNKNOWN, "", "", Map.of(), "", Instant.now());
        }
    }

    /** Provider's read-only statement bound back to the exact attempt query. */
    public record ProviderAttemptObservation(
            ProviderAttemptQuery query, AttemptFinality finality, String providerReceiptId,
            Map<String, Object> result, String provenanceDigest, Instant observedAt) {
        public ProviderAttemptObservation {
            query = java.util.Objects.requireNonNull(query, "query");
            finality = java.util.Objects.requireNonNull(finality, "finality");
            providerReceiptId = required(providerReceiptId, "providerReceiptId");
            if (!query.providerReceiptId().equals(providerReceiptId)) {
                throw new IllegalArgumentException("provider observation receipt does not match exact query");
            }
            result = Map.copyOf(result == null ? Map.of() : result);
            provenanceDigest = optional(provenanceDigest);
            if ((finality == AttemptFinality.SUCCEEDED || finality == AttemptFinality.FAILED
                    || finality == AttemptFinality.NO_EFFECT_PROVEN)
                    && !provenanceDigest.matches("[0-9a-f]{64}")) {
                throw new IllegalArgumentException("final provider observation requires a provenance SHA-256 digest");
            }
            if (finality == AttemptFinality.NO_EFFECT_PROVEN && !result.isEmpty()) {
                throw new IllegalArgumentException("no-effect proof cannot carry a processing result");
            }
            observedAt = java.util.Objects.requireNonNull(observedAt, "observedAt");
        }
    }

    public record ProcessingAttempt(
            String tenantId, String jobId, String requestId, int attemptNumber,
            long fencingToken, String requestFingerprint, String providerId,
            String providerOperationId, String providerReceiptId, AttemptFinality finality,
            String resultDigest, String provenanceDigest, Instant observedAt) {
        public ProcessingAttempt {
            tenantId = required(tenantId, "tenantId");
            jobId = required(jobId, "jobId");
            requestId = required(requestId, "requestId");
            if (attemptNumber < 1 || fencingToken < 1) throw new IllegalArgumentException("attempt and fencing token must be positive");
            requestFingerprint = requireSha256(requestFingerprint);
            providerId = required(providerId, "providerId");
            providerOperationId = optional(providerOperationId);
            providerReceiptId = optional(providerReceiptId);
            finality = java.util.Objects.requireNonNull(finality, "finality");
            resultDigest = optional(resultDigest);
            provenanceDigest = optional(provenanceDigest);
        }

        public ProviderAttemptQuery query() {
            if (providerOperationId.isBlank() || providerReceiptId.isBlank()) {
                throw new IllegalStateException("attempt has no persisted provider operation and receipt identity");
            }
            return new ProviderAttemptQuery(tenantId, jobId, requestId, attemptNumber, fencingToken,
                    requestFingerprint, providerId, providerOperationId, providerReceiptId);
        }
    }

    /** A durable provider execution attempt. A DISPATCH_INTENT is persisted before provider I/O. */
    public record JobAttempt(
            String tenantId,
            String jobId,
            int attemptNumber,
            String providerId,
            String requestId,
            long fencingToken,
            JobAttemptStatus status,
            Instant createdAt,
            Instant completedAt,
            String outcomeCode) {
        public JobAttempt {
            tenantId = required(tenantId, "tenantId");
            jobId = required(jobId, "jobId");
            providerId = required(providerId, "providerId");
            requestId = required(requestId, "requestId");
            if (attemptNumber < 1) throw new IllegalArgumentException("attemptNumber must be positive");
            if (fencingToken < 1) throw new IllegalArgumentException("fencingToken must be positive");
            status = java.util.Objects.requireNonNull(status, "status");
            createdAt = createdAt == null ? Instant.now() : createdAt;
            outcomeCode = optional(outcomeCode);
        }
    }

    /** Result of atomically claiming a newly accepted job and persisting its first dispatch intent. */
    public record StartedJobAttempt(ProcessingJob job, JobLease lease, JobAttempt attempt) {
        public StartedJobAttempt {
            job = java.util.Objects.requireNonNull(job, "job");
            lease = java.util.Objects.requireNonNull(lease, "lease");
            attempt = java.util.Objects.requireNonNull(attempt, "attempt");
            if (!job.tenantId().equals(lease.tenantId()) || !job.jobId().equals(lease.jobId())
                    || !job.tenantId().equals(attempt.tenantId()) || !job.jobId().equals(attempt.jobId())
                    || lease.fencingToken() != attempt.fencingToken()) {
                throw new IllegalArgumentException("started job, attempt, and lease identities must match");
            }
        }
    }

    public record StreamSessionRequest(
            String tenantId,
            String principalId,
            String correlationId,
            StreamKind streamKind,
            String providerHint,
            long maximumBufferedBytes,
            Duration leaseDuration,
            Map<String, Object> metadata,
            MediaGovernanceContext governanceContext) {
        public StreamSessionRequest {
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            correlationId = required(correlationId, "correlationId");
            streamKind = java.util.Objects.requireNonNull(streamKind, "streamKind");
            providerHint = optional(providerHint);
            if (maximumBufferedBytes < 1 || maximumBufferedBytes > 1_073_741_824L) {
                throw new IllegalArgumentException("maximumBufferedBytes must be between 1 and 1073741824");
            }
            if (leaseDuration == null || leaseDuration.isZero() || leaseDuration.isNegative()
                    || leaseDuration.compareTo(Duration.ofHours(1)) > 0) {
                throw new IllegalArgumentException("leaseDuration must be between 1 ms and 1 hour");
            }
            metadata = Map.copyOf(metadata == null ? Map.of() : metadata);
            governanceContext = governanceContext == null
                    ? MediaGovernanceContext.compatibilityDefault() : governanceContext;
        }

        public StreamSessionRequest(
                String tenantId, String principalId, String correlationId, StreamKind streamKind,
                String providerHint, long maximumBufferedBytes, Duration leaseDuration,
                Map<String, Object> metadata) {
            this(tenantId, principalId, correlationId, streamKind, providerHint,
                    maximumBufferedBytes, leaseDuration, metadata,
                    MediaGovernanceContext.compatibilityDefault());
        }
    }

    public record StreamSession(
            String tenantId,
            String sessionId,
            String principalId,
            StreamKind streamKind,
            String providerId,
            StreamState state,
            long lastSequence,
            long bufferedBytes,
            long maximumBufferedBytes,
            int reconnectCount,
            Instant leaseExpiresAt,
            Instant createdAt,
            Instant updatedAt,
            Instant closedAt,
            Map<String, Object> metadata,
            long version,
            String sequenceTokenHash,
            long acknowledgementRevision,
            StreamFinality finality,
            Long inFlightSequence,
            String inFlightAttemptId) {
        public StreamSession {
            tenantId = required(tenantId, "tenantId");
            sessionId = required(sessionId, "sessionId");
            principalId = required(principalId, "principalId");
            streamKind = java.util.Objects.requireNonNull(streamKind, "streamKind");
            providerId = required(providerId, "providerId");
            state = java.util.Objects.requireNonNull(state, "state");
            if (lastSequence < -1 || bufferedBytes < 0 || maximumBufferedBytes < 1 || reconnectCount < 0) {
                throw new IllegalArgumentException("stream counters are invalid");
            }
            createdAt = createdAt == null ? Instant.now() : createdAt;
            updatedAt = updatedAt == null ? createdAt : updatedAt;
            metadata = Map.copyOf(metadata == null ? Map.of() : metadata);
            sequenceTokenHash = optional(sequenceTokenHash);
            finality = finality == null ? StreamFinality.NONE : finality;
            inFlightAttemptId = optional(inFlightAttemptId);
            if ((!sequenceTokenHash.isEmpty() && !sequenceTokenHash.matches("[0-9a-f]{64}"))
                    || acknowledgementRevision < 0
                    || (inFlightSequence == null) != inFlightAttemptId.isEmpty()
                    || inFlightSequence != null && (inFlightSequence < 0
                            || lastSequence == Long.MAX_VALUE || inFlightSequence != lastSequence + 1
                            || finality == StreamFinality.FINAL_ACKNOWLEDGED
                            || inFlightAttemptId.length() > 128
                            || inFlightAttemptId.chars().anyMatch(Character::isISOControl))) {
                throw new IllegalArgumentException("stream acknowledgement fields exceed bounds");
            }
            if (version < 1) throw new IllegalArgumentException("version must be positive");
        }

        public StreamSession(String tenantId, String sessionId, String principalId, StreamKind streamKind,
                String providerId, StreamState state, long lastSequence, long bufferedBytes,
                long maximumBufferedBytes, int reconnectCount, Instant leaseExpiresAt, Instant createdAt,
                Instant updatedAt, Instant closedAt, Map<String, Object> metadata, long version) {
            this(tenantId, sessionId, principalId, streamKind, providerId, state, lastSequence,
                    bufferedBytes, maximumBufferedBytes, reconnectCount, leaseExpiresAt, createdAt,
                    updatedAt, closedAt, metadata, version, "", 0, StreamFinality.NONE, null, "");
        }

        public StreamSession(String tenantId, String sessionId, String principalId, StreamKind streamKind,
                String providerId, StreamState state, long lastSequence, long bufferedBytes,
                long maximumBufferedBytes, int reconnectCount, Instant leaseExpiresAt, Instant createdAt,
                Instant updatedAt, Instant closedAt, Map<String, Object> metadata, long version,
                String sequenceTokenHash, long acknowledgementRevision, StreamFinality finality) {
            this(tenantId, sessionId, principalId, streamKind, providerId, state, lastSequence,
                    bufferedBytes, maximumBufferedBytes, reconnectCount, leaseExpiresAt, createdAt,
                    updatedAt, closedAt, metadata, version, sequenceTokenHash, acknowledgementRevision,
                    finality, null, "");
        }
    }

    public enum StreamFinality { NONE, FINAL_ACKNOWLEDGED, UNKNOWN }

    public record StreamSessionRegistration(StreamSession session, String connectionToken) {
        public StreamSessionRegistration {
            session = java.util.Objects.requireNonNull(session, "session");
            connectionToken = required(connectionToken, "connectionToken");
        }
    }

    public record StreamFrame(
            String tenantId,
            String sessionId,
            String connectionToken,
            long sequence,
            byte[] payload,
            boolean endOfStream,
            Instant receivedAt) {
        public StreamFrame {
            tenantId = required(tenantId, "tenantId");
            sessionId = required(sessionId, "sessionId");
            connectionToken = required(connectionToken, "connectionToken");
            if (sequence < 0) throw new IllegalArgumentException("sequence must not be negative");
            payload = payload == null ? new byte[0] : payload.clone();
            if (payload.length == 0 && !endOfStream) throw new IllegalArgumentException("non-terminal stream frame requires payload");
            receivedAt = receivedAt == null ? Instant.now() : receivedAt;
        }
        @Override public byte[] payload() { return payload.clone(); }
    }

    public record StreamAck(long acceptedSequence, long bufferedBytes, boolean backpressured) {
        public StreamAck {
            if (acceptedSequence < 0 || bufferedBytes < 0) throw new IllegalArgumentException("stream acknowledgement counters are invalid");
        }
    }

    /** Store-atomic disposition for an idempotent upload begin. */
    public record UploadBeginResult(UploadSession session, boolean created) {
        public UploadBeginResult { java.util.Objects.requireNonNull(session, "session"); }
    }

    /** Store-atomic disposition for upload finalization. */
    public record UploadCompletionResult(MediaArtifact artifact, boolean completedNow) {
        public UploadCompletionResult { java.util.Objects.requireNonNull(artifact, "artifact"); }
    }

    public interface MediaArtifactStore extends AutoCloseable {
        String storeId();
        UploadSession begin(UploadRequest request, String idempotencyKey);
        default UploadBeginResult beginWithDisposition(UploadRequest request, String idempotencyKey) {
            throw new UnsupportedOperationException("Atomic upload begin disposition is not supported by this store");
        }
        /** @deprecated A begin without a caller idempotency key cannot prevent duplicate upload creation. */
        @Deprecated default UploadSession begin(UploadRequest request) {
            throw new IllegalArgumentException("Idempotency-Key is required to begin a Media upload");
        }
        UploadSession append(String tenantId, String principalId, String uploadId, int chunkIndex, byte[] bytes);
        MediaArtifact complete(String tenantId, String principalId, String uploadId);
        default UploadCompletionResult completeWithDisposition(String tenantId, String principalId, String uploadId) {
            throw new UnsupportedOperationException("Atomic upload completion disposition is not supported by this store");
        }
        /** @deprecated Principal-less mutation cannot prove upload ownership and always fails closed. */
        @Deprecated default UploadSession append(String tenantId, String uploadId, int chunkIndex, byte[] bytes) {
            throw new SecurityException("Authenticated principal is required to append an upload");
        }
        /** @deprecated Principal-less mutation cannot prove upload ownership and always fails closed. */
        @Deprecated default MediaArtifact complete(String tenantId, String uploadId) {
            throw new SecurityException("Authenticated principal is required to finalize an upload");
        }
        Optional<UploadSession> upload(String tenantId, String uploadId);
        Optional<MediaArtifact> artifact(String tenantId, String artifactId);
        /**
         * Read an artifact only when its current immutable content version matches the caller's
         * expected version. A missing artifact and a stale version both return empty.
         */
        default Optional<MediaArtifact> artifact(
                String tenantId, String artifactId, ArtifactVersion expectedVersion) {
            java.util.Objects.requireNonNull(expectedVersion, "expectedVersion");
            return artifact(tenantId, artifactId)
                    .filter(value -> expectedVersion.equals(value.version()));
        }
        /** Atomically register a new immutable derived artifact and its exact source lineage. */
        default MediaArtifact registerDerived(
                MediaArtifact derivedArtifact, ArtifactLineage lineage) {
            throw new UnsupportedOperationException("derived artifact registration is not supported");
        }
        boolean durable();
        boolean productionEligible();
        boolean ready();
        @Override default void close() { }
    }

    public interface MediaJobStore extends AutoCloseable {
        String storeId();
        /** Creates a job bound to the request fingerprint already pinned on the record. */
        default ProcessingJob create(ProcessingJob job) {
            return create(job, job.requestFingerprint());
        }
        /** Creates an idempotent job bound to the digest of its normalized submission and provider plan. */
        ProcessingJob create(ProcessingJob job, String submissionDigest);
        ProcessingJob update(ProcessingJob expected, ProcessingJob updated);
        /** Update a worker-owned job only while the supplied lease fence is current and unexpired. */
        ProcessingJob update(JobLease lease, ProcessingJob expected, ProcessingJob updated);
        Optional<ProcessingJob> find(String tenantId, String jobId);
        List<ProcessingJob> list(String tenantId, int limit);
        JobLease claim(ProcessingJob expected, String ownerId, Instant expiresAt);
        boolean leaseValid(JobLease lease);
        void release(JobLease lease);
        List<ProcessingJob> recoverable(int limit);
        default List<ProcessingJob> recoverableAfter(int limit, RecoveryCursor cursor) {
            return recoverable(limit).stream().filter(job -> cursor == null
                    || job.createdAt().isAfter(cursor.createdAt())
                    || (job.createdAt().equals(cursor.createdAt()) && job.tenantId().compareTo(cursor.tenantId()) > 0)
                    || (job.createdAt().equals(cursor.createdAt()) && job.tenantId().equals(cursor.tenantId())
                    && job.jobId().compareTo(cursor.jobId()) > 0)).toList();
        }
        default AttemptStart startAttempt(
                ProcessingJob accepted, ProcessingJob running, JobLease lease,
                int attemptNumber, String requestFingerprint) {
            throw new UnsupportedOperationException("atomic running transition and attempt creation is not supported");
        }
        default ProcessingAttempt recordProviderReceipt(
                ProcessingAttempt attempt, JobLease lease, String providerOperationId, String providerReceiptId) {
            throw new UnsupportedOperationException("provider receipt persistence is not supported");
        }
        /** Atomically persists the exact attempt observation, terminal job state, and lifecycle outbox row. */
        default ProcessingJob commitFinalOutcome(
                ProcessingJob expected, ProcessingAttempt attempt, ProcessingJob terminal,
                ProviderAttemptObservation observation, MediaLifecycleEvent lifecycleEvent) {
            throw new UnsupportedOperationException("atomic attempt finalization is not supported");
        }
        default ProcessingJob markOutcomeUnknown(
                ProcessingJob expected, ProcessingAttempt attempt, ProcessingJob unknown,
                Map<String, Object> observation, MediaLifecycleEvent lifecycleEvent) {
            throw new UnsupportedOperationException("atomic unknown-outcome persistence is not supported");
        }
        /** Atomically records a policy refusal proven to occur before provider dispatch. */
        default ProcessingJob markPreDispatchNoEffect(
                ProcessingJob expected, ProcessingAttempt attempt, ProcessingJob failed,
                MediaLifecycleEvent lifecycleEvent) {
            throw new UnsupportedOperationException("pre-dispatch finality is not supported");
        }
        default ProcessingJob reconcileExpired(
                ProcessingJob expected, ProcessingJob terminal, MediaLifecycleEvent lifecycleEvent) {
            return update(expected, terminal);
        }
        /** Aggregate status count used for tenant-safe operational gauges. */
        default long countByStatus(JobStatus status) {
            throw new UnsupportedOperationException("Aggregate status counts are not supported");
        }
        /** Count expired leases attached to running jobs without exposing their identifiers. */
        default long countOverdueLeases(Instant now) {
            throw new UnsupportedOperationException("Overdue lease counts are not supported");
        }
        /** Atomically claims an accepted job and persists RUNNING, its first attempt, and dispatch intent. */
        default StartedJobAttempt startAttempt(
                ProcessingJob expected, String ownerId, Instant expiresAt, String providerId) {
            JobLease lease = claim(expected, ownerId, expiresAt);
            Instant now = Instant.now();
            ProcessingJob running = new ProcessingJob(expected.jobId(), expected.requestId(), expected.tenantId(),
                    expected.principalId(), expected.artifactId(), expected.jobType(), providerId,
                    JobStatus.RUNNING, expected.createdAt(), now, null, Map.of(), "",
                    expected.version() + 1, expected.expectedArtifactVersion(), expected.requestFingerprint());
            update(expected, running);
            int attemptNumber = latestAttempt(expected.tenantId(), expected.jobId())
                    .map(previous -> previous.attemptNumber() + 1).orElse(1);
            JobAttempt attempt = new JobAttempt(expected.tenantId(), expected.jobId(), attemptNumber,
                    providerId, expected.requestId(), lease.fencingToken(), JobAttemptStatus.DISPATCH_INTENT,
                    now, null, "");
            beginAttempt(attempt);
            return new StartedJobAttempt(running, lease, attempt);
        }
        /** Persists the provider dispatch intent before any provider call is made. */
        default JobAttempt beginAttempt(JobAttempt attempt) { return attempt; }
        /** Records provider finality under the same attempt identity and fencing token. */
        default void finishAttempt(JobAttempt attempt, JobAttemptStatus status, Instant completedAt, String outcomeCode) { }
        default Optional<JobAttempt> latestAttempt(String tenantId, String jobId) { return Optional.empty(); }
        boolean durable();
        boolean productionEligible();
        boolean ready();
        @Override default void close() { }
    }

    /** Result of the single transaction that enters RUNNING and records dispatch intent. */
    public record AttemptStart(ProcessingJob running, ProcessingAttempt attempt) {
        public AttemptStart {
            running = java.util.Objects.requireNonNull(running, "running");
            attempt = java.util.Objects.requireNonNull(attempt, "attempt");
            if (running.status() != JobStatus.RUNNING || !running.jobId().equals(attempt.jobId())
                    || !running.tenantId().equals(attempt.tenantId())) {
                throw new IllegalArgumentException("running job and attempt identities must match");
            }
        }
    }

    public record ProviderObservation(JobAttemptStatus status, String outcomeCode, Map<String, Object> result) {
        public ProviderObservation {
            status = java.util.Objects.requireNonNull(status, "status");
            if (status != JobAttemptStatus.COMPLETED && status != JobAttemptStatus.FAILED) {
                throw new IllegalArgumentException("provider observation must be final");
            }
            outcomeCode = optional(outcomeCode);
            result = Map.copyOf(result == null ? Map.of() : result);
        }
    }

    public interface MediaStreamSessionStore extends AutoCloseable {
        String storeId();
        StreamSession create(StreamSession session, String connectionTokenHash);
        Optional<StreamSession> find(String tenantId, String sessionId);
        StreamSession connect(StreamSession expected, String connectionTokenHash, Instant leaseExpiresAt);
        /** Claims exactly the next sequence durably before any provider effect is dispatched. */
        default StreamSession beginFrame(StreamSession expected, long sequence, String attemptId) {
            throw new UnsupportedOperationException("Durable stream frame reservation is unavailable");
        }
        StreamSession recordFrame(StreamSession expected, long sequence, long payloadBytes, boolean endOfStream);
        /** Records a provider timeout/crash/ambiguous acknowledgement and prevents blind replay. */
        default StreamSession markFrameOutcomeUnknown(StreamSession expected) {
            throw new UnsupportedOperationException("Durable unknown stream outcome is unavailable");
        }
        default StreamSession recordFinalAcknowledgement(StreamSession expected) {
            throw new UnsupportedOperationException("Stream final acknowledgement is unavailable");
        }
        StreamSession transition(StreamSession expected, StreamState target);
        boolean tokenMatches(String tenantId, String sessionId, String connectionTokenHash);
        boolean durable();
        boolean productionEligible();
        boolean ready();
        @Override default void close() { }
    }

    public interface MediaProcessingProvider extends AutoCloseable {
        String providerId();
        default String providerVersion() { return "unspecified"; }
        default String modelVersion(JobType modality) { return providerVersion(); }
        Set<JobType> capabilities();
        /**
         * Exact STT profile candidate. An absent profile is unqualified; a provider capability
         * declaration or a caller-supplied model hint is not profile admission evidence.
         */
        default java.util.Optional<MediaSpeechToTextAdmission.Profile> speechToTextProfile() {
            return java.util.Optional.empty();
        }
        /**
         * Optional observed capability projections. Declaring a job type is not evidence of
         * codec, timing, confidence, biometric, or model support; providers must override this
         * method with source-backed facts before production admission.
         */
        default List<MediaModalityContracts.CapabilityProfile> capabilityProfiles() {
            return List.of();
        }
        default MediaModalityContracts.ProviderHealth health() {
            return new MediaModalityContracts.ProviderHealth(
                    providerId(), providerVersion(),
                    ready() ? MediaModalityContracts.ProviderHealthStatus.DEGRADED
                            : MediaModalityContracts.ProviderHealthStatus.UNAVAILABLE,
                    processingBoundary() == ProcessingBoundary.LOCAL
                            ? MediaModalityContracts.DegradationPolicy.LOCAL_DIAGNOSTIC_ONLY
                            : MediaModalityContracts.DegradationPolicy.FAIL_CLOSED,
                    ready() ? "provider readiness is not an observed modality health report"
                            : "provider is not ready", java.time.Instant.now());
        }
        default MediaModalityContracts.DegradationPolicy degradationPolicy(JobType modality) {
            return processingBoundary() == ProcessingBoundary.LOCAL
                    ? MediaModalityContracts.DegradationPolicy.LOCAL_DIAGNOSTIC_ONLY
                    : MediaModalityContracts.DegradationPolicy.FAIL_CLOSED;
        }
        default MediaModalityContracts.ExecutionBounds executionBounds() {
            return MediaModalityContracts.ExecutionBounds.defaults();
        }
        boolean ready();
        boolean productionEligible();
        int priority();
        CompletableFuture<Map<String, Object>> process(ProcessingContext context);
        default CompletableFuture<ProviderSubmission> processAttempt(
                ProcessingContext context, ProviderAttemptContext attempt) {
            java.util.Objects.requireNonNull(attempt, "attempt");
            return process(context).thenApply(ignored -> ProviderSubmission.unknown());
        }
        /** Read-only exact lookup; default implementation never infers a result from a missing receipt. */
        default CompletableFuture<ProviderAttemptObservation> reconcileAttempt(ProviderAttemptQuery query) {
            java.util.Objects.requireNonNull(query, "query");
            return CompletableFuture.completedFuture(new ProviderAttemptObservation(
                    query, AttemptFinality.UNKNOWN, query.providerReceiptId(), Map.of(), "", Instant.now()));
        }
        default CancellationOutcome cancel(
                String tenantId, String principalId, String correlationId, String jobId) {
            return CancellationOutcome.UNSUPPORTED;
        }
        /**
         * Whether this provider has explicit proof that the supplied failure is safe to repeat on
         * another provider. Timeout and network errors occur after dispatch and are ambiguous by
         * default, so providers must opt in only when their protocol supplies a stronger no-effect,
         * idempotency, or reconciliation guarantee.
         */
        default boolean fallbackEligible(Throwable failure) { return false; }
        /**
         * Returns a final observation only when the provider can query this exact tenant, job,
         * request, and attempt identity. Implementations must not create or retry provider work.
         */
        default Optional<ProviderObservation> reconcileAttempt(
                String tenantId, String jobId, String requestId, int attemptNumber) {
            return Optional.empty();
        }
        default ProcessingBoundary processingBoundary() { return ProcessingBoundary.EXTERNAL; }
        default String processingRegion() { return "unspecified"; }
        default ProviderDataRetention providerDataRetention() { return ProviderDataRetention.UNKNOWN; }
        default void verifyReady() {
            if (!ready()) throw new IllegalStateException("Media provider is not ready: " + providerId());
            if (processingBoundary() == null) throw new IllegalStateException("Media provider processing boundary is missing");
            if (providerVersion() == null || providerVersion().isBlank()) {
                throw new IllegalStateException("Media provider version is missing: " + providerId());
            }
            if (productionEligible() && "unspecified".equalsIgnoreCase(providerVersion())) {
                throw new IllegalStateException(
                        "Production Media provider version must be explicit: " + providerId());
            }
            List<MediaModalityContracts.CapabilityProfile> profiles = capabilityProfiles();
            if (profiles.stream().anyMatch(profile ->
                    !providerId().equals(profile.providerId())
                            || !providerVersion().equals(profile.providerVersion()))) {
                throw new IllegalStateException(
                        "Media provider capability profile identity does not match provider identity: " + providerId());
            }
            Set<JobType> profiled = profiles.stream()
                    .map(MediaModalityContracts.CapabilityProfile::modality)
                    .collect(java.util.stream.Collectors.toUnmodifiableSet());
            if (productionEligible() && profiles.isEmpty()) {
                throw new IllegalStateException(
                        "Production Media provider must supply explicit observed capability profiles: "
                                + providerId());
            }
            if (productionEligible() && profiles.stream().anyMatch(profile ->
                    profile.health().status() != MediaModalityContracts.ProviderHealthStatus.HEALTHY)) {
                throw new IllegalStateException(
                        "Production Media provider capability health must be explicitly healthy: " + providerId());
            }
            if (!profiles.isEmpty()
                    && (profiles.size() != profiled.size() || !profiled.equals(Set.copyOf(capabilities())))) {
                throw new IllegalStateException(
                        "Media provider capability profiles do not exactly match declared modalities: " + providerId());
            }
        }
        @Override default void close() { }
    }

    public interface MediaStreamingProvider extends AutoCloseable {
        String providerId();
        Set<StreamKind> capabilities();
        boolean ready();
        boolean productionEligible();
        int priority();
        CompletableFuture<StreamAck> accept(StreamContext context, StreamFrame frame);
        default ProcessingBoundary processingBoundary() { return ProcessingBoundary.EXTERNAL; }
        default String processingRegion() { return "unspecified"; }
        default ProviderDataRetention providerDataRetention() { return ProviderDataRetention.UNKNOWN; }
        /**
         * Verifies the provider identity and declared stream capabilities before composition.
         * Readiness alone is not sufficient: a provider with no usable stream kind must not make
         * the runtime appear ready.
         */
        default void verifyReady() {
            if (!ready()) throw new IllegalStateException("Media streaming provider is not ready: " + providerId());
            if (providerId() == null || providerId().isBlank()) {
                throw new IllegalStateException("Media streaming provider ID is missing");
            }
            if (processingBoundary() == null) {
                throw new IllegalStateException("Media streaming provider processing boundary is missing");
            }
            Set<StreamKind> declared = capabilities();
            if (declared == null || declared.isEmpty()) {
                throw new IllegalStateException("Media streaming provider declares no stream capabilities: " + providerId());
            }
        }
        default MediaModalityContracts.ProviderHealth health() {
            return new MediaModalityContracts.ProviderHealth(
                    providerId(), "stream-provider-v1",
                    ready() ? MediaModalityContracts.ProviderHealthStatus.HEALTHY
                            : MediaModalityContracts.ProviderHealthStatus.UNAVAILABLE,
                    processingBoundary() == ProcessingBoundary.LOCAL
                            ? MediaModalityContracts.DegradationPolicy.LOCAL_DIAGNOSTIC_ONLY
                            : MediaModalityContracts.DegradationPolicy.FAIL_CLOSED,
                    ready() ? "" : "provider is not ready", java.time.Instant.now());
        }
        default void closeSession(StreamContext context) { }
        @Override default void close() { }
    }

    public record ProcessingContext(
            ProcessingJobRequest request,
            MediaArtifact artifact,
            Cancellation cancellation,
            ConsentDecision consentDecision) {
        public ProcessingContext {
            java.util.Objects.requireNonNull(request, "request");
            java.util.Objects.requireNonNull(artifact, "artifact");
            java.util.Objects.requireNonNull(cancellation, "cancellation");
            consentDecision = consentDecision == null ? ConsentDecision.unverified() : consentDecision;
        }
        public ProcessingContext(ProcessingJobRequest request, MediaArtifact artifact, Cancellation cancellation) {
            this(request, artifact, cancellation, ConsentDecision.unverified());
        }
    }

    public record StreamContext(
            StreamSession session,
            Cancellation cancellation,
            ConsentDecision consentDecision,
            MediaGovernanceContext governanceContext) {
        public StreamContext {
            java.util.Objects.requireNonNull(session, "session");
            java.util.Objects.requireNonNull(cancellation, "cancellation");
            consentDecision = consentDecision == null ? ConsentDecision.unverified() : consentDecision;
            governanceContext = governanceContext == null
                    ? MediaGovernanceContext.compatibilityDefault() : governanceContext;
        }
        public StreamContext(StreamSession session, Cancellation cancellation) {
            this(session, cancellation, ConsentDecision.unverified(), MediaGovernanceContext.compatibilityDefault());
        }
    }

    public static final class Cancellation {
        private final AtomicBoolean cancelled = new AtomicBoolean(false);
        public boolean cancelled() { return cancelled.get(); }
        public void cancel() { cancelled.set(true); }
        public void throwIfCancelled() {
            if (cancelled()) throw new java.util.concurrent.CancellationException("Media operation cancelled");
        }
    }

    private static String requireSha256(String value) {
        String normalized = required(value, "sha256").toLowerCase(Locale.ROOT);
        if (!normalized.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("sha256 must contain 64 hexadecimal characters");
        return normalized;
    }

    private static Map<String, Object> immutableJsonObject(Map<String, Object> value) {
        @SuppressWarnings("unchecked")
        Map<String, Object> copy = (Map<String, Object>) immutableJsonValue(value, new IdentityHashMap<>(), 0);
        return copy;
    }

    private static Object immutableJsonValue(
            Object value, IdentityHashMap<Object, Boolean> active, int depth) {
        if (depth > 64) throw new IllegalArgumentException("Media request parameters exceed maximum JSON nesting");
        if (value == null || value instanceof String || value instanceof Boolean) return value;
        if (value instanceof MediaModalityContracts.ContextReference) return value;
        if (value instanceof Number number) {
            if (!(number instanceof Byte || number instanceof Short || number instanceof Integer
                    || number instanceof Long || number instanceof java.math.BigInteger
                    || number instanceof java.math.BigDecimal || number instanceof Double
                    || number instanceof Float)) {
                throw new IllegalArgumentException("Media request number type is not a supported JSON number");
            }
            if ((number instanceof Double d && !Double.isFinite(d))
                    || (number instanceof Float f && !Float.isFinite(f))) {
                throw new IllegalArgumentException("Media request parameters cannot contain non-finite numbers");
            }
            return number;
        }
        if (active.put(value, Boolean.TRUE) != null) {
            throw new IllegalArgumentException("Media request parameters cannot contain cyclic values");
        }
        try {
            if (value instanceof Map<?, ?> map) {
                Map<String, Object> copy = new LinkedHashMap<>();
                for (Map.Entry<?, ?> entry : map.entrySet()) {
                    if (!(entry.getKey() instanceof String key)) {
                        throw new IllegalArgumentException("Media request parameter object keys must be strings");
                    }
                    copy.put(key, immutableJsonValue(entry.getValue(), active, depth + 1));
                }
                return Collections.unmodifiableMap(copy);
            }
            if (value instanceof List<?> list) {
                List<Object> copy = new ArrayList<>(list.size());
                for (Object item : list) copy.add(immutableJsonValue(item, active, depth + 1));
                return Collections.unmodifiableList(copy);
            }
            if (value.getClass().isArray()) {
                int length = Array.getLength(value);
                Object copy = Array.newInstance(value.getClass().getComponentType(), length);
                for (int i = 0; i < length; i++) {
                    Array.set(copy, i, immutableJsonValue(Array.get(value, i), active, depth + 1));
                }
                return copy;
            }
            throw new IllegalArgumentException(
                    "Unsupported Media request parameter value type: " + value.getClass().getName());
        } finally {
            active.remove(value);
        }
    }

    private static String required(String value, String field) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(field + " is required");
        return value.trim();
    }

    private static String normalizedRequired(String value, String field) {
        return required(value, field).toLowerCase(Locale.ROOT);
    }

    private static Set<String> normalizedSet(Set<String> values) {
        return Set.copyOf(values == null ? Set.of() : values.stream()
                .filter(java.util.Objects::nonNull)
                .map(value -> value.trim().toLowerCase(Locale.ROOT))
                .filter(value -> !value.isBlank())
                .toList());
    }

    private static String optional(String value) {
        return value == null ? "" : value.trim();
    }

    private static String metadataPurpose(Map<String, Object> metadata) {
        Object value = metadata == null ? null : metadata.get("purpose");
        if (value instanceof String text && !text.isBlank()) return text.trim().toLowerCase(Locale.ROOT);
        return "unspecified";
    }
}
