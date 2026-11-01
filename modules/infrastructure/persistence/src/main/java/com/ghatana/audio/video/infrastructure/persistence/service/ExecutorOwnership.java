package com.ghatana.audio.video.infrastructure.persistence.service;

/** Defines which component is responsible for shutting down an injected executor. */
public enum ExecutorOwnership {
    /** The persistence service shuts the executor down when it is closed. */
    SERVICE,
    /** The caller retains the executor and may share it with other services. */
    CALLER
}
