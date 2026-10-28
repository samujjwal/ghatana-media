package com.ghatana.stt.job;

import com.ghatana.core.lifecycle.CanonicalJobRecord;
import com.ghatana.core.lifecycle.CanonicalJobStatus;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.EnumMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Tests for {@link AvJobLifecycleAdapter} (LJE-0004).
 *
 * @doc.type class
 * @doc.purpose Tests for AV transcription job lifecycle adapter
 * @doc.layer product
 * @doc.pattern Test
 */
@DisplayName("AvJobLifecycleAdapter")
class AvJobLifecycleAdapterTest {

    @Test
    @DisplayName("maps created transcription job to canonical record")
    void mapsCreatedJobToCanonical() {
        AvTranscriptionJob job = AvTranscriptionJob.create(
                "audio-1", "tenant-1", "ne",
                Map.of("diarization", "true", "authorization", "Bearer sensitive-token",
                        "prompt", "private transcription context"),
                "trace-1", "req-1", "whisper-3");

        CanonicalJobRecord canonical = AvJobLifecycleAdapter.toCanonical(job);

        assertThat(canonical.jobId()).isEqualTo(job.jobId());
        assertThat(canonical.jobType()).isEqualTo("media.transcribe");
        assertThat(canonical.status()).isEqualTo(CanonicalJobStatus.PENDING);
        assertThat(canonical.tenantId()).isEqualTo("tenant-1");
        assertThat(canonical.input()).containsEntry("languageCode", "ne");
        assertThat(canonical.input()).containsEntry("artifactId", "audio-1")
                .doesNotContainKeys("diarization", "authorization", "prompt");
        assertThat(canonical.tags()).contains("speech-to-text");
    }

    @Test
    @DisplayName("maps completed job to canonical with result")
    void mapsCompletedJobToCanonical() {
        AvTranscriptionJob job = jobAt(AvTranscriptionJob.JobStatus.COMPLETED);

        CanonicalJobRecord canonical = AvJobLifecycleAdapter.toCanonical(job);

        assertThat(canonical.status()).isEqualTo(CanonicalJobStatus.COMPLETED);
    }

    @Test
    @DisplayName("maps failed job to canonical")
    void mapsFailedJobToCanonical() {
        AvTranscriptionJob job = jobAt(AvTranscriptionJob.JobStatus.FAILED);

        CanonicalJobRecord canonical = AvJobLifecycleAdapter.toCanonical(job);

        assertThat(canonical.status()).isEqualTo(CanonicalJobStatus.FAILED);
        assertThat(canonical.isTerminal()).isTrue();
    }

    @Test
    void redactsFreeFormFailureDiagnosticsFromCanonicalProjection() {
        AvTranscriptionJob failed = jobAt(AvTranscriptionJob.JobStatus.FAILED);
        String sensitiveDiagnostic = "private-transcript-marker bearer-token-marker";
        AvTranscriptionJob withDiagnostic = new AvTranscriptionJob(
                failed.jobId(), failed.artifactId(), failed.tenantId(), failed.languageCode(), failed.status(),
                failed.parameters(), failed.resultId(), sensitiveDiagnostic, failed.progressPercent(),
                failed.createdAt(), failed.startedAt(), failed.completedAt(), failed.retryCount(),
                failed.maxRetries(), failed.traceId(), failed.requestId(), failed.processorVersion());

        CanonicalJobRecord canonical = AvJobLifecycleAdapter.toCanonical(withDiagnostic);

        assertThat(canonical.failureCode()).isEqualTo("STT_JOB_FAILED");
        assertThat(canonical.failureMessage()).isEqualTo("Transcription job failed");
        assertThat(canonical.failureMessage()).doesNotContain("private-transcript-marker", "bearer-token-marker");
    }

    @Test
    @DisplayName("rejects null job")
    void rejectsNullJob() {
        assertThrows(NullPointerException.class, () -> AvJobLifecycleAdapter.toCanonical(null));
    }

    @Test
    @DisplayName("converts canonical status back to local status")
    void convertsCanonicalBackToLocal() {
        assertThat(AvJobLifecycleAdapter.fromCanonical(CanonicalJobStatus.RETRYING))
                .isEqualTo(AvTranscriptionJob.JobStatus.RETRY_PENDING);
        assertThat(AvJobLifecycleAdapter.fromCanonical(CanonicalJobStatus.SCHEDULED))
                .isNull();
    }

