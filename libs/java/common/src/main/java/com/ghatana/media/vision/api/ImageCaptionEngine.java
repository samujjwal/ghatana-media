package com.ghatana.media.vision.api;

import com.ghatana.media.common.ImageData;

/**
 * Optional caption authority, deliberately separate from object detection.
 *
 * @doc.type interface
 * @doc.purpose Define the Image Caption Engine contract
 * @doc.layer product
 * @doc.pattern Engine
 */
public interface ImageCaptionEngine {
    String caption(ImageData image);
}
