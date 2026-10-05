package com.ghatana.media.common;

/**
 * Common engine status representation.
 *
 * @doc.type record
 * @doc.purpose Engine lifecycle and health status snapshot
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public record EngineStatus(
    State state,
    String modelId,
    String version,
    long uptimeMs,
    String errorMessage
) {
    public enum State {
        INITIALIZING,
        READY,
        BUSY,
        DEGRADED,
        ERROR,
        CLOSED
    }

    public boolean isReady() {
        return state == State.READY;
    }

    public boolean isHealthy() {
        return state == State.READY || state == State.BUSY;
    }
}
