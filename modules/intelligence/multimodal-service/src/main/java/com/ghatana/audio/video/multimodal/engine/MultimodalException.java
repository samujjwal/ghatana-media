package com.ghatana.audio.video.multimodal.engine;

import com.ghatana.core.exception.ServiceException;

/**
 * Unchecked exception for multimodal analysis failures.
 *
 * @doc.type exception
 * @doc.purpose Multimodal analysis engine failure
 * @doc.layer product
 * @doc.pattern Exception
 */
public class MultimodalException extends ServiceException {

    public MultimodalException(String message) {
        super(message);
    }

    public MultimodalException(String message, Throwable cause) {
        super(message, cause);
    }
}
