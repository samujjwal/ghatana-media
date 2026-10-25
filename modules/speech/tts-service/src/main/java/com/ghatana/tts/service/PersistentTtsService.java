package com.ghatana.tts.service;

import com.ghatana.audio.video.infrastructure.persistence.entity.AudioFileEntity;
import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.tts.api.SynthesisOptions;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.tts.engine.PcmAudioValidator;
import com.ghatana.tts.engine.TtsSynthesisEngine;
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
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executor;
import java.util.concurrent.ForkJoinPool;

/**
 * @doc.type class
 * @doc.purpose TTS service with persistence integration.
 *              Wraps the platform TtsEngine and persists generated audio files.
 * @doc.layer product
 * @doc.pattern Service
 */
public class PersistentTtsService {

    private static final Logger LOG = LoggerFactory.getLogger(PersistentTtsService.class);
    private static final int MAX_TEXT_LENGTH = 10_000;
    private static final float MIN_SPEED = 0.5f;
    private static final float MAX_SPEED = 2.0f;
    private static final float MIN_PITCH = 0.5f;
    private static final float MAX_PITCH = 2.0f;
    private static final Set<String> SUPPORTED_LANGUAGES = Set.of(
            "en", "ne", "hi", "es", "fr", "de", "ja", "zh");
    private static final long DEFAULT_SYNTHESIS_TIMEOUT_MS = 60_000;

    private volatile boolean degraded = false;
    private volatile String degradationReason = null;

    private final AudioVideoLibrary library;
    private final AudioFileService audioFileService;
    private final Timer synthesizeTimer;
    private final Executor blockingExecutor;
    private final AuditService auditService;

    public PersistentTtsService(
            AudioVideoLibrary library,
            AudioFileService audioFileService,
            MeterRegistry meterRegistry) {
        this(library, audioFileService, meterRegistry, null);
    }

    public PersistentTtsService(
            AudioVideoLibrary library,
            AudioFileService audioFileService,
            MeterRegistry meterRegistry,
            @Nullable AuditService auditService) {
        this.library = Objects.requireNonNull(library, "library cannot be null");
        this.audioFileService = Objects.requireNonNull(audioFileService, "audioFileService cannot be null");
        this.auditService = auditService;
        this.synthesizeTimer = Timer.builder("tts.persistent.synthesize")
                .description("Persistent synthesis latency")
                .register(meterRegistry);
        this.blockingExecutor = ForkJoinPool.commonPool();
    }

    /** Synthesize text to speech and persist opaque audio metadata without persisting source text. */
    public Promise<SynthesisResult> synthesizeAndPersist(
            String tenantId,
            UUID userId,
            String text,
            Optional<String> voiceId,
            float speed,
            float pitch,
            String language) {
        Objects.requireNonNull(tenantId, "tenantId cannot be null");
        Objects.requireNonNull(userId, "userId cannot be null");
        Objects.requireNonNull(text, "text cannot be null");
        voiceId = voiceId == null ? Optional.empty() : voiceId;
        validateTtsInput(text, voiceId, speed, pitch, language);

        // This compatibility persistence path has no trusted owner/consent authority, admitted
        // synthesis provider, or Media artifact/job/outbox integration. Do not dispatch to the
        // injected legacy engine or register a legacy audio-file record as a completed artifact.
        return Promise.ofException(new TtsSynthesisEngine.SynthesisException(
                "Persistent TTS is NOT_ADMITTED: owner/consent, provider, and Media artifact/job/outbox authorities are not wired",
                TtsSynthesisEngine.FailureReason.NOT_ADMITTED));
    }

    private Promise<AudioFileEntity> persistAudioFile(
            String tenantId,
            UUID userId,
            String fileName,
            int fileSize,
            String format,
            int sampleRate,
            AudioData audioData) {
        AudioFileEntity entity = new AudioFileEntity(
                UUID.randomUUID(),
                tenantId,
                userId,
                fileName,
                "/storage/tts/" + tenantId + "/" + UUID.randomUUID() + "." + format,
                format);
        entity.setFileSizeBytes((long) fileSize);
        entity.setSampleRate(sampleRate);
        long durationSeconds = Math.round(PcmAudioValidator.validate(audioData, 22_050, 1)
                .duration().toNanos() / 1_000_000_000.0d);
        entity.setDurationSeconds(Math.toIntExact(durationSeconds));
        entity.setStatus(AudioFileEntity.ProcessingStatus.COMPLETED);
        entity.setCreatedAt(Instant.now());
        entity.setUpdatedAt(Instant.now());
        return audioFileService.save(tenantId, entity);
    }

