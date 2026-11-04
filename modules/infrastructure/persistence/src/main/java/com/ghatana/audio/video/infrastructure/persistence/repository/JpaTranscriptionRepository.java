package com.ghatana.audio.video.infrastructure.persistence.repository;

import com.ghatana.audio.video.infrastructure.persistence.entity.TranscriptionEntity;
import jakarta.persistence.EntityManager;
import jakarta.persistence.FlushModeType;
import jakarta.persistence.LockModeType;
import jakarta.persistence.TypedQuery;
import jakarta.persistence.criteria.CriteriaBuilder;
import jakarta.persistence.criteria.CriteriaQuery;
import jakarta.persistence.criteria.Predicate;
import jakarta.persistence.criteria.Root;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.ByteBuffer;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;

/**
 * @doc.type class
 * @doc.purpose Synchronous JPA repository for TranscriptionEntity.
 *              Follows AEP pattern - repositories are synchronous.
 * @doc.layer infrastructure
 * @doc.pattern Repository Implementation
 */
public class JpaTranscriptionRepository implements TranscriptionRepository {

    private static final Logger LOG = LoggerFactory.getLogger(JpaTranscriptionRepository.class);

    private final EntityManager entityManager;

    public JpaTranscriptionRepository(EntityManager entityManager) {
        this.entityManager = Objects.requireNonNull(entityManager, "EntityManager cannot be null");
    }

    @Override
    public TranscriptionEntity save(String tenantId, TranscriptionEntity entity) {
        Objects.requireNonNull(tenantId, "tenantId cannot be null");
        Objects.requireNonNull(entity, "entity cannot be null");

        var tx = entityManager.getTransaction();
        boolean began = false;
        try {
            if (!tx.isActive()) {
                tx.begin();
                began = true;
            }

            PersistedTranscription persisted = entity.getId() == null
                ? null
                : readPersistedForUpdate(entity.getId());
            String persistedTenant = persisted == null ? null : persisted.tenantId();
            if (entity.getTenantId() != null && !tenantId.equals(entity.getTenantId())) {
                restoreManagedEntityIfPresent(entity, persistedTenant);
                throw new TenantScopeException("Transcription tenant does not match save tenant");
            }
            if (persistedTenant != null && !tenantId.equals(persistedTenant)) {
                restoreManagedEntityIfPresent(entity, persistedTenant);
                throw new TenantScopeException("Transcription does not belong to save tenant");
            }
            if (persisted != null && (!Objects.equals(entity.getUserId(), persisted.userId())
                    || !Objects.equals(entity.getAudioFileId(), persisted.audioFileId()))) {
                restoreManagedEntityIfPresent(entity, persistedTenant);
                throw new TenantScopeException(
                    "Transcription principal and source audio ownership cannot be changed");
            }
            // The legacy JPA row has no canonical source-version or successful-attempt binding.
            // Keep it from claiming provider-owned transcript finality.
            if (claimsSuccessfulTranscriptFinality(entity.getStatus())) {
                restoreManagedEntityIfPresent(entity, persistedTenant);
                throw new SuccessfulTranscriptWriteException(
                    "JPA transcription storage cannot claim successful transcript finality without canonical provider binding");
            }
            if (persisted != null && claimsSuccessfulTranscriptFinality(persisted.status())) {
                restoreManagedEntityIfPresent(entity, persistedTenant);
                throw new SuccessfulTranscriptWriteException(
                    "JPA cannot rewrite rows marked as successful transcript content without canonical provider binding");
            }

            TranscriptionEntity saved;
            if (entity.getId() == null || persistedTenant == null) {
                if (entity.getId() != null && entityManager.contains(entity)) {
                    throw new TenantScopeException("Managed Transcription with no persisted row cannot be saved");
                }
                entity.setTenantId(tenantId);
                entityManager.persist(entity);
                saved = entity;
            } else {
                entity.setTenantId(tenantId);
                saved = entityManager.merge(entity);
            }

            if (began) tx.commit();
            LOG.debug("Transcription saved: tenantId={}, id={}", tenantId, saved.getId());
            return saved;
        } catch (TenantScopeException e) {
            if (began && tx.isActive()) tx.rollback();
            throw e;
        } catch (SuccessfulTranscriptWriteException e) {
            if (began && tx.isActive()) tx.rollback();
            throw e;
        } catch (Exception e) {
            rollbackOrMarkRollbackOnly(tx, began);
            LOG.error("Failed to save Transcription: tenantId={}", tenantId, e);
            throw new RuntimeException("Failed to save Transcription: " + e.getMessage(), e);
        }
    }

    private static void rollbackOrMarkRollbackOnly(jakarta.persistence.EntityTransaction tx, boolean began) {
        if (!tx.isActive()) {
            return;
        }
        if (began) {
            tx.rollback();
        } else {
            tx.setRollbackOnly();
        }
    }

    private static final class TenantScopeException extends IllegalArgumentException {
        private TenantScopeException(String message) {
            super(message);
        }
    }

    private static final class SuccessfulTranscriptWriteException extends IllegalArgumentException {
        private SuccessfulTranscriptWriteException(String message) {
            super(message);
        }
    }

