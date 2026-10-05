/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.multimodal.datacloud;

/**
 * Pass 6: Media processing job statuses.
 *
 * @doc.type enum
 * @doc.purpose Define job lifecycle states
 * @doc.layer product
 * @doc.pattern JobStatus
 */
public enum JobStatus {
    QUEUED,
    PROCESSING,
    COMPLETED,
    FAILED,
    CANCELLED;

    public boolean isTerminal() {
        return this == COMPLETED || this == FAILED || this == CANCELLED;
    }

    public boolean isSuccessful() {
        return this == COMPLETED;
    }
}
