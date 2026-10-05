package com.ghatana.stt.service;

import com.ghatana.audio.video.infrastructure.persistence.entity.AudioFileEntity;
import com.ghatana.audio.video.infrastructure.persistence.entity.TranscriptionEntity;
import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.audio.video.infrastructure.persistence.service.TranscriptionService;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.stt.api.SttEngine;
import com.ghatana.media.stt.api.TranscriptionOptions;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.audit.AuditEvent;
import com.ghatana.audit.AuditService;
import io.activej.promise.Promise;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.jetbrains.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executor;
import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * @doc.type class
 * @doc.purpose STT service with persistence integration.
 *              Wraps the platform SttEngine and persists audio files and transcriptions.
 * @doc.layer product
 * @doc.pattern Service
 */
public class PersistentSttService {

    private static final Logger LOG = LoggerFactory.getLogger(PersistentSttService.class);
    private static final long MAX_AUDIO_SIZE_BYTES = 100 * 1024 * 1024;
    private static final int MIN_SAMPLE_RATE = 8_000;
    private static final int MAX_SAMPLE_RATE = 48_000;
    private static final Set<String> SUPPORTED_FORMATS = Set.of("wav", "mp3", "flac", "ogg", "m4a");
    private static final Set<String> SUPPORTED_LANGUAGES = Set.of(
            "en", "ne", "hi", "es", "fr", "de", "ja", "zh");
    private static final long BATCH_TRANSCRIPTION_TIMEOUT_MS = 30_000;

    private volatile boolean degraded = false;
    private volatile String degradationReason = null;

    private final AudioVideoLibrary library;
    private final AudioFileService audioFileService;
    private final TranscriptionService transcriptionService;
    private final Timer transcribeTimer;
    private final Executor blockingExecutor;
    private final AuditService auditService;

    public PersistentSttService(
            AudioVideoLibrary library,
            AudioFileService audioFileService,
            TranscriptionService transcriptionService,
            MeterRegistry meterRegistry) {
        this(library, audioFileService, transcriptionService, meterRegistry, null);
    }

    public PersistentSttService(
            AudioVideoLibrary library,
            AudioFileService audioFileService,
            TranscriptionService transcriptionService,
            MeterRegistry meterRegistry,
            @Nullable AuditService auditService) {
        this.library = Objects.requireNonNull(library, "library cannot be null");
        this.audioFileService = Objects.requireNonNull(audioFileService, "audioFileService cannot be null");
        this.transcriptionService = Objects.requireNonNull(
                transcriptionService, "transcriptionService cannot be null");
        this.auditService = auditService;
        this.transcribeTimer = Timer.builder("stt.persistent.transcribe")
                .description("Persistent transcription latency")
                .register(meterRegistry);
        this.blockingExecutor = ForkJoinPool.commonPool();
    }

