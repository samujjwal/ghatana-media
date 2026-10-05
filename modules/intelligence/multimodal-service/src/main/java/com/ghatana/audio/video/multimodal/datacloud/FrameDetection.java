/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.multimodal.datacloud;

import java.util.List;

/**
 * Pass 6: Detection within a frame.
 *
 * @doc.type record
 * @doc.purpose Store detection label with bounding box
 * @doc.layer product
 * @doc.pattern Immutable Record
 */
public record FrameDetection(
        String label,
        double confidence,
        List<Double> boundingBox
) {
    public FrameDetection {
        if (label == null || label.isBlank()) {
            throw new IllegalArgumentException("label required");
        }
        if (boundingBox == null) {
            boundingBox = List.of();
        }
    }
}
