package com.ghatana.media.vision.api;

import com.ghatana.media.common.ImageData;
import java.util.List;

/**
 * Optional classification authority. Implement only when a real classifier is composed.
 *
 * @doc.type interface
 * @doc.purpose Define the Image Classification Engine contract
 * @doc.layer product
 * @doc.pattern Engine
 */
public interface ImageClassificationEngine {
    List<Classification> classify(ImageData image, int topK);
}
