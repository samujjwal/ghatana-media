package com.ghatana.audio.video.vision.datacloud;

import com.ghatana.audio.video.vision.VisionLogCapture;
import com.ghatana.audio.video.vision.service.PersistentVisionService;
import com.ghatana.testing.activej.EventloopTestBase;
import io.activej.promise.Promise;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class DataCloudVisionAdapterLogPrivacyTest extends EventloopTestBase {
    private static final String ARTIFACT_MARKER = "artifact-marker-vision-private";
    private static final String TENANT_MARKER = "tenant-marker-vision-private";
    private static final String FRAME_INDEX_MARKER = "frame-index-marker-private";
    private static final String ERROR_MARKER = "provider-path-marker-private";

    @Test
    void adapterLogsDoNotIncludeArtifactTenantFrameIndexOrProviderDetails() {
        PersistentVisionService service = mock(PersistentVisionService.class);
        when(service.analyze(anyString(), anyString(), anyString(), anyMap()))
                .thenReturn(Promise.of(FRAME_INDEX_MARKER),
                        Promise.ofException(new IllegalStateException(ERROR_MARKER)));
        DataCloudVisionAdapter adapter = new DataCloudVisionAdapter(service);

        try (VisionLogCapture logs = new VisionLogCapture(DataCloudVisionAdapter.class)) {
            runPromise(() -> adapter.transcribeAudio(ARTIFACT_MARKER, TENANT_MARKER, "en", Map.of()));
            runPromise(() -> adapter.indexMultimodal(ARTIFACT_MARKER, TENANT_MARKER, "video", Map.of()));
            assertThat(runPromise(() -> adapter.analyzeVision(
                    ARTIFACT_MARKER, TENANT_MARKER, "CUSTOM_ANALYSIS_" + TENANT_MARKER, Map.of())))
                    .isEqualTo(FRAME_INDEX_MARKER);
            assertThatThrownBy(() -> runPromise(() -> adapter.analyzeVision(
                    ARTIFACT_MARKER, TENANT_MARKER, "CUSTOM_ANALYSIS", Map.of())))
                    .isInstanceOf(RuntimeException.class);

            String output = String.join("\n", logs.messages());
            assertThat(output).contains("Transcription not supported", "Analyzing vision artifact",
                    "Vision analysis completed", "Vision analysis failed (IllegalStateException)",
                    "Multimodal indexing not supported");
            assertThat(output).doesNotContain(ARTIFACT_MARKER, TENANT_MARKER, FRAME_INDEX_MARKER, ERROR_MARKER);
            assertThat(logs.throwables()).isEmpty();
        }
    }
}
