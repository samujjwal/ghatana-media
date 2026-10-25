package com.ghatana.stt.job;

import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * Typed job record for audio-video STT transcription operations (LJE-0004).
 *
 * <p>Provides lifecycle tracking, retry bookkeeping, and result correlation
 * for speech-to-text jobs so they can be projected onto the canonical
 * {@code CanonicalJobRecord} envelope via {@link AvJobLifecycleAdapter}.</p>
 *
 * @param jobId            globally unique job identifier
 * @param artifactId       associated audio artifact identifier
 * @param tenantId         tenant scope for isolation
 * @param languageCode     target language code for transcription
 * @param status           current job status
 * @param parameters       job-specific parameters (model, diarization, etc.)
 * @param resultId         immutable transcript version identifier when completed
 * @param errorMessage     human-readable error if failed
 * @param progressPercent  progress 0-100
 * @param createdAt        creation timestamp
 * @param startedAt        start timestamp (null until started)
 * @param completedAt      completion timestamp (null until completed)
 * @param retryCount       how many retries have been attempted
 * @param maxRetries       maximum retry attempts
 * @param traceId          distributed trace ID
 * @param requestId        correlation request ID
 * @param processorVersion engine version for reproducibility
 *
 * @doc.type record
 * @doc.purpose STT transcription job record with lifecycle tracking
 * @doc.layer product
 * @doc.pattern Value Object
 */
