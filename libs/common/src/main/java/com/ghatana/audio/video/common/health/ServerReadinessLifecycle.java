package com.ghatana.audio.video.common.health;

import io.grpc.BindableService;

/**
 * gRPC health service lifecycle shared by Media server roots.
 *
 * <p>Implementations must remain not serving until required checks are registered and startup is
 * complete, and must return to not serving before server shutdown begins.
 */
public interface ServerReadinessLifecycle extends BindableService, AutoCloseable {

    /** Mark startup complete when all required readiness checks are registered. */
    boolean markReady();

    /** Move readiness to NOT_SERVING before draining or closing the server. */
    void setNotServing();

    /** Return current provider and modality readiness without disclosing check details. */
    boolean isServing();
}