    /** Persist a failed synthesis record using only opaque metadata and a bounded failure type. */
    private Promise<Void> persistFailedAudioFile(
            String tenantId,
            UUID userId,
            String fileName,
            int textLength,
            String failureType) {
        AudioFileEntity entity = new AudioFileEntity(
                UUID.randomUUID(),
                tenantId,
                userId,
                fileName,
                "/storage/tts/" + tenantId + "/" + UUID.randomUUID() + ".failed",
                "failed");
        entity.setFileSizeBytes(0L);
        entity.setSampleRate(0);
        entity.setDurationSeconds(0);
        entity.setStatus(AudioFileEntity.ProcessingStatus.FAILED);
        entity.setFailureReason("TTS_" + failureType);
        entity.setCreatedAt(Instant.now());
        entity.setUpdatedAt(Instant.now());

        return audioFileService.save(tenantId, entity)
                .then(saved -> Promise.of((Void) null))
                .whenException(failure -> LOG.error(
                        "Failed to persist failed TTS record failureType={}",
                        failureType(failure)));
    }

    /** Opaque raw-PCM names deliberately contain no source text or voice identifier. */
    private String generateOpaqueFileName() {
        return "tts_" + UUID.randomUUID() + ".pcm";
    }

    private void validateTtsInput(
            String text,
            Optional<String> voiceId,
            float speed,
            float pitch,
            String language) {
        if (text.isBlank()) throw new IllegalArgumentException("Text cannot be empty");
        if (text.length() > MAX_TEXT_LENGTH) {
            throw new IllegalArgumentException(
                    "Text exceeds maximum length of " + MAX_TEXT_LENGTH + " characters");
        }
        if (!Float.isFinite(speed)) throw new IllegalArgumentException("Speed must be finite");
        if (!Float.isFinite(pitch)) throw new IllegalArgumentException("Pitch must be finite");
        if (speed < MIN_SPEED || speed > MAX_SPEED) {
            throw new IllegalArgumentException(
                    "Speed must be between " + MIN_SPEED + " and " + MAX_SPEED + ", got: " + speed);
        }
        if (pitch < MIN_PITCH || pitch > MAX_PITCH) {
            throw new IllegalArgumentException(
                    "Pitch must be between " + MIN_PITCH + " and " + MAX_PITCH + ", got: " + pitch);
        }
        if (speed != 1.0f || pitch != 1.0f) {
            throw new UnsupportedOperationException(
                    "NOT_ADMITTED: no qualified provider effect exists for non-neutral speed or pitch");
        }
        if (voiceId != null && voiceId.isPresent() && voiceId.get().length() > 255) {
            throw new IllegalArgumentException("voiceId must not exceed 255 characters");
        }
        if (language != null && !language.isBlank()) {
            String langCode = language.toLowerCase(java.util.Locale.ROOT).split("-")[0];
            if (!SUPPORTED_LANGUAGES.contains(langCode)) {
                throw new IllegalArgumentException(
                        "Unsupported language: " + language + ". Supported: " + SUPPORTED_LANGUAGES);
            }
        }
    }

    public void setDegradedMode(boolean degraded, String reason) {
        this.degraded = degraded;
        this.degradationReason = reason;
        if (degraded) LOG.warn("TTS service entering degraded mode");
        else LOG.info("TTS service exiting degraded mode");
    }

    public boolean isDegraded() { return degraded; }
    public String getDegradationReason() { return degradationReason; }

    private void emitTtsAudit(
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
                    .resourceType("tts")
                    .resourceId("tts-operation")
                    .success("SUCCESS".equals(status))
                    .detail("status", status)
                    .detail("operation", operation)
                    .details(Map.copyOf(details))
                    .build();
            auditService.record(event);
        } catch (Exception failure) {
            LOG.warn(
                    "Failed to emit audit event for TTS operation {} failureType={}",
                    operation,
                    failureType(failure));
        }
    }

    private static String failureType(Throwable failure) {
        Throwable current = failure;
        while (current.getCause() != null && current.getCause() != current) {
            current = current.getCause();
        }
        String value = current.getClass().getSimpleName();
        if (value == null || value.isBlank()) return "UNKNOWN_FAILURE";
        return value.replaceAll("[^A-Za-z0-9]", "_").toUpperCase(java.util.Locale.ROOT);
    }

    private static boolean isNotAdmitted(Throwable failure) {
        for (Throwable current = failure; current != null; current = current.getCause()) {
            String message = current.getMessage();
            if (message != null && message.contains("NOT_ADMITTED")) return true;
        }
        return false;
    }

    public record SynthesisResult(
            UUID audioFileId,
            byte[] audioData,
            int sampleRate,
            long processingTimeMs,
            long durationMillis,
            int channels,
            int bitsPerSample,
            String format) {
        public SynthesisResult {
            audioData = audioData == null ? null : audioData.clone();
        }

        /** Prevent callers from mutating the bytes associated with this result after creation. */
        @Override
        public byte[] audioData() {
            return audioData == null ? null : audioData.clone();
        }

        public SynthesisResult(UUID audioFileId, byte[] audioData, int sampleRate, long processingTimeMs) {
            this(audioFileId, audioData, sampleRate, processingTimeMs, 0L, 0, 0, "UNKNOWN");
        }
    }
}
