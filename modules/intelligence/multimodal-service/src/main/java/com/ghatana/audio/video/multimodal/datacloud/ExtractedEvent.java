/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.multimodal.datacloud;

/**
 * Pass 6: Extracted event from media analysis.
 *
 * @doc.type record
 * @doc.purpose Store extracted event with temporal bounds
 * @doc.layer product
 * @doc.pattern Immutable Record
 */
public record ExtractedEvent(
        String eventType,
        long startMs,
        long endMs,
        String description,
        double confidence
) {
    public ExtractedEvent {
        if (eventType == null || eventType.isBlank()) {
            throw new IllegalArgumentException("eventType required");
        }
    }
}
