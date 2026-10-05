package com.ghatana.audio.video.infrastructure.persistence.service;

import com.ghatana.audio.video.infrastructure.persistence.entity.TranscriptionEntity;
import com.ghatana.audio.video.infrastructure.persistence.repository.TranscriptionRepository;
import com.ghatana.testing.activej.EventloopTestBase;
import io.activej.eventloop.Eventloop;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.Executors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

/**
 * @doc.type class
 * @doc.purpose Unit tests for TranscriptionService (async service layer per AEP pattern) 
 * @doc.layer test
 * @doc.pattern Test
 */
@DisplayName("TranscriptionService Tests")
@ExtendWith(MockitoExtension.class) 
class TranscriptionServiceTest extends EventloopTestBase {

    @Mock
    private TranscriptionRepository repository;

    private TranscriptionService service;

    @BeforeEach
    void setUp() { 
        Eventloop eventloop = Eventloop.create(); 
        service = new TranscriptionService(repository, eventloop, Executors.newSingleThreadExecutor()); 
    }

    @Test
    @DisplayName("GIVEN valid entity WHEN save THEN returns saved entity async")
    void testSave() { 
        // GIVEN
        String tenantId = "tenant-123";
        TranscriptionEntity entity = createTestTranscription(tenantId); 
        when(repository.save(eq(tenantId), any())).thenReturn(entity); 

        // WHEN
        TranscriptionEntity result = runPromise(() -> service.save(tenantId, entity)); 

        // THEN
        assertThat(result).isNotNull(); 
        assertThat(result.getId()).isEqualTo(entity.getId()); 
        verify(repository).save(tenantId, entity); 
    }

    @Test
    @DisplayName("GIVEN existing entity WHEN findById THEN returns entity async")
    void testFindById() { 
        // GIVEN
        String tenantId = "tenant-123";
        TranscriptionEntity entity = createTestTranscription(tenantId); 
        when(repository.findById(tenantId, entity.getId())).thenReturn(Optional.of(entity)); 

        // WHEN
        Optional<TranscriptionEntity> result = runPromise(() -> service.findById(tenantId, entity.getId())); 

        // THEN
        assertThat(result).isPresent(); 
        assertThat(result.get().getId()).isEqualTo(entity.getId()); 
    }

    @Test
    @DisplayName("GIVEN existing transcription WHEN findByAudioFileId THEN returns entity async")
    void testFindByAudioFileId() { 
        // GIVEN
        String tenantId = "tenant-123";
        UUID audioFileId = UUID.randomUUID(); 
        TranscriptionEntity entity = createTestTranscription(tenantId); 
        entity.setAudioFileId(audioFileId); 
        when(repository.findByAudioFileId(tenantId, audioFileId)).thenReturn(Optional.of(entity)); 

        // WHEN
        Optional<TranscriptionEntity> result = runPromise(() -> service.findByAudioFileId(tenantId, audioFileId)); 

        // THEN
        assertThat(result).isPresent(); 
        assertThat(result.get().getAudioFileId()).isEqualTo(audioFileId); 
    }

    @Test
    @DisplayName("GIVEN multiple entities WHEN findByTenantId THEN returns list async")
    void testFindByTenantId() { 
        // GIVEN
        String tenantId = "tenant-123";
        TranscriptionEntity entity1 = createTestTranscription(tenantId); 
        TranscriptionEntity entity2 = createTestTranscription(tenantId); 
        when(repository.findByTenantId(tenantId)).thenReturn(List.of(entity1, entity2)); 

        // WHEN
        List<TranscriptionEntity> result = runPromise(() -> service.findByTenantId(tenantId)); 

        // THEN
        assertThat(result).hasSize(2); 
    }

    @Test
    @DisplayName("GIVEN entities with status WHEN findByStatus THEN returns filtered list async")
    void testFindByStatus() { 
        // GIVEN
        String tenantId = "tenant-123";
        TranscriptionEntity.TranscriptionStatus status = TranscriptionEntity.TranscriptionStatus.COMPLETED;
        TranscriptionEntity entity = createTestTranscription(tenantId); 
        entity.setStatus(status); 
        when(repository.findByStatus(tenantId, status)).thenReturn(List.of(entity)); 

        // WHEN
        List<TranscriptionEntity> result = runPromise(() -> service.findByStatus(tenantId, status)); 

        // THEN
        assertThat(result).hasSize(1); 
        assertThat(result.get(0).getStatus()).isEqualTo(status); 
    }

    @Test
    @DisplayName("GIVEN entity WHEN softDelete THEN returns true async")
    void testSoftDelete() { 
        // GIVEN
        String tenantId = "tenant-123";
        UUID id = UUID.randomUUID(); 
        when(repository.softDelete(tenantId, id)).thenReturn(true); 

        // WHEN
        Boolean result = runPromise(() -> service.softDelete(tenantId, id)); 

        // THEN
        assertThat(result).isTrue(); 
        verify(repository).softDelete(tenantId, id); 
    }

    @Test
    @DisplayName("GIVEN entity WHEN hardDelete THEN returns true async")
    void testHardDelete() { 
        // GIVEN
        String tenantId = "tenant-123";
        UUID id = UUID.randomUUID(); 
        when(repository.hardDelete(tenantId, id)).thenReturn(true); 

        // WHEN
        Boolean result = runPromise(() -> service.hardDelete(tenantId, id)); 

        // THEN
        assertThat(result).isTrue(); 
        verify(repository).hardDelete(tenantId, id); 
    }

    @Test
    @DisplayName("GIVEN existing transcription WHEN existsByAudioFileId THEN returns true async")
    void testExistsByAudioFileId() { 
        // GIVEN
        String tenantId = "tenant-123";
        UUID audioFileId = UUID.randomUUID(); 
        when(repository.existsByAudioFileId(tenantId, audioFileId)).thenReturn(true); 

        // WHEN
        Boolean result = runPromise(() -> service.existsByAudioFileId(tenantId, audioFileId)); 

        // THEN
        assertThat(result).isTrue(); 
    }

    @Test
    @DisplayName("GIVEN entities WHEN countByTenantId THEN returns count async")
    void testCountByTenantId() { 
        // GIVEN
        String tenantId = "tenant-123";
        when(repository.countByTenantId(tenantId)).thenReturn(3L); 

        // WHEN
        Long result = runPromise(() -> service.countByTenantId(tenantId)); 

        // THEN
        assertThat(result).isEqualTo(3L); 
    }

    // Helper methods

    private TranscriptionEntity createTestTranscription(String tenantId) { 
        return new TranscriptionEntity( 
            UUID.randomUUID(), 
            tenantId,
            UUID.randomUUID(), 
            UUID.randomUUID(), 
            "Hello world transcription",
            "en"
        );
    }
}
