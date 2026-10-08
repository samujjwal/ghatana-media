package com.ghatana.media.runtime;

import java.time.Duration;
import java.time.Instant;
import java.lang.reflect.Array;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Service-owned artifact, governance, consent, upload, job, stream, and provider contracts for Media Runtime.
 *
 * @doc.type class
 * @doc.purpose Provide Media Runtime Contracts behavior
 * @doc.layer product
 * @doc.pattern Component
 */
public final class MediaRuntimeContracts {
    private MediaRuntimeContracts() { }

    /** A compare-and-set conflict caused by a newer concurrent job transition. */
    public static final class MediaJobStoreConflictException extends IllegalStateException {
        public MediaJobStoreConflictException(String message) { super(message); }
    }

    public enum UploadStatus { OPEN, FINALIZING, COMPLETED, ABORTED, EXPIRED }
    /** Logical job outcome and observation; OUTCOME_UNKNOWN is never a replay or failure signal. */
    public enum JobStatus { ACCEPTED, RUNNING, OUTCOME_UNKNOWN, COMPLETED, FAILED, CANCELLED }
    public enum CancellationOutcome { CONFIRMED, REQUESTED_UNCONFIRMED, UNSUPPORTED }
    public enum JobType { TRANSCODE, SPEECH_TO_TEXT, TEXT_TO_SPEECH, VISION, MULTIMODAL }
    public enum StreamKind { AUDIO, VIDEO, MULTIMODAL }
    public enum StreamState { OPEN, CONNECTED, DEGRADED, DRAINING, CLOSED, FAILED }
    public enum ProcessingBoundary { LOCAL, EXTERNAL }
    public enum ProviderDataRetention { UNKNOWN, NONE, TRANSIENT, PERSISTENT }
    public enum ResultClassification { SENSITIVE, DEIDENTIFIED }
    public enum DataClassification {
        PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED;

        public boolean isAtLeast(DataClassification floor) {
            return ordinal() >= java.util.Objects.requireNonNull(floor, "floor").ordinal();
        }
    }
    public enum BiometricSensitivity { NONE, DERIVED, TEMPLATE }
    public enum AutomationRisk { ASSISTIVE, DECISION_SUPPORT, CONSEQUENTIAL }

    /**
     * Privacy/purpose envelope requested for media processing or streaming. This is intent, not
     * authority: an external provider must enforce the intersection of this request and the
     * permissions returned by a verified {@link ConsentDecision}.
     */
    public record MediaGovernanceContext(
            String consentId,
            String purpose,
            DataClassification classification,
            String residency,
            Set<String> allowedRegions,
            boolean externalProcessingAllowed,
            String retentionPolicy,
            boolean providerRetentionAllowed,
            boolean biometricProcessingAllowed,
            String biometricProcessingBasis,
            BiometricSensitivity biometricSensitivity,
            AutomationRisk automationRisk) {
        public MediaGovernanceContext {
            consentId = optional(consentId);
            purpose = normalizedRequired(purpose, "purpose");
            classification = classification == null ? DataClassification.INTERNAL : classification;
            residency = normalizedRequired(residency, "residency");
            allowedRegions = normalizedSet(allowedRegions);
            retentionPolicy = normalizedRequired(retentionPolicy, "retentionPolicy");
            biometricProcessingBasis = optional(biometricProcessingBasis);
            biometricSensitivity = biometricSensitivity == null
                    ? BiometricSensitivity.NONE : biometricSensitivity;
            automationRisk = automationRisk == null ? AutomationRisk.ASSISTIVE : automationRisk;
            if (biometricProcessingAllowed && biometricProcessingBasis.isBlank()) {
                throw new IllegalArgumentException(
                        "biometricProcessingBasis is required when biometric processing is allowed");
            }
            if (biometricProcessingAllowed && "service-default".equalsIgnoreCase(retentionPolicy)) {
                throw new IllegalArgumentException(
                        "explicit biometric retentionPolicy is required when biometric processing is allowed");
            }
            if (!biometricProcessingAllowed && biometricSensitivity != BiometricSensitivity.NONE) {
                throw new IllegalArgumentException(
                        "biometricSensitivity requires biometric processing permission");
            }
        }

        /** Compatibility constructor with conservative retention and classification defaults. */
        public MediaGovernanceContext(
                String consentId,
                String purpose,
                String residency,
                Set<String> allowedRegions,
                boolean externalProcessingAllowed,
                boolean biometricProcessingAllowed) {
            this(consentId, purpose, DataClassification.RESTRICTED, residency, allowedRegions,
                    externalProcessingAllowed, "service-default", false,
                    biometricProcessingAllowed,
                    biometricProcessingAllowed ? "explicit-consent" : "",
                    biometricProcessingAllowed ? BiometricSensitivity.DERIVED : BiometricSensitivity.NONE,
                    AutomationRisk.ASSISTIVE);
        }

        public static MediaGovernanceContext compatibilityDefault() {
            return new MediaGovernanceContext(
                    "", "unspecified", DataClassification.INTERNAL, "unspecified", Set.of(),
                    false, "service-default", false, false, "",
                    BiometricSensitivity.NONE, AutomationRisk.ASSISTIVE);
        }

        public boolean permitsRegion(String region) {
            String normalized = optional(region).toLowerCase(Locale.ROOT);
            return !normalized.isBlank() && (allowedRegions.contains("*") || allowedRegions.contains(normalized));
        }

        /** Derived data may preserve or raise, but never silently lower, its source floor. */
        public boolean permitsDerivedClassification(DataClassification derived) {
            return java.util.Objects.requireNonNull(derived, "derived").isAtLeast(classification);
        }
    }

