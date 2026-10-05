package com.ghatana.audio.video.infrastructure.persistence.repository;

import com.ghatana.audio.video.infrastructure.persistence.entity.TranscriptionEntity;
import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityManagerFactory;
import jakarta.persistence.Persistence;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * @doc.type class
 * @doc.purpose Unit tests for JpaTranscriptionRepository (synchronous per AEP pattern) 
 * @doc.layer test
 * @doc.pattern Test
 */
@DisplayName("JpaTranscriptionRepository Tests")
class JpaTranscriptionRepositoryTest {

    private EntityManagerFactory emf;
    private EntityManager entityManager;
    private JpaTranscriptionRepository repository;

    @BeforeEach
    void setUp() { 
        emf = Persistence.createEntityManagerFactory("audio-video-test");
        entityManager = emf.createEntityManager(); 
        repository = new JpaTranscriptionRepository(entityManager); 
    }

    @AfterEach
    void tearDown() { 
        if (entityManager != null && entityManager.isOpen()) { 
            entityManager.close(); 
        }
        if (emf != null && emf.isOpen()) { 
            emf.close(); 
        }
    }

    @Test
    @DisplayName("GIVEN valid entity WHEN save THEN entity is persisted")
    void testSaveTranscription() { 
        // GIVEN
        String tenantId = "tenant-123";
        UUID audioFileId = UUID.randomUUID(); 
        TranscriptionEntity entity = new TranscriptionEntity( 
            UUID.randomUUID(), 
            tenantId,
            audioFileId,
            UUID.randomUUID(), 
            "Hello world, this is a test transcription.",
            "en"
        );
        entity.setConfidence(0.95f); 

        // WHEN
        TranscriptionEntity saved = repository.save(tenantId, entity); 

        // THEN
        assertThat(saved).isNotNull(); 
        assertThat(saved.getId()).isEqualTo(entity.getId()); 
        assertThat(saved.getTenantId()).isEqualTo(tenantId); 
        assertThat(saved.getStatus()).isEqualTo(TranscriptionEntity.TranscriptionStatus.PENDING); 
    }

    @Test
    @DisplayName("GIVEN saved entity WHEN findById THEN returns entity")
    void testFindById() { 
        // GIVEN
        String tenantId = "tenant-123";
        TranscriptionEntity entity = createTestTranscription(tenantId); 
        repository.save(tenantId, entity); 

        // WHEN
        var found = repository.findById(tenantId, entity.getId()); 

        // THEN
        assertThat(found).isPresent(); 
        assertThat(found.get().getId()).isEqualTo(entity.getId()); 
    }

    @Test
    @DisplayName("GIVEN saved transcription WHEN findByAudioFileId THEN returns transcription")
    void testFindByAudioFileId() { 
        // GIVEN
        String tenantId = "tenant-123";
        UUID audioFileId = UUID.randomUUID(); 
        TranscriptionEntity entity = new TranscriptionEntity( 
            UUID.randomUUID(), 
            tenantId,
            audioFileId,
            UUID.randomUUID(), 
            "Test transcription text",
            "en"
        );
        repository.save(tenantId, entity); 

        // WHEN
        var found = repository.findByAudioFileId(tenantId, audioFileId); 

        // THEN
        assertThat(found).isPresent(); 
        assertThat(found.get().getAudioFileId()).isEqualTo(audioFileId); 
    }

    @Test
    @DisplayName("GIVEN wrong tenant WHEN findById THEN returns empty")
    void testFindByIdWrongTenant() { 
        // GIVEN
        String tenantId = "tenant-123";
        String wrongTenant = "tenant-999";
        TranscriptionEntity entity = createTestTranscription(tenantId); 
        repository.save(tenantId, entity); 

        // WHEN
        var found = repository.findById(wrongTenant, entity.getId()); 

        // THEN
        assertThat(found).isEmpty(); 
    }

    @Test
    @DisplayName("GIVEN multiple entities WHEN findByTenantId THEN returns all for tenant")
    void testFindByTenantId() { 
        // GIVEN
        String tenantId = "tenant-123";

        TranscriptionEntity entity1 = createTestTranscription(tenantId); 
        TranscriptionEntity entity2 = createTestTranscription(tenantId); 

        repository.save(tenantId, entity1); 
        repository.save(tenantId, entity2); 

        // WHEN
        var found = repository.findByTenantId(tenantId); 

        // THEN
        assertThat(found).hasSize(2); 
    }

