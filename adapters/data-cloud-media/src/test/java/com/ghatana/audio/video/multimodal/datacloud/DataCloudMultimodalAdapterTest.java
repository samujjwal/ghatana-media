package com.ghatana.audio.video.multimodal.datacloud;

import com.ghatana.audio.video.multimodal.service.PersistentMultimodalService;
import com.ghatana.testing.activej.EventloopTestBase;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowable;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

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
    void artifactIndexingFailsClosedBeforeCallingTheBackingService() {
        PersistentMultimodalService service = mock(PersistentMultimodalService.class);
        DataCloudMultimodalAdapter adapter = new DataCloudMultimodalAdapter(service);

        assertThat(adapter.isAvailable("MULTIMODAL")).isFalse();
        assertThat(adapter.getSupportedIndexTypes()).isEmpty();
        Throwable failure = catchThrowable(() -> runPromise(() -> adapter.indexMultimodal(
                "artifact", "tenant", "SCENE_UNDERSTANDING", Map.of())));
        assertThat(failure)
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("Data Cloud multimodal integration is unavailable")
                .hasNoCause();
        verifyNoInteractions(service);
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
