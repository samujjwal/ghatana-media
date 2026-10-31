package com.ghatana.audio.video.vision.scenetext;

import java.util.Optional;

/**
 * Sanitized failure from the Document Intelligence v1 boundary. Raw worker payloads
 * and transport details are never carried.
 *
 * @doc.type class
 * @doc.purpose Typed DI v1 consumer failure
 * @doc.layer product
 * @doc.pattern Exception
 */
public final class DocumentIntelligenceException extends Exception {

    public enum Kind { UNAVAILABLE, TIMEOUT, CANCELLED, WORKER_ERROR, INVALID_RESPONSE, SOURCE_TOO_LARGE }

    private final Kind kind;
    private final String workerCode;
    private final boolean retryable;

    public DocumentIntelligenceException(Kind kind, String workerCode, boolean retryable) {
        super("Document Intelligence " + kind + (workerCode == null ? "" : ": " + workerCode));
        this.kind = kind;
        this.workerCode = workerCode;
        this.retryable = retryable;
    }

    public static DocumentIntelligenceException of(Kind kind) {
        return new DocumentIntelligenceException(kind, null, kind == Kind.UNAVAILABLE || kind == Kind.TIMEOUT);
    }

    public Kind kind() {
        return kind;
    }

    /** Sanitized DI error code from a v1 error envelope, when {@link Kind#WORKER_ERROR}. */
    public Optional<String> workerCode() {
        return Optional.ofNullable(workerCode);
    }

    public boolean retryable() {
        return retryable;
    }
}
