package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.audio.video.multimodal.grpc.proto.CanonicalOperationBinding;
import java.util.concurrent.Callable;

/** Package-private operation boundary used only by explicit gRPC test fixtures. */
interface CanonicalOperationExecutor {
    <T> T execute(CanonicalOperationBinding binding, String operationRef, Callable<T> action) throws Exception;
}
