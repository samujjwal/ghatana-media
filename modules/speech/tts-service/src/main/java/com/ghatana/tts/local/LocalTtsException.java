package com.ghatana.tts.local;

/** Typed failure of a local speech synthesis invocation. The message never carries tool output or content. */
public final class LocalTtsException extends Exception {
    private static final long serialVersionUID = 1L;

    public enum Code {
        INVALID_INPUT, VOICE_NOT_ADMITTED, RUNTIME_UNAVAILABLE, TIMEOUT, CANCELLED, PROCESS_FAILED,
        OUTPUT_INVALID, OUTPUT_TOO_LARGE
    }

    private final Code code;

    public LocalTtsException(Code code, String message) {
        super(message);
        this.code = code;
    }

    public Code code() { return code; }
}
