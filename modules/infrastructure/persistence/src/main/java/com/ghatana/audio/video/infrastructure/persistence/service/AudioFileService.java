package com.ghatana.audio.video.infrastructure.persistence.service;

import com.ghatana.audio.video.infrastructure.persistence.entity.AudioFileEntity;
import com.ghatana.audio.video.infrastructure.persistence.repository.AudioFileRepository;
import io.activej.eventloop.Eventloop;
import io.activej.promise.Promise;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ExecutorService;

/**
 * @doc.type class
 * @doc.purpose Async service for AudioFile operations.
 *              Follows AEP pattern - service layer is async,
 *              repository layer is synchronous.
 * @doc.layer infrastructure
 * @doc.pattern Service
 */
public class AudioFileService implements AutoCloseable {

    private static final Logger LOG = LoggerFactory.getLogger(AudioFileService.class);

    private final AudioFileRepository repository;
    private final ExecutorService dbExecutor;
    private final PersistenceOperations operations;
    private final ExecutorOwnership executorOwnership;

    public AudioFileService(AudioFileRepository repository, Eventloop eventloop) {
        this(repository, eventloop, PersistenceExecutors.newDatabaseExecutor("audio-file"), ExecutorOwnership.SERVICE);
    }

    public AudioFileService(AudioFileRepository repository, Eventloop eventloop, ExecutorService dbExecutor) {
        this(repository, eventloop, dbExecutor, ExecutorOwnership.CALLER);
    }

    /**
     * Injects an executor with explicit shutdown ownership. Caller-owned executors can be shared
     * across persistence services; service-owned executors are shut down by {@link #close()}.
     */
    public AudioFileService(AudioFileRepository repository, Eventloop eventloop, ExecutorService dbExecutor,
                            ExecutorOwnership executorOwnership) {
        this.repository = repository;
        this.dbExecutor = Objects.requireNonNull(dbExecutor, "dbExecutor");
        this.operations = new PersistenceOperations(eventloop, dbExecutor);
        this.executorOwnership = Objects.requireNonNull(executorOwnership, "executorOwnership");
    }

    /** Initiates graceful shutdown of an owned executor without waiting on the caller/eventloop. */
    @Override
    public void close() {
        if (executorOwnership != ExecutorOwnership.SERVICE) {
            return;
        }
        // shutdown() stops admission but drains already accepted tasks. Do not await or interrupt here:
        // callers may be on the eventloop, and Promise.ofBlocking needs accepted tasks to complete.
        dbExecutor.shutdown();
    }

    /**
     * Save an audio file entity.
     */
    public Promise<AudioFileEntity> save(String tenantId, AudioFileEntity entity) {
        return operations.submit(() -> repository.save(tenantId, entity))
            .whenResult(saved -> LOG.debug("AudioFile saved: tenantId={}, id={}", tenantId, saved.getId()))
            .whenException(e -> LOG.error("Failed to save AudioFile: tenantId={}", tenantId, e));
    }

    /**
     * Find audio file by ID.
     */
    public Promise<Optional<AudioFileEntity>> findById(String tenantId, UUID id) {
        return operations.submit(() -> repository.findById(tenantId, id))
            .whenException(e -> LOG.error("Failed to find AudioFile: tenantId={}, id={}", tenantId, id, e));
    }

    /**
     * Find all audio files for a tenant.
     */
    public Promise<List<AudioFileEntity>> findByTenantId(String tenantId) {
        return operations.submit(() -> repository.findByTenantId(tenantId))
            .whenException(e -> LOG.error("Failed to find AudioFiles: tenantId={}", tenantId, e));
    }

    /**
     * Find audio files by user ID.
     */
    public Promise<List<AudioFileEntity>> findByUserId(String tenantId, UUID userId) {
        return operations.submit(() -> repository.findByUserId(tenantId, userId))
            .whenException(e -> LOG.error("Failed to find AudioFiles by user: tenantId={}, userId={}", tenantId, userId, e));
    }

    /**
     * Find audio files by status.
     */
    public Promise<List<AudioFileEntity>> findByStatus(String tenantId, AudioFileEntity.ProcessingStatus status) {
        return operations.submit(() -> repository.findByStatus(tenantId, status))
            .whenException(e -> LOG.error("Failed to find AudioFiles by status: tenantId={}, status={}", tenantId, status, e));
    }

