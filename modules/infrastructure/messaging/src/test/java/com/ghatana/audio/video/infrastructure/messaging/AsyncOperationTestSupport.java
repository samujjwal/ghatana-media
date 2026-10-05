package com.ghatana.audio.video.infrastructure.messaging;

import com.ghatana.core.async.AsyncOperation;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;

final class AsyncOperationTestSupport {

    private AsyncOperationTestSupport() {
    }

    static <T> T await(AsyncOperation<T> operation) {
        try {
            return future(operation).get(5, TimeUnit.SECONDS);
        } catch (Exception failure) {
            throw new AssertionError("Async operation did not complete successfully", failure);
        }
    }

    static Throwable awaitFailure(AsyncOperation<?> operation) {
        try {
            future(operation).get(5, TimeUnit.SECONDS);
            throw new AssertionError("Expected async operation to fail");
        } catch (ExecutionException expected) {
            return expected.getCause();
        } catch (Exception failure) {
            throw new AssertionError("Async operation did not expose its failure", failure);
        }
    }

    private static <T> CompletableFuture<T> future(AsyncOperation<T> operation) {
        CompletableFuture<T> future = new CompletableFuture<>();
        operation.whenComplete((value, error) -> {
            if (error == null) {
                future.complete(value);
            } else {
                future.completeExceptionally(error);
            }
        });
        return future;
    }
}
