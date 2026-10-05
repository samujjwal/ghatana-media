/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.multimodal.datacloud;

/**
 * Pass 6: Temporal event extracted from video analysis.
 *
 * @doc.type record
 * @doc.purpose Store event with temporal bounds
 * @doc.layer product
 * @doc.pattern Immutable Record
 */
public record FrameEvent(
        String eventType,
        long startMs,
        long endMs,
        String description,
        double confidence
) {
    public FrameEvent {
        if (eventType == null || eventType.isBlank()) {
            throw new IllegalArgumentException("eventType required");
        }
    }
}
