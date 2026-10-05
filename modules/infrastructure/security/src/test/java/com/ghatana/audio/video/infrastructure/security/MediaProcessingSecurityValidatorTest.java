package com.ghatana.audio.video.infrastructure.security;

import com.ghatana.audio.video.infrastructure.messaging.TranscriptionJobProducer;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Set;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * K4: Tests for media processing security validator.
 *
 * Tests media consent enforcement and tenant isolation.
 *
 * @doc.type test
 * @doc.purpose Test media processing security validation
 * @doc.layer infrastructure
 * @doc.pattern Test
 */
@DisplayName("Media Processing Security Validator Tests")
class MediaProcessingSecurityValidatorTest {

    private final MediaProcessingSecurityValidator validator = new MediaProcessingSecurityValidator();

    @Test
    @DisplayName("should reject request with missing tenant ID")
    void shouldRejectMissingTenantId() {
        TranscriptionJobProducer.TranscriptionJobMessage job =
            TranscriptionJobProducer.TranscriptionJobMessage.createWithDataCloudMetadata(
                null,
                UUID.randomUUID(),
                UUID.randomUUID().toString(),
                "GRANTED",
                "STANDARD",
                "en-US"
            );

        MediaProcessingSecurityValidator.ValidationResult result =
            validator.validateMediaProcessingRequest(job, Set.of());

        assertThat(result.isValid()).isFalse();
        assertThat(result.errorCode()).isEqualTo("MISSING_TENANT_ID");
    }

    @Test
    @DisplayName("should reject request with blank tenant ID")
    void shouldRejectBlankTenantId() {
        TranscriptionJobProducer.TranscriptionJobMessage job =
            TranscriptionJobProducer.TranscriptionJobMessage.createWithDataCloudMetadata(
                "   ",
                UUID.randomUUID(),
                UUID.randomUUID().toString(),
                "GRANTED",
                "STANDARD",
                "en-US"
            );

        MediaProcessingSecurityValidator.ValidationResult result =
            validator.validateMediaProcessingRequest(job, Set.of());

        assertThat(result.isValid()).isFalse();
        assertThat(result.errorCode()).isEqualTo("MISSING_TENANT_ID");
    }

    @Test
    @DisplayName("should reject request with missing artifact ID")
    void shouldRejectMissingArtifactId() {
        TranscriptionJobProducer.TranscriptionJobMessage job =
            TranscriptionJobProducer.TranscriptionJobMessage.createWithDataCloudMetadata(
                "tenant-123",
                null,
                UUID.randomUUID().toString(),
                "GRANTED",
                "STANDARD",
                "en-US"
            );

        MediaProcessingSecurityValidator.ValidationResult result =
            validator.validateMediaProcessingRequest(job, Set.of());

        assertThat(result.isValid()).isFalse();
        assertThat(result.errorCode()).isEqualTo("MISSING_ARTIFACT_ID");
    }

    @Test
    @DisplayName("should reject request with missing consent status")
    void shouldRejectMissingConsentStatus() {
        TranscriptionJobProducer.TranscriptionJobMessage job =
            new TranscriptionJobProducer.TranscriptionJobMessage(
                UUID.randomUUID(),
                "tenant-123",
                UUID.randomUUID(),
                UUID.randomUUID().toString(),
                null,
                "STANDARD",
                "en-US",
                null,
                java.time.Instant.now()
            );

        MediaProcessingSecurityValidator.ValidationResult result =
            validator.validateMediaProcessingRequest(job, Set.of());

        assertThat(result.isValid()).isFalse();
        assertThat(result.errorCode()).isEqualTo("MISSING_CONSENT_STATUS");
    }

    @Test
    @DisplayName("should reject request with blank consent status")
    void shouldRejectBlankConsentStatus() {
        TranscriptionJobProducer.TranscriptionJobMessage job =
            new TranscriptionJobProducer.TranscriptionJobMessage(
                UUID.randomUUID(),
                "tenant-123",
                UUID.randomUUID(),
                UUID.randomUUID().toString(),
                "   ",
                "STANDARD",
                "en-US",
                null,
                java.time.Instant.now()
            );

        MediaProcessingSecurityValidator.ValidationResult result =
            validator.validateMediaProcessingRequest(job, Set.of());

        assertThat(result.isValid()).isFalse();
        assertThat(result.errorCode()).isEqualTo("MISSING_CONSENT_STATUS");
    }

