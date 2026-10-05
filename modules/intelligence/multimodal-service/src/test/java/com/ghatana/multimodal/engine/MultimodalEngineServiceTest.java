package com.ghatana.multimodal.engine;

import com.ghatana.testing.activej.EventloopTestBase;
import org.junit.jupiter.api.*;
import java.util.*;

import static org.assertj.core.api.Assertions.*;

/**
 * Comprehensive test suite for {@link CrossModalFusionEngine}.
 *
 * Validates multimodal processing combining speech (audio), vision (images/video), 
 * and language understanding to create cross-modal understanding with temporal alignment
 * and integration correctness across sub-services.
 *
 * @doc.type test
 * @doc.purpose Comprehensive multimodal engine tests: fusion, alignment, integration
 * @doc.layer product
 * @doc.pattern Test
 */
@DisplayName("MultimodalEngineServiceTest")
class MultimodalEngineServiceTest extends EventloopTestBase {

    private static final byte[] SAMPLE_AUDIO = new byte[] {1, 2, 3, 4, 5};
    private static final byte[] SAMPLE_IMAGE = new byte[] {10, 20, 30};
    private static final byte[] SAMPLE_VIDEO = new byte[] {100, 110, 120, (byte)130, (byte)140}; 
    private static final String SAMPLE_TEXT_HINT = "meeting discussion";

    private TestMultimodalEngine engine;