    private record PersistedTranscription(String tenantId, UUID audioFileId, UUID userId,
                                          TranscriptionEntity.TranscriptionStatus status) { }

    private static boolean claimsSuccessfulTranscriptFinality(TranscriptionEntity.TranscriptionStatus status) {
        return status == TranscriptionEntity.TranscriptionStatus.COMPLETED
            || status == TranscriptionEntity.TranscriptionStatus.CORRECTED;
    }

    private PersistedTranscription readPersistedForUpdate(UUID id) {
        try {
            Object[] row = (Object[]) entityManager.createNativeQuery(
                    "SELECT tenant_id, audio_file_id, user_id, status "
                        + "FROM audio_video.transcriptions WHERE id = :id FOR UPDATE")
                .setParameter("id", id)
                .setFlushMode(FlushModeType.COMMIT)
                .getSingleResult();
            return new PersistedTranscription((String) row[0], readUuidColumn(row[1], "audio_file_id"),
                readUuidColumn(row[2], "user_id"),
                TranscriptionEntity.TranscriptionStatus.valueOf((String) row[3]));
        } catch (jakarta.persistence.NoResultException missing) {
            return null;
        }
    }

    private static UUID readUuidColumn(Object value, String columnName) {
        if (value instanceof UUID uuid) {
            return uuid;
        }
        if (value instanceof byte[] bytes && bytes.length == 16) {
            ByteBuffer buffer = ByteBuffer.wrap(bytes);
            return new UUID(buffer.getLong(), buffer.getLong());
        }
        if (value instanceof String text) {
            UUID uuid;
            try {
                uuid = UUID.fromString(text);
            } catch (IllegalArgumentException malformed) {
                throw new IllegalStateException("Database returned malformed UUID for " + columnName, malformed);
            }
            if (uuid.toString().equalsIgnoreCase(text)) {
                return uuid;
            }
        }
        throw new IllegalStateException("Database returned unsupported UUID value for " + columnName);
    }

    private void restoreManagedEntityIfPresent(TranscriptionEntity entity, String persistedTenant) {
        if (persistedTenant != null && entityManager.contains(entity)) {
            entityManager.refresh(entity, LockModeType.PESSIMISTIC_WRITE);
        }
    }

    /**
     * Load the database-owned row while holding its write lock, then refresh any existing
     * persistence-context instance before a tenant-scoped mutation. A managed entity may have
     * been retagged in memory; checking only its current tenant field would let that dirty value
     * authorize a cross-tenant update and then flush the forged tenant along with it.
     */
    private TranscriptionEntity findPersistedForTenantUpdate(String tenantId, UUID id) {
        PersistedTranscription persisted = readPersistedForUpdate(id);
        if (persisted == null) {
            return null;
        }

        TranscriptionEntity entity = entityManager.find(TranscriptionEntity.class, id);
        if (entity == null) {
            return null;
        }
        entityManager.refresh(entity, LockModeType.PESSIMISTIC_WRITE);
        if (!tenantId.equals(persisted.tenantId()) || !tenantId.equals(entity.getTenantId())) {
            return null;
        }
        return entity;
    }

    @Override
    public Optional<TranscriptionEntity> findById(String tenantId, UUID id) {
        Objects.requireNonNull(tenantId, "tenantId cannot be null");
        Objects.requireNonNull(id, "id cannot be null");

        try {
            TypedQuery<TranscriptionEntity> query = entityManager.createNamedQuery(
                "Transcription.findByIdAndTenantId", TranscriptionEntity.class);
            query.setParameter("id", id);
            query.setParameter("tenantId", tenantId);

            return Optional.of(query.getSingleResult());
        } catch (jakarta.persistence.NoResultException e) {
            return Optional.empty();
        } catch (Exception e) {
            LOG.error("Failed to find Transcription: tenantId={}, id={}", tenantId, id, e);
            throw new RuntimeException("Failed to find Transcription: " + e.getMessage(), e);
        }
    }

    @Override
    public Optional<TranscriptionEntity> findByAudioFileId(String tenantId, UUID audioFileId) {
        Objects.requireNonNull(tenantId, "tenantId cannot be null");
        Objects.requireNonNull(audioFileId, "audioFileId cannot be null");

        try {
            TypedQuery<TranscriptionEntity> query = entityManager.createNamedQuery(
                "Transcription.findByAudioFileIdAndTenantId", TranscriptionEntity.class);
            query.setParameter("audioFileId", audioFileId);
            query.setParameter("tenantId", tenantId);

            return Optional.of(query.getSingleResult());
        } catch (jakarta.persistence.NoResultException e) {
            return Optional.empty();
        } catch (Exception e) {
            LOG.error("Failed to find Transcription: tenantId={}, audioFileId={}", tenantId, audioFileId, e);
            throw new RuntimeException("Failed to find Transcription: " + e.getMessage(), e);
        }
    }

