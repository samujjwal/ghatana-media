/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionFailure;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.media.runtime.MediaCapabilityNotAdmittedException;
import com.ghatana.media.runtime.MediaDeploymentProfiles;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import io.activej.promise.Promise;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * Maps one validated Media agent tool call to exactly one canonical Media job and the job's
 * observed outcome back to a {@link ToolExecutionResult}. Nothing is self-admitted: no
 * model, voice, licence, consent or quality claim is made here, and the governance context
 * stays the runtime's conservative default so provider admission is decided by the runtime.
 *
 * <p>Tool identity is bound to an authenticated Media principal. In development profiles the
 * host supplies the DEV_ONLY signed identity; production-like profiles admit only a principal
 * verified by the configured OIDC identity provider ({@code AssuranceSource.OIDC_VERIFIED}), and
 * unknown profiles fail closed. The verified invoking principal is carried unchanged into job
 * submission; it is never replaced by a synthetic one.
 *
 * @doc.type class
 * @doc.purpose Tool-call to canonical Media job mapping
 * @doc.layer product
 * @doc.pattern Adapter
 */
public final class MediaToolJobBridge {

    public static final String SOURCE_VERSION_FIELD = "sourceArtifactVersion";
    public static final String IDENTITY_CONTRACT_UNAVAILABLE = "TOOLS_IDENTITY_CONTRACT_UNAVAILABLE";
    public static final String PRINCIPAL_REQUIRED = "AUTHENTICATED_PRINCIPAL_REQUIRED";
    public static final String PRINCIPAL_TENANT_MISMATCH = "PRINCIPAL_TENANT_MISMATCH";

    private final MediaJobSubmissionPort port;
    private final String deploymentProfile;

    public MediaToolJobBridge(MediaJobSubmissionPort port, String deploymentProfile) {
        this.port = Objects.requireNonNull(port, "port");
        this.deploymentProfile = MediaDeploymentProfiles.canonical(deploymentProfile);
    }

    /** Deterministic job request id derived from the durable invocation id. */
    public static String requestIdFor(String invocationId) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(invocationId.getBytes(StandardCharsets.UTF_8));
            return "agtool-" + HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    /** Typed validation failure for source-binding errors. */
    static ToolExecutionResult validationFailure(ToolExecutionEnvelope envelope, String code, Instant start) {
        Instant end = Instant.now();
        return ToolExecutionResult.failed(envelope.invocationId(),
                new ToolExecutionFailure(ToolExecutionFailure.Kind.VALIDATION,
                        ToolExecutionFailure.Stage.EXECUTION, code, false, end),
                envelope.invocationId(), end, Duration.between(start, end));
    }

    /** Runtime-readback adapter used by the binder to reconcile ambiguous submissions. */
    public MediaToolExecutionBinder.MediaJobReadback readback() {
        return (tenantId, invocationId) -> port.findByRequestId(tenantId, requestIdFor(invocationId))
                .map(job -> job.status().name());
    }

    Promise<ToolExecutionResult> submit(ToolExecutionEnvelope envelope, AuthenticatedPrincipal authenticated,
            JobType jobType, String artifactId, String sourceVersion, Map<String, Object> parameters,
            Instant start) {
        if (!MediaDeploymentProfiles.isSupported(deploymentProfile)) {
            return Promise.of(unavailable(envelope, IDENTITY_CONTRACT_UNAVAILABLE, start));
        }
        if (authenticated == null) {
            return Promise.of(unavailable(envelope, PRINCIPAL_REQUIRED, start));
        }
        // Production-like profiles admit only a principal that an OIDC identity provider verified at the host's
        // ingress. A synthetic, DEV-issued, shared-secret, local or unstated principal remains unavailable.
        if (MediaDeploymentProfiles.productionLike(deploymentProfile) && !authenticated.idpVerified()) {
            return Promise.of(unavailable(envelope, IDENTITY_CONTRACT_UNAVAILABLE, start));
        }
        if (!authenticated.tenantId().equals(envelope.tenantId())) {
            return Promise.of(denied(envelope, PRINCIPAL_TENANT_MISMATCH));
        }
        final ProcessingJobRequest request;
        try {
            request = new ProcessingJobRequest(requestIdFor(envelope.invocationId()), envelope.tenantId(),
                    authenticated.principalId(), envelope.invocationId(), artifactId, sourceVersion,
                    jobType, "", new HashMap<>(parameters));
        } catch (IllegalArgumentException invalid) {
            return Promise.of(validationFailure(envelope, "SOURCE_VERSION_INVALID", start));
        }
        final ProcessingJob job;
        try {
            job = port.submit(request, authenticated);
        } catch (MediaCapabilityNotAdmittedException refusal) {
            return Promise.of(refusal(envelope, refusal, start));
        } catch (RuntimeException ambiguous) {
            // Dispatch outcome is not established: stay on the error channel so the
            // binder keeps the UNKNOWN fence and reconciles via readback.
            return Promise.ofException(ambiguous);
        }
        if (job == null || !matches(request, job)) {
            return Promise.ofException(new IllegalStateException("MEDIA_JOB_IDENTITY_MISMATCH"));
        }
        return Promise.of(observed(envelope, job, start));
    }