public record AvTranscriptionJob(
        String jobId,
        String artifactId,
        String tenantId,
        String languageCode,
        JobStatus status,
        Map<String, String> parameters,
        String resultId,
        String errorMessage,
        int progressPercent,
        Instant createdAt,
        Instant startedAt,
        Instant completedAt,
        int retryCount,
        int maxRetries,
        String traceId,
        String requestId,
        String processorVersion) {

    public AvTranscriptionJob {
        Objects.requireNonNull(jobId, "jobId must not be null");
        Objects.requireNonNull(artifactId, "artifactId must not be null");
        Objects.requireNonNull(tenantId, "tenantId must not be null");
        Objects.requireNonNull(languageCode, "languageCode must not be null");
        Objects.requireNonNull(status, "status must not be null");
        Objects.requireNonNull(createdAt, "createdAt must not be null");
        if (status == JobStatus.COMPLETED && (resultId == null || resultId.isBlank())) {
            throw new IllegalArgumentException("STT_JOB_RESULT_VERSION_REQUIRED: completed jobs require a transcript version");
        }
        if (progressPercent < 0 || progressPercent > 100)
            throw new IllegalArgumentException("progressPercent must be between 0 and 100");
        if (retryCount < 0) throw new IllegalArgumentException("retryCount must not be negative");
        if (maxRetries < 0) throw new IllegalArgumentException("maxRetries must not be negative");
        parameters = parameters != null ? Map.copyOf(parameters) : Map.of();
    }

    /** Job lifecycle statuses for AV transcription. */
    public enum JobStatus {
        CREATED,
        QUEUED,
        PROCESSING,
        RETRY_PENDING,
        OUTCOME_UNKNOWN,
        RECONCILING,
        COMPLETED,
        FAILED,
        CANCELLED,
        /** @deprecated Use {@link #RETRY_PENDING}; retained for wire compatibility. */
        @Deprecated
        RETRYING
    }

    /** Factory for a new transcription job. */
    public static AvTranscriptionJob create(
            String artifactId,
            String tenantId,
            String languageCode,
            Map<String, String> parameters,
            String traceId,
            String requestId,
            String processorVersion) {
        Instant now = Instant.now();
        return new AvTranscriptionJob(
                UUID.randomUUID().toString(), artifactId, tenantId, languageCode,
                JobStatus.CREATED, parameters, null, null, 0,
                now, null, null, 0, 3, traceId, requestId, processorVersion);
    }

    /** Returns a copy with a legal local lifecycle transition and updated timestamps. */
    public AvTranscriptionJob withStatus(JobStatus newStatus) {
        Objects.requireNonNull(newStatus, "newStatus must not be null");
        if (newStatus == status) return this;
        if (isTerminal()) {
            throw new IllegalStateException("STT_JOB_TERMINAL_STATE_IMMUTABLE: terminal job cannot transition");
        }
        if (newStatus == JobStatus.RETRY_PENDING || newStatus == JobStatus.RETRYING) {
            throw new IllegalStateException(
                    "STT_JOB_RETRY_SCHEDULE_REQUIRED: use scheduleRetry to enforce the retry budget");
        }
        if (!transitionAllowed(status, newStatus)) {
            throw new IllegalStateException("STT_JOB_TRANSITION_INVALID: " + status + " cannot transition to " + newStatus);
        }
        if (newStatus == JobStatus.COMPLETED) {
            throw new IllegalStateException(
                    "STT_JOB_RESULT_VERSION_REQUIRED: use withCompletedResult with an immutable transcript version");
        }

        Instant now = Instant.now();
        Instant newStartedAt = this.startedAt;
        Instant newCompletedAt = this.completedAt;
        if (newStatus == JobStatus.PROCESSING && newStartedAt == null) {
            newStartedAt = now;
        }
        if ((newStatus == JobStatus.COMPLETED || newStatus == JobStatus.FAILED || newStatus == JobStatus.CANCELLED)
                && newCompletedAt == null) {
            newCompletedAt = now;
        }
        return new AvTranscriptionJob(
                jobId, artifactId, tenantId, languageCode, newStatus, parameters,
                resultId, errorMessage, progressPercent, createdAt, newStartedAt, newCompletedAt,
                retryCount, maxRetries, traceId, requestId, processorVersion);
    }

    /** Schedules one bounded retry after a failed or reconciled attempt. */
    public AvTranscriptionJob scheduleRetry() {
        if (status != JobStatus.PROCESSING && status != JobStatus.RECONCILING) {
            throw new IllegalStateException("STT_JOB_TRANSITION_INVALID: " + status + " cannot schedule a retry");
        }
        if (retryCount >= maxRetries) {
            throw new IllegalStateException("STT_JOB_RETRY_BUDGET_EXCEEDED: retry budget is exhausted");
        }
        return new AvTranscriptionJob(
                jobId, artifactId, tenantId, languageCode, JobStatus.RETRY_PENDING, parameters,
                resultId, errorMessage, progressPercent, createdAt, startedAt, completedAt,
                retryCount + 1, maxRetries, traceId, requestId, processorVersion);
    }

    /** Completes an active or reconciling job with the immutable transcript version that was persisted. */
    public AvTranscriptionJob withCompletedResult(String immutableTranscriptVersionId) {
        if (immutableTranscriptVersionId == null || immutableTranscriptVersionId.isBlank()) {
            throw new IllegalArgumentException("STT_JOB_RESULT_VERSION_REQUIRED: transcript version must be present");
        }
        if (status == JobStatus.COMPLETED) {
            if (immutableTranscriptVersionId.equals(resultId)) return this;
            throw new IllegalStateException("STT_JOB_RESULT_VERSION_CONFLICT: completed result version is immutable");
        }
        if (isTerminal() || !transitionAllowed(status, JobStatus.COMPLETED)) {
            throw new IllegalStateException("STT_JOB_TRANSITION_INVALID: " + status + " cannot complete");
        }
        Instant now = Instant.now();
        Instant newStartedAt = startedAt == null ? now : startedAt;
        return new AvTranscriptionJob(
                jobId, artifactId, tenantId, languageCode, JobStatus.COMPLETED, parameters,
                immutableTranscriptVersionId, errorMessage, progressPercent, createdAt,
                newStartedAt, now, retryCount, maxRetries, traceId, requestId, processorVersion);
    }

    private static boolean transitionAllowed(JobStatus from, JobStatus to) {
        return switch (from) {
            case CREATED -> to == JobStatus.QUEUED || to == JobStatus.PROCESSING
                    || to == JobStatus.FAILED || to == JobStatus.CANCELLED;
            case QUEUED -> to == JobStatus.PROCESSING || to == JobStatus.FAILED || to == JobStatus.CANCELLED;
            case PROCESSING -> to == JobStatus.OUTCOME_UNKNOWN || to == JobStatus.RECONCILING
                    || to == JobStatus.COMPLETED || to == JobStatus.FAILED || to == JobStatus.CANCELLED;
            case RETRY_PENDING, RETRYING -> to == JobStatus.PROCESSING
                    || to == JobStatus.FAILED || to == JobStatus.CANCELLED;
            case OUTCOME_UNKNOWN -> to == JobStatus.RECONCILING;
            case RECONCILING -> to == JobStatus.COMPLETED
                    || to == JobStatus.FAILED || to == JobStatus.CANCELLED;
            case COMPLETED, FAILED, CANCELLED -> false;
        };
    }

    /** Returns true if the job is in a terminal state. */
    public boolean isTerminal() {
        return status == JobStatus.COMPLETED || status == JobStatus.FAILED || status == JobStatus.CANCELLED;
    }
}
