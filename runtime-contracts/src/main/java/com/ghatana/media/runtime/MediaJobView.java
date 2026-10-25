package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaLifecycleProjection.LogicalJobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;

import java.time.Instant;
import java.util.Map;

/**
 * Read-observation of a {@link ProcessingJob} that exposes both the persisted durable status and
 * the PDP-1 logical lifecycle status projected by {@link MediaLifecycleProjection}.
 *
 * <p>{@code status} remains the exact durable value for compatibility; {@code logicalStatus} is the
 * lossless projection. The two disagree wherever a logical state has no durable representation
 * (e.g. durable {@code ACCEPTED} reads as logical {@code QUEUED}), which is the point of carrying
 * both — a consumer never has to guess whether {@code ACCEPTED} means queued, retry-pending or
 * reconciling.</p>
 *
 * @doc.type record
 * @doc.purpose Job read payload carrying durable status plus projected logical status
 * @doc.layer product
 * @doc.pattern ReadModel
 */
public record MediaJobView(
        String jobId,
        String requestId,
        String tenantId,
        String principalId,
        String artifactId,
        JobType jobType,
        String providerId,
        JobStatus status,
        LogicalJobStatus logicalStatus,
        Instant createdAt,
        Instant startedAt,
        Instant completedAt,
        Map<String, Object> result,
        String failureCode,
        long version,
        String expectedArtifactVersion,
        String requestFingerprint) {

    public MediaJobView {
        java.util.Objects.requireNonNull(status, "status");
        java.util.Objects.requireNonNull(logicalStatus, "logicalStatus");
        result = Map.copyOf(result == null ? Map.of() : result);
    }

    public static MediaJobView of(ProcessingJob job, LogicalJobStatus logicalStatus) {
        java.util.Objects.requireNonNull(job, "job");
        return new MediaJobView(
                job.jobId(), job.requestId(), job.tenantId(), job.principalId(), job.artifactId(),
                job.jobType(), job.providerId(), job.status(), logicalStatus,
                job.createdAt(), job.startedAt(), job.completedAt(), job.result(), job.failureCode(),
                job.version(), job.expectedArtifactVersion(), job.requestFingerprint());
    }
}
