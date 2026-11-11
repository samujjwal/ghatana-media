package com.ghatana.media.runtime;

import java.util.Arrays;

/** Stable public v1 lifecycle event names observed at Media runtime transition sites. */
public enum MediaLifecycleEventType {
    UPLOAD_STARTED("media.upload.started", "upload", false),
    ARTIFACT_COMPLETED("media.artifact.completed", "artifact", false),
    JOB_ACCEPTED("media.job.accepted", "job", false),
    JOB_CANCELLED("media.job.cancelled", "job", true),
    JOB_CANCEL_REQUESTED("media.job.cancel_requested", "job", false),
    STREAM_OPENED("media.stream.opened", "stream", false),
    STREAM_CLOSED("media.stream.closed", "stream", false),
    JOB_COMPLETED("media.job.completed", "job", true),
    JOB_FAILED("media.job.failed", "job", true);

    private final String wireName;
    private final String aggregateType;
    private final boolean terminalReadbackRequired;

    MediaLifecycleEventType(String wireName, String aggregateType, boolean terminalReadbackRequired) {
        this.wireName = wireName;
        this.aggregateType = aggregateType;
        this.terminalReadbackRequired = terminalReadbackRequired;
    }

    public String wireName() { return wireName; }
    public String aggregateType() { return aggregateType; }
    public boolean terminalReadbackRequired() { return terminalReadbackRequired; }

    public static MediaLifecycleEventType fromWireName(String value) {
        return Arrays.stream(values()).filter(type -> type.wireName.equals(value)).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Unsupported Media lifecycle event type"));
    }
}
