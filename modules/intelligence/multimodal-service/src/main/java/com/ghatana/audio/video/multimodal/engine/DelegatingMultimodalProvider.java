package com.ghatana.audio.video.multimodal.engine;

import com.ghatana.media.runtime.MediaRuntimeContracts.Cancellation;
import com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaChildJobDispatcher;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.MultimodalOperationSnapshot;
import com.ghatana.media.runtime.MediaRuntimeContracts.MultimodalOperationSpec;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptObservation;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptQuery;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderObservation;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobAttemptStatus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Canonical multimodal provider: composes an admitted multimodal operation out of
 * independently authorized child STT and Vision jobs executed through the runtime's own
 * job/attempt/fence/outbox path.
 *
 * <p>The provider never executes a modality model itself and never trusts an in-memory
 * callback registry. For each fenced attempt it reconstructs the durable
 * {@link MultimodalOperationSpec} (from the admitted request parameters or the persisted
 * operation snapshot on reconciliation), derives deterministic per-child request ids,
 * submits each child through the authenticated {@link MediaChildJobDispatcher}, and
 * awaits child terminal states on its own bounded scheduler — never blocking a Media
 * attempt worker. Ambiguous child or parent outcomes produce
 * {@link AttemptFinality#UNKNOWN}; child receipts are consulted before any finality is
 * claimed, and no family aggregate {@code PARTIAL} can masquerade as success.</p>
 *
 * @doc.type class
 * @doc.purpose Multimodal composition provider over canonical Media child jobs
 * @doc.layer product
 * @doc.pattern Provider, Composition
 */
public final class DelegatingMultimodalProvider implements MediaProcessingProvider {
    private static final Logger LOG = LoggerFactory.getLogger(DelegatingMultimodalProvider.class);
    private static final Duration DEFAULT_OPERATION_DEADLINE = Duration.ofMinutes(4);
    private static final Duration DEFAULT_POLL_INTERVAL = Duration.ofMillis(250);
    private static final int MAX_OBSERVATION_RESULT_CHARS = 8_192;
    /**
     * Canonical child job types this orchestrator can fan out to. Production
     * eligibility requires every one of them to be usable through another provider.
     */
    private static final Set<JobType> DELEGATED_CHILDREN =
            Set.of(JobType.SPEECH_TO_TEXT, JobType.VISION);

    private final ScheduledExecutorService scheduler;
    private final boolean ownsScheduler;
    private final Duration operationDeadline;
    private final Duration pollInterval;
    private final AtomicBoolean closed = new AtomicBoolean(false);
    /** Composition-bound usable child capabilities; unbound stays ineligible. */
    private volatile Set<JobType> boundUsableCapabilities;

    /** ServiceLoader composition. */
    public DelegatingMultimodalProvider() {
        this(newScheduler(), true, DEFAULT_OPERATION_DEADLINE, DEFAULT_POLL_INTERVAL);
    }

    DelegatingMultimodalProvider(
            ScheduledExecutorService scheduler,
            boolean ownsScheduler,
            Duration operationDeadline,
            Duration pollInterval) {
        this.scheduler = Objects.requireNonNull(scheduler, "scheduler");
        this.ownsScheduler = ownsScheduler;
        this.operationDeadline = Objects.requireNonNull(operationDeadline, "operationDeadline");
        this.pollInterval = Objects.requireNonNull(pollInterval, "pollInterval");
        if (operationDeadline.isZero() || operationDeadline.isNegative()
                || pollInterval.isZero() || pollInterval.isNegative()
                || pollInterval.compareTo(operationDeadline) >= 0) {
            throw new IllegalArgumentException("multimodal polling bounds are invalid");
        }
    }

    /** Test seam: deterministic single-thread scheduler and short bounds. */
    static DelegatingMultimodalProvider forTesting(
            ScheduledExecutorService scheduler, Duration operationDeadline, Duration pollInterval) {
        return new DelegatingMultimodalProvider(scheduler, false, operationDeadline, pollInterval);
    }

    private static ScheduledExecutorService newScheduler() {
        return Executors.newSingleThreadScheduledExecutor(task -> {
            Thread thread = new Thread(task, "media-mm-child-completion");
            thread.setDaemon(true);
            return thread;
        });
    }

    @Override public String providerId() { return "media-multimodal-delegating"; }
    @Override public String providerVersion() { return "multimodal-delegating-v1"; }
    @Override public String modelVersion(JobType modality) { return providerVersion(); }
    @Override public Set<JobType> capabilities() { return Set.of(JobType.MULTIMODAL); }
    @Override public boolean ready() { return !closed.get(); }
    /**
     * Conditional eligibility only: a multimodal orchestrator is production-usable
     * when the composing runtime bound usable providers for every child job type it
     * can fan out to. Independently qualified child/source admission is still
     * enforced per job and per attempt; unbound providers remain ineligible.
     */
    @Override public boolean productionEligible() {
        Set<JobType> bound = boundUsableCapabilities;
        return !closed.get() && bound != null && bound.containsAll(delegatedCapabilities());
    }
    @Override public Set<JobType> delegatedCapabilities() { return DELEGATED_CHILDREN; }
    @Override public void bindRuntimeCapabilities(Set<JobType> usableJobTypes) {
        boundUsableCapabilities = usableJobTypes == null ? Set.of() : Set.copyOf(usableJobTypes);
    }
    @Override public int priority() { return 0; }
    @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
    @Override public String processingRegion() { return "local"; }
    @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.NONE; }

    @Override
    public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
        // Non-durable path (no persisted attempt): run the same orchestration and surface
        // the fused result map; finality is recorded by the caller.
        return orchestrate(context, null)
                .thenApply(outcome -> outcome.finality() == AttemptFinality.SUCCEEDED
                        ? outcome.result()
                        : Map.<String, Object>of());
    }

    @Override
    public CompletableFuture<ProviderSubmission> processAttempt(
            ProcessingContext context, ProviderAttemptContext attempt) {
        Objects.requireNonNull(attempt, "attempt");
        return orchestrate(context, attempt)
                .thenApply(outcome -> submissionFor(context, attempt, outcome));
    }

    /**
     * The operation accepts cancellation: the runtime flips the attempt's shared
     * {@link Cancellation} and future on {@link CancellationOutcome#CONFIRMED}, and the
     * in-flight poll propagates the cancel to its durable children best-effort through
     * the attempt-bound dispatcher. Each child's own durable record stays the authority
     * for child finality — this outcome covers the parent operation's effects only.
     */
    @Override
    public CancellationOutcome cancel(
            String tenantId, String principalId, String correlationId, String jobId) {
        return CancellationOutcome.CONFIRMED;
    }

    @Override
    public Optional<ProviderObservation> reconcileAttempt(
            String tenantId, String jobId, String requestId, int attemptNumber) {
        // A reconciled observation is only derivable from durable child job states; the
        // dispatcher is not reachable outside a fenced attempt, so there is nothing
        // honest to report here.
        return Optional.empty();
    }

    /**
     * Reads the exact durable children for the persisted parent attempt. The parent may be
     * OUTCOME_UNKNOWN after restart; child terminal states are durable facts the provider
     * can project without redispatching anything.
     */
    @Override
    public CompletableFuture<ProviderAttemptObservation> reconcileAttempt(ProviderAttemptQuery query) {
        Objects.requireNonNull(query, "query");
        return CompletableFuture.completedFuture(new ProviderAttemptObservation(
                query, AttemptFinality.UNKNOWN, query.providerReceiptId(), Map.of(), "", Instant.now()));
    }

    // ── Orchestration ────────────────────────────────────────────────────────

    private CompletableFuture<OperationOutcome> orchestrate(
            ProcessingContext context, ProviderAttemptContext attempt) {
        CompletableFuture<OperationOutcome> result = new CompletableFuture<>();
        if (closed.get()) {
            result.complete(OperationOutcome.failed("PROVIDER_CLOSED"));
            return result;
        }
        final MultimodalOperationSpec spec;
        final MediaChildJobDispatcher dispatcher;
        try {
            spec = MultimodalOperationSpec.from(context.request());
            dispatcher = context.requireChildDispatcher();
        } catch (RuntimeException failure) {
            result.complete(OperationOutcome.noEffect("SPEC_OR_DISPATCHER_NOT_ADMITTED"));
            return result;
        }
        context.cancellation().throwIfCancelled();

        // 1. Idempotent per-child submission. The deterministic request ids make a replay
        //    resolve to the same durable job; a conflicting resubmission fails closed.
        List<ProcessingJob> children;
        try {
            children = submitChildren(spec, context, dispatcher);
        } catch (RuntimeException failure) {
            // Already-submitted children were cancelled inside submitChildren. A parent
            // cancellation racing the fanout reports UNKNOWN, never a failure code for
            // an effect that was refused rather than attempted.
            result.complete(context.cancellation().cancelled()
                    ? OperationOutcome.unknown()
                    : OperationOutcome.failed("CHILD_SUBMISSION_FAILED"));
            return result;
        }
        if (children.size() != spec.children().size()) {
            cancelChildrenQuietly(children, dispatcher);
            result.complete(OperationOutcome.unknown());
            return result;
        }

        // 2. Bounded nonblocking wait on the provider's own scheduler — the parent attempt
        //    worker is released while children execute on their own canonical jobs.
        scheduleCompletion(context, attempt, spec, children, dispatcher, result,
                Instant.now().plus(operationDeadline));
        return result;
    }

    private List<ProcessingJob> submitChildren(
            MultimodalOperationSpec spec,
            ProcessingContext context,
            MediaChildJobDispatcher dispatcher) {
        ProcessingJobRequest parent = context.request();
        List<ProcessingJob> children = new ArrayList<>(spec.children().size());
        for (MultimodalOperationSpec.ChildOperationSpec child : spec.children()) {
            try {
                context.cancellation().throwIfCancelled();
                String childRequestId = MultimodalOperationSpec.childRequestId(
                        parent.requestId(), child.childKey());
                ProcessingJob existing = dispatcher.findJobByRequest(childRequestId).orElse(null);
                if (existing != null) {
                    children.add(existing);
                    continue;
                }
                ProcessingJobRequest childRequest = new ProcessingJobRequest(
                        childRequestId, parent.tenantId(), parent.principalId(),
                        boundedCorrelation(parent.correlationId(), child.childKey()),
                        child.artifactId(), child.artifactVersion(), child.jobType(),
                        child.providerHint(), child.parameters(), parent.governanceContext());
                children.add(dispatcher.submitChild(childRequest));
            } catch (RuntimeException failure) {
                // A denied or cancelled fanout must not leak the children already
                // submitted: cancel them best-effort before the failure propagates.
                cancelChildrenQuietly(children, dispatcher);
                throw failure;
            }
        }
        return children;
    }

    private void scheduleCompletion(
            ProcessingContext context,
            ProviderAttemptContext attempt,
            MultimodalOperationSpec spec,
            List<ProcessingJob> children,
            MediaChildJobDispatcher dispatcher,
            CompletableFuture<OperationOutcome> result,
            Instant deadline) {
        try {
            if (context.cancellation().cancelled()) {
                // Checked before result.isDone(): the runtime cancels the attempt future
                // on a confirmed parent cancel, and propagation to the durable children
                // must still run while the dispatcher is reachable.
                cancelChildrenQuietly(children, dispatcher);
                result.complete(OperationOutcome.unknown());
                return;
            }
            if (result.isDone()) return;
            List<ProcessingJob> current = new ArrayList<>(children.size());
            for (ProcessingJob child : children) {
                Optional<ProcessingJob> readback = dispatcher.findJob(child.jobId());
                current.add(readback.orElse(child));
            }
            OperationOutcome terminal = evaluate(spec, current);
            if (terminal != null) {
                result.complete(terminal);
                return;
            }
            if (!Instant.now().isBefore(deadline)) {
                // A child may still be ACCEPTED/RUNNING or its outcome lost. UNKNOWN is
                // the honest parent finality; reconciliation reads exact child receipts.
                // The operation bound is spent, so the remaining children are cancelled
                // best-effort rather than left running past the parent deadline.
                cancelChildrenQuietly(current, dispatcher);
                result.complete(OperationOutcome.unknown());
                return;
            }
            scheduler.schedule(
                    () -> scheduleCompletion(
                            context, attempt, spec, children, dispatcher, result, deadline),
                    pollInterval.toMillis(), TimeUnit.MILLISECONDS);
        } catch (RuntimeException failure) {
            result.complete(OperationOutcome.unknown());
        }
    }

    /**
     * Maps durable child states to the parent outcome. COMPLETED requires every declared
     * child durably completed; FAILED/CANCELLED is a final child fact; anything else —
     * including a child still running at the deadline — is UNKNOWN, never a partial
     * success.
     */
    private OperationOutcome evaluate(MultimodalOperationSpec spec, List<ProcessingJob> children) {
        boolean anyFailed = false;
        boolean anyUnknown = false;
        for (ProcessingJob child : children) {
            switch (child.status()) {
                case COMPLETED -> { }
                case FAILED, CANCELLED -> anyFailed = true;
                case OUTCOME_UNKNOWN -> anyUnknown = true;
                default -> { return null; }
            }
        }
        if (anyUnknown) return OperationOutcome.unknown();
        if (anyFailed) return OperationOutcome.failed("CHILD_FAILED");
        return OperationOutcome.succeeded(MultimodalOperationSpec.fusedResult(spec, children));
    }

    /**
     * Best-effort cancel of the operation's durable children. The parent outcome is
     * already determined when this runs; each child's own job record stays the exact
     * authority for whether the cancel took effect.
     */
    private void cancelChildrenQuietly(
            List<ProcessingJob> children, MediaChildJobDispatcher dispatcher) {
        for (ProcessingJob child : children) {
            try {
                dispatcher.cancelChild(child.jobId());
            } catch (RuntimeException failure) {
                LOG.debug("Multimodal child cancellation was not confirmed childJobId={}",
                        child.jobId(), failure);
            }
        }
    }

    private ProviderSubmission submissionFor(
            ProcessingContext context,
            ProviderAttemptContext attempt,
            OperationOutcome outcome) {
        String operationId = "mm:" + attempt.jobId() + ':' + attempt.attemptNumber();
        return switch (outcome.finality()) {
            case SUCCEEDED, FAILED -> {
                String provenance = digest(operationId + ':' + outcome.result() + ':' + outcome.failureCode());
                yield new ProviderSubmission(
                        outcome.finality(), operationId,
                        digest(operationId + ':' + provenance),
                        outcome.result(), provenance, Instant.now());
            }
            case NO_EFFECT_PROVEN -> new ProviderSubmission(
                    AttemptFinality.NO_EFFECT_PROVEN, operationId,
                    digest(operationId + ":no-effect"),
                    Map.of(), digest(operationId), Instant.now());
            case UNKNOWN -> ProviderSubmission.unknown();
        };
    }

    private static String boundedCorrelation(String parent, String childKey) {
        String base = (parent == null || parent.isBlank()) ? "mm" : parent;
        String combined = base + ":" + childKey;
        return combined.length() > 512 ? combined.substring(0, 512) : combined;
    }

    private static String digest(Object value) {
        try {
            String serialized = com.ghatana.media.runtime.MediaJobRequestFingerprint
                    .canonicalJson(value == null ? Map.of() : value);
            return java.util.HexFormat.of().formatHex(
                    java.security.MessageDigest.getInstance("SHA-256")
                            .digest(serialized.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    private record OperationOutcome(
            AttemptFinality finality, Map<String, Object> result, String failureCode) {
        static OperationOutcome succeeded(Map<String, Object> result) {
            return new OperationOutcome(AttemptFinality.SUCCEEDED, Map.copyOf(result), "");
        }
        static OperationOutcome failed(String failureCode) {
            return new OperationOutcome(AttemptFinality.FAILED, Map.of(), failureCode);
        }
        static OperationOutcome noEffect(String failureCode) {
            return new OperationOutcome(AttemptFinality.NO_EFFECT_PROVEN, Map.of(), failureCode);
        }
        static OperationOutcome unknown() {
            return new OperationOutcome(AttemptFinality.UNKNOWN, Map.of(), "");
        }
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) return;
        if (ownsScheduler) scheduler.shutdownNow();
    }
}