    @Test
    @DisplayName("does not project unknown outcome as canonical RUNNING")
    void doesNotProjectUnknownAsRunning() {
        for (AvTranscriptionJob.JobStatus status : java.util.List.of(
                AvTranscriptionJob.JobStatus.OUTCOME_UNKNOWN,
                AvTranscriptionJob.JobStatus.RECONCILING)) {
            AvTranscriptionJob job = jobAt(status);

            assertThat(assertThrows(IllegalStateException.class, () -> AvJobLifecycleAdapter.toCanonical(job)))
                    .hasMessageStartingWith("STT_JOB_STATUS_NOT_PROJECTABLE:");
        }
    }

    @Test
    @SuppressWarnings("deprecation")
    @DisplayName("projects every status that canonical enum can represent")
    void preservesExactMediaStateAcrossSharedProjection() {
        Map<AvTranscriptionJob.JobStatus, CanonicalJobStatus> expectedSharedStatus =
                new EnumMap<>(AvTranscriptionJob.JobStatus.class);
        expectedSharedStatus.put(AvTranscriptionJob.JobStatus.CREATED, CanonicalJobStatus.PENDING);
        expectedSharedStatus.put(AvTranscriptionJob.JobStatus.QUEUED, CanonicalJobStatus.QUEUED);
        expectedSharedStatus.put(AvTranscriptionJob.JobStatus.PROCESSING, CanonicalJobStatus.RUNNING);
        expectedSharedStatus.put(AvTranscriptionJob.JobStatus.RETRY_PENDING, CanonicalJobStatus.RETRYING);
        expectedSharedStatus.put(AvTranscriptionJob.JobStatus.RETRYING, CanonicalJobStatus.RETRYING);
        expectedSharedStatus.put(AvTranscriptionJob.JobStatus.COMPLETED, CanonicalJobStatus.COMPLETED);
        expectedSharedStatus.put(AvTranscriptionJob.JobStatus.FAILED, CanonicalJobStatus.FAILED);
        expectedSharedStatus.put(AvTranscriptionJob.JobStatus.CANCELLED, CanonicalJobStatus.CANCELLED);

        assertThat(expectedSharedStatus).hasSize(AvTranscriptionJob.JobStatus.values().length - 2);
        for (var entry : expectedSharedStatus.entrySet()) {
            AvTranscriptionJob job = jobAt(entry.getKey());

            CanonicalJobRecord projected = AvJobLifecycleAdapter.toCanonical(job);

            assertThat(projected.status()).as("shared projection for %s", entry.getKey())
                    .isEqualTo(entry.getValue());
            assertThat(projected.metadata()).as("exact source state for %s", entry.getKey())
                    .containsEntry("mediaCanonicalState", entry.getKey().name());
            assertThat(AvJobLifecycleAdapter.fromCanonical(projected))
                    .as("state restoration for %s", entry.getKey())
                    .isEqualTo(entry.getKey());
        }

        CanonicalJobRecord projected = AvJobLifecycleAdapter.toCanonical(AvTranscriptionJob.create(
                "audio-state", "tenant-1", "en", Map.of(), "trace", "request", "processor"));
        CanonicalJobRecord unknownSourceState = new CanonicalJobRecord(
                projected.jobId(), projected.jobType(), projected.status(), projected.tenantId(),
                projected.correlationId(), projected.traceId(), projected.createdAt(), projected.startedAt(),
                projected.completedAt(), projected.progressPercent(), projected.input(), projected.resultId(),
                projected.resultType(), projected.failureCode(), projected.failureMessage(), projected.retryCount(),
                projected.maxRetries(), projected.tags(), projected.metadata().with("mediaCanonicalState", "UNKNOWN"));
        assertThat(AvJobLifecycleAdapter.fromCanonical(unknownSourceState))
                .as("unrecognized source-state metadata is not coerced using a lossy shared state")
                .isNull();

        CanonicalJobRecord conflictingSourceState = new CanonicalJobRecord(
                projected.jobId(), projected.jobType(), projected.status(), projected.tenantId(),
                projected.correlationId(), projected.traceId(), projected.createdAt(), projected.startedAt(),
                projected.completedAt(), projected.progressPercent(), projected.input(), projected.resultId(),
                projected.resultType(), projected.failureCode(), projected.failureMessage(), projected.retryCount(),
                projected.maxRetries(), projected.tags(),
                projected.metadata().with("mediaCanonicalState", "OUTCOME_UNKNOWN"));
        assertThat(AvJobLifecycleAdapter.fromCanonical(conflictingSourceState))
                .as("source-state metadata that conflicts with the shared projection fails closed")
                .isNull();

        for (String unrepresentableState : java.util.List.of("OUTCOME_UNKNOWN", "RECONCILING")) {
            CanonicalJobRecord forgedRunningUnknown = new CanonicalJobRecord(
                    projected.jobId(), projected.jobType(), CanonicalJobStatus.RUNNING, projected.tenantId(),
                    projected.correlationId(), projected.traceId(), projected.createdAt(), projected.startedAt(),
                    projected.completedAt(), projected.progressPercent(), projected.input(), projected.resultId(),
                    projected.resultType(), projected.failureCode(), projected.failureMessage(), projected.retryCount(),
                    projected.maxRetries(), projected.tags(),
                    projected.metadata().with("mediaCanonicalState", unrepresentableState));
            assertThat(AvJobLifecycleAdapter.fromCanonical(forgedRunningUnknown))
                    .as("unrepresentable %s state cannot be recovered from a lossy RUNNING projection",
                            unrepresentableState)
                    .isNull();
        }

        CanonicalJobRecord malformedSourceState = new CanonicalJobRecord(
                projected.jobId(), projected.jobType(), projected.status(), projected.tenantId(),
                projected.correlationId(), projected.traceId(), projected.createdAt(), projected.startedAt(),
                projected.completedAt(), projected.progressPercent(), projected.input(), projected.resultId(),
                projected.resultType(), projected.failureCode(), projected.failureMessage(), projected.retryCount(),
                projected.maxRetries(), projected.tags(), projected.metadata().with("mediaCanonicalState", 1));
        assertThat(AvJobLifecycleAdapter.fromCanonical(malformedSourceState))
                .as("malformed source-state metadata fails closed instead of falling back to shared state")
                .isNull();
    }

