package com.ghatana.media.runtime;

/**
 * A stream frame may have crossed the provider boundary, but no authoritative
 * acknowledgement could be confirmed. Callers must reconcile before retrying.
 */
public final class MediaStreamOutcomeUnknownException extends IllegalStateException {
    private static final long serialVersionUID = 1L;

    public MediaStreamOutcomeUnknownException(String message, Throwable cause) {
        super(message, cause);
    }
}
