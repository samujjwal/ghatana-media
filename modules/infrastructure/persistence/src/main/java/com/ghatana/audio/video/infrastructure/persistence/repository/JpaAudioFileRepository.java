package com.ghatana.audio.video.infrastructure.persistence.repository;

import com.ghatana.audio.video.infrastructure.persistence.entity.AudioFileEntity;
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

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;

/**
 * @doc.type class
 * @doc.purpose Synchronous JPA repository for AudioFileEntity.
 *              Follows AEP pattern - repositories are synchronous.
 * @doc.layer infrastructure
 * @doc.pattern Repository Implementation
 */
public class JpaAudioFileRepository implements AudioFileRepository {

    private static final Logger LOG = LoggerFactory.getLogger(JpaAudioFileRepository.class);

    private final EntityManager entityManager;

    public JpaAudioFileRepository(EntityManager entityManager) {
        this.entityManager = Objects.requireNonNull(entityManager, "EntityManager cannot be null");
    }

    @Override
    public AudioFileEntity save(String tenantId, AudioFileEntity entity) {
        Objects.requireNonNull(tenantId, "tenantId cannot be null");
        Objects.requireNonNull(entity, "entity cannot be null");

        var tx = entityManager.getTransaction();
        boolean began = false;
        try {
            if (!tx.isActive()) {
                tx.begin();
                began = true;
            }

            String persistedTenant = entity.getId() == null
                ? null
                : readPersistedTenantForUpdate(entity.getId());
            if (entity.getTenantId() != null && !tenantId.equals(entity.getTenantId())) {
                restoreManagedEntityIfPresent(entity, persistedTenant);
                throw new TenantScopeException("AudioFile tenant does not match save tenant");
            }
            if (persistedTenant != null && !tenantId.equals(persistedTenant)) {
                restoreManagedEntityIfPresent(entity, persistedTenant);
                throw new TenantScopeException("AudioFile does not belong to save tenant");
            }

            AudioFileEntity saved;
            if (entity.getId() == null || persistedTenant == null) {
                if (entity.getId() != null && entityManager.contains(entity)) {
                    throw new TenantScopeException("Managed AudioFile with no persisted row cannot be saved");
                }
                entity.setTenantId(tenantId);
                entityManager.persist(entity);
                saved = entity;
            } else {
                entity.setTenantId(tenantId);
                saved = entityManager.merge(entity);
            }

            if (began) {
                tx.commit();
            }

            LOG.debug("AudioFile saved: tenantId={}, id={}", tenantId, saved.getId());
            return saved;
        } catch (TenantScopeException e) {
            if (began && tx.isActive()) {
                tx.rollback();
            }
            throw e;
        } catch (Exception e) {
            if (began && tx.isActive()) {
                tx.rollback();
            }
            LOG.error("Failed to save AudioFile: tenantId={}", tenantId, e);
            throw new RuntimeException("Failed to save AudioFile: " + e.getMessage(), e);
        }
    }

    private static final class TenantScopeException extends IllegalArgumentException {
        private TenantScopeException(String message) {
            super(message);
        }
    }

    private String readPersistedTenantForUpdate(UUID id) {
        try {
            return (String) entityManager.createNativeQuery(
                    "SELECT tenant_id FROM audio_video.audio_files WHERE id = :id FOR UPDATE")
                .setParameter("id", id)
                .setFlushMode(FlushModeType.COMMIT)
                .getSingleResult();
        } catch (jakarta.persistence.NoResultException missing) {
            return null;
        }
    }

    private void restoreManagedEntityIfPresent(AudioFileEntity entity, String persistedTenant) {
        if (persistedTenant != null && entityManager.contains(entity)) {
            entityManager.refresh(entity, LockModeType.PESSIMISTIC_WRITE);
        }
    }

