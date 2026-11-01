package com.ghatana.stt.datacloud;

import com.ghatana.stt.service.PersistentSttService;
import com.ghatana.stt.testutil.LogCapture;
import io.activej.promise.Promise;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

@Tag("datacloud-event-bridge")
class DataCloudSttAdapterLogPrivacyTest {
    @Test
    void unavailableCallDoesNotLogOrDispatchArtifactTenantOrTranscriptIds() {
        String artifactId = "artifact-secret-marker";
        String tenantId = "tenant-secret-marker";
        String transcriptId = "transcript-secret-marker";
        PersistentSttService service = mock(PersistentSttService.class);
        when(service.transcribe(artifactId, tenantId, "en-US", Map.of()))
                .thenReturn(Promise.of(transcriptId));

        try (LogCapture logs = LogCapture.capture(DataCloudSttAdapter.class)) {
            new DataCloudSttAdapter(service).transcribeAudio(artifactId, tenantId, "en-US", Map.of());

            assertThat(logs.output()).doesNotContain(artifactId, tenantId, transcriptId);
            verifyNoInteractions(service);
        }
    }

    @Test
    void failureLogsOmitArtifactTenantAndExceptionDetails() {
        String artifactId = "artifact-secret-marker";
        String tenantId = "tenant-secret-marker";
        String exceptionDetail = "private-transcript-and-provider-detail";
        PersistentSttService service = mock(PersistentSttService.class);
        when(service.transcribe(artifactId, tenantId, "en-US", Map.of()))
                .thenReturn(Promise.ofException(new IllegalStateException(exceptionDetail)));

        try (LogCapture logs = LogCapture.capture(DataCloudSttAdapter.class)) {
            new DataCloudSttAdapter(service).transcribeAudio(artifactId, tenantId, "en-US", Map.of());

            assertThat(logs.output()).doesNotContain(artifactId, tenantId, exceptionDetail);
            verifyNoInteractions(service);
        }
    }
}
