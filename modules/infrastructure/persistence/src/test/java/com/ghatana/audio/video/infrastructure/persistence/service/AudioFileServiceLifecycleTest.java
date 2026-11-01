package com.ghatana.audio.video.infrastructure.persistence.service;

import com.ghatana.audio.video.infrastructure.persistence.entity.AudioFileEntity;
import com.ghatana.audio.video.infrastructure.persistence.repository.AudioFileRepository;
import com.ghatana.testing.activej.EventloopTestBase;
import io.activej.eventloop.Eventloop;
import io.activej.promise.Promise;
import org.junit.jupiter.api.Test;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class AudioFileServiceLifecycleTest extends EventloopTestBase {

    @Test
    void closeIsNonBlockingAndDrainsAcceptedPromisesWhileSaturatedSubmissionFailsAsPromise() {
        AudioFileRepository repository = mock(AudioFileRepository.class);
        CountDownLatch firstCallEntered = new CountDownLatch(1);
        CountDownLatch releaseFirstCall = new CountDownLatch(1);
        AtomicInteger calls = new AtomicInteger();
        when(repository.save(anyString(), any())).thenAnswer(invocation -> {
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
        AudioFileService service = new AudioFileService(repository, Eventloop.create(), executor, ExecutorOwnership.SERVICE);
        AtomicReference<AudioFileEntity> firstResult = new AtomicReference<>();
        AtomicReference<Exception> rejectedFailure = new AtomicReference<>();

        try {
            AudioFileEntity second = entity();
            AudioFileEntity result = runPromise(() -> {
                Promise<AudioFileEntity> firstPromise = service.save("tenant", entity())
                    .whenResult(firstResult::set);
                assertThat(firstCallEntered.await(2, TimeUnit.SECONDS)).isTrue();
                Promise<AudioFileEntity> acceptedQueuedPromise = service.save("tenant", second);
                service.save("tenant", entity())
                    .whenException(rejectedFailure::set);

                long closeStarted = System.nanoTime();
                service.close();
                long closeMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - closeStarted);
                assertThat(closeMillis).isLessThan(1_000);

                releaseFirstCall.countDown();
                // The accepted second operation must finish; the third submission is reported through its promise.
                return acceptedQueuedPromise;
            });

            assertThat(result).isSameAs(second);
            assertThat(firstResult.get()).isNotNull();
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

    private static AudioFileEntity entity() {
        return new AudioFileEntity(java.util.UUID.randomUUID(), "tenant", java.util.UUID.randomUUID(),
            "audio.wav", "/tmp/audio.wav", "wav");
    }
}