    @Override
    public Optional<AudioFileEntity> findById(String tenantId, UUID id) {
        Objects.requireNonNull(tenantId, "tenantId cannot be null");
        Objects.requireNonNull(id, "id cannot be null");

        try {
            TypedQuery<AudioFileEntity> query = entityManager.createNamedQuery(
                "AudioFile.findByIdAndTenantId", AudioFileEntity.class);
            query.setParameter("id", id);
            query.setParameter("tenantId", tenantId);

            return Optional.of(query.getSingleResult());
        } catch (jakarta.persistence.NoResultException e) {
            return Optional.empty();
        } catch (Exception e) {
            LOG.error("Failed to find AudioFile: tenantId={}, id={}", tenantId, id, e);
            throw new RuntimeException("Failed to find AudioFile: " + e.getMessage(), e);
        }
    }

    @Override
    public List<AudioFileEntity> findByTenantId(String tenantId) {
        Objects.requireNonNull(tenantId, "tenantId cannot be null");

        CriteriaBuilder cb = entityManager.getCriteriaBuilder();
        CriteriaQuery<AudioFileEntity> query = cb.createQuery(AudioFileEntity.class);
        Root<AudioFileEntity> root = query.from(AudioFileEntity.class);

        List<Predicate> predicates = new ArrayList<>();
        predicates.add(cb.equal(root.get("tenantId"), tenantId));
        predicates.add(cb.equal(root.get("deleted"), false));

        query.select(root)
            .where(predicates.toArray(new Predicate[0]))
            .orderBy(cb.desc(root.get("createdAt")));

        return entityManager.createQuery(query).getResultList();
    }

    @Override
    public List<AudioFileEntity> findByUserId(String tenantId, UUID userId) {
        Objects.requireNonNull(tenantId, "tenantId cannot be null");
        Objects.requireNonNull(userId, "userId cannot be null");

        try {
            TypedQuery<AudioFileEntity> query = entityManager.createNamedQuery(
                "AudioFile.findByUserIdAndTenantId", AudioFileEntity.class);
            query.setParameter("userId", userId);
            query.setParameter("tenantId", tenantId);
            return query.getResultList();
        } catch (Exception e) {
            LOG.error("Failed to find AudioFiles by user: tenantId={}, userId={}", tenantId, userId, e);
            throw new RuntimeException("Failed to find AudioFiles by user: " + e.getMessage(), e);
        }
    }

    @Override
    public List<AudioFileEntity> findByStatus(String tenantId, AudioFileEntity.ProcessingStatus status) {
        Objects.requireNonNull(tenantId, "tenantId cannot be null");
        Objects.requireNonNull(status, "status cannot be null");

        try {
            TypedQuery<AudioFileEntity> query = entityManager.createNamedQuery(
                "AudioFile.findByStatusAndTenantId", AudioFileEntity.class);
            query.setParameter("status", status);
            query.setParameter("tenantId", tenantId);
            return query.getResultList();
        } catch (Exception e) {
            LOG.error("Failed to find AudioFiles by status: tenantId={}, status={}", tenantId, status, e);
            throw new RuntimeException("Failed to find AudioFiles by status: " + e.getMessage(), e);
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

            AudioFileEntity entity = entityManager.find(AudioFileEntity.class, id);
            if (entity != null && entity.getTenantId().equals(tenantId) && !entity.isDeleted()) {
                entity.setDeleted(true);
                entity.setDeletedAt(Instant.now());
                entityManager.merge(entity);
                if (began) tx.commit();
                LOG.debug("AudioFile soft deleted: tenantId={}, id={}", tenantId, id);
                return true;
            }

            if (began) tx.commit();
            return false;
        } catch (Exception e) {
            if (began && tx.isActive()) tx.rollback();
            LOG.error("Failed to soft delete AudioFile: tenantId={}, id={}", tenantId, id, e);
            throw new RuntimeException("Failed to soft delete AudioFile: " + e.getMessage(), e);
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

            AudioFileEntity entity = entityManager.find(AudioFileEntity.class, id);
            if (entity != null && entity.getTenantId().equals(tenantId)) {
                entityManager.remove(entity);
                if (began) tx.commit();
                LOG.debug("AudioFile hard deleted: tenantId={}, id={}", tenantId, id);
                return true;
            }

            if (began) tx.commit();
            return false;
        } catch (Exception e) {
            if (began && tx.isActive()) tx.rollback();
            LOG.error("Failed to hard delete AudioFile: tenantId={}, id={}", tenantId, id, e);
            throw new RuntimeException("Failed to hard delete AudioFile: " + e.getMessage(), e);
        }
    }

