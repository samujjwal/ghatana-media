package com.ghatana.audio.video.infrastructure.persistence.service;

import com.ghatana.audio.video.infrastructure.persistence.entity.TranscriptionEntity;
import com.ghatana.audio.video.infrastructure.persistence.repository.TranscriptionRepository;
import com.ghatana.testing.activej.EventloopTestBase;
import io.activej.promise.Promise;
import org.junit.jupiter.api.Test;

import java.util.UUID;
import java.util.List;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class TranscriptionServiceLifecycleTest extends EventloopTestBase {

    @Test
    void repeatedServiceCreateAndCloseTerminatesOwnedDatabaseWorkers() throws InterruptedException {
        TranscriptionRepository repository = mock(TranscriptionRepository.class);
        when(repository.countByTenantId("tenant")).thenReturn(9L);

        for (int iteration = 0; iteration < 12; iteration++) {
            RejectFirstExecutorService executor = new RejectFirstExecutorService();
            TranscriptionService service = new TranscriptionService(repository, eventloop(), executor,
                ExecutorOwnership.SERVICE);
            AtomicReference<Exception> firstFailure = new AtomicReference<>();
            Boolean failed = runPromise(() -> service.countByTenantId("tenant")
                .map((result, failure) -> {
                    firstFailure.set(failure);
                    return Boolean.TRUE;
                }));

            assertThat(failed).isTrue();
            assertThat(firstFailure.get()).isInstanceOf(RejectedExecutionException.class);
            assertThat(runPromise(() -> service.countByTenantId("tenant"))).isEqualTo(9L);
            service.close();
            assertThat(executor.isShutdown()).isTrue();
            assertThat(executor.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
        }
    }

    @Test
    void injectedUnboundedExecutorCannotExceedDatabaseConcurrencyLimit() throws InterruptedException {
        TranscriptionRepository repository = mock(TranscriptionRepository.class);
        int operationCount = PersistenceExecutors.MAX_CONCURRENT_DATABASE_OPERATIONS * 2;
        CountDownLatch firstWaveEntered = new CountDownLatch(PersistenceExecutors.MAX_CONCURRENT_DATABASE_OPERATIONS);
        CountDownLatch releaseOperations = new CountDownLatch(1);
        CountDownLatch operationsFinished = new CountDownLatch(operationCount);
        AtomicInteger active = new AtomicInteger();
        AtomicInteger maximumActive = new AtomicInteger();
        when(repository.countByTenantId("tenant")).thenAnswer(invocation -> {
            int current = active.incrementAndGet();
            maximumActive.accumulateAndGet(current, Math::max);
            firstWaveEntered.countDown();
            try {
                if (!releaseOperations.await(3, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("test did not release blocked repository calls");
                }
                return 1L;
            } finally {
                active.decrementAndGet();
                operationsFinished.countDown();
            }
        });

        ExecutorService executor = Executors.newCachedThreadPool();
        TranscriptionService service = new TranscriptionService(repository, eventloop(), executor,
            ExecutorOwnership.SERVICE);
        AtomicInteger maximumBeforeRelease = new AtomicInteger();
        Thread releaseThread = new Thread(() -> {
            try {
                if (!firstWaveEntered.await(2, TimeUnit.SECONDS)) {
                    return;
                }
                Thread.sleep(100);
                maximumBeforeRelease.set(maximumActive.get());
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            } finally {
                releaseOperations.countDown();
            }
        }, "persistence-concurrency-test-release");
        releaseThread.start();

        try {
            Long lastResult = runPromise(() -> {
                Promise<Long> last = null;
                for (int index = 0; index < operationCount; index++) {
                    last = service.countByTenantId("tenant");
                }
                return last;
            });

            assertThat(lastResult).isEqualTo(1L);
            assertThat(operationsFinished.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(maximumBeforeRelease.get())
                .isEqualTo(PersistenceExecutors.MAX_CONCURRENT_DATABASE_OPERATIONS);
            assertThat(maximumActive.get())
                .isLessThanOrEqualTo(PersistenceExecutors.MAX_CONCURRENT_DATABASE_OPERATIONS);
        } finally {
            releaseOperations.countDown();
            releaseThread.join(2_000);
            service.close();
            assertThat(executor.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
        }
    }

    @Test
    void cachedExecutorBurstStagesWorkWithoutProvisioningOneThreadPerOperation() throws InterruptedException {
        TranscriptionRepository repository = mock(TranscriptionRepository.class);
        int acceptedCount = PersistenceExecutors.MAX_OUTSTANDING_OPERATIONS;
        CountDownLatch firstWaveEntered = new CountDownLatch(PersistenceExecutors.MAX_CONCURRENT_DATABASE_OPERATIONS);
        CountDownLatch releaseOperations = new CountDownLatch(1);
        AtomicInteger active = new AtomicInteger();
        AtomicInteger maximumActive = new AtomicInteger();
        AtomicInteger terminalCount = new AtomicInteger();
        AtomicInteger successCount = new AtomicInteger();
        AtomicReference<Exception> overflowFailure = new AtomicReference<>();
        when(repository.countByTenantId("tenant")).thenAnswer(invocation -> {
            int current = active.incrementAndGet();
            maximumActive.accumulateAndGet(current, Math::max);
            firstWaveEntered.countDown();
            try {
                if (!releaseOperations.await(5, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("test did not release blocked repository calls");
                }
                return 1L;
            } finally {
                active.decrementAndGet();
            }
        });

        ThreadPoolExecutor executor = (ThreadPoolExecutor) Executors.newCachedThreadPool();
        TranscriptionService service = new TranscriptionService(repository, eventloop(), executor,
            ExecutorOwnership.SERVICE);
        AtomicInteger workerCountBeforeRelease = new AtomicInteger();
        Thread releaseThread = new Thread(() -> {
            try {
                if (!firstWaveEntered.await(3, TimeUnit.SECONDS)) return;
                Thread.sleep(100);
                workerCountBeforeRelease.set(executor.getLargestPoolSize());
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            } finally {
                releaseOperations.countDown();
            }
        }, "persistence-cached-burst-release");
        releaseThread.start();

        try {
            Long lastResult = runPromise(() -> {
                Promise<Long> last = null;
                for (int index = 0; index < acceptedCount; index++) {
                    last = service.countByTenantId("tenant").whenComplete((value, failure) -> {
                        terminalCount.incrementAndGet();
                        if (failure == null) successCount.incrementAndGet();
                    });
                }
                service.countByTenantId("tenant").whenException(overflowFailure::set);
                return last;
            });

            assertThat(lastResult).isEqualTo(1L);
            assertThat(terminalCount).hasValue(acceptedCount);
            assertThat(successCount).hasValue(acceptedCount);
            assertThat(overflowFailure.get()).isInstanceOf(RejectedExecutionException.class);
            assertThat(workerCountBeforeRelease.get())
                .isLessThanOrEqualTo(PersistenceExecutors.MAX_CONCURRENT_DATABASE_OPERATIONS);
            assertThat(maximumActive.get())
                .isEqualTo(PersistenceExecutors.MAX_CONCURRENT_DATABASE_OPERATIONS);
        } finally {
            releaseOperations.countDown();
            releaseThread.join(2_000);
            service.close();
            assertThat(executor.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
        }
    }

    @Test
    void closeIsNonBlockingAndDrainsAcceptedPromisesWhileSaturatedSubmissionFailsAsPromise() {
        TranscriptionRepository repository = mock(TranscriptionRepository.class);
        CountDownLatch firstCallEntered = new CountDownLatch(1);
        CountDownLatch releaseFirstCall = new CountDownLatch(1);
        AtomicInteger calls = new AtomicInteger();
        AtomicReference<Thread> repositoryThread = new AtomicReference<>();
        when(repository.save(anyString(), any())).thenAnswer(invocation -> {
            repositoryThread.compareAndSet(null, Thread.currentThread());
            if (calls.getAndIncrement() == 0) {
                firstCallEntered.countDown();
                try {
                    if (!releaseFirstCall.await(3, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("test did not release blocked repository call");
                    }
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(interrupted);
                }
            }
            return invocation.getArgument(1);
        });
        ThreadPoolExecutor executor = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<>(1), new ThreadPoolExecutor.AbortPolicy());
        TranscriptionService service = new TranscriptionService(repository, eventloop(), executor,
            ExecutorOwnership.SERVICE);
        AtomicReference<Thread> eventloopThread = new AtomicReference<>();
        AtomicReference<TranscriptionEntity> firstResult = new AtomicReference<>();
        AtomicReference<Exception> rejectedFailure = new AtomicReference<>();

        try {
            TranscriptionEntity second = entity();
            TranscriptionEntity result = runPromise(() -> {
                eventloopThread.set(Thread.currentThread());
                service.save("tenant", entity()).whenResult(firstResult::set);
                assertThat(firstCallEntered.await(2, TimeUnit.SECONDS)).isTrue();
                Promise<TranscriptionEntity> acceptedQueuedPromise = service.save("tenant", second);
                service.save("tenant", entity()).whenException(rejectedFailure::set);

                long closeStarted = System.nanoTime();
                service.close();
                long closeMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - closeStarted);
                assertThat(closeMillis).isLessThan(1_000);

                releaseFirstCall.countDown();
                return acceptedQueuedPromise;
            });

            assertThat(result).isSameAs(second);
            assertThat(firstResult.get()).isNotNull();
            assertThat(repositoryThread.get()).isNotSameAs(eventloopThread.get());
            assertThat(rejectedFailure.get()).isInstanceOf(RejectedExecutionException.class);
            assertThat(executor.isShutdown()).isTrue();
            assertThat(executor.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError(interrupted);
        } finally {
            releaseFirstCall.countDown();
            service.close();
            executor.shutdownNow();
        }
    }

    @Test
    void unboundedInjectedExecutorCannotQueueMoreThanTheDatabaseAdmissionLimit() {
        TranscriptionRepository repository = mock(TranscriptionRepository.class);
        CountDownLatch firstCallEntered = new CountDownLatch(1);
        CountDownLatch releaseFirstCall = new CountDownLatch(1);
        AtomicInteger calls = new AtomicInteger();
        when(repository.countByTenantId("tenant")).thenAnswer(invocation -> {
            int call = calls.incrementAndGet();
            if (call == 1) {
                firstCallEntered.countDown();
                try {
                    if (!releaseFirstCall.await(3, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("test did not release blocked repository call");
                    }
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(interrupted);
                }
            }
            return (long) call;
        });
        ExecutorService executor = Executors.newSingleThreadExecutor();
        TranscriptionService service = new TranscriptionService(repository, eventloop(), executor);
        AtomicReference<Exception> saturatedFailure = new AtomicReference<>();

        try {
            Long lastAccepted = runPromise(() -> {
                service.countByTenantId("tenant");
                assertThat(firstCallEntered.await(2, TimeUnit.SECONDS)).isTrue();

                Promise<Long> finalAccepted = null;
                for (int index = 1; index < PersistenceExecutors.MAX_OUTSTANDING_OPERATIONS; index++) {
                    finalAccepted = service.countByTenantId("tenant");
                }
                service.countByTenantId("tenant").whenException(saturatedFailure::set);
                releaseFirstCall.countDown();
                return finalAccepted;
            });

            assertThat(lastAccepted).isEqualTo(PersistenceExecutors.MAX_OUTSTANDING_OPERATIONS);
            assertThat(saturatedFailure.get()).isInstanceOf(RejectedExecutionException.class);
            assertThat(calls.get()).isEqualTo(PersistenceExecutors.MAX_OUTSTANDING_OPERATIONS);
        } finally {
            releaseFirstCall.countDown();
            service.close();
            assertThat(executor.isShutdown()).isFalse();
            executor.shutdownNow();
        }
    }

    @Test
    void inlineExecutorFailsBeforeRepositoryInvocationOnEventloop() {
        TranscriptionRepository repository = mock(TranscriptionRepository.class);
        InlineExecutorService executor = new InlineExecutorService();
        TranscriptionService service = new TranscriptionService(repository, eventloop(), executor);
        AtomicReference<Exception> operationFailure = new AtomicReference<>();

        try {
            Boolean completed = runPromise(() -> {
                Promise<Boolean> lastOperation = null;
                for (int index = 0; index <= PersistenceExecutors.MAX_OUTSTANDING_OPERATIONS; index++) {
                    lastOperation = service.countByTenantId("tenant")
                        .map((result, failure) -> {
                            operationFailure.set(failure);
                            return Boolean.TRUE;
                        });
                }
                return lastOperation;
            });

            assertThat(completed).isTrue();
            assertThat(operationFailure.get()).isInstanceOf(Exception.class)
                .hasMessageContaining("cannot run on the ActiveJ eventloop");
            verify(repository, never()).countByTenantId("tenant");
        } finally {
            service.close();
            assertThat(executor.isShutdown()).isFalse();
        }
    }

    @Test
    void executorRejectionReleasesAdmissionForTheNextOperation() throws InterruptedException {
        TranscriptionRepository repository = mock(TranscriptionRepository.class);
        when(repository.countByTenantId("tenant")).thenReturn(12L);
        RejectFirstExecutorService executor = new RejectFirstExecutorService();
        TranscriptionService service = new TranscriptionService(repository, eventloop(), executor);
        AtomicReference<Exception> firstFailure = new AtomicReference<>();

        try {
            Boolean firstCompleted = runPromise(() -> service.countByTenantId("tenant")
                .map((result, failure) -> {
                    firstFailure.set(failure);
                    return Boolean.TRUE;
                }));
            Long secondResult = runPromise(() -> service.countByTenantId("tenant"));

            assertThat(firstCompleted).isTrue();
            assertThat(firstFailure.get()).isInstanceOf(RejectedExecutionException.class);
            assertThat(secondResult).isEqualTo(12L);
        } finally {
            service.close();
            assertThat(executor.isShutdown()).isFalse();
            executor.shutdownNow();
            assertThat(executor.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
        }
    }

    @Test
    void supplierFailureReleasesAdmissionForTheNextOperation() {
        ExecutorService executor = Executors.newSingleThreadExecutor();
        PersistenceOperations operations = new PersistenceOperations(eventloop(), executor);
        AtomicReference<Exception> firstFailure = new AtomicReference<>();

        try {
            Boolean firstCompleted = runPromise(() -> operations.submit(() -> {
                throw new Exception("database operation failed");
            })
                .map((result, failure) -> {
                    firstFailure.set(failure);
                    return Boolean.TRUE;
                }));
            Long secondResult = runPromise(() -> operations.submit(() -> 23L));

            assertThat(firstCompleted).isTrue();
            assertThat(firstFailure.get()).hasMessageContaining("database operation failed");
            assertThat(secondResult).isEqualTo(23L);
        } finally {
            executor.shutdownNow();
        }
    }

    private static TranscriptionEntity entity() {
        return new TranscriptionEntity(UUID.randomUUID(), "tenant", UUID.randomUUID(), UUID.randomUUID(),
            "transcript", "en");
    }

    private static void awaitNoDatabaseWorkers(String prefix) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        while (System.nanoTime() < deadline) {
            boolean workerAlive = Thread.getAllStackTraces().keySet().stream()
                .anyMatch(thread -> thread.isAlive() && thread.getName().startsWith(prefix));
            if (!workerAlive) return;
            try {
                Thread.sleep(10);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new AssertionError("interrupted while waiting for persistence worker shutdown", interrupted);
            }
        }
        assertThat(Thread.getAllStackTraces().keySet())
            .filteredOn(thread -> thread.isAlive() && thread.getName().startsWith(prefix))
            .as("owned persistence workers should terminate after close drains accepted work")
            .isEmpty();
    }

    private static final class InlineExecutorService extends AbstractExecutorService {
        private boolean shutdown;

        @Override
        public void shutdown() {
            shutdown = true;
        }

        @Override
        public List<Runnable> shutdownNow() {
            shutdown = true;
            return List.of();
        }

        @Override
        public boolean isShutdown() {
            return shutdown;
        }

        @Override
        public boolean isTerminated() {
            return shutdown;
        }

        @Override
        public boolean awaitTermination(long timeout, TimeUnit unit) {
            return shutdown;
        }

        @Override
        public void execute(Runnable command) {
            if (shutdown) {
                throw new RejectedExecutionException("executor is shut down");
            }
            command.run();
        }
    }

    private static final class RejectFirstExecutorService extends AbstractExecutorService {
        private final ThreadPoolExecutor delegate = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<>(1), new ThreadPoolExecutor.AbortPolicy());
        private final AtomicBoolean rejectFirst = new AtomicBoolean(true);

        @Override
        public void shutdown() {
            delegate.shutdown();
        }

        @Override
        public List<Runnable> shutdownNow() {
            return delegate.shutdownNow();
        }

        @Override
        public boolean isShutdown() {
            return delegate.isShutdown();
        }

        @Override
        public boolean isTerminated() {
            return delegate.isTerminated();
        }

        @Override
        public boolean awaitTermination(long timeout, TimeUnit unit) throws InterruptedException {
            return delegate.awaitTermination(timeout, unit);
        }

        @Override
        public void execute(Runnable command) {
            if (rejectFirst.compareAndSet(true, false)) {
                throw new RejectedExecutionException("intentional first submission rejection");
            }
            delegate.execute(command);
        }
    }
}
