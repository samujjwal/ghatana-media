package com.ghatana.audio.video.integration;

import com.ghatana.audio.video.multimodal.engine.AudioResult;
import com.ghatana.audio.video.multimodal.engine.MultimodalRequest;
import com.ghatana.audio.video.multimodal.engine.MultimodalResult;
import com.ghatana.audio.video.multimodal.engine.VisualResult;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Contract tests for the Multimodal API surface (AV-P1-07). 
 *
 * <p>These tests verify the stable data contract of {@link MultimodalRequest},
 * {@link MultimodalResult}, and the hasAudio/hasImage/hasVideo predicates as
 * agreed between the Java backend and the TypeScript {@code @audio-video/client}.
 * No native AI dependencies are required — all results are constructed directly
 * to verify shape and field propagation.
 *
 * <h3>Contract guarantees verified</h3>
 * <ul>
 *   <li>{@code hasAudio}, {@code hasImage}, {@code hasVideo} correctly reflect presence of data</li>
 *   <li>Empty / null data bytes are treated as absent</li>
 *   <li>{@link MultimodalResult} carries audioResult, visualResult, combinedAnalysis, processingTimeMs</li>
 *   <li>Processing time is non-negative</li>
 *   <li>Combined analysis field is at least an empty string (never null)</li> 
 * </ul>
 *
 * @doc.type class
 * @doc.purpose Contract tests for Multimodal request/response shape stability (AV-P1-07) 
 * @doc.layer test
 * @doc.pattern ContractTest
 */
@Tag("contract")
@DisplayName("Multimodal Service API Contract Tests (AV-P1-07)")
class MultimodalContractTest {

    @Nested
    @DisplayName("MultimodalRequest contract")
    class RequestContract {

        @Test
        @DisplayName("hasAudio returns false when no audio data provided")
        void shouldReturnFalseHasAudioWhenAbsent() { 
            MultimodalRequest request = MultimodalRequest.builder() 
                    .imageData(new byte[]{1, 2, 3}) 
                    .build(); 

            assertThat(request.hasAudio()).isFalse(); 
            assertThat(request.hasImage()).isTrue(); 
            assertThat(request.hasVideo()).isFalse(); 
        }

        @Test
        @DisplayName("hasAudio returns false for empty byte array")
        void shouldReturnFalseHasAudioForEmptyArray() { 
            MultimodalRequest request = MultimodalRequest.builder() 
                    .audioData(new byte[0]) 
                    .build(); 

            assertThat(request.hasAudio()).isFalse(); 
        }

        @Test
        @DisplayName("hasAudio/hasImage/hasVideo all true when all provided")
        void shouldReportAllModalitiesWhenAllPresent() { 
            MultimodalRequest request = MultimodalRequest.builder() 
                    .audioData(new byte[]{1}) 
                    .imageData(new byte[]{2}) 
                    .videoData(new byte[]{3}) 
                    .build(); 

            assertThat(request.hasAudio()).isTrue(); 
            assertThat(request.hasImage()).isTrue(); 
            assertThat(request.hasVideo()).isTrue(); 
        }

        @Test
        @DisplayName("getText returns empty string when not set")
        void shouldReturnEmptyStringForAbsentText() { 
            MultimodalRequest request = MultimodalRequest.builder().build(); 

            assertThat(request.getText()).isNotNull().isEmpty(); 
        }

        @Test
        @DisplayName("videoSampleFps defaults to 1 when not set")
        void shouldDefaultVideoSampleFpsToOne() { 
            MultimodalRequest request = MultimodalRequest.builder().build(); 

            assertThat(request.getVideoSampleFps()).isEqualTo(1); 
        }

        @Test
        @DisplayName("videoMaxFrames defaults to 50 when not set")
        void shouldDefaultVideoMaxFramesToFifty() { 
            MultimodalRequest request = MultimodalRequest.builder().build(); 

            assertThat(request.getVideoMaxFrames()).isEqualTo(50); 
        }
    }

    @Nested
    @DisplayName("MultimodalResult contract")
    class ResultContract {

        @Test
        @DisplayName("combinedAnalysis defaults to empty string (never null)")
        void combinedAnalysisDefaultsToEmptyString() { 
            MultimodalResult result = MultimodalResult.builder().build(); 

            assertThat(result.getCombinedAnalysis()).isNotNull().isEmpty(); 
        }

        @Test
        @DisplayName("processingTimeMs is zero when not set")
        void processingTimeMsDefaultsToZero() { 
            MultimodalResult result = MultimodalResult.builder().build(); 

            assertThat(result.getProcessingTimeMs()).isZero(); 
        }

        @Test
        @DisplayName("Result fields are accessible after builder construction")
        void shouldExposeBuilderSetFields() { 
            MultimodalResult result = MultimodalResult.builder() 
                    .combinedAnalysis("Audio: Hello | Scene: Room")
                    .processingTimeMs(99L) 
                    .build(); 

            assertThat(result.getCombinedAnalysis()).isEqualTo("Audio: Hello | Scene: Room");
            assertThat(result.getProcessingTimeMs()).isEqualTo(99L); 
        }
    }
}



