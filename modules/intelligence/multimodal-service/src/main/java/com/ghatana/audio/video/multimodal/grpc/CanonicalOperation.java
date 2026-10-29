package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MultimodalOperationSpec;

import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;

/**
 * Typed canonical operation declaration used by the production dispatcher. The plan is
 * durable and serializable — every child source is either an existing artifact reference
 * or an inline payload that must first pass the canonical artifact upload/rights path.
 * The fixture callable is a same-process test seam only and is never invoked by the
 * production executor.
 */
interface CanonicalOperation<T> {
    CanonicalOperationPlan plan();

    /** Test-seam fallback invoked only by fixture executors. */
    Callable<T> fixtureAction();

    /** Fuses a durably grounded parent outcome into the RPC response projection. */
    T fuse(CanonicalOperationOutcome outcome) throws Exception;
}

/** Serializable operation plan: capability + per-child source selections + source clock. */
record CanonicalOperationPlan(
        String capabilityRef,
        List<CanonicalChildSelection> children,
        MultimodalOperationSpec.SourceClockBinding sourceClock) {
    CanonicalOperationPlan {
        capabilityRef = java.util.Objects.requireNonNull(capabilityRef, "capabilityRef");
        children = List.copyOf(java.util.Objects.requireNonNull(children, "children"));
    }
}

/** One child source selection: an artifact reference or inline bytes for canonical ingest. */
record CanonicalChildSelection(
        String childKey,
        JobType jobType,
        String artifactId,
        byte[] inlineSource,
        String inlineContentType,
        String providerHint,
        Map<String, Object> parameters) {
    CanonicalChildSelection {
        childKey = java.util.Objects.requireNonNull(childKey, "childKey");
        jobType = java.util.Objects.requireNonNull(jobType, "jobType");
        artifactId = artifactId == null ? "" : artifactId;
        inlineSource = inlineSource == null ? new byte[0] : inlineSource.clone();
        inlineContentType = inlineContentType == null ? "application/octet-stream" : inlineContentType;
        providerHint = providerHint == null ? "" : providerHint;
        parameters = Map.copyOf(parameters == null ? Map.of() : parameters);
        if (artifactId.isBlank() == (inlineSource.length == 0)) {
            throw new IllegalArgumentException(
                    "child selection requires exactly one of artifact reference or inline source");
        }
    }
    @Override public byte[] inlineSource() { return inlineSource.clone(); }
}

/** Durably grounded outcome of the parent multimodal job presented to the fusion step. */
record CanonicalOperationOutcome(
        String jobId, JobStatus status, Map<String, Object> result, String failureCode) {
    CanonicalOperationOutcome {
        jobId = java.util.Objects.requireNonNull(jobId, "jobId");
        status = java.util.Objects.requireNonNull(status, "status");
        result = Map.copyOf(result == null ? Map.of() : result);
        failureCode = failureCode == null ? "" : failureCode;
    }
    static CanonicalOperationOutcome completed(String jobId, Map<String, Object> result) {
        return new CanonicalOperationOutcome(jobId, JobStatus.COMPLETED, result, "");
    }
    static CanonicalOperationOutcome failed(String jobId, String failureCode) {
        return new CanonicalOperationOutcome(jobId, JobStatus.FAILED, Map.of(), failureCode);
    }
    static CanonicalOperationOutcome unknown(String jobId) {
        return new CanonicalOperationOutcome(jobId, JobStatus.OUTCOME_UNKNOWN, Map.of(), "");
    }
}
