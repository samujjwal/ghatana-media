package com.ghatana.audio.video.multimodal.engine;

import com.ghatana.media.error.ErrorHandler;

/**
 * @doc.type record
 * @doc.purpose Standardized multimodal error envelope aligned with the shared media error taxonomy
 * @doc.layer product
 * @doc.pattern ValueObject
 */
public record AudioVideoProcessingError(String code, String category, boolean retryable, String message) {

    /**
     * Maps an arbitrary throwable to a standardized audio-video processing error.
     */
    public static AudioVideoProcessingError fromThrowable(String context, Throwable throwable) {
        String message = throwable == null ? context : context + ": " + throwable.getMessage();
        boolean retryable = ErrorHandler.isRetryable(throwable);
        if (throwable instanceof IllegalArgumentException) {
            return new AudioVideoProcessingError("media.invalid_request", "validation", false, message);
        }
        if (retryable) {
            return new AudioVideoProcessingError("media.temporarily_unavailable", "runtime", true, message);
        }
        return new AudioVideoProcessingError("media.processing_failed", "runtime", false, message);
    }

}
