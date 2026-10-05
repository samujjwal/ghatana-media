package com.ghatana.audio.video.infrastructure.cache;

import com.ghatana.core.async.AsyncOperation;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

final class AsyncOperationTestSupport {

    private AsyncOperationTestSupport() {
    }

    static <T> T await(AsyncOperation<T> operation) {
        CompletableFuture<T> future = new CompletableFuture<>();
        operation.whenComplete((value, error) -> {
            if (error == null) {
                future.complete(value);
            } else {
                future.completeExceptionally(error);
            }
        });
        try {
            return future.get(5, TimeUnit.SECONDS);
        } catch (Exception failure) {
            throw new AssertionError("Async operation did not complete successfully", failure);
        }
    }
}
