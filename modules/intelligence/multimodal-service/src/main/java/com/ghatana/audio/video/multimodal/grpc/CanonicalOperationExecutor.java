package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.audio.video.multimodal.grpc.proto.CanonicalOperationBinding;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import java.util.concurrent.Callable;

/**
 * Operation boundary used by explicit gRPC test fixtures and the production executor.
 * The typed overload is the production path; the raw {@link Callable} overload remains a
 * same-process fixture seam and is rejected by {@link MediaCanonicalOperationExecutor}.
 */
interface CanonicalOperationExecutor {
    /**
     * Typed production dispatch over a durable, reconstructible operation bound to the
     * verified ingress credential. The default routes through the fixture callable so
     * existing test executors keep working without change.
     */
    default <T> T execute(CanonicalOperationBinding binding, String operationRef,
                          CanonicalOperation<T> operation,
                          AuthenticatedPrincipal authenticated) throws Exception {
        return execute(binding, operationRef, operation.fixtureAction());
    }

    /** Fixture seam: same-process optimization only, never production authority. */
    <T> T execute(CanonicalOperationBinding binding, String operationRef, Callable<T> action) throws Exception;
}
