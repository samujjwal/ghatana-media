/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.multimodal.datacloud;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * Pass 6: Frame index result for image/video analysis.
 *
 * @doc.type record
 * @doc.purpose Store frame-level analysis output
 * @doc.layer product
 * @doc.pattern Immutable Record
 */
public record FrameIndexResult(
        String frameIndexId,
        String artifactId,
        String jobId,
        String analysisType,
        List<FrameIndexEntry> frames,
        List<FrameLabel> labels,
        List<FrameEvent> events,
        double confidence,
        int frameCount,
        long durationMs,
        Map<String, Object> metadata,
        Instant createdAt
) {
    public FrameIndexResult {
        if (frameIndexId == null || frameIndexId.isBlank()) {
            throw new IllegalArgumentException("frameIndexId required");
        }
        if (artifactId == null || artifactId.isBlank()) {
            throw new IllegalArgumentException("artifactId required");
        }
        if (frames == null) {
            frames = List.of();
        }
        if (labels == null) {
            labels = List.of();
        }
        if (events == null) {
            events = List.of();
        }
        if (metadata == null) {
            metadata = Map.of();
        }
    }
}
