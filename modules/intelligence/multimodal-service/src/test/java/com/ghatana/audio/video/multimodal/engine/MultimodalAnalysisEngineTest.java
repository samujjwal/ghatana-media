package com.ghatana.audio.video.multimodal.engine;

import com.ghatana.testing.activej.EventloopTestBase;
import io.activej.promise.Promise;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Tests for multimodal fusion and temporal alignment.
 *
 * @doc.type test
 * @doc.purpose Verifies multimodal analysis engine fusion behavior with fake adapters
 * @doc.layer product
 */
@DisplayName("MultimodalAnalysisEngine Tests")
class MultimodalAnalysisEngineTest extends EventloopTestBase {

    @Test
    @DisplayName("Should fuse audio image and text context")
    void shouldFuseAudioImageAndTextContext() { 
        AudioResult audio = AudioResult.builder() 
            .transcription("hello from the meeting room")
            .confidence(0.93) 
            .build(); 
        VisualResult visual = VisualResult.builder() 
            .sceneDescription("A person standing near a whiteboard")
            .detections(List.of(new DetectionResult("person", 0.98, 10, 20, 30, 40))) 
            .confidence(0.98) 
            .build(); 

        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine( 
            new FakeMediaGateway(audio, visual, visual), 
            AudioVideoRuntimeSettings.defaults())) { 
            MultimodalResult result = runPromise(() -> Promise.of(engine.analyse( 
                MultimodalRequest.builder() 
                    .audioData(new byte[] {1, 2, 3}) 
                    .imageData(new byte[] {4, 5, 6}) 
                    .text("board review")
                    .build() 
            )));

            assertEquals("hello from the meeting room", result.getAudioResult().getTranscription()); 
            assertEquals("A person standing near a whiteboard", result.getVisualResult().getSceneDescription()); 
            assertTrue(result.getCombinedAnalysis().contains("Speech: \"hello from the meeting room\"")); 
            assertTrue(result.getCombinedAnalysis().contains("Visual: A person standing near a whiteboard"));
            assertTrue(result.getCombinedAnalysis().contains("Text context: board review"));
            assertTrue(result.getProcessingTimeMs() >= 0); 
        }
    }

    @Test
    @DisplayName("Should align speech segments with video frames")
    void shouldAlignSpeechSegmentsWithVideoFrames() { 
        AudioResult audio = AudioResult.builder() 
            .transcription("hello world")
            .confidence(0.88) 
            .timedSegments(List.of( 
                new AudioResult.TimedSegment(0, 999, "hello"), 
                new AudioResult.TimedSegment(1000, 1999, "world") 
            ))
            .build(); 
        VisualResult video = VisualResult.builder() 
            .sceneDescription("Two frames with objects")
            .frameResults(List.of( 
                new FrameResult(1, 500, List.of(new DetectionResult("person", 0.95, 0, 0, 10, 10))), 
                new FrameResult(2, 1500, List.of(new DetectionResult("car", 0.90, 5, 5, 15, 15))) 
            ))
            .detections(List.of( 
                new DetectionResult("person", 0.95, 0, 0, 10, 10), 
                new DetectionResult("car", 0.90, 5, 5, 15, 15) 
            ))
            .confidence(0.95) 
            .build(); 

        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine( 
            new FakeMediaGateway(audio, VisualResult.error("unused"), video),
            AudioVideoRuntimeSettings.defaults())) { 
            VideoAudioResult result = runPromise(() -> Promise.of( 
                engine.analyseVideoWithAudio(new byte[] {9, 8, 7}, true, true, 2) 
            ));

            assertEquals(2, result.getTemporalAlignments().size()); 
            assertEquals("hello", result.getTemporalAlignments().get(0).getSpeechText()); 
            assertEquals("world", result.getTemporalAlignments().get(1).getSpeechText()); 
            assertTrue(result.getTemporalAlignments().get(0).getSyncConfidence() > 0.0); 
            assertTrue(result.getCombinedNarrative().contains("[0s] \"hello\"")); 
            assertTrue(result.getCombinedNarrative().contains("[1s] \"world\"")); 
            assertFalse(result.getVideoResult().isError()); 
        }
    }

    private static final class FakeMediaGateway implements MultimodalMediaGateway {
        private final AudioResult audioResult;
        private final VisualResult imageResult;
        private final VisualResult videoResult;

        private FakeMediaGateway(AudioResult audioResult, VisualResult imageResult, VisualResult videoResult) { 
            this.audioResult = audioResult;
            this.imageResult = imageResult;
            this.videoResult = videoResult;
        }

        @Override
        public AudioResult transcribe(byte[] audioData) { 
            return audioResult;
        }

        @Override
        public VisualResult analyseImage(byte[] imageData) { 
            return imageResult;
        }

        @Override
        public VisualResult analyseVideo(byte[] videoData, int sampleFps, int maxFrames) { 
            return videoResult;
        }

        @Override
        public String backendName() { 
            return "test";
        }

        @Override
        public boolean metricsEnabled() { 
            return true;
        }

        @Override
        public void close() { 
        }
    }
}
