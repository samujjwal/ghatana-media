package com.ghatana.audio.video.multimodal.datacloud;

import com.ghatana.audio.video.multimodal.service.PersistentMultimodalService;
import com.ghatana.testing.activej.EventloopTestBase;
import io.activej.promise.Promise;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowable;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class DataCloudMultimodalAdapterTest extends EventloopTestBase {
    @Test
    void unsupportedStandaloneCallsFailWithoutCallingBackingService() {
        PersistentMultimodalService service = mock(PersistentMultimodalService.class);
        DataCloudMultimodalAdapter adapter = new DataCloudMultimodalAdapter(service);

        assertThatThrownBy(() -> runPromise(() -> adapter.transcribeAudio(
                "artifact-secret", "tenant-secret", "en", Map.of())))
                .isInstanceOf(UnsupportedOperationException.class)
                .hasMessage("Standalone transcription is unavailable through the multimodal adapter");
        assertThatThrownBy(() -> runPromise(() -> adapter.analyzeVision(
                "artifact-secret", "tenant-secret", "SCENE", Map.of())))
                .isInstanceOf(UnsupportedOperationException.class)
                .hasMessage("Standalone vision analysis is unavailable through the multimodal adapter");
        verifyNoInteractions(service);
    }

    @Test
    void absentServiceIsUnavailableAndIndexingFailsAsPromise() {
        DataCloudMultimodalAdapter adapter = new DataCloudMultimodalAdapter(null);

        assertThat(adapter.isAvailable("MULTIMODAL")).isFalse();
        assertThat(adapter.getSupportedIndexTypes()).isEmpty();
        assertThatThrownBy(() -> runPromise(() -> adapter.indexMultimodal(
                "artifact", "tenant", "SCENE_UNDERSTANDING", Map.of())))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("Data Cloud multimodal integration is unavailable");
    }

    @Test
    void backingServiceFailureRemainsUnavailableAndIsNotReportedAsAnIndex() {
        PersistentMultimodalService service = mock(PersistentMultimodalService.class);
        String tenantId = "tenant-private-42";
        String sourceText = "confidential dock transcript";
        when(service.index("artifact", "tenant", "SCENE_UNDERSTANDING", Map.of()))
                .thenReturn(Promise.ofException(new IllegalStateException(
                        "index failed tenant=" + tenantId + " source=" + sourceText)));
        PersistentMultimodalService.MultimodalResult localResult = new PersistentMultimodalService.MultimodalResult(
                UUID.randomUUID(), sourceText, 0.97f, null, 12,
                PersistentMultimodalService.Outcome.COMPLETE,
                PersistentMultimodalService.ModalityStatus.SUCCEEDED,
                PersistentMultimodalService.ModalityStatus.NOT_REQUESTED);
        byte[] localAudio = {1};
        UUID localUserId = new UUID(0, 7);
        when(service.processAndPersist(tenantId, localUserId, localAudio, null, "local.wav"))
                .thenReturn(Promise.of(localResult));
        DataCloudMultimodalAdapter adapter = new DataCloudMultimodalAdapter(service);

        assertThat(adapter.isAvailable("MULTIMODAL")).isFalse();
        assertThat(adapter.getSupportedIndexTypes()).isEmpty();
        Throwable failure = catchThrowable(() -> runPromise(() -> adapter.indexMultimodal(
                "artifact", "tenant", "SCENE_UNDERSTANDING", Map.of())));
        assertThat(failure)
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("Data Cloud multimodal integration is unavailable")
                .hasNoCause();
        assertThat(failure.toString()).doesNotContain(tenantId, sourceText);
        assertThat(runPromise(() -> service.processAndPersist(
                tenantId, localUserId, localAudio, null, "local.wav")))
                .isSameAs(localResult);
        verify(service).index("artifact", "tenant", "SCENE_UNDERSTANDING", Map.of());
        verify(service).processAndPersist(tenantId, localUserId, localAudio, null, "local.wav");
    }

    @Test
    void missingArtifactScopeIsRejectedBeforeCallingIntegration() {
        PersistentMultimodalService service = mock(PersistentMultimodalService.class);
        DataCloudMultimodalAdapter adapter = new DataCloudMultimodalAdapter(service);

        assertThatThrownBy(() -> runPromise(() -> adapter.indexMultimodal(
                " ", "tenant", "SCENE_UNDERSTANDING", Map.of())))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Artifact, tenant, and index type are required for multimodal indexing");
        assertThat(adapter.isAvailable("TRANSCRIPTION")).isFalse();
    }
}
