/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.media.resilience;

import com.ghatana.core.async.AsyncOperation;
import com.ghatana.resilience.CircuitBreaker;
import io.activej.promise.Promise;
import io.activej.promise.SettablePromise;

import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;

/**
 * Bridges the media modules' ActiveJ promise API to the platform circuit-breaker port.
 *
 * @doc.type class
 * @doc.purpose Preserve the platform-neutral circuit-breaker boundary for ActiveJ callers
 * @doc.layer product
 * @doc.pattern Adapter
 */
final class CircuitBreakerPromiseAdapter {

    private CircuitBreakerPromiseAdapter() {
    }

    static <T> Promise<T> execute(
            CircuitBreaker circuitBreaker,
            Supplier<Promise<T>> operation,
            Supplier<T> fallback) {
        SettablePromise<T> result = new SettablePromise<>();
        circuitBreaker.execute(() -> {
            CompletableFuture<T> future = new CompletableFuture<>();
            operation.get().whenComplete((value, error) -> {
                if (error == null) {
                    future.complete(value);
                } else {
                    future.completeExceptionally(error);
                }
            });
            return AsyncOperation.from(future);
        }, fallback).whenComplete((value, error) -> {
            if (error == null) {
                result.set(value);
            } else {
                result.setException(error instanceof Exception exception
                        ? exception
                        : new java.util.concurrent.CompletionException(error));
            }
        });
        return result;
    }
}