    @Test
    @DisplayName("GIVEN entities with different statuses WHEN findByStatus THEN returns matching")
    void testFindByStatus() { 
        // GIVEN
        String tenantId = "tenant-123";

        TranscriptionEntity completed = createTestTranscription(tenantId); 
        completed.setStatus(TranscriptionEntity.TranscriptionStatus.COMPLETED); 

        TranscriptionEntity pending = createTestTranscription(tenantId); 
        pending.setStatus(TranscriptionEntity.TranscriptionStatus.PENDING); 

        repository.save(tenantId, completed); 
        repository.save(tenantId, pending); 

        // WHEN
        var completedTranscriptions = repository.findByStatus( 
            tenantId,
            TranscriptionEntity.TranscriptionStatus.COMPLETED
        );

        // THEN
        assertThat(completedTranscriptions).hasSize(1); 
        assertThat(completedTranscriptions.get(0).getStatus()).isEqualTo( 
            TranscriptionEntity.TranscriptionStatus.COMPLETED
        );
    }

    @Test
    @DisplayName("GIVEN saved entity WHEN softDelete THEN entity is marked deleted")
    void testSoftDelete() { 
        // GIVEN
        String tenantId = "tenant-123";
        TranscriptionEntity entity = createTestTranscription(tenantId); 
        repository.save(tenantId, entity); 

        // WHEN
        boolean deleted = repository.softDelete(tenantId, entity.getId()); 

        // THEN
        assertThat(deleted).isTrue(); 
        var found = repository.findById(tenantId, entity.getId()); 
        assertThat(found).isPresent(); 
        assertThat(found.get().isDeleted()).isTrue(); 
        assertThat(found.get().getDeletedAt()).isNotNull(); 
    }

    @Test
    @DisplayName("GIVEN no entity WHEN softDelete THEN returns false")
    void testSoftDeleteNotFound() { 
        // GIVEN
        String tenantId = "tenant-123";
        UUID nonExistentId = UUID.randomUUID(); 

        // WHEN
        boolean deleted = repository.softDelete(tenantId, nonExistentId); 

        // THEN
        assertThat(deleted).isFalse(); 
    }

    @Test
    @DisplayName("GIVEN soft deleted entity WHEN hardDelete THEN entity is removed")
    void testHardDelete() { 
        // GIVEN
        String tenantId = "tenant-123";
        TranscriptionEntity entity = createTestTranscription(tenantId); 
        repository.save(tenantId, entity); 
        repository.softDelete(tenantId, entity.getId()); 

        // WHEN
        boolean deleted = repository.hardDelete(tenantId, entity.getId()); 

        // THEN
        assertThat(deleted).isTrue(); 
        var found = repository.findById(tenantId, entity.getId()); 
        assertThat(found).isEmpty(); 
    }

    @Test
    @DisplayName("GIVEN transcription exists WHEN existsByAudioFileId THEN returns true")
    void testExistsByAudioFileId() { 
        // GIVEN
        String tenantId = "tenant-123";
        UUID audioFileId = UUID.randomUUID(); 
        TranscriptionEntity entity = new TranscriptionEntity( 
            UUID.randomUUID(), 
            tenantId,
            audioFileId,
            UUID.randomUUID(), 
            "Test text",
            "en"
        );
        repository.save(tenantId, entity); 

        // WHEN
        boolean exists = repository.existsByAudioFileId(tenantId, audioFileId); 

        // THEN
        assertThat(exists).isTrue(); 
    }

    @Test
    @DisplayName("GIVEN no transcription WHEN existsByAudioFileId THEN returns false")
    void testExistsByAudioFileIdNotFound() { 
        // GIVEN
        String tenantId = "tenant-123";
        UUID audioFileId = UUID.randomUUID(); 

        // WHEN
        boolean exists = repository.existsByAudioFileId(tenantId, audioFileId); 

        // THEN
        assertThat(exists).isFalse(); 
    }

    @Test
    @DisplayName("GIVEN saved entities WHEN countByTenantId THEN returns correct count")
    void testCountByTenantId() { 
        // GIVEN
        String tenantId = "tenant-123";
        repository.save(tenantId, createTestTranscription(tenantId)); 
        repository.save(tenantId, createTestTranscription(tenantId)); 

        // WHEN
        long count = repository.countByTenantId(tenantId); 

        // THEN
        assertThat(count).isEqualTo(2L); 
    }

    // Helper methods

    private TranscriptionEntity createTestTranscription(String tenantId) { 
        return new TranscriptionEntity( 
            UUID.randomUUID(), 
            tenantId,
            UUID.randomUUID(), 
            UUID.randomUUID(), 
            "Test transcription " + UUID.randomUUID(), 
            "en"
        );
    }
}
