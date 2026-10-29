package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.audio.video.multimodal.grpc.proto.CanonicalOperationBinding;
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MultimodalOperationSpec;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadSession;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.Callable;

/**
 * Production canonical operation executor for the multimodal gRPC boundary.
 *
 * <p>For each RPC it materializes a durable {@link MultimodalOperationSpec} — resolving
 * inline payloads through the canonical authenticated artifact-upload path first — then
 * submits exactly one parent MULTIMODAL job through the runtime's authenticated port and
 * awaits its durable terminal state. The submitted operation, its children and its
 * outcome are reconstructible from durable state alone; a transport timeout surfaces
 * {@link CanonicalOperationUnknownException} carrying the stable job id so the caller can
 * reconcile by identity rather than resubmitting blindly.</p>
 *
 * @doc.type class
 * @doc.purpose Durable multimodal operation submission and bounded terminal readback
 * @doc.layer product
 * @doc.pattern Executor, Adapter
 */
public final class MediaCanonicalOperationExecutor implements CanonicalOperationExecutor {
    private static final Logger LOG = LoggerFactory.getLogger(MediaCanonicalOperationExecutor.class);
    private static final Duration DEFAULT_OPERATION_DEADLINE = Duration.ofMinutes(3);
    private static final Duration DEFAULT_POLL_INTERVAL = Duration.ofMillis(100);
    private static final int UPLOAD_CHUNK_BYTES = 256 * 1024;
    private static final Duration UPLOAD_RETENTION = Duration.ofDays(1);

    private final MediaProcessingRuntimePort port;
    private final Duration operationDeadline;
    private final Duration pollInterval;
    private final Clock clock;

    public MediaCanonicalOperationExecutor(MediaProcessingRuntimePort port) {
        this(port, DEFAULT_OPERATION_DEADLINE, DEFAULT_POLL_INTERVAL, Clock.systemUTC());
    }