    /** Transcribe audio and persist the governed audio/transcription records. */
    public Promise<TranscriptionResult> transcribeAndPersist(
            String tenantId,
            UUID userId,
            byte[] audioBytes,
            String fileName,
            AudioFormat format,
            String language,
            int sampleRate) {
        Objects.requireNonNull(tenantId, "tenantId cannot be null");
        Objects.requireNonNull(userId, "userId cannot be null");
        Objects.requireNonNull(audioBytes, "audioBytes cannot be null");

        try {
            validateSttInput(audioBytes, fileName, format, sampleRate, language);
        } catch (IllegalArgumentException failure) {
            emitSttAudit(
                    tenantId,
                    userId.toString(),
                    "stt.transcribe",
                    "VALIDATION_FAILURE",
                    Map.of(
                            "failureType", failureType(failure),
                            "audioSizeBytes", String.valueOf(audioBytes.length)));
            throw failure;
        }

        String inputHash = sha256Hex(audioBytes);
        String requestId = UUID.randomUUID().toString();
        long startTime = System.currentTimeMillis();

        return persistAudioFile(
                tenantId, userId, fileName, audioBytes.length, format, sampleRate)
                .then(audioFile -> {
                    LOG.info(
                            "[tenant={}] Audio file persisted: id={}, sizeBytes={}",
                            tenantId, audioFile.getId(), audioBytes.length);
                    return performTranscription(audioBytes, sampleRate, language)
                            .then(transcriptionResult -> persistTranscription(
                                    tenantId,
                                    userId,
                                    audioFile.getId(),
                                    transcriptionResult,
                                    requestId,
                                    inputHash)
                                    .map(transcription -> {
                                        long elapsedMs = System.currentTimeMillis() - startTime;
                                        transcribeTimer.record(Duration.ofMillis(elapsedMs));
                                        LOG.info(
                                                "[tenant={} requestId={}] Transcription completed: audioId={}, transcriptionId={}, confidence={}, elapsedMs={}",
                                                tenantId,
                                                requestId,
                                                audioFile.getId(),
                                                transcription.getId(),
                                                transcriptionResult.confidence(),
                                                elapsedMs);
                                        emitSttAudit(
                                                tenantId,
                                                userId.toString(),
                                                "stt.transcribe",
                                                "SUCCESS",
                                                Map.of(
                                                        "requestId", requestId,
                                                        "audioFileId", audioFile.getId().toString(),
                                                        "transcriptionId", transcription.getId().toString(),
                                                        "confidence", String.valueOf(transcriptionResult.confidence()),
                                                        "language", transcriptionResult.language() != null
                                                                ? transcriptionResult.language()
                                                                : "unknown",
                                                        "processingTimeMs", String.valueOf(elapsedMs),
                                                        "audioSizeBytes", String.valueOf(audioBytes.length),
                                                        "inputHash", inputHash));
                                        return transcriptionResult;
                                    }))
                            .whenException(failure -> {
                                String failureType = failureType(failure);
                                LOG.error(
                                        "[tenant={} requestId={}] Transcription failed audioId={} failureType={}",
                                        tenantId, requestId, audioFile.getId(), failureType);
                                updateAudioFileStatus(
                                        tenantId,
                                        audioFile.getId(),
                                        AudioFileEntity.ProcessingStatus.FAILED,
                                        "STT_" + failureType);
                                emitSttAudit(
                                        tenantId,
                                        userId.toString(),
                                        "stt.transcribe",
                                        resolveFailureOutcome(failure),
                                        Map.of(
                                                "requestId", requestId,
                                                "audioFileId", audioFile.getId().toString(),
                                                "failureType", failureType,
                                                "audioSizeBytes", String.valueOf(audioBytes.length)));
                            });
                })
                .whenException(failure -> {
                    String failureType = failureType(failure);
                    LOG.error(
                            "[tenant={} requestId={}] STT request failed failureType={}",
                            tenantId, requestId, failureType);
                    emitSttAudit(
                            tenantId,
                            userId.toString(),
                            "stt.transcribe",
                            resolveFailureOutcome(failure),
                            Map.of(
                                    "requestId", requestId,
                                    "failureType", failureType,
                                    "audioSizeBytes", String.valueOf(audioBytes.length)));
                });
    }

    public Promise<Optional<TranscriptionEntity>> getTranscription(
            String tenantId, UUID audioFileId) {
        return transcriptionService.findByAudioFileId(tenantId, audioFileId);
    }

    public Promise<java.util.List<TranscriptionEntity>> getTranscriptions(String tenantId) {
        return transcriptionService.findByTenantId(tenantId);
    }

    public Promise<Boolean> deleteTranscription(String tenantId, UUID transcriptionId) {
        return transcriptionService.softDelete(tenantId, transcriptionId);
    }

    /**
     * Artifact-backed transcription requires an adapter that loads and authorizes Media bytes.
     */
    public Promise<String> transcribe(
            String artifactId,
            String tenantId,
            String languageCode,
            Map<String, String> parameters) {
        return Promise.ofException(new IllegalStateException(
                "Artifact-backed STT requires a MediaArtifactRepository-backed adapter; "
                        + "PersistentSttService cannot transcribe artifact IDs without loading artifact bytes"));
    }

    public void setDegradedMode(boolean degraded, String reason) {
        this.degraded = degraded;
        this.degradationReason = reason;
        if (degraded) LOG.warn("STT service entering degraded mode");
        else LOG.info("STT service exiting degraded mode");
    }