    private static boolean matches(ProcessingJobRequest request, ProcessingJob job) {
        return request.requestId().equals(job.requestId())
                && request.tenantId().equals(job.tenantId())
                && request.principalId().equals(job.principalId())
                && request.artifactId().equals(job.artifactId())
                && request.jobType() == job.jobType()
                && request.expectedArtifactVersion().equals(job.expectedArtifactVersion());
    }

    private static ToolExecutionResult observed(ToolExecutionEnvelope envelope, ProcessingJob job, Instant start) {
        Instant end = Instant.now();
        Duration took = Duration.between(start, end);
        String id = envelope.invocationId();
        return switch (job.status()) {
            case COMPLETED -> {
                Map<String, Object> output = new HashMap<>();
                output.put("jobId", job.jobId());
                output.put("requestId", job.requestId());
                output.put("jobType", job.jobType().name());
                output.put("status", job.status().name());
                output.put("sourceArtifactId", job.artifactId());
                output.put("sourceArtifactVersion", job.expectedArtifactVersion());
                output.put("providerId", job.providerId());
                output.put("result", job.result());
                yield ToolExecutionResult.succeeded(id, Map.copyOf(output),
                        Map.of("mediaJobId", job.jobId()), id, end, took);
            }
            case ACCEPTED, RUNNING -> ToolExecutionResult.outcomeUnknown(id, job.jobId(), null, id,
                    "MEDIA_JOB_" + job.status().name(), end, took);
            case OUTCOME_UNKNOWN -> ToolExecutionResult.outcomeUnknown(id, job.jobId(), null, id,
                    "MEDIA_JOB_OUTCOME_UNKNOWN", end, took);
            case CANCELLED -> ToolExecutionResult.cancelled(id, ToolExecutionFailure.Stage.EXECUTION,
                    "MEDIA_JOB_CANCELLED", id, end, took);
            case FAILED -> ToolExecutionResult.failed(id,
                    new ToolExecutionFailure(ToolExecutionFailure.Kind.UNAVAILABLE,
                            ToolExecutionFailure.Stage.EXECUTION,
                            code(Optional.ofNullable(job.failureCode()).orElse(""), "MEDIA_JOB_FAILED"),
                            false, end),
                    id, end, took);
        };
    }

    private static ToolExecutionResult refusal(ToolExecutionEnvelope envelope,
            MediaCapabilityNotAdmittedException refusal, Instant start) {
        String code = "MEDIA_" + refusal.reason().name();
        if (refusal.reason() == MediaCapabilityNotAdmittedException.Reason.POLICY_DENIED) {
            return ToolExecutionResult.denied(envelope.invocationId(), code, Instant.now());
        }
        return unavailable(envelope, code, start);
    }

    private static ToolExecutionResult denied(ToolExecutionEnvelope envelope, String code) {
        return ToolExecutionResult.denied(envelope.invocationId(), code, Instant.now());
    }

    private static ToolExecutionResult unavailable(ToolExecutionEnvelope envelope, String code, Instant start) {
        Instant end = Instant.now();
        return ToolExecutionResult.failed(envelope.invocationId(),
                new ToolExecutionFailure(ToolExecutionFailure.Kind.UNAVAILABLE,
                        ToolExecutionFailure.Stage.ADMISSION, code, false, end),
                envelope.invocationId(), end, Duration.between(start, end));
    }

    private static String code(String candidate, String fallback) {
        String normalized = candidate.trim().toUpperCase(java.util.Locale.ROOT);
        return normalized.matches("^[A-Z][A-Z0-9_]{0,127}$") ? normalized : fallback;
    }
}
