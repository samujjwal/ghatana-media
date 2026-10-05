package com.ghatana.media.common;

/**
 * Inference error that may be retryable.
 *
 * @doc.type class
 * @doc.purpose Exception raised when model inference fails
 * @doc.layer platform
 * @doc.pattern Exception
 */
public final class InferenceError extends ProcessingError {
    public InferenceError(String message, Throwable cause, boolean retryable) {
        super(message, cause, ErrorCategory.INFERENCE, retryable);
    }
}
