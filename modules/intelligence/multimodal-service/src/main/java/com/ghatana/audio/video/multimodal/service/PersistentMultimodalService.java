package com.ghatana.audio.video.multimodal.service;

import com.ghatana.audio.video.infrastructure.persistence.entity.AudioFileEntity;
import com.ghatana.audio.video.infrastructure.persistence.entity.TranscriptionEntity;
import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.audio.video.infrastructure.persistence.service.TranscriptionService;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.ImageData;
import com.ghatana.media.common.ImageFormat;
import com.ghatana.media.common.ColorSpace;
import com.ghatana.media.stt.api.SttEngine;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.media.vision.api.VisionEngine;
import com.ghatana.audit.AuditEvent;
import com.ghatana.audit.AuditService;
import io.activej.promise.Promise;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.jetbrains.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CancellationException;

/**
 * @doc.type class
 * @doc.purpose Multimodal service with persistence integration.
 *              Combines audio transcription with visual analysis and persists results.
 * @doc.layer product
 * @doc.pattern Service
 */
public class PersistentMultimodalService {

    private static final Logger LOG = LoggerFactory.getLogger(PersistentMultimodalService.class);

    /** Default sample rate assumed for raw PCM audio data passed to this service. */
    private static final int DEFAULT_SAMPLE_RATE_HZ = 16_000;

    private final AudioFileService audioFileService;
    private final TranscriptionService transcriptionService;
    private final SttEngine sttEngine;
    private final VisionEngine visionEngine;
    private final Timer fuseTimer;
    private final AuditService auditService;
    private final Timer dataCloudFuseTimer;

    /**
     * Convenience constructor — engines not yet wired; audio and visual processing will
     * throw {@link UnsupportedOperationException} until real engines are supplied.
     */
    public PersistentMultimodalService(
            AudioFileService audioFileService,
            TranscriptionService transcriptionService,
            MeterRegistry meterRegistry) {
        this(audioFileService, transcriptionService, null, null, meterRegistry, null);
    }

    public PersistentMultimodalService(
            AudioFileService audioFileService,
            TranscriptionService transcriptionService,
            SttEngine sttEngine,
            VisionEngine visionEngine,
            MeterRegistry meterRegistry) {
        this(audioFileService, transcriptionService, sttEngine, visionEngine, meterRegistry, null);
    }

    public PersistentMultimodalService(
            AudioFileService audioFileService,
            TranscriptionService transcriptionService,
            SttEngine sttEngine,
            VisionEngine visionEngine,
            MeterRegistry meterRegistry,
            @Nullable AuditService auditService) {
        this.audioFileService = Objects.requireNonNull(audioFileService, "audioFileService cannot be null");
        this.transcriptionService = Objects.requireNonNull(transcriptionService, "transcriptionService cannot be null");
        this.sttEngine = sttEngine;   // nullable — checked at call time
        this.visionEngine = visionEngine; // nullable — checked at call time
        this.auditService = auditService;
        this.fuseTimer = Timer.builder("multimodal.persistent.fuse")
            .description("Multimodal fusion latency with persistence")
            .register(meterRegistry);
        this.dataCloudFuseTimer = Timer.builder("multimodal.fuse.duration")
            .description("Data Cloud multimodal fusion latency")
            .register(meterRegistry);
    }

    /**
     * Legacy aggregate entry point retained for source compatibility.
     *
     * <p>The canonical Media contract has no family-level multimodal request/result. Callers
     * must submit one admitted capability operation with its trusted artifact version and
     * authorization context. This legacy method has no such bindings and must not persist
     * source bytes or invoke modality providers.
     *
     * @return failed promise with {@code MULTIMODAL_FAMILY_NOT_ADMITTED}
     */
    public Promise<MultimodalResult> processAndPersist(
            String tenantId,
            UUID userId,
            byte[] audioData,
            byte[] visualData,
            String fileName) {

        Objects.requireNonNull(tenantId, "tenantId cannot be null");
        Objects.requireNonNull(userId, "userId cannot be null");
        return Promise.ofException(new IllegalStateException(
                "MULTIMODAL_FAMILY_NOT_ADMITTED: submit one canonical capability operation"));
    }

