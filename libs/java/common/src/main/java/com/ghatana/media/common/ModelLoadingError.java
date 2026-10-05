package com.ghatana.media.common;

/**
 * Model loading error.
 *
 * @doc.type class
 * @doc.purpose Exception raised when an engine model cannot be loaded
 * @doc.layer platform
 * @doc.pattern Exception
 */
public final class ModelLoadingError extends ProcessingError {
    public ModelLoadingError(String message) {
        super(message, ErrorCategory.MODEL_LOADING, false);
    }

    public ModelLoadingError(String message, Throwable cause) {
        super(message, cause, ErrorCategory.MODEL_LOADING, false);
    }
}