    @Override
    public boolean existsById(String tenantId, UUID id) {
        return findById(tenantId, id).isPresent();
    }

    @Override
    public long countByTenantId(String tenantId) {
        Objects.requireNonNull(tenantId, "tenantId cannot be null");

        try {
            TypedQuery<Long> query = entityManager.createNamedQuery(
                "AudioFile.countByTenantId", Long.class);
            query.setParameter("tenantId", tenantId);
            return query.getSingleResult();
        } catch (Exception e) {
            LOG.error("Failed to count AudioFiles: tenantId={}", tenantId, e);
            throw new RuntimeException("Failed to count AudioFiles: " + e.getMessage(), e);
        }
    }

    @Override
    public long countByUserId(String tenantId, UUID userId) {
        Objects.requireNonNull(tenantId, "tenantId cannot be null");
        Objects.requireNonNull(userId, "userId cannot be null");

        try {
            TypedQuery<Long> query = entityManager.createQuery(
                "SELECT COUNT(af) FROM AudioFileEntity af WHERE af.tenantId = :tenantId AND af.userId = :userId AND af.deleted = false",
                Long.class);
            query.setParameter("tenantId", tenantId);
            query.setParameter("userId", userId);
            return query.getSingleResult();
        } catch (Exception e) {
            LOG.error("Failed to count AudioFiles by user: tenantId={}, userId={}", tenantId, userId, e);
            throw new RuntimeException("Failed to count AudioFiles by user: " + e.getMessage(), e);
        }
    }

    @Override
    public boolean updateStatus(String tenantId, UUID id, AudioFileEntity.ProcessingStatus status, String reason) {
        Objects.requireNonNull(tenantId, "tenantId cannot be null");
        Objects.requireNonNull(id, "id cannot be null");
        Objects.requireNonNull(status, "status cannot be null");

        var tx = entityManager.getTransaction();
        boolean began = false;
        try {
            if (!tx.isActive()) {
                tx.begin();
                began = true;
            }

            AudioFileEntity entity = entityManager.find(AudioFileEntity.class, id);
            if (entity != null && entity.getTenantId().equals(tenantId)) {
                entity.setStatus(status);
                entity.setUpdatedAt(Instant.now());
                if (reason != null) {
                    entity.setFailureReason(reason);
                }
                entityManager.merge(entity);
                if (began) tx.commit();
                LOG.debug("AudioFile status updated: tenantId={}, id={}, status={}", tenantId, id, status);
                return true;
            }

            if (began) tx.commit();
            return false;
        } catch (Exception e) {
            if (began && tx.isActive()) tx.rollback();
            LOG.error("Failed to update AudioFile status: tenantId={}, id={}, status={}", tenantId, id, status, e);
            throw new RuntimeException("Failed to update AudioFile status: " + e.getMessage(), e);
        }
    }

    @Override
    public List<AudioFileEntity> findAllByTenantIdIncludingDeleted(String tenantId) {
        Objects.requireNonNull(tenantId, "tenantId cannot be null");

        try {
            TypedQuery<AudioFileEntity> query = entityManager.createQuery(
                "SELECT af FROM AudioFileEntity af WHERE af.tenantId = :tenantId",
                AudioFileEntity.class);
            query.setParameter("tenantId", tenantId);
            return query.getResultList();
        } catch (Exception e) {
            LOG.error("Failed to find all AudioFiles including deleted: tenantId={}", tenantId, e);
            throw new RuntimeException("Failed to find all AudioFiles: " + e.getMessage(), e);
        }
    }

    @Override
    public jakarta.persistence.EntityManager getEntityManager() {
        return entityManager;
    }
}
