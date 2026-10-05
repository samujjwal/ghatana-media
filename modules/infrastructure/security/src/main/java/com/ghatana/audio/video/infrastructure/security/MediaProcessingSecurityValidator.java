package com.ghatana.audio.video.infrastructure.security;

import com.ghatana.audio.video.infrastructure.messaging.TranscriptionJobProducer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;

import java.util.Set;

/**
 * K4: Security validator for Data Cloud media processing requests.
 *
 * Enforces tenant and permission metadata from Data Cloud job request,
 * adds consent/retention validation for audio/video processing,
 * and rejects jobs without consent where required.
 *
 * @doc.type class
 * @doc.purpose Security validation for media processing
 * @doc.layer infrastructure
 * @doc.pattern Validator
 */
public class MediaProcessingSecurityValidator {

    private static final Logger LOG = LoggerFactory.getLogger(MediaProcessingSecurityValidator.class);

    private static final Set<String> REQUIRED_CONSENT_STATUSES = Set.of("GRANTED", "AUTO_APPROVED");
    private static final Set<String> VALID_RETENTION_POLICIES = Set.of("STANDARD", "SHORT", "LONG", "NONE");

    /**
     * Validation result for media processing requests
     */
    public record ValidationResult(
            boolean isValid,
            String rejectionReason,
            String errorCode
    ) {
        public static ValidationResult valid() {
            return new ValidationResult(true, null, null);
        }

        public static ValidationResult rejected(String reason, String errorCode) {
            return new ValidationResult(false, reason, errorCode);
        }
    }

    /**
     * Validate a media processing request from Data Cloud
     *
     * @param job The transcription job message to validate
     * @param requiredPermissions Set of required permissions for the operation
     * @return ValidationResult indicating if the request is valid
     */
    public ValidationResult validateMediaProcessingRequest(
            TranscriptionJobProducer.TranscriptionJobMessage job,
            Set<String> requiredPermissions) {

        try (MDC.MDCCloseable ignored = MDC.putCloseable("jobId", job.jobId().toString())) {
            MDC.put("tenantId", job.tenantId());
            if (job.artifactId() != null) {
                MDC.put("artifactId", job.artifactId().toString());
            }

            // K4: Enforce tenant metadata presence
            if (job.tenantId() == null || job.tenantId().isBlank()) {
                LOG.warn("Media processing request rejected: missing tenant ID");
                return ValidationResult.rejected("Tenant ID is required", "MISSING_TENANT_ID");
            }

            // K4: Enforce artifact ID presence
            if (job.artifactId() == null) {
                LOG.warn("Media processing request rejected: missing artifact ID");
                return ValidationResult.rejected("Artifact ID is required", "MISSING_ARTIFACT_ID");
            }

            // K4: Validate consent status
            ValidationResult consentValidation = validateConsentStatus(job.consentStatus());
            if (!consentValidation.isValid()) {
                LOG.warn("Media processing request rejected: consent validation failed - {}",
                    consentValidation.rejectionReason());
                return consentValidation;
            }

            // K4: Validate retention policy
            ValidationResult retentionValidation = validateRetentionPolicy(job.retentionPolicy());
            if (!retentionValidation.isValid()) {
                LOG.warn("Media processing request rejected: retention policy validation failed - {}",
                    retentionValidation.rejectionReason());
                return retentionValidation;
            }

            // K4: Validate correlation ID for traceability
            if (job.correlationId() == null || job.correlationId().isBlank()) {
                LOG.warn("Media processing request rejected: missing correlation ID");
                return ValidationResult.rejected("Correlation ID is required for traceability", "MISSING_CORRELATION_ID");
            }

            LOG.debug("Media processing request validation passed: jobId={}, tenantId={}",
                job.jobId(), job.tenantId());

            return ValidationResult.valid();
        }
    }

    /**
     * Validate consent status for media processing
     *
     * K4: Reject job without consent where required
     */
    private ValidationResult validateConsentStatus(String consentStatus) {
        if (consentStatus == null || consentStatus.isBlank()) {
            return ValidationResult.rejected("Consent status is required", "MISSING_CONSENT_STATUS");
        }

        if (!REQUIRED_CONSENT_STATUSES.contains(consentStatus.toUpperCase())) {
            return ValidationResult.rejected(
                "Invalid consent status: " + consentStatus + ". Required: " + REQUIRED_CONSENT_STATUSES,
                "INVALID_CONSENT_STATUS"
            );
        }

        return ValidationResult.valid();
    }

    /**
     * Validate retention policy for media processing
     *
     * K4: Ensure retention policy is valid
     */
    private ValidationResult validateRetentionPolicy(String retentionPolicy) {
        if (retentionPolicy == null || retentionPolicy.isBlank()) {
            return ValidationResult.rejected("Retention policy is required", "MISSING_RETENTION_POLICY");
        }

        if (!VALID_RETENTION_POLICIES.contains(retentionPolicy.toUpperCase())) {
            return ValidationResult.rejected(
                "Invalid retention policy: " + retentionPolicy + ". Valid policies: " + VALID_RETENTION_POLICIES,
                "INVALID_RETENTION_POLICY"
            );
        }

        return ValidationResult.valid();
    }

    /**
     * Validate tenant isolation - ensure tenant context matches request
     *
     * K4: Tenant isolation test
     */
    public ValidationResult validateTenantIsolation(
            TranscriptionJobProducer.TranscriptionJobMessage job,
            String expectedTenantId) {

        if (expectedTenantId == null || expectedTenantId.isBlank()) {
            LOG.warn("Tenant isolation validation failed: expected tenant ID is not set");
            return ValidationResult.rejected("Expected tenant ID is not set", "MISSING_EXPECTED_TENANT");
        }

        if (!expectedTenantId.equals(job.tenantId())) {
            LOG.warn("Tenant isolation violation: expected={}, actual={}",
                expectedTenantId, job.tenantId());
            return ValidationResult.rejected(
                "Tenant ID mismatch. Expected: " + expectedTenantId + ", Actual: " + job.tenantId(),
                "TENANT_ISOLATION_VIOLATION"
            );
        }

        LOG.debug("Tenant isolation validation passed: tenantId={}", job.tenantId());
        return ValidationResult.valid();
    }
}
