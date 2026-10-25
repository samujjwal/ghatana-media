package com.ghatana.audio.video.multimodal.service;

import com.ghatana.audio.video.infrastructure.persistence.entity.AudioFileEntity;
import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.audio.video.infrastructure.persistence.service.TranscriptionService;
import com.ghatana.testing.activej.EventloopTestBase;
import io.activej.promise.Promise;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class PersistentMultimodalServiceMetricPrivacyTest extends EventloopTestBase {

    @Test
    void dataCloudJobDoesNotExportTenantCorrelationOrRequestIdsAsMetricTags() {
        AudioFileService audioFileService = mock(AudioFileService.class);
        TranscriptionService transcriptionService = mock(TranscriptionService.class);
        SimpleMeterRegistry meterRegistry = new SimpleMeterRegistry();
        when(audioFileService.save(anyString(), any(AudioFileEntity.class)))
                .thenAnswer(invocation -> Promise.of(invocation.getArgument(1)));
        PersistentMultimodalService service = new PersistentMultimodalService(
                audioFileService, transcriptionService, null, null, meterRegistry);
        String tenantMarker = "tenant-marker-private";
        String correlationMarker = "correlation-marker-private";
        String requestMarker = "request-marker-private";

        runPromise(() -> service.processDataCloudJob(tenantMarker, UUID.randomUUID(),
                correlationMarker, requestMarker, "GRANTED", "30-days", null, null));

        var timer = meterRegistry.find("multimodal.fuse.duration").timer();
        assertThat(timer).isNotNull();
        assertThat(timer.getId().getTags()).isEmpty();
        assertThat(timer.getId().getTags().toString())
                .doesNotContain(tenantMarker, correlationMarker, requestMarker);
    }
}
