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
                Map.of("diarization", "true"),
                "trace-1", "req-1", "whisper-3");

        CanonicalJobRecord canonical = AvJobLifecycleAdapter.toCanonical(job);

        assertThat(canonical.jobId()).isEqualTo(job.jobId());
        assertThat(canonical.jobType()).isEqualTo("media.transcribe");
        assertThat(canonical.status()).isEqualTo(CanonicalJobStatus.PENDING);
        assertThat(canonical.tenantId()).isEqualTo("tenant-1");
        assertThat(canonical.input()).containsEntry("languageCode", "ne");
        assertThat(canonical.tags()).contains("speech-to-text");
    }

    @Test
    @DisplayName("maps completed job to canonical with result")
    void mapsCompletedJobToCanonical() {
        AvTranscriptionJob job = AvTranscriptionJob.create(
                "audio-2", "tenant-1", "en",
                Map.of(), "trace-2", "req-2", "whisper-3");
        job = job.withStatus(AvTranscriptionJob.JobStatus.COMPLETED);

        CanonicalJobRecord canonical = AvJobLifecycleAdapter.toCanonical(job);

        assertThat(canonical.status()).isEqualTo(CanonicalJobStatus.COMPLETED);
    }

    @Test
    @DisplayName("maps failed job to canonical")
    void mapsFailedJobToCanonical() {
        AvTranscriptionJob job = AvTranscriptionJob.create(
                "audio-3", "tenant-1", "en",
                Map.of(), "trace-3", "req-3", "whisper-3");
        job = job.withStatus(AvTranscriptionJob.JobStatus.FAILED);

        CanonicalJobRecord canonical = AvJobLifecycleAdapter.toCanonical(job);

        assertThat(canonical.status()).isEqualTo(CanonicalJobStatus.FAILED);
        assertThat(canonical.isTerminal()).isTrue();
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
    @DisplayName("retains canonical unknown and retry states without marking them terminal")
    void retainsCanonicalIntermediateStates() {
        AvTranscriptionJob job = AvTranscriptionJob.create(
                "audio-4", "tenant-1", "en", Map.of(), "trace-4", "req-4", "whisper-3")
                .withStatus(AvTranscriptionJob.JobStatus.OUTCOME_UNKNOWN);

        CanonicalJobRecord canonical = AvJobLifecycleAdapter.toCanonical(job);

        assertThat(canonical.status()).isEqualTo(CanonicalJobStatus.RUNNING);
        assertThat(canonical.metadata()).containsEntry("mediaCanonicalState", "OUTCOME_UNKNOWN");
        assertThat(canonical.isTerminal()).isFalse();
    }

    @Test
    @SuppressWarnings("deprecation")
    @DisplayName("preserves exact Media state across lossy shared-status projection")
    void preservesExactMediaStateAcrossSharedProjection() {
        Map<AvTranscriptionJob.JobStatus, CanonicalJobStatus> expectedSharedStatus =
                new EnumMap<>(AvTranscriptionJob.JobStatus.class);
        expectedSharedStatus.put(AvTranscriptionJob.JobStatus.CREATED, CanonicalJobStatus.PENDING);
        expectedSharedStatus.put(AvTranscriptionJob.JobStatus.QUEUED, CanonicalJobStatus.QUEUED);
        expectedSharedStatus.put(AvTranscriptionJob.JobStatus.PROCESSING, CanonicalJobStatus.RUNNING);
        expectedSharedStatus.put(AvTranscriptionJob.JobStatus.RETRY_PENDING, CanonicalJobStatus.RETRYING);
        expectedSharedStatus.put(AvTranscriptionJob.JobStatus.RETRYING, CanonicalJobStatus.RETRYING);
        expectedSharedStatus.put(AvTranscriptionJob.JobStatus.OUTCOME_UNKNOWN, CanonicalJobStatus.RUNNING);
        expectedSharedStatus.put(AvTranscriptionJob.JobStatus.RECONCILING, CanonicalJobStatus.RUNNING);
        expectedSharedStatus.put(AvTranscriptionJob.JobStatus.COMPLETED, CanonicalJobStatus.COMPLETED);
        expectedSharedStatus.put(AvTranscriptionJob.JobStatus.FAILED, CanonicalJobStatus.FAILED);
        expectedSharedStatus.put(AvTranscriptionJob.JobStatus.CANCELLED, CanonicalJobStatus.CANCELLED);

        assertThat(expectedSharedStatus).hasSize(AvTranscriptionJob.JobStatus.values().length);
        for (var entry : expectedSharedStatus.entrySet()) {
            AvTranscriptionJob job = AvTranscriptionJob.create(
                    "audio-state", "tenant-1", "en", Map.of(), "trace", "request", "processor")
                    .withStatus(entry.getKey());

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
}
