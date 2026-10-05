/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.multimodal.datacloud;

/**
 * Pass 6: Aggregated label information across frames.
 *
 * @doc.type record
 * @doc.purpose Store label occurrence statistics
 * @doc.layer product
 * @doc.pattern Immutable Record
 */
public record FrameLabel(
        String label,
        int occurrenceCount,
        double avgConfidence
) {
    public FrameLabel {
        if (label == null || label.isBlank()) {
            throw new IllegalArgumentException("label required");
        }
    }
}
