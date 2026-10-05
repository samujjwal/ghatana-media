/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.multimodal.datacloud;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * Pass 6: Transcription result for Data Cloud media artifact.
 *
 * @doc.type record
 * @doc.purpose Store transcription output with segments and metadata
 * @doc.layer product
 * @doc.pattern Immutable Record
 */
public record TranscriptResult(
        String transcriptId,
        String artifactId,
        String jobId,
        String languageCode,
        List<TranscriptSegment> segments,
        String fullText,
        double confidence,
        long durationMs,
        int wordCount,
        int speakerCount,
        Map<String, Object> metadata,
        Instant createdAt
) {
    public TranscriptResult {
        if (transcriptId == null || transcriptId.isBlank()) {
            throw new IllegalArgumentException("transcriptId required");
        }
        if (artifactId == null || artifactId.isBlank()) {
            throw new IllegalArgumentException("artifactId required");
        }
        if (segments == null) {
            segments = List.of();
        }
        if (metadata == null) {
            metadata = Map.of();
        }
    }
}