    @Test
    void localTransitionsRequireImmutableResultAndKeepTerminalStateFinal() {
        AvTranscriptionJob created = jobAt(AvTranscriptionJob.JobStatus.CREATED);
        assertThat(assertThrows(IllegalStateException.class,
                () -> created.withStatus(AvTranscriptionJob.JobStatus.COMPLETED)))
                .hasMessageStartingWith("STT_JOB_TRANSITION_INVALID:");

        AvTranscriptionJob processing = created.withStatus(AvTranscriptionJob.JobStatus.PROCESSING);
        assertThat(assertThrows(IllegalStateException.class,
                () -> processing.withStatus(AvTranscriptionJob.JobStatus.RETRY_PENDING)))
                .hasMessageStartingWith("STT_JOB_RETRY_NOT_ADMITTED:");
        assertThat(assertThrows(IllegalArgumentException.class, () -> processing.withCompletedResult(" ")))
                .hasMessageStartingWith("STT_JOB_RESULT_VERSION_REQUIRED:");
        AvTranscriptionJob completed = processing.withCompletedResult("transcript-version-1");
        assertThat(completed.resultId()).isEqualTo("transcript-version-1");
        assertThat(completed.withCompletedResult("transcript-version-1")).isSameAs(completed);
        assertThat(assertThrows(IllegalStateException.class,
                () -> completed.withCompletedResult("transcript-version-2")))
                .hasMessageStartingWith("STT_JOB_RESULT_VERSION_CONFLICT:");
        assertThat(assertThrows(IllegalStateException.class,
                () -> completed.withStatus(AvTranscriptionJob.JobStatus.PROCESSING)))
                .hasMessageStartingWith("STT_JOB_TERMINAL_STATE_IMMUTABLE:");
    }

    @Test
    void retrySchedulingFailsClosedWithoutDurableNoEffectEvidenceAndAttemptFence() {
        for (AvTranscriptionJob.JobStatus status : java.util.List.of(
                AvTranscriptionJob.JobStatus.PROCESSING,
                AvTranscriptionJob.JobStatus.RECONCILING)) {
            AvTranscriptionJob job = jobAt(status);

            assertThat(assertThrows(IllegalStateException.class, job::scheduleRetry))
                    .as("%s cannot authorize replay without durable no-effect evidence and attempt fencing", status)
                    .hasMessageStartingWith("STT_JOB_RETRY_NOT_ADMITTED:");
        }
    }

