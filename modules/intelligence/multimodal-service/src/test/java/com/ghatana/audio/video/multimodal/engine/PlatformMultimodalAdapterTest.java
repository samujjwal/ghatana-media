package com.ghatana.audio.video.multimodal.engine;

import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.vision.api.VisionEngine;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.mock;

/**
 * @doc.type class
 * @doc.purpose Unit tests for PlatformMultimodalAdapter STT adapter routing
 * @doc.layer test
 * @doc.pattern Test
 */
@ExtendWith(MockitoExtension.class) 
@DisplayName("PlatformMultimodalAdapter")
class PlatformMultimodalAdapterTest {

    @Mock
    private AudioVideoLibrary library;

    @Mock
    private VideoFrameExtractor frameExtractor;

    @Mock
    private SttClientAdapter sttClientAdapter;

    @BeforeEach
    void providePublicVisionSpi() {
        when(library.getVisionEngine()).thenReturn(mock(VisionEngine.class));
    }

    @Test
    @DisplayName("transcribe delegates to STT adapter and returns adapter result")
    void transcribeDelegatesToSttAdapter() { 
        AudioResult expected = AudioResult.builder() 
            .transcription("hello via llm")
            .confidence(0.93) 
            .build(); 
        when(sttClientAdapter.transcribe(any())).thenReturn(expected); 

        PlatformMultimodalAdapter adapter = new PlatformMultimodalAdapter( 
            AudioVideoRuntimeSettings.defaults(), 
            library,
            frameExtractor,
            sttClientAdapter
        );

        AudioResult actual = adapter.transcribe(new byte[] {1, 2, 3}); 

        assertThat(actual.getTranscription()).isEqualTo("hello via llm");
        assertThat(actual.getConfidence()).isEqualTo(0.93); 
    }

    @Test
    @DisplayName("child STT error is preserved")
    void transcribePreservesChildProviderError() {
        AudioResult providerFailure = AudioResult.error("STT provider unavailable");
        when(sttClientAdapter.transcribe(any())).thenReturn(providerFailure);

        PlatformMultimodalAdapter adapter = new PlatformMultimodalAdapter(
                AudioVideoRuntimeSettings.defaults(), library, frameExtractor, sttClientAdapter);

        assertThat(adapter.transcribe(new byte[] {1, 2, 3})).isSameAs(providerFailure);
        assertThat(providerFailure.isError()).isTrue();
    }

    @Test
    @DisplayName("missing child result fails explicitly")
    void transcribeRejectsMissingChildResult() {
        when(sttClientAdapter.transcribe(any())).thenReturn(null);

        PlatformMultimodalAdapter adapter = new PlatformMultimodalAdapter(
                AudioVideoRuntimeSettings.defaults(), library, frameExtractor, sttClientAdapter);

        assertThatThrownBy(() -> adapter.transcribe(new byte[] {1, 2, 3}))
                .isInstanceOf(MultimodalException.class)
                .hasMessage("Platform STT processing failed")
                .hasRootCauseMessage("STT provider returned no result");
    }

    @Test
    @DisplayName("composition rejects a missing STT provider")
    void compositionRejectsMissingSttProvider() {
        assertThatThrownBy(() -> new PlatformMultimodalAdapter(
                AudioVideoRuntimeSettings.defaults(), library, frameExtractor, null))
                .isInstanceOf(NullPointerException.class)
                .hasMessage("sttClientAdapter");
    }
}
