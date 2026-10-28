package com.ghatana.media.stt.engine.onnx;

import java.util.Map;
import java.util.Objects;

/**
 * Source-owned, opt-in ONNX CPU intra-op tuning. The ordinary model profile keeps
 * ONNX Runtime's existing default (zero / unspecified) until a same-source A/B
 * benchmark justifies changing it.
 *
 * <p>Only the trusted service environment may configure this hint. A malformed
 * or oversubscribed value aborts model creation; request data is never allowed
 * to select thread counts.
 */
final class WhisperOnnxThreadPolicy {
    static final String INTRA_OP_THREADS_ENV = "GHATANA_MEDIA_WHISPER_ORT_INTRA_OP_THREADS";

    private WhisperOnnxThreadPolicy() { }

    static int intraOpThreads(Map<String, String> environment, int availableProcessors) {
        Objects.requireNonNull(environment, "environment");
        if (availableProcessors < 1) {
            throw new IllegalArgumentException("availableProcessors must be positive");
        }
        String raw = environment.get(INTRA_OP_THREADS_ENV);
        if (raw == null || raw.isEmpty()) {
            return 0; // Retain ONNX's existing default, no implicit performance claim.
        }
        if (!raw.matches("[1-9][0-9]?")) {
            throw new IllegalArgumentException(INTRA_OP_THREADS_ENV
                    + " must be an exact positive decimal integer with no whitespace");
        }
        int value = Integer.parseInt(raw);
        int ceiling = Math.min(32, availableProcessors);
        if (value > ceiling) {
            throw new IllegalArgumentException(INTRA_OP_THREADS_ENV
                    + " exceeds the CPU-visible bounded thread budget " + ceiling);
        }
        return value;
    }
}
