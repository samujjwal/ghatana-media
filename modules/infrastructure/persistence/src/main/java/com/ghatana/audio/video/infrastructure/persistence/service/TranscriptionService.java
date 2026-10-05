package com.ghatana.audio.video.infrastructure.persistence.service;

import com.ghatana.audio.video.infrastructure.persistence.entity.TranscriptionEntity;
import com.ghatana.audio.video.infrastructure.persistence.repository.TranscriptionRepository;
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
 * @doc.purpose Async service for Transcription operations.
 *              Follows AEP pattern - service layer is async,
 *              repository layer is synchronous.
 * @doc.layer infrastructure
 * @doc.pattern Service
 */
public class TranscriptionService {

    private static final Logger LOG = LoggerFactory.getLogger(TranscriptionService.class);

    private final TranscriptionRepository repository;
    private final Eventloop eventloop;
    private final ExecutorService dbExecutor;

    public TranscriptionService(TranscriptionRepository repository, Eventloop eventloop) {
        this(repository, eventloop, Executors.newVirtualThreadPerTaskExecutor());
    }

    public TranscriptionService(TranscriptionRepository repository, Eventloop eventloop, ExecutorService dbExecutor) {
        this.repository = repository;
        this.eventloop = eventloop;
        this.dbExecutor = dbExecutor;
    }

    /**
     * Save a transcription entity.
     */
    public Promise<TranscriptionEntity> save(String tenantId, TranscriptionEntity entity) {
        return Promise.ofBlocking(dbExecutor, () -> repository.save(tenantId, entity))
            .whenResult(saved -> LOG.debug("Transcription saved: tenantId={}, id={}", tenantId, saved.getId()))
            .whenException(e -> LOG.error("Failed to save Transcription: tenantId={}", tenantId, e));
    }

    /**
     * Find transcription by ID.
     */
    public Promise<Optional<TranscriptionEntity>> findById(String tenantId, UUID id) {
        return Promise.ofBlocking(dbExecutor, () -> repository.findById(tenantId, id))
            .whenException(e -> LOG.error("Failed to find Transcription: tenantId={}, id={}", tenantId, id, e));
    }

    /**
     * Find transcription by audio file ID.
     */
    public Promise<Optional<TranscriptionEntity>> findByAudioFileId(String tenantId, UUID audioFileId) {
        return Promise.ofBlocking(dbExecutor, () -> repository.findByAudioFileId(tenantId, audioFileId))
            .whenException(e -> LOG.error("Failed to find Transcription: tenantId={}, audioFileId={}", tenantId, audioFileId, e));
    }

    /**
     * Find all transcriptions for a tenant.
     */
    public Promise<List<TranscriptionEntity>> findByTenantId(String tenantId) {
        return Promise.ofBlocking(dbExecutor, () -> repository.findByTenantId(tenantId))
            .whenException(e -> LOG.error("Failed to find Transcriptions: tenantId={}", tenantId, e));
    }

    /**
     * Find transcriptions by status.
     */
    public Promise<List<TranscriptionEntity>> findByStatus(String tenantId, TranscriptionEntity.TranscriptionStatus status) {
        return Promise.ofBlocking(dbExecutor, () -> repository.findByStatus(tenantId, status))
            .whenException(e -> LOG.error("Failed to find Transcriptions by status: tenantId={}, status={}", tenantId, status, e));
    }

    /**
     * Soft delete a transcription.
     */
    public Promise<Boolean> softDelete(String tenantId, UUID id) {
        return Promise.ofBlocking(dbExecutor, () -> repository.softDelete(tenantId, id))
            .whenResult(deleted -> LOG.debug("Transcription soft deleted: tenantId={}, id={}, success={}", tenantId, id, deleted))
            .whenException(e -> LOG.error("Failed to soft delete Transcription: tenantId={}, id={}", tenantId, id, e));
    }

    /**
     * Hard delete a transcription.
     */
    public Promise<Boolean> hardDelete(String tenantId, UUID id) {
        return Promise.ofBlocking(dbExecutor, () -> repository.hardDelete(tenantId, id))
            .whenResult(deleted -> LOG.debug("Transcription hard deleted: tenantId={}, id={}, success={}", tenantId, id, deleted))
            .whenException(e -> LOG.error("Failed to hard delete Transcription: tenantId={}, id={}", tenantId, id, e));
    }

    /**
     * Check if transcription exists for an audio file.
     */
    public Promise<Boolean> existsByAudioFileId(String tenantId, UUID audioFileId) {
        return Promise.ofBlocking(dbExecutor, () -> repository.existsByAudioFileId(tenantId, audioFileId));
    }

    /**
     * Count transcriptions for a tenant.
     */
    public Promise<Long> countByTenantId(String tenantId) {
        return Promise.ofBlocking(dbExecutor, () -> repository.countByTenantId(tenantId))
            .whenException(e -> LOG.error("Failed to count Transcriptions: tenantId={}", tenantId, e));
    }
}