    /**
     * Authenticated, revocation-aware consent outcome supplied by a real authority. Permission
     * fields are authority-owned; callers cannot widen them through {@link MediaGovernanceContext}.
     */
    public record ConsentDecision(
            boolean verified,
            String authorityId,
            String consentId,
            Instant verifiedAt,
            Instant expiresAt,
            Set<String> allowedPurposes,
            Set<String> allowedRegions,
            boolean externalProcessingAllowed,
            boolean biometricProcessingAllowed) {
        public ConsentDecision {
            authorityId = optional(authorityId);
            consentId = optional(consentId);
            verifiedAt = verifiedAt == null ? Instant.EPOCH : verifiedAt;
            allowedPurposes = normalizedSet(allowedPurposes);
            allowedRegions = normalizedSet(allowedRegions);
            if (verified && (authorityId.isBlank() || consentId.isBlank())) {
                throw new IllegalArgumentException("verified consent requires authorityId and consentId");
            }
            if (verified && expiresAt != null && !expiresAt.isAfter(verifiedAt)) {
                throw new IllegalArgumentException("consent expiresAt must be after verifiedAt");
            }
        }

        /** Compatibility bridge; intentionally grants no processing rights. */
        public ConsentDecision(
                boolean verified,
                String authorityId,
                String consentId,
                Instant verifiedAt,
                Instant expiresAt) {
            this(verified, authorityId, consentId, verifiedAt, expiresAt,
                    Set.of(), Set.of(), false, false);
        }

        public static ConsentDecision unverified() {
            return new ConsentDecision(
                    false, "", "", Instant.EPOCH, null,
                    Set.of(), Set.of(), false, false);
        }

        public boolean activeAt(Instant instant) {
            return verified && (expiresAt == null || expiresAt.isAfter(instant));
        }

        public boolean permitsPurpose(String purpose) {
            String normalized = optional(purpose).toLowerCase(Locale.ROOT);
            return !normalized.isBlank()
                    && (allowedPurposes.contains("*") || allowedPurposes.contains(normalized));
        }

        public boolean permitsRegion(String region) {
            String normalized = optional(region).toLowerCase(Locale.ROOT);
            return !normalized.isBlank()
                    && (allowedRegions.contains("*") || allowedRegions.contains(normalized));
        }
    }

    /** Provider boundary for authoritative, revocation-aware consent verification. */
    public interface MediaConsentAuthority extends AutoCloseable {
        String authorityId();
        ConsentDecision verify(
                String tenantId,
                String principalId,
                MediaGovernanceContext governance,
                String operation);
        boolean ready();
        boolean productionEligible();
        @Override default void close() { }
    }

    /**
     * Semantic de-identification request. Sensitive source text is passed only to the selected
     * provider and is never part of redaction provenance. The caller must still obey the request's
     * classification, residency, consent, and retention policy.
     */
    public record SemanticRedactionRequest(
            String tenantId,
            String principalId,
            String correlationId,
            String sourceText,
            String language,
            MediaGovernanceContext governanceContext) {
        public SemanticRedactionRequest {
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            correlationId = required(correlationId, "correlationId");
            sourceText = required(sourceText, "sourceText");
            language = optional(language);
            governanceContext = governanceContext == null
                    ? MediaGovernanceContext.compatibilityDefault() : governanceContext;
        }
    }

