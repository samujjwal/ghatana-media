package com.ghatana.stt.datacloud;

import com.ghatana.stt.service.PersistentSttService;
import com.ghatana.stt.testutil.LogCapture;
import io.activej.promise.Promise;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

@Tag("datacloud-event-bridge")
class DataCloudSttAdapterLogPrivacyTest {
    @Test
    void successLogsOmitArtifactTenantAndTranscriptIds() {
        String artifactId = "artifact-secret-marker";
        String tenantId = "tenant-secret-marker";
        String transcriptId = "transcript-secret-marker";
        PersistentSttService service = mock(PersistentSttService.class);
        when(service.transcribe(artifactId, tenantId, "en-US", Map.of()))
                .thenReturn(Promise.of(transcriptId));

        try (LogCapture logs = LogCapture.capture(DataCloudSttAdapter.class)) {
            String returned = new DataCloudSttAdapter(service)
                    .transcribeAudio(artifactId, tenantId, "en-US", Map.of()).getResult();

            assertThat(returned).isEqualTo(transcriptId);
            assertThat(logs.output()).contains("Transcribing audio", "Transcription completed")
                    .doesNotContain(artifactId, tenantId, transcriptId);
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

            assertThat(logs.output()).contains("failureType=IllegalStateException")
                    .doesNotContain(artifactId, tenantId, exceptionDetail);
        }
    }
}