    /**
     * Data Cloud processing remains unavailable until trusted consent and immutable artifact
     * version authorities are wired. A caller-supplied consent status is descriptive metadata,
     * not permission to persist or dispatch media.
     *
     * @param tenantId       the tenant ID from Data Cloud
     * @param artifactId     the artifact ID from Data Cloud
     * @param correlationId  the correlation ID for traceability
     * @param requestId      the request ID for tracking
     * @param consentStatus  caller-supplied consent metadata; never an authority decision
     * @param retentionPolicy the retention policy for the results
     * @param audioData      the audio data (optional)
     * @param visualData     the visual data (optional)
     * @return Promise containing multimodal result with references only
     */
    public Promise<DataCloudMultimodalResult> processDataCloudJob(
            String tenantId,
            UUID artifactId,
            String correlationId,
            String requestId,
            String consentStatus,
            String retentionPolicy,
            byte[] audioData,
            byte[] visualData) {

        Objects.requireNonNull(tenantId, "tenantId cannot be null");
        Objects.requireNonNull(artifactId, "artifactId cannot be null");
        Objects.requireNonNull(correlationId, "correlationId cannot be null");
        Objects.requireNonNull(requestId, "requestId cannot be null");

        return Promise.ofException(new IllegalStateException(
                "DATACLOUD_MULTIMODAL_NOT_ADMITTED: trusted consent and immutable artifact/version authorities are unavailable"));
    }

    /**
     * Legacy transcript search cannot be exposed without a principal-scoped source/read authority.
     * The current signature accepts only a caller-supplied tenant ID and query, so neither value
     * proves access to the persisted transcripts.
     */
    public Promise<java.util.List<MultimodalSearchResult>> search(String tenantId, String query) {
        Objects.requireNonNull(tenantId, "tenantId cannot be null");
        Objects.requireNonNull(query, "query cannot be null");
        return Promise.ofException(new IllegalStateException(
                "MULTIMODAL_SEARCH_NOT_ADMITTED: principal-scoped transcript read authority is unavailable"));
    }

    /**
     * Index multimodal content by artifact ID for Data Cloud integration.
     *
     * <p>Artifact-backed indexing must load and authorize artifact bytes through
     * the Data Cloud media repository before invoking {@link #processAndPersist}.
     *
     * @param artifactId the artifact ID
     * @param tenantId the tenant ID
     * @param indexType the index type
     * @param parameters additional parameters
     * @return Promise containing the index ID
     */
    public Promise<String> index(String artifactId, String tenantId, String indexType, Map<String, String> parameters) {
        return Promise.ofException(new IllegalStateException(
            "Artifact-backed multimodal indexing is unavailable"));
    }

    private Promise<AudioFileEntity> persistMediaFile(
            String tenantId,
            UUID userId,
            String fileName,
            int fileSize) {

        String extension = getExtension(fileName);

        AudioFileEntity entity = new AudioFileEntity(
            UUID.randomUUID(),
            tenantId,
            userId,
            fileName,
            "/storage/multimodal/" + tenantId + "/" + UUID.randomUUID() + "." + extension,
            extension
        );
        entity.setFileSizeBytes((long) fileSize);
        entity.setStatus(AudioFileEntity.ProcessingStatus.PROCESSING);
        entity.setCreatedAt(Instant.now());
        entity.setUpdatedAt(Instant.now());

        return audioFileService.save(tenantId, entity);
    }

    private Promise<ModalityExecution<Optional<TranscriptionEntity>>> processAudio(
            String tenantId,
            UUID userId,
            UUID audioFileId,
            byte[] audioData) {

        if (audioData == null || audioData.length == 0) {
            return Promise.of(ModalityExecution.notRequested(Optional.empty()));
        }

        if (sttEngine == null) {
            return Promise.of(ModalityExecution.unavailable(Optional.empty()));
        }

        AudioData audio = new AudioData(audioData, DEFAULT_SAMPLE_RATE_HZ, 1, 16);
        TranscriptionResult result;
        try {
            result = sttEngine.transcribe(audio);
        } catch (Exception e) {
            LOG.warn("STT transcription failed failureType={}", failureType(e));
            if (e instanceof CancellationException) return Promise.ofException(e);
            return Promise.of(ModalityExecution.unavailable(Optional.empty()));
        }
        if (result == null) {
            LOG.warn("STT transcription returned no result");
            return Promise.of(ModalityExecution.unavailable(Optional.empty()));
        }
        if (result.hasConfidence() && (!Double.isFinite(result.confidence())
                || result.confidence() < 0.0 || result.confidence() > 1.0)) {
            return Promise.ofException(new IllegalArgumentException(
                    "STT_RESULT_INVALID: confidence must be finite and in [0, 1]"));
        }

        TranscriptionEntity entity = new TranscriptionEntity(
            UUID.randomUUID(),
            tenantId,
            audioFileId,
            userId,
            result.text(),
            result.language() != null ? result.language() : "en"
        );
        entity.setConfidence(result.hasConfidence() ? (float) result.confidence() : null);
        TranscriptionEntity.TranscriptionMetadata metadata = new TranscriptionEntity.TranscriptionMetadata();
        metadata.setConfidenceStatus(result.confidenceAvailability().name());
        entity.setMetadata(metadata);
        entity.setStatus(TranscriptionEntity.TranscriptionStatus.COMPLETED);
        entity.setCreatedAt(Instant.now());
        entity.setUpdatedAt(Instant.now());

        return transcriptionService.save(tenantId, entity)
            .map(saved -> ModalityExecution.succeeded(Optional.of(saved)));
    }

