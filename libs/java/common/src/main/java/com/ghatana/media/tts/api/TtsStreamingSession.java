package com.ghatana.media.tts.api;

import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Cancellable lifecycle for one streaming synthesis operation.
 *
 * @doc.type interface
 * @doc.purpose Exposes cancellation and terminal completion for streaming TTS
 * @doc.layer platform
 * @doc.pattern Session
 */
public interface TtsStreamingSession extends AutoCloseable {

    boolean cancel();

    boolean isCancelled();

    CompletableFuture<Void> completion();

    @Override
    default void close() {
        cancel();
    }

    static TtsStreamingSession create(
            AtomicBoolean cancelled,
            CompletableFuture<Void> completion) {
        return create(cancelled, completion, () -> {});
    }

    static TtsStreamingSession create(
            AtomicBoolean cancelled,
            CompletableFuture<Void> completion,
            Runnable cancelAction) {
        Objects.requireNonNull(cancelled, "cancelled");
        Objects.requireNonNull(completion, "completion");
        Objects.requireNonNull(cancelAction, "cancelAction");
        return new TtsStreamingSession() {
            @Override
            public boolean cancel() {
                if (!cancelled.compareAndSet(false, true)) return false;
                try {
                    cancelAction.run();
                } finally {
                    completion.cancel(false);
                }
                return true;
            }

            @Override
            public boolean isCancelled() {
                return cancelled.get();
            }

            @Override
            public CompletableFuture<Void> completion() {
                return completion;
            }
        };
    }
}