    /**
     * Proven de-identification outcome. A result can be promoted only when {@code safeForPromotion}
     * is true and the provider explicitly classifies it as {@link ResultClassification#DEIDENTIFIED}.
     */
    public record SemanticRedactionResult(
            String redactedText,
            ResultClassification classification,
            boolean safeForPromotion,
            String providerId,
            String policyVersion,
            Set<String> redactionCategories,
            Instant evaluatedAt,
            Map<String, Object> provenance) {
        public SemanticRedactionResult {
            redactedText = required(redactedText, "redactedText");
            classification = java.util.Objects.requireNonNull(classification, "classification");
            providerId = required(providerId, "providerId");
            policyVersion = required(policyVersion, "policyVersion");
            redactionCategories = normalizedSet(redactionCategories);
            evaluatedAt = evaluatedAt == null ? Instant.now() : evaluatedAt;
            provenance = Map.copyOf(provenance == null ? Map.of() : provenance);
            if (safeForPromotion && classification != ResultClassification.DEIDENTIFIED) {
                throw new IllegalArgumentException(
                        "safeForPromotion requires DEIDENTIFIED classification");
            }
        }
    }

    /**
     * Provider-neutral semantic redaction SPI. Production promotion must never substitute a
     * structural key filter, regex-only helper, or caller assertion for this provider decision.
     */
    public interface MediaSemanticRedactionProvider extends AutoCloseable {
        String providerId();
        boolean ready();
        boolean productionEligible();
        ProcessingBoundary processingBoundary();
        default String processingRegion() { return "unspecified"; }
        default ProviderDataRetention providerDataRetention() { return ProviderDataRetention.UNKNOWN; }
        CompletableFuture<SemanticRedactionResult> redact(SemanticRedactionRequest request);
        @Override default void close() { }
    }

    public record UploadRequest(
            String tenantId,
            String principalId,
            String fileName,
            String contentType,
            long expectedSizeBytes,
            String expectedSha256,
            String classification,
            Duration retention,
            Map<String, Object> metadata) {
        public UploadRequest {
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            fileName = required(fileName, "fileName");
            contentType = required(contentType, "contentType");
            if (expectedSizeBytes < 1) throw new IllegalArgumentException("expectedSizeBytes must be positive");
            expectedSha256 = requireSha256(expectedSha256);
            classification = required(classification, "classification");
            if (retention == null || retention.isZero() || retention.isNegative()
                    || retention.compareTo(Duration.ofDays(3_650)) > 0) {
                throw new IllegalArgumentException("retention must be between 1 ms and 3650 days");
            }
            metadata = Map.copyOf(metadata == null ? Map.of() : metadata);
        }

        public String purpose() { return metadataPurpose(metadata); }
    }

    public record UploadSession(
            String uploadId,
            String tenantId,
            String principalId,
            String fileName,
            String contentType,
            long expectedSizeBytes,
            String expectedSha256,
            String classification,
            Instant createdAt,
            Instant expiresAt,
            long bytesReceived,
            int nextChunkIndex,
            UploadStatus status,
            Map<String, Object> metadata) {
        public UploadSession {
            uploadId = required(uploadId, "uploadId");
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            fileName = required(fileName, "fileName");
            contentType = required(contentType, "contentType");
            expectedSha256 = requireSha256(expectedSha256);
            classification = required(classification, "classification");
            createdAt = createdAt == null ? Instant.now() : createdAt;
            expiresAt = java.util.Objects.requireNonNull(expiresAt, "expiresAt");
            if (bytesReceived < 0 || nextChunkIndex < 0) throw new IllegalArgumentException("upload progress must not be negative");
            status = java.util.Objects.requireNonNull(status, "status");
            metadata = Map.copyOf(metadata == null ? Map.of() : metadata);
        }

        public String purpose() { return metadataPurpose(metadata); }
    }

    public record MediaArtifact(
            String tenantId,
            String principalId,
            String artifactId,
            String fileName,
            String contentType,
            long sizeBytes,
            String sha256,
            String objectReference,
            String classification,
            Instant createdAt,
            Instant expiresAt,
            Map<String, Object> metadata) {
        public MediaArtifact {
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            artifactId = required(artifactId, "artifactId");
            fileName = required(fileName, "fileName");
            contentType = required(contentType, "contentType");
            if (sizeBytes < 1) throw new IllegalArgumentException("sizeBytes must be positive");
            sha256 = requireSha256(sha256);
            objectReference = required(objectReference, "objectReference");
            classification = required(classification, "classification");
            createdAt = createdAt == null ? Instant.now() : createdAt;
            expiresAt = java.util.Objects.requireNonNull(expiresAt, "expiresAt");
            metadata = Map.copyOf(metadata == null ? Map.of() : metadata);
        }

        public String purpose() { return metadataPurpose(metadata); }
    }

