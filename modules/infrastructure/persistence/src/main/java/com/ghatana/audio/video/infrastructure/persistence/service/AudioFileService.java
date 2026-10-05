package com.ghatana.audio.video.infrastructure.persistence.service;

import com.ghatana.audio.video.infrastructure.persistence.entity.AudioFileEntity;
import com.ghatana.audio.video.infrastructure.persistence.repository.AudioFileRepository;
import io.activej.eventloop.Eventloop;
import io.activej.promise.Promise;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * @doc.type class
 * @doc.purpose Async service for AudioFile operations.
 *              Follows AEP pattern - service layer is async,
 *              repository layer is synchronous.
 * @doc.layer infrastructure
 * @doc.pattern Service
 */
public class AudioFileService {

    private static final Logger LOG = LoggerFactory.getLogger(AudioFileService.class);

    private final AudioFileRepository repository;
    private final Eventloop eventloop;
    private final ExecutorService dbExecutor;

    public AudioFileService(AudioFileRepository repository, Eventloop eventloop) {
        this(repository, eventloop, Executors.newVirtualThreadPerTaskExecutor());
    }

    public AudioFileService(AudioFileRepository repository, Eventloop eventloop, ExecutorService dbExecutor) {
        this.repository = repository;
        this.eventloop = eventloop;
        this.dbExecutor = dbExecutor;
    }

    /**
     * Save an audio file entity.
     */
    public Promise<AudioFileEntity> save(String tenantId, AudioFileEntity entity) {
        return Promise.ofBlocking(dbExecutor, () -> repository.save(tenantId, entity))
            .whenResult(saved -> LOG.debug("AudioFile saved: tenantId={}, id={}", tenantId, saved.getId()))
            .whenException(e -> LOG.error("Failed to save AudioFile: tenantId={}", tenantId, e));
    }

    /**
     * Find audio file by ID.
     */
    public Promise<Optional<AudioFileEntity>> findById(String tenantId, UUID id) {
        return Promise.ofBlocking(dbExecutor, () -> repository.findById(tenantId, id))
            .whenException(e -> LOG.error("Failed to find AudioFile: tenantId={}, id={}", tenantId, id, e));
    }

    /**
     * Find all audio files for a tenant.
     */
    public Promise<List<AudioFileEntity>> findByTenantId(String tenantId) {
        return Promise.ofBlocking(dbExecutor, () -> repository.findByTenantId(tenantId))
            .whenException(e -> LOG.error("Failed to find AudioFiles: tenantId={}", tenantId, e));
    }

    /**
     * Find audio files by user ID.
     */
    public Promise<List<AudioFileEntity>> findByUserId(String tenantId, UUID userId) {
        return Promise.ofBlocking(dbExecutor, () -> repository.findByUserId(tenantId, userId))
            .whenException(e -> LOG.error("Failed to find AudioFiles by user: tenantId={}, userId={}", tenantId, userId, e));
    }

    /**
     * Find audio files by status.
     */
    public Promise<List<AudioFileEntity>> findByStatus(String tenantId, AudioFileEntity.ProcessingStatus status) {
        return Promise.ofBlocking(dbExecutor, () -> repository.findByStatus(tenantId, status))
            .whenException(e -> LOG.error("Failed to find AudioFiles by status: tenantId={}, status={}", tenantId, status, e));
    }

    /**
     * Soft delete an audio file.
     */
    public Promise<Boolean> softDelete(String tenantId, UUID id) {
        return Promise.ofBlocking(dbExecutor, () -> repository.softDelete(tenantId, id))
            .whenResult(deleted -> LOG.debug("AudioFile soft deleted: tenantId={}, id={}, success={}", tenantId, id, deleted))
            .whenException(e -> LOG.error("Failed to soft delete AudioFile: tenantId={}, id={}", tenantId, id, e));
    }

    /**
     * Hard delete an audio file.
     */
    public Promise<Boolean> hardDelete(String tenantId, UUID id) {
        return Promise.ofBlocking(dbExecutor, () -> repository.hardDelete(tenantId, id))
            .whenResult(deleted -> LOG.debug("AudioFile hard deleted: tenantId={}, id={}, success={}", tenantId, id, deleted))
            .whenException(e -> LOG.error("Failed to hard delete AudioFile: tenantId={}, id={}", tenantId, id, e));
    }

    /**
     * Check if audio file exists.
     */
    public Promise<Boolean> existsById(String tenantId, UUID id) {
        return Promise.ofBlocking(dbExecutor, () -> repository.existsById(tenantId, id));
    }

    /**
     * Count audio files for a tenant.
     */
    public Promise<Long> countByTenantId(String tenantId) {
        return Promise.ofBlocking(dbExecutor, () -> repository.countByTenantId(tenantId))
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
        return Promise.ofBlocking(dbExecutor, () -> repository.updateStatus(tenantId, id, status, reason))
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
        return Promise.ofBlocking(dbExecutor, () -> {
            var tx = repository.getEntityManager().getTransaction();
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
                    // Use the same EntityManager for transcription save
                    jakarta.persistence.EntityManager em = repository.getEntityManager();
                    if (transcription.getId() == null) {
                        em.persist(transcription);
                    } else {
                        em.merge(transcription);
                    }
                }

                if (began) {
                    tx.commit();
                }

                LOG.debug("AudioFile and transcription saved atomically: tenantId={}, audioId={}, transcriptionId={}", 
                    tenantId, savedAudioFile.getId(), transcription != null ? transcription.getId() : "none");
                return savedAudioFile;
            } catch (Exception e) {
                if (began && tx.isActive()) {
                    tx.rollback();
                }
                LOG.error("Failed to save audio file with transcription atomically: tenantId={}", tenantId, e);
                throw new RuntimeException("Failed to save audio file with transcription: " + e.getMessage(), e);
            }
        });
    }
}
