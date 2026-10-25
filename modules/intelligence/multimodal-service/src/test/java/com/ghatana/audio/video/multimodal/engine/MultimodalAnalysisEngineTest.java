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
            assertEquals(TemporalAlignment.SyncStatus.SYNC_UNDETERMINED,
                    result.getTemporalAlignments().get(0).getSyncStatus());
            assertFalse(result.getTemporalAlignments().get(0).hasSyncMeasurement());
            assertEquals(0L, result.getTemporalAlignments().get(0).getSyncOffsetMs());
            assertEquals(0.0, result.getTemporalAlignments().get(0).getSyncConfidence());
            assertTrue(result.getCombinedNarrative().contains("[0s] \"hello\"")); 
            assertTrue(result.getCombinedNarrative().contains("[1s] \"world\"")); 
            assertFalse(result.getVideoResult().isError()); 
        }
    }

    @Test
    @DisplayName("Should not report timestamp association as measured synchronization")
    void shouldLeaveSynchronizationUndeterminedWithoutSignalFeatures() {
        AudioResult audio = AudioResult.builder()
                .transcription("hello")
                .timedSegments(List.of(new AudioResult.TimedSegment(0, 999, "hello")))
                .build();
        VisualResult video = VisualResult.builder()
                .frameResults(List.of(new FrameResult(1, 500, List.of())))
                .build();

        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                new FakeMediaGateway(audio, VisualResult.error("unused"), video),
                AudioVideoRuntimeSettings.defaults())) {
            VideoAudioResult result = runPromise(() -> Promise.of(
                    engine.analyseVideoWithAudio(new byte[] {1}, true, true, 1)));

            TemporalAlignment alignment = result.getTemporalAlignments().get(0);
            assertEquals("hello", alignment.getSpeechText());
            assertEquals(TemporalAlignment.SyncStatus.SYNC_UNDETERMINED, alignment.getSyncStatus());
            assertFalse(alignment.hasSyncMeasurement());
            assertEquals(0L, alignment.getSyncOffsetMs());
            assertEquals(0.0, alignment.getSyncConfidence());
        }
    }

    @Test
    @DisplayName("Should keep unavailable synchronization unknown for positive and negative timestamp offsets")
    void shouldKeepUnmeasuredTimestampOffsetsUndetermined() {
        List<AudioResult.TimedSegment> segments = List.of(
                new AudioResult.TimedSegment(0, 999, "audio lags"),
                new AudioResult.TimedSegment(1_000, 1_999, "audio leads"));
        List<FrameResult> frames = List.of(
                new FrameResult(1, 500, List.of()),
                new FrameResult(2, 1_500, List.of()));
        AudioResult audio = AudioResult.builder().transcription("audio").timedSegments(segments).build();
        VisualResult video = VisualResult.builder().frameResults(frames).build();

        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                new FakeMediaGateway(audio, VisualResult.error("unused"), video),
                AudioVideoRuntimeSettings.defaults())) {
            VideoAudioResult result = runPromise(() -> Promise.of(
                    engine.analyseVideoWithAudio(new byte[] {1}, true, true, 1)));

            assertEquals(2, result.getTemporalAlignments().size());
            assertTrue(result.getTemporalAlignments().stream().allMatch(alignment ->
                    alignment.getSyncStatus() == TemporalAlignment.SyncStatus.SYNC_UNDETERMINED));
            assertTrue(result.getTemporalAlignments().stream().noneMatch(
                    TemporalAlignment::hasSyncMeasurement));
        }
    }

    @Test
    @DisplayName("Unknown source PTS is preserved and never aligned to fabricated zero")
    void shouldPreserveUnknownSourcePts() {
        AudioResult audio = AudioResult.builder().transcription("hello")
                .timedSegments(List.of(new AudioResult.TimedSegment(0, 999, "hello"))).build();
        VisualResult video = VisualResult.builder().frameResults(List.of(new FrameResult(1,
                MediaClockTimestamp.unknown("NO_SOURCE_PTS"), List.of()))).build();

        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                new FakeMediaGateway(audio, VisualResult.error("unused"), video),
                AudioVideoRuntimeSettings.defaults())) {
            VideoAudioResult result = runPromise(() -> Promise.of(
                    engine.analyseVideoWithAudio(new byte[] {1}, true, true, 1)));

            TemporalAlignment alignment = result.getTemporalAlignments().getFirst();
            assertFalse(alignment.hasTimestamp());
            assertEquals("NO_SOURCE_PTS", alignment.getTimestamp().unknownReason());
            assertEquals("", alignment.getSpeechText());
            assertFalse(alignment.hasSyncMeasurement());
        }
    }

    @Test
    @DisplayName("Unknown source time does not fall back to full transcript")
    void unknownSourceTimeDoesNotAssociateUntimedTranscript() {
        AudioResult audio = AudioResult.builder().transcription("whole transcript").build();

        assertEquals("", audio.getTranscriptionAtTimestamp(MediaClockTimestamp.unknown("NO_PTS")));
        assertEquals("", audio.getTranscriptionAtTimestamp(MediaClockTimestamp.mediaMilliseconds(500)));
        assertEquals("whole transcript", audio.getTranscription());
    }

    @Test
    @DisplayName("Timestamp lookup does not carry the last segment past its end")
    void timestampLookupRequiresAnActiveSegment() {
        AudioResult audio = AudioResult.builder().transcription("hello")
                .timedSegments(List.of(new AudioResult.TimedSegment(100, 200, "hello"))).build();

        assertEquals("hello", audio.getTranscriptionAtTimestamp(150));
        assertEquals("", audio.getTranscriptionAtTimestamp(250));
        org.assertj.core.api.Assertions.assertThatThrownBy(
                () -> new AudioResult.TimedSegment(200, 100, "bad"))
                .isInstanceOf(IllegalArgumentException.class);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> AudioResult.builder().timedSegments(List.of(
                new AudioResult.TimedSegment(100, 200, "first"),
                new AudioResult.TimedSegment(150, 250, "overlap"))).build())
                .isInstanceOf(IllegalArgumentException.class);
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
