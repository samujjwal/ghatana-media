package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobAttempt;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobAttemptStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;

/**
 * Truthful projection from Media's durable job/attempt records onto the PDP-1 logical lifecycle
 * models (`media-job` nine states, `media-attempt` ten states).
 *
 * <p>The durable store intentionally persists a narrower state set; the richer logical states are
 * always derived from recorded evidence, never assumed. Callers must supply the facts they actually
 * observed — when evidence is absent the projection returns the conservative durable-equivalent
 * status rather than an invented intermediate state.</p>
 *
 * <p>Derivation rules:</p>
 * <ul>
 *   <li>{@code QUEUED}: job accepted, no current execution owner visible at read time.</li>
 *   <li>{@code RETRY_PENDING}: job RUNNING, latest attempt durably FAILED, and the caller has
 *       evidence that bounded retry authority remains. Never produced without all three.</li>
 *   <li>{@code RECONCILING}: job OUTCOME_UNKNOWN and a provider/operator reconciliation pass is
 *       actively recorded in progress. Unknown is never silently claimed resolved.</li>
 *   <li>{@code PARTIALLY_SUCCEEDED}: job COMPLETED only with an explicitly recorded partial-output
 *       disposition. A completed job is never re-labeled partial without that evidence.</li>
 *   <li>{@code SUPERSEDED} (attempt): a non-terminal attempt whose fencing token is behind the
 *       current fence; its later writes cannot commit. Terminal attempt truth is preserved.</li>
 *   <li>{@code CANCEL_REQUESTED} (attempt): a non-terminal attempt on a job with a recorded
 *       cancellation request that has not reached provider/authority confirmation.</li>
 *   <li>{@code CANCEL_CONFIRMED} (attempt): any attempt whose cancellation reached authoritative
 *       confirmation; confirmation evidence outranks the durable failure bucket.</li>
 *   <li>{@code DISPATCHED} (attempt): dispatch intent durably recorded and a provider operation /
 *       receipt identity exists, meaning the request may have crossed the trust boundary.</li>
 *   <li>{@code CLAIMED} (attempt): a lease is held but no durable attempt record exists yet —
 *       produced by {@link #claimedAttempt()} for lease-only observations.</li>
 * </ul>
 *
 * @doc.type class
 * @doc.purpose Lossless logical lifecycle projection over the narrower durable job/attempt states
 * @doc.layer product
 * @doc.pattern Projection
 */
public final class MediaLifecycleProjection {

    /** Logical `media-job` overall status (PDP-1 state model). */
    public enum LogicalJobStatus {
        QUEUED, RUNNING, RETRY_PENDING, OUTCOME_UNKNOWN, RECONCILING,
        COMPLETED, PARTIALLY_SUCCEEDED, FAILED, CANCELLED
    }

    /** Logical `media-attempt` technical status (PDP-1 state model). */
    public enum LogicalAttemptStatus {
        CLAIMED, DISPATCH_INTENT_RECORDED, DISPATCHED, RUNNING, CANCEL_REQUESTED,
        SUCCEEDED, FAILED, CANCEL_CONFIRMED, OUTCOME_UNKNOWN, SUPERSEDED
    }

    /**
     * Evidence the caller durably observed about the job beyond the record itself. Every field
     * defaults to false so a caller without evidence gets the conservative durable-equivalent read.
     *
     * @param retryAuthorityRemaining bounded retry authority still exists for the latest failed
     *                                attempt (budget, policy and authority re-checked)
     * @param reconciliationActive a provider/owner reconciliation pass is durably in progress
     * @param partialDispositionRecorded a per-output partial disposition was durably recorded
     */
    public record JobFacts(
            boolean retryAuthorityRemaining,
            boolean reconciliationActive,
            boolean partialDispositionRecorded) {
        public static JobFacts none() {
            return new JobFacts(false, false, false);
        }
    }

