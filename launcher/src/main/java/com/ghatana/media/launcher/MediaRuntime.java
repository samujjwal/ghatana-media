package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.Cancellation;
import com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome;
import com.ghatana.media.runtime.MediaRuntimeContracts.AutomationRisk;
import com.ghatana.media.runtime.MediaRuntimeContracts.BiometricSensitivity;
import com.ghatana.media.runtime.MediaRuntimeContracts.ConsentDecision;
import com.ghatana.media.runtime.MediaRuntimeContracts.DataClassification;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobLease;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifactStore;
import com.ghatana.media.runtime.MediaUploadRequestFingerprint;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaConsentAuthority;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaJobStore;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaStreamSessionStore;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaStreamingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamAck;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamFrame;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSession;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSessionRegistration;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSessionRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamState;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadSession;
import com.ghatana.media.runtime.MediaModalityContracts;
import com.ghatana.media.runtime.MediaLifecycleEvent;
import com.ghatana.media.runtime.MediaLifecycleEventPublisher;
import com.ghatana.media.runtime.MediaJobRequestFingerprint;
import com.ghatana.media.runtime.MediaJobRequestFingerprint.ProviderDescriptor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.ServiceLoader;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Standalone Media Runtime composition for resumable artifacts, asynchronous jobs, and streams.
 *
 * <p>Codec, speech, vision, streaming, multimodal, and semantic-redaction implementations remain
 * provider-owned. This runtime owns lifecycle, durable state, routing, ordering, backpressure,
 * cancellation, consent verification, privacy-bound provider dispatch, fail-closed de-identified
 * promotion, and closure. External processing is never invoked with caller-asserted consent: a
 * composed {@link MediaConsentAuthority} must return an active decision bound to the request's
 * consent identity.
 *
 * <p>Instances can only be created through {@link #compose(Map)} in production so store/provider/
 * consent readiness, durability, production eligibility, and resource limits cannot be bypassed.
 *
 * @doc.type class
 * @doc.purpose Provide Media Runtime behavior
 * @doc.layer product
 * @doc.pattern Component
 */
public final class MediaRuntime implements AutoCloseable {
    private static final Logger log = LoggerFactory.getLogger(MediaRuntime.class);
    private static final Logger audit = LoggerFactory.getLogger("media.auditTrail");
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final String META_CONSENT_ID = "governance.consentId";
    private static final String META_PURPOSE = "governance.purpose";
    private static final String META_CLASSIFICATION = "governance.classification";
    private static final String META_RESIDENCY = "governance.residency";
    private static final String META_ALLOWED_REGIONS = "governance.allowedRegions";
    private static final String META_EXTERNAL_ALLOWED = "governance.externalProcessingAllowed";
    private static final String META_RETENTION_POLICY = "governance.retentionPolicy";
    private static final String META_PROVIDER_RETENTION_ALLOWED = "governance.providerRetentionAllowed";
    private static final String META_BIOMETRIC_ALLOWED = "governance.biometricProcessingAllowed";
    private static final String META_BIOMETRIC_BASIS = "governance.biometricProcessingBasis";
    private static final String META_BIOMETRIC_SENSITIVITY = "governance.biometricSensitivity";
    private static final String META_AUTOMATION_RISK = "governance.automationRisk";
    private static final String META_CONSENT_VERIFIED = "governance.consentVerified";
    private static final String META_CONSENT_AUTHORITY = "governance.consentAuthorityId";
    private static final String META_CONSENT_VERIFIED_AT = "governance.consentVerifiedAt";
    private static final String META_CONSENT_EXPIRES_AT = "governance.consentExpiresAt";
    private static final String META_CONSENT_ALLOWED_PURPOSES = "governance.consentAllowedPurposes";
    private static final String META_CONSENT_ALLOWED_REGIONS = "governance.consentAllowedRegions";
    private static final String META_CONSENT_EXTERNAL_ALLOWED = "governance.consentExternalProcessingAllowed";
    private static final String META_CONSENT_BIOMETRIC_ALLOWED = "governance.consentBiometricProcessingAllowed";

    private final MediaRuntimeConfig config;
    private final MediaArtifactStore artifactStore;
    private final MediaJobStore jobStore;
    private final MediaStreamSessionStore streamStore;
    private final MediaConsentAuthority consentAuthority;
    private final MediaSemanticRedactionRuntime semanticRedaction;
    private final MediaLifecycleEventPublisher lifecyclePublisher;
    private final List<MediaProcessingProvider> processingProviders;
    private final List<MediaStreamingProvider> streamingProviders;
    private final ConcurrentMap<String, JobControl> activeJobs = new ConcurrentHashMap<>();
    private final ConcurrentMap<String, StreamControl> activeStreams = new ConcurrentHashMap<>();
    /** Serializes provider dispatch and persisted cursor updates for each stream session. */
    private final ConcurrentMap<String, Object> streamOperationLocks = new ConcurrentHashMap<>();
    private final Semaphore concurrency;
    private final String workerId = "media-worker-" + UUID.randomUUID();
    private final AtomicBoolean closed = new AtomicBoolean(false);

    MediaRuntime(
            MediaRuntimeConfig config,
            MediaArtifactStore artifactStore,
            MediaJobStore jobStore,
            MediaStreamSessionStore streamStore,
            MediaConsentAuthority consentAuthority,
            List<MediaProcessingProvider> processingProviders,
            List<MediaStreamingProvider> streamingProviders) {
        this(
                config, artifactStore, jobStore, streamStore, consentAuthority,
                MediaSemanticRedactionRuntime.disabled(config.jobTimeout()),
                MediaLifecyclePublisher.disabled(),
                processingProviders, streamingProviders);
    }

    MediaRuntime(
            MediaRuntimeConfig config,
            MediaArtifactStore artifactStore,
            MediaJobStore jobStore,
            MediaStreamSessionStore streamStore,
            MediaConsentAuthority consentAuthority,
            MediaSemanticRedactionRuntime semanticRedaction,
            MediaLifecycleEventPublisher lifecyclePublisher,
            List<MediaProcessingProvider> processingProviders,
            List<MediaStreamingProvider> streamingProviders) {
        this.config = java.util.Objects.requireNonNull(config, "config");
        this.artifactStore = java.util.Objects.requireNonNull(artifactStore, "artifactStore");
        this.jobStore = java.util.Objects.requireNonNull(jobStore, "jobStore");
        this.streamStore = java.util.Objects.requireNonNull(streamStore, "streamStore");
        this.consentAuthority = consentAuthority;
        this.semanticRedaction = java.util.Objects.requireNonNull(semanticRedaction, "semanticRedaction");
        this.lifecyclePublisher = java.util.Objects.requireNonNull(lifecyclePublisher, "lifecyclePublisher");
        this.processingProviders = List.copyOf(processingProviders);
        this.streamingProviders = List.copyOf(streamingProviders);
        this.concurrency = new Semaphore(config.maximumConcurrentJobs());
        reconcileJobsAfterRestart();
    }

    public static MediaRuntime compose(Map<String, String> environment) {
        MediaRuntimeConfig config = MediaRuntimeConfig.fromEnvironment(environment);
        if (!config.runtimeEnabled()) throw new IllegalStateException("Media Runtime is disabled");

        MediaArtifactStore artifactStore = null;
        MediaJobStore jobStore = null;
        MediaStreamSessionStore streamStore = null;
        MediaConsentAuthority consentAuthority = null;
        MediaSemanticRedactionRuntime semanticRedaction = null;
        MediaLifecyclePublisher lifecyclePublisher = null;
        List<MediaProcessingProvider> processing = new ArrayList<>();
        List<MediaStreamingProvider> streaming = new ArrayList<>();
        List<MediaConsentAuthority> consentAuthorities = new ArrayList<>();
        try {
            List<MediaArtifactStore> artifactStores = loadUnique(MediaArtifactStore.class, MediaArtifactStore::storeId);
            List<MediaJobStore> jobStores = loadUnique(MediaJobStore.class, MediaJobStore::storeId);
            List<MediaStreamSessionStore> streamStores = loadUnique(
                    MediaStreamSessionStore.class, MediaStreamSessionStore::storeId);
            for (MediaConsentAuthority authority : ServiceLoader.load(MediaConsentAuthority.class)) {
                register(consentAuthorities, authority, MediaConsentAuthority::authorityId);
            }
            for (MediaProcessingProvider provider : ServiceLoader.load(MediaProcessingProvider.class)) {
                register(processing, provider, MediaProcessingProvider::providerId);
            }
            for (MediaStreamingProvider provider : ServiceLoader.load(MediaStreamingProvider.class)) {
                register(streaming, provider, MediaStreamingProvider::providerId);
            }
            if (config.localStoresEnabled()) {
                artifactStores = append(artifactStores,
                        new LocalMediaRuntimeSupport.FileArtifactStore(config.localStorageRoot()));
                jobStores = append(jobStores, new LocalMediaRuntimeSupport.JobStore());
                streamStores = append(streamStores, new LocalMediaRuntimeSupport.StreamStore());
            }
            if (config.localProviderEnabled()) {
                register(processing, new LocalMediaRuntimeSupport.DiagnosticProcessor(),
                        MediaProcessingProvider::providerId);
                register(streaming, new LocalMediaRuntimeSupport.DiagnosticStreamingProvider(),
                        MediaStreamingProvider::providerId);
            }

            artifactStore = selectStore(artifactStores, config.artifactStoreId(),
                    config.productionLike(), "artifact");
            jobStore = selectStore(jobStores, config.jobStoreId(), config.productionLike(), "job");
            String streamStoreId = canonicalOptional(environment.getOrDefault("MEDIA_STREAM_STORE_ID", ""));
            streamStore = selectStore(streamStores, streamStoreId, config.productionLike(), "stream");

            if (processing.stream().noneMatch(provider -> usableProcessingProvider(provider, config.productionLike()))) {
                throw new IllegalStateException("No ready Media processing provider is registered");
            }
            if (streaming.stream().noneMatch(provider -> usableStreamingProvider(provider, config.productionLike()))) {
                throw new IllegalStateException("No ready Media streaming provider is registered");
            }
            processing.stream()
                    .filter(provider -> usableProcessingProvider(provider, config.productionLike()))
                    .forEach(MediaProcessingProvider::verifyReady);
            streaming.stream()
                    .filter(provider -> usableStreamingProvider(provider, config.productionLike()))
                    .forEach(MediaStreamingProvider::verifyReady);

            boolean externalProcessingReady = processing.stream()
                    .anyMatch(p -> usableProcessingProvider(p, config.productionLike())
                            && p.processingBoundary() == ProcessingBoundary.EXTERNAL)
                    || streaming.stream()
                    .anyMatch(p -> usableStreamingProvider(p, config.productionLike())
                            && p.processingBoundary() == ProcessingBoundary.EXTERNAL);
            consentAuthority = selectConsentAuthority(
                    consentAuthorities,
                    canonicalOptional(environment.getOrDefault("MEDIA_CONSENT_AUTHORITY_ID", "")),
                    config.productionLike(),
                    externalProcessingReady);
            semanticRedaction = MediaSemanticRedactionRuntime.compose(
                    environment, config.productionLike(), config.jobTimeout());
            lifecyclePublisher = MediaLifecyclePublisher.compose(environment, config.productionLike());

            MediaRuntime runtime = new MediaRuntime(
                    config, artifactStore, jobStore, streamStore, consentAuthority, semanticRedaction,
                    lifecyclePublisher,
                    processing, streaming);
            if (!runtime.ready()) throw new IllegalStateException("Media Runtime dependencies are not ready");
            return runtime;
        } catch (RuntimeException failure) {
            safeClose(lifecyclePublisher, failure);
            safeClose(semanticRedaction, failure);
            streaming.forEach(provider -> safeClose(provider, failure));
            processing.forEach(provider -> safeClose(provider, failure));
            consentAuthorities.forEach(authority -> safeClose(authority, failure));
            safeClose(streamStore, failure);
            safeClose(jobStore, failure);
            safeClose(artifactStore, failure);
            throw failure;
        }
    }

    /** @deprecated Upload creation without a caller-provided idempotency key is unsafe and fails closed. */
    @Deprecated
    public UploadSession beginUpload(UploadRequest request) {
        throw new IllegalArgumentException("Idempotency-Key is required to begin a Media upload");
    }

    public UploadSession beginUpload(UploadRequest request, String idempotencyKey) {
        ensureOpen();
        requireIdempotencyKey(idempotencyKey);
        if (request.expectedSizeBytes() > config.maximumArtifactBytes()) {
            throw new IllegalArgumentException(
                    "Media artifact exceeds MEDIA_MAX_ARTIFACT_BYTES");
        }
        var begin = artifactStore.beginWithDisposition(request, idempotencyKey);
        UploadSession session = begin.session();
        audit.info("MEDIA_UPLOAD_STARTED tenantId={} uploadId={} contentType={} expectedSize={} classification={}",
                request.tenantId(), session.uploadId(), request.contentType(), request.expectedSizeBytes(),
                request.classification());
        if (begin.created()) {
            publishLifecycle("media.upload.started", request.tenantId(), request.principalId(),
                    session.uploadId(), "", "upload", session.uploadId(), 1L,
                    request.classification(), Map.of(
                            "contentType", request.contentType(),
                            "expectedSizeBytes", request.expectedSizeBytes()));
        }
        return session;
    }

    private static void requireIdempotencyKey(String value) {
        if (value == null || value.isBlank() || value.length() > 255) {
            throw new IllegalArgumentException("Idempotency-Key must contain between 1 and 255 characters");
        }
    }

    public UploadSession appendChunk(String tenantId, String principalId, String uploadId, int chunkIndex, byte[] bytes) {
        ensureOpen();
        if (principalId == null || principalId.isBlank()) throw new SecurityException("Authenticated principal is required");
        if (chunkIndex < 0) throw new IllegalArgumentException("chunkIndex must not be negative");
        if (bytes == null || bytes.length == 0 || bytes.length > config.maximumChunkBytes()) {
            throw new IllegalArgumentException(
                    "Chunk must contain between 1 and " + config.maximumChunkBytes() + " bytes");
        }
        return artifactStore.append(tenantId, principalId, uploadId, chunkIndex, bytes);
    }

    /** @deprecated Principal-less upload mutation cannot prove ownership and always fails closed. */
    @Deprecated
    public UploadSession appendChunk(String tenantId, String uploadId, int chunkIndex, byte[] bytes) {
        throw new SecurityException("Authenticated principal is required to append an upload");
    }

    public MediaArtifact completeUpload(String tenantId, String principalId, String uploadId) {
        ensureOpen();
        if (principalId == null || principalId.isBlank()) throw new SecurityException("Authenticated principal is required");
        UploadSession upload = artifactStore.upload(tenantId, uploadId)
                .orElseThrow(() -> new IllegalArgumentException("Media upload not found: " + uploadId));
        if (!upload.principalId().equals(principalId)) {
            throw new IllegalArgumentException("Media upload not found: " + uploadId);
        }
        var completion = artifactStore.completeWithDisposition(tenantId, principalId, uploadId);
        MediaArtifact artifact = completion.artifact();
        audit.info("MEDIA_UPLOAD_COMPLETED tenantId={} uploadId={} artifactId={} size={} sha256={} classification={}",
                tenantId, uploadId, artifact.artifactId(), artifact.sizeBytes(), artifact.sha256(),
                artifact.classification());
        if (completion.completedNow()) {
            publishLifecycle("media.artifact.completed", tenantId, artifact.principalId(),
                    uploadId, uploadId, "artifact", artifact.artifactId(), 1L,
                    artifact.classification(), Map.of(
                            "contentType", artifact.contentType(),
                            "sizeBytes", artifact.sizeBytes(),
                            "sourceUploadId", uploadId,
                            "sha256", artifact.sha256()));
        }
        return artifact;
    }

    /** @deprecated Principal-less upload mutation cannot prove ownership and always fails closed. */
    @Deprecated
    public MediaArtifact completeUpload(String tenantId, String uploadId) {
        throw new SecurityException("Authenticated principal is required to finalize an upload");
    }

    /** @deprecated A tenant-scoped upload read is insufficient where sessions belong to principals. */
    @Deprecated
    public Optional<UploadSession> upload(String tenantId, String uploadId) {
        throw new SecurityException("Authenticated principal is required to read a Media upload");
    }

    public Optional<UploadSession> upload(String tenantId, String principalId, String uploadId) {
        ensureOpen();
        requirePrincipal(principalId);
        return artifactStore.upload(tenantId, uploadId)
                .filter(session -> session.principalId().equals(principalId));
    }

    /** @deprecated A tenant-scoped artifact read is insufficient where artifacts belong to principals. */
    @Deprecated
    public Optional<MediaArtifact> artifact(String tenantId, String artifactId) {
        throw new SecurityException("Authenticated principal is required to read a Media artifact");
    }

    public Optional<MediaArtifact> artifact(String tenantId, String principalId, String artifactId) {
        ensureOpen();
        requirePrincipal(principalId);
        return artifactStore.artifact(tenantId, artifactId)
                .filter(value -> value.principalId().equals(principalId));
    }

    public ProcessingJob submit(ProcessingJobRequest request) {
        ensureOpen();
        MediaArtifact artifact = artifactStore.artifact(request.tenantId(), request.artifactId())
                .orElseThrow(() -> new IllegalArgumentException("Media artifact not found: " + request.artifactId()));
        if (!artifact.principalId().equals(request.principalId())) {
            throw new SecurityException("Media artifact is not owned by the authenticated principal");
        }
        List<MediaProcessingProvider> providers = selectProcessingProviders(request);
        MediaProcessingProvider provider = providers.getFirst();
        List<ProviderDescriptor> providerDescriptors = providers.stream()
                .map(candidate -> new ProviderDescriptor(candidate.providerId(), candidate.providerVersion(),
                        candidate.modelVersion(request.jobType())))
                .toList();
        String requestFingerprint = MediaJobRequestFingerprint.compute(request, providerDescriptors);
        if (MediaSemanticRedactionRuntime.promotionRequested(request) && !semanticRedaction.available()) {
            throw new IllegalStateException(
                    "DEIDENTIFIED promotion requires a ready Media semantic redaction provider");
        }
        String jobId = UUID.randomUUID().toString();
        ProcessingJob accepted = jobStore.create(new ProcessingJob(
                jobId, request.requestId(), request.tenantId(), request.principalId(), request.artifactId(), request.jobType(),
                provider.providerId(), JobStatus.ACCEPTED, Instant.now(), null, null, Map.of(), "", 1,
                requestFingerprint));
        if (!accepted.jobId().equals(jobId)) {
            audit.info("MEDIA_JOB_IDEMPOTENT_REPLAY tenantId={} requestId={} jobId={} status={}",
                    request.tenantId(), request.requestId(), accepted.jobId(), accepted.status());
            return accepted;
        }
        Cancellation cancellation = new Cancellation();
        CompletableFuture<?> future = startJob(
                accepted, request, artifact, providers, cancellation);
        JobControl control = new JobControl(cancellation, future);
        activeJobs.put(jobId, control);
        future.whenComplete((result, failure) -> activeJobs.remove(jobId, control));
        // A local provider may complete synchronously before the control is registered. Do not
        // leave such an already-terminal job in the active set.
        if (future.isDone()) activeJobs.remove(jobId, control);
        audit.info("MEDIA_JOB_ACCEPTED tenantId={} requestId={} jobId={} artifactId={} type={} provider={} consentAuthority={} semanticPromotionRequested={}",
                request.tenantId(), request.requestId(), jobId, request.artifactId(), request.jobType(),
                provider.providerId(), "verified-at-dispatch", MediaSemanticRedactionRuntime.promotionRequested(request));
        publishLifecycle("media.job.accepted", request.tenantId(), request.principalId(),
                request.correlationId(), request.requestId(), "job", accepted.jobId(), accepted.version(),
                artifact.classification(), Map.of(
                        "artifactId", request.artifactId(),
                        "jobType", request.jobType().name(),
                        "providerId", provider.providerId(),
                        "status", accepted.status().name()));
        return accepted;
    }

    /** @deprecated A tenant-scoped read is insufficient where jobs belong to principals. */
    @Deprecated
    public Optional<ProcessingJob> job(String tenantId, String jobId) {
        throw new SecurityException("Authenticated principal is required to read a Media job");
    }

    public Optional<ProcessingJob> job(String tenantId, String principalId, String jobId) {
        ensureOpen();
        requirePrincipal(principalId);
        return jobStore.find(tenantId, jobId)
                .filter(value -> value.principalId().equals(principalId));
    }

    /** @deprecated A tenant-scoped list is insufficient where jobs belong to principals. */
    @Deprecated
    public List<ProcessingJob> jobs(String tenantId, int limit) {
        throw new SecurityException("Authenticated principal is required to list Media jobs");
    }

    public List<ProcessingJob> jobs(String tenantId, String principalId, int limit) {
        ensureOpen();
        requirePrincipal(principalId);
        return jobStore.list(tenantId, Math.max(1, Math.min(limit, 1_000))).stream()
                .filter(value -> value.principalId().equals(principalId))
                .toList();
    }

    /** @deprecated Cancellation requires the authenticated principal that owns the job. */
    @Deprecated
    public ProcessingJob cancel(String tenantId, String jobId) {
        throw new SecurityException("Authenticated principal is required to cancel a Media job");
    }

    public ProcessingJob cancel(String tenantId, String principalId, String jobId) {
        ensureOpen();
        requirePrincipal(principalId);
        return cancelOwnedJob(tenantId, principalId, jobId);
    }

    private ProcessingJob cancelOwnedJob(String tenantId, String principalId, String jobId) {
        ensureOpen();
        ProcessingJob current = jobStore.find(tenantId, jobId)
                .orElseThrow(() -> new IllegalArgumentException("Media job not found: " + jobId));
        if (!current.principalId().equals(principalId)) {
            throw new IllegalArgumentException("Media job not found: " + jobId);
        }
        if (terminal(current.status())) return current;
        JobControl control = activeJobs.get(jobId);
        CancellationOutcome providerOutcome = processingProviders.stream()
                .filter(provider -> provider.providerId().equalsIgnoreCase(current.providerId()))
                .findFirst()
                .map(provider -> provider.cancel(
                        tenantId, current.principalId(), current.requestId(), jobId))
                .orElse(CancellationOutcome.UNSUPPORTED);

        ProcessingJob stored;
        String lifecycleEvent;
        try {
            if (providerOutcome == CancellationOutcome.CONFIRMED) {
                stored = jobStore.update(current,
                        transition(current, JobStatus.CANCELLED,
                                Map.of("cancellationOutcome", CancellationOutcome.CONFIRMED.name()),
                                "CANCELLED"));
                lifecycleEvent = "media.job.cancelled";
                if (control != null) {
                    control.cancellation().cancel();
                    control.future().cancel(true);
                }
                audit.info("MEDIA_JOB_CANCELLED tenantId={} jobId={} provider={} cancellationOutcome={}",
                        tenantId, jobId, current.providerId(), providerOutcome);
            } else {
                stored = jobStore.update(current, cancellationRequested(current, providerOutcome));
                lifecycleEvent = "media.job.cancel_requested";
                audit.info("MEDIA_JOB_CANCEL_REQUESTED tenantId={} jobId={} provider={} cancellationOutcome={} status={}",
                        tenantId, jobId, current.providerId(), providerOutcome, stored.status());
            }
        } catch (com.ghatana.media.runtime.MediaRuntimeContracts.MediaJobStoreConflictException concurrentTransition) {
            // Provider cancellation can race with completion/failure or another cancellation.
            // A stale confirmation cannot rewrite the newer state or report false cancellation.
            ProcessingJob latest = jobStore.find(tenantId, jobId).orElseThrow(() -> concurrentTransition);
            if (terminal(latest.status())) return latest;
            throw concurrentTransition;
        }

        String classification = artifactStore.artifact(tenantId, current.artifactId())
                .map(MediaArtifact::classification).orElse("RESTRICTED");
        publishLifecycle(lifecycleEvent, tenantId, current.principalId(), current.requestId(),
                current.requestId(), "job", current.jobId(), stored.version(), classification, Map.of(
                        "artifactId", current.artifactId(),
                        "jobType", current.jobType().name(),
                        "providerId", current.providerId(),
                        "status", stored.status().name(),
                        "cancellationOutcome", providerOutcome.name()));
        return stored;
    }

    public StreamSessionRegistration openStream(StreamSessionRequest request) {
        ensureOpen();
        MediaStreamingProvider provider = selectStreamingProvider(request);
        ConsentDecision consent = consentFor(
                request.tenantId(),
                request.principalId(),
                request.governanceContext(),
                "stream:" + request.streamKind().name(),
                provider.processingBoundary());
        String sessionId = UUID.randomUUID().toString();
        String token = connectionToken();
        Instant now = Instant.now();
        Map<String, Object> metadata = governedStreamMetadata(request.metadata(), request.governanceContext(), consent);
        StreamSession session = streamStore.create(new StreamSession(
                request.tenantId(), sessionId, request.principalId(), request.streamKind(),
                provider.providerId(), StreamState.OPEN, -1L, 0L, request.maximumBufferedBytes(), 0,
                now.plus(request.leaseDuration()), now, now, null, metadata, 1), hash(token));
        activeStreams.put(streamKey(request.tenantId(), sessionId),
                new StreamControl(new Cancellation(), provider, request.governanceContext(), consent));
        audit.info("MEDIA_STREAM_OPENED tenantId={} sessionId={} kind={} provider={} maxBufferedBytes={} consentAuthority={}",
                request.tenantId(), sessionId, request.streamKind(), provider.providerId(),
                request.maximumBufferedBytes(), consent.authorityId());
        publishLifecycle("media.stream.opened", request.tenantId(), request.principalId(),
                request.correlationId(), "", "stream", sessionId, session.version(),
                request.governanceContext().classification().name(), Map.of(
                        "streamKind", request.streamKind().name(),
                        "providerId", provider.providerId()));
        return new StreamSessionRegistration(session, token);
    }

    public StreamSession connectStream(String tenantId, String sessionId, String token) {
        ensureOpen();
        Object lock = streamOperationLocks.computeIfAbsent(
                streamKey(tenantId, sessionId), ignored -> new Object());
        synchronized (lock) {
            StreamSession current = requireStream(tenantId, sessionId);
            String tokenHash = hash(token);
            if (!streamStore.tokenMatches(tenantId, sessionId, tokenHash)) {
                throw new SecurityException("Invalid media stream connection token");
            }
            if (current.state() != StreamState.OPEN
                    && current.state() != StreamState.CONNECTED
                    && current.state() != StreamState.DEGRADED) {
                throw new IllegalStateException("Media stream state cannot connect: " + current.state());
            }
            MediaStreamingProvider provider = provider(current.providerId(), current.streamKind());
            MediaGovernanceContext governance = governanceFromSession(current);
            ConsentDecision consent = consentFor(
                    current.tenantId(), current.principalId(), governance,
                    "stream:" + current.streamKind().name(), provider.processingBoundary());
            StreamSession connected = streamStore.connect(
                    current, tokenHash, Instant.now().plusSeconds(30));
            activeStreams.put(streamKey(tenantId, sessionId),
                    new StreamControl(new Cancellation(), provider, governance, consent));
            audit.info("MEDIA_STREAM_CONNECTED tenantId={} sessionId={} reconnectCount={} consentAuthority={}",
                    tenantId, sessionId, connected.reconnectCount(), consent.authorityId());
            return connected;
        }
    }

    public StreamSession connectStream(
            String tenantId, String principalId, String sessionId, String token) {
        stream(tenantId, principalId, sessionId)
                .orElseThrow(() -> new IllegalArgumentException(
                        "Media stream session not found: " + sessionId));
        return connectStream(tenantId, sessionId, token);
    }

    public StreamAck acceptFrame(StreamFrame frame) {
        ensureOpen();
        if (frame.payload().length > config.maximumChunkBytes()) {
            throw new IllegalArgumentException("Stream frame exceeds MEDIA_MAX_CHUNK_BYTES");
        }
        Object lock = streamOperationLocks.computeIfAbsent(
                streamKey(frame.tenantId(), frame.sessionId()), ignored -> new Object());
        synchronized (lock) {
            return acceptFrameLocked(frame);
        }
    }

    /** Performs the provider call and cursor commit under the per-session stream fence. */
    private StreamAck acceptFrameLocked(StreamFrame frame) {
        StreamSession current = requireStream(frame.tenantId(), frame.sessionId());
        String tokenHash = hash(frame.connectionToken());
        if (!streamStore.tokenMatches(frame.tenantId(), frame.sessionId(), tokenHash)) {
            throw new SecurityException("Invalid media stream connection token");
        }
        if (current.state() != StreamState.CONNECTED && current.state() != StreamState.DEGRADED) {
            throw new IllegalStateException("Media stream is not connected");
        }
        if (current.leaseExpiresAt() == null || !current.leaseExpiresAt().isAfter(Instant.now())) {
            throw new IllegalStateException("Media stream connection lease expired");
        }
        StreamControl control = activeStreams.computeIfAbsent(
                streamKey(frame.tenantId(), frame.sessionId()),
                ignored -> streamControlFor(current));
        ConsentDecision consent = refreshConsent(current, control);
        CompletableFuture<StreamAck> future = control.provider().accept(
                new StreamContext(current, control.cancellation(), consent, control.governance()), frame);
        if (future == null) throw new IllegalStateException("Media streaming provider returned a null future");
        try {
            StreamAck ack = future.copy()
                    .orTimeout(config.jobTimeout().toMillis(), TimeUnit.MILLISECONDS)
                    .join();
            if (ack.acceptedSequence() != frame.sequence()) {
                throw new IllegalStateException("Media streaming provider acknowledged a different sequence");
            }
            if (ack.bufferedBytes() > current.maximumBufferedBytes()) {
                throw new IllegalStateException("Media streaming provider exceeded the session buffer limit");
            }
            streamStore.recordFrame(current, frame.sequence(), ack.bufferedBytes(), frame.endOfStream());
            return new StreamAck(ack.acceptedSequence(), ack.bufferedBytes(), ack.backpressured());
        } catch (java.util.concurrent.CompletionException failure) {
            Throwable cause = unwrap(failure);
            if (cause instanceof TimeoutException) {
                cancelTimedOutStreamFrame(control, future);
                throw new IllegalStateException("Media stream frame processing timed out", cause);
            }
            throw new IllegalStateException("Media stream frame processing failed", cause);
        } catch (java.util.concurrent.CancellationException failure) {
            throw new IllegalStateException("Media stream frame processing was cancelled", failure);
        }
    }

    public StreamSession closeStream(String tenantId, String sessionId, String token) {
        ensureOpen();
        Object lock = streamOperationLocks.computeIfAbsent(
                streamKey(tenantId, sessionId), ignored -> new Object());
        synchronized (lock) {
            StreamSession current = requireStream(tenantId, sessionId);
            if (!streamStore.tokenMatches(tenantId, sessionId, hash(token))) {
                throw new SecurityException("Invalid media stream connection token");
            }
            if (current.state() == StreamState.CLOSED || current.state() == StreamState.FAILED) {
                activeStreams.remove(streamKey(tenantId, sessionId));
                streamOperationLocks.remove(streamKey(tenantId, sessionId), lock);
                return current;
            }
            // OPEN sessions can be closed directly; durable stores intentionally do not permit
            // OPEN -> DRAINING. A connected session drains before its provider is closed.
            StreamSession closing = current.state() == StreamState.OPEN
                    || current.state() == StreamState.DRAINING
                    ? current
                    : streamStore.transition(current, StreamState.DRAINING);
            StreamControl activeControl = activeStreams.remove(streamKey(tenantId, sessionId));
            MediaStreamingProvider provider = activeControl == null
                    ? provider(current.providerId(), current.streamKind())
                    : activeControl.provider();
            MediaGovernanceContext governance = activeControl == null
                    ? governanceFromSession(current)
                    : activeControl.governance();
            ConsentDecision terminationConsent = provider.processingBoundary() == ProcessingBoundary.LOCAL
                    ? ConsentDecision.unverified()
                    : activeControl == null ? consentFromSession(current) : activeControl.consent();
            Cancellation cancellation = activeControl == null ? new Cancellation() : activeControl.cancellation();
            cancellation.cancel();
            provider.closeSession(new StreamContext(
                    closing, cancellation, terminationConsent, governance));
            StreamSession closed = streamStore.transition(closing, StreamState.CLOSED);
            streamOperationLocks.remove(streamKey(tenantId, sessionId), lock);
            audit.info("MEDIA_STREAM_CLOSED tenantId={} sessionId={} lastSequence={} consentAuthority={}",
                    tenantId, sessionId, closed.lastSequence(), terminationConsent.authorityId());
            publishLifecycle("media.stream.closed", tenantId, closed.principalId(), sessionId,
                    sessionId, "stream", sessionId, closed.version(),
                    governance.classification().name(), Map.of(
                            "streamKind", closed.streamKind().name(),
                            "providerId", closed.providerId(),
                            "lastSequence", closed.lastSequence(),
                            "state", closed.state().name()));
            return closed;
        }
    }

    public StreamSession closeStream(
            String tenantId, String principalId, String sessionId, String token) {
        stream(tenantId, principalId, sessionId)
                .orElseThrow(() -> new IllegalArgumentException(
                        "Media stream session not found: " + sessionId));
        return closeStream(tenantId, sessionId, token);
    }

    public Optional<StreamSession> stream(String tenantId, String sessionId) {
        ensureOpen();
        return streamStore.find(tenantId, sessionId);
    }

    public Optional<StreamSession> stream(String tenantId, String principalId, String sessionId) {
        return stream(tenantId, sessionId)
                .filter(value -> value.principalId().equals(principalId));
    }

    public MediaRuntimeConfig config() { return config; }

    public List<String> providerIds() {
        ensureOpen();
        return processingProviders.stream().map(MediaProcessingProvider::providerId).sorted().toList();
    }

    public List<String> streamingProviderIds() {
        ensureOpen();
        return streamingProviders.stream().map(MediaStreamingProvider::providerId).sorted().toList();
    }

    public List<MediaModalityContracts.CapabilityProfile> capabilityProfiles() {
        ensureOpen();
        return processingProviders.stream()
                .filter(MediaProcessingProvider::ready)
                .sorted(Comparator.comparing(provider -> canonical(provider.providerId())))
                .flatMap(provider -> provider.capabilityProfiles().stream())
                .sorted(Comparator
                        .comparing(MediaModalityContracts.CapabilityProfile::providerId)
                        .thenComparing(profile -> profile.modality().name()))
                .toList();
    }

    public boolean ready() {
        return readiness().ready();
    }

    /**
     * Returns the dependency-level readiness decision used by {@link #ready()} and HTTP probes.
     * Probe failures are represented as not-ready reasons so health checks fail closed instead of
     * throwing out of the readiness endpoint.
     */
    public Map<String, Object> readinessSnapshot() {
        ensureOpen();
        return readiness().snapshot();
    }

    public Map<String, Object> healthSnapshot() {
        ensureOpen();
        Readiness readiness = readiness();
        Map<String, Object> snapshot = new LinkedHashMap<>();
        snapshot.put("status", readiness.ready() ? "UP" : "DOWN");
        snapshot.put("readiness", readiness.snapshot());
        snapshot.put("profile", config.profile());
        snapshot.put("artifactStoreId", artifactStore.storeId());
        snapshot.put("artifactStoreDurable", artifactStore.durable());
        snapshot.put("jobStoreId", jobStore.storeId());
        snapshot.put("jobStoreDurable", jobStore.durable());
        snapshot.put("streamStoreId", streamStore.storeId());
        snapshot.put("streamStoreDurable", streamStore.durable());
        snapshot.put("providerIds", providerIds());
        snapshot.put("streamingProviderIds", streamingProviderIds());
        snapshot.put("providerHealth", processingProviders.stream().map(MediaRuntime::healthMap).toList());
        snapshot.put("streamingProviderHealth", streamingProviders.stream().map(MediaRuntime::healthMap).toList());
        snapshot.put("consentAuthorityId", consentAuthority == null ? "not-required" : consentAuthority.authorityId());
        snapshot.put("consentAuthorityReady", consentAuthority == null || safeReady(consentAuthority::ready));
        snapshot.put("semanticRedactionProviderId", semanticRedaction.providerId());
        snapshot.put("semanticRedactionReady", semanticRedaction.available());
        snapshot.put("lifecyclePublisherId", lifecyclePublisher.publisherId());
        snapshot.put("lifecyclePublisherReady", safeReady(lifecyclePublisher::ready));
        snapshot.put("activeJobs", activeJobs.size());
        snapshot.put("activeStreams", activeStreams.size());
        snapshot.put("availableJobPermits", concurrency.availablePermits());
        snapshot.put("metadataIntegration", "data-cloud-capability");
        snapshot.put("genericModelIntegration", "ai-inference-capability");
        return Map.copyOf(snapshot);
    }

    private static Map<String, Object> healthMap(MediaProcessingProvider provider) {
        try {
            var health = provider.health();
            return healthMap(health.providerId(), health.providerVersion(), health.status().name(),
                    health.degradationPolicy().name(), health.reason());
        } catch (RuntimeException failure) {
            return healthMap(safeText(() -> provider.providerId(), "unknown"), "unknown", "UNAVAILABLE",
                    "FAIL_CLOSED", "health probe failed: " + failure.getClass().getSimpleName());
        }
    }

    private static Map<String, Object> healthMap(MediaStreamingProvider provider) {
        try {
            var health = provider.health();
            return healthMap(health.providerId(), health.providerVersion(), health.status().name(),
                    health.degradationPolicy().name(), health.reason());
        } catch (RuntimeException failure) {
            return healthMap(safeText(() -> provider.providerId(), "unknown"), "unknown", "UNAVAILABLE",
                    "FAIL_CLOSED", "health probe failed: " + failure.getClass().getSimpleName());
        }
    }

    private static Map<String, Object> healthMap(
            String providerId, String providerVersion, String status, String degradationPolicy, String reason) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("providerId", safeValue(providerId, "unknown"));
        result.put("providerVersion", safeValue(providerVersion, "unknown"));
        result.put("status", safeValue(status, "UNAVAILABLE"));
        result.put("degradationPolicy", safeValue(degradationPolicy, "FAIL_CLOSED"));
        result.put("reason", safeValue(reason, ""));
        return Map.copyOf(result);
    }

    private Readiness readiness() {
        List<String> reasons = new ArrayList<>();
        Map<String, Object> components = new LinkedHashMap<>();
        boolean runtimeReady = !closed.get();
        components.put("runtime", component(runtimeReady, runtimeReady, false,
                runtimeReady ? "" : "runtime is closed"));
        if (!runtimeReady) reasons.add("runtime is closed");

        boolean artifactReady = safeReady(artifactStore::ready);
        boolean artifactDurable = safeBoolean(artifactStore::durable);
        boolean artifactEligible = safeBoolean(artifactStore::productionEligible);
        boolean artifactUsable = artifactReady
                && (!config.productionLike() || artifactDurable && artifactEligible);
        components.put("artifactStore", componentStatus(
                artifactUsable, artifactReady, artifactDurable, artifactEligible,
                config.productionLike(), "artifact store"));
        addStoreReason(reasons, artifactUsable, artifactReady, artifactDurable, artifactEligible,
                config.productionLike(), "artifact store");

        boolean jobReady = safeReady(jobStore::ready);
        boolean jobDurable = safeBoolean(jobStore::durable);
        boolean jobEligible = safeBoolean(jobStore::productionEligible);
        boolean jobUsable = jobReady && (!config.productionLike() || jobDurable && jobEligible);
        components.put("jobStore", componentStatus(
                jobUsable, jobReady, jobDurable, jobEligible,
                config.productionLike(), "job store"));
        addStoreReason(reasons, jobUsable, jobReady, jobDurable, jobEligible,
                config.productionLike(), "job store");

        boolean streamReady = safeReady(streamStore::ready);
        boolean streamDurable = safeBoolean(streamStore::durable);
        boolean streamEligible = safeBoolean(streamStore::productionEligible);
        boolean streamUsable = streamReady
                && (!config.productionLike() || streamDurable && streamEligible);
        components.put("streamStore", componentStatus(
                streamUsable, streamReady, streamDurable, streamEligible,
                config.productionLike(), "stream store"));
        addStoreReason(reasons, streamUsable, streamReady, streamDurable, streamEligible,
                config.productionLike(), "stream store");

        List<Map<String, Object>> processingStatus = new ArrayList<>();
        boolean processingAvailable = false;
        boolean externalProcessingRequired = false;
        for (MediaProcessingProvider provider : processingProviders) {
            boolean providerReady = safeReady(provider::ready);
            boolean providerEligible = safeBoolean(provider::productionEligible);
            Set<com.ghatana.media.runtime.MediaRuntimeContracts.JobType> capabilities = safeCapabilities(
                    provider::capabilities);
            ProcessingBoundary boundary = safeBoundary(provider::processingBoundary);
            boolean usable = providerReady && !capabilities.isEmpty() && boundary != null
                    && (!config.productionLike() || providerEligible);
            String reason = providerReason(
                    usable, providerReady, capabilities.isEmpty(), boundary == null,
                    providerEligible, config.productionLike(), "processing provider");
            if (usable) {
                try {
                    provider.verifyReady();
                } catch (RuntimeException failure) {
                    usable = false;
                    reason = "verification failed: " + failure.getClass().getSimpleName();
                }
            }
            processingStatus.add(providerStatus(
                    safeText(provider::providerId, "unknown"), providerReady, usable,
                    providerEligible, capabilities, boundary, reason));
            if (usable) {
                processingAvailable = true;
                externalProcessingRequired |= boundary == ProcessingBoundary.EXTERNAL;
            } else if (!reason.isBlank()) {
                reasons.add(safeText(provider::providerId, "unknown") + ": " + reason);
            }
        }
        components.put("processingProviders", List.copyOf(processingStatus));
        if (!processingAvailable) reasons.add("no usable Media processing provider is ready");

        List<Map<String, Object>> streamingStatus = new ArrayList<>();
        boolean streamingAvailable = false;
        for (MediaStreamingProvider provider : streamingProviders) {
            boolean providerReady = safeReady(provider::ready);
            boolean providerEligible = safeBoolean(provider::productionEligible);
            Set<com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind> capabilities = safeStreamCapabilities(
                    provider::capabilities);
            ProcessingBoundary boundary = safeBoundary(provider::processingBoundary);
            boolean usable = providerReady && !capabilities.isEmpty() && boundary != null
                    && (!config.productionLike() || providerEligible);
            String reason = providerReason(
                    usable, providerReady, capabilities.isEmpty(), boundary == null,
                    providerEligible, config.productionLike(), "streaming provider");
            if (usable) {
                try {
                    provider.verifyReady();
                } catch (RuntimeException failure) {
                    usable = false;
                    reason = "verification failed: " + failure.getClass().getSimpleName();
                }
            }
            streamingStatus.add(providerStatus(
                    safeText(provider::providerId, "unknown"), providerReady, usable,
                    providerEligible, capabilities, boundary, reason));
            if (usable) {
                streamingAvailable = true;
                externalProcessingRequired |= boundary == ProcessingBoundary.EXTERNAL;
            } else if (!reason.isBlank()) {
                reasons.add(safeText(provider::providerId, "unknown") + ": " + reason);
            }
        }
        components.put("streamingProviders", List.copyOf(streamingStatus));
        if (!streamingAvailable) reasons.add("no usable Media streaming provider is ready");

        boolean consentReady = !externalProcessingRequired
                || consentAuthority != null && safeReady(consentAuthority::ready);
        boolean consentEligible = consentAuthority != null && safeBoolean(consentAuthority::productionEligible);
        Map<String, Object> consentStatus = new LinkedHashMap<>();
        consentStatus.put("required", externalProcessingRequired);
        consentStatus.put("configured", consentAuthority != null);
        consentStatus.put("ready", consentAuthority == null ? !externalProcessingRequired : safeReady(consentAuthority::ready));
        consentStatus.put("productionEligible", consentEligible);
        components.put("consentAuthority", Map.copyOf(consentStatus));
        if (externalProcessingRequired && !consentReady) {
            reasons.add("external Media processing requires a ready consent authority");
        }
        if (config.productionLike() && externalProcessingRequired && !consentEligible) {
            reasons.add("consent authority is not production eligible");
        }

        boolean lifecycleReady = safeReady(lifecyclePublisher::ready);
        boolean lifecycleEligible = safeBoolean(lifecyclePublisher::productionEligible);
        boolean lifecycleUsable = !config.productionLike() || lifecycleReady && lifecycleEligible;
        components.put("lifecyclePublisher", component(
                lifecycleUsable, lifecycleReady, lifecycleEligible,
                lifecycleUsable ? "" : "lifecycle publisher is not production eligible"));
        if (!lifecycleUsable) reasons.add("production Media lifecycle publication is not ready");

        boolean allReady = runtimeReady && artifactUsable && jobUsable && streamUsable
                && processingAvailable && streamingAvailable && consentReady
                && lifecycleUsable;
        return new Readiness(allReady, components, reasons);
    }

    private static Map<String, Object> component(
            boolean usable, boolean ready, boolean eligible, String reason) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("ready", ready);
        result.put("usable", usable);
        result.put("productionEligible", eligible);
        result.put("reason", safeValue(reason, ""));
        return Map.copyOf(result);
    }

    private static Map<String, Object> componentStatus(
            boolean usable, boolean ready, boolean durable, boolean eligible,
            boolean productionLike, String name) {
        String reason = usable ? "" : !ready ? name + " is not ready"
                : productionLike && !durable ? name + " is not durable"
                : productionLike && !eligible ? name + " is not production eligible" : name + " is unusable";
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("ready", ready);
        result.put("usable", usable);
        result.put("durable", durable);
        result.put("productionEligible", eligible);
        result.put("reason", reason);
        return Map.copyOf(result);
    }

    private static void addStoreReason(
            List<String> reasons, boolean usable, boolean ready, boolean durable, boolean eligible,
            boolean productionLike, String name) {
        if (usable) return;
        if (!ready) reasons.add(name + " is not ready");
        else if (productionLike && !durable) reasons.add(name + " is not durable");
        else if (productionLike && !eligible) reasons.add(name + " is not production eligible");
        else reasons.add(name + " is unusable");
    }

    private static String providerReason(
            boolean usable, boolean ready, boolean noCapabilities, boolean noBoundary,
            boolean eligible, boolean productionLike, String name) {
        if (usable) return "";
        if (!ready) return name + " is not ready";
        if (noCapabilities) return name + " declares no capabilities";
        if (noBoundary) return name + " has no processing boundary";
        if (productionLike && !eligible) return name + " is not production eligible";
        return name + " is unusable";
    }

    private static Map<String, Object> providerStatus(
            String id, boolean ready, boolean usable, boolean productionEligible,
            Set<?> capabilities, ProcessingBoundary boundary, String reason) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("providerId", id);
        result.put("ready", ready);
        result.put("usable", usable);
        result.put("productionEligible", productionEligible);
        result.put("boundary", boundary == null ? "unknown" : boundary.name());
        result.put("capabilities", capabilities.stream().map(String::valueOf).sorted().toList());
        result.put("reason", safeValue(reason, ""));
        return Map.copyOf(result);
    }

    private static boolean usableProcessingProvider(
            MediaProcessingProvider provider, boolean productionLike) {
        try {
            return provider.ready() && provider.capabilities() != null
                    && !provider.capabilities().isEmpty()
                    && provider.processingBoundary() != null
                    && (!productionLike || provider.productionEligible());
        } catch (RuntimeException failure) {
            return false;
        }
    }

    private static boolean usableStreamingProvider(
            MediaStreamingProvider provider, boolean productionLike) {
        try {
            return provider.ready() && provider.capabilities() != null
                    && !provider.capabilities().isEmpty()
                    && provider.processingBoundary() != null
                    && (!productionLike || provider.productionEligible());
        } catch (RuntimeException failure) {
            return false;
        }
    }

    private static boolean safeReady(java.util.function.BooleanSupplier probe) {
        try { return probe.getAsBoolean(); }
        catch (RuntimeException failure) { return false; }
    }

    private static boolean safeBoolean(java.util.function.BooleanSupplier probe) {
        return safeReady(probe);
    }

    private static ProcessingBoundary safeBoundary(
            java.util.function.Supplier<ProcessingBoundary> probe) {
        try { return probe.get(); }
        catch (RuntimeException failure) { return null; }
    }

    private static Set<com.ghatana.media.runtime.MediaRuntimeContracts.JobType> safeCapabilities(
            java.util.function.Supplier<Set<com.ghatana.media.runtime.MediaRuntimeContracts.JobType>> probe) {
        try {
            Set<com.ghatana.media.runtime.MediaRuntimeContracts.JobType> values = probe.get();
            return values == null ? Set.of() : Set.copyOf(values);
        } catch (RuntimeException failure) { return Set.of(); }
    }

    private static Set<com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind> safeStreamCapabilities(
            java.util.function.Supplier<Set<com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind>> probe) {
        try {
            Set<com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind> values = probe.get();
            return values == null ? Set.of() : Set.copyOf(values);
        } catch (RuntimeException failure) { return Set.of(); }
    }

    private static String safeText(java.util.function.Supplier<String> probe, String fallback) {
        try { return safeValue(probe.get(), fallback); }
        catch (RuntimeException failure) { return fallback; }
    }

    private static String safeValue(String value, String fallback) {
        return value == null ? fallback : value;
    }

    private record Readiness(
            boolean ready,
            Map<String, Object> components,
            List<String> reasons) {
        private Readiness {
            components = Map.copyOf(components);
            reasons = List.copyOf(reasons);
        }

        private Map<String, Object> snapshot() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("ready", ready);
            result.put("components", components);
            result.put("reasons", reasons);
            return Map.copyOf(result);
        }
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) return;
        activeJobs.values().forEach(control -> {
            control.cancellation().cancel();
            control.future().cancel(true);
        });
        activeJobs.clear();
        activeStreams.values().forEach(control -> control.cancellation().cancel());
        activeStreams.clear();
        streamOperationLocks.clear();
        RuntimeException failure = null;
        failure = close(lifecyclePublisher, failure);
        failure = close(semanticRedaction, failure);
        for (int index = streamingProviders.size() - 1; index >= 0; index--) {
            failure = close(streamingProviders.get(index), failure);
        }
        for (int index = processingProviders.size() - 1; index >= 0; index--) {
            failure = close(processingProviders.get(index), failure);
        }
        if (consentAuthority != null) failure = close(consentAuthority, failure);
        failure = close(streamStore, failure);
        failure = close(jobStore, failure);
        failure = close(artifactStore, failure);
        if (failure != null) throw failure;
    }

    private CompletableFuture<ProcessingOutcome> startJob(
            ProcessingJob accepted,
            ProcessingJobRequest request,
            MediaArtifact artifact,
            List<MediaProcessingProvider> providers,
            Cancellation cancellation) {
        JobLease lease = jobStore.claim(
                accepted, workerId, Instant.now().plus(config.jobTimeout()).plusSeconds(30));
        final ProcessingJob running;
        try {
            running = jobStore.update(lease, accepted, new ProcessingJob(
                    accepted.jobId(), accepted.requestId(), accepted.tenantId(), accepted.principalId(), accepted.artifactId(),
                    accepted.jobType(), accepted.providerId(), JobStatus.RUNNING, accepted.createdAt(),
                    Instant.now(), null, Map.of(), "", accepted.version() + 1, accepted.requestFingerprint()));
        } catch (RuntimeException failure) {
            jobStore.release(lease);
            throw failure;
        }
        if (!concurrency.tryAcquire()) {
            jobStore.update(lease, running, transition(running, JobStatus.FAILED, Map.of(), "CONCURRENCY_LIMIT"));
            jobStore.release(lease);
            return CompletableFuture.failedFuture(new IllegalStateException("Media job concurrency limit reached"));
        }
        final java.util.concurrent.atomic.AtomicReference<CompletableFuture<Map<String, Object>>> activeProvider =
                new java.util.concurrent.atomic.AtomicReference<>();
        CompletableFuture<ProcessingOutcome> providerFuture = dispatchProcessing(
                request, artifact, providers, 0, cancellation, activeProvider);
        CompletableFuture<ProcessingOutcome> terminalFuture = providerFuture.whenComplete((outcome, failure) -> {
            concurrency.release();
            Throwable cause = failure == null ? null : unwrap(failure);
            boolean timedOut = cause instanceof TimeoutException;
            if (timedOut) {
                cancellation.cancel();
                CompletableFuture<Map<String, Object>> active = activeProvider.get();
                if (active != null) active.cancel(true);
            }

            Optional<ProcessingJob> current = jobStore.find(running.tenantId(), running.jobId());
            if (current.isEmpty() || terminal(current.get().status())) {
                jobStore.release(lease);
                return;
            }
            if (!jobStore.leaseValid(lease)) {
                audit.warn("MEDIA_JOB_STALE_WORKER_REJECTED tenantId={} jobId={} fencingToken={}",
                        running.tenantId(), running.jobId(), lease.fencingToken());
                return;
            }
            ProcessingJob value = current.get();
            ProcessingJob terminal;
            if (timedOut) {
                terminal = transition(value, JobStatus.FAILED,
                        Map.of("failureType", TimeoutException.class.getSimpleName()),
                        "PROCESSING_TIMEOUT");
            } else if (cancellation.cancelled()
                    || cause instanceof java.util.concurrent.CancellationException) {
                if (closed.get()) {
                    audit.warn("MEDIA_JOB_LOCAL_CANCELLATION_UNCONFIRMED tenantId={} jobId={} status={}",
                            value.tenantId(), value.jobId(), value.status());
                    jobStore.release(lease);
                    return;
                }
                terminal = transition(value, JobStatus.FAILED,
                        Map.of(
                                "failureType", cause == null
                                        ? "Cancellation"
                                        : cause.getClass().getSimpleName(),
                                "cancellationOutcome", "UNCONFIRMED"),
                        "PROCESSING_CANCELLED_UNCONFIRMED");
            } else if (cause != null) {
                terminal = transition(value, JobStatus.FAILED,
                        Map.of("failureType", cause.getClass().getSimpleName()),
                        "PROCESSING_FAILED");
            } else {
                try {
                    Map<String, Object> modalityResult = MediaModalityContracts.governedResult(
                            request, artifact, outcome.provider().providerId(),
                            outcome.provider().providerVersion(),
                            outcome.provider().modelVersion(request.jobType()),
                            outcome.result(), outcome.consent(),
                            outcome.provider().processingBoundary(),
                            outcome.provider().providerDataRetention());
                    Map<String, Object> governedResult = semanticRedaction.promoteIfRequested(
                            request, modalityResult, outcome.consent());
                    terminal = transition(value, outcome.provider().providerId(),
                            JobStatus.COMPLETED, governedResult, "");
                } catch (RuntimeException redactionFailure) {
                    terminal = transition(value, JobStatus.FAILED,
                            Map.of("failureType", redactionFailure.getClass().getSimpleName()),
                            "SEMANTIC_REDACTION_FAILED");
                    audit.warn(
                            "MEDIA_SEMANTIC_REDACTION_FAILED tenantId={} requestId={} jobId={} provider={} redactionProvider={} failureType={}",
                            request.tenantId(), request.requestId(), value.jobId(), value.providerId(),
                            semanticRedaction.providerId(), redactionFailure.getClass().getSimpleName());
                }
            }
            try {
                jobStore.update(lease, value, terminal);
                audit.info("MEDIA_JOB_TERMINAL tenantId={} jobId={} type={} provider={} status={} failureCode={}",
                        value.tenantId(), value.jobId(), value.jobType(), value.providerId(),
                        terminal.status(), terminal.failureCode());
                publishLifecycle("media.job." + terminal.status().name().toLowerCase(java.util.Locale.ROOT),
                        value.tenantId(), value.principalId(), request.correlationId(), request.requestId(),
                        "job", value.jobId(), terminal.version(), artifact.classification(), Map.of(
                                "artifactId", value.artifactId(),
                                "jobType", value.jobType().name(),
                                "providerId", terminal.providerId(),
                                "status", terminal.status().name(),
                                "failureCode", terminal.failureCode()));
            } catch (RuntimeException updateFailure) {
                log.error("Unable to persist terminal Media job state jobId={}", value.jobId(), updateFailure);
            } finally {
                jobStore.release(lease);
            }
        });
        terminalFuture.whenComplete((ignoredResult, ignoredFailure) -> {
            if (!terminalFuture.isCancelled()) return;
            cancellation.cancel();
            providerFuture.cancel(true);
            CompletableFuture<Map<String, Object>> active = activeProvider.get();
            if (active != null) active.cancel(true);
        });
        return terminalFuture;
    }

    private CompletableFuture<ProcessingOutcome> dispatchProcessing(
            ProcessingJobRequest request,
            MediaArtifact artifact,
            List<MediaProcessingProvider> providers,
            int index,
            Cancellation cancellation,
            java.util.concurrent.atomic.AtomicReference<CompletableFuture<Map<String, Object>>> active) {
        MediaProcessingProvider provider = providers.get(index);
        final ConsentDecision consent;
        final CompletableFuture<Map<String, Object>> raw;
        try {
            consent = consentFor(
                    request.tenantId(), request.principalId(), request.governanceContext(),
                    "job:" + request.jobType().name(), provider.processingBoundary());
            raw = java.util.Objects.requireNonNull(
                    provider.process(new ProcessingContext(request, artifact, cancellation, consent)),
                    "Media provider returned a null future");
        } catch (RuntimeException failure) {
            return fallbackOrFail(
                    request, artifact, providers, index, cancellation, active, provider, failure);
        }
        active.set(raw);
        CompletableFuture<Map<String, Object>> timed = raw.copy()
                .orTimeout(config.jobTimeout().toMillis(), TimeUnit.MILLISECONDS);
        CompletableFuture<ProcessingOutcome> result = new CompletableFuture<>();
        timed.whenComplete((value, failure) -> {
            if (result.isDone()) return;
            if (failure == null) {
                result.complete(new ProcessingOutcome(
                        provider, consent, Map.copyOf(value == null ? Map.of() : value)));
                return;
            }
            Throwable cause = unwrap(failure);
            if (cause instanceof TimeoutException) raw.cancel(true);
            fallbackOrFail(request, artifact, providers, index, cancellation, active, provider, cause)
                    .whenComplete((next, nextFailure) -> {
                        if (nextFailure == null) result.complete(next);
                        else result.completeExceptionally(unwrap(nextFailure));
                    });
        });
        result.whenComplete((ignored, ignoredFailure) -> {
            if (result.isCancelled()) {
                timed.cancel(true);
                raw.cancel(true);
            }
        });
        return result;
    }

    private CompletableFuture<ProcessingOutcome> fallbackOrFail(
            ProcessingJobRequest request,
            MediaArtifact artifact,
            List<MediaProcessingProvider> providers,
            int index,
            Cancellation cancellation,
            java.util.concurrent.atomic.AtomicReference<CompletableFuture<Map<String, Object>>> active,
            MediaProcessingProvider failedProvider,
            Throwable failure) {
        if (!cancellation.cancelled()
                && failedProvider.fallbackEligible(failure)
                && index + 1 < providers.size()) {
            MediaProcessingProvider fallback = providers.get(index + 1);
            audit.warn("MEDIA_PROVIDER_FALLBACK tenantId={} requestId={} failedProvider={} fallbackProvider={} failureType={}",
                    request.tenantId(), request.requestId(), failedProvider.providerId(),
                    fallback.providerId(), failure.getClass().getSimpleName());
            return dispatchProcessing(
                    request, artifact, providers, index + 1, cancellation, active);
        }
        return CompletableFuture.failedFuture(failure);
    }

    private void reconcileJobsAfterRestart() {
        for (ProcessingJob job : jobStore.recoverable(1_000)) {
            try {
                ProcessingJob reconciled = new ProcessingJob(
                        job.jobId(), job.requestId(), job.tenantId(), job.principalId(), job.artifactId(),
                        job.jobType(), job.providerId(), JobStatus.OUTCOME_UNKNOWN, job.createdAt(),
                        job.startedAt(), null,
                        Map.of("reconciliation", "provider outcome unknown after runtime restart"),
                        "", job.version() + 1, job.requestFingerprint());
                jobStore.update(job, reconciled);
                audit.warn("MEDIA_JOB_RECONCILED_AFTER_RESTART tenantId={} jobId={} priorStatus={}",
                        job.tenantId(), job.jobId(), job.status());
            } catch (RuntimeException failure) {
                throw new IllegalStateException(
                        "Unable to reconcile non-terminal Media job " + job.jobId(), failure);
            }
        }
    }

    private void publishLifecycle(
            String eventType,
            String tenantId,
            String principalId,
            String correlationId,
            String causationId,
            String aggregateType,
            String aggregateId,
            long aggregateVersion,
            String classification,
            Map<String, Object> attributes) {
        if (!lifecyclePublisher.ready()) return;
        String eventId = "media:" + eventType + ":" + aggregateId + ":" + aggregateVersion;
        try {
            lifecyclePublisher.publish(new MediaLifecycleEvent(
                    eventId, eventType, tenantId, principalId, correlationId, causationId,
                    aggregateType, aggregateId, aggregateVersion, classification, Instant.now(), attributes));
        } catch (RuntimeException failure) {
            audit.error(
                    "MEDIA_LIFECYCLE_PUBLICATION_UNCONFIRMED tenantId={} eventId={} eventType={} aggregateType={} aggregateId={} failureType={}",
                    tenantId, eventId, eventType, aggregateType, aggregateId,
                    failure.getClass().getSimpleName());
            log.error("Media lifecycle publication is unconfirmed eventId={}", eventId, failure);
        }
    }

    private List<MediaProcessingProvider> selectProcessingProviders(ProcessingJobRequest request) {
        List<MediaProcessingProvider> eligible = processingProviders.stream()
                .filter(provider -> usableProcessingProvider(provider, config.productionLike())
                        && provider.capabilities().contains(request.jobType()))
                .filter(provider -> request.providerHint().isBlank()
                        || provider.providerId().equalsIgnoreCase(request.providerHint()))
                .sorted(Comparator.comparingInt(MediaProcessingProvider::priority)
                        .thenComparing(provider -> canonical(provider.providerId())))
                .toList();
        if (eligible.isEmpty()) {
            throw new IllegalStateException(
                    "No Media provider available for job type " + request.jobType());
        }
        return eligible;
    }

    private MediaStreamingProvider selectStreamingProvider(StreamSessionRequest request) {
        return streamingProviders.stream()
                .filter(provider -> usableStreamingProvider(provider, config.productionLike())
                        && provider.capabilities().contains(request.streamKind()))
                .filter(provider -> request.providerHint().isBlank()
                        || provider.providerId().equalsIgnoreCase(request.providerHint()))
                .sorted(Comparator.comparingInt(MediaStreamingProvider::priority)
                        .thenComparing(provider -> canonical(provider.providerId())))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException(
                        "No Media streaming provider available for " + request.streamKind()));
    }

    private MediaStreamingProvider provider(
            String providerId,
            com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind kind) {
        return streamingProviders.stream()
                .filter(provider -> provider.providerId().equalsIgnoreCase(providerId)
                        && usableStreamingProvider(provider, config.productionLike())
                        && provider.capabilities().contains(kind))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException(
                        "Media streaming provider is unavailable: " + providerId));
    }

    private ConsentDecision consentFor(
            String tenantId,
            String principalId,
            MediaGovernanceContext governance,
            String operation,
            ProcessingBoundary boundary) {
        if (boundary == ProcessingBoundary.LOCAL) return ConsentDecision.unverified();
        if (consentAuthority == null || !consentAuthority.ready()) {
            throw new SecurityException("External Media processing requires a ready consent authority");
        }
        ConsentDecision decision = java.util.Objects.requireNonNull(
                consentAuthority.verify(tenantId, principalId, governance, operation),
                "Media consent authority returned null decision");
        if (!decision.activeAt(Instant.now())) {
            throw new SecurityException("Media consent is not active for external processing");
        }
        if (!governance.consentId().equals(decision.consentId())) {
            throw new SecurityException("Media consent identity does not match requested consent");
        }
        return decision;
    }

    private StreamControl streamControlFor(StreamSession session) {
        MediaStreamingProvider provider = provider(session.providerId(), session.streamKind());
        MediaGovernanceContext governance = governanceFromSession(session);
        ConsentDecision consent = consentFor(
                session.tenantId(), session.principalId(), governance,
                "stream:" + session.streamKind().name(), provider.processingBoundary());
        return new StreamControl(new Cancellation(), provider, governance, consent);
    }

    private ConsentDecision refreshConsent(StreamSession session, StreamControl control) {
        if (control.provider().processingBoundary() == ProcessingBoundary.LOCAL) {
            return ConsentDecision.unverified();
        }
        return consentFor(
                session.tenantId(), session.principalId(), control.governance(),
                "stream:" + session.streamKind().name(), control.provider().processingBoundary());
    }

    private static Map<String, Object> governedStreamMetadata(
            Map<String, Object> source,
            MediaGovernanceContext governance,
            ConsentDecision consent) {
        Map<String, Object> metadata = new LinkedHashMap<>(source == null ? Map.of() : source);
        metadata.put(META_CONSENT_ID, governance.consentId());
        metadata.put(META_PURPOSE, governance.purpose());
        metadata.put(META_CLASSIFICATION, governance.classification().name());
        metadata.put(META_RESIDENCY, governance.residency());
        metadata.put(META_ALLOWED_REGIONS, List.copyOf(governance.allowedRegions()));
        metadata.put(META_EXTERNAL_ALLOWED, governance.externalProcessingAllowed());
        metadata.put(META_RETENTION_POLICY, governance.retentionPolicy());
        metadata.put(META_PROVIDER_RETENTION_ALLOWED, governance.providerRetentionAllowed());
        metadata.put(META_BIOMETRIC_ALLOWED, governance.biometricProcessingAllowed());
        metadata.put(META_BIOMETRIC_BASIS, governance.biometricProcessingBasis());
        metadata.put(META_BIOMETRIC_SENSITIVITY, governance.biometricSensitivity().name());
        metadata.put(META_AUTOMATION_RISK, governance.automationRisk().name());
        metadata.put(META_CONSENT_VERIFIED, consent.verified());
        metadata.put(META_CONSENT_AUTHORITY, consent.authorityId());
        metadata.put(META_CONSENT_VERIFIED_AT, consent.verifiedAt().toString());
        if (consent.expiresAt() != null) {
            metadata.put(META_CONSENT_EXPIRES_AT, consent.expiresAt().toString());
        }
        metadata.put(META_CONSENT_ALLOWED_PURPOSES, List.copyOf(consent.allowedPurposes()));
        metadata.put(META_CONSENT_ALLOWED_REGIONS, List.copyOf(consent.allowedRegions()));
        metadata.put(META_CONSENT_EXTERNAL_ALLOWED, consent.externalProcessingAllowed());
        metadata.put(META_CONSENT_BIOMETRIC_ALLOWED, consent.biometricProcessingAllowed());
        return Map.copyOf(metadata);
    }

    private static MediaGovernanceContext governanceFromSession(StreamSession session) {
        Map<String, Object> metadata = session.metadata();
        return new MediaGovernanceContext(
                text(metadata.get(META_CONSENT_ID)),
                defaultText(metadata.get(META_PURPOSE), "unspecified"),
                enumValue(metadata.get(META_CLASSIFICATION), DataClassification.class, DataClassification.INTERNAL),
                defaultText(metadata.get(META_RESIDENCY), "unspecified"),
                stringSet(metadata.get(META_ALLOWED_REGIONS)),
                booleanValue(metadata.get(META_EXTERNAL_ALLOWED)),
                defaultText(metadata.get(META_RETENTION_POLICY), "service-default"),
                booleanValue(metadata.get(META_PROVIDER_RETENTION_ALLOWED)),
                booleanValue(metadata.get(META_BIOMETRIC_ALLOWED)),
                text(metadata.get(META_BIOMETRIC_BASIS)),
                enumValue(metadata.get(META_BIOMETRIC_SENSITIVITY),
                        BiometricSensitivity.class, BiometricSensitivity.NONE),
                enumValue(metadata.get(META_AUTOMATION_RISK), AutomationRisk.class, AutomationRisk.ASSISTIVE));
    }

    private static ConsentDecision consentFromSession(StreamSession session) {
        Map<String, Object> metadata = session.metadata();
        boolean verified = booleanValue(metadata.get(META_CONSENT_VERIFIED));
        String authorityId = text(metadata.get(META_CONSENT_AUTHORITY));
        String consentId = text(metadata.get(META_CONSENT_ID));
        Instant verifiedAt = instantOrEpoch(metadata.get(META_CONSENT_VERIFIED_AT));
        Instant expiresAt = nullableInstant(metadata.get(META_CONSENT_EXPIRES_AT));
        ConsentDecision decision = new ConsentDecision(
                verified,
                authorityId,
                consentId,
                verifiedAt,
                expiresAt,
                stringSet(metadata.get(META_CONSENT_ALLOWED_PURPOSES)),
                stringSet(metadata.get(META_CONSENT_ALLOWED_REGIONS)),
                booleanValue(metadata.get(META_CONSENT_EXTERNAL_ALLOWED)),
                booleanValue(metadata.get(META_CONSENT_BIOMETRIC_ALLOWED)));
        if (session.providerId() != null && !session.providerId().isBlank()
                && verified && decision.authorityId().isBlank()) {
            throw new IllegalStateException("Persisted Media consent evidence is incomplete");
        }
        return decision;
    }

    private StreamSession requireStream(String tenantId, String sessionId) {
        return streamStore.find(tenantId, sessionId)
                .orElseThrow(() -> new IllegalArgumentException(
                        "Media stream session not found: " + sessionId));
    }

    private static ProcessingJob cancellationRequested(
            ProcessingJob current,
            CancellationOutcome outcome) {
        Map<String, Object> result = new LinkedHashMap<>(current.result());
        result.put("cancellationOutcome", outcome.name());
        result.put("cancellationRequestedAt", Instant.now().toString());
        return new ProcessingJob(
                current.jobId(), current.requestId(), current.tenantId(), current.principalId(), current.artifactId(),
                current.jobType(), current.providerId(), current.status(), current.createdAt(), current.startedAt(),
                current.completedAt(), Map.copyOf(result), current.failureCode(), current.version() + 1,
                current.requestFingerprint());
    }

    private static ProcessingJob transition(
            ProcessingJob current,
            JobStatus status,
            Map<String, Object> result,
            String failureCode) {
        return transition(current, current.providerId(), status, result, failureCode);
    }

    private static ProcessingJob transition(
            ProcessingJob current,
            String providerId,
            JobStatus status,
            Map<String, Object> result,
            String failureCode) {
        return new ProcessingJob(
                current.jobId(), current.requestId(), current.tenantId(), current.principalId(), current.artifactId(),
                current.jobType(), providerId, status, current.createdAt(), current.startedAt(),
                Instant.now(), result, failureCode, current.version() + 1, current.requestFingerprint());
    }

    private static boolean terminal(JobStatus status) {
        return status == JobStatus.COMPLETED
                || status == JobStatus.FAILED
                || status == JobStatus.CANCELLED;
    }

    private static void cancelTimedOutStreamFrame(
            StreamControl control,
            CompletableFuture<StreamAck> future) {
        control.cancellation().cancel();
        future.cancel(true);
    }

    private static Throwable unwrap(Throwable failure) {
        Throwable current = failure;
        while ((current instanceof java.util.concurrent.CompletionException
                || current instanceof java.util.concurrent.ExecutionException)
                && current.getCause() != null) current = current.getCause();
        return current;
    }

    private static <T> void register(
            List<T> providers,
            T provider,
            java.util.function.Function<T, String> id) {
        String providerId = canonical(id.apply(provider));
        if (providers.stream().anyMatch(existing -> canonical(id.apply(existing)).equals(providerId))) {
            throw new IllegalStateException("Duplicate Media provider ID: " + providerId);
        }
        providers.add(provider);
    }

    private static <T> List<T> loadUnique(
            Class<T> type,
            java.util.function.Function<T, String> id) {
        Map<String, T> values = new LinkedHashMap<>();
        for (T value : ServiceLoader.load(type)) {
            String key = canonical(id.apply(value));
            if (values.putIfAbsent(key, value) != null) {
                throw new IllegalStateException("Duplicate Media runtime component ID: " + key);
            }
        }
        return values.entrySet().stream().sorted(Map.Entry.comparingByKey())
                .map(Map.Entry::getValue).toList();
    }

    private static <T> List<T> append(List<T> values, T value) {
        List<T> result = new ArrayList<>(values);
        result.add(value);
        return List.copyOf(result);
    }

    private static MediaConsentAuthority selectConsentAuthority(
            List<MediaConsentAuthority> authorities,
            String configuredId,
            boolean productionLike,
            boolean required) {
        List<MediaConsentAuthority> ready = authorities.stream()
                .filter(MediaConsentAuthority::ready)
                .sorted(Comparator.comparing(authority -> canonical(authority.authorityId())))
                .toList();
        if (!configuredId.isBlank()) {
            ready = ready.stream()
                    .filter(authority -> canonical(authority.authorityId()).equals(configuredId))
                    .toList();
        }
        if (!required && ready.isEmpty()) return null;
        if (ready.size() != 1) {
            throw new IllegalStateException(
                    "Expected exactly one ready Media consent authority, found " + ready.size());
        }
        MediaConsentAuthority selected = ready.getFirst();
        if (productionLike && !selected.productionEligible()) {
            throw new IllegalStateException("Media consent authority is not production eligible");
        }
        return selected;
    }

    private static <T> T selectStore(
            List<T> stores,
            String configuredId,
            boolean productionLike,
            String kind) {
        java.util.function.Function<T, String> id = value -> {
            if (value instanceof MediaArtifactStore store) return store.storeId();
            if (value instanceof MediaJobStore store) return store.storeId();
            return ((MediaStreamSessionStore) value).storeId();
        };
        java.util.function.Predicate<T> ready = value -> {
            if (value instanceof MediaArtifactStore store) return store.ready();
            if (value instanceof MediaJobStore store) return store.ready();
            return ((MediaStreamSessionStore) value).ready();
        };
        java.util.function.Predicate<T> eligible = value -> {
            if (value instanceof MediaArtifactStore store) return store.productionEligible();
            if (value instanceof MediaJobStore store) return store.productionEligible();
            return ((MediaStreamSessionStore) value).productionEligible();
        };
        java.util.function.Predicate<T> durable = value -> {
            if (value instanceof MediaArtifactStore store) return store.durable();
            if (value instanceof MediaJobStore store) return store.durable();
            return ((MediaStreamSessionStore) value).durable();
        };
        List<T> candidates = stores.stream().filter(ready).toList();
        if (!configuredId.isBlank()) {
            candidates = candidates.stream()
                    .filter(value -> canonical(id.apply(value)).equals(configuredId)).toList();
        }
        if (candidates.size() != 1) {
            throw new IllegalStateException(
                    "Expected exactly one Media " + kind + " store, found " + candidates.size());
        }
        T selected = candidates.getFirst();
        if (productionLike && !durable.test(selected)) {
            throw new IllegalStateException("Media " + kind + " store is not durable");
        }
        if (productionLike && !eligible.test(selected)) {
            throw new IllegalStateException("Media " + kind + " store is not production eligible");
        }
        return selected;
    }

    private static String connectionToken() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static String hash(String value) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("connection token is required");
        }
        try {
            return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception failure) {
            throw new IllegalStateException("SHA-256 is unavailable", failure);
        }
    }

    private static String streamKey(String tenantId, String sessionId) {
        return tenantId.length() + ":" + tenantId + ':' + sessionId.length() + ':' + sessionId;
    }

    private static void requirePrincipal(String principalId) {
        if (principalId == null || principalId.isBlank()) {
            throw new SecurityException("Authenticated principal is required");
        }
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("Media Runtime is closed");
    }

    private static String canonicalOptional(String value) {
        return value == null ? "" : value.trim().toLowerCase(java.util.Locale.ROOT);
    }

    private static String canonical(String value) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("component ID is required");
        }
        return value.trim().toLowerCase(java.util.Locale.ROOT);
    }

    private static String text(Object value) {
        return value == null ? "" : String.valueOf(value).trim();
    }

    private static String defaultText(Object value, String fallback) {
        String text = text(value);
        return text.isBlank() ? fallback : text;
    }

    private static boolean booleanValue(Object value) {
        return value instanceof Boolean bool && bool;
    }

    private static <E extends Enum<E>> E enumValue(
            Object value, Class<E> type, E fallback) {
        String text = text(value);
        if (text.isBlank()) return fallback;
        try {
            return Enum.valueOf(type, text.toUpperCase(java.util.Locale.ROOT));
        } catch (IllegalArgumentException failure) {
            throw new IllegalStateException(
                    "Persisted Media governance enum is malformed: " + type.getSimpleName(), failure);
        }
    }

    private static Set<String> stringSet(Object value) {
        if (!(value instanceof Iterable<?> iterable)) return Set.of();
        LinkedHashSet<String> result = new LinkedHashSet<>();
        for (Object item : iterable) {
            String text = text(item).toLowerCase(java.util.Locale.ROOT);
            if (!text.isBlank()) result.add(text);
        }
        return Set.copyOf(result);
    }

    private static Instant instantOrEpoch(Object value) {
        Instant parsed = nullableInstant(value);
        return parsed == null ? Instant.EPOCH : parsed;
    }

    private static Instant nullableInstant(Object value) {
        String text = text(value);
        if (text.isBlank()) return null;
        try {
            return Instant.parse(text);
        } catch (DateTimeParseException failure) {
            throw new IllegalStateException("Persisted Media consent timestamp is malformed", failure);
        }
    }

    private static RuntimeException close(
            AutoCloseable closeable,
            RuntimeException current) {
        try {
            closeable.close();
            return current;
        } catch (Exception failure) {
            RuntimeException wrapped = failure instanceof RuntimeException runtime
                    ? runtime
                    : new IllegalStateException("Media Runtime resource close failed", failure);
            if (current == null) return wrapped;
            current.addSuppressed(wrapped);
            return current;
        }
    }

    private static void safeClose(AutoCloseable closeable, RuntimeException primary) {
        if (closeable == null) return;
        try {
            closeable.close();
        } catch (Exception failure) {
            primary.addSuppressed(failure);
        }
    }

    private record JobControl(
            Cancellation cancellation,
            CompletableFuture<?> future) { }

    private record ProcessingOutcome(
            MediaProcessingProvider provider,
            ConsentDecision consent,
            Map<String, Object> result) { }

    private record StreamControl(
            Cancellation cancellation,
            MediaStreamingProvider provider,
            MediaGovernanceContext governance,
            ConsentDecision consent) { }
}
