package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.audio.video.multimodal.grpc.proto.CanonicalOperationBinding;
import com.ghatana.media.runtime.MediaCapabilityNotAdmittedException;
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import io.grpc.Context;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
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

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CancellationException;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

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
    private static final int MAX_PORT_CALL_WORKERS = 8;
    private static final int PORT_CALL_QUEUE_CAPACITY = 64;
    /** Process-scoped bounded pool: executor instances created by service composition do not own threads. */
    private static final ThreadPoolExecutor PORT_CALL_WORKERS = createPortCallWorkers();

    private final MediaProcessingRuntimePort port;
    private final Duration operationDeadline;
    private final Duration pollInterval;
    private final ThreadPoolExecutor portCallWorkers;
    private final Runnable beforePortCallDispatch;

    public MediaCanonicalOperationExecutor(MediaProcessingRuntimePort port) {
        this(port, DEFAULT_OPERATION_DEADLINE, DEFAULT_POLL_INTERVAL, PORT_CALL_WORKERS);
    }

    MediaCanonicalOperationExecutor(
            MediaProcessingRuntimePort port, Duration operationDeadline, Duration pollInterval) {
        this(port, operationDeadline, pollInterval, PORT_CALL_WORKERS);
    }

    /** Package-private bounded-worker seam for deterministic saturation and cancellation tests. */
    MediaCanonicalOperationExecutor(
            MediaProcessingRuntimePort port,
            Duration operationDeadline,
            Duration pollInterval,
            ThreadPoolExecutor portCallWorkers) {
        this(port, operationDeadline, pollInterval, portCallWorkers, () -> { });
    }

    /** Package-private barrier seam for dispatch/deadline linearization tests. */
    MediaCanonicalOperationExecutor(
            MediaProcessingRuntimePort port,
            Duration operationDeadline,
            Duration pollInterval,
            ThreadPoolExecutor portCallWorkers,
            Runnable beforePortCallDispatch) {
        this.port = Objects.requireNonNull(port, "port");
        this.operationDeadline = Objects.requireNonNull(operationDeadline, "operationDeadline");
        this.pollInterval = Objects.requireNonNull(pollInterval, "pollInterval");
        this.portCallWorkers = Objects.requireNonNull(portCallWorkers, "portCallWorkers");
        this.beforePortCallDispatch = Objects.requireNonNull(beforePortCallDispatch, "beforePortCallDispatch");
        if (portCallWorkers.getQueue().remainingCapacity() == Integer.MAX_VALUE) {
            throw new IllegalArgumentException("port call worker queue must be bounded");
        }
        if (operationDeadline.isZero() || operationDeadline.isNegative()) {
            throw new IllegalArgumentException("operation deadline must be positive");
        }
        if (pollInterval.isZero() || pollInterval.isNegative()) {
            throw new IllegalArgumentException("poll interval must be positive");
        }
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
        OperationBudget budget = new OperationBudget(Context.current(), operationDeadline);
        CanonicalOperationPlan plan = Objects.requireNonNull(operation.plan(), "operation plan");
        if (plan.children().isEmpty()) {
            throw new IllegalArgumentException(
                    "canonical multimodal operation requires at least one modality child");
        }
        // Resolve and version-check the caller's canonical source before ingesting any
        // inline child payload. Otherwise a stale/mismatched source binding can leave
        // durable child artifacts behind even though the parent operation is refused.
        MediaArtifact source = sourceArtifact(binding, authenticated, budget);
        MultimodalOperationSpec.SourceClockBinding sourceClock = sourceClockBinding(plan, source);
        var governance = governanceFor(binding);
        // Resolve every referenced child before the first inline upload. A missing later
        // reference must not leave earlier inline children durably ingested.
        List<MediaArtifact> referencedChildren = resolveReferencedChildren(plan, authenticated, budget);
        InlineUploadAttempt uploadAttempt = new InlineUploadAttempt();
        final ProcessingJobRequest jobRequest;
        try {
            List<MultimodalOperationSpec.ChildOperationSpec> children =
                    resolveChildren(plan, authenticated, referencedChildren, uploadAttempt, budget);
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
            if (uploadAttempt.started.get()) {
                throw new CanonicalOperationUnknownException(null, failureAfterUploadAttempt);
            }
            throw failureAfterUploadAttempt;
        }
        // Before any inline upload, validation/refusal is provably effect-free. Once an
        // upload attempt starts, even parent-job rejection may leave a durable child
        // artifact; report UNKNOWN so callers do not blindly repeat the operation.
        final ProcessingJob submitted;
        try {
            submitted = portCall(budget, PortCallKind.SUBMIT, null, uploadAttempt.started.get(),
                    null, () -> port.submit(jobRequest, authenticated));
        } catch (MediaCapabilityNotAdmittedException | IllegalArgumentException provenNoEffect) {
            if (uploadAttempt.started.get()) {
                throw new CanonicalOperationUnknownException(null, provenNoEffect);
            }
            throw provenNoEffect;
        } catch (CanonicalOperationResourceExhaustedException saturated) {
            if (uploadAttempt.started.get()) {
                throw new CanonicalOperationUnknownException(null, saturated);
            }
            throw saturated;
        } catch (RuntimeException ambiguous) {
            throw new CanonicalOperationUnknownException(null, ambiguous);
        }
        LOG.debug("Multimodal operation submitted jobId={} requestId={}",
                submitted.jobId(), submitted.requestId());
        final CanonicalOperationOutcome outcome;
        try {
            outcome = awaitTerminal(authenticated, submitted.jobId(), budget);
        } catch (CanonicalOperationUnknownException unknown) {
            throw unknown;
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
        if (!budget.isActive()) {
            throw new CanonicalOperationUnknownException(submitted.jobId());
        }
        CanonicalOperationOutcome completed = CanonicalOperationOutcome.completed(
                submitted.jobId(), outcome.result());
        T fused = operation.fuse(completed);
        if (!budget.isActive()) {
            throw new CanonicalOperationUnknownException(submitted.jobId());
        }
        return fused;
    }

    private List<MediaArtifact> resolveReferencedChildren(
            CanonicalOperationPlan plan, AuthenticatedPrincipal authenticated, OperationBudget budget)
            throws CanonicalOperationUnknownException {
        List<MediaArtifact> referencedChildren = new ArrayList<>(plan.children().size());
        for (CanonicalChildSelection selection : plan.children()) {
            if (selection.inlineSource().length > 0) {
                referencedChildren.add(null);
            } else {
                MediaArtifact artifact = portCall(budget, PortCallKind.READ, null, false, null,
                        () -> port.artifact(authenticated.tenantId(), authenticated.principalId(),
                                selection.artifactId()))
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
            List<MediaArtifact> referencedChildren, InlineUploadAttempt uploadAttempt, OperationBudget budget)
            throws CanonicalOperationUnknownException {
        List<MultimodalOperationSpec.ChildOperationSpec> children =
                new ArrayList<>(plan.children().size());
        for (int index = 0; index < plan.children().size(); index++) {
            CanonicalChildSelection selection = plan.children().get(index);
            MediaArtifact artifact = selection.inlineSource().length > 0
                    ? ingest(selection, authenticated, uploadAttempt, budget)
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
                                 InlineUploadAttempt uploadAttempt, OperationBudget budget)
            throws CanonicalOperationUnknownException {
        budget.requireActive(PortCallKind.EFFECT, null, uploadAttempt.started.get());
        byte[] bytes = selection.inlineSource();
        String sha256 = sha256Hex(bytes);
        Map<String, Object> metadata = Map.of("purpose", "multimodal-operation-ingest");
        UploadRequest uploadRequest = new UploadRequest(
                authenticated.tenantId(), authenticated.principalId(),
                selection.childKey() + "-source", selection.inlineContentType(),
                bytes.length, sha256, "CONFIDENTIAL", UPLOAD_RETENTION, metadata);
        String idempotencyKey = "mm-upload:" + sha256;
        // Each call marks the upload as started at the worker dispatch boundary. Once any
        // upload call starts, cancellation/deadline requires reconciliation before replay.
        UploadSession session = portCall(budget, PortCallKind.EFFECT, null,
                uploadAttempt.started.get(), () -> uploadAttempt.started.set(true),
                () -> port.beginUpload(uploadRequest, idempotencyKey, authenticated));
        int chunks = Math.max(1, (bytes.length + UPLOAD_CHUNK_BYTES - 1) / UPLOAD_CHUNK_BYTES);
        for (int index = 0; index < chunks; index++) {
            int offset = index * UPLOAD_CHUNK_BYTES;
            int length = Math.min(UPLOAD_CHUNK_BYTES, bytes.length - offset);
            int chunkIndex = index;
            byte[] chunk = java.util.Arrays.copyOfRange(bytes, offset, offset + length);
            UploadSession priorSession = session;
            session = portCall(budget, PortCallKind.EFFECT, null,
                    uploadAttempt.started.get(), () -> uploadAttempt.started.set(true),
                    () -> port.appendUploadChunk(authenticated, priorSession.uploadId(), chunkIndex, chunk));
        }
        UploadSession completedSession = session;
        return portCall(budget, PortCallKind.EFFECT, null, uploadAttempt.started.get(),
                () -> uploadAttempt.started.set(true),
                () -> port.completeUpload(authenticated, completedSession.uploadId()));
    }

    private static final class InlineUploadAttempt {
        private final AtomicBoolean started = new AtomicBoolean();
    }

    private MediaArtifact sourceArtifact(
            CanonicalOperationBinding binding, AuthenticatedPrincipal authenticated, OperationBudget budget)
            throws CanonicalOperationUnknownException {
        MediaArtifact source = portCall(budget, PortCallKind.READ, null, false, null,
                () -> port.artifact(authenticated.tenantId(), authenticated.principalId(),
                        binding.getSourceArtifactId()))
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
            AuthenticatedPrincipal authenticated, String jobId, OperationBudget budget)
            throws CanonicalOperationUnknownException {
        while (true) {
            if (!budget.isActive()) return CanonicalOperationOutcome.unknown(jobId);
            ProcessingJob current = portCall(budget, PortCallKind.READBACK, jobId, false, null,
                    () -> port.job(authenticated.tenantId(), authenticated.principalId(), jobId))
                    .orElseThrow(() -> new IllegalStateException(
                            "multimodal parent job is not readable by its principal"));
            if (!budget.isActive()) return CanonicalOperationOutcome.unknown(jobId);
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
            long remainingNanos = budget.remainingNanos();
            if (remainingNanos <= 0) {
                return CanonicalOperationOutcome.unknown(jobId);
            }
            try {
                TimeUnit.NANOSECONDS.sleep(Math.min(safeToNanos(pollInterval), remainingNanos));
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new CanonicalOperationUnknownException(jobId, interrupted);
            }
        }
    }

    /**
     * Calls a synchronous runtime-port method away from the gRPC caller thread. The caller
     * stops waiting at the effective deadline even when an implementation ignores interrupt;
     * such a late result is never observed as the operation's success.
     */
    private <T> T portCall(
            OperationBudget budget,
            PortCallKind kind,
            String jobId,
            boolean priorEffectStarted,
            Runnable onDispatch,
            Callable<T> action) throws CanonicalOperationUnknownException {
        budget.requireActive(kind, jobId, priorEffectStarted);
        PortCallDispatchGate dispatchGate = new PortCallDispatchGate();
        final Future<T> future;
        try {
            future = portCallWorkers.submit(budget.context.wrap(() -> {
                if (!budget.isActive()) {
                    dispatchGate.closeBeforeDispatch();
                    throwCallOutcome(budget.context, kind, jobId,
                            dispatchGate.dispatched(), priorEffectStarted, null);
                }
                beforePortCallDispatch.run();
                if (!dispatchGate.tryDispatch()) {
                    throwCallOutcome(budget.context, kind, jobId,
                            dispatchGate.dispatched(), priorEffectStarted, null);
                }
                if (onDispatch != null) onDispatch.run();
                return action.call();
            }));
        } catch (RejectedExecutionException saturated) {
            if (kind == PortCallKind.READBACK || priorEffectStarted) {
                throw new CanonicalOperationUnknownException(jobId, saturated);
            }
            throw new CanonicalOperationResourceExhaustedException(saturated);
        }

        Context.CancellationListener cancelChild = ignored -> {
            cancelPortCall(future, dispatchGate);
        };
        budget.context.addListener(cancelChild, Runnable::run);
        try {
            long remainingNanos = budget.remainingNanos();
            if (remainingNanos <= 0) {
                cancelPortCall(future, dispatchGate);
                throwCallOutcome(budget.context, kind, jobId,
                        dispatchGate.dispatched(), priorEffectStarted, null);
            }
            T value = future.get(remainingNanos, TimeUnit.NANOSECONDS);
            if (!budget.isActive()) {
                cancelPortCall(future, dispatchGate);
                throwCallOutcome(budget.context, kind, jobId,
                        dispatchGate.dispatched(), priorEffectStarted, null);
            }
            return value;
        } catch (TimeoutException | CancellationException expired) {
            cancelPortCall(future, dispatchGate);
            throwCallOutcome(budget.context, kind, jobId,
                    dispatchGate.dispatched(), priorEffectStarted, expired);
            throw new AssertionError("unreachable");
        } catch (InterruptedException interrupted) {
            cancelPortCall(future, dispatchGate);
            Thread.currentThread().interrupt();
            throwCallOutcome(budget.context, kind, jobId,
                    dispatchGate.dispatched(), priorEffectStarted, interrupted);
            throw new AssertionError("unreachable");
        } catch (ExecutionException failed) {
            Throwable cause = failed.getCause() == null ? failed : failed.getCause();
            if (!budget.isActive()) {
                dispatchGate.closeBeforeDispatch();
                throwCallOutcome(budget.context, kind, jobId,
                        dispatchGate.dispatched(), priorEffectStarted, cause);
            }
            if (kind == PortCallKind.SUBMIT
                    && cause instanceof MediaCapabilityNotAdmittedException notAdmitted
                    && !priorEffectStarted) {
                throw notAdmitted;
            }
            if (kind == PortCallKind.SUBMIT
                    && cause instanceof IllegalArgumentException invalid && !priorEffectStarted) {
                throw invalid;
            }
            if (kind == PortCallKind.READBACK || kind == PortCallKind.SUBMIT
                    && (dispatchGate.dispatched() || priorEffectStarted)
                    || kind == PortCallKind.EFFECT
                    && (dispatchGate.dispatched() || priorEffectStarted)) {
                throw new CanonicalOperationUnknownException(jobId, cause);
            }
            if (cause instanceof RuntimeException runtime) throw runtime;
            throw new IllegalStateException("Multimodal runtime port call failed", cause);
        } finally {
            budget.context.removeListener(cancelChild);
        }
    }

    /**
     * Cancels a port-call task and immediately removes it only when cancellation won
     * before dispatch. A started callable keeps its worker slot until it actually exits;
     * interrupting it is not treated as proof that native or blocked work stopped.
     */
    private void cancelPortCall(Future<?> future, PortCallDispatchGate dispatchGate) {
        boolean cancelledBeforeDispatch = dispatchGate.closeBeforeDispatch();
        future.cancel(true);
        if (cancelledBeforeDispatch && future instanceof Runnable queuedTask) {
            portCallWorkers.remove(queuedTask);
        }
    }

    private static void throwCallOutcome(
            Context context, PortCallKind kind, String jobId,
            boolean dispatched, boolean priorEffectStarted, Throwable cause)
            throws CanonicalOperationUnknownException {
        if (kind == PortCallKind.READBACK || kind == PortCallKind.SUBMIT
                && (dispatched || priorEffectStarted)
                || kind == PortCallKind.EFFECT
                && (dispatched || priorEffectStarted)) {
            throw new CanonicalOperationUnknownException(jobId, cause);
        }
        if (context.isCancelled()
                && (context.getDeadline() == null || !context.getDeadline().isExpired())) {
            throw new CanonicalOperationCancelledException(cause);
        }
        throw new CanonicalOperationDeadlineExceededException(cause);
    }

    private enum PortCallKind { READ, EFFECT, SUBMIT, READBACK }

    /** Linearizes an observed timeout or cancellation against starting a port call. */
    static final class PortCallDispatchGate {
        private static final int WAITING = 0;
        private static final int DISPATCHED = 1;
        private static final int CLOSED = 2;
        private final AtomicInteger state = new AtomicInteger(WAITING);

        boolean tryDispatch() {
            return state.compareAndSet(WAITING, DISPATCHED);
        }

        boolean closeBeforeDispatch() {
            return state.compareAndSet(WAITING, CLOSED);
        }

        boolean dispatched() {
            return state.get() == DISPATCHED;
        }
    }

    private static final class OperationBudget {
        private final Context context;
        private final long operationBudgetNanos;
        private final long startedNanos;

        private OperationBudget(Context context, Duration operationDeadline) {
            this.context = context;
            this.operationBudgetNanos = safeToNanos(operationDeadline);
            this.startedNanos = System.nanoTime();
        }

        private long remainingNanos() {
            long remaining = operationBudgetNanos - (System.nanoTime() - startedNanos);
            if (context.getDeadline() != null) {
                remaining = Math.min(remaining, context.getDeadline().timeRemaining(TimeUnit.NANOSECONDS));
            }
            return remaining;
        }

        private boolean isActive() {
            return !context.isCancelled() && remainingNanos() > 0;
        }

        private void requireActive(PortCallKind kind, String jobId, boolean priorEffectStarted)
                throws CanonicalOperationUnknownException {
            if (!isActive()) throwCallOutcome(context, kind, jobId, false, priorEffectStarted, null);
        }
    }

    private static long safeToNanos(Duration duration) {
        try {
            return duration.toNanos();
        } catch (ArithmeticException overflow) {
            return Long.MAX_VALUE;
        }
    }

    private static ThreadPoolExecutor createPortCallWorkers() {
        int threads = Math.max(2, Math.min(MAX_PORT_CALL_WORKERS,
                Runtime.getRuntime().availableProcessors()));
        AtomicInteger threadNumber = new AtomicInteger();
        ThreadFactory threadFactory = runnable -> {
            Thread thread = new Thread(runnable,
                    "media-multimodal-port-" + threadNumber.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        };
        return new ThreadPoolExecutor(threads, threads, 0L, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(PORT_CALL_QUEUE_CAPACITY), threadFactory,
                new ThreadPoolExecutor.AbortPolicy());
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

/** Known no-effect deadline/cancellation result emitted only before an effect can start. */
final class CanonicalOperationDeadlineExceededException extends StatusRuntimeException {
    CanonicalOperationDeadlineExceededException() {
        this(null);
    }

    CanonicalOperationDeadlineExceededException(Throwable cause) {
        super(Status.DEADLINE_EXCEEDED
                .withDescription("MULTIMODAL_OPERATION_DEADLINE_EXCEEDED")
                .withCause(cause));
    }
}

/** Known no-effect caller cancellation emitted only when cancellation wins before dispatch. */
final class CanonicalOperationCancelledException extends StatusRuntimeException {
    CanonicalOperationCancelledException(Throwable cause) {
        super(Status.CANCELLED
                .withDescription("MULTIMODAL_OPERATION_CANCELLED_BEFORE_DISPATCH")
                .withCause(cause));
    }
}

/** Local bounded-worker saturation before a runtime-port call starts. */
final class CanonicalOperationResourceExhaustedException extends StatusRuntimeException {
    CanonicalOperationResourceExhaustedException(Throwable cause) {
        super(Status.RESOURCE_EXHAUSTED
                .withDescription("MULTIMODAL_PORT_CAPACITY_UNAVAILABLE")
                .withCause(cause));
    }
}
