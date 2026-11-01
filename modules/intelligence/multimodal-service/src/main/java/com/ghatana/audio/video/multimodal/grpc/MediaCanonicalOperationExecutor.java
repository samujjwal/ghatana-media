package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.audio.video.multimodal.grpc.proto.CanonicalOperationBinding;
import com.ghatana.media.runtime.MediaCapabilityNotAdmittedException;
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
 * outcome are reconstructible from durable state once the parent is submitted. A
 * transport timeout surfaces {@link CanonicalOperationUnknownException}; a known
 * parent job id is included when available. An ambiguous earlier inline upload may
 * have no parent id and needs separate upload reconciliation before retry.</p>
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
        // Resolve and version-check the caller's canonical source before ingesting any
        // inline child payload. Otherwise a stale/mismatched source binding can leave
        // durable child artifacts behind even though the parent operation is refused.
        MediaArtifact source = sourceArtifact(binding, authenticated);
        MultimodalOperationSpec.SourceClockBinding sourceClock = sourceClockBinding(plan, source);
        var governance = governanceFor(binding);
        // Resolve every referenced child before the first inline upload. A missing later
        // reference must not leave earlier inline children durably ingested.
        List<MediaArtifact> referencedChildren = resolveReferencedChildren(plan, authenticated);
        InlineUploadAttempt uploadAttempt = new InlineUploadAttempt();
        final ProcessingJobRequest jobRequest;
        try {
            List<MultimodalOperationSpec.ChildOperationSpec> children =
                    resolveChildren(plan, authenticated, referencedChildren, uploadAttempt);
            MultimodalOperationSpec spec = new MultimodalOperationSpec(
                    MultimodalOperationSpec.SPEC_VERSION,
                    plan.capabilityRef(),
                    operationRef,
                    Math.max(1, binding.getOperationVersion()),
                    binding.getSourceArtifactId(),
                    binding.getSourceVersionId(),
                    source.sha256(),
                    children,
                    sourceClock,
                    Map.of("purpose", binding.getPurpose()));
            Map<String, Object> parameters = new LinkedHashMap<>();
            parameters.put(MultimodalOperationSpec.PARAMETERS_KEY, spec.toParametersValue());
            jobRequest = new ProcessingJobRequest(
                    binding.getRequestId(),
                    authenticated.tenantId(),
                    authenticated.principalId(),
                    binding.getCorrelationId().isBlank() ? binding.getRequestId() : binding.getCorrelationId(),
                    spec.sourceArtifactId(),
                    spec.sourceVersion(),
                    JobType.MULTIMODAL,
                    "",
                    parameters,
                    governance);
        } catch (RuntimeException failureAfterUploadAttempt) {
            if (uploadAttempt.started) {
                throw new CanonicalOperationUnknownException(null, failureAfterUploadAttempt);
            }
            throw failureAfterUploadAttempt;
        }
        // Before any inline upload, validation/refusal is provably effect-free. Once an
        // upload attempt starts, even parent-job rejection may leave a durable child
        // artifact; report UNKNOWN so callers do not blindly repeat the operation.
        final ProcessingJob submitted;
        try {
            submitted = port.submit(jobRequest, authenticated);
        } catch (MediaCapabilityNotAdmittedException | IllegalArgumentException provenNoEffect) {
            if (uploadAttempt.started) {
                throw new CanonicalOperationUnknownException(null, provenNoEffect);
            }
            throw provenNoEffect;
        } catch (RuntimeException ambiguous) {
            throw new CanonicalOperationUnknownException(null, ambiguous);
        }
        LOG.debug("Multimodal operation submitted jobId={} requestId={}",
                submitted.jobId(), submitted.requestId());
        final CanonicalOperationOutcome outcome;
        try {
            outcome = awaitTerminal(
                    authenticated, submitted.jobId(), clock.instant().plus(operationDeadline));
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new CanonicalOperationUnknownException(submitted.jobId(), interrupted);
        } catch (RuntimeException postSubmit) {
            throw new CanonicalOperationUnknownException(submitted.jobId(), postSubmit);
        }
        if (outcome.status() == JobStatus.OUTCOME_UNKNOWN) {
            throw new CanonicalOperationUnknownException(submitted.jobId());
        }
        if (outcome.status() == JobStatus.FAILED || outcome.status() == JobStatus.CANCELLED) {
            return operation.fuse(new CanonicalOperationOutcome(
                    submitted.jobId(), outcome.status(), Map.of(), outcome.failureCode()));
        }
        return operation.fuse(
                CanonicalOperationOutcome.completed(submitted.jobId(), outcome.result()));
    }

    private List<MediaArtifact> resolveReferencedChildren(
            CanonicalOperationPlan plan, AuthenticatedPrincipal authenticated) {
        List<MediaArtifact> referencedChildren = new ArrayList<>(plan.children().size());
        for (CanonicalChildSelection selection : plan.children()) {
            if (selection.inlineSource().length > 0) {
                referencedChildren.add(null);
            } else {
                MediaArtifact artifact = port.artifact(
                                authenticated.tenantId(), authenticated.principalId(), selection.artifactId())
                        .orElseThrow(() -> new IllegalArgumentException(
                                "multimodal child source artifact is unavailable: "
                                        + selection.artifactId()));
                referencedChildren.add(artifact);
            }
        }
        return referencedChildren;
    }

    private List<MultimodalOperationSpec.ChildOperationSpec> resolveChildren(
            CanonicalOperationPlan plan, AuthenticatedPrincipal authenticated,
            List<MediaArtifact> referencedChildren, InlineUploadAttempt uploadAttempt) {
        List<MultimodalOperationSpec.ChildOperationSpec> children =
                new ArrayList<>(plan.children().size());
        for (int index = 0; index < plan.children().size(); index++) {
            CanonicalChildSelection selection = plan.children().get(index);
            MediaArtifact artifact = selection.inlineSource().length > 0
                    ? ingest(selection, authenticated, uploadAttempt)
                    : referencedChildren.get(index);
            children.add(new MultimodalOperationSpec.ChildOperationSpec(
                    selection.childKey(), selection.jobType(), artifact.artifactId(),
                    artifact.version().value(), artifact.sha256(),
                    selection.providerHint(), selection.parameters()));
        }
        return children;
    }

    /**
     * Ingests an inline payload through the canonical authenticated artifact upload path.
     * The deterministic upload idempotency key incorporates the content digest.
     * An ambiguous upload still requires reconciliation before retry; this key
     * alone does not establish a parent operation or its outcome.
     */
    private MediaArtifact ingest(CanonicalChildSelection selection, AuthenticatedPrincipal authenticated,
                                InlineUploadAttempt uploadAttempt) {
        byte[] bytes = selection.inlineSource();
        String sha256 = sha256Hex(bytes);
        Map<String, Object> metadata = Map.of("purpose", "multimodal-operation-ingest");
        UploadRequest uploadRequest = new UploadRequest(
                authenticated.tenantId(), authenticated.principalId(),
                selection.childKey() + "-source", selection.inlineContentType(),
                bytes.length, sha256, "CONFIDENTIAL", UPLOAD_RETENTION, metadata);
        String idempotencyKey = "mm-upload:" + sha256;
        // From this boundary onward begin/append/complete may have committed even if the
        // transport reports an exception, so retries must first reconcile the effect.
        uploadAttempt.started = true;
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

    private static final class InlineUploadAttempt {
        private boolean started;
    }

    private MediaArtifact sourceArtifact(
            CanonicalOperationBinding binding, AuthenticatedPrincipal authenticated) {
        MediaArtifact source = port.artifact(
                        authenticated.tenantId(), authenticated.principalId(),
                        binding.getSourceArtifactId())
                .orElseThrow(() -> new IllegalArgumentException(
                        "multimodal source artifact is unavailable: " + binding.getSourceArtifactId()));
        if (!source.version().value().equals(binding.getSourceVersionId())) {
            throw new IllegalArgumentException(
                    "multimodal source artifact version does not match the operation binding");
        }
        return source;
    }

    /**
     * Binds the operation to the source clock declared by the immutable artifact's own
     * metadata — never to caller-supplied fields. A declared but malformed clock fails
     * closed; an artifact without a declared clock leaves the binding to the plan seam
     * (null in production) and grounding stays {@code SYNC_UNDETERMINED}.
     */
    private static MultimodalOperationSpec.SourceClockBinding sourceClockBinding(
            CanonicalOperationPlan plan, MediaArtifact source) {
        Map<String, Object> metadata = source.metadata();
        Object evidenceRef = metadata.get("sourceClockMappingEvidenceRef");
        Object ticksPerSecond = metadata.get("sourceClockTicksPerSecond");
        if (evidenceRef == null && ticksPerSecond == null) {
            return plan.sourceClock();
        }
        if (!(evidenceRef instanceof String ref) || ref.isBlank()) {
            throw new IllegalArgumentException(
                    "source artifact clock mapping evidence is missing or malformed");
        }
        long ticks = positiveMetadataLong(ticksPerSecond, "sourceClockTicksPerSecond");
        String clockId = metadata.get("sourceClockId") instanceof String id ? id : "";
        long epochOffset = metadata.get("sourceClockEpochOffsetTicks") == null
                ? 0 : nonnegativeMetadataLong(
                        metadata.get("sourceClockEpochOffsetTicks"), "sourceClockEpochOffsetTicks");
        long duration = metadata.get("sourceDurationTicks") == null
                ? 0 : nonnegativeMetadataLong(
                        metadata.get("sourceDurationTicks"), "sourceDurationTicks");
        return new MultimodalOperationSpec.SourceClockBinding(
                ref, ticks, epochOffset, clockId, duration);
    }

    private static long positiveMetadataLong(Object value, String field) {
        long parsed = nonnegativeMetadataLong(value, field);
        if (parsed < 1) {
            throw new IllegalArgumentException("source artifact " + field + " is malformed");
        }
        return parsed;
    }

    private static long nonnegativeMetadataLong(Object value, String field) {
        if (!(value instanceof Number number) || !Double.isFinite(number.doubleValue())
                || number.doubleValue() != Math.rint(number.doubleValue())
                || number.doubleValue() < 0
                || number.doubleValue() > 9_007_199_254_740_991d) {
            throw new IllegalArgumentException("source artifact " + field + " is malformed");
        }
        return number.longValue();
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
        this(jobId, null);
    }
    CanonicalOperationUnknownException(String jobId, Throwable cause) {
        super("MULTIMODAL_OPERATION_OUTCOME_UNKNOWN"
                + (jobId == null ? "" : " jobId=" + jobId)
                + (jobId == null
                        ? ": a durable upload or operation effect may have started; reconcile when possible"
                        : ": reconcile by exact job identity")
                + "; do not resubmit blindly", cause);
        this.jobId = jobId;
    }
    String jobId() { return jobId; }
}