    /**
     * Evidence the caller durably observed about an attempt beyond the record itself.
     *
     * @param dispatchMayHaveCrossedBoundary a persisted provider operation/receipt identity or
     *                                       equivalent boundary evidence exists for the attempt
     * @param cancellationRequested a job-level cancellation request is durably recorded and not yet
     *                              authoritatively resolved for this attempt
     * @param cancellationConfirmed the provider or local execution authority confirmed no further
     *                              mutation from this attempt
     * @param currentFenceToken the highest fencing token currently owning writes for the job
     */
    public record AttemptFacts(
            boolean dispatchMayHaveCrossedBoundary,
            boolean cancellationRequested,
            boolean cancellationConfirmed,
            long currentFenceToken) {
        public static AttemptFacts none() {
            return new AttemptFacts(false, false, false, 0L);
        }
        public AttemptFacts {
            if (currentFenceToken < 0) {
                throw new IllegalArgumentException("currentFenceToken cannot be negative");
            }
        }
    }

    private MediaLifecycleProjection() { }

    /**
     * Projects the logical job status. Terminal durable statuses are preserved exactly; a
     * partial disposition never hides behind {@code COMPLETED} and unknown work is never
     * reclassified resolved.
     */
    public static LogicalJobStatus projectJob(
            ProcessingJob job, JobAttempt latestAttempt, JobFacts facts) {
        java.util.Objects.requireNonNull(job, "job");
        JobFacts evidence = facts == null ? JobFacts.none() : facts;
        JobStatus durable = job.status();
        return switch (durable) {
            case COMPLETED -> evidence.partialDispositionRecorded()
                    ? LogicalJobStatus.PARTIALLY_SUCCEEDED : LogicalJobStatus.COMPLETED;
            case FAILED -> LogicalJobStatus.FAILED;
            case CANCELLED -> LogicalJobStatus.CANCELLED;
            case OUTCOME_UNKNOWN -> evidence.reconciliationActive()
                    ? LogicalJobStatus.RECONCILING : LogicalJobStatus.OUTCOME_UNKNOWN;
            case ACCEPTED -> LogicalJobStatus.QUEUED;
            case RUNNING -> (latestAttempt != null
                    && latestAttempt.status() == JobAttemptStatus.FAILED
                    && evidence.retryAuthorityRemaining())
                    ? LogicalJobStatus.RETRY_PENDING : LogicalJobStatus.RUNNING;
        };
    }

    /**
     * Projects the logical attempt status. A stale fence supersedes only non-terminal attempts —
     * a recorded terminal outcome remains the truth for that attempt.
     */
    public static LogicalAttemptStatus projectAttempt(JobAttempt attempt, AttemptFacts facts) {
        java.util.Objects.requireNonNull(attempt, "attempt");
        AttemptFacts evidence = facts == null ? AttemptFacts.none() : facts;
        if (evidence.cancellationConfirmed()) {
            return LogicalAttemptStatus.CANCEL_CONFIRMED;
        }
        boolean terminal = attempt.status() == JobAttemptStatus.COMPLETED
                || attempt.status() == JobAttemptStatus.FAILED
                || attempt.status() == JobAttemptStatus.OUTCOME_UNKNOWN;
        if (!terminal && attempt.fencingToken() < evidence.currentFenceToken()) {
            return LogicalAttemptStatus.SUPERSEDED;
        }
        return switch (attempt.status()) {
            case DISPATCH_INTENT -> evidence.dispatchMayHaveCrossedBoundary()
                    ? LogicalAttemptStatus.DISPATCHED : LogicalAttemptStatus.DISPATCH_INTENT_RECORDED;
            case RUNNING -> evidence.cancellationRequested()
                    ? LogicalAttemptStatus.CANCEL_REQUESTED : LogicalAttemptStatus.RUNNING;
            case COMPLETED -> LogicalAttemptStatus.SUCCEEDED;
            case FAILED -> LogicalAttemptStatus.FAILED;
            case OUTCOME_UNKNOWN -> LogicalAttemptStatus.OUTCOME_UNKNOWN;
        };
    }

    /**
     * A held lease before durable attempt persistence is the {@code CLAIMED} logical state.
     * Callers holding a {@code JobLease} with no attempt row use this constant rather than
     * inventing an attempt.
     */
    public static LogicalAttemptStatus claimedAttempt() {
        return LogicalAttemptStatus.CLAIMED;
    }
}