    public record ProcessingJobRequest(
            String requestId,
            String tenantId,
            String principalId,
            String correlationId,
            String artifactId,
            JobType jobType,
            String providerHint,
            Map<String, Object> parameters,
            MediaGovernanceContext governanceContext) {
        public ProcessingJobRequest {
            requestId = required(requestId, "requestId");
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            correlationId = required(correlationId, "correlationId");
            artifactId = required(artifactId, "artifactId");
            jobType = java.util.Objects.requireNonNull(jobType, "jobType");
            providerHint = optional(providerHint);
            parameters = immutableJsonObject(parameters == null ? Map.of() : parameters);
            governanceContext = governanceContext == null
                    ? MediaGovernanceContext.compatibilityDefault() : governanceContext;
        }

        /** Return a defensive snapshot; JSON arrays are copied because Java arrays remain mutable. */
        @Override
        public Map<String, Object> parameters() {
            return immutableJsonObject(parameters);
        }

        public ProcessingJobRequest(
                String requestId, String tenantId, String principalId, String correlationId,
                String artifactId, JobType jobType, String providerHint, Map<String, Object> parameters) {
            this(requestId, tenantId, principalId, correlationId, artifactId, jobType,
                    providerHint, parameters, MediaGovernanceContext.compatibilityDefault());
        }
    }

    public record ProcessingJob(
            String jobId,
            String requestId,
            String tenantId,
            String principalId,
            String artifactId,
            JobType jobType,
            String providerId,
            JobStatus status,
            Instant createdAt,
            Instant startedAt,
            Instant completedAt,
            Map<String, Object> result,
            String failureCode,
            long version,
            String requestFingerprint) {
        public ProcessingJob {
            jobId = required(jobId, "jobId");
            requestId = required(requestId, "requestId");
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            artifactId = required(artifactId, "artifactId");
            jobType = java.util.Objects.requireNonNull(jobType, "jobType");
            providerId = optional(providerId);
            status = java.util.Objects.requireNonNull(status, "status");
            createdAt = createdAt == null ? Instant.now() : createdAt;
            result = Map.copyOf(result == null ? Map.of() : result);
            failureCode = optional(failureCode);
            requestFingerprint = optional(requestFingerprint);
            if (version < 1) throw new IllegalArgumentException("version must be positive");
        }

        /** Compatibility constructor for pre-fingerprint records and non-submission fixtures. */
        public ProcessingJob(
                String jobId, String requestId, String tenantId, String principalId, String artifactId,
                JobType jobType, String providerId, JobStatus status, Instant createdAt, Instant startedAt,
                Instant completedAt, Map<String, Object> result, String failureCode, long version) {
            this(jobId, requestId, tenantId, principalId, artifactId, jobType, providerId, status,
                    createdAt, startedAt, completedAt, result, failureCode, version, "");
        }
    }

    /** Durable worker ownership; every re-claim advances the fencing token. */
    public record JobLease(
            String tenantId,
            String jobId,
            String ownerId,
            long fencingToken,
            Instant expiresAt) {
        public JobLease {
            tenantId = required(tenantId, "tenantId");
            jobId = required(jobId, "jobId");
            ownerId = required(ownerId, "ownerId");
            if (fencingToken < 1L) throw new IllegalArgumentException("fencingToken must be positive");
            expiresAt = java.util.Objects.requireNonNull(expiresAt, "expiresAt");
        }
    }

    public record StreamSessionRequest(
            String tenantId,
            String principalId,
            String correlationId,
            StreamKind streamKind,
            String providerHint,
            long maximumBufferedBytes,
            Duration leaseDuration,
            Map<String, Object> metadata,
            MediaGovernanceContext governanceContext) {
        public StreamSessionRequest {
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            correlationId = required(correlationId, "correlationId");
            streamKind = java.util.Objects.requireNonNull(streamKind, "streamKind");
            providerHint = optional(providerHint);
            if (maximumBufferedBytes < 1 || maximumBufferedBytes > 1_073_741_824L) {
                throw new IllegalArgumentException("maximumBufferedBytes must be between 1 and 1073741824");
            }
            if (leaseDuration == null || leaseDuration.isZero() || leaseDuration.isNegative()
                    || leaseDuration.compareTo(Duration.ofHours(1)) > 0) {
                throw new IllegalArgumentException("leaseDuration must be between 1 ms and 1 hour");
            }
            metadata = Map.copyOf(metadata == null ? Map.of() : metadata);
            governanceContext = governanceContext == null
                    ? MediaGovernanceContext.compatibilityDefault() : governanceContext;
        }

        public StreamSessionRequest(
                String tenantId, String principalId, String correlationId, StreamKind streamKind,
                String providerHint, long maximumBufferedBytes, Duration leaseDuration,
                Map<String, Object> metadata) {
            this(tenantId, principalId, correlationId, streamKind, providerHint,
                    maximumBufferedBytes, leaseDuration, metadata,
                    MediaGovernanceContext.compatibilityDefault());
        }
    }

