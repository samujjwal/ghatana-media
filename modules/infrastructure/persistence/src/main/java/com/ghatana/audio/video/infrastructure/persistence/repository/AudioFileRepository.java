package com.ghatana.audio.video.infrastructure.persistence.repository;

import com.ghatana.audio.video.infrastructure.persistence.entity.AudioFileEntity;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * @doc.type interface
 * @doc.purpose Synchronous repository for AudioFileEntity with tenant isolation.
 *              Follows AEP pattern - repositories are synchronous,
 *              async is handled at service layer.
 * @doc.layer infrastructure
 * @doc.pattern Repository
 */
public interface AudioFileRepository {

    AudioFileEntity save(String tenantId, AudioFileEntity entity);

    Optional<AudioFileEntity> findById(String tenantId, UUID id);

    List<AudioFileEntity> findByTenantId(String tenantId);

    List<AudioFileEntity> findByUserId(String tenantId, UUID userId);

    List<AudioFileEntity> findByStatus(String tenantId, AudioFileEntity.ProcessingStatus status);

    boolean softDelete(String tenantId, UUID id);

    boolean hardDelete(String tenantId, UUID id);

    boolean existsById(String tenantId, UUID id);

    long countByTenantId(String tenantId);

    long countByUserId(String tenantId, UUID userId);

    /**
     * AV-P1-004: Update audio file status.
     *
     * @param tenantId the tenant ID
     * @param id the audio file ID
     * @param status the new processing status
     * @param reason optional reason for status change (for FAILED status)
     * @return true if update succeeded
     */
    boolean updateStatus(String tenantId, UUID id, AudioFileEntity.ProcessingStatus status, String reason);

    /**
     * Find all audio files including soft-deleted ones.
     * Useful for admin operations and hard delete verification.
     */
    List<AudioFileEntity> findAllByTenantIdIncludingDeleted(String tenantId);

    /**
     * AV-P1-005: Get the EntityManager for transactional operations.
     * This allows service layer to perform multi-entity atomic operations.
     *
     * @return the EntityManager
     */
    jakarta.persistence.EntityManager getEntityManager();
}