    @Test
    @DisplayName("should reject request with invalid consent status")
    void shouldRejectInvalidConsentStatus() {
        TranscriptionJobProducer.TranscriptionJobMessage job =
            TranscriptionJobProducer.TranscriptionJobMessage.createWithDataCloudMetadata(
                "tenant-123",
                UUID.randomUUID(),
                UUID.randomUUID().toString(),
                "DENIED",
                "STANDARD",
                "en-US"
            );

        MediaProcessingSecurityValidator.ValidationResult result =
            validator.validateMediaProcessingRequest(job, Set.of());

        assertThat(result.isValid()).isFalse();
        assertThat(result.errorCode()).isEqualTo("INVALID_CONSENT_STATUS");
    }

    @Test
    @DisplayName("should accept request with GRANTED consent status")
    void shouldAcceptGrantedConsentStatus() {
        TranscriptionJobProducer.TranscriptionJobMessage job =
            TranscriptionJobProducer.TranscriptionJobMessage.createWithDataCloudMetadata(
                "tenant-123",
                UUID.randomUUID(),
                UUID.randomUUID().toString(),
                "GRANTED",
                "STANDARD",
                "en-US"
            );

        MediaProcessingSecurityValidator.ValidationResult result =
            validator.validateMediaProcessingRequest(job, Set.of());

        assertThat(result.isValid()).isTrue();
    }

    @Test
    @DisplayName("should accept request with AUTO_APPROVED consent status")
    void shouldAcceptAutoApprovedConsentStatus() {
        TranscriptionJobProducer.TranscriptionJobMessage job =
            TranscriptionJobProducer.TranscriptionJobMessage.createWithDataCloudMetadata(
                "tenant-123",
                UUID.randomUUID(),
                UUID.randomUUID().toString(),
                "AUTO_APPROVED",
                "STANDARD",
                "en-US"
            );

        MediaProcessingSecurityValidator.ValidationResult result =
            validator.validateMediaProcessingRequest(job, Set.of());

        assertThat(result.isValid()).isTrue();
    }

    @Test
    @DisplayName("should reject request with missing retention policy")
    void shouldRejectMissingRetentionPolicy() {
        TranscriptionJobProducer.TranscriptionJobMessage job =
            new TranscriptionJobProducer.TranscriptionJobMessage(
                UUID.randomUUID(),
                "tenant-123",
                UUID.randomUUID(),
                UUID.randomUUID().toString(),
                "GRANTED",
                null,
                "en-US",
                null,
                java.time.Instant.now()
            );

        MediaProcessingSecurityValidator.ValidationResult result =
            validator.validateMediaProcessingRequest(job, Set.of());

        assertThat(result.isValid()).isFalse();
        assertThat(result.errorCode()).isEqualTo("MISSING_RETENTION_POLICY");
    }

    @Test
    @DisplayName("should reject request with invalid retention policy")
    void shouldRejectInvalidRetentionPolicy() {
        TranscriptionJobProducer.TranscriptionJobMessage job =
            TranscriptionJobProducer.TranscriptionJobMessage.createWithDataCloudMetadata(
                "tenant-123",
                UUID.randomUUID(),
                UUID.randomUUID().toString(),
                "GRANTED",
                "INVALID_POLICY",
                "en-US"
            );

        MediaProcessingSecurityValidator.ValidationResult result =
            validator.validateMediaProcessingRequest(job, Set.of());

        assertThat(result.isValid()).isFalse();
        assertThat(result.errorCode()).isEqualTo("INVALID_RETENTION_POLICY");
    }

    @Test
    @DisplayName("should accept valid retention policies")
    void shouldAcceptValidRetentionPolicies() {
        String[] validPolicies = {"STANDARD", "SHORT", "LONG", "NONE"};

        for (String policy : validPolicies) {
            TranscriptionJobProducer.TranscriptionJobMessage job =
                TranscriptionJobProducer.TranscriptionJobMessage.createWithDataCloudMetadata(
                    "tenant-123",
                    UUID.randomUUID(),
                    UUID.randomUUID().toString(),
                    "GRANTED",
                    policy,
                    "en-US"
                );

            MediaProcessingSecurityValidator.ValidationResult result =
                validator.validateMediaProcessingRequest(job, Set.of());

            assertThat(result.isValid()).isTrue();
        }
    }

