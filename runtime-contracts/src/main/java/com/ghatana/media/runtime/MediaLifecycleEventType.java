package com.ghatana.media.runtime;

import java.util.Arrays;

/** Stable public v1 lifecycle event names observed at Media runtime transition sites. */
public enum MediaLifecycleEventType {
    UPLOAD_STARTED("media.upload.started", false),
    ARTIFACT_COMPLETED("media.artifact.completed", false),
    JOB_ACCEPTED("media.job.accepted", false),
    JOB_CANCELLED("media.job.cancelled", true),
    JOB_CANCEL_REQUESTED("media.job.cancel_requested", false),
    STREAM_OPENED("media.stream.opened", false),
    STREAM_CLOSED("media.stream.closed", false),
    JOB_COMPLETED("media.job.completed", true),
    JOB_FAILED("media.job.failed", true);

    private final String wireName;
    private final boolean terminalReadbackRequired;

    MediaLifecycleEventType(String wireName, boolean terminalReadbackRequired) {
        this.wireName = wireName;
        this.terminalReadbackRequired = terminalReadbackRequired;
    }

    public String wireName() { return wireName; }
    public boolean terminalReadbackRequired() { return terminalReadbackRequired; }

    public static MediaLifecycleEventType fromWireName(String value) {
        return Arrays.stream(values()).filter(type -> type.wireName.equals(value)).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Unsupported Media lifecycle event type"));
    }
}