    MediaCanonicalOperationExecutor(
            MediaProcessingRuntimePort port,
            Duration operationDeadline,
            Duration pollInterval,
            Clock clock) {
        this.port = Objects.requireNonNull(port, "port");
        this.operationDeadline = Objects.requireNonNull(operationDeadline, "operationDeadline");
        this.pollInterval = Objects.requireNonNull(pollInterval, "pollInterval");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    /** A raw closure is never the operation; production dispatch requires the typed plan. */
    @Override
    public <T> T execute(CanonicalOperationBinding binding, String operationRef, Callable<T> action) {
        throw new UnsupportedOperationException(
                "Production multimodal execution requires a durable typed operation, not a callable");
    }

    @Override
    public <T> T execute(
            CanonicalOperationBinding binding,
            String operationRef,
            CanonicalOperation<T> operation,
            AuthenticatedPrincipal authenticated) throws Exception {
        Objects.requireNonNull(binding, "binding");
        Objects.requireNonNull(operation, "operation");
        Objects.requireNonNull(authenticated, "authenticated");
        CanonicalOperationPlan plan = Objects.requireNonNull(operation.plan(), "operation plan");
        if (plan.children().isEmpty()) {
            throw new IllegalArgumentException(
                    "canonical multimodal operation requires at least one modality child");
        }
        List<MultimodalOperationSpec.ChildOperationSpec> children =
                resolveChildren(plan, authenticated);
        MultimodalOperationSpec spec = new MultimodalOperationSpec(
                MultimodalOperationSpec.SPEC_VERSION,
                plan.capabilityRef(),
                operationRef,
                Math.max(1, binding.getOperationVersion()),
                binding.getSourceArtifactId(),
                binding.getSourceVersionId(),
                sourceSha256(binding, authenticated),
                children,
                plan.sourceClock(),
                Map.of("purpose", binding.getPurpose()));
        Map<String, Object> parameters = new LinkedHashMap<>();
        parameters.put(MultimodalOperationSpec.PARAMETERS_KEY, spec.toParametersValue());
        ProcessingJobRequest jobRequest = new ProcessingJobRequest(
                binding.getRequestId(),
                authenticated.tenantId(),
                authenticated.principalId(),
                binding.getCorrelationId().isBlank() ? binding.getRequestId() : binding.getCorrelationId(),
                spec.sourceArtifactId(),
                spec.sourceVersion(),
                JobType.MULTIMODAL,
                "",
                parameters,
                governanceFor(binding));
        ProcessingJob submitted = port.submit(jobRequest, authenticated);
        LOG.debug("Multimodal operation submitted jobId={} requestId={}",
                submitted.jobId(), submitted.requestId());
        CanonicalOperationOutcome outcome = awaitTerminal(
                authenticated, submitted.jobId(), clock.instant().plus(operationDeadline));
        if (outcome.status() == JobStatus.OUTCOME_UNKNOWN) {
            throw new CanonicalOperationUnknownException(submitted.jobId());
        }
        if (outcome.status() == JobStatus.FAILED || outcome.status() == JobStatus.CANCELLED) {
            return operation.fuse(CanonicalOperationOutcome.failed(
                    submitted.jobId(), outcome.failureCode()));
        }
        return operation.fuse(
                CanonicalOperationOutcome.completed(submitted.jobId(), outcome.result()));
    }

    private List<MultimodalOperationSpec.ChildOperationSpec> resolveChildren(
            CanonicalOperationPlan plan, AuthenticatedPrincipal authenticated) {
        List<MultimodalOperationSpec.ChildOperationSpec> children =
                new ArrayList<>(plan.children().size());
        for (CanonicalChildSelection selection : plan.children()) {
            MediaArtifact artifact = selection.inlineSource().length > 0
                    ? ingest(selection, authenticated)
                    : port.artifact(authenticated.tenantId(), authenticated.principalId(),
                                    selection.artifactId())
                            .orElseThrow(() -> new IllegalArgumentException(
                                    "multimodal child source artifact is unavailable: "
                                            + selection.artifactId()));
            children.add(new MultimodalOperationSpec.ChildOperationSpec(
                    selection.childKey(), selection.jobType(), artifact.artifactId(),
                    artifact.version().value(), artifact.sha256(),
                    selection.providerHint(), selection.parameters()));
        }
        return children;
    }

    /**
     * Ingests an inline payload through the canonical authenticated artifact upload path.
     * The deterministic idempotency key binds the upload to the exact operation request
     * and content digest, so a retried RPC reuses the same immutable artifact.
     */
    private MediaArtifact ingest(CanonicalChildSelection selection, AuthenticatedPrincipal authenticated) {
        byte[] bytes = selection.inlineSource();
        String sha256 = sha256Hex(bytes);
        Map<String, Object> metadata = Map.of("purpose", "multimodal-operation-ingest");
        UploadRequest uploadRequest = new UploadRequest(
                authenticated.tenantId(), authenticated.principalId(),
                selection.childKey() + "-source", selection.inlineContentType(),
                bytes.length, sha256, "CONFIDENTIAL", UPLOAD_RETENTION, metadata);
        String idempotencyKey = "mm-upload:" + sha256;
        UploadSession session = port.beginUpload(uploadRequest, idempotencyKey, authenticated);
        int chunks = Math.max(1, (bytes.length + UPLOAD_CHUNK_BYTES - 1) / UPLOAD_CHUNK_BYTES);
        for (int index = 0; index < chunks; index++) {
            int offset = index * UPLOAD_CHUNK_BYTES;
            int length = Math.min(UPLOAD_CHUNK_BYTES, bytes.length - offset);
            byte[] chunk = java.util.Arrays.copyOfRange(bytes, offset, offset + length);
            session = port.appendUploadChunk(authenticated, session.uploadId(), index, chunk);
        }
        return port.completeUpload(authenticated, session.uploadId());
    }

    private String sourceSha256(CanonicalOperationBinding binding, AuthenticatedPrincipal authenticated) {
        MediaArtifact source = port.artifact(
                        authenticated.tenantId(), authenticated.principalId(),
                        binding.getSourceArtifactId())
                .orElseThrow(() -> new IllegalArgumentException(
                        "multimodal source artifact is unavailable: " + binding.getSourceArtifactId()));
        if (!source.version().value().equals(binding.getSourceVersionId())) {
            throw new IllegalArgumentException(
                    "multimodal source artifact version does not match the operation binding");
        }
        return source.sha256();
    }

    /**
     * Bounded gateway await: polls the durable job readback until a terminal state or the
     * deadline. A timeout is UNKNOWN, and the caller retains the stable job identity for
     * later exact reconciliation — the response is never fabricated.
     */
    private CanonicalOperationOutcome awaitTerminal(
            AuthenticatedPrincipal authenticated, String jobId, Instant deadline)
            throws InterruptedException {
        while (true) {
            ProcessingJob current = port.job(
                            authenticated.tenantId(), authenticated.principalId(), jobId)
                    .orElseThrow(() -> new IllegalStateException(
                            "multimodal parent job is not readable by its principal"));
            switch (current.status()) {
                case COMPLETED:
                    return CanonicalOperationOutcome.completed(jobId, current.result());
                case FAILED:
                case CANCELLED:
                    return new CanonicalOperationOutcome(
                            jobId, current.status(), Map.of(), current.failureCode());
                case OUTCOME_UNKNOWN:
                    return CanonicalOperationOutcome.unknown(jobId);
                default:
                    break;
            }
            if (!clock.instant().isBefore(deadline)) {
                return CanonicalOperationOutcome.unknown(jobId);
            }
            Thread.sleep(pollInterval.toMillis());
        }
    }

    private static com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext
            governanceFor(CanonicalOperationBinding binding) {
        return new com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext(
                "", binding.getPurpose(),
                com.ghatana.media.runtime.MediaRuntimeContracts.DataClassification.CONFIDENTIAL,
                "unspecified", java.util.Set.of(), false, "service-default", false, false, "",
                com.ghatana.media.runtime.MediaRuntimeContracts.BiometricSensitivity.NONE,
                com.ghatana.media.runtime.MediaRuntimeContracts.AutomationRisk.ASSISTIVE);
    }

    private static String sha256Hex(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                    .digest(bytes));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }
}

/** The parent job exists durably but its outcome cannot be established within the bound. */
final class CanonicalOperationUnknownException extends Exception {
    private final String jobId;
    CanonicalOperationUnknownException(String jobId) {
        super("MULTIMODAL_OPERATION_OUTCOME_UNKNOWN jobId=" + jobId
                + ": reconcile by exact job identity, do not resubmit");
        this.jobId = jobId;
    }
    String jobId() { return jobId; }
}
