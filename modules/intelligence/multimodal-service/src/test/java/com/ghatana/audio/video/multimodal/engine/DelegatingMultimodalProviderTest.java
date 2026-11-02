package com.ghatana.audio.video.multimodal.engine;

import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.Cancellation;
import com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaChildJobDispatcher;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaJobStoreConflictException;
import com.ghatana.media.runtime.MediaRuntimeContracts.MultimodalOperationSpec;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext.MonotonicDeadline;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;

/** Verifies child fanout, finality mapping and UNKNOWN preservation of the real provider. */
class DelegatingMultimodalProviderTest {

    private static final String SHA = "ab".repeat(32);

    @Test
    void completedChildrenProduceSucceededSubmissionWithGroundedObservations() throws Exception {
        var scheduler = Executors.newSingleThreadScheduledExecutor();
        try {
            var provider = DelegatingMultimodalProvider.forTesting(
                    scheduler, Duration.ofSeconds(5), Duration.ofMillis(10));
            var dispatcher = new FixtureDispatcher()
                    .with(JobStatus.COMPLETED, Map.of("text", "grounded"));
            var submission = provider.processAttempt(context(dispatcher), attempt())
                    .get(10, TimeUnit.SECONDS);
            assertThat(submission.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
            assertThat(submission.providerOperationId()).isNotBlank();
            assertThat(submission.providerReceiptId()).isNotBlank();
            assertThat(submission.provenanceDigest()).matches("[0-9a-f]{64}");
            assertThat(submission.result()).containsKey("observations");
            assertThat(dispatcher.submits).hasValue(1);
        } finally {
            scheduler.shutdownNow();
        }
    }

    @Test
    void failedChildProducesFailedNotPartialSuccess() throws Exception {
        var scheduler = Executors.newSingleThreadScheduledExecutor();
        try {
            var provider = DelegatingMultimodalProvider.forTesting(
                    scheduler, Duration.ofSeconds(5), Duration.ofMillis(10));
            var dispatcher = new FixtureDispatcher()
                    .with(JobStatus.FAILED, Map.of());
            var submission = provider.processAttempt(context(dispatcher), attempt())
                    .get(10, TimeUnit.SECONDS);
            assertThat(submission.finality()).isEqualTo(AttemptFinality.FAILED);
        } finally {
            scheduler.shutdownNow();
        }
    }

    @Test
    void childStillRunningAtDeadlinePreservesOutcomeUnknown() throws Exception {
        var scheduler = Executors.newSingleThreadScheduledExecutor();
        try {
            var provider = DelegatingMultimodalProvider.forTesting(
                    scheduler, Duration.ofMillis(120), Duration.ofMillis(10));
            var dispatcher = new FixtureDispatcher()
                    .with(JobStatus.RUNNING, Map.of());
            var submission = provider.processAttempt(context(dispatcher), attempt())
                    .get(10, TimeUnit.SECONDS);
            assertThat(submission.finality()).isEqualTo(AttemptFinality.UNKNOWN);
            assertThat(submission.result()).isEmpty();
            assertThat(dispatcher.cancelledJobIds()).containsExactly("job-req-1:stt");
        } finally {
            scheduler.shutdownNow();
        }
    }

    @Test
    void expiredParentDeadlinePreventsAnyChildDispatch() throws Exception {
        var scheduler = Executors.newSingleThreadScheduledExecutor();
        try {
            var provider = DelegatingMultimodalProvider.forTesting(
                    scheduler, Duration.ofSeconds(5), Duration.ofMillis(10));
            var dispatcher = new FixtureDispatcher().with(JobStatus.RUNNING, Map.of());
            AtomicLong monotonicClock = new AtomicLong(Long.MAX_VALUE - 5);
            MonotonicDeadline monotonicDeadline = MonotonicDeadline.after(
                    Duration.ofNanos(10), monotonicClock::get);
            monotonicClock.set(Long.MIN_VALUE + 5); // elapsed 11ns across nanoTime wrap
            var expired = new ProcessingContext(request(), artifact(), new Cancellation(), null,
                    null, null, dispatcher, Instant.MAX,
                    monotonicDeadline);

            var submission = provider.processAttempt(expired, attempt()).get(10, TimeUnit.SECONDS);

            assertThat(submission.finality()).isEqualTo(AttemptFinality.NO_EFFECT_PROVEN);
            assertThat(dispatcher.submits).hasValue(0);
        } finally {
            scheduler.shutdownNow();
        }
    }

    @Test
    void earlierParentDeadlineBoundsProviderOperationDeadline() throws Exception {
        var scheduler = Executors.newSingleThreadScheduledExecutor();
        try {
            var provider = DelegatingMultimodalProvider.forTesting(
                    scheduler, Duration.ofSeconds(5), Duration.ofMillis(5));
            var dispatcher = new FixtureDispatcher().with(JobStatus.RUNNING, Map.of());
            var parentDeadline = Instant.now().plusMillis(100);
            var bounded = new ProcessingContext(request(), artifact(), new Cancellation(), null,
                    null, null, dispatcher, parentDeadline);

            var submission = provider.processAttempt(bounded, attempt()).get(10, TimeUnit.SECONDS);

            assertThat(submission.finality()).isEqualTo(AttemptFinality.UNKNOWN);
            assertThat(dispatcher.submits).hasValue(1);
            assertThat(dispatcher.cancelledJobIds()).containsExactly("job-req-1:stt");
        } finally {
            scheduler.shutdownNow();
        }
    }

    @Test
    void samePrincipalMismatchedReturnedChildIsNotCancelled() throws Exception {
        var scheduler = Executors.newSingleThreadScheduledExecutor();
        try {
            var provider = DelegatingMultimodalProvider.forTesting(
                    scheduler, Duration.ofSeconds(5), Duration.ofMillis(10));
            var dispatcher = new FixtureDispatcher() {
                @Override public ProcessingJob submitChild(ProcessingJobRequest request) {
                    ProcessingJob submitted = super.submitChild(request);
                    return new ProcessingJob(submitted.jobId(), submitted.requestId(), submitted.tenantId(),
                            submitted.principalId(), "rebound-artifact", submitted.jobType(),
                            submitted.providerId(), submitted.status(), submitted.createdAt(),
                            submitted.startedAt(), submitted.completedAt(), submitted.result(),
                            submitted.failureCode(), submitted.version(),
                            submitted.expectedArtifactVersion(), submitted.requestFingerprint());
                }
            }.with(JobStatus.COMPLETED, Map.of("text", "unbound result"));

            var submission = provider.processAttempt(context(dispatcher), attempt())
                    .get(10, TimeUnit.SECONDS);
            assertThat(submission.finality()).isEqualTo(AttemptFinality.UNKNOWN);
            assertThat(submission.result()).isEmpty();
            assertThat(dispatcher.cancelledJobIds()).isEmpty();
        } finally {
            scheduler.shutdownNow();
        }
    }

    @Test
    void legacyOrMalformedChildRequestFingerprintCannotBeFused() throws Exception {
        for (String fingerprint : List.of("", "malformed-fingerprint")) {
            var scheduler = Executors.newSingleThreadScheduledExecutor();
            try {
                var provider = DelegatingMultimodalProvider.forTesting(
                        scheduler, Duration.ofSeconds(5), Duration.ofMillis(10));
                var dispatcher = new FixtureDispatcher() {
                    @Override public ProcessingJob submitChild(ProcessingJobRequest request) {
                        ProcessingJob submitted = super.submitChild(request);
                        return new ProcessingJob(submitted.jobId(), submitted.requestId(),
                                submitted.tenantId(), submitted.principalId(), submitted.artifactId(),
                                submitted.jobType(), submitted.providerId(), submitted.status(),
                                submitted.createdAt(), submitted.startedAt(), submitted.completedAt(),
                                submitted.result(), submitted.failureCode(), submitted.version(),
                                submitted.expectedArtifactVersion(), fingerprint);
                    }
                }.with(JobStatus.COMPLETED, Map.of("text", "unbound result"));

                var submission = provider.processAttempt(context(dispatcher), attempt())
                        .get(10, TimeUnit.SECONDS);
                assertThat(submission.finality()).as("fingerprint=%s", fingerprint)
                        .isEqualTo(AttemptFinality.UNKNOWN);
                assertThat(submission.result()).as("fingerprint=%s", fingerprint).isEmpty();
                assertThat(dispatcher.cancelledJobIds()).as("fingerprint=%s", fingerprint).isEmpty();
            } finally {
                scheduler.shutdownNow();
            }
        }
    }

    @Test
    void fusedResultGroundsChildTimedObservationsOnTheBoundSourceClock() throws Exception {
        var scheduler = Executors.newSingleThreadScheduledExecutor();
        try {
            var provider = DelegatingMultimodalProvider.forTesting(
                    scheduler, Duration.ofSeconds(5), Duration.ofMillis(10));
            var dispatcher = new FixtureDispatcher()
                    .with(JobStatus.COMPLETED, Map.of("text", "grounded",
                            "timedObservations", List.of(Map.of(
                                    "startTick", 0L, "endTick", 48_000L,
                                    "sourceClockId", "src-clock"))));
            var submission = provider.processAttempt(clockedContext(dispatcher), attempt())
                    .get(10, TimeUnit.SECONDS);
            assertThat(submission.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
            List<?> observations = (List<?>) submission.result().get("observations");
            Map<?, ?> timing = (Map<?, ?>) ((Map<?, ?>) observations.get(0)).get("timing");
            assertThat(timing.get("status")).isEqualTo("TIMESTAMP_ALIGNED");
            Map<?, ?> entry = (Map<?, ?>) ((List<?>) timing.get("entries")).get(0);
            assertThat(entry.get("mediaEndMs")).isEqualTo(1_000L);
            assertThat(submission.result().get("clockComparability"))
                    .isEqualTo("SOURCE_CLOCK_SHARED");
        } finally {
            scheduler.shutdownNow();
        }
    }

    @Test
    void unknownChildWithSucceededSiblingKeepsParentUnknown() throws Exception {
        var scheduler = Executors.newSingleThreadScheduledExecutor();
        try {
            var provider = DelegatingMultimodalProvider.forTesting(
                    scheduler, Duration.ofSeconds(5), Duration.ofMillis(10));
            var dispatcher = new FixtureDispatcher()
                    .with(JobType.SPEECH_TO_TEXT, JobStatus.OUTCOME_UNKNOWN, Map.of())
                    .with(JobType.VISION, JobStatus.COMPLETED, Map.of("detections", List.of()));
            var submission = provider.processAttempt(context(dispatcher, twoChildRequest()), attempt())
                    .get(10, TimeUnit.SECONDS);
            assertThat(submission.finality()).isEqualTo(AttemptFinality.UNKNOWN);
            assertThat(submission.result()).isEmpty();
        } finally {
            scheduler.shutdownNow();
        }
    }

    @Test
    void parentCancellationPropagatesToInflightChildren() throws Exception {
        var scheduler = Executors.newSingleThreadScheduledExecutor();
        try {
            var provider = DelegatingMultimodalProvider.forTesting(
                    scheduler, Duration.ofSeconds(30), Duration.ofMillis(10));
            var dispatcher = new FixtureDispatcher()
                    .with(JobType.SPEECH_TO_TEXT, JobStatus.RUNNING, Map.of())
                    .with(JobType.VISION, JobStatus.RUNNING, Map.of());
            var cancellation = new Cancellation();
            var future = provider.processAttempt(
                    context(cancellation, dispatcher, twoChildRequest()), attempt());
            assertThat(dispatcher.submits.get()).isEqualTo(2);
            cancellation.cancel();
            var submission = future.get(10, TimeUnit.SECONDS);
            assertThat(submission.finality()).isEqualTo(AttemptFinality.UNKNOWN);
            assertThat(dispatcher.cancelledJobIds()).containsExactlyInAnyOrder(
                    "job-req-1:stt", "job-req-1:vision");
        } finally {
            scheduler.shutdownNow();
        }
    }

    @Test
    void deniedSecondChildCancelsAlreadySubmittedSiblings() throws Exception {
        var scheduler = Executors.newSingleThreadScheduledExecutor();
        try {
            var provider = DelegatingMultimodalProvider.forTesting(
                    scheduler, Duration.ofSeconds(5), Duration.ofMillis(10));
            var dispatcher = new FixtureDispatcher()
                    .with(JobType.SPEECH_TO_TEXT, JobStatus.RUNNING, Map.of())
                    .failOn(JobType.VISION, new SecurityException("child source rights revoked"));
            var submission = provider.processAttempt(context(dispatcher, twoChildRequest()), attempt())
                    .get(10, TimeUnit.SECONDS);
            assertThat(submission.finality()).isEqualTo(AttemptFinality.UNKNOWN);
            assertThat(dispatcher.cancelledJobIds()).containsExactly("job-req-1:stt");
        } finally {
            scheduler.shutdownNow();
        }
    }

    @Test
    void expiredOperationDeadlineCancelsStillRunningChildren() throws Exception {
        var scheduler = Executors.newSingleThreadScheduledExecutor();
        try {
            var provider = DelegatingMultimodalProvider.forTesting(
                    scheduler, Duration.ofMillis(120), Duration.ofMillis(10));
            var dispatcher = new FixtureDispatcher()
                    .with(JobType.SPEECH_TO_TEXT, JobStatus.RUNNING, Map.of())
                    .with(JobType.VISION, JobStatus.RUNNING, Map.of());
            var submission = provider.processAttempt(context(dispatcher, twoChildRequest()), attempt())
                    .get(10, TimeUnit.SECONDS);
            assertThat(submission.finality()).isEqualTo(AttemptFinality.UNKNOWN);
            assertThat(dispatcher.cancelledJobIds()).containsExactlyInAnyOrder(
                    "job-req-1:stt", "job-req-1:vision");
        } finally {
            scheduler.shutdownNow();
        }
    }

    @Test
    void missingDispatcherProducesNoEffectProven() throws Exception {
        var scheduler = Executors.newSingleThreadScheduledExecutor();
        try {
            var provider = DelegatingMultimodalProvider.forTesting(
                    scheduler, Duration.ofSeconds(5), Duration.ofMillis(10));
            var submission = provider.processAttempt(context(), attempt())
                    .get(10, TimeUnit.SECONDS);
            assertThat(submission.finality()).isEqualTo(AttemptFinality.NO_EFFECT_PROVEN);
        } finally {
            scheduler.shutdownNow();
        }
    }

    @Test
    void completedSubmissionWithoutCurrentDurableReadbackRemainsUnknown() throws Exception {
        var scheduler = Executors.newSingleThreadScheduledExecutor();
        try {
            var provider = DelegatingMultimodalProvider.forTesting(
                    scheduler, Duration.ofSeconds(5), Duration.ofMillis(10));
            var dispatcher = new FixtureDispatcher() {
                @Override public Optional<ProcessingJob> findJob(String jobId) {
                    return Optional.empty();
                }
            }.with(JobStatus.COMPLETED, Map.of("text", "stale snapshot"));

            var submission = provider.processAttempt(context(dispatcher), attempt())
                    .get(10, TimeUnit.SECONDS);
            assertThat(submission.finality()).isEqualTo(AttemptFinality.UNKNOWN);
            assertThat(submission.result()).isEmpty();
            assertThat(dispatcher.cancelledJobIds()).containsExactly("job-req-1:stt");
        } finally {
            scheduler.shutdownNow();
        }
    }

    @Test
    void mismatchedChildTenantCannotBeFusedAsSucceeded() throws Exception {
        var scheduler = Executors.newSingleThreadScheduledExecutor();
        try {
            var provider = DelegatingMultimodalProvider.forTesting(
                    scheduler, Duration.ofSeconds(5), Duration.ofMillis(10));
            var dispatcher = new FixtureDispatcher() {
                @Override public ProcessingJob submitChild(ProcessingJobRequest request) {
                    ProcessingJob submitted = super.submitChild(request);
                    return new ProcessingJob(submitted.jobId(), submitted.requestId(), "other-tenant",
                            submitted.principalId(), submitted.artifactId(), submitted.jobType(),
                            submitted.providerId(), submitted.status(), submitted.createdAt(),
                            submitted.startedAt(), submitted.completedAt(), submitted.result(),
                            submitted.failureCode(), submitted.version(),
                            submitted.expectedArtifactVersion(), submitted.requestFingerprint());
                }
            }.with(JobStatus.COMPLETED, Map.of("text", "unbound result"));

            var submission = provider.processAttempt(context(dispatcher), attempt())
                    .get(10, TimeUnit.SECONDS);
            assertThat(submission.finality()).isEqualTo(AttemptFinality.UNKNOWN);
            assertThat(submission.result()).isEmpty();
            assertThat(dispatcher.cancelledJobIds()).isEmpty();
        } finally {
            scheduler.shutdownNow();
        }
    }

    @Test
    void durableReadbackWithChangedSourceBindingRemainsUnknown() throws Exception {
        var scheduler = Executors.newSingleThreadScheduledExecutor();
        try {
            var provider = DelegatingMultimodalProvider.forTesting(
                    scheduler, Duration.ofSeconds(5), Duration.ofMillis(10));
            var dispatcher = new FixtureDispatcher() {
                @Override public Optional<ProcessingJob> findJob(String jobId) {
                    return super.findJob(jobId).map(job -> new ProcessingJob(
                            job.jobId(), job.requestId(), job.tenantId(), job.principalId(), "rebound-artifact",
                            job.jobType(), job.providerId(), job.status(), job.createdAt(), job.startedAt(),
                            job.completedAt(), job.result(), job.failureCode(), job.version(),
                            job.expectedArtifactVersion(), job.requestFingerprint()));
                }
            }.with(JobStatus.COMPLETED, Map.of("text", "rebound result"));

            var submission = provider.processAttempt(context(dispatcher), attempt())
                    .get(10, TimeUnit.SECONDS);
            assertThat(submission.finality()).isEqualTo(AttemptFinality.UNKNOWN);
            assertThat(submission.result()).isEmpty();
            assertThat(dispatcher.cancelledJobIds()).containsExactly("job-req-1:stt");
        } finally {
            scheduler.shutdownNow();
        }
    }

    @Test
    void sameChildRequestIdWithChangedParametersAndGovernanceRemainsUnknown() throws Exception {
        var scheduler = Executors.newSingleThreadScheduledExecutor();
        try {
            var provider = DelegatingMultimodalProvider.forTesting(
                    scheduler, Duration.ofSeconds(5), Duration.ofMillis(10));
            var dispatcher = new FixtureDispatcher().with(JobStatus.COMPLETED, Map.of("text", "result"));
            var first = singleChildRequest(Map.of("language", "en"),
                    new MediaGovernanceContext("consent-v1", "transcription", "local", Set.of("local"),
                            false, false));
            var changed = singleChildRequest(Map.of("language", "hi"),
                    new MediaGovernanceContext("consent-v2", "transcription", "local", Set.of("local"),
                            false, false));

            var firstSubmission = provider.processAttempt(context(dispatcher, first), attempt())
                    .get(10, TimeUnit.SECONDS);
            var replaySubmission = provider.processAttempt(context(dispatcher, changed), attempt())
                    .get(10, TimeUnit.SECONDS);

            assertThat(firstSubmission.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
            assertThat(replaySubmission.finality()).isEqualTo(AttemptFinality.UNKNOWN);
            assertThat(replaySubmission.result()).isEmpty();
            assertThat(dispatcher.submits).hasValue(1);
        } finally {
            scheduler.shutdownNow();
        }
    }

    @Test
    void lostChildSubmissionAcknowledgementRemainsUnknownThenExactReplayReadsSameJob() throws Exception {
        var scheduler = Executors.newSingleThreadScheduledExecutor();
        try {
            var provider = DelegatingMultimodalProvider.forTesting(
                    scheduler, Duration.ofSeconds(5), Duration.ofMillis(10));
            AtomicInteger acknowledgements = new AtomicInteger();
            var dispatcher = new FixtureDispatcher() {
                @Override public ProcessingJob submitChild(ProcessingJobRequest request) {
                    ProcessingJob job = super.submitChild(request);
                    if (acknowledgements.getAndIncrement() == 0) {
                        throw new IllegalStateException("simulated lost child acknowledgement");
                    }
                    return job;
                }
            }.with(JobStatus.COMPLETED, Map.of("text", "durable result"));
            ProcessingJobRequest request = singleChildRequest(Map.of("language", "en"),
                    MediaGovernanceContext.compatibilityDefault());

            var first = provider.processAttempt(context(dispatcher, request), attempt())
                    .get(10, TimeUnit.SECONDS);
            var replay = provider.processAttempt(context(dispatcher, request), attempt())
                    .get(10, TimeUnit.SECONDS);

            assertThat(first.finality()).isEqualTo(AttemptFinality.UNKNOWN);
            assertThat(first.result()).isEmpty();
            assertThat(replay.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
            assertThat(dispatcher.submits).hasValue(1);
        } finally {
            scheduler.shutdownNow();
        }
    }

    // ── Fixtures ────────────────────────────────────────────────────────────

    private static ProcessingContext context() {
        return new ProcessingContext(request(), artifact(), new Cancellation());
    }

    private static ProcessingContext context(FixtureDispatcher dispatcher) {
        return new ProcessingContext(request(), artifact(), new Cancellation(), null,
                null, null, dispatcher);
    }

    private static ProcessingContext context(FixtureDispatcher dispatcher, ProcessingJobRequest request) {
        return new ProcessingContext(request, artifact(), new Cancellation(), null,
                null, null, dispatcher);
    }

    private static ProcessingContext context(
            Cancellation cancellation, FixtureDispatcher dispatcher, ProcessingJobRequest request) {
        return new ProcessingContext(request, artifact(), cancellation, null,
                null, null, dispatcher);
    }

    private static ProcessingJobRequest twoChildRequest() {
        var spec = new MultimodalOperationSpec(
                MultimodalOperationSpec.SPEC_VERSION,
                "cap", "op", 1, "src", "sha256:" + SHA, SHA,
                List.of(new MultimodalOperationSpec.ChildOperationSpec(
                        "stt", JobType.SPEECH_TO_TEXT, "stt-art",
                        "sha256:" + SHA, SHA, "", Map.of()),
                        new MultimodalOperationSpec.ChildOperationSpec(
                        "vision", JobType.VISION, "vision-art",
                        "sha256:" + SHA, SHA, "", Map.of())),
                null, Map.of());
        return new ProcessingJobRequest("req-1", "tenant-a", "principal-a", "corr-1",
                "src", "sha256:" + SHA, JobType.MULTIMODAL, "",
                Map.of(MultimodalOperationSpec.PARAMETERS_KEY, spec.toParametersValue()));
    }

    private static ProcessingJobRequest singleChildRequest(
            Map<String, Object> childParameters, MediaGovernanceContext governance) {
        var spec = new MultimodalOperationSpec(
                MultimodalOperationSpec.SPEC_VERSION,
                "cap", "op", 1, "src", "sha256:" + SHA, SHA,
                List.of(new MultimodalOperationSpec.ChildOperationSpec(
                        "stt", JobType.SPEECH_TO_TEXT, "child-art",
                        "sha256:" + SHA, SHA, "", childParameters)),
                null, Map.of());
        return new ProcessingJobRequest("req-1", "tenant-a", "principal-a", "corr-1",
                "src", "sha256:" + SHA, JobType.MULTIMODAL, "",
                Map.of(MultimodalOperationSpec.PARAMETERS_KEY, spec.toParametersValue()), governance);
    }

    private static ProcessingContext clockedContext(FixtureDispatcher dispatcher) {
        var spec = new MultimodalOperationSpec(
                MultimodalOperationSpec.SPEC_VERSION,
                "cap", "op", 1, "src", "sha256:" + SHA, SHA,
                List.of(new MultimodalOperationSpec.ChildOperationSpec(
                        "stt", JobType.SPEECH_TO_TEXT, "child-art",
                        "sha256:" + SHA, SHA, "", Map.of())),
                new MultimodalOperationSpec.SourceClockBinding(
                        "ev-1", 48_000, 0, "src-clock", 96_000),
                Map.of());
        var request = new ProcessingJobRequest("req-1", "tenant-a", "principal-a", "corr-1",
                "src", "sha256:" + SHA, JobType.MULTIMODAL, "",
                Map.of(MultimodalOperationSpec.PARAMETERS_KEY, spec.toParametersValue()));
        return new ProcessingContext(request, artifact(), new Cancellation(), null,
                null, null, dispatcher);
    }

    private static ProcessingJobRequest request() {
        var spec = new MultimodalOperationSpec(
                MultimodalOperationSpec.SPEC_VERSION,
                "cap", "op", 1, "src", "sha256:" + SHA, SHA,
                List.of(new MultimodalOperationSpec.ChildOperationSpec(
                        "stt", JobType.SPEECH_TO_TEXT, "child-art",
                        "sha256:" + SHA, SHA, "", Map.of())),
                null, Map.of());
        return new ProcessingJobRequest("req-1", "tenant-a", "principal-a", "corr-1",
                "src", "sha256:" + SHA, JobType.MULTIMODAL, "",
                Map.of(MultimodalOperationSpec.PARAMETERS_KEY, spec.toParametersValue()));
    }

    private static MediaArtifact artifact() {
        return new MediaArtifact("tenant-a", "principal-a", "src", "src.bin",
                "application/octet-stream", 4, SHA, "ref", "CONFIDENTIAL",
                Instant.now(), Instant.now().plusSeconds(3600), Map.of());
    }

    private static ProviderAttemptContext attempt() {
        return new ProviderAttemptContext("tenant-a", "job-1", "req-1", 1, 1, SHA);
    }

    private static class FixtureDispatcher implements MediaChildJobDispatcher {
        private final Map<String, ProcessingJob> jobs = new ConcurrentHashMap<>();
        private final Map<String, ProcessingJobRequest> requests = new ConcurrentHashMap<>();
        private final Map<JobType, JobStatus> statuses = new ConcurrentHashMap<>();
        private final Map<JobType, Map<String, Object>> results = new ConcurrentHashMap<>();
        private final Map<JobType, RuntimeException> failures = new ConcurrentHashMap<>();
        private final java.util.Set<String> cancelled = ConcurrentHashMap.newKeySet();
        private final AtomicInteger submits = new AtomicInteger();
        private JobStatus defaultStatus = JobStatus.COMPLETED;
        private Map<String, Object> defaultResult = Map.of();

        FixtureDispatcher with(JobStatus status, Map<String, Object> result) {
            this.defaultStatus = status;
            this.defaultResult = result;
            return this;
        }

        FixtureDispatcher with(JobType jobType, JobStatus status, Map<String, Object> result) {
            statuses.put(jobType, status);
            results.put(jobType, result);
            return this;
        }

        FixtureDispatcher failOn(JobType jobType, RuntimeException failure) {
            failures.put(jobType, failure);
            return this;
        }

        java.util.Set<String> cancelledJobIds() {
            return cancelled;
        }

        @Override public ProcessingJob submitChild(ProcessingJobRequest childRequest) {
            RuntimeException failure = failures.get(childRequest.jobType());
            if (failure != null) throw failure;
            ProcessingJobRequest priorRequest = requests.putIfAbsent(childRequest.requestId(), childRequest);
            if (priorRequest != null) {
                if (!priorRequest.equals(childRequest)) {
                    throw new MediaJobStoreConflictException(
                            "same child request id was resubmitted with different normalized input");
                }
                return jobs.get(childRequest.requestId());
            }
            submits.incrementAndGet();
            JobStatus status = statuses.getOrDefault(childRequest.jobType(), defaultStatus);
            Map<String, Object> result =
                    results.getOrDefault(childRequest.jobType(), defaultResult);
            boolean terminal = status == JobStatus.COMPLETED || status == JobStatus.FAILED
                    || status == JobStatus.CANCELLED || status == JobStatus.OUTCOME_UNKNOWN;
            ProcessingJob job = new ProcessingJob("job-" + childRequest.requestId(),
                    childRequest.requestId(),
                    childRequest.tenantId(), childRequest.principalId(), childRequest.artifactId(),
                    childRequest.jobType(), "child-provider", status, Instant.now(), Instant.now(),
                    terminal ? Instant.now() : null,
                    result, "", 1, "sha256:" + SHA, "sha256:" + SHA);
            jobs.put(childRequest.requestId(), job);
            return job;
        }

        @Override public Optional<ProcessingJob> findJob(String jobId) {
            return jobs.values().stream().filter(j -> j.jobId().equals(jobId)).findFirst();
        }

        @Override public Optional<ProcessingJob> findJobByRequest(String requestId) {
            return Optional.ofNullable(jobs.get(requestId));
        }

        @Override public CancellationOutcome cancelChild(String jobId) {
            cancelled.add(jobId);
            jobs.replaceAll((requestId, job) -> job.jobId().equals(jobId)
                    ? new ProcessingJob(job.jobId(), job.requestId(), job.tenantId(),
                            job.principalId(), job.artifactId(), job.jobType(), job.providerId(),
                            JobStatus.CANCELLED, job.createdAt(), job.startedAt(), Instant.now(),
                            job.result(), job.failureCode(), job.version() + 1,
                            job.expectedArtifactVersion(), job.requestFingerprint())
                    : job);
            return CancellationOutcome.CONFIRMED;
        }
    }
}
