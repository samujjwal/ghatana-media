/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.multimodal.datacloud;

import java.time.Instant;
import java.util.Map;

/**
 * Pass 6: Media processing job record for Data Cloud lifecycle.
 *
 * @doc.type record
 * @doc.purpose Track media processing job state
 * @doc.layer product
 * @doc.pattern Immutable Record
 */
public record MediaProcessingJob(
        String jobId,
        String artifactId,
        String tenantId,
        String jobType,
        String status,
        Map<String, String> parameters,
        String resultId,
        String errorMessage,
        int progress,
        Instant createdAt,
        Instant startedAt,
        Instant completedAt,
        String createdBy
) {
    public MediaProcessingJob {
        if (jobId == null || jobId.isBlank()) {
            throw new IllegalArgumentException("jobId required");
        }
        if (artifactId == null || artifactId.isBlank()) {
            throw new IllegalArgumentException("artifactId required");
        }
        if (tenantId == null || tenantId.isBlank()) {
            throw new IllegalArgumentException("tenantId required");
        }
        if (parameters == null) {
            parameters = Map.of();
        }
    }

    public boolean isTerminal() {
        return JobStatus.valueOf(status).isTerminal();
    }

    public boolean isSuccessful() {
        return JobStatus.valueOf(status).isSuccessful();
    }
}