    public record StreamSession(
            String tenantId,
            String sessionId,
            String principalId,
            StreamKind streamKind,
            String providerId,
            StreamState state,
            long lastSequence,
            long bufferedBytes,
            long maximumBufferedBytes,
            int reconnectCount,
            Instant leaseExpiresAt,
            Instant createdAt,
            Instant updatedAt,
            Instant closedAt,
            Map<String, Object> metadata,
            long version) {
        public StreamSession {
            tenantId = required(tenantId, "tenantId");
            sessionId = required(sessionId, "sessionId");
            principalId = required(principalId, "principalId");
            streamKind = java.util.Objects.requireNonNull(streamKind, "streamKind");
            providerId = required(providerId, "providerId");
            state = java.util.Objects.requireNonNull(state, "state");
            if (lastSequence < -1 || bufferedBytes < 0 || maximumBufferedBytes < 1 || reconnectCount < 0) {
                throw new IllegalArgumentException("stream counters are invalid");
            }
            createdAt = createdAt == null ? Instant.now() : createdAt;
            updatedAt = updatedAt == null ? createdAt : updatedAt;
            metadata = Map.copyOf(metadata == null ? Map.of() : metadata);
            if (version < 1) throw new IllegalArgumentException("version must be positive");
        }
    }

    public record StreamSessionRegistration(StreamSession session, String connectionToken) {
        public StreamSessionRegistration {
            session = java.util.Objects.requireNonNull(session, "session");
            connectionToken = required(connectionToken, "connectionToken");
        }
    }

    public record StreamFrame(
            String tenantId,
            String sessionId,
            String connectionToken,
            long sequence,
            byte[] payload,
            boolean endOfStream,
            Instant receivedAt) {
        public StreamFrame {
            tenantId = required(tenantId, "tenantId");
            sessionId = required(sessionId, "sessionId");
            connectionToken = required(connectionToken, "connectionToken");
            if (sequence < 0) throw new IllegalArgumentException("sequence must not be negative");
            payload = payload == null ? new byte[0] : payload.clone();
            if (payload.length == 0 && !endOfStream) throw new IllegalArgumentException("non-terminal stream frame requires payload");
            receivedAt = receivedAt == null ? Instant.now() : receivedAt;
        }
        @Override public byte[] payload() { return payload.clone(); }
    }

    public record StreamAck(long acceptedSequence, long bufferedBytes, boolean backpressured) {
        public StreamAck {
            if (acceptedSequence < 0 || bufferedBytes < 0) throw new IllegalArgumentException("stream acknowledgement counters are invalid");
        }
    }

    public interface MediaArtifactStore extends AutoCloseable {
        String storeId();
        UploadSession begin(UploadRequest request);
        UploadSession append(String tenantId, String principalId, String uploadId, int chunkIndex, byte[] bytes);
        MediaArtifact complete(String tenantId, String principalId, String uploadId);
        /** @deprecated Principal-less mutation cannot prove upload ownership and always fails closed. */
        @Deprecated default UploadSession append(String tenantId, String uploadId, int chunkIndex, byte[] bytes) {
            throw new SecurityException("Authenticated principal is required to append an upload");
        }
        /** @deprecated Principal-less mutation cannot prove upload ownership and always fails closed. */
        @Deprecated default MediaArtifact complete(String tenantId, String uploadId) {
            throw new SecurityException("Authenticated principal is required to finalize an upload");
        }
        Optional<UploadSession> upload(String tenantId, String uploadId);
        Optional<MediaArtifact> artifact(String tenantId, String artifactId);
        boolean durable();
        boolean productionEligible();
        boolean ready();
        @Override default void close() { }
    }

