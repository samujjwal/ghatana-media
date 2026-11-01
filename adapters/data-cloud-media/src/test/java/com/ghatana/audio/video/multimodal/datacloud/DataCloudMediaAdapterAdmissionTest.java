package com.ghatana.audio.video.multimodal.datacloud;

import com.ghatana.audio.video.vision.datacloud.DataCloudVisionAdapter;
import com.ghatana.audio.video.vision.service.PersistentVisionService;
import com.ghatana.datacloud.memory.media.MediaProcessorPort;
import com.ghatana.stt.datacloud.DataCloudSttAdapter;
import com.ghatana.stt.service.PersistentSttService;
import com.ghatana.testing.activej.EventloopTestBase;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

/** The Data Cloud SPI has no source-version, principal, or live disclosure context. */
class DataCloudMediaAdapterAdmissionTest extends EventloopTestBase {
    @Test
    void sttDoesNotAdvertiseUnboundArtifactTranscriptionOrUnqualifiedLocales() {
        MediaProcessorPort adapter = new DataCloudSttAdapter(mock(PersistentSttService.class));

        assertThat(adapter.isAvailable("TRANSCRIPTION")).isFalse();
        assertThat(adapter.isAvailable("transcription")).isFalse();
        assertThat(adapter.getSupportedLanguages()).isEmpty();
    }

    @Test
    void visionDoesNotAdvertiseUnboundFramesBiometricsOrMediaOwnedOcr() {
        MediaProcessorPort adapter = new DataCloudVisionAdapter(mock(PersistentVisionService.class));

        assertThat(adapter.isAvailable("VISION")).isFalse();
        assertThat(adapter.getSupportedAnalysisTypes()).isEmpty();
        assertThat(adapter.getSupportedLanguages()).isEmpty();
        assertThat(adapter.getSupportedIndexTypes()).isEmpty();
    }

    @Test
    void directSttCallReturnsBoundedNotAdmittedBeforeCallingTheService() {
        PersistentSttService service = mock(PersistentSttService.class);
        DataCloudSttAdapter adapter = new DataCloudSttAdapter(service);

        assertThatThrownBy(() -> runPromise(() -> adapter.transcribeAudio(
                "artifact-private", "tenant-private", "en-US", java.util.Map.of("token", "private"))))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("STT_SOURCE_AUTHORITY_NOT_ADMITTED: source, principal, purpose, and disclosure bindings are required");
        verifyNoInteractions(service);
    }

    @Test
    void directVisionCallReturnsBoundedNotAdmittedBeforeCallingTheService() {
        PersistentVisionService service = mock(PersistentVisionService.class);
        DataCloudVisionAdapter adapter = new DataCloudVisionAdapter(service);

        assertThatThrownBy(() -> runPromise(() -> adapter.analyzeVision(
                "artifact-private", "tenant-private", "OCR", java.util.Map.of("secret", "private"))))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("VISION_SOURCE_AUTHORITY_NOT_ADMITTED: source version, timebase, principal, and disclosure bindings are required");
        verifyNoInteractions(service);
    }
}
