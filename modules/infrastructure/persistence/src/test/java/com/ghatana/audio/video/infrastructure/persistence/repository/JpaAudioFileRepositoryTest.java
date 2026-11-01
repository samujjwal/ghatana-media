package com.ghatana.audio.video.infrastructure.persistence.repository;

import com.ghatana.audio.video.infrastructure.persistence.entity.AudioFileEntity;
import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityManagerFactory;
import jakarta.persistence.Persistence;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * @doc.type class
 * @doc.purpose Unit tests for JpaAudioFileRepository (synchronous per AEP pattern) 
 * @doc.layer test
 * @doc.pattern Test
 */
@DisplayName("JpaAudioFileRepository Tests")
class JpaAudioFileRepositoryTest {

    private EntityManagerFactory emf;
    private EntityManager entityManager;
    private JpaAudioFileRepository repository;

    @BeforeEach
    void setUp() { 
        // Use in-memory H2 for unit tests
        emf = Persistence.createEntityManagerFactory("audio-video-test");
        entityManager = emf.createEntityManager(); 
        repository = new JpaAudioFileRepository(entityManager); 
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
    void testSaveAudioFile() { 
        // GIVEN
        String tenantId = "tenant-123";
        UUID userId = UUID.randomUUID(); 
        AudioFileEntity entity = new AudioFileEntity( 
            UUID.randomUUID(), 
            tenantId,
            userId,
            "test-audio.mp3",
            "/storage/test.mp3",
            "mp3"
        );
        entity.setDurationSeconds(120); 
        entity.setFileSizeBytes(1024L * 1024L); 

        // WHEN
        AudioFileEntity saved = repository.save(tenantId, entity); 

        // THEN
        assertThat(saved).isNotNull(); 
        assertThat(saved.getId()).isEqualTo(entity.getId()); 
        assertThat(saved.getTenantId()).isEqualTo(tenantId); 
        assertThat(saved.getStatus()).isEqualTo(AudioFileEntity.ProcessingStatus.PENDING); 
    }

    @Test
    @DisplayName("GIVEN another tenant reuses an existing ID WHEN save THEN ownership and data stay unchanged")
    void testSaveCannotReassignExistingAudioFileToAnotherTenant() {
        AudioFileEntity original = createTestAudioFile("tenant-owner");
        original.setFileName("owned.mp3");
        repository.save("tenant-owner", original);
        entityManager.clear();

        AudioFileEntity ownedUpdate = repository.findById("tenant-owner", original.getId()).orElseThrow();
        ownedUpdate.setFileName("owner-updated.mp3");
        repository.save("tenant-owner", ownedUpdate);
        entityManager.clear();

        AudioFileEntity forgedUpdate = new AudioFileEntity(
            original.getId(), "tenant-attacker", original.getUserId(), "overwritten.mp3",
            "/storage/attacker.mp3", "mp3");

        assertThatThrownBy(() -> repository.save("tenant-attacker", forgedUpdate))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("does not belong to save tenant");

        entityManager.clear();
        assertThat(repository.findById("tenant-owner", original.getId()))
            .get()
            .satisfies(file -> {
                assertThat(file.getTenantId()).isEqualTo("tenant-owner");
                assertThat(file.getFileName()).isEqualTo("owner-updated.mp3");
            });
        assertThat(repository.findById("tenant-attacker", original.getId())).isEmpty();
    }

    @Test
    @DisplayName("GIVEN a managed file is retagged WHEN cross-tenant save is attempted THEN persisted owner is restored")
    void testManagedAudioFileCannotBeRetaggedAcrossTenants() {
        AudioFileEntity original = createTestAudioFile("tenant-owner");
        original.setFileName("owned.mp3");
        repository.save("tenant-owner", original);
        entityManager.clear();

        AudioFileEntity managed = repository.findById("tenant-owner", original.getId()).orElseThrow();
        managed.setTenantId("tenant-attacker");
        managed.setFileName("overwritten.mp3");

        assertThatThrownBy(() -> repository.save("tenant-attacker", managed))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("does not belong to save tenant");

        assertThat(managed.getTenantId()).isEqualTo("tenant-owner");
        assertThat(managed.getFileName()).isEqualTo("owned.mp3");
        entityManager.clear();
        assertThat(repository.findById("tenant-owner", original.getId())).get()
            .extracting(AudioFileEntity::getFileName).isEqualTo("owned.mp3");
    }

    @Test
    @DisplayName("GIVEN a stale file revision WHEN saved THEN it cannot overwrite the current tenant row")
    void staleAudioFileRevisionCannotOverwriteCurrentValue() {
        String tenantId = "tenant-version-owner";
        AudioFileEntity original = createTestAudioFile(tenantId);
        original.setFileName("revision-zero.mp3");
        repository.save(tenantId, original);
        entityManager.clear();

        AudioFileEntity stale = repository.findById(tenantId, original.getId()).orElseThrow();
        entityManager.detach(stale);
        AudioFileEntity current = repository.findById(tenantId, original.getId()).orElseThrow();
        current.setFileName("current-revision.mp3");
        AudioFileEntity savedCurrent = repository.save(tenantId, current);
        assertThat(savedCurrent.getVersion()).isGreaterThan(stale.getVersion());

        stale.setFileName("stale-overwrite.mp3");
        assertThatThrownBy(() -> repository.save(tenantId, stale))
            .hasRootCauseInstanceOf(org.hibernate.StaleStateException.class);

        entityManager.clear();
        assertThat(repository.findById(tenantId, original.getId()))
            .get()
            .satisfies(actual -> {
                assertThat(actual.getTenantId()).isEqualTo(tenantId);
                assertThat(actual.getFileName()).isEqualTo("current-revision.mp3");
            });
    }

    @Test
    @DisplayName("A retagged managed audio file cannot authorize a cross-tenant status update")
    void managedTenantMutationCannotAuthorizeAudioFileUpdate() {
        AudioFileEntity original = createTestAudioFile("tenant-owner");
        original.setFileName("owner-file.mp3");
        repository.save("tenant-owner", original);
        entityManager.clear();

        AudioFileEntity managed = repository.findById("tenant-owner", original.getId()).orElseThrow();
        managed.setTenantId("tenant-attacker");

        assertThat(repository.updateStatus("tenant-attacker", original.getId(),
            AudioFileEntity.ProcessingStatus.FAILED, "forged update")).isFalse();
        assertThat(managed.getTenantId()).isEqualTo("tenant-owner");

        entityManager.clear();
        assertThat(repository.findById("tenant-owner", original.getId())).get()
            .satisfies(actual -> {
                assertThat(actual.getTenantId()).isEqualTo("tenant-owner");
                assertThat(actual.getFileName()).isEqualTo("owner-file.mp3");
                assertThat(actual.getStatus()).isEqualTo(AudioFileEntity.ProcessingStatus.PENDING);
            });
        assertThat(repository.findById("tenant-attacker", original.getId())).isEmpty();
    }

    @Test
    @DisplayName("GIVEN saved entity WHEN findById THEN returns entity")
    void testFindById() { 
        // GIVEN
        String tenantId = "tenant-123";
        AudioFileEntity entity = createTestAudioFile(tenantId); 
        repository.save(tenantId, entity); 

        // WHEN
        var found = repository.findById(tenantId, entity.getId()); 

        // THEN
        assertThat(found).isPresent(); 
        assertThat(found.get().getId()).isEqualTo(entity.getId()); 
        assertThat(found.get().getFileName()).isEqualTo(entity.getFileName()); 
    }

    @Test
    @DisplayName("GIVEN wrong tenant WHEN findById THEN returns empty")
    void testFindByIdWrongTenant() { 
        // GIVEN
        String tenantId = "tenant-123";
        String wrongTenant = "tenant-999";
        AudioFileEntity entity = createTestAudioFile(tenantId); 
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
        String tenantId1 = "tenant-123";
        String tenantId2 = "tenant-456";

        AudioFileEntity entity1 = createTestAudioFile(tenantId1); 
        AudioFileEntity entity2 = createTestAudioFile(tenantId1); 
        AudioFileEntity entity3 = createTestAudioFile(tenantId2); 

        repository.save(tenantId1, entity1); 
        repository.save(tenantId1, entity2); 
        repository.save(tenantId2, entity3); 

        // WHEN
        var found = repository.findByTenantId(tenantId1); 

        // THEN
        assertThat(found).hasSize(2); 
        assertThat(found).extracting("id").containsExactlyInAnyOrder(entity1.getId(), entity2.getId());
    }

    @Test
    @DisplayName("GIVEN saved entity WHEN softDelete THEN entity is marked deleted")
    void testSoftDelete() { 
        // GIVEN
        String tenantId = "tenant-123";
        AudioFileEntity entity = createTestAudioFile(tenantId); 
        repository.save(tenantId, entity); 

        // WHEN
        boolean deleted = repository.softDelete(tenantId, entity.getId()); 

        // THEN
        assertThat(deleted).isTrue(); 
        var found = repository.findById(tenantId, entity.getId()); 
        assertThat(found).isEmpty(); 

        var includingDeleted = repository.findAllByTenantIdIncludingDeleted(tenantId).stream() 
            .filter(audioFile -> audioFile.getId().equals(entity.getId())) 
            .findFirst(); 
        assertThat(includingDeleted).isPresent(); 
        assertThat(includingDeleted.get().isDeleted()).isTrue(); 
        assertThat(includingDeleted.get().getDeletedAt()).isNotNull(); 
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
        AudioFileEntity entity = createTestAudioFile(tenantId); 
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
    @DisplayName("GIVEN soft deleted user file WHEN findByUserId THEN excludes deleted records")
    void testFindByUserIdExcludesSoftDeleted() { 
        // GIVEN
        String tenantId = "tenant-123";
        UUID userId = UUID.randomUUID(); 

        AudioFileEntity active = new AudioFileEntity( 
            UUID.randomUUID(), 
            tenantId,
            userId,
            "active.mp3",
            "/storage/active.mp3",
            "mp3"
        );
        AudioFileEntity deleted = new AudioFileEntity( 
            UUID.randomUUID(), 
            tenantId,
            userId,
            "deleted.mp3",
            "/storage/deleted.mp3",
            "mp3"
        );

        repository.save(tenantId, active); 
        repository.save(tenantId, deleted); 
        repository.softDelete(tenantId, deleted.getId()); 

        // WHEN
        var found = repository.findByUserId(tenantId, userId); 

        // THEN
        assertThat(found).hasSize(1); 
        assertThat(found.getFirst().getId()).isEqualTo(active.getId()); 
        assertThat(found.getFirst().isDeleted()).isFalse(); 
    }

    @Test
    @DisplayName("GIVEN saved entities WHEN countByTenantId THEN returns correct count")
    void testCountByTenantId() { 
        // GIVEN
        String tenantId = "tenant-123";
        repository.save(tenantId, createTestAudioFile(tenantId)); 
        repository.save(tenantId, createTestAudioFile(tenantId)); 

        // WHEN
        long count = repository.countByTenantId(tenantId); 

        // THEN
        assertThat(count).isEqualTo(2L); 
    }

    @Test
    @DisplayName("GIVEN soft deleted entity not counted WHEN countByTenantId")
    void testCountByTenantIdExcludesDeleted() { 
        // GIVEN
        String tenantId = "tenant-123";
        AudioFileEntity entity1 = createTestAudioFile(tenantId); 
        AudioFileEntity entity2 = createTestAudioFile(tenantId); 
        repository.save(tenantId, entity1); 
        repository.save(tenantId, entity2); 
        repository.softDelete(tenantId, entity1.getId()); 

        // WHEN
        long count = repository.countByTenantId(tenantId); 

        // THEN - count excludes soft deleted
        assertThat(count).isEqualTo(1L); 
    }

    // Helper methods

    private AudioFileEntity createTestAudioFile(String tenantId) { 
        return new AudioFileEntity( 
            UUID.randomUUID(), 
            tenantId,
            UUID.randomUUID(), 
            "test-audio-" + UUID.randomUUID() + ".mp3", 
            "/storage/test.mp3",
            "mp3"
        );
    }
}
