package com.ghatana.audio.video.multimodal.service;

import com.ghatana.audit.AuditEvent;
import com.ghatana.audit.AuditService;
import com.ghatana.audio.video.infrastructure.persistence.entity.AudioFileEntity;
import com.ghatana.audio.video.infrastructure.persistence.entity.TranscriptionEntity;
import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.audio.video.infrastructure.persistence.service.TranscriptionService;
import com.ghatana.testing.activej.EventloopTestBase;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.stt.api.SttEngine;
import com.ghatana.media.vision.api.VisionEngine;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

class PersistentMultimodalServiceMetricPrivacyTest extends EventloopTestBase {

    @Test
    void legacyAggregateEntryPointRejectsBeforePersistenceProvidersAuditOrMetrics() {
        AudioFileService audioFileService = mock(AudioFileService.class);
        TranscriptionService transcriptionService = mock(TranscriptionService.class);
        AuditService auditService = mock(AuditService.class);
        SttEngine sttEngine = mock(SttEngine.class);
        VisionEngine visionEngine = mock(VisionEngine.class);
        SimpleMeterRegistry meterRegistry = new SimpleMeterRegistry();
        PersistentMultimodalService service = new PersistentMultimodalService(
                audioFileService, transcriptionService, sttEngine, visionEngine, meterRegistry, auditService);

        assertThatThrownBy(() -> runPromise(() -> service.processAndPersist(
                "tenant-marker", UUID.randomUUID(), new byte[] {1, 2}, new byte[] {3, 4}, "private.wav")))
                .hasMessage("MULTIMODAL_FAMILY_NOT_ADMITTED: submit one canonical capability operation");

        verify(audioFileService, never()).save(anyString(), any(AudioFileEntity.class));
        verify(transcriptionService, never()).save(anyString(), any(TranscriptionEntity.class));
        verify(sttEngine, never()).transcribe(any(AudioData.class));
        verify(visionEngine, never()).detectAsync(any(), any());
        verify(auditService, never()).record(any(AuditEvent.class));
        assertThat(meterRegistry.find("multimodal.persistent.fuse").timer().count()).isZero();
        assertThat(meterRegistry.find("multimodal.fuse.duration").timer().count()).isZero();
    }

    @Test
    void callerSuppliedConsentStatusCannotAuthorizeDataCloudDispatchOrPersistence() {
        AudioFileService audioFileService = mock(AudioFileService.class);
        TranscriptionService transcriptionService = mock(TranscriptionService.class);
        SttEngine sttEngine = mock(SttEngine.class);
        VisionEngine visionEngine = mock(VisionEngine.class);
        AuditService auditService = mock(AuditService.class);
        SimpleMeterRegistry meterRegistry = new SimpleMeterRegistry();
        PersistentMultimodalService service = new PersistentMultimodalService(
                audioFileService, transcriptionService, sttEngine, visionEngine, meterRegistry, auditService);

        for (String callerSuppliedStatus : java.util.List.of("GRANTED", "AUTO_APPROVED")) {
            assertThatThrownBy(() -> runPromise(() -> service.processDataCloudJob(
                    "tenant", UUID.randomUUID(), "correlation", "request", callerSuppliedStatus,
                    "30-days", new byte[] {1}, new byte[] {2})))
                    .hasMessageStartingWith("DATACLOUD_MULTIMODAL_NOT_ADMITTED:");
        }

        verify(audioFileService, never()).save(anyString(), any(AudioFileEntity.class));
        verify(transcriptionService, never()).save(anyString(), any(TranscriptionEntity.class));
        verify(sttEngine, never()).transcribe(any(AudioData.class));
        verify(visionEngine, never()).detectAsync(any(), any());
        verify(auditService, never()).record(any(AuditEvent.class));
        assertThat(meterRegistry.find("multimodal.fuse.duration").timer().count()).isZero();
    }

    @Test
    void legacyTranscriptSearchFailsClosedWithoutPrincipalScopedReadAuthority() {
        TranscriptionService transcriptionService = mock(TranscriptionService.class);
        PersistentMultimodalService service = new PersistentMultimodalService(
                mock(AudioFileService.class), transcriptionService, new SimpleMeterRegistry());

        assertThatThrownBy(() -> runPromise(() -> service.search("tenant-marker", "private-marker")))
                .hasMessage("MULTIMODAL_SEARCH_NOT_ADMITTED: principal-scoped transcript read authority is unavailable");

        verify(transcriptionService, never()).findByTenantId(anyString());
    }
}
