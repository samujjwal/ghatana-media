package com.ghatana.audio.video.infrastructure.persistence.repository;

import com.ghatana.audio.video.infrastructure.persistence.entity.TranscriptionEntity;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * @doc.type interface
 * @doc.purpose Synchronous repository for TranscriptionEntity with tenant isolation.
 *              Follows AEP pattern - repositories are synchronous,
 *              async is handled at service layer.
 * @doc.layer infrastructure
 * @doc.pattern Repository
 */
public interface TranscriptionRepository {

    TranscriptionEntity save(String tenantId, TranscriptionEntity entity);

    Optional<TranscriptionEntity> findById(String tenantId, UUID id);

    Optional<TranscriptionEntity> findByAudioFileId(String tenantId, UUID audioFileId);

    List<TranscriptionEntity> findByTenantId(String tenantId);

    List<TranscriptionEntity> findByUserId(String tenantId, UUID userId);

    List<TranscriptionEntity> findByStatus(String tenantId, TranscriptionEntity.TranscriptionStatus status);

    boolean softDelete(String tenantId, UUID id);

    boolean hardDelete(String tenantId, UUID id);

    boolean existsByAudioFileId(String tenantId, UUID audioFileId);

    long countByTenantId(String tenantId);
}