    private Promise<ModalityExecution<VisualAnalysis>> processVisual(
            String tenantId, UUID mediaFileId, byte[] visualData) {
        if (visualData == null || visualData.length == 0) {
            return Promise.of(ModalityExecution.notRequested(new VisualAnalysis(false, 0, java.util.List.of())));
        }

        if (visionEngine == null) {
            return Promise.of(ModalityExecution.unavailable(new VisualAnalysis(false, 0, java.util.List.of())));
        }

        // Image dimensions must be known for correct inference; if the caller supplies
        // raw encoded bytes (JPEG/PNG) the engine is expected to handle them via the
        // declared ImageFormat.  We use a nominal sentinel (width=0, height=0 signals
        // "unknown") which requires the engine to decode dimensions from the header.
        // Use the overload processVisual(tenantId, mediaFileId, visualData, width, height)
        // when the caller can supply explicit dimensions for higher accuracy.
        ImageData image = ImageData.builder()
            .data(visualData)
            .width(1)   // minimal valid value; engine decodes actual dimensions from header
            .height(1)  // minimal valid value
            .format(ImageFormat.JPEG)
            .colorSpace(ColorSpace.RGB)
            .build();

        Promise<com.ghatana.media.vision.api.DetectionResult> detectionPromise;
        try {
            detectionPromise = Objects.requireNonNull(
                    visionEngine.detectAsync(image, com.ghatana.media.vision.api.DetectionOptions.defaults()),
                    "vision engine returned no promise");
        } catch (RuntimeException failure) {
            LOG.warn("Vision detection failed failureType={}", failureType(failure));
            if (failure instanceof CancellationException) return Promise.ofException(failure);
            return Promise.of(ModalityExecution.unavailable(new VisualAnalysis(false, 0, java.util.List.of())));
        }

        return detectionPromise.toTry().map(detectionTry -> {
                if (detectionTry.isException()) {
                    Exception failure = detectionTry.getException();
                    LOG.warn("Vision detection failed failureType={}", failureType(failure));
                    if (failure instanceof CancellationException) throw (CancellationException) failure;
                    return ModalityExecution.unavailable(new VisualAnalysis(false, 0, java.util.List.of()));
                }
                com.ghatana.media.vision.api.DetectionResult detection = detectionTry.get();
                if (detection == null || detection.objects() == null) {
                    return ModalityExecution.unavailable(new VisualAnalysis(false, 0, java.util.List.of()));
                }
                java.util.List<String> labels = detection.objects().stream()
                    .map(com.ghatana.media.vision.api.DetectedObject::className)
                    .toList();
                LOG.debug("Visual detection completed");
                return ModalityExecution.succeeded(
                        new VisualAnalysis(detection.count() > 0, detection.count(), labels));
            });
    }

    private static Outcome aggregateOutcome(ModalityStatus audio, ModalityStatus visual) {
        int requested = 0;
        int succeeded = 0;
        int failed = 0;
        int unknown = 0;
        for (ModalityStatus status : java.util.List.of(audio, visual)) {
            if (status == ModalityStatus.NOT_REQUESTED) continue;
            requested++;
            if (status == ModalityStatus.SUCCEEDED) succeeded++;
            else if (status == ModalityStatus.OUTCOME_UNKNOWN) unknown++;
            else failed++;
        }
        if (requested == 0) return Outcome.NO_MODALITY;
        if (unknown > 0) return Outcome.OUTCOME_UNKNOWN;
        if (failed == 0) return Outcome.COMPLETE;
        return succeeded == 0 ? Outcome.FAILED : Outcome.PARTIAL;
    }

    private record ModalityExecution<T>(ModalityStatus status, T value) {
        private ModalityExecution {
            Objects.requireNonNull(status, "status");
            Objects.requireNonNull(value, "value");
        }

