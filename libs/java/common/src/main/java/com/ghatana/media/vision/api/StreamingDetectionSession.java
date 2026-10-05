package com.ghatana.media.vision.api;

import com.ghatana.media.common.ImageData;

/**
 * Streaming detection session for video processing.
 *
 * @doc.type interface
 * @doc.purpose Real-time vision streaming detection contract
 * @doc.layer platform
 * @doc.pattern ServiceInterface
 */
public interface StreamingDetectionSession extends AutoCloseable {
    void feedFrame(ImageData frame, long frameNumber);

    void endStream();

    boolean isActive();

    @Override
    void close();
}