    public boolean isDegraded() { return degraded; }
    public String getDegradationReason() { return degradationReason; }

    private Promise<AudioFileEntity> persistAudioFile(
            String tenantId,
            UUID userId,
            String fileName,
            int fileSize,
            AudioFormat format,
            int sampleRate) {
        String extension = getExtension(fileName);
        AudioFileEntity entity = new AudioFileEntity(
                UUID.randomUUID(),
                tenantId,
                userId,
                fileName,
                "/storage/audio/" + tenantId + "/" + UUID.randomUUID() + "." + extension,
                extension);
        entity.setFileSizeBytes((long) fileSize);
        entity.setSampleRate(sampleRate);
        entity.setStatus(AudioFileEntity.ProcessingStatus.PROCESSING);
        entity.setCreatedAt(Instant.now());
        entity.setUpdatedAt(Instant.now());
        return audioFileService.save(tenantId, entity);
    }

    private Promise<TranscriptionResult> performTranscription(
            byte[] audioBytes,
            int sampleRate,
            String language) {
        if (degraded) {
            LOG.warn("STT service is in degraded mode");
            return Promise.ofException(new IllegalStateException("STT service is degraded"));
        }

        return Promise.ofCallback(callback -> blockingExecutor.execute(() -> {
            java.util.concurrent.ExecutorService singleUse =
                    java.util.concurrent.Executors.newSingleThreadExecutor(runnable -> {
                        Thread thread = new Thread(runnable, "stt-transcribe-timeout");
                        thread.setDaemon(true);
                        return thread;
                    });
            Future<TranscriptionResult> future = singleUse.submit(() -> {
                AudioData audio = new AudioData(
                        audioBytes, sampleRate, 1, 16, Duration.ZERO, AudioFormat.PCM);
                try (SttEngine stt = library.getSttEngine()) {
                    TranscriptionOptions options = TranscriptionOptions.builder()
                            .language(language != null && !language.isBlank()
                                    ? Locale.forLanguageTag(language)
                                    : Locale.getDefault())
                            .build();
                    return stt.transcribe(audio, options);
                }
            });
            try {
                callback.set(future.get(BATCH_TRANSCRIPTION_TIMEOUT_MS, TimeUnit.MILLISECONDS));
            } catch (TimeoutException failure) {
                future.cancel(true);
                singleUse.shutdownNow();
                callback.setException(new TimeoutException(
                        "STT transcription timed out after "
                                + BATCH_TRANSCRIPTION_TIMEOUT_MS + " ms"));
            } catch (java.util.concurrent.ExecutionException failure) {
                callback.setException(asPromiseException(failure.getCause()));
            } catch (InterruptedException failure) {
                Thread.currentThread().interrupt();
                future.cancel(true);
                callback.setException(failure);
            } finally {
                singleUse.shutdown();
            }
        }));
    }

    private static Exception asPromiseException(Throwable cause) {
        if (cause instanceof Exception exception) return exception;
        return new RuntimeException(cause);
    }

    private Promise<TranscriptionEntity> persistTranscription(
            String tenantId,
            UUID userId,
            UUID audioFileId,
            TranscriptionResult result,
            String requestId,
            String inputHashSha256) {
        TranscriptionEntity entity = new TranscriptionEntity(
                UUID.randomUUID(),
                tenantId,
                audioFileId,
                userId,
                result.text(),
                result.language() != null ? result.language() : "unknown");
        entity.setConfidence((float) result.confidence());
        entity.setStatus(TranscriptionEntity.TranscriptionStatus.COMPLETED);
        entity.setModelUsed(result.modelId());
        entity.setProcessingTimeMs(result.processingTime().toMillis());
        entity.setCreatedAt(Instant.now());
        entity.setUpdatedAt(Instant.now());

        TranscriptionEntity.TranscriptionMetadata metadata =
                new TranscriptionEntity.TranscriptionMetadata();
        metadata.setRequestId(requestId);
        metadata.setInputHashSha256(inputHashSha256);
        if (result.modelId() != null) metadata.setEngineVersion(result.modelId());
        entity.setMetadata(metadata);

        return transcriptionService.save(tenantId, entity)
                .then(transcription -> updateAudioFileStatus(
                        tenantId,
                        audioFileId,
                        AudioFileEntity.ProcessingStatus.COMPLETED,
                        null)
                        .map(ignored -> transcription));
    }