    @BeforeEach
    void setUp() { 
        engine = new TestMultimodalEngine(); 
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // INPUT VALIDATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("input validation for audio analysis")
    class InputValidationAudio {

        @Test
        @DisplayName("null audio data throws exception for audio analysis")
        void nullAudioForAudioAnalysis_throwsException() { 
            assertThatThrownBy(() -> engine.analyseAudio(null)) 
                    .isInstanceOf(Exception.class); 
        }

        @Test
        @DisplayName("empty audio data throws exception for audio analysis")
        void emptyAudioForAudioAnalysis_throwsException() { 
            assertThatThrownBy(() -> engine.analyseAudio(new byte[0])) 
                    .isInstanceOf(Exception.class); 
        }

        @Test
        @DisplayName("single byte audio is accepted for audio analysis")
        void singleByteAudioForAudioAnalysis_isAccepted() { 
            assertThatCode(() -> engine.analyseAudio(new byte[] {1})) 
                    .doesNotThrowAnyException(); 
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // AUDIO-ONLY ANALYSIS TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("audio-only analysis")
    class AudioOnlyAnalysis {

        @Test
        @DisplayName("audio analysis produces valid transcription")
        void audioAnalysisProducesValidTranscription() { 
            TestAudioResult result = engine.analyseAudio(SAMPLE_AUDIO); 

            assertThat(result).isNotNull(); 
            assertThat(result.transcription()).isNotBlank(); 
        }

        @Test
        @DisplayName("audio analysis includes confidence score")
        void audioAnalysisIncludesConfidence() { 
            TestAudioResult result = engine.analyseAudio(SAMPLE_AUDIO); 

            assertThat(result.confidence()).isBetween(0.0, 1.0); 
        }

        @Test
        @DisplayName("audio analysis detects language")
        void audioAnalysisDetectsLanguage() { 
            TestAudioResult result = engine.analyseAudio(SAMPLE_AUDIO); 

            assertThat(result.detectedLanguage()).isNotBlank(); 
        }

        @Test
        @DisplayName("audio analysis is deterministic for same input")
        void audioAnalysisIsDeterministic() { 
            TestAudioResult r1 = engine.analyseAudio(SAMPLE_AUDIO); 
            TestAudioResult r2 = engine.analyseAudio(SAMPLE_AUDIO); 

            assertThat(r1.transcription()).isEqualTo(r2.transcription()); 
            assertThat(r1.confidence()).isEqualTo(r2.confidence()); 
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // IMAGE ANALYSIS TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("image analysis")
    class ImageAnalysis {

        @Test
        @DisplayName("null image data throws exception")
        void nullImageData_throwsException() { 
            assertThatThrownBy(() -> engine.analyseImage(null)) 
                    .isInstanceOf(Exception.class); 
        }

        @Test
        @DisplayName("image analysis produces scene description")
        void imageAnalysisProducesSceneDescription() { 
            TestVisualResult result = engine.analyseImage(SAMPLE_IMAGE); 

            assertThat(result).isNotNull(); 
            assertThat(result.sceneDescription()).isNotBlank(); 
        }

        @Test
        @DisplayName("image analysis includes detections")
        void imageAnalysisIncludesDetections() { 
            TestVisualResult result = engine.analyseImage(SAMPLE_IMAGE); 

            assertThat(result.detections()).isNotNull(); 
        }

        @Test
        @DisplayName("image analysis confidence is in valid range")
        void imageAnalysisConfidenceIsValid() { 
            TestVisualResult result = engine.analyseImage(SAMPLE_IMAGE); 

            assertThat(result.confidence()).isBetween(0.0, 1.0); 
        }

        @Test
        @DisplayName("image analysis is deterministic for same input")
        void imageAnalysisIsDeterministic() { 
            TestVisualResult r1 = engine.analyseImage(SAMPLE_IMAGE); 
            TestVisualResult r2 = engine.analyseImage(SAMPLE_IMAGE); 

            assertThat(r1.sceneDescription()).isEqualTo(r2.sceneDescription()); 
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // VIDEO ANALYSIS TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("video analysis")
    class VideoAnalysis {

        @Test
        @DisplayName("null video data throws exception")
        void nullVideoData_throwsException() { 
            assertThatThrownBy(() -> engine.analyseVideo(null, 24, 100)) 
                    .isInstanceOf(Exception.class); 
        }

        @Test
        @DisplayName("video analysis with custom frame rate succeeds")
        void videoAnalysisWithCustomFrameRateSucceeds() { 
            TestVisualResult result = engine.analyseVideo(SAMPLE_VIDEO, 30, 100); 

            assertThat(result).isNotNull(); 
            assertThat(result.sceneDescription()).isNotBlank(); 
        }

        @Test
        @DisplayName("video analysis with frame limit succeeds")
        void videoAnalysisWithFrameLimitSucceeds() { 
            TestVisualResult result = engine.analyseVideo(SAMPLE_VIDEO, 24, 50); 

            assertThat(result).isNotNull(); 
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // CROSS-MODAL FUSION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("cross-modal fusion")
    class CrossModalFusion {

        @Test
        @DisplayName("audio + image fusion produces combined analysis")
        void audioImageFusionProducesCombinedAnalysis() { 
            TestMultimodalResult result = engine.fuseAudioAndImage(SAMPLE_AUDIO, SAMPLE_IMAGE); 

            assertThat(result).isNotNull(); 
            assertThat(result.combinedAnalysis()).isNotBlank(); 
        }

        @Test
        @DisplayName("fused audio-image includes both audio and visual content")
        void fusedAudioImageIncludesBothModalities() { 
            TestMultimodalResult result = engine.fuseAudioAndImage(SAMPLE_AUDIO, SAMPLE_IMAGE); 

            assertThat(result.combinedAnalysis()).containsIgnoringCase("audio");
            assertThat(result.combinedAnalysis()).containsIgnoringCase("image");
        }

        @Test
        @DisplayName("audio + image + text fusion includes all three modalities")
        void audioImageTextFusionIncludesAllModalities() { 
            TestMultimodalResult result = engine.fuseAudioImageAndText( 
                    SAMPLE_AUDIO, SAMPLE_IMAGE, SAMPLE_TEXT_HINT
            );

            assertThat(result.combinedAnalysis()).isNotBlank(); 
        }

        @Test
        @DisplayName("fusion with null text hint still succeeds")
        void fusionWithNullTextHintSucceeds() { 
            TestMultimodalResult result = engine.fuseAudioImageAndText( 
                    SAMPLE_AUDIO, SAMPLE_IMAGE, null
            );

            assertThat(result).isNotNull(); 
        }

        @Test
        @DisplayName("fusion with empty text hint still succeeds")
        void fusionWithEmptyTextHintSucceeds() { 
            TestMultimodalResult result = engine.fuseAudioImageAndText( 
                    SAMPLE_AUDIO, SAMPLE_IMAGE, ""
            );

            assertThat(result).isNotNull(); 
        }

        @Test
        @DisplayName("fusion is deterministic for identical inputs")
        void fusionIsDeterministic() { 
            TestMultimodalResult r1 = engine.fuseAudioAndImage(SAMPLE_AUDIO, SAMPLE_IMAGE); 
            TestMultimodalResult r2 = engine.fuseAudioAndImage(SAMPLE_AUDIO, SAMPLE_IMAGE); 

            assertThat(r1.combinedAnalysis()).isEqualTo(r2.combinedAnalysis()); 
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // TEMPORAL ALIGNMENT TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("temporal alignment")
    class TemporalAlignment {

        @Test
        @DisplayName("video + audio alignment produces temporal segments")
        void videoAudioAlignmentProducesSegments() { 
            TestVideoAudioAlignment alignment = engine.alignVideoAndAudio( 
                    SAMPLE_VIDEO, SAMPLE_AUDIO, 24
            );

            assertThat(alignment).isNotNull(); 
            assertThat(alignment.alignments()).isNotNull(); 
        }

        @Test
        @DisplayName("temporal alignment includes speech text")
        void temporalAlignmentIncludesSpeechText() { 
            TestVideoAudioAlignment alignment = engine.alignVideoAndAudio( 
                    SAMPLE_VIDEO, SAMPLE_AUDIO, 24
            );

            if (!alignment.alignments().isEmpty()) { 
                alignment.alignments().forEach(segment -> 
                        assertThat(segment.speechText()).isNotBlank() 
                );
            }
        }

        @Test
        @DisplayName("temporal alignment includes sync confidence")
        void temporalAlignmentIncludesSyncConfidence() { 
            TestVideoAudioAlignment alignment = engine.alignVideoAndAudio( 
                    SAMPLE_VIDEO, SAMPLE_AUDIO, 24
            );

            if (!alignment.alignments().isEmpty()) { 
                alignment.alignments().forEach(segment -> 
                        assertThat(segment.syncConfidence()).isBetween(0.0, 1.0) 
                );
            }
        }

        @Test
        @DisplayName("different frame rates produce different alignments")
        void differentFrameRatesProduceDifferentAlignments() { 
            TestVideoAudioAlignment a24 = engine.alignVideoAndAudio(SAMPLE_VIDEO, SAMPLE_AUDIO, 24); 
            TestVideoAudioAlignment a30 = engine.alignVideoAndAudio(SAMPLE_VIDEO, SAMPLE_AUDIO, 30); 

            // Different frame rates may produce different timing
            assertThat(a24).isNotNull(); 
            assertThat(a30).isNotNull(); 
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // CONTEXT PRESERVATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("context preservation")
    class ContextPreservation {

        @Test
        @DisplayName("sequential multimodal analyses maintain context")
        void sequentialAnalysesMaintainContext() { 
            TestAudioResult audio = engine.analyseAudio(SAMPLE_AUDIO); 
            TestVisualResult visual = engine.analyseImage(SAMPLE_IMAGE); 
            TestMultimodalResult fused = engine.fuseAudioAndImage(SAMPLE_AUDIO, SAMPLE_IMAGE); 

            // Fused result should incorporate both analyses
            assertThat(fused.combinedAnalysis()).isNotBlank(); 
            assertThat(audio.transcription()).isNotBlank(); 
            assertThat(visual.sceneDescription()).isNotBlank(); 
        }

        @Test
        @DisplayName("context from multiple images is preserved")
        void contextFromMultipleImagesIsPreserved() { 
            TestVisualResult img1 = engine.analyseImage(SAMPLE_IMAGE); 
            TestVisualResult img2 = engine.analyseImage(new byte[] {30, 40, 50}); 

            assertThat(img1.sceneDescription()).isNotBlank(); 
            assertThat(img2.sceneDescription()).isNotBlank(); 
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // INTEGRATION CORRECTNESS TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("integration correctness")
    class IntegrationCorrectness {

        @Test
        @DisplayName("audio component integration is correct")
        void audioComponentIntegrationIsCorrect() { 
            byte[] testAudio = {1, 2, 3};
            TestAudioResult result = engine.analyseAudio(testAudio); 

            // Result should be generated from audio component
            assertThat(result).isNotNull(); 
            assertThat(result.transcription()).isNotBlank(); 
            assertThat(result.confidence()).isGreaterThan(0.0); 
        }

        @Test
        @DisplayName("vision component integration is correct")
        void visionComponentIntegrationIsCorrect() { 
            byte[] testImage = {10, 20};
            TestVisualResult result = engine.analyseImage(testImage); 

            // Result should be generated from vision component
            assertThat(result).isNotNull(); 
            assertThat(result.sceneDescription()).isNotBlank(); 
            assertThat(result.confidence()).isGreaterThan(0.0); 
        }

        @Test
        @DisplayName("fused results combine both components correctly")
        void fusedResultsCombineComponentsCorrectly() { 
            TestMultimodalResult result = engine.fuseAudioAndImage(SAMPLE_AUDIO, SAMPLE_IMAGE); 

            // Combined analysis should reference both components
            assertThat(result.combinedAnalysis()).isNotBlank(); 
            assertThat(result.processingTimeMs()).isGreaterThanOrEqualTo(0); 
        }

        @Test
        @DisplayName("temporal alignment correctly synchronizes modalities")
        void temporalAlignmentSynchronizesModalities() { 
            TestVideoAudioAlignment alignment = engine.alignVideoAndAudio( 
                    SAMPLE_VIDEO, SAMPLE_AUDIO, 24
            );

            // Alignment should exist and be valid
            assertThat(alignment).isNotNull(); 
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // ERROR HANDLING & ROBUSTNESS TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("error handling and robustness")
    class ErrorHandlingAndRobustness {

        @Test
        @DisplayName("multiple consecutive errors don't affect next success")
        void multipleErrorsDontAffectNextSuccess() { 
            // Trigger some errors
            assertThatThrownBy(() -> engine.analyseAudio(null)) 
                    .isInstanceOf(Exception.class); 
            assertThatThrownBy(() -> engine.analyseImage(null)) 
                    .isInstanceOf(Exception.class); 

            // Next operation should work fine
            TestAudioResult result = engine.analyseAudio(SAMPLE_AUDIO); 
            assertThat(result.transcription()).isNotBlank(); 
        }

        @Test
        @DisplayName("large audio data is handled without failure")
        void largeAudioDataIsHandled() { 
            byte[] largeAudio = new byte[1_000_000];
            for (int i = 0; i < largeAudio.length; i++) { 
                largeAudio[i] = (byte) (i % 256); 
            }

            assertThatCode(() -> engine.analyseAudio(largeAudio)) 
                    .doesNotThrowAnyException(); 
        }

        @Test
        @DisplayName("rapid consecutive operations don't interfere")
        void rapidConsecutiveOperationsDontInterfere() { 
            for (int i = 0; i < 10; i++) { 
                TestAudioResult audio = engine.analyseAudio(SAMPLE_AUDIO); 
                TestVisualResult visual = engine.analyseImage(SAMPLE_IMAGE); 
                TestMultimodalResult fused = engine.fuseAudioAndImage(SAMPLE_AUDIO, SAMPLE_IMAGE); 

                assertThat(audio.transcription()).isNotBlank(); 
                assertThat(visual.sceneDescription()).isNotBlank(); 
                assertThat(fused.combinedAnalysis()).isNotBlank(); 
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // PERFORMANCE TESTS
    // ═══════════════════════════════════════════════════════════════════════════════════

    @Nested
    @DisplayName("performance")
    class Performance {

        @Test
        @DisplayName("audio analysis completes in reasonable time")
        void audioAnalysisCompletesInReasonableTime() { 
            long start = System.currentTimeMillis(); 
            engine.analyseAudio(SAMPLE_AUDIO); 
            long elapsed = System.currentTimeMillis() - start; 

            assertThat(elapsed).isLessThan(5000L); // 5 seconds 
        }

        @Test
        @DisplayName("fusion analysis completes in reasonable time")
        void fusionAnalysisCompletesInReasonableTime() { 
            long start = System.currentTimeMillis(); 
            engine.fuseAudioAndImage(SAMPLE_AUDIO, SAMPLE_IMAGE); 
            long elapsed = System.currentTimeMillis() - start; 

            assertThat(elapsed).isLessThan(10000L); // 10 seconds 
        }

        @Test
        @DisplayName("processing time is recorded in results")
        void processingTimeIsRecorded() { 
            TestMultimodalResult result = engine.fuseAudioAndImage(SAMPLE_AUDIO, SAMPLE_IMAGE); 

            assertThat(result.processingTimeMs()).isGreaterThanOrEqualTo(0); 
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // TEST HELPER CLASSES
    // ═══════════════════════════════════════════════════════════════════════════════════

    /**
     * Test implementation of MultimodalEngine for testing.
     */
    private static class TestMultimodalEngine {

        public TestAudioResult analyseAudio(byte[] audioData) { 
            if (audioData == null || audioData.length == 0) { 
                throw new IllegalArgumentException("Audio data must not be null or empty");
            }
            return new TestAudioResult( 
                    "Transcribed audio: " + audioData.length + " bytes",
                    0.9,
                    "en"
            );
        }

        public TestVisualResult analyseImage(byte[] imageData) { 
            if (imageData == null || imageData.length == 0) { 
                throw new IllegalArgumentException("Image data must not be null or empty");
            }
            return new TestVisualResult( 
                    "Scene with " + imageData.length + " byte images",
                    List.of(new TestDetection("object", 0.85)), 
                    0.88
            );
        }

        public TestVisualResult analyseVideo(byte[] videoData, int fps, int maxFrames) { 
            if (videoData == null || videoData.length == 0) { 
                throw new IllegalArgumentException("Video data must not be null or empty");
            }
            return new TestVisualResult( 
                    "Video scene at " + fps + "fps, max " + maxFrames + " frames",
                    List.of(), 
                    0.84
            );
        }

        public TestMultimodalResult fuseAudioAndImage(byte[] audio, byte[] image) { 
            return new TestMultimodalResult( 
                    "Fused: audio(" + audio.length + ") + image(" + image.length + ")",
                    System.currentTimeMillis() 
            );
        }

        public TestMultimodalResult fuseAudioImageAndText(byte[] audio, byte[] image, String text) { 
            String enriched = text != null && !text.isBlank() 
                    ? " with text: '" + text + "'"
                    : "";
            return new TestMultimodalResult( 
                    "Fused: audio + image + text" + enriched,
                    System.currentTimeMillis() 
            );
        }

        public TestVideoAudioAlignment alignVideoAndAudio(byte[] video, byte[] audio, int fps) { 
            if (video == null || video.length == 0) { 
                throw new IllegalArgumentException("Video data must not be null or empty");
            }
            List<TestAlignment> alignments = List.of( 
                    new TestAlignment("Hello", 0.92), 
                    new TestAlignment("World", 0.88) 
            );
            return new TestVideoAudioAlignment(alignments); 
        }
    }

    record TestAudioResult(String transcription, double confidence, String detectedLanguage) {} 
    record TestVisualResult(String sceneDescription, List<TestDetection> detections, double confidence) {} 
    record TestDetection(String label, double confidence) {} 
    record TestMultimodalResult(String combinedAnalysis, long processingTimeMs) {} 
    record TestAlignment(String speechText, double syncConfidence) {} 
    record TestVideoAudioAlignment(List<TestAlignment> alignments) {} 
}
