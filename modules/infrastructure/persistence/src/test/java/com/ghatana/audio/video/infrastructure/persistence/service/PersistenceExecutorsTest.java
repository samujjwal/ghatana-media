package com.ghatana.audio.video.infrastructure.persistence.service;

import org.junit.jupiter.api.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class PersistenceExecutorsTest {

    @Test
    void databaseExecutorHasBoundedWorkersAndRejectsBeyondItsQueue() throws InterruptedException {
        ThreadPoolExecutor executor = PersistenceExecutors.newDatabaseExecutor("test");
        CountDownLatch workersEntered = new CountDownLatch(executor.getMaximumPoolSize());
        CountDownLatch releaseWorkers = new CountDownLatch(1);
        try {
            assertThat(executor.getMaximumPoolSize()).isBetween(1, 8);
            assertThat(executor.getQueue().remainingCapacity()).isEqualTo(128);

            for (int index = 0; index < executor.getMaximumPoolSize(); index++) {
                executor.execute(() -> {
                    workersEntered.countDown();
                    try {
                        releaseWorkers.await();
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                    }
                });
            }
            assertThat(workersEntered.await(2, TimeUnit.SECONDS)).isTrue();
            for (int index = 0; index < 128; index++) {
                executor.execute(() -> { });
            }
            assertThatThrownBy(() -> executor.execute(() -> { }))
                .isInstanceOf(RejectedExecutionException.class);
        } finally {
            releaseWorkers.countDown();
            executor.shutdownNow();
        }
        assertThat(executor.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
    }
}
