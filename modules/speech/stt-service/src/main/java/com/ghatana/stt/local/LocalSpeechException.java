package com.ghatana.stt.local;

/** Typed failure of a local speech runtime invocation. The message never carries tool output or content. */
public final class LocalSpeechException extends Exception {
    private static final long serialVersionUID = 1L;

    public enum Code {
        INVALID_INPUT, RUNTIME_UNAVAILABLE, TIMEOUT, CANCELLED, PROCESS_FAILED, OUTPUT_INVALID, OUTPUT_TOO_LARGE
    }

    private final Code code;

    public LocalSpeechException(Code code, String message) {
        super(message);
        this.code = code;
    }

    public Code code() { return code; }
}