    @Test
    @SuppressWarnings("deprecation")
    void retryStatesCannotTransitionBackToProcessingWithoutReplaySafetyEvidence() {
        for (AvTranscriptionJob.JobStatus status : java.util.List.of(
                AvTranscriptionJob.JobStatus.RETRY_PENDING,
                AvTranscriptionJob.JobStatus.RETRYING)) {
            AvTranscriptionJob retryState = jobAt(status);

            assertThat(assertThrows(IllegalStateException.class,
                    () -> retryState.withStatus(AvTranscriptionJob.JobStatus.PROCESSING)))
                    .as("%s cannot authorize another provider dispatch", status)
                    .hasMessageStartingWith("STT_JOB_TRANSITION_INVALID:");
        }
    }

    @Test
    void unknownOutcomeCannotStartAnotherAttemptUntilReconciled() {
        AvTranscriptionJob unknown = jobAt(AvTranscriptionJob.JobStatus.OUTCOME_UNKNOWN);

        assertThat(assertThrows(IllegalStateException.class, unknown::scheduleRetry))
                .hasMessageStartingWith("STT_JOB_RETRY_NOT_ADMITTED:");

        AvTranscriptionJob reconciling = unknown.withStatus(AvTranscriptionJob.JobStatus.RECONCILING);
        assertThat(assertThrows(IllegalStateException.class, reconciling::scheduleRetry))
                .as("entering reconciliation is not evidence that replay is safe")
                .hasMessageStartingWith("STT_JOB_RETRY_NOT_ADMITTED:");
    }

    @SuppressWarnings("deprecation")
    private static AvTranscriptionJob jobAt(AvTranscriptionJob.JobStatus status) {
        AvTranscriptionJob job = AvTranscriptionJob.create(
                "audio-state", "tenant-1", "en", Map.of(), "trace", "request", "processor");
        return switch (status) {
            case CREATED -> job;
            case QUEUED -> job.withStatus(AvTranscriptionJob.JobStatus.QUEUED);
            case PROCESSING -> job.withStatus(AvTranscriptionJob.JobStatus.PROCESSING);
            case RETRY_PENDING -> retryPending(job);
            case RETRYING -> legacyRetrying(retryPending(job));
            case OUTCOME_UNKNOWN -> job.withStatus(AvTranscriptionJob.JobStatus.PROCESSING)
                    .withStatus(AvTranscriptionJob.JobStatus.OUTCOME_UNKNOWN);
            case RECONCILING -> job.withStatus(AvTranscriptionJob.JobStatus.PROCESSING)
                    .withStatus(AvTranscriptionJob.JobStatus.OUTCOME_UNKNOWN)
                    .withStatus(AvTranscriptionJob.JobStatus.RECONCILING);
            case COMPLETED -> job.withStatus(AvTranscriptionJob.JobStatus.PROCESSING)
                    .withCompletedResult("transcript-version-1");
            case FAILED -> job.withStatus(AvTranscriptionJob.JobStatus.PROCESSING)
                    .withStatus(AvTranscriptionJob.JobStatus.FAILED);
            case CANCELLED -> job.withStatus(AvTranscriptionJob.JobStatus.CANCELLED);
        };
    }

    private static AvTranscriptionJob retryPending(AvTranscriptionJob job) {
        return new AvTranscriptionJob(
                job.jobId(), job.artifactId(), job.tenantId(), job.languageCode(),
                AvTranscriptionJob.JobStatus.RETRY_PENDING, job.parameters(), job.resultId(),
                job.errorMessage(), job.progressPercent(), job.createdAt(), job.startedAt(),
                job.completedAt(), 1, job.maxRetries(), job.traceId(), job.requestId(), job.processorVersion());
    }

    @SuppressWarnings("deprecation")
    private static AvTranscriptionJob legacyRetrying(AvTranscriptionJob retryPending) {
        return new AvTranscriptionJob(
                retryPending.jobId(), retryPending.artifactId(), retryPending.tenantId(), retryPending.languageCode(),
                AvTranscriptionJob.JobStatus.RETRYING, retryPending.parameters(), retryPending.resultId(),
                retryPending.errorMessage(), retryPending.progressPercent(), retryPending.createdAt(),
                retryPending.startedAt(), retryPending.completedAt(), retryPending.retryCount(),
                retryPending.maxRetries(), retryPending.traceId(), retryPending.requestId(),
                retryPending.processorVersion());
    }
}
