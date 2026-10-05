/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.multimodal.datacloud;

/**
 * Pass 6: Single transcript segment with timestamps and speaker.
 *
 * @doc.type record
 * @doc.purpose Store segment-level transcription data
 * @doc.layer product
 * @doc.pattern Immutable Record
 */
public record TranscriptSegment(
        String segmentId,
        long startMs,
        long endMs,
        String speakerId,
        String text,
        double confidence
) {
    public TranscriptSegment {
        if (segmentId == null || segmentId.isBlank()) {
            throw new IllegalArgumentException("segmentId required");
        }
        if (text == null || text.isBlank()) {
            throw new IllegalArgumentException("text required");
        }
    }
}
