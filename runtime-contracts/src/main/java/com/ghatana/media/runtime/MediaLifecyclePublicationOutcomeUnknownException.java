package com.ghatana.media.runtime;

/** Indicates an Event Plane append may have committed without a verifiable receipt. */
public final class MediaLifecyclePublicationOutcomeUnknownException extends IllegalStateException {
    public MediaLifecyclePublicationOutcomeUnknownException(String message, Throwable cause) {
        super(message, cause);
    }

    public MediaLifecyclePublicationOutcomeUnknownException(String message) {
        super(message);
    }
}
