package com.ghatana.audio.video.common.resilience;

import org.junit.jupiter.api.Test;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ContextAwareBoundedExecutorTest {

    @Test
    void consumerCannotMutateActiveWorkerOutcome() throws Exception {
        ExecutorService workers = Executors.newSingleThreadExecutor();
        CountDownLatch workerStarted = new CountDownLatch(1);
        CountDownLatch releaseWorker = new CountDownLatch(1);
        AtomicInteger mutationSuppliers = new AtomicInteger();
        var submission = new ContextAwareBoundedExecutor(workers).submit(() -> {
            workerStarted.countDown();
            if (!releaseWorker.await(2, TimeUnit.SECONDS)) {
                throw new IllegalStateException("test did not release active worker");
            }
            return "actual-worker-result";
        });

        try {
            assertThat(workerStarted.await(2, TimeUnit.SECONDS)).isTrue();
            CompletableFuture<String> result = submission.result();
            assertThat(submission.started()).isTrue();
            assertThat(result.isDone()).isFalse();

            assertMutationRejected(() -> result.complete("forged-success"));
            assertMutationRejected(() -> result.completeExceptionally(
                    new IllegalStateException("forged-failure")));
            assertMutationRejected(() -> result.obtrudeValue("obtruded-success"));
            assertMutationRejected(() -> result.obtrudeException(
                    new IllegalStateException("obtruded-failure")));
            assertMutationRejected(() -> result.completeAsync(() -> {
                mutationSuppliers.incrementAndGet();
                return "async-forged-success";
            }));
            assertMutationRejected(() -> result.completeAsync(() -> {
                mutationSuppliers.incrementAndGet();
                return "executor-forged-success";
            }, Runnable::run));
            assertMutationRejected(() -> result.orTimeout(1, TimeUnit.HOURS));
            assertMutationRejected(() -> result.completeOnTimeout("timeout-forged-success",
                    1, TimeUnit.HOURS));

            assertThat(mutationSuppliers).hasValue(0);
            assertThat(result.isDone()).isFalse();
            assertThat(result.isCancelled()).isFalse();

            releaseWorker.countDown();
            assertThat(result.get(2, TimeUnit.SECONDS)).isEqualTo("actual-worker-result");
            assertThat(result.isCancelled()).isFalse();
        } finally {
            releaseWorker.countDown();
            workers.shutdownNow();
            assertThat(workers.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
        }
    }

    private static void assertMutationRejected(Runnable mutation) {
        assertThatThrownBy(() -> mutation.run())
                .isInstanceOf(UnsupportedOperationException.class)
                .hasMessage("Submission result is owned by the executor; observe it or cancel the submission");
    }
}
