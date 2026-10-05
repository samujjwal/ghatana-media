/**
 * @doc.type class
 * @doc.purpose Security envelope validation for Media service operations
 * @doc.layer product
 * @doc.pattern Validator
 */
package com.ghatana.media.security;

import java.util.Objects;

/**
 * Validates security envelope for media operations (upload, transcode, delivery).
 */
public final class MediaSecurityEnvelopeValidator {

    private MediaSecurityEnvelopeValidator() {
        // Utility class
    }

    public static void validateMediaOperation(
            String tenantContext,
            String principalId,
            String correlationId,
            String requestId) {
        Objects.requireNonNull(tenantContext, "TenantContext is required");
        Objects.requireNonNull(principalId, "Principal ID is required");
        validateNonBlank(principalId, "Principal ID");
        Objects.requireNonNull(correlationId, "Correlation ID is required");
        validateNonBlank(correlationId, "Correlation ID");
        Objects.requireNonNull(requestId, "Request ID is required");
    }

    private static void validateNonBlank(String value, String fieldName) {
        if (value.isBlank()) {
            throw new IllegalArgumentException(fieldName + " must not be blank");
        }
    }
}
