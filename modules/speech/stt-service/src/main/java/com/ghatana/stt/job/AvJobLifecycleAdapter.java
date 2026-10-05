package com.ghatana.stt.job;

import com.ghatana.core.lifecycle.CanonicalJobRecord;
import com.ghatana.core.lifecycle.CanonicalJobStatus;

import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Adapter that projects Audio-Video transcription jobs onto the canonical
 * {@link CanonicalJobRecord} envelope (LJE-0004).
 *
 * <p>Enables cross-service job observability, audit pipelines, and lifecycle
 * dashboards to consume AV transcription jobs in the shared Bridge job contract
 * shape without importing AV internals.</p>
 *
 * <h3>Status mapping</h3>
 * <ul>
 *   <li>{@code CREATED} → {@code PENDING}</li>
 *   <li>{@code QUEUED} → {@code QUEUED}</li>
 *   <li>{@code PROCESSING} → {@code RUNNING}</li>
 *   <li>{@code COMPLETED} → {@code COMPLETED}</li>
 *   <li>{@code FAILED} → {@code FAILED}</li>
 *   <li>{@code CANCELLED} → {@code CANCELLED}</li>
 *   <li>{@code RETRYING} → {@code RETRYING}</li>
 * </ul>
 *
 * @doc.type class
 * @doc.purpose Project AV transcription jobs onto the canonical lifecycle contract envelope
 * @doc.layer product
 * @doc.pattern Adapter
 */
public final class AvJobLifecycleAdapter {

    private AvJobLifecycleAdapter() {
        // utility class
    }

    /**
     * Maps an AV {@link AvTranscriptionJob} to the canonical {@link CanonicalJobRecord} shape.
     *
     * @param job the AV transcription job
     * @return a canonical job record suitable for cross-service consumption
     */
    public static CanonicalJobRecord toCanonical(AvTranscriptionJob job) {
        Objects.requireNonNull(job, "job must not be null");

        Map<String, Object> input = new HashMap<>();
        if (job.parameters() != null) input.putAll(job.parameters());
        input.put("artifactId", job.artifactId());
        input.put("languageCode", job.languageCode());

        Map<String, Object> metadata = new HashMap<>();
        metadata.put("processorVersion", job.processorVersion());

        return new CanonicalJobRecord(
                job.jobId(),
                "media.transcribe",
                mapStatus(job.status()),
                job.tenantId(),
                job.requestId(),
                job.traceId(),
                job.createdAt(),
                job.startedAt(),
                job.completedAt(),
                job.progressPercent(),
                com.ghatana.core.json.StructuredMap.trusted(input),
                job.resultId(),
                job.resultId() != null ? "transcript" : null,
                null,
                job.errorMessage(),
                job.retryCount(),
                job.maxRetries(),
                java.util.List.of("speech-to-text", "audio"),
                com.ghatana.core.json.StructuredMap.trusted(metadata)
        );
    }

    /**
     * Maps canonical status back to AV local status.
     *
     * @param status canonical job status
     * @return AV local status, or null if unmapped
     */
    public static AvTranscriptionJob.JobStatus fromCanonical(CanonicalJobStatus status) {
        return switch (status) {
            case PENDING -> AvTranscriptionJob.JobStatus.CREATED;
            case QUEUED -> AvTranscriptionJob.JobStatus.QUEUED;
            case RUNNING -> AvTranscriptionJob.JobStatus.PROCESSING;
            case COMPLETED -> AvTranscriptionJob.JobStatus.COMPLETED;
            case FAILED -> AvTranscriptionJob.JobStatus.FAILED;
            case CANCELLED -> AvTranscriptionJob.JobStatus.CANCELLED;
            case RETRYING -> AvTranscriptionJob.JobStatus.RETRYING;
            default -> null;
        };
    }

    private static CanonicalJobStatus mapStatus(AvTranscriptionJob.JobStatus status) {
        return switch (status) {
            case CREATED -> CanonicalJobStatus.PENDING;
            case QUEUED -> CanonicalJobStatus.QUEUED;
            case PROCESSING -> CanonicalJobStatus.RUNNING;
            case COMPLETED -> CanonicalJobStatus.COMPLETED;
            case FAILED -> CanonicalJobStatus.FAILED;
            case CANCELLED -> CanonicalJobStatus.CANCELLED;
            case RETRYING -> CanonicalJobStatus.RETRYING;
        };
    }
}
