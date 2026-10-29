package com.ghatana.audio.video.multimodal.engine;

import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.Cancellation;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaChildJobDispatcher;
import com.ghatana.media.runtime.MediaRuntimeContracts.MultimodalOperationSpec;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

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

    // ── Fixtures ────────────────────────────────────────────────────────────

    private static ProcessingContext context() {
        return new ProcessingContext(request(), artifact(), new Cancellation());
    }

    private static ProcessingContext context(FixtureDispatcher dispatcher) {
        return new ProcessingContext(request(), artifact(), new Cancellation(), null,
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

    private static final class FixtureDispatcher implements MediaChildJobDispatcher {
        private final Map<String, ProcessingJob> jobs = new ConcurrentHashMap<>();
        private JobStatus status = JobStatus.COMPLETED;
        private Map<String, Object> result = Map.of();
        private final AtomicInteger submits = new AtomicInteger();

        FixtureDispatcher with(JobStatus status, Map<String, Object> result) {
            this.status = status;
            this.result = result;
            return this;
        }

        @Override public ProcessingJob submitChild(ProcessingJobRequest childRequest) {
            submits.incrementAndGet();
            boolean terminal = status == JobStatus.COMPLETED || status == JobStatus.FAILED
                    || status == JobStatus.CANCELLED || status == JobStatus.OUTCOME_UNKNOWN;
            ProcessingJob job = new ProcessingJob("child-1", childRequest.requestId(),
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
    }
}
