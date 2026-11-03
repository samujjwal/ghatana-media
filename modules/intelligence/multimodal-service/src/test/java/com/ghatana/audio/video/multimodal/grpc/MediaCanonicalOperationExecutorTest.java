package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.audio.video.multimodal.grpc.proto.CanonicalOperationBinding;
import com.ghatana.media.runtime.MediaCapabilityNotAdmittedException;
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactContentReadReceipt;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadSession;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.MultimodalOperationSpec;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import io.grpc.Context;
import io.grpc.Deadline;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentLinkedDeque;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Unit coverage of the durable MM operation executor's submit/await/finality split. */
class MediaCanonicalOperationExecutorTest {

    private static final String SHA = "ab".repeat(32);
    private static final AuthenticatedPrincipal AUTH =
            new AuthenticatedPrincipal("tenant-a", "principal-a", Instant.now());
    private static final ScheduledExecutorService DEADLINE_TIMER = Executors.newSingleThreadScheduledExecutor(runnable -> {
        Thread thread = new Thread(runnable, "multimodal-deadline-test");
        thread.setDaemon(true);
        return thread;
    });

    @Test
    void timeoutWinningDispatchGatePreventsLatePortAction() throws Exception {
        var gate = new MediaCanonicalOperationExecutor.PortCallDispatchGate();
        CountDownLatch workerAtDispatchBoundary = new CountDownLatch(1);
        CountDownLatch releaseWorker = new CountDownLatch(1);
        AtomicBoolean actionInvoked = new AtomicBoolean();
        AtomicBoolean dispatchWon = new AtomicBoolean();

        Thread worker = Thread.startVirtualThread(() -> {
            workerAtDispatchBoundary.countDown();
            awaitIgnoringInterrupts(releaseWorker);
            if (gate.tryDispatch()) {
                dispatchWon.set(true);
                actionInvoked.set(true);
            }
        });
        try {
            assertThat(workerAtDispatchBoundary.await(1, TimeUnit.SECONDS)).isTrue();
            // Models the caller observing its deadline while the worker has passed its
            // initial budget check but has not yet crossed the actual effect boundary.
            gate.closeBeforeDispatch();
        } finally {
            releaseWorker.countDown();
            worker.join(1_000);
        }

        assertThat(worker.isAlive()).isFalse();
        assertThat(dispatchWon).isFalse();
        assertThat(actionInvoked).isFalse();
        assertThat(gate.dispatched()).isFalse();
    }

