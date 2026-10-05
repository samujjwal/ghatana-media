package com.ghatana.media.common;

/**
 * Base exception for audio-video processing failures.
 *
 * @doc.type class
 * @doc.purpose Sealed base exception for engine processing failures
 * @doc.layer platform
 * @doc.pattern Exception
 */
public sealed class ProcessingError extends RuntimeException
    permits ValidationError, ModelLoadingError, InferenceError, ResourceExhaustedError {

    private final ErrorCategory category;
    private final boolean retryable;

    public ProcessingError(String message, ErrorCategory category, boolean retryable) {
        super(message);
        this.category = category;
        this.retryable = retryable;
    }

    public ProcessingError(String message, Throwable cause, ErrorCategory category, boolean retryable) {
        super(message, cause);
        this.category = category;
        this.retryable = retryable;
    }

    public ErrorCategory getCategory() {
        return category;
    }

    public boolean isRetryable() {
        return retryable;
    }

    public enum ErrorCategory {
        INPUT_VALIDATION,
        MODEL_LOADING,
        INFERENCE,
        RESOURCE_EXHAUSTED,
        NETWORK,
        INTERNAL
    }
}