    /**
     * Soft delete an audio file.
     */
    public Promise<Boolean> softDelete(String tenantId, UUID id) {
        return operations.submit(() -> repository.softDelete(tenantId, id))
            .whenResult(deleted -> LOG.debug("AudioFile soft deleted: tenantId={}, id={}, success={}", tenantId, id, deleted))
            .whenException(e -> LOG.error("Failed to soft delete AudioFile: tenantId={}, id={}", tenantId, id, e));
    }

    /**
     * Hard delete an audio file.
     */
    public Promise<Boolean> hardDelete(String tenantId, UUID id) {
        return operations.submit(() -> repository.hardDelete(tenantId, id))
            .whenResult(deleted -> LOG.debug("AudioFile hard deleted: tenantId={}, id={}, success={}", tenantId, id, deleted))
            .whenException(e -> LOG.error("Failed to hard delete AudioFile: tenantId={}, id={}", tenantId, id, e));
    }

    /**
     * Check if audio file exists.
     */
    public Promise<Boolean> existsById(String tenantId, UUID id) {
        return operations.submit(() -> repository.existsById(tenantId, id));
    }

    /**
     * Count audio files for a tenant.
     */
    public Promise<Long> countByTenantId(String tenantId) {
        return operations.submit(() -> repository.countByTenantId(tenantId))
            .whenException(e -> LOG.error("Failed to count AudioFiles: tenantId={}", tenantId, e));
    }

    /**
     * AV-P1-004: Update audio file status.
     *
     * @param tenantId the tenant ID
     * @param id the audio file ID
     * @param status the new processing status
     * @param reason optional reason for status change (for FAILED status)
     * @return promise completing when status is updated
     */
    public Promise<Boolean> updateStatus(String tenantId, UUID id, 
                                          AudioFileEntity.ProcessingStatus status, 
                                          String reason) {
        return operations.submit(() -> repository.updateStatus(tenantId, id, status, reason))
            .whenResult(updated -> LOG.debug("AudioFile status updated: tenantId={}, id={}, status={}, reason={}", 
                tenantId, id, status, reason))
            .whenException(e -> LOG.error("Failed to update AudioFile status: tenantId={}, id={}, status={}", 
                tenantId, id, status, e));
    }

    /**
     * AV-P1-005: Transactional save of audio file with transcription.
     * Both entities are saved in a single transaction to ensure atomicity.
     *
     * @param tenantId the tenant ID
     * @param audioFile the audio file entity
     * @param transcription the transcription entity (optional)
     * @return promise completing with the saved audio file
     */
    public Promise<AudioFileEntity> saveWithTranscription(String tenantId, 
                                                          AudioFileEntity audioFile,
                                                          com.ghatana.audio.video.infrastructure.persistence.entity.TranscriptionEntity transcription) {
        return operations.submit(() -> {
            var tx = repository.getEntityManager().getTransaction();
            UUID originalAudioFileId = transcription == null ? null : transcription.getAudioFileId();
            boolean began = false;
            try {
                if (!tx.isActive()) {
                    tx.begin();
                    began = true;
                }

                // Save audio file
                AudioFileEntity savedAudioFile = repository.save(tenantId, audioFile);

                // Save transcription if provided
                if (transcription != null) {
                    transcription.setAudioFileId(savedAudioFile.getId());
                    // Reuse the guarded tenant-aware repository on the same
                    // EntityManager/transaction. Direct merge by global ID could
                    // otherwise overwrite a different tenant's transcription.
                    new com.ghatana.audio.video.infrastructure.persistence.repository.JpaTranscriptionRepository(
                            repository.getEntityManager()).save(tenantId, transcription);
                }

                if (began) {
                    tx.commit();
                }

                LOG.debug("AudioFile and transcription saved atomically: tenantId={}, audioId={}, transcriptionId={}", 
                    tenantId, savedAudioFile.getId(), transcription != null ? transcription.getId() : "none");
                return savedAudioFile;
            } catch (Exception e) {
                if (transcription != null) transcription.setAudioFileId(originalAudioFileId);
                if (tx.isActive()) {
                    if (began) tx.rollback();
                    else tx.setRollbackOnly();
                }
                LOG.error("Failed to save audio file with transcription atomically");
                throw new RuntimeException("Failed to save audio file with transcription", e);
            }
        });
    }
}