    @Test
    void deadlineBeforeInlineUploadDispatchDoesNotMarkEffectStartedOrCallPort() throws Exception {
        byte[] payload = "deadline-before-upload-dispatch".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        var port = new FixturePort().withSource(Map.of());
        CountDownLatch beforeUploadDispatch = new CountDownLatch(1);
        CountDownLatch releaseUploadDispatch = new CountDownLatch(1);
        CountDownLatch uploadDispatchResumed = new CountDownLatch(1);
        AtomicInteger portCallCount = new AtomicInteger();
        ThreadPoolExecutor workers = new ThreadPoolExecutor(
                1, 1, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(1));
        var executor = new MediaCanonicalOperationExecutor(
                port, Duration.ofMillis(180), Duration.ofMillis(5), workers, () -> {
                    if (portCallCount.incrementAndGet() == 2) {
                        beforeUploadDispatch.countDown();
                        awaitIgnoringInterrupts(releaseUploadDispatch);
                        uploadDispatchResumed.countDown();
                    }
                });
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread execution = Thread.startVirtualThread(() -> {
            try {
                executor.execute(binding(), "op", inlineOperation(payload), AUTH);
            } catch (Throwable thrown) {
                failure.set(thrown);
            }
        });

        try {
            assertThat(beforeUploadDispatch.await(1, TimeUnit.SECONDS)).isTrue();
            execution.join(1_000);
            assertThat(execution.isAlive()).isFalse();
            assertThat(failure.get()).isInstanceOf(CanonicalOperationDeadlineExceededException.class);
        } finally {
            releaseUploadDispatch.countDown();
            execution.join(1_000);
            workers.shutdownNow();
        }

        assertThat(uploadDispatchResumed.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(port.uploads).isEmpty();
        assertThat(port.submitted).isEmpty();
    }

    @Test
    void completedParentFusesAndSpecBindsArtifactDeclaredSourceClock() throws Exception {
        var port = new FixturePort().withSource(clockMetadata())
                .thenStatuses(JobStatus.RUNNING, JobStatus.COMPLETED);
        var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
        CanonicalOperation<CanonicalOperationOutcome> operation = operation();

        CanonicalOperationOutcome outcome = executor.execute(
                binding(), "op", operation, AUTH);

        assertThat(outcome.status()).isEqualTo(JobStatus.COMPLETED);
        ProcessingJobRequest submitted = port.submitted.peek();
        assertThat(submitted.jobType()).isEqualTo(JobType.MULTIMODAL);
        MultimodalOperationSpec spec = MultimodalOperationSpec.from(submitted);
        MultimodalOperationSpec.SourceClockBinding clock = spec.sourceClock();
        assertThat(clock).isNotNull();
        assertThat(clock.clockId()).isEqualTo("src-clock");
        assertThat(clock.evidenceRef()).isEqualTo("ev-1");
        assertThat(clock.ticksPerSecond()).isEqualTo(48_000);
        assertThat(clock.durationTicks()).isEqualTo(96_000);
        assertThat(spec.children()).hasSize(1);
    }

    @Test
    void parentStillRunningAtDeadlineThrowsUnknownCarryingJobId() {
        var port = new FixturePort().withSource(Map.of())
                .thenStatuses(JobStatus.RUNNING);
        var executor = executor(port, Duration.ofMillis(40), Duration.ofMillis(5));
        assertThatThrownBy(() -> executor.execute(binding(), "op", operation(), AUTH))
                .isInstanceOf(CanonicalOperationUnknownException.class)
                .satisfies(error -> assertThat(
                        ((CanonicalOperationUnknownException) error).jobId()).isEqualTo("job-1"));
    }

    @Test
    void callerDeadlineAfterSubmitReturnsUnknownWithJobIdInsteadOfLateSuccess() {
        var port = new FixturePort().withSource(Map.of()).thenStatuses(JobStatus.RUNNING);
        var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
        Context request = Context.current().withDeadline(Deadline.after(150, TimeUnit.MILLISECONDS), DEADLINE_TIMER);
        Context previous = request.attach();
        try {
            assertThatThrownBy(() -> executor.execute(binding(), "op", operation(), AUTH))
                    .isInstanceOf(CanonicalOperationUnknownException.class)
                    .satisfies(error -> assertThat(
                            ((CanonicalOperationUnknownException) error).jobId()).isEqualTo("job-1"));
            assertThat(port.submitted).hasSize(1);
        } finally {
            request.detach(previous);
        }
    }

    @Test
    void blockedSourceReadStopsAtOperationDeadlineAndCannotContinueToSubmit() throws Exception {
        CountDownLatch readStarted = new CountDownLatch(1);
        CountDownLatch releaseRead = new CountDownLatch(1);
        CountDownLatch readReturned = new CountDownLatch(1);
        AtomicBoolean fused = new AtomicBoolean();
        FixturePort port = new FixturePort() {
            @Override public Optional<MediaArtifact> artifact(String tenantId, String principalId, String artifactId) {
                if ("src".equals(artifactId)) {
                    readStarted.countDown();
                    awaitIgnoringInterrupts(releaseRead);
                    readReturned.countDown();
                }
                return super.artifact(tenantId, principalId, artifactId);
            }
        };
        port.withSource(Map.of());
        var executor = executor(port, Duration.ofMillis(100), Duration.ofMillis(5));
        CanonicalOperation<CanonicalOperationOutcome> operation = CanonicalOperations.of(
                CanonicalOperations.plan("cap", List.of(
                        CanonicalOperations.childArtifact("stt", JobType.SPEECH_TO_TEXT, "child-art"))),
                () -> null, outcome -> { fused.set(true); return outcome; });

        try {
            assertThatThrownBy(() -> executor.execute(binding(), "op", operation, AUTH))
                    .isInstanceOf(io.grpc.StatusRuntimeException.class)
                    .satisfies(failure -> assertThat(io.grpc.Status.fromThrowable((Throwable) failure).getCode())
                            .isEqualTo(io.grpc.Status.Code.DEADLINE_EXCEEDED));
            assertThat(readStarted.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(port.submitted).isEmpty();
        } finally {
            releaseRead.countDown();
        }
        assertThat(readReturned.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(port.submitted).isEmpty();
        assertThat(fused).isFalse();
    }

    @Test
    void expiredCallerDeadlineRejectsBeforeSourceReadOrSubmit() {
        var port = new FixturePort().withSource(Map.of());
        var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
        Context.CancellableContext request = Context.current()
                .withDeadline(Deadline.after(-1, TimeUnit.MILLISECONDS), DEADLINE_TIMER);
        Context previous = request.attach();
        try {
            assertThatThrownBy(() -> executor.execute(binding(), "op", operation(), AUTH))
                    .isInstanceOf(io.grpc.StatusRuntimeException.class)
                    .satisfies(failure -> assertThat(io.grpc.Status.fromThrowable((Throwable) failure).getCode())
                            .isEqualTo(io.grpc.Status.Code.DEADLINE_EXCEEDED));
            assertThat(port.artifactReads.get()).isZero();
            assertThat(port.submitted).isEmpty();
        } finally {
            request.detach(previous);
            request.cancel(null);
        }
    }

    @Test
    void blockedSubmitTimesOutUnknownAndLateJobReturnCannotFuseSuccess() throws Exception {
        CountDownLatch submitStarted = new CountDownLatch(1);
        CountDownLatch releaseSubmit = new CountDownLatch(1);
        CountDownLatch submitReturned = new CountDownLatch(1);
        AtomicBoolean fused = new AtomicBoolean();
        FixturePort port = new FixturePort() {
            @Override public ProcessingJob submit(
                    ProcessingJobRequest request, AuthenticatedPrincipal authenticated) {
                submitStarted.countDown();
                awaitIgnoringInterrupts(releaseSubmit);
                ProcessingJob job = super.submit(request, authenticated);
                submitReturned.countDown();
                return job;
            }
        };
        port.withSource(Map.of());
        var executor = executor(port, Duration.ofMillis(100), Duration.ofMillis(5));
        CanonicalOperation<CanonicalOperationOutcome> operation = CanonicalOperations.of(
                CanonicalOperations.plan("cap", List.of(
                        CanonicalOperations.childArtifact("stt", JobType.SPEECH_TO_TEXT, "child-art"))),
                () -> null, outcome -> { fused.set(true); return outcome; });

        try {
            assertThatThrownBy(() -> executor.execute(binding(), "op", operation, AUTH))
                    .isInstanceOf(CanonicalOperationUnknownException.class)
                    .satisfies(failure -> assertThat(
                            ((CanonicalOperationUnknownException) failure).jobId()).isNull());
            assertThat(submitStarted.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(port.submitted).isEmpty();
        } finally {
            releaseSubmit.countDown();
        }
        assertThat(submitReturned.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(port.submitted).hasSize(1);
        assertThat(fused).isFalse();
    }

    @Test
    void startedInlineUploadTimeoutIsUnknownAndDoesNotContinueWithLateSession() throws Exception {
        byte[] payload = "pcm-fixture".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        CountDownLatch uploadStarted = new CountDownLatch(1);
        CountDownLatch releaseUpload = new CountDownLatch(1);
        CountDownLatch uploadReturned = new CountDownLatch(1);
        FixturePort port = new FixturePort() {
            @Override public UploadSession beginUpload(
                    UploadRequest request, String idempotencyKey, AuthenticatedPrincipal authenticated) {
                uploadStarted.countDown();
                awaitIgnoringInterrupts(releaseUpload);
                UploadSession session = super.beginUpload(request, idempotencyKey, authenticated);
                uploadReturned.countDown();
                return session;
            }
        };
        port.withSource(Map.of());
        var executor = executor(port, Duration.ofMillis(100), Duration.ofMillis(5));

        try {
            assertThatThrownBy(() -> executor.execute(binding(), "op", inlineOperation(payload), AUTH))
                    .isInstanceOf(CanonicalOperationUnknownException.class)
                    .satisfies(failure -> assertThat(
                            ((CanonicalOperationUnknownException) failure).jobId()).isNull());
            assertThat(uploadStarted.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(port.submitted).isEmpty();
        } finally {
            releaseUpload.countDown();
        }
        assertThat(uploadReturned.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(port.submitted).isEmpty();
    }

    @Test
    void boundedPortQueueRejectsExcessCallersAsResourceExhausted() throws Exception {
        CountDownLatch firstReadStarted = new CountDownLatch(1);
        CountDownLatch releaseFirstRead = new CountDownLatch(1);
        AtomicInteger sourceCalls = new AtomicInteger();
        FixturePort port = new FixturePort() {
            @Override public Optional<MediaArtifact> artifact(String tenantId, String principalId, String artifactId) {
                if ("src".equals(artifactId) && sourceCalls.incrementAndGet() == 1) {
                    firstReadStarted.countDown();
                    awaitIgnoringInterrupts(releaseFirstRead);
                }
                return super.artifact(tenantId, principalId, artifactId);
            }
        };
        port.withSource(Map.of());
        ThreadPoolExecutor boundedWorkers = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(1), runnable -> {
                    Thread thread = new Thread(runnable, "multimodal-port-saturation-test");
                    thread.setDaemon(true);
                    return thread;
                }, new ThreadPoolExecutor.AbortPolicy());
        var executor = new MediaCanonicalOperationExecutor(
                port, Duration.ofSeconds(3), Duration.ofMillis(5), boundedWorkers);
        CanonicalOperationBinding staleBinding = binding().toBuilder()
                .setSourceVersionId("sha256:" + "cd".repeat(32)).build();
        AtomicReference<Throwable> firstFailure = new AtomicReference<>();
        AtomicReference<Throwable> secondFailure = new AtomicReference<>();
        Thread first = startExecution(executor, staleBinding, firstFailure);
        Thread second = null;
        try {
            assertThat(firstReadStarted.await(1, TimeUnit.SECONDS)).isTrue();
            second = startExecution(executor, staleBinding, secondFailure);
            long queueDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
            while (boundedWorkers.getQueue().size() != 1 && System.nanoTime() < queueDeadline) {
                Thread.onSpinWait();
            }
            assertThat(boundedWorkers.getQueue()).hasSize(1);

            assertThatThrownBy(() -> executor.execute(staleBinding, "op", operation(), AUTH))
                    .isInstanceOf(io.grpc.StatusRuntimeException.class)
                    .satisfies(failure -> assertThat(io.grpc.Status.fromThrowable((Throwable) failure).getCode())
                            .isEqualTo(io.grpc.Status.Code.RESOURCE_EXHAUSTED));
        } finally {
            releaseFirstRead.countDown();
            first.join(1_000);
            if (second != null) second.join(1_000);
            boundedWorkers.shutdownNow();
        }
        assertThat(first.isAlive()).isFalse();
        assertThat(second).isNotNull();
        assertThat(second.isAlive()).isFalse();
        assertThat(firstFailure.get()).isInstanceOf(IllegalArgumentException.class);
        assertThat(secondFailure.get()).isInstanceOf(IllegalArgumentException.class);
        assertThat(port.submitted).isEmpty();
    }

    @Test
    void contextCancellationInterruptsStartedSubmitAndReturnsUnknown() throws Exception {
        CountDownLatch submitStarted = new CountDownLatch(1);
        CountDownLatch releaseSubmit = new CountDownLatch(1);
        CountDownLatch submitReturned = new CountDownLatch(1);
        AtomicBoolean fused = new AtomicBoolean();
        FixturePort port = new FixturePort() {
            @Override public ProcessingJob submit(
                    ProcessingJobRequest request, AuthenticatedPrincipal authenticated) {
                submitStarted.countDown();
                awaitIgnoringInterrupts(releaseSubmit);
                ProcessingJob job = super.submit(request, authenticated);
                submitReturned.countDown();
                return job;
            }
        };
        port.withSource(Map.of());
        var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
        CanonicalOperation<CanonicalOperationOutcome> operation = CanonicalOperations.of(
                CanonicalOperations.plan("cap", List.of(
                        CanonicalOperations.childArtifact("stt", JobType.SPEECH_TO_TEXT, "child-art"))),
                () -> null, outcome -> { fused.set(true); return outcome; });
        Context.CancellableContext request = Context.current().withCancellation();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread caller = Thread.startVirtualThread(() -> {
            Context previous = request.attach();
            try {
                executor.execute(binding(), "op", operation, AUTH);
            } catch (Throwable thrown) {
                failure.set(thrown);
            } finally {
                request.detach(previous);
            }
        });
        try {
            assertThat(submitStarted.await(1, TimeUnit.SECONDS)).isTrue();
            request.cancel(null);
            caller.join(1_000);
            assertThat(caller.isAlive()).isFalse();
            assertThat(failure.get()).isInstanceOf(CanonicalOperationUnknownException.class)
                    .satisfies(thrown -> assertThat(
                            ((CanonicalOperationUnknownException) thrown).jobId()).isNull());
        } finally {
            releaseSubmit.countDown();
            caller.join(1_000);
            request.cancel(null);
        }
        assertThat(submitReturned.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(port.submitted).hasSize(1);
        assertThat(fused).isFalse();
    }

    @Test
    void cancelledQueuedReadIsRemovedImmediatelyAndReturnsCancelledWithoutDispatch() throws Exception {
        CountDownLatch firstReadStarted = new CountDownLatch(1);
        CountDownLatch releaseFirstRead = new CountDownLatch(1);
        AtomicInteger sourceReads = new AtomicInteger();
        FixturePort port = new FixturePort() {
            @Override public Optional<MediaArtifact> artifact(String tenantId, String principalId, String artifactId) {
                if ("src".equals(artifactId)) {
                    sourceReads.incrementAndGet();
                    firstReadStarted.countDown();
                    awaitIgnoringInterrupts(releaseFirstRead);
                }
                return super.artifact(tenantId, principalId, artifactId);
            }
        };
        port.withSource(Map.of());
        ThreadPoolExecutor workers = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(1), runnable -> {
                    Thread thread = new Thread(runnable, "multimodal-cancel-queue-test");
                    thread.setDaemon(true);
                    return thread;
                }, new ThreadPoolExecutor.AbortPolicy());
        var executor = new MediaCanonicalOperationExecutor(
                port, Duration.ofSeconds(3), Duration.ofMillis(5), workers);
        CanonicalOperationBinding staleBinding = binding().toBuilder()
                .setSourceVersionId("sha256:" + "cd".repeat(32)).build();
        AtomicReference<Throwable> firstFailure = new AtomicReference<>();
        Thread first = startExecution(executor, staleBinding, firstFailure);
        Context.CancellableContext cancelledRequest = Context.current().withCancellation();
        AtomicReference<Throwable> cancelledFailure = new AtomicReference<>();
        Thread queued = null;

        try {
            assertThat(firstReadStarted.await(1, TimeUnit.SECONDS)).isTrue();
            queued = Thread.startVirtualThread(() -> {
                Context previous = cancelledRequest.attach();
                try {
                    executor.execute(staleBinding, "op", operation(), AUTH);
                } catch (Throwable failure) {
                    cancelledFailure.set(failure);
                } finally {
                    cancelledRequest.detach(previous);
                }
            });
            long queueDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
            while (workers.getQueue().size() != 1 && System.nanoTime() < queueDeadline) {
                Thread.onSpinWait();
            }
            assertThat(workers.getQueue()).hasSize(1);

            cancelledRequest.cancel(null);
            queued.join(1_000);
            assertThat(queued.isAlive()).isFalse();
            assertThat(cancelledFailure.get()).isInstanceOf(CanonicalOperationCancelledException.class);
            assertThat(workers.getQueue()).isEmpty();
            assertThat(sourceReads).hasValue(1);
        } finally {
            releaseFirstRead.countDown();
            first.join(1_000);
            if (queued != null) queued.join(1_000);
            workers.shutdownNow();
            cancelledRequest.cancel(null);
        }

        assertThat(first.isAlive()).isFalse();
        assertThat(queued).isNotNull();
        assertThat(workers.getActiveCount()).isZero();
        assertThat(firstFailure.get()).isInstanceOf(IllegalArgumentException.class);
        assertThat(sourceReads).hasValue(1);
        assertThat(port.submitted).isEmpty();
    }

    @Test
    void outcomeUnknownParentThrowsUnknownCarryingJobId() {
        var port = new FixturePort().withSource(Map.of())
                .thenStatuses(JobStatus.OUTCOME_UNKNOWN);
        var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
        assertThatThrownBy(() -> executor.execute(binding(), "op", operation(), AUTH))
                .isInstanceOf(CanonicalOperationUnknownException.class)
                .satisfies(error -> assertThat(
                        ((CanonicalOperationUnknownException) error).jobId()).isEqualTo("job-1"));
    }

    @Test
    void failedParentReachesFusionAsTypedFailedOutcome() {
        var port = new FixturePort().withSource(Map.of())
                .thenStatuses(JobStatus.FAILED);
        var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
        CanonicalOperation<Object> operation = CanonicalOperations.of(
                CanonicalOperations.plan("cap", List.of(
                        CanonicalOperations.childArtifact("stt", JobType.SPEECH_TO_TEXT, "child-art"))),
                () -> null,
                outcome -> CanonicalOperations.toVideoAudioResult(outcome, true, false));
        assertThatThrownBy(() -> executor.execute(binding(), "op", operation, AUTH))
                .isInstanceOf(CanonicalOperationFailedException.class)
                .satisfies(error -> {
                    assertThat(((CanonicalOperationFailedException) error).jobId()).isEqualTo("job-1");
                    assertThat(((CanonicalOperationFailedException) error).failureCode())
                            .isEqualTo("CHILD_FAILED");
                });
    }

    @Test
    void cancelledParentRemainsCancelledThroughFusion() {
        var port = new FixturePort().withSource(Map.of())
                .thenStatuses(JobStatus.CANCELLED);
        var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
        CanonicalOperation<Object> operation = CanonicalOperations.of(
                CanonicalOperations.plan("cap", List.of(
                        CanonicalOperations.childArtifact("stt", JobType.SPEECH_TO_TEXT, "child-art"))),
                () -> null,
                outcome -> {
                    assertThat(outcome.status()).isEqualTo(JobStatus.CANCELLED);
                    return CanonicalOperations.toVideoAudioResult(outcome, true, false);
                });

        assertThatThrownBy(() -> executor.execute(binding(), "op", operation, AUTH))
                .isInstanceOf(CanonicalOperationFailedException.class)
                .satisfies(error -> {
                    var failure = (CanonicalOperationFailedException) error;
                    assertThat(failure.jobId()).isEqualTo("job-1");
                    assertThat(failure.status()).isEqualTo(JobStatus.CANCELLED);
                });
    }

    @Test
    void postSubmitReadbackFailureThrowsUnknownCarryingJobId() {
        var port = new FixturePort().withSource(Map.of());
        port.jobFailure = new IllegalStateException("readback lost");
        var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
        assertThatThrownBy(() -> executor.execute(binding(), "op", operation(), AUTH))
                .isInstanceOf(CanonicalOperationUnknownException.class)
                .satisfies(error -> assertThat(
                        ((CanonicalOperationUnknownException) error).jobId()).isEqualTo("job-1"));
    }

    @Test
    void missingSourceArtifactFailsValidationBeforeSubmit() {
        var port = new FixturePort();
        var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
        assertThatThrownBy(() -> executor.execute(binding(), "op", operation(), AUTH))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(port.submitted).isEmpty();
    }

    @Test
    void admissionRefusalAndSubmitAmbiguityKeepDistinctFinality() {
        var denied = new FixturePort().withSource(Map.of());
        denied.submitFailure = new MediaCapabilityNotAdmittedException(
                MediaCapabilityNotAdmittedException.Reason.NOT_ADMITTED, "MULTIMODAL", "denied");
        var executor = executor(denied, Duration.ofSeconds(5), Duration.ofMillis(5));
        assertThatThrownBy(() -> executor.execute(binding(), "op", operation(), AUTH))
                .isInstanceOf(MediaCapabilityNotAdmittedException.class);

        var ambiguous = new FixturePort().withSource(Map.of());
        ambiguous.submitFailure = new IllegalStateException("connection lost mid-submit");
        var executor2 = executor(ambiguous, Duration.ofSeconds(5), Duration.ofMillis(5));
        assertThatThrownBy(() -> executor2.execute(binding(), "op", operation(), AUTH))
                .isInstanceOf(CanonicalOperationUnknownException.class)
                .satisfies(error -> assertThat(
                        ((CanonicalOperationUnknownException) error).jobId()).isNull());
    }

    @Test
    void malformedArtifactClockMetadataFailsClosed() {
        byte[] payload = "inline-source".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        var port = new FixturePort().withSource(Map.of(
                "sourceClockMappingEvidenceRef", "ev-1",
                "sourceClockTicksPerSecond", "not-a-number"));
        var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
        CanonicalOperation<CanonicalOperationOutcome> operation = CanonicalOperations.of(
                CanonicalOperations.plan("cap", List.of(
                        CanonicalOperations.childInline(
                                "stt", JobType.SPEECH_TO_TEXT, payload, "audio/wav"))),
                () -> null, outcome -> outcome);

        assertThatThrownBy(() -> executor.execute(binding(), "op", operation, AUTH))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(port.uploads).isEmpty();
        assertThat(port.submitted).isEmpty();
    }

    @Test
    void partialArtifactClockMetadataFailsClosedBeforeInlineUpload() {
        List<Map<String, Object>> partialClockMetadata = List.of(
                Map.of("sourceClockId", "src-clock"),
                Map.of("sourceClockEpochOffsetTicks", 10),
                Map.of("sourceDurationTicks", 96_000));

        for (Map<String, Object> metadata : partialClockMetadata) {
            byte[] payload = "inline-source".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            var port = new FixturePort().withSource(metadata);
            var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
            CanonicalOperation<CanonicalOperationOutcome> operation = CanonicalOperations.of(
                    CanonicalOperations.plan("cap", List.of(
                            CanonicalOperations.childInline(
                                    "stt", JobType.SPEECH_TO_TEXT, payload, "audio/wav"))),
                    () -> null, outcome -> outcome);

            assertThatThrownBy(() -> executor.execute(binding(), "op", operation, AUTH))
                    .as("partial source clock metadata %s", metadata)
                    .isInstanceOf(IllegalArgumentException.class);
            assertThat(port.uploads).as("uploads for %s", metadata).isEmpty();
            assertThat(port.submitted).as("submissions for %s", metadata).isEmpty();
        }
    }

    @Test
    void malformedPresentClockMetadataFailsBeforeChildResolutionOrEffects() {
        List<Map<String, Object>> malformedMetadata = new ArrayList<>();
        for (String field : List.of(
                "sourceClockId", "sourceClockEpochOffsetTicks", "sourceDurationTicks")) {
            Map<String, Object> metadata = new java.util.HashMap<>(clockMetadata());
            metadata.put(field, field.equals("sourceClockId") ? 17 : "not-a-tick-count");
            malformedMetadata.add(metadata);
        }

        byte[] payload = "inline-source".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        for (Map<String, Object> metadata : malformedMetadata) {
            var port = new FixturePort().withSource(metadata);
            var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
            CanonicalOperation<CanonicalOperationOutcome> operation = CanonicalOperations.of(
                    CanonicalOperations.plan("cap", List.of(
                            CanonicalOperations.childInline(
                                    "stt", JobType.SPEECH_TO_TEXT, payload, "audio/wav"))),
                    () -> null, outcome -> outcome);

            assertThatThrownBy(() -> executor.execute(binding(), "op", operation, AUTH))
                    .as("malformed declared source clock metadata %s", metadata)
                    .isInstanceOf(IllegalArgumentException.class);
            assertThat(port.artifactReads).as("artifact reads for %s", metadata).hasValue(1);
            assertThat(port.uploads).as("uploads for %s", metadata).isEmpty();
            assertThat(port.submitted).as("submissions for %s", metadata).isEmpty();
        }
    }

    @Test
    void explicitNullClockMetadataIsRejectedByArtifactContractBeforeExecutorCanReadIt() {
        for (String field : List.of(
                "sourceClockId", "sourceClockEpochOffsetTicks", "sourceDurationTicks")) {
            Map<String, Object> metadata = new java.util.HashMap<>(clockMetadata());
            metadata.put(field, null);

            assertThatThrownBy(() -> FixturePort.artifact("src", SHA, metadata))
                    .as("explicit null source clock metadata field %s", field)
                    .isInstanceOf(NullPointerException.class);
        }
    }

    @Test
    void invalidGovernancePurposeFailsBeforeInlineChildUpload() {
        byte[] payload = "inline-source".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        var port = new FixturePort().withSource(Map.of());
        var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
        CanonicalOperation<CanonicalOperationOutcome> operation = CanonicalOperations.of(
                CanonicalOperations.plan("cap", List.of(
                        CanonicalOperations.childInline(
                                "stt", JobType.SPEECH_TO_TEXT, payload, "audio/wav"))),
                () -> null, outcome -> outcome);
        CanonicalOperationBinding noPurpose = binding().toBuilder().setPurpose(" ").build();

        assertThatThrownBy(() -> executor.execute(noPurpose, "op", operation, AUTH))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("purpose");

        assertThat(port.uploads).isEmpty();
        assertThat(port.submitted).isEmpty();
    }

    @Test
    void missingLaterReferencedChildFailsBeforeEarlierInlineUpload() {
        byte[] payload = "inline-source".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        var port = new FixturePort().withSource(Map.of());
        var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
        CanonicalOperation<CanonicalOperationOutcome> operation = CanonicalOperations.of(
                CanonicalOperations.plan("cap", List.of(
                        CanonicalOperations.childInline(
                                "stt", JobType.SPEECH_TO_TEXT, payload, "audio/wav"),
                        CanonicalOperations.childArtifact("vision", JobType.VISION, "missing-vision"))),
                () -> null, outcome -> outcome);

        assertThatThrownBy(() -> executor.execute(binding(), "op", operation, AUTH))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("missing-vision");

        assertThat(port.uploads).isEmpty();
        assertThat(port.submitted).isEmpty();
    }

    @Test
    void inlineChildBytesIngestThroughCanonicalUploadBeforeSubmit() throws Exception {
        byte[] payload = "pcm-fixture".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        var port = new FixturePort().withSource(Map.of())
                .thenStatuses(JobStatus.COMPLETED);
        var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
        CanonicalOperation<CanonicalOperationOutcome> operation = CanonicalOperations.of(
                CanonicalOperations.plan("cap", List.of(
                        CanonicalOperations.childInline(
                                "stt", JobType.SPEECH_TO_TEXT, payload, "audio/wav"))),
                () -> null, outcome -> outcome);

        executor.execute(binding(), "op", operation, AUTH);

        assertThat(port.uploads).hasSize(1);
        assertThat(port.uploads.peek().expectedSha256()).isEqualTo(sha256(payload));
        ProcessingJobRequest submitted = port.submitted.peek();
        MultimodalOperationSpec spec = MultimodalOperationSpec.from(submitted);
        var child = spec.child("stt");
        assertThat(child.artifactId()).isEqualTo("uploaded-art");
        assertThat(child.artifactSha256()).isEqualTo(sha256(payload));
    }

    @Test
    void ambiguousInlineUploadFailureIsUnknownAndMustNotBeBlindlyRetried() {
        byte[] payload = "pcm-fixture".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        var port = new FixturePort().withSource(Map.of());
        port.beginUploadFailure = new IllegalStateException("upload response lost after acceptance");
        var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
        CanonicalOperation<CanonicalOperationOutcome> operation = inlineOperation(payload);

        assertThatThrownBy(() -> executor.execute(binding(), "op", operation, AUTH))
                .isInstanceOf(CanonicalOperationUnknownException.class)
                .satisfies(failure -> {
                    CanonicalOperationUnknownException unknown = (CanonicalOperationUnknownException) failure;
                    assertThat(unknown.jobId()).isNull();
                    assertThat(unknown).hasMessageContaining("do not resubmit blindly");
                });

        assertThat(port.uploads).hasSize(1);
        assertThat(port.submitted).isEmpty();
    }

    @Test
    void parentAdmissionRejectionAfterInlineUploadIsUnknownAndMustNotBeBlindlyRetried() {
        byte[] payload = "pcm-fixture".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        var port = new FixturePort().withSource(Map.of());
        port.submitFailure = new MediaCapabilityNotAdmittedException(
                MediaCapabilityNotAdmittedException.Reason.NOT_ADMITTED, "MULTIMODAL", "denied");
        var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));

        assertThatThrownBy(() -> executor.execute(binding(), "op", inlineOperation(payload), AUTH))
                .isInstanceOf(CanonicalOperationUnknownException.class)
                .satisfies(failure -> {
                    CanonicalOperationUnknownException unknown = (CanonicalOperationUnknownException) failure;
                    assertThat(unknown.jobId()).isNull();
                    assertThat(unknown).hasMessageContaining("do not resubmit blindly");
                });

        assertThat(port.uploads).hasSize(1);
        assertThat(port.submitted).isEmpty();
    }

    @Test
    void mixedInlineAndReferencedChildrenPreserveDeclaredOrder() throws Exception {
        byte[] payload = "pcm-fixture".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        var port = new FixturePort().withSource(Map.of())
                .thenStatuses(JobStatus.COMPLETED);
        var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
        CanonicalOperation<CanonicalOperationOutcome> operation = CanonicalOperations.of(
                CanonicalOperations.plan("cap", List.of(
                        CanonicalOperations.childInline(
                                "stt", JobType.SPEECH_TO_TEXT, payload, "audio/wav"),
                        CanonicalOperations.childArtifact("vision", JobType.VISION, "child-art"))),
                () -> null, outcome -> outcome);

        executor.execute(binding(), "op", operation, AUTH);

        MultimodalOperationSpec spec = MultimodalOperationSpec.from(port.submitted.peek());
        assertThat(spec.children()).extracting(MultimodalOperationSpec.ChildOperationSpec::childKey)
                .containsExactly("stt", "vision");
        assertThat(spec.children()).extracting(MultimodalOperationSpec.ChildOperationSpec::jobType)
                .containsExactly(JobType.SPEECH_TO_TEXT, JobType.VISION);
    }

    @Test
    void mismatchedParentSourceVersionFailsBeforeInlineChildUpload() {
        byte[] payload = "pcm-fixture".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        var port = new FixturePort().withSource(Map.of());
        var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
        CanonicalOperation<CanonicalOperationOutcome> operation = CanonicalOperations.of(
                CanonicalOperations.plan("cap", List.of(
                        CanonicalOperations.childInline(
                                "stt", JobType.SPEECH_TO_TEXT, payload, "audio/wav"))),
                () -> null, outcome -> outcome);
        CanonicalOperationBinding staleBinding = binding().toBuilder()
                .setSourceVersionId("sha256:" + "cd".repeat(32))
                .build();

        assertThatThrownBy(() -> executor.execute(staleBinding, "op", operation, AUTH))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("source artifact version does not match");

        assertThat(port.uploads).isEmpty();
        assertThat(port.submitted).isEmpty();
    }

    // ── Fixtures ────────────────────────────────────────────────────────────

    private static MediaCanonicalOperationExecutor executor(
            FixturePort port, Duration deadline, Duration poll) {
        return new MediaCanonicalOperationExecutor(port, deadline, poll);
    }

    private static Thread startExecution(
            MediaCanonicalOperationExecutor executor,
            CanonicalOperationBinding binding,
            AtomicReference<Throwable> failure) {
        return Thread.startVirtualThread(() -> {
            try {
                executor.execute(binding, "op", operation(), AUTH);
            } catch (Throwable thrown) {
                failure.set(thrown);
            }
        });
    }

    private static void awaitIgnoringInterrupts(CountDownLatch latch) {
        boolean interrupted = false;
        while (true) {
            try {
                latch.await();
                break;
            } catch (InterruptedException ignored) {
                interrupted = true;
            }
        }
        if (interrupted) Thread.currentThread().interrupt();
    }

    private static CanonicalOperation<CanonicalOperationOutcome> operation() {
        return CanonicalOperations.of(
                CanonicalOperations.plan("cap", List.of(
                        CanonicalOperations.childArtifact("stt", JobType.SPEECH_TO_TEXT, "child-art"))),
                () -> null, outcome -> outcome);
    }

    private static CanonicalOperation<CanonicalOperationOutcome> inlineOperation(byte[] payload) {
        return CanonicalOperations.of(
                CanonicalOperations.plan("cap", List.of(
                        CanonicalOperations.childInline(
                                "stt", JobType.SPEECH_TO_TEXT, payload, "audio/wav"))),
                () -> null, outcome -> outcome);
    }

    private static CanonicalOperationBinding binding() {
        return CanonicalOperationBinding.newBuilder()
                .setCapabilityRef("cap")
                .setOperationRef("op")
                .setOperationVersion(1)
                .setRequestId("req-mm-1")
                .setSourceArtifactId("src")
                .setSourceVersionId("sha256:" + SHA)
                .setPurpose("mm-observe")
                .build();
    }

    private static Map<String, Object> clockMetadata() {
        return Map.of("sourceClockId", "src-clock",
                "sourceClockMappingEvidenceRef", "ev-1",
                "sourceClockTicksPerSecond", 48_000,
                "sourceDurationTicks", 96_000);
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static class FixturePort implements MediaProcessingRuntimePort {
        private final Deque<ProcessingJobRequest> submitted = new ConcurrentLinkedDeque<>();
        private final Deque<UploadRequest> uploads = new ConcurrentLinkedDeque<>();
        private final Deque<JobStatus> statuses = new ConcurrentLinkedDeque<>();
        private final AtomicInteger artifactReads = new AtomicInteger();
        private MediaArtifact source;
        private RuntimeException submitFailure;
        private RuntimeException beginUploadFailure;
        private RuntimeException jobFailure;

        FixturePort withSource(Map<String, Object> metadata) {
            this.source = artifact("src", SHA, metadata);
            return this;
        }

        FixturePort thenStatuses(JobStatus... sequence) {
            statuses.addAll(List.of(sequence));
            return this;
        }

        private static MediaArtifact artifact(String id, String sha, Map<String, Object> metadata) {
            return new MediaArtifact("tenant-a", "principal-a", id, id + ".bin",
                    "application/octet-stream", 4, sha, "ref", "CONFIDENTIAL",
                    Instant.now(), Instant.now().plusSeconds(3_600), metadata);
        }

        @Override public ProcessingJob submit(ProcessingJobRequest request) {
            return submit(request, AUTH);
        }

        @Override public ProcessingJob submit(
                ProcessingJobRequest request, AuthenticatedPrincipal authenticated) {
            if (submitFailure != null) throw submitFailure;
            submitted.add(request);
            return job("job-1", request.requestId(), JobStatus.ACCEPTED, Map.of());
        }

        @Override public Optional<ProcessingJob> job(
                String tenantId, String principalId, String jobId) {
            if (jobFailure != null) throw jobFailure;
            JobStatus status = statuses.isEmpty() ? JobStatus.RUNNING
                    : statuses.size() == 1 ? statuses.peek() : statuses.poll();
            Map<String, Object> result = status == JobStatus.COMPLETED
                    ? Map.of("observations", List.of(Map.of(
                            "childJobType", "SPEECH_TO_TEXT",
                            "observations", Map.of("text", "grounded"))))
                    : Map.of();
            String failureCode = status == JobStatus.FAILED ? "CHILD_FAILED" : "";
            return Optional.of(job(jobId, "req-mm-1", status, result, failureCode));
        }

        private static ProcessingJob job(String jobId, String requestId, JobStatus status,
                                         Map<String, Object> result) {
            return job(jobId, requestId, status, result, "");
        }

        private static ProcessingJob job(String jobId, String requestId, JobStatus status,
                                         Map<String, Object> result, String failureCode) {
            return new ProcessingJob(jobId, requestId, "tenant-a", "principal-a", "src",
                    JobType.MULTIMODAL, "mm", status, Instant.now(), Instant.now(),
                    status == JobStatus.ACCEPTED || status == JobStatus.RUNNING
                            ? null : Instant.now(),
                    result, failureCode, 1, "sha256:" + SHA, "sha256:" + SHA);
        }

        @Override public Optional<MediaArtifact> artifact(
                String tenantId, String principalId, String artifactId) {
            artifactReads.incrementAndGet();
            if (source != null && artifactId.equals(source.artifactId())) {
                return Optional.of(source);
            }
            if ("child-art".equals(artifactId)) {
                return Optional.of(artifact("child-art", SHA, Map.of()));
            }
            if ("uploaded-art".equals(artifactId)) {
                return Optional.of(artifact("uploaded-art", SHA, Map.of()));
            }
            return Optional.empty();
        }

        @Override public UploadSession beginUpload(
                UploadRequest request, String idempotencyKey, AuthenticatedPrincipal authenticated) {
            uploads.add(request);
            if (beginUploadFailure != null) throw beginUploadFailure;
            return new UploadSession("up-1", request.tenantId(), request.principalId(),
                    request.fileName(), request.contentType(), request.expectedSizeBytes(),
                    request.expectedSha256(), request.classification(), Instant.now(),
                    Instant.now().plusSeconds(3_600), 0, 0,
                    UploadStatus.OPEN, request.metadata());
        }

        @Override public UploadSession appendUploadChunk(
                AuthenticatedPrincipal authenticated, String uploadId, int chunkIndex, byte[] bytes) {
            UploadRequest request = uploads.peek();
            return new UploadSession(uploadId, authenticated.tenantId(), authenticated.principalId(),
                    request.fileName(), request.contentType(), request.expectedSizeBytes(),
                    request.expectedSha256(), request.classification(), Instant.now(),
                    Instant.now().plusSeconds(3_600), 0, chunkIndex + 1,
                    UploadStatus.OPEN, request.metadata());
        }

        @Override public MediaArtifact completeUpload(
                AuthenticatedPrincipal authenticated, String uploadId) {
            return artifact("uploaded-art", uploads.peek().expectedSha256(), Map.of());
        }
    }
}
