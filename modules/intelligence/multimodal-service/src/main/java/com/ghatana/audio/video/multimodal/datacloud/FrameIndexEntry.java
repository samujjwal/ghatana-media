/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.multimodal.datacloud;

import java.util.List;
import java.util.Map;

/**
 * Pass 6: Single frame entry in frame index.
 *
 * @doc.type record
 * @doc.purpose Store per-frame analysis data
 * @doc.layer product
 * @doc.pattern Immutable Record
 */
public record FrameIndexEntry(
        int frameNumber,
        long timestampMs,
        List<String> labels,
        Map<String, List<Double>> boundingBoxes,
        double confidence
) {
    public FrameIndexEntry {
        if (labels == null) {
            labels = List.of();
        }
        if (boundingBoxes == null) {
            boundingBoxes = Map.of();
        }
    }
}