    @Override
    public List<TranscriptionEntity> findByTenantId(String tenantId) {
        Objects.requireNonNull(tenantId, "tenantId cannot be null");

        CriteriaBuilder cb = entityManager.getCriteriaBuilder();
        CriteriaQuery<TranscriptionEntity> query = cb.createQuery(TranscriptionEntity.class);
        Root<TranscriptionEntity> root = query.from(TranscriptionEntity.class);

        List<Predicate> predicates = new ArrayList<>();
        predicates.add(cb.equal(root.get("tenantId"), tenantId));
        predicates.add(cb.equal(root.get("deleted"), false));

        query.select(root)
            .where(predicates.toArray(new Predicate[0]))
            .orderBy(cb.desc(root.get("createdAt")));

        return entityManager.createQuery(query).getResultList();
    }

    @Override
    public List<TranscriptionEntity> findByUserId(String tenantId, UUID userId) {
        Objects.requireNonNull(tenantId, "tenantId cannot be null");
        Objects.requireNonNull(userId, "userId cannot be null");

        try {
            TypedQuery<TranscriptionEntity> query = entityManager.createNamedQuery(
                "Transcription.findByUserIdAndTenantId", TranscriptionEntity.class);
            query.setParameter("userId", userId);
            query.setParameter("tenantId", tenantId);
            return query.getResultList();
        } catch (Exception e) {
            LOG.error("Failed to find Transcriptions: tenantId={}, userId={}", tenantId, userId, e);
            throw new RuntimeException("Failed to find Transcriptions: " + e.getMessage(), e);
        }
    }

    @Override
    public List<TranscriptionEntity> findByStatus(String tenantId, TranscriptionEntity.TranscriptionStatus status) {
        Objects.requireNonNull(tenantId, "tenantId cannot be null");
        Objects.requireNonNull(status, "status cannot be null");

        try {
            TypedQuery<TranscriptionEntity> query = entityManager.createQuery(
                "SELECT t FROM TranscriptionEntity t WHERE t.tenantId = :tenantId AND t.status = :status AND t.deleted = false ORDER BY t.createdAt DESC",
                TranscriptionEntity.class);
            query.setParameter("tenantId", tenantId);
            query.setParameter("status", status);
            return query.getResultList();
        } catch (Exception e) {
            LOG.error("Failed to find Transcriptions by status: tenantId={}, status={}", tenantId, status, e);
            throw new RuntimeException("Failed to find Transcriptions by status: " + e.getMessage(), e);
        }
    }

    @Override
    public boolean softDelete(String tenantId, UUID id) {
        Objects.requireNonNull(tenantId, "tenantId cannot be null");
        Objects.requireNonNull(id, "id cannot be null");

        var tx = entityManager.getTransaction();
        boolean began = false;
        try {
            if (!tx.isActive()) {
                tx.begin();
                began = true;
            }

            TranscriptionEntity entity = findPersistedForTenantUpdate(tenantId, id);
            if (entity != null && !entity.isDeleted()) {
                entity.setDeleted(true);
                entity.setDeletedAt(Instant.now());
                entityManager.merge(entity);
                if (began) tx.commit();
                LOG.debug("Transcription soft deleted: tenantId={}, id={}", tenantId, id);
                return true;
            }

            if (began) tx.commit();
            return false;
        } catch (Exception e) {
            rollbackOrMarkRollbackOnly(tx, began);
            LOG.error("Failed to soft delete Transcription: tenantId={}, id={}", tenantId, id, e);
            throw new RuntimeException("Failed to soft delete Transcription: " + e.getMessage(), e);
        }
    }

    @Override
    public boolean hardDelete(String tenantId, UUID id) {
        Objects.requireNonNull(tenantId, "tenantId cannot be null");
        Objects.requireNonNull(id, "id cannot be null");

        var tx = entityManager.getTransaction();
        boolean began = false;
        try {
            if (!tx.isActive()) {
                tx.begin();
                began = true;
            }

            TranscriptionEntity entity = findPersistedForTenantUpdate(tenantId, id);
            if (entity != null) {
                entityManager.remove(entity);
                if (began) tx.commit();
                LOG.debug("Transcription hard deleted: tenantId={}, id={}", tenantId, id);
                return true;
            }

            if (began) tx.commit();
            return false;
        } catch (Exception e) {
            rollbackOrMarkRollbackOnly(tx, began);
            LOG.error("Failed to hard delete Transcription: tenantId={}, id={}", tenantId, id, e);
            throw new RuntimeException("Failed to hard delete Transcription: " + e.getMessage(), e);
        }
    }

    @Override
    public boolean existsByAudioFileId(String tenantId, UUID audioFileId) {
        return findByAudioFileId(tenantId, audioFileId).isPresent();
    }

    @Override
    public long countByTenantId(String tenantId) {
        Objects.requireNonNull(tenantId, "tenantId cannot be null");

        try {
            TypedQuery<Long> query = entityManager.createQuery(
                "SELECT COUNT(t) FROM TranscriptionEntity t WHERE t.tenantId = :tenantId AND t.deleted = false",
                Long.class);
            query.setParameter("tenantId", tenantId);
            return query.getSingleResult();
        } catch (Exception e) {
            LOG.error("Failed to count Transcriptions: tenantId={}", tenantId, e);
            throw new RuntimeException("Failed to count Transcriptions: " + e.getMessage(), e);
        }
    }
}
