package com.ghatana.audio.video.infrastructure.persistence.repository;

import com.ghatana.audio.video.infrastructure.persistence.entity.TranscriptionEntity;
import jakarta.persistence.EntityManager;
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

        entity.setTenantId(tenantId);

        var tx = entityManager.getTransaction();
        boolean began = false;
        try {
            if (!tx.isActive()) {
                tx.begin();
                began = true;
            }

            TranscriptionEntity saved;
            if (entity.getId() == null) {
                entityManager.persist(entity);
                saved = entity;
            } else {
                saved = entityManager.merge(entity);
            }

            if (began) tx.commit();
            LOG.debug("Transcription saved: tenantId={}, id={}", tenantId, saved.getId());
            return saved;
        } catch (Exception e) {
            if (began && tx.isActive()) tx.rollback();
            LOG.error("Failed to save Transcription: tenantId={}", tenantId, e);
            throw new RuntimeException("Failed to save Transcription: " + e.getMessage(), e);
        }
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

            TranscriptionEntity entity = entityManager.find(TranscriptionEntity.class, id);
            if (entity != null && entity.getTenantId().equals(tenantId) && !entity.isDeleted()) {
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
            if (began && tx.isActive()) tx.rollback();
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

            TranscriptionEntity entity = entityManager.find(TranscriptionEntity.class, id);
            if (entity != null && entity.getTenantId().equals(tenantId)) {
                entityManager.remove(entity);
                if (began) tx.commit();
                LOG.debug("Transcription hard deleted: tenantId={}, id={}", tenantId, id);
                return true;
            }

            if (began) tx.commit();
            return false;
        } catch (Exception e) {
            if (began && tx.isActive()) tx.rollback();
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
