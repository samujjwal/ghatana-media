/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.multimodal.datacloud;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * Pass 6: Embedding and index metadata for media artifact.
 *
 * @doc.type record
 * @doc.purpose Store vector embedding and search index metadata
 * @doc.layer product
 * @doc.pattern Immutable Record
 */
public record EmbeddingMetadata(
        String embeddingId,
        String artifactId,
        int dimensions,
        String modelId,
        String indexType,
        List<String> indexedFields,
        Map<String, Object> indexConfig,
        long vectorCount,
        Instant createdAt
) {
    public EmbeddingMetadata {
        if (embeddingId == null || embeddingId.isBlank()) {
            throw new IllegalArgumentException("embeddingId required");
        }
        if (artifactId == null || artifactId.isBlank()) {
            throw new IllegalArgumentException("artifactId required");
        }
        if (indexedFields == null) {
            indexedFields = List.of();
        }
        if (indexConfig == null) {
            indexConfig = Map.of();
        }
    }
}
