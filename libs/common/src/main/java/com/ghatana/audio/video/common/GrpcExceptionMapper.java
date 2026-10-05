package com.ghatana.audio.video.common;

import com.ghatana.media.common.InferenceError;
import com.ghatana.media.common.ModelLoadingError;
import com.ghatana.media.common.ProcessingError;
import com.ghatana.media.common.ResourceExhaustedError;
import com.ghatana.media.common.ValidationError;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import org.slf4j.Logger;

/**
 * Shared utility that maps platform {@link ProcessingError} exceptions — and generic
 * {@link Throwable}s — to appropriate gRPC {@link Status} codes.
 *
 * <p>Centralises the exception-to-status mapping so that all four audio-video gRPC
 * services ({@code STT}, {@code TTS}, {@code Vision}, {@code Multimodal}) handle errors
 * consistently without duplicating switch/catch logic.
 *
 * <h3>Mapping rules</h3>
 * <table>
 *   <tr><th>Exception type</th><th>gRPC Status</th></tr>
 *   <tr><td>{@link ValidationError}</td><td>INVALID_ARGUMENT</td></tr>
 *   <tr><td>{@link ModelLoadingError}</td><td>INTERNAL</td></tr>
 *   <tr><td>{@link InferenceError} (retryable)</td><td>UNAVAILABLE</td></tr>
 *   <tr><td>{@link InferenceError} (non-retryable)</td><td>INTERNAL</td></tr>
 *   <tr><td>{@link ResourceExhaustedError}</td><td>RESOURCE_EXHAUSTED</td></tr>
 *   <tr><td>{@link IllegalArgumentException}</td><td>INVALID_ARGUMENT</td></tr>
 *   <tr><td>{@link IllegalStateException}</td><td>FAILED_PRECONDITION</td></tr>
 *   <tr><td>Everything else</td><td>INTERNAL</td></tr>
 * </table>
 *
 * <h3>Usage</h3>
 * <pre>{@code
 * try {
 *     // ...
 * } catch (Exception e) {
 *     responseObserver.onError(GrpcExceptionMapper.toStatusException(e, "transcribe", LOG));
 * }
 * }</pre>
 *
 * @doc.type class
 * @doc.purpose Shared gRPC exception mapper for audio-video services
 * @doc.layer product
 * @doc.pattern Utility
 */
public final class GrpcExceptionMapper {

    private GrpcExceptionMapper() {}

    /**
     * Maps a throwable to a {@link StatusRuntimeException} and logs the error.
     *
     * <p>For {@link ProcessingError} subtypes the mapping follows the documented rules.
     * The internal error message is <em>not</em> propagated to the caller for
     * non-validation errors — only a generic message is returned to avoid leaking
     * internal detail.
     *
     * @param throwable  the exception to map
     * @param operation  human-readable operation name used in log messages (e.g., {@code "transcribe"})
     * @param log        caller's logger for error-level logging
     * @return a {@link StatusRuntimeException} ready to pass to {@code responseObserver.onError()}
     */
    public static StatusRuntimeException toStatusException(
            Throwable throwable, String operation, Logger log) {
        return toStatus(throwable, operation, log).asRuntimeException();
    }

    /**
     * Maps a throwable to a gRPC {@link Status}.
     *
     * @param throwable  the exception to map
     * @param operation  human-readable operation name
     * @param log        caller's logger
     * @return gRPC {@link Status}
     */
    public static Status toStatus(Throwable throwable, String operation, Logger log) {
        if (throwable instanceof ValidationError e) {
            log.debug("[{}] Validation error: {}", operation, e.getMessage());
            return Status.INVALID_ARGUMENT.withDescription(e.getMessage());
        }
        if (throwable instanceof ModelLoadingError e) {
            log.error("[{}] Model loading error: {}", operation, e.getMessage(), e);
            return Status.INTERNAL.withDescription("Model unavailable");
        }
        if (throwable instanceof InferenceError e) {
            if (e.isRetryable()) {
                log.warn("[{}] Retryable inference error: {}", operation, e.getMessage(), e);
                return Status.UNAVAILABLE.withDescription("Service temporarily unavailable — retry");
            }
            log.error("[{}] Non-retryable inference error: {}", operation, e.getMessage(), e);
            return Status.INTERNAL.withDescription("Inference failed");
        }
        if (throwable instanceof ResourceExhaustedError e) {
            log.warn("[{}] Resource exhausted: {}", operation, e.getMessage());
            return Status.RESOURCE_EXHAUSTED.withDescription("Capacity exceeded — retry later");
        }
        if (throwable instanceof IllegalArgumentException e) {
            log.debug("[{}] Invalid argument: {}", operation, e.getMessage());
            return Status.INVALID_ARGUMENT.withDescription(e.getMessage());
        }
        if (throwable instanceof IllegalStateException e) {
            log.warn("[{}] Precondition failed: {}", operation, e.getMessage());
            return Status.FAILED_PRECONDITION.withDescription(e.getMessage());
        }
        // Catch-all: log with full stack trace, return generic message to caller
        log.error("[{}] Unexpected error", operation, throwable);
        return Status.INTERNAL.withDescription("Internal server error");
    }

    /**
     * Returns {@code true} if the mapped status is retryable by the caller
     * (i.e., {@code UNAVAILABLE} or {@code RESOURCE_EXHAUSTED}).
     *
     * @param status gRPC status to check
     * @return whether the client should retry
     */
    public static boolean isRetryable(Status status) {
        return status.getCode() == Status.Code.UNAVAILABLE
                || status.getCode() == Status.Code.RESOURCE_EXHAUSTED;
    }
}
