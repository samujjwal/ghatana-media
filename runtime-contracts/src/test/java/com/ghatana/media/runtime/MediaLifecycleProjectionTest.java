package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaLifecycleProjection.AttemptFacts;
import com.ghatana.media.runtime.MediaLifecycleProjection.JobFacts;
import com.ghatana.media.runtime.MediaLifecycleProjection.LogicalAttemptStatus;
import com.ghatana.media.runtime.MediaLifecycleProjection.LogicalJobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobAttempt;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobAttemptStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaLifecycleProjectionTest {

    private static ProcessingJob job(JobStatus status) {
        return new ProcessingJob(
                "job-1", "request-1", "tenant-1", "principal-1", "artifact-1", JobType.VISION,
                "provider-1", status, Instant.now(), null, null, Map.of(), "", 1);
    }

    private static JobAttempt attempt(JobAttemptStatus status, long fence) {
        return new JobAttempt(
                "tenant-1", "job-1", 1, "provider-1", "request-1", fence,
                status, Instant.now(), null, "");
    }

    @Test
    void durableTerminalStatusesProjectExactly() {
        assertThat(MediaLifecycleProjection.projectJob(job(JobStatus.COMPLETED), null, JobFacts.none()))
                .isEqualTo(LogicalJobStatus.COMPLETED);
        assertThat(MediaLifecycleProjection.projectJob(job(JobStatus.FAILED), null, JobFacts.none()))
                .isEqualTo(LogicalJobStatus.FAILED);
        assertThat(MediaLifecycleProjection.projectJob(job(JobStatus.CANCELLED), null, JobFacts.none()))
                .isEqualTo(LogicalJobStatus.CANCELLED);
    }

    @Test
    void acceptedJobsProjectAsQueuedAndRunningJobsStayRunning() {
        assertThat(MediaLifecycleProjection.projectJob(job(JobStatus.ACCEPTED), null, JobFacts.none()))
                .isEqualTo(LogicalJobStatus.QUEUED);
        assertThat(MediaLifecycleProjection.projectJob(job(JobStatus.RUNNING), null, JobFacts.none()))
                .isEqualTo(LogicalJobStatus.RUNNING);
    }

    @Test
    void retryPendingRequiresFailedAttemptAndRemainingRetryAuthority() {
        JobAttempt failed = attempt(JobAttemptStatus.FAILED, 1);
        JobFacts retryable = new JobFacts(true, false, false);
        assertThat(MediaLifecycleProjection.projectJob(job(JobStatus.RUNNING), failed, retryable))
                .isEqualTo(LogicalJobStatus.RETRY_PENDING);
        // No retry authority evidence -> conservative RUNNING, never an invented RETRY_PENDING.
        assertThat(MediaLifecycleProjection.projectJob(job(JobStatus.RUNNING), failed, JobFacts.none()))
                .isEqualTo(LogicalJobStatus.RUNNING);
        // Failed-attempt evidence does not apply to a non-failed latest attempt.
        assertThat(MediaLifecycleProjection.projectJob(
                job(JobStatus.RUNNING), attempt(JobAttemptStatus.RUNNING, 1), retryable))
                .isEqualTo(LogicalJobStatus.RUNNING);
        // Or to a job that is not RUNNING.
        assertThat(MediaLifecycleProjection.projectJob(job(JobStatus.ACCEPTED), failed, retryable))
                .isEqualTo(LogicalJobStatus.QUEUED);
    }

    @Test
    void reconcilingRequiresActiveReconciliationEvidence() {
        assertThat(MediaLifecycleProjection.projectJob(
                job(JobStatus.OUTCOME_UNKNOWN), null, new JobFacts(false, true, false)))
                .isEqualTo(LogicalJobStatus.RECONCILING);
        assertThat(MediaLifecycleProjection.projectJob(job(JobStatus.OUTCOME_UNKNOWN), null, JobFacts.none()))
                .isEqualTo(LogicalJobStatus.OUTCOME_UNKNOWN);
    }

    @Test
    void partialSuccessRequiresRecordedPartialDisposition() {
        assertThat(MediaLifecycleProjection.projectJob(
                job(JobStatus.COMPLETED), null, new JobFacts(false, false, true)))
                .isEqualTo(LogicalJobStatus.PARTIALLY_SUCCEEDED);
        assertThat(MediaLifecycleProjection.projectJob(job(JobStatus.COMPLETED), null, JobFacts.none()))
                .isEqualTo(LogicalJobStatus.COMPLETED);
    }

    @Test
    void staleFenceSupersedesOnlyNonTerminalAttempts() {
        assertThat(MediaLifecycleProjection.projectAttempt(
                attempt(JobAttemptStatus.DISPATCH_INTENT, 1),
                new AttemptFacts(false, false, false, 2)))
                .isEqualTo(LogicalAttemptStatus.SUPERSEDED);
        assertThat(MediaLifecycleProjection.projectAttempt(
                attempt(JobAttemptStatus.RUNNING, 1),
                new AttemptFacts(true, false, false, 2)))
                .isEqualTo(LogicalAttemptStatus.SUPERSEDED);
        // Terminal attempts keep their recorded outcome even behind a newer fence.
        assertThat(MediaLifecycleProjection.projectAttempt(
                attempt(JobAttemptStatus.COMPLETED, 1),
                new AttemptFacts(true, false, false, 2)))
                .isEqualTo(LogicalAttemptStatus.SUCCEEDED);
        assertThat(MediaLifecycleProjection.projectAttempt(
                attempt(JobAttemptStatus.OUTCOME_UNKNOWN, 1),
                new AttemptFacts(true, false, false, 2)))
                .isEqualTo(LogicalAttemptStatus.OUTCOME_UNKNOWN);
    }

    @Test
    void dispatchIntentOnlyProjectsDispatchedWithBoundaryEvidence() {
        assertThat(MediaLifecycleProjection.projectAttempt(
                attempt(JobAttemptStatus.DISPATCH_INTENT, 1), AttemptFacts.none()))
                .isEqualTo(LogicalAttemptStatus.DISPATCH_INTENT_RECORDED);
        assertThat(MediaLifecycleProjection.projectAttempt(
                attempt(JobAttemptStatus.DISPATCH_INTENT, 1),
                new AttemptFacts(true, false, false, 1)))
                .isEqualTo(LogicalAttemptStatus.DISPATCHED);
    }

    @Test
    void cancelRequestedAppliesOnlyToActiveAttempts() {
        assertThat(MediaLifecycleProjection.projectAttempt(
                attempt(JobAttemptStatus.RUNNING, 1),
                new AttemptFacts(true, true, false, 1)))
                .isEqualTo(LogicalAttemptStatus.CANCEL_REQUESTED);
        // A terminal attempt is never re-labeled as awaiting cancellation.
        assertThat(MediaLifecycleProjection.projectAttempt(
                attempt(JobAttemptStatus.FAILED, 1),
                new AttemptFacts(true, true, false, 1)))
                .isEqualTo(LogicalAttemptStatus.FAILED);
    }

    @Test
    void cancelConfirmedEvidenceOutranksAnyDurableAttemptState() {
        for (JobAttemptStatus status : JobAttemptStatus.values()) {
            assertThat(MediaLifecycleProjection.projectAttempt(
                    attempt(status, 1), new AttemptFacts(false, false, true, 1)))
                    .isEqualTo(LogicalAttemptStatus.CANCEL_CONFIRMED);
        }
    }

    @Test
    void terminalAttemptOutcomesProjectExactly() {
        assertThat(MediaLifecycleProjection.projectAttempt(
                attempt(JobAttemptStatus.COMPLETED, 1), AttemptFacts.none()))
                .isEqualTo(LogicalAttemptStatus.SUCCEEDED);
        assertThat(MediaLifecycleProjection.projectAttempt(
                attempt(JobAttemptStatus.FAILED, 1), AttemptFacts.none()))
                .isEqualTo(LogicalAttemptStatus.FAILED);
        assertThat(MediaLifecycleProjection.projectAttempt(
                attempt(JobAttemptStatus.OUTCOME_UNKNOWN, 1), AttemptFacts.none()))
                .isEqualTo(LogicalAttemptStatus.OUTCOME_UNKNOWN);
    }

    @Test
    void leaseWithoutAttemptIsClaimedNotInvented() {
        assertThat(MediaLifecycleProjection.claimedAttempt()).isEqualTo(LogicalAttemptStatus.CLAIMED);
    }

    @Test
    void projectionRejectsMissingSubjects() {
        assertThatThrownBy(() -> MediaLifecycleProjection.projectJob(null, null, JobFacts.none()))
                .isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> MediaLifecycleProjection.projectAttempt(null, AttemptFacts.none()))
                .isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new AttemptFacts(false, false, false, -1))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void logicalEnumsMatchTheNineAndTenStateModels() {
        assertThat(LogicalJobStatus.values()).containsExactly(
                LogicalJobStatus.QUEUED, LogicalJobStatus.RUNNING, LogicalJobStatus.RETRY_PENDING,
                LogicalJobStatus.OUTCOME_UNKNOWN, LogicalJobStatus.RECONCILING,
                LogicalJobStatus.COMPLETED, LogicalJobStatus.PARTIALLY_SUCCEEDED,
                LogicalJobStatus.FAILED, LogicalJobStatus.CANCELLED);
        assertThat(LogicalAttemptStatus.values()).containsExactly(
                LogicalAttemptStatus.CLAIMED, LogicalAttemptStatus.DISPATCH_INTENT_RECORDED,
                LogicalAttemptStatus.DISPATCHED, LogicalAttemptStatus.RUNNING,
                LogicalAttemptStatus.CANCEL_REQUESTED, LogicalAttemptStatus.SUCCEEDED,
                LogicalAttemptStatus.FAILED, LogicalAttemptStatus.CANCEL_CONFIRMED,
                LogicalAttemptStatus.OUTCOME_UNKNOWN, LogicalAttemptStatus.SUPERSEDED);
    }
}
