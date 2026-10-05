package com.ghatana.media.common;

/**
 * Input validation error.
 *
 * @doc.type class
 * @doc.purpose Exception raised for invalid audio-video input data
 * @doc.layer platform
 * @doc.pattern Exception
 */
public final class ValidationError extends ProcessingError {
    public ValidationError(String message) {
        super(message, ErrorCategory.INPUT_VALIDATION, false);
    }
}
