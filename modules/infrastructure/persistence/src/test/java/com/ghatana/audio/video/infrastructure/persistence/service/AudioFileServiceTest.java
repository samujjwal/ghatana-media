package com.ghatana.audio.video.infrastructure.persistence.service;

import com.ghatana.audio.video.infrastructure.persistence.entity.AudioFileEntity;
import com.ghatana.audio.video.infrastructure.persistence.repository.AudioFileRepository;
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
 * @doc.purpose Unit tests for AudioFileService (async service layer per AEP pattern) 
 * @doc.layer test
 * @doc.pattern Test
 */
@DisplayName("AudioFileService Tests")
@ExtendWith(MockitoExtension.class) 
class AudioFileServiceTest extends EventloopTestBase {

    @Mock
    private AudioFileRepository repository;

    private AudioFileService service;

    @BeforeEach
    void setUp() { 
        Eventloop eventloop = Eventloop.create(); 
        service = new AudioFileService(repository, eventloop, Executors.newSingleThreadExecutor()); 
    }

    @Test
    @DisplayName("GIVEN valid entity WHEN save THEN returns saved entity async")
    void testSave() { 
        // GIVEN
        String tenantId = "tenant-123";
        AudioFileEntity entity = createTestAudioFile(tenantId); 
        when(repository.save(eq(tenantId), any())).thenReturn(entity); 

        // WHEN
        AudioFileEntity result = runPromise(() -> service.save(tenantId, entity)); 

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
        AudioFileEntity entity = createTestAudioFile(tenantId); 
        when(repository.findById(tenantId, entity.getId())).thenReturn(Optional.of(entity)); 

        // WHEN
        Optional<AudioFileEntity> result = runPromise(() -> service.findById(tenantId, entity.getId())); 

        // THEN
        assertThat(result).isPresent(); 
        assertThat(result.get().getId()).isEqualTo(entity.getId()); 
    }

    @Test
    @DisplayName("GIVEN non-existent entity WHEN findById THEN returns empty async")
    void testFindByIdNotFound() { 
        // GIVEN
        String tenantId = "tenant-123";
        UUID id = UUID.randomUUID(); 
        when(repository.findById(tenantId, id)).thenReturn(Optional.empty()); 

        // WHEN
        Optional<AudioFileEntity> result = runPromise(() -> service.findById(tenantId, id)); 

        // THEN
        assertThat(result).isEmpty(); 
    }

    @Test
    @DisplayName("GIVEN multiple entities WHEN findByTenantId THEN returns list async")
    void testFindByTenantId() { 
        // GIVEN
        String tenantId = "tenant-123";
        AudioFileEntity entity1 = createTestAudioFile(tenantId); 
        AudioFileEntity entity2 = createTestAudioFile(tenantId); 
        when(repository.findByTenantId(tenantId)).thenReturn(List.of(entity1, entity2)); 

        // WHEN
        List<AudioFileEntity> result = runPromise(() -> service.findByTenantId(tenantId)); 

        // THEN
        assertThat(result).hasSize(2); 
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
    @DisplayName("GIVEN non-existent entity WHEN softDelete THEN returns false async")
    void testSoftDeleteNotFound() { 
        // GIVEN
        String tenantId = "tenant-123";
        UUID id = UUID.randomUUID(); 
        when(repository.softDelete(tenantId, id)).thenReturn(false); 

        // WHEN
        Boolean result = runPromise(() -> service.softDelete(tenantId, id)); 

        // THEN
        assertThat(result).isFalse(); 
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
    @DisplayName("GIVEN existing entity WHEN existsById THEN returns true async")
    void testExistsById() { 
        // GIVEN
        String tenantId = "tenant-123";
        UUID id = UUID.randomUUID(); 
        when(repository.existsById(tenantId, id)).thenReturn(true); 

        // WHEN
        Boolean result = runPromise(() -> service.existsById(tenantId, id)); 

        // THEN
        assertThat(result).isTrue(); 
    }

    @Test
    @DisplayName("GIVEN entities WHEN countByTenantId THEN returns count async")
    void testCountByTenantId() { 
        // GIVEN
        String tenantId = "tenant-123";
        when(repository.countByTenantId(tenantId)).thenReturn(5L); 

        // WHEN
        Long result = runPromise(() -> service.countByTenantId(tenantId)); 

        // THEN
        assertThat(result).isEqualTo(5L); 
    }

    // Helper methods

    private AudioFileEntity createTestAudioFile(String tenantId) { 
        return new AudioFileEntity( 
            UUID.randomUUID(), 
            tenantId,
            UUID.randomUUID(), 
            "test-audio.mp3",
            "/storage/test.mp3",
            "mp3"
        );
    }
}
