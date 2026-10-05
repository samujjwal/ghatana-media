package com.ghatana.media.common;

/**
 * Resource exhaustion error.
 *
 * @doc.type class
 * @doc.purpose Exception raised when engine resource limits are exceeded
 * @doc.layer platform
 * @doc.pattern Exception
 */
public final class ResourceExhaustedError extends ProcessingError {
    public ResourceExhaustedError(String message) {
        super(message, ErrorCategory.RESOURCE_EXHAUSTED, true);
    }
}