        static <T> ModalityExecution<T> notRequested(T value) {
            return new ModalityExecution<>(ModalityStatus.NOT_REQUESTED, value);
        }

        static <T> ModalityExecution<T> succeeded(T value) {
            return new ModalityExecution<>(ModalityStatus.SUCCEEDED, value);
        }

        static <T> ModalityExecution<T> unavailable(T value) {
            return new ModalityExecution<>(ModalityStatus.UNAVAILABLE, value);
        }
    }

    private String getExtension(String fileName) {
        if (fileName == null || !fileName.contains(".")) {
            return "mp4";
        }
        return fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase();
    }

    /**
     * Result of multimodal fusion.
     */
    public record MultimodalResult(
        UUID mediaFileId,
        String transcription,
        float transcriptionConfidence,
        VisualAnalysis visualAnalysis,
        long processingTimeMs,
        Outcome outcome,
        ModalityStatus audioStatus,
        ModalityStatus visualStatus
    ) {
        /** Compatibility path for callers that cannot supply modality finality. */
        public MultimodalResult(UUID mediaFileId, String transcription, float transcriptionConfidence,
                                VisualAnalysis visualAnalysis, long processingTimeMs) {
            this(mediaFileId, transcription, transcriptionConfidence, visualAnalysis, processingTimeMs,
                    Outcome.OUTCOME_UNKNOWN, ModalityStatus.OUTCOME_UNKNOWN, ModalityStatus.OUTCOME_UNKNOWN);
        }
    }

    public enum Outcome { COMPLETE, PARTIAL, FAILED, NO_MODALITY, OUTCOME_UNKNOWN }

    public enum ModalityStatus { NOT_REQUESTED, SUCCEEDED, UNAVAILABLE, OUTCOME_UNKNOWN }

    /**
     * Visual analysis result.
     */
    public record VisualAnalysis(
        boolean hasDetections,
        int detectionCount,
        java.util.List<String> detectedObjects
    ) {}

    /**
     * Search result.
     */
    public record MultimodalSearchResult(
        UUID mediaFileId,
        String resultType,
        String content,
        float relevance,
        Instant createdAt
    ) {}

    /**
     * K5: Data Cloud multimodal result.
     *
     * Contains processing result references, not raw sensitive media content.
     */
    public record DataCloudMultimodalResult(
        UUID artifactId,
        UUID mediaFileId,
        String correlationId,
        String requestId,
        String transcriptionText,
        float confidence,
        boolean hasVisualDetections,
        long processingTimeMs,
        String consentStatus,
        String retentionPolicy,
        Outcome outcome,
        ModalityStatus audioStatus,
        ModalityStatus visualStatus
    ) {
        /** Compatibility path for data without recorded child finality. */
        public DataCloudMultimodalResult(UUID artifactId, UUID mediaFileId, String correlationId,
                                         String requestId, String transcriptionText, float confidence,
                                         boolean hasVisualDetections, long processingTimeMs,
                                         String consentStatus, String retentionPolicy) {
            this(artifactId, mediaFileId, correlationId, requestId, transcriptionText, confidence,
                    hasVisualDetections, processingTimeMs, consentStatus, retentionPolicy,
                    Outcome.OUTCOME_UNKNOWN, ModalityStatus.OUTCOME_UNKNOWN,
                    ModalityStatus.OUTCOME_UNKNOWN);
        }
    }

    /**
     * OBS-P1-002: Emit audit event for multimodal operations.
     *
     * @param tenantId the tenant ID
     * @param userId the user ID
     * @param operation the operation type
     * @param status the operation status
     * @param details additional details
     */
    private void emitMultimodalAudit(String tenantId, String userId, String operation,
                                      String status, Map<String, String> details) {
        if (auditService == null) {
            return; // Audit service not configured
        }
        
        try {
            AuditEvent event = AuditEvent.builder()
                .tenantId(tenantId != null ? tenantId : "unknown")
                .eventType(operation)
                .principal(userId != null ? userId : "system")
                .resourceType("multimodal")
                .resourceId("multimodal-operation")
                .success("SUCCESS".equals(status) || "COMPLETE".equals(status))
                .detail("status", status)
                .detail("operation", operation)
                .details(Map.copyOf(details))
                .build();
            
            auditService.record(event);
        } catch (Exception e) {
            LOG.warn("Failed to emit multimodal audit event failureType={}", failureType(e));
        }
    }

    private static String failureType(Throwable failure) {
        return failure == null ? "UNKNOWN" : failure.getClass().getSimpleName();
    }
}