    public interface MediaJobStore extends AutoCloseable {
        String storeId();
        ProcessingJob create(ProcessingJob job);
        ProcessingJob update(ProcessingJob expected, ProcessingJob updated);
        /** Update a worker-owned job only while the supplied lease fence is current and unexpired. */
        ProcessingJob update(JobLease lease, ProcessingJob expected, ProcessingJob updated);
        Optional<ProcessingJob> find(String tenantId, String jobId);
        List<ProcessingJob> list(String tenantId, int limit);
        JobLease claim(ProcessingJob expected, String ownerId, Instant expiresAt);
        boolean leaseValid(JobLease lease);
        void release(JobLease lease);
        List<ProcessingJob> recoverable(int limit);
        boolean durable();
        boolean productionEligible();
        boolean ready();
        @Override default void close() { }
    }

    public interface MediaStreamSessionStore extends AutoCloseable {
        String storeId();
        StreamSession create(StreamSession session, String connectionTokenHash);
        Optional<StreamSession> find(String tenantId, String sessionId);
        StreamSession connect(StreamSession expected, String connectionTokenHash, Instant leaseExpiresAt);
        StreamSession recordFrame(StreamSession expected, long sequence, long payloadBytes, boolean endOfStream);
        StreamSession transition(StreamSession expected, StreamState target);
        boolean tokenMatches(String tenantId, String sessionId, String connectionTokenHash);
        boolean durable();
        boolean productionEligible();
        boolean ready();
        @Override default void close() { }
    }

    public interface MediaProcessingProvider extends AutoCloseable {
        String providerId();
        default String providerVersion() { return "unspecified"; }
        default String modelVersion(JobType modality) { return providerVersion(); }
        Set<JobType> capabilities();
        default List<MediaModalityContracts.CapabilityProfile> capabilityProfiles() {
            return capabilities().stream().sorted().map(modality -> switch (modality) {
                case SPEECH_TO_TEXT, TEXT_TO_SPEECH -> new MediaModalityContracts.CapabilityProfile(
                        providerId(), providerVersion(), modality,
                        Set.of("pcm_s16le"), Set.of("wav"), Set.of(16_000, 48_000),
                        0, 0, Set.of(modelVersion(modality)),
                        Set.of(processingRegion()),
                        processingBoundary(), modality == JobType.SPEECH_TO_TEXT,
                        modality == JobType.SPEECH_TO_TEXT, false,
                        health(), degradationPolicy(modality), executionBounds());
                case VISION, MULTIMODAL -> new MediaModalityContracts.CapabilityProfile(
                        providerId(), providerVersion(), modality,
                        Set.of("raw"), Set.of("jpeg", "png", "mp4"), Set.of(),
                        8_192, 8_192, Set.of(modelVersion(modality)),
                        Set.of(processingRegion()),
                        processingBoundary(), false, true, modality == JobType.VISION,
                        health(), degradationPolicy(modality), executionBounds());
                case TRANSCODE -> new MediaModalityContracts.CapabilityProfile(
                        providerId(), providerVersion(), modality,
                        Set.of("h264", "h265", "aac", "opus"), Set.of("mp4", "webm", "wav"),
                        Set.of(16_000, 44_100, 48_000), 8_192, 8_192,
                        Set.of(modelVersion(modality)),
                        Set.of(processingRegion()),
                        processingBoundary(),
                        false, false, false,
                        health(), degradationPolicy(modality), executionBounds());
            }).toList();
        }
        default MediaModalityContracts.ProviderHealth health() {
            return new MediaModalityContracts.ProviderHealth(
                    providerId(), providerVersion(),
                    ready() ? MediaModalityContracts.ProviderHealthStatus.HEALTHY
                            : MediaModalityContracts.ProviderHealthStatus.UNAVAILABLE,
                    processingBoundary() == ProcessingBoundary.LOCAL
                            ? MediaModalityContracts.DegradationPolicy.LOCAL_DIAGNOSTIC_ONLY
                            : MediaModalityContracts.DegradationPolicy.FAIL_CLOSED,
                    ready() ? "" : "provider is not ready", java.time.Instant.now());
        }
        default MediaModalityContracts.DegradationPolicy degradationPolicy(JobType modality) {
            return processingBoundary() == ProcessingBoundary.LOCAL
                    ? MediaModalityContracts.DegradationPolicy.LOCAL_DIAGNOSTIC_ONLY
                    : MediaModalityContracts.DegradationPolicy.FAIL_CLOSED;
        }
        default MediaModalityContracts.ExecutionBounds executionBounds() {
            return MediaModalityContracts.ExecutionBounds.defaults();
        }
        boolean ready();
        boolean productionEligible();
        int priority();
        CompletableFuture<Map<String, Object>> process(ProcessingContext context);
        default CancellationOutcome cancel(
                String tenantId, String principalId, String correlationId, String jobId) {
            return CancellationOutcome.UNSUPPORTED;
        }
        /**
         * Whether this provider has explicit proof that the supplied failure is safe to repeat on
         * another provider. Timeout and network errors occur after dispatch and are ambiguous by
         * default, so providers must opt in only when their protocol supplies a stronger no-effect,
         * idempotency, or reconciliation guarantee.
         */
        default boolean fallbackEligible(Throwable failure) { return false; }
        default ProcessingBoundary processingBoundary() { return ProcessingBoundary.EXTERNAL; }
        default String processingRegion() { return "unspecified"; }
        default ProviderDataRetention providerDataRetention() { return ProviderDataRetention.UNKNOWN; }
        default void verifyReady() {
            if (!ready()) throw new IllegalStateException("Media provider is not ready: " + providerId());
            if (processingBoundary() == null) throw new IllegalStateException("Media provider processing boundary is missing");
            if (providerVersion() == null || providerVersion().isBlank()) {
                throw new IllegalStateException("Media provider version is missing: " + providerId());
            }
            if (productionEligible() && "unspecified".equalsIgnoreCase(providerVersion())) {
                throw new IllegalStateException(
                        "Production Media provider version must be explicit: " + providerId());
            }
            Set<JobType> profiled = capabilityProfiles().stream()
                    .map(MediaModalityContracts.CapabilityProfile::modality)
                    .collect(java.util.stream.Collectors.toUnmodifiableSet());
            if (!profiled.equals(Set.copyOf(capabilities()))) {
                throw new IllegalStateException(
                        "Media provider capability profiles do not exactly match declared modalities: " + providerId());
            }
        }
        @Override default void close() { }
    }