    private Promise<Boolean> updateAudioFileStatus(
            String tenantId,
            UUID audioFileId,
            AudioFileEntity.ProcessingStatus status,
            String reason) {
        return audioFileService.updateStatus(tenantId, audioFileId, status, reason);
    }

    private String getExtension(String fileName) {
        if (fileName == null || !fileName.contains(".")) return "audio";
        return fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
    }

    private void validateSttInput(
            byte[] audioBytes,
            String fileName,
            AudioFormat format,
            int sampleRate,
            String language) {
        if (audioBytes.length == 0) {
            throw new IllegalArgumentException("Audio data cannot be empty");
        }
        if (audioBytes.length > MAX_AUDIO_SIZE_BYTES) {
            throw new IllegalArgumentException(
                    "Audio data exceeds maximum size of "
                            + (MAX_AUDIO_SIZE_BYTES / 1024 / 1024) + "MB");
        }
        String extension = getExtension(fileName).toLowerCase(Locale.ROOT);
        if (!SUPPORTED_FORMATS.contains(extension)) {
            throw new IllegalArgumentException(
                    "Unsupported audio format: " + extension + ". Supported: " + SUPPORTED_FORMATS);
        }
        if (sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
            throw new IllegalArgumentException(
                    "Sample rate must be between " + MIN_SAMPLE_RATE + " and "
                            + MAX_SAMPLE_RATE + " Hz, got: " + sampleRate);
        }
        if (language != null && !language.isBlank()) {
            String langCode = language.toLowerCase(Locale.ROOT).split("-")[0];
            if (!SUPPORTED_LANGUAGES.contains(langCode)) {
                throw new IllegalArgumentException(
                        "Unsupported language: " + language + ". Supported: " + SUPPORTED_LANGUAGES);
            }
        }
    }

    private static String resolveFailureOutcome(Throwable failure) {
        Throwable root = root(failure);
        if (root instanceof TimeoutException) return "TIMEOUT";
        if (root instanceof IllegalStateException
                && "STT service is degraded".equals(root.getMessage())) {
            return "DEGRADED_PROVIDER_FAILURE";
        }
        if (root instanceof com.ghatana.media.common.InferenceError) {
            return "INFERENCE_FAILURE";
        }
        return "FAILED";
    }

    private static String sha256Hex(byte[] data) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(data));
        } catch (NoSuchAlgorithmException failure) {
            throw new IllegalStateException("SHA-256 not available", failure);
        }
    }

    private void emitSttAudit(
            String tenantId,
            String userId,
            String operation,
            String status,
            Map<String, String> details) {
        if (auditService == null) return;
        try {
            AuditEvent event = AuditEvent.builder()
                    .tenantId(tenantId != null ? tenantId : "unknown")
                    .eventType(operation)
                    .principal(userId != null ? userId : "system")
                    .resourceType("stt")
                    .resourceId("stt-operation")
                    .success("SUCCESS".equals(status))
                    .detail("status", status)
                    .detail("operation", operation)
                    .details(Map.copyOf(details))
                    .build();
            auditService.record(event);
        } catch (Exception failure) {
            LOG.warn(
                    "Failed to emit audit event for STT operation {} failureType={}",
                    operation,
                    failureType(failure));
        }
    }

    private static String failureType(Throwable failure) {
        Throwable root = root(failure);
        String value = root.getClass().getSimpleName();
        if (value == null || value.isBlank()) return "UNKNOWN_FAILURE";
        return value.replaceAll("[^A-Za-z0-9]", "_").toUpperCase(Locale.ROOT);
    }

    private static Throwable root(Throwable failure) {
        Throwable current = failure;
        while (current.getCause() != null && current.getCause() != current) {
            current = current.getCause();
        }
        return current;
    }
}