    @Test
    @DisplayName("should reject request with missing correlation ID")
    void shouldRejectMissingCorrelationId() {
        TranscriptionJobProducer.TranscriptionJobMessage job =
            new TranscriptionJobProducer.TranscriptionJobMessage(
                UUID.randomUUID(),
                "tenant-123",
                UUID.randomUUID(),
                null,
                "GRANTED",
                "STANDARD",
                "en-US",
                null,
                java.time.Instant.now()
            );

        MediaProcessingSecurityValidator.ValidationResult result =
            validator.validateMediaProcessingRequest(job, Set.of());

        assertThat(result.isValid()).isFalse();
        assertThat(result.errorCode()).isEqualTo("MISSING_CORRELATION_ID");
    }

    @Test
    @DisplayName("should reject request with blank correlation ID")
    void shouldRejectBlankCorrelationId() {
        TranscriptionJobProducer.TranscriptionJobMessage job =
            new TranscriptionJobProducer.TranscriptionJobMessage(
                UUID.randomUUID(),
                "tenant-123",
                UUID.randomUUID(),
                "   ",
                "GRANTED",
                "STANDARD",
                "en-US",
                null,
                java.time.Instant.now()
            );

        MediaProcessingSecurityValidator.ValidationResult result =
            validator.validateMediaProcessingRequest(job, Set.of());

        assertThat(result.isValid()).isFalse();
        assertThat(result.errorCode()).isEqualTo("MISSING_CORRELATION_ID");
    }

    @Test
    @DisplayName("should validate tenant isolation with matching tenant ID")
    void shouldValidateTenantIsolationWithMatchingTenant() {
        // K4: Tenant isolation test
        String tenantId = "tenant-123";
        TranscriptionJobProducer.TranscriptionJobMessage job =
            TranscriptionJobProducer.TranscriptionJobMessage.createWithDataCloudMetadata(
                tenantId,
                UUID.randomUUID(),
                UUID.randomUUID().toString(),
                "GRANTED",
                "STANDARD",
                "en-US"
            );

        MediaProcessingSecurityValidator.ValidationResult result =
            validator.validateTenantIsolation(job, tenantId);

        assertThat(result.isValid()).isTrue();
    }

    @Test
    @DisplayName("should reject tenant isolation with mismatched tenant ID")
    void shouldRejectTenantIsolationWithMismatchedTenant() {
        // K4: Tenant isolation test
        TranscriptionJobProducer.TranscriptionJobMessage job =
            TranscriptionJobProducer.TranscriptionJobMessage.createWithDataCloudMetadata(
                "tenant-123",
                UUID.randomUUID(),
                UUID.randomUUID().toString(),
                "GRANTED",
                "STANDARD",
                "en-US"
            );

        MediaProcessingSecurityValidator.ValidationResult result =
            validator.validateTenantIsolation(job, "tenant-456");

        assertThat(result.isValid()).isFalse();
        assertThat(result.errorCode()).isEqualTo("TENANT_ISOLATION_VIOLATION");
    }

    @Test
    @DisplayName("should reject tenant isolation with missing expected tenant ID")
    void shouldRejectTenantIsolationWithMissingExpectedTenant() {
        // K4: Tenant isolation test
        TranscriptionJobProducer.TranscriptionJobMessage job =
            TranscriptionJobProducer.TranscriptionJobMessage.createWithDataCloudMetadata(
                "tenant-123",
                UUID.randomUUID(),
                UUID.randomUUID().toString(),
                "GRANTED",
                "STANDARD",
                "en-US"
            );

        MediaProcessingSecurityValidator.ValidationResult result =
            validator.validateTenantIsolation(job, null);

        assertThat(result.isValid()).isFalse();
        assertThat(result.errorCode()).isEqualTo("MISSING_EXPECTED_TENANT");
    }

    @Test
    @DisplayName("should accept fully valid media processing request")
    void shouldAcceptFullyValidRequest() {
        TranscriptionJobProducer.TranscriptionJobMessage job =
            TranscriptionJobProducer.TranscriptionJobMessage.createWithDataCloudMetadata(
                "tenant-123",
                UUID.randomUUID(),
                UUID.randomUUID().toString(),
                "GRANTED",
                "STANDARD",
                "en-US"
            );

        MediaProcessingSecurityValidator.ValidationResult result =
            validator.validateMediaProcessingRequest(job, Set.of("media:process"));

        assertThat(result.isValid()).isTrue();
    }
}