    public interface MediaStreamingProvider extends AutoCloseable {
        String providerId();
        Set<StreamKind> capabilities();
        boolean ready();
        boolean productionEligible();
        int priority();
        CompletableFuture<StreamAck> accept(StreamContext context, StreamFrame frame);
        default ProcessingBoundary processingBoundary() { return ProcessingBoundary.EXTERNAL; }
        default String processingRegion() { return "unspecified"; }
        default ProviderDataRetention providerDataRetention() { return ProviderDataRetention.UNKNOWN; }
        /**
         * Verifies the provider identity and declared stream capabilities before composition.
         * Readiness alone is not sufficient: a provider with no usable stream kind must not make
         * the runtime appear ready.
         */
        default void verifyReady() {
            if (!ready()) throw new IllegalStateException("Media streaming provider is not ready: " + providerId());
            if (providerId() == null || providerId().isBlank()) {
                throw new IllegalStateException("Media streaming provider ID is missing");
            }
            if (processingBoundary() == null) {
                throw new IllegalStateException("Media streaming provider processing boundary is missing");
            }
            Set<StreamKind> declared = capabilities();
            if (declared == null || declared.isEmpty()) {
                throw new IllegalStateException("Media streaming provider declares no stream capabilities: " + providerId());
            }
        }
        default MediaModalityContracts.ProviderHealth health() {
            return new MediaModalityContracts.ProviderHealth(
                    providerId(), "stream-provider-v1",
                    ready() ? MediaModalityContracts.ProviderHealthStatus.HEALTHY
                            : MediaModalityContracts.ProviderHealthStatus.UNAVAILABLE,
                    processingBoundary() == ProcessingBoundary.LOCAL
                            ? MediaModalityContracts.DegradationPolicy.LOCAL_DIAGNOSTIC_ONLY
                            : MediaModalityContracts.DegradationPolicy.FAIL_CLOSED,
                    ready() ? "" : "provider is not ready", java.time.Instant.now());
        }
        default void closeSession(StreamContext context) { }
        @Override default void close() { }
    }

    public record ProcessingContext(
            ProcessingJobRequest request,
            MediaArtifact artifact,
            Cancellation cancellation,
            ConsentDecision consentDecision) {
        public ProcessingContext {
            java.util.Objects.requireNonNull(request, "request");
            java.util.Objects.requireNonNull(artifact, "artifact");
            java.util.Objects.requireNonNull(cancellation, "cancellation");
            consentDecision = consentDecision == null ? ConsentDecision.unverified() : consentDecision;
        }
        public ProcessingContext(ProcessingJobRequest request, MediaArtifact artifact, Cancellation cancellation) {
            this(request, artifact, cancellation, ConsentDecision.unverified());
        }
    }

