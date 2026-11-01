package com.ghatana.audio.video.vision.datacloud;

import com.ghatana.audio.video.vision.VisionLogCapture;
import com.ghatana.audio.video.vision.service.PersistentVisionService;
import com.ghatana.testing.activej.EventloopTestBase;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

@Tag("datacloud-job-handling")
class DataCloudVisionAdapterLogPrivacyTest extends EventloopTestBase {
    private static final String ARTIFACT_MARKER = "artifact-marker-vision-private";
    private static final String TENANT_MARKER = "tenant-marker-vision-private";
    private static final String FRAME_INDEX_MARKER = "frame-index-marker-private";
    private static final String ERROR_MARKER = "provider-path-marker-private";

    @Test
    void unavailableVisionCallDoesNotLogOrDispatchArtifactTenantFrameIndexOrProviderDetails() {
        PersistentVisionService service = mock(PersistentVisionService.class);
        DataCloudVisionAdapter adapter = new DataCloudVisionAdapter(service);

        try (VisionLogCapture logs = new VisionLogCapture(DataCloudVisionAdapter.class)) {
            runPromise(() -> adapter.transcribeAudio(ARTIFACT_MARKER, TENANT_MARKER, "en", Map.of()));
            runPromise(() -> adapter.indexMultimodal(ARTIFACT_MARKER, TENANT_MARKER, "video", Map.of()));
            assertThatThrownBy(() -> runPromise(() -> adapter.analyzeVision(
                    ARTIFACT_MARKER, TENANT_MARKER, "CUSTOM_ANALYSIS_" + TENANT_MARKER, Map.of())))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessage("VISION_SOURCE_AUTHORITY_NOT_ADMITTED: source version, timebase, principal, and disclosure bindings are required");

            String output = String.join("\n", logs.messages());
            assertThat(output).contains("Transcription not supported", "Multimodal indexing not supported")
                    .doesNotContain("Analyzing vision artifact", "Vision analysis completed",
                            "Vision analysis failed");
            assertThat(output).doesNotContain(ARTIFACT_MARKER, TENANT_MARKER, FRAME_INDEX_MARKER, ERROR_MARKER);
            assertThat(logs.throwables()).isEmpty();
            verifyNoInteractions(service);
        }
    }
}
