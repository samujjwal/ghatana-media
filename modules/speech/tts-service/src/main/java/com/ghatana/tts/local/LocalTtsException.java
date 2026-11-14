package com.ghatana.tts.local;

/** Typed failure of a local speech synthesis invocation. The message never carries tool output or content. */
public final class LocalTtsException extends Exception {
    private static final long serialVersionUID = 1L;

    public enum Code {
        INVALID_INPUT, VOICE_NOT_ADMITTED, RUNTIME_UNAVAILABLE, TIMEOUT, CANCELLED, PROCESS_FAILED,
        OUTPUT_INVALID, OUTPUT_TOO_LARGE, ENCODING_NOT_SUPPORTED,
        /** The persistent worker is dead, unreachable, refused its credentials or is cooling down after repeated failures. */
        WORKER_UNAVAILABLE,
        /** The persistent worker's bounded queue is full; nothing was synthesized. */
        WORKER_BUSY,
        /** The verified files (weights, voices, worker script) changed after verification; the worker is withdrawn. */
        FILES_CHANGED
    }

    private final Code code;

    public LocalTtsException(Code code, String message) {
        super(message);
        this.code = code;
    }

    public Code code() { return code; }
}