    public record StreamContext(
            StreamSession session,
            Cancellation cancellation,
            ConsentDecision consentDecision,
            MediaGovernanceContext governanceContext) {
        public StreamContext {
            java.util.Objects.requireNonNull(session, "session");
            java.util.Objects.requireNonNull(cancellation, "cancellation");
            consentDecision = consentDecision == null ? ConsentDecision.unverified() : consentDecision;
            governanceContext = governanceContext == null
                    ? MediaGovernanceContext.compatibilityDefault() : governanceContext;
        }
        public StreamContext(StreamSession session, Cancellation cancellation) {
            this(session, cancellation, ConsentDecision.unverified(), MediaGovernanceContext.compatibilityDefault());
        }
    }

    public static final class Cancellation {
        private final AtomicBoolean cancelled = new AtomicBoolean(false);
        public boolean cancelled() { return cancelled.get(); }
        public void cancel() { cancelled.set(true); }
        public void throwIfCancelled() {
            if (cancelled()) throw new java.util.concurrent.CancellationException("Media operation cancelled");
        }
    }

    private static String requireSha256(String value) {
        String normalized = required(value, "sha256").toLowerCase(Locale.ROOT);
        if (!normalized.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("sha256 must contain 64 hexadecimal characters");
        return normalized;
    }

    private static Map<String, Object> immutableJsonObject(Map<String, Object> value) {
        @SuppressWarnings("unchecked")
        Map<String, Object> copy = (Map<String, Object>) immutableJsonValue(value, new IdentityHashMap<>(), 0);
        return copy;
    }

    private static Object immutableJsonValue(
            Object value, IdentityHashMap<Object, Boolean> active, int depth) {
        if (depth > 64) throw new IllegalArgumentException("Media request parameters exceed maximum JSON nesting");
        if (value == null || value instanceof String || value instanceof Boolean) return value;
        if (value instanceof MediaModalityContracts.ContextReference) return value;
        if (value instanceof Number number) {
            if (!(number instanceof Byte || number instanceof Short || number instanceof Integer
                    || number instanceof Long || number instanceof java.math.BigInteger
                    || number instanceof java.math.BigDecimal || number instanceof Double
                    || number instanceof Float)) {
                throw new IllegalArgumentException("Media request number type is not a supported JSON number");
            }
            if ((number instanceof Double d && !Double.isFinite(d))
                    || (number instanceof Float f && !Float.isFinite(f))) {
                throw new IllegalArgumentException("Media request parameters cannot contain non-finite numbers");
            }
            return number;
        }
        if (active.put(value, Boolean.TRUE) != null) {
            throw new IllegalArgumentException("Media request parameters cannot contain cyclic values");
        }
        try {
            if (value instanceof Map<?, ?> map) {
                Map<String, Object> copy = new LinkedHashMap<>();
                for (Map.Entry<?, ?> entry : map.entrySet()) {
                    if (!(entry.getKey() instanceof String key)) {
                        throw new IllegalArgumentException("Media request parameter object keys must be strings");
                    }
                    copy.put(key, immutableJsonValue(entry.getValue(), active, depth + 1));
                }
                return Collections.unmodifiableMap(copy);
            }
            if (value instanceof List<?> list) {
                List<Object> copy = new ArrayList<>(list.size());
                for (Object item : list) copy.add(immutableJsonValue(item, active, depth + 1));
                return Collections.unmodifiableList(copy);
            }
            if (value.getClass().isArray()) {
                int length = Array.getLength(value);
                Object copy = Array.newInstance(value.getClass().getComponentType(), length);
                for (int i = 0; i < length; i++) {
                    Array.set(copy, i, immutableJsonValue(Array.get(value, i), active, depth + 1));
                }
                return copy;
            }
            throw new IllegalArgumentException(
                    "Unsupported Media request parameter value type: " + value.getClass().getName());
        } finally {
            active.remove(value);
        }
    }

    private static String required(String value, String field) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(field + " is required");
        return value.trim();
    }

    private static String normalizedRequired(String value, String field) {
        return required(value, field).toLowerCase(Locale.ROOT);
    }

    private static Set<String> normalizedSet(Set<String> values) {
        return Set.copyOf(values == null ? Set.of() : values.stream()
                .filter(java.util.Objects::nonNull)
                .map(value -> value.trim().toLowerCase(Locale.ROOT))
                .filter(value -> !value.isBlank())
                .toList());
    }

    private static String optional(String value) {
        return value == null ? "" : value.trim();
    }

    private static String metadataPurpose(Map<String, Object> metadata) {
        Object value = metadata == null ? null : metadata.get("purpose");
        if (value instanceof String text && !text.isBlank()) return text.trim().toLowerCase(Locale.ROOT);
        return "unspecified";
    }
}
