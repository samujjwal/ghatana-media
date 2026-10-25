package com.ghatana.audio.video.multimodal.engine;

import com.ghatana.audio.video.multimodal.adapter.GrpcSttClientAdapter;
import com.ghatana.testing.activej.EventloopTestBase;
import io.activej.promise.Promise;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.api.trace.TraceFlags;
import io.opentelemetry.api.trace.TraceState;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import com.ghatana.audiovideo.observability.MediaWorkflowMetrics;
import io.micrometer.core.instrument.Timer;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertThrows;

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
    @DisplayName("Provider boundary records only valid results as success and exceptions as unknown")
    void providerMetricsReflectActualGatewayResultWithoutPrivateTags() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "multimodal");
        MultimodalMediaGateway gateway = new FakeMediaGateway(
                AudioResult.builder().transcription("transcript").build(),
                VisualResult.error("unavailable"), VisualResult.error("unavailable")) {
        };
        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                gateway, AudioVideoRuntimeSettings.defaults(), TimeUnit.SECONDS.toNanos(60), metrics)) {
            engine.analyse(MultimodalRequest.builder().audioData(new byte[] {1}).build());
        }
        Timer success = registry.find("media.modality.boundary.duration")
                .tag("modality", "stt").tag("service", "multimodal")
                .tag("boundary", "provider").tag("execution_class", "model")
                .tag("outcome", "success").timer();
        assertTrue(success != null && success.count() == 1);
        assertFalse(success.getId().getTags().stream().anyMatch(tag ->
                List.of("tenant", "text", "content", "provider_id", "request_id").contains(tag.getKey())));
        registry.close();
    }

    @Test
    @DisplayName("Image and video provider calls use the vision boundary label")
    void imageAndVideoCallsUseVisionMetricLabel() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "multimodal");
        VisualResult visual = VisualResult.builder().sceneDescription("scene").build();
        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                new FakeMediaGateway(AudioResult.error("unused"), visual, visual),
                AudioVideoRuntimeSettings.defaults(), TimeUnit.SECONDS.toNanos(60), metrics)) {
            engine.analyse(MultimodalRequest.builder().imageData(new byte[] {1})
                    .videoData(new byte[] {2}).build());
        }
        Timer vision = registry.find("media.modality.boundary.duration")
                .tag("modality", "vision").tag("service", "multimodal")
                .tag("boundary", "provider").tag("outcome", "success").timer();
        assertTrue(vision != null && vision.count() == 2);
        assertTrue(registry.find("media.modality.boundary.duration")
                .tag("modality", "stt").tag("boundary", "provider").timers().isEmpty());
        registry.close();
    }

    @Test
    @DisplayName("Unavailable and ambiguous provider outcomes never record success")
    void providerMetricsDoNotMarkUnavailableOrThrownProviderAsSuccess() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "multimodal");
        MultimodalMediaGateway gateway = new FakeMediaGateway(
                AudioResult.error("not available"), VisualResult.error("unused"), VisualResult.error("unused")) {
            private int calls;

            @Override
            public AudioResult transcribe(byte[] audioData) {
                if (calls++ == 0) throw new IllegalStateException("ambiguous provider outcome");
                return AudioResult.error("provider unavailable");
            }
        };
        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                gateway, AudioVideoRuntimeSettings.defaults(), TimeUnit.SECONDS.toNanos(60), metrics)) {
            MultimodalException unknown = assertThrows(MultimodalException.class,
                    () -> engine.analyse(MultimodalRequest.builder().audioData(new byte[] {1}).build()));
            assertEquals("Analysis outcome unavailable", unknown.getMessage());
            MultimodalResult result = engine.analyse(
                    MultimodalRequest.builder().audioData(new byte[] {2}).build());
            assertTrue(result.getAudioResult().isError());
        }
        assertTrue(registry.find("media.modality.boundary.duration")
                .tag("modality", "stt").tag("boundary", "provider")
                .tag("outcome", "success").timers().isEmpty());
        Timer unknown = registry.find("media.modality.boundary.duration")
                .tag("modality", "stt").tag("boundary", "provider")
                .tag("outcome", "unknown").timer();
        assertTrue(unknown != null && unknown.count() == 1);
        Timer failure = registry.find("media.modality.boundary.duration")
                .tag("modality", "stt").tag("boundary", "provider")
                .tag("outcome", "failure").timer();
        assertTrue(failure != null && failure.count() == 1);
        registry.close();
    }

    @Test
    @DisplayName("NOP transcription remains unavailable and is measured as provider failure")
    void nopTranscriptionIsNotCountedAsSuccessfulProviderResult() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "multimodal");
        GrpcSttClientAdapter nop = GrpcSttClientAdapter.forLocalTesting(
                "localhost", 1, GrpcSttClientAdapter.SttMode.NOP);
        MultimodalMediaGateway gateway = new FakeMediaGateway(
                AudioResult.error("unused"), VisualResult.error("unused"), VisualResult.error("unused")) {
            @Override public AudioResult transcribe(byte[] audioData) { return nop.transcribe(audioData); }
            @Override public void close() {
                nop.close();
            }
        };

        MultimodalResult result;
        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                gateway, AudioVideoRuntimeSettings.defaults(), TimeUnit.SECONDS.toNanos(60), metrics)) {
            result = engine.analyse(MultimodalRequest.builder().audioData(new byte[] {1, 2, 3}).build());
        }

        assertTrue(result.getAudioResult().isError());
        assertTrue(registry.find("media.modality.boundary.duration")
                .tag("modality", "stt").tag("boundary", "provider")
                .tag("outcome", "success").timers().isEmpty());
        Timer failure = registry.find("media.modality.boundary.duration")
                .tag("modality", "stt").tag("boundary", "provider")
                .tag("outcome", "failure").timer();
        assertTrue(failure != null && failure.count() == 1);
        registry.close();
    }

    @Test
    @DisplayName("Ambiguous child failure does not become an aggregate partial response")
    void ambiguousVisionFailureAfterAudioSuccessReturnsNoAggregateResult() {
        AudioResult audio = AudioResult.builder().transcription("child result").build();
        MultimodalMediaGateway gateway = new FakeMediaGateway(audio,
                VisualResult.builder().build(), VisualResult.builder().build()) {
            @Override public VisualResult analyseImage(byte[] input) {
                throw new IllegalStateException("private provider detail");
            }
        };

        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                gateway, AudioVideoRuntimeSettings.defaults())) {
            MultimodalException failure = assertThrows(MultimodalException.class,
                    () -> engine.analyse(MultimodalRequest.builder()
                            .audioData(new byte[] {1}).imageData(new byte[] {2}).build()));
            assertEquals("Analysis outcome unavailable", failure.getMessage());
        }
    }

    @Test
    @DisplayName("Provider cancellation remains unknown instead of becoming known unavailability")
    void providerCancellationIsNotConvertedToUnavailableModality() {
        MultimodalMediaGateway gateway = new FakeMediaGateway(
                AudioResult.error("unused"), VisualResult.error("unused"), VisualResult.error("unused")) {
            @Override public AudioResult transcribe(byte[] input) {
                throw new CancellationException("private provider cancellation detail");
            }
        };

        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                gateway, AudioVideoRuntimeSettings.defaults())) {
            MultimodalException failure = assertThrows(MultimodalException.class,
                    () -> engine.analyse(MultimodalRequest.builder().audioData(new byte[] {1}).build()));
            assertEquals("Analysis outcome unavailable", failure.getMessage());
        }
    }

    @Test
    @DisplayName("Unconfigured result does not imply successful modality execution")
    void unconfiguredResultDefaultsToNoModality() {
        assertEquals(MultimodalResult.Outcome.NO_MODALITY, MultimodalResult.builder().build().getOutcome());
    }

    @Test
    @DisplayName("Result builder derives truthful outcome from returned modalities")
    void resultBuilderDerivesOutcomeFromModalities() {
        AudioResult audio = AudioResult.builder().transcription("transcript").build();
        VisualResult visual = VisualResult.builder().sceneDescription("scene").build();

        assertEquals(MultimodalResult.Outcome.COMPLETE,
                MultimodalResult.builder().audioResult(audio).visualResult(visual).build().getOutcome());
        assertEquals(MultimodalResult.Outcome.PARTIAL,
                MultimodalResult.builder().audioResult(audio).visualResult(VisualResult.error("unavailable"))
                        .build().getOutcome());
        assertEquals(MultimodalResult.Outcome.FAILED,
                MultimodalResult.builder().audioResult(AudioResult.error("unavailable"))
                        .visualResult(VisualResult.error("unavailable")).build().getOutcome());
    }

    @Test
    @DisplayName("Should abstain from fusion when source references are unavailable")
    void shouldAbstainFromFusionWithoutSourceReferences() {
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
            assertEquals("ABSTAIN: SOURCE_REFERENCES_INCOMPLETE", result.getCombinedAnalysis());
            assertTrue(result.getProcessingTimeMs() >= 0); 
        }
    }

    @Test
    @DisplayName("Caller context alone is not presented as an observed multimodal result")
    void callerContextOnlyAbstainsWithoutDispatchingModalities() {
        String callerContext = "Caller says the clip shows a red car at 8:12";
        AudioResult providerAudio = AudioResult.builder().transcription("unreferenced provider speech").build();
        VisualResult providerVisual = VisualResult.builder().sceneDescription("unreferenced provider scene").build();

        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                new FakeMediaGateway(providerAudio, providerVisual, providerVisual),
                AudioVideoRuntimeSettings.defaults())) {
            MultimodalResult result = runPromise(() -> Promise.of(engine.analyse(
                    MultimodalRequest.builder().text(callerContext).build())));

            assertEquals(MultimodalResult.Outcome.NO_MODALITY, result.getOutcome());
            assertNull(result.getAudioResult());
            assertNull(result.getVisualResult());
            assertEquals("ABSTAIN: SOURCE_REFERENCES_INCOMPLETE", result.getCombinedAnalysis());
            assertFalse(result.getCombinedAnalysis().contains(callerContext));
            assertFalse(result.getCombinedAnalysis().contains("red car"));
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
            assertEquals("ABSTAIN: SOURCE_REFERENCES_INCOMPLETE", result.getCombinedNarrative());
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
    @DisplayName("Variable-rate source PTS is preserved while cross-clock sync remains unknown")
    void variableRateSourcePtsDoesNotInventAudioClockMapping() {
        AudioResult audio = AudioResult.builder().transcription("audio words")
                .timedSegments(List.of(new AudioResult.TimedSegment(0, 5_000, "audio words"))).build();
        List<FrameResult> sourceFrames = List.of(
                new FrameResult(1, sourcePts(0, 1, 90_000), List.of()),
                new FrameResult(2, sourcePts(3_003, 1, 90_000), List.of()),
                new FrameResult(3, sourcePts(9_009, 1, 90_000), List.of()));
        VisualResult video = VisualResult.builder().frameResults(sourceFrames).build();

        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                new FakeMediaGateway(audio, VisualResult.error("unused"), video),
                AudioVideoRuntimeSettings.defaults())) {
            VideoAudioResult result = runPromise(() -> Promise.of(
                    engine.analyseVideoWithAudio(new byte[] {1}, true, true, 1)));

            assertEquals(List.of(0L, 3_003L, 9_009L), result.getVideoResult().getFrameResults().stream()
                    .map(frame -> frame.getTimestamp().ticks()).toList());
            assertTrue(result.getTemporalAlignments().stream().allMatch(alignment ->
                    alignment.getSyncStatus() == TemporalAlignment.SyncStatus.SYNC_UNDETERMINED
                            && !alignment.hasSyncMeasurement()
                            && alignment.getSyncOffsetMs() == 0L
                            && alignment.getSyncConfidence() == 0.0
                            && alignment.getSpeechText().isEmpty()));
        }
    }

    @Test
    @DisplayName("Exact rational transcript windows align only on the same source clock")
    void exactSourceClockWindowsAlignWithoutEstimatingSynchronization() {
        String sourceClock = "trusted-source-clock-1";
        AudioResult audio = AudioResult.builder().transcription("speech").timedSegments(List.of(
                new AudioResult.TimedSegment(
                        MediaClockTimestamp.audioSamples(4_800, 48_000, sourceClock),
                        MediaClockTimestamp.audioSamples(14_400, 48_000, sourceClock),
                        "speech"))).build();
        VisualResult video = VisualResult.builder().frameResults(List.of(
                // 18000/90000 is exactly 200ms, despite its distinct rational timebase.
                new FrameResult(1, clockTime(18_000, 1, 90_000,
                        MediaClockTimestamp.ClockDomain.SOURCE, sourceClock), List.of()),
                new FrameResult(2, clockTime(36_000, 1, 90_000,
                        MediaClockTimestamp.ClockDomain.SOURCE, "different-source-clock"), List.of()),
                new FrameResult(3, clockTime(45_000, 1, 90_000,
                        MediaClockTimestamp.ClockDomain.SOURCE, sourceClock), List.of())))
                .build();

        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                new FakeMediaGateway(audio, VisualResult.error("unused"), video),
                AudioVideoRuntimeSettings.defaults())) {
            VideoAudioResult result = runPromise(() -> Promise.of(
                    engine.analyseVideoWithAudio(new byte[] {1}, true, true, 1)));

            assertEquals(List.of("speech", "", ""), result.getTemporalAlignments().stream()
                    .map(TemporalAlignment::getSpeechText).toList());
            assertTrue(result.getTemporalAlignments().stream().allMatch(alignment ->
                    alignment.getSyncStatus() == TemporalAlignment.SyncStatus.SYNC_UNDETERMINED
                            && !alignment.hasSyncMeasurement()
                            && alignment.getSyncOffsetMs() == 0L
                            && alignment.getSyncConfidence() == 0.0));
        }
    }

    @Test
    @DisplayName("Rational media timestamps align to bounded transcript windows without fps extrapolation")
    void rationalVariableRateMediaTimestampsMatchExplicitWindows() {
        AudioResult audio = AudioResult.builder().transcription("first second")
                .timedSegments(List.of(
                        new AudioResult.TimedSegment(33, 34, "first"),
                        new AudioResult.TimedSegment(100, 101, "second")))
                .build();
        VisualResult video = VisualResult.builder().frameResults(List.of(
                new FrameResult(1, mediaTime(1_001, 1, 30_000), List.of()),
                new FrameResult(2, mediaTime(3_003, 1, 30_000), List.of())))
                .build();

        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                new FakeMediaGateway(audio, VisualResult.error("unused"), video),
                AudioVideoRuntimeSettings.defaults())) {
            VideoAudioResult result = runPromise(() -> Promise.of(
                    engine.analyseVideoWithAudio(new byte[] {1}, true, true, 1)));

            assertEquals(List.of("first", "second"), result.getTemporalAlignments().stream()
                    .map(TemporalAlignment::getSpeechText).toList());
            assertTrue(result.getTemporalAlignments().stream().allMatch(alignment ->
                    alignment.getSyncStatus() == TemporalAlignment.SyncStatus.SYNC_UNDETERMINED
                            && !alignment.hasSyncMeasurement()));
        }
    }

    @Test
    @DisplayName("Rational interval boundaries are compared exactly rather than rounded to milliseconds")
    void rationalMediaTimestampUsesExactInclusiveWindowBounds() {
        AudioResult audio = AudioResult.builder().transcription("word")
                .timedSegments(List.of(new AudioResult.TimedSegment(1, 2, "word"))).build();
        VisualResult video = VisualResult.builder().frameResults(List.of(
                new FrameResult(1, mediaTime(1_999, 1, 2_000_000), List.of()),
                new FrameResult(2, mediaTime(2_000, 1, 2_000_000), List.of())))
                .build();

        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                new FakeMediaGateway(audio, VisualResult.error("unused"), video),
                AudioVideoRuntimeSettings.defaults())) {
            VideoAudioResult result = runPromise(() -> Promise.of(
                    engine.analyseVideoWithAudio(new byte[] {1}, true, true, 1)));

            assertEquals(List.of("", "word"), result.getTemporalAlignments().stream()
                    .map(TemporalAlignment::getSpeechText).toList());
        }
    }

    @Test
    @DisplayName("Source, simulation, wall, and unrelated media clocks remain unresolved against media windows")
    void mismatchedClockDomainsAndIdentitiesDoNotAlignTranscriptWindows() {
        AudioResult audio = AudioResult.builder().transcription("word")
                .timedSegments(List.of(new AudioResult.TimedSegment(0, 2, "word"))).build();
        VisualResult video = VisualResult.builder().frameResults(List.of(
                new FrameResult(1, mediaTime(1, 1, 1000), List.of()),
                new FrameResult(2, clockTime(1, 1, 1000, MediaClockTimestamp.ClockDomain.SOURCE,
                        "source-clock"), List.of()),
                new FrameResult(3, clockTime(1, 1, 1000, MediaClockTimestamp.ClockDomain.SIMULATION,
                        "simulation-clock"), List.of()),
                new FrameResult(4, clockTime(1, 1, 1000, MediaClockTimestamp.ClockDomain.WALL,
                        "wall-clock"), List.of()),
                new FrameResult(5, clockTime(1, 1, 1000, MediaClockTimestamp.ClockDomain.MEDIA,
                        "other-media-clock"), List.of())))
                .build();

        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                new FakeMediaGateway(audio, VisualResult.error("unused"), video),
                AudioVideoRuntimeSettings.defaults())) {
            VideoAudioResult result = runPromise(() -> Promise.of(
                    engine.analyseVideoWithAudio(new byte[] {1}, true, true, 1)));

            assertEquals("word", result.getTemporalAlignments().getFirst().getSpeechText());
            assertTrue(result.getTemporalAlignments().stream().skip(1)
                    .allMatch(alignment -> alignment.getSpeechText().isEmpty()
                            && alignment.getSyncStatus() == TemporalAlignment.SyncStatus.SYNC_UNDETERMINED
                            && !alignment.hasSyncMeasurement()));
        }
    }

    @Test
    @DisplayName("Unavailable audio timing never produces measured synchronization")
    void unavailableAudioTimingLeavesSynchronizationUnknown() {
        AudioResult audio = AudioResult.builder().error("audio timing unavailable").build();
        VisualResult video = VisualResult.builder().frameResults(List.of(
                new FrameResult(1, sourcePts(90_000, 1, 90_000), List.of()))).build();

        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                new FakeMediaGateway(audio, VisualResult.error("unused"), video),
                AudioVideoRuntimeSettings.defaults())) {
            VideoAudioResult result = runPromise(() -> Promise.of(
                    engine.analyseVideoWithAudio(new byte[] {1}, true, true, 1)));

            TemporalAlignment alignment = result.getTemporalAlignments().getFirst();
            assertEquals(TemporalAlignment.SyncStatus.SYNC_UNDETERMINED, alignment.getSyncStatus());
            assertTrue(alignment.getSpeechText().isEmpty());
            assertFalse(alignment.hasSyncMeasurement());
        }
    }

    @Test
    @DisplayName("Audio failure remains explicit while successful visual result is preserved")
    void oneModalityFailurePreservesOtherAndRedactsFailure() {
        VisualResult visual = VisualResult.builder().sceneDescription("qualified fixture result").build();
        MultimodalMediaGateway gateway = new FakeMediaGateway(AudioResult.error("private marker"), visual,
                VisualResult.error("unused")) {
        };
        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                gateway, AudioVideoRuntimeSettings.defaults())) {
            MultimodalResult result = engine.analyse(MultimodalRequest.builder()
                    .audioData(new byte[] {1}).imageData(new byte[] {2}).build());

            assertTrue(result.getAudioResult().isError());
            assertEquals("Audio transcription unavailable", result.getAudioResult().getError());
            assertEquals("qualified fixture result", result.getVisualResult().getSceneDescription());
            assertEquals("ABSTAIN: SOURCE_REFERENCES_INCOMPLETE", result.getCombinedAnalysis());
            assertEquals(MultimodalResult.Outcome.PARTIAL, result.getOutcome());
        }
    }

    @Test
    @DisplayName("Failed video result is not merged into apparent image success")
    void failedVisualChildMakesMergedVisualExplicitlyUnavailable() {
        VisualResult image = VisualResult.builder().sceneDescription("image fixture").build();
        MultimodalMediaGateway gateway = new FakeMediaGateway(AudioResult.error("unused"), image,
                VisualResult.error("unused")) {
            @Override public VisualResult analyseVideo(byte[] input, int fps, int maxFrames) {
                return VisualResult.error("known video provider unavailable");
            }
        };
        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                gateway, AudioVideoRuntimeSettings.defaults())) {
            MultimodalResult result = engine.analyse(MultimodalRequest.builder()
                    .imageData(new byte[] {1}).videoData(new byte[] {2}).build());

            assertTrue(result.getVisualResult().isError());
            assertEquals("Visual analysis unavailable", result.getVisualResult().getError());
            assertEquals("", result.getVisualResult().getSceneDescription());
            assertEquals(MultimodalResult.Outcome.PARTIAL, result.getOutcome());
        }
    }

    @Test
    @DisplayName("Image and video confidence scores are not collapsed into one visual score")
    void mergedVisualResultLeavesAggregateConfidenceUnknown() {
        DetectionResult imageDetection = new DetectionResult("image-object", 0.82, 1, 2, 3, 4);
        DetectionResult videoDetection = new DetectionResult("video-object", 0.47, 5, 6, 7, 8);
        VisualResult image = VisualResult.builder().confidence(0.82)
                .detections(List.of(imageDetection)).build();
        VisualResult video = VisualResult.builder().confidence(0.47)
                .detections(List.of(videoDetection)).build();
        MultimodalMediaGateway gateway = new FakeMediaGateway(AudioResult.error("unused"), image, video);

        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                gateway, AudioVideoRuntimeSettings.defaults())) {
            MultimodalResult result = engine.analyse(MultimodalRequest.builder()
                    .imageData(new byte[] {1}).videoData(new byte[] {2}).build());

            assertNull(result.getVisualResult().getConfidence());
            assertEquals(2, result.getVisualResult().getDetections().size());
            assertEquals(0.82, result.getVisualResult().getDetections().get(0).getConfidence());
            assertEquals(0.47, result.getVisualResult().getDetections().get(1).getConfidence());
        }
    }

    @Test
    @DisplayName("All requested modality failures produce an explicit failed outcome")
    void allRequestedModalityFailuresAreFailed() {
        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                new FakeMediaGateway(AudioResult.error("unused"), VisualResult.error("unused"),
                        VisualResult.error("unused")), AudioVideoRuntimeSettings.defaults())) {
            MultimodalResult result = engine.analyse(MultimodalRequest.builder()
                    .audioData(new byte[] {1}).imageData(new byte[] {2}).build());

            assertEquals(MultimodalResult.Outcome.FAILED, result.getOutcome());
            assertTrue(result.getAudioResult().isError());
            assertTrue(result.getVisualResult().isError());
        }
    }

    @Test
    @DisplayName("Timeout cancels child work and returns a stable unavailable result")
    void timeoutCancelsChildrenAndRedactsProviderFailure() throws Exception {
        CountDownLatch audioStarted = new CountDownLatch(1);
        CountDownLatch audioInterrupted = new CountDownLatch(1);
        MultimodalMediaGateway gateway = new FakeMediaGateway(AudioResult.error("unused"),
                VisualResult.builder().build(), VisualResult.builder().build()) {
            @Override public AudioResult transcribe(byte[] input) {
                audioStarted.countDown();
                try {
                    new CountDownLatch(1).await();
                    return AudioResult.builder().build();
                } catch (InterruptedException interrupted) {
                    audioInterrupted.countDown();
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException("private provider detail", interrupted);
                }
            }
        };
        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                gateway, AudioVideoRuntimeSettings.defaults(), TimeUnit.MILLISECONDS.toNanos(50))) {
            MultimodalException failure = assertThrows(MultimodalException.class,
                    () -> engine.analyse(MultimodalRequest.builder()
                            .audioData(new byte[] {1}).imageData(new byte[] {2}).build()));
            assertEquals("Analysis outcome unavailable: deadline exceeded", failure.getMessage());
            assertTrue(audioStarted.await(1, TimeUnit.SECONDS));
            assertTrue(audioInterrupted.await(1, TimeUnit.SECONDS));
        }
    }

    @Test
    @DisplayName("Caller interruption cancels every submitted modality child and restores the interrupt")
    void callerInterruptionCancelsAllChildrenAndRestoresInterrupt() throws Exception {
        CountDownLatch childrenStarted = new CountDownLatch(3);
        CountDownLatch childrenInterrupted = new CountDownLatch(3);
        MultimodalMediaGateway gateway = new FakeMediaGateway(AudioResult.error("unused"),
                VisualResult.error("unused"), VisualResult.error("unused")) {
            private void awaitCancellation() {
                childrenStarted.countDown();
                try {
                    new CountDownLatch(1).await();
                } catch (InterruptedException cancelled) {
                    childrenInterrupted.countDown();
                    throw new CancellationException("child cancelled");
                }
            }

            @Override public AudioResult transcribe(byte[] input) {
                awaitCancellation();
                return AudioResult.error("unexpected completion");
            }

            @Override public VisualResult analyseImage(byte[] input) {
                awaitCancellation();
                return VisualResult.error("unexpected completion");
            }

            @Override public VisualResult analyseVideo(byte[] input, int sampleFps, int maxFrames) {
                awaitCancellation();
                return VisualResult.error("unexpected completion");
            }
        };
        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                gateway, settingsWithMaxInputStreams(3), TimeUnit.SECONDS.toNanos(5))) {
            AtomicReference<MultimodalException> failure = new AtomicReference<>();
            AtomicBoolean interruptRestored = new AtomicBoolean();
            Thread caller = new Thread(() -> {
                try {
                    engine.analyse(MultimodalRequest.builder().audioData(new byte[] {1})
                            .imageData(new byte[] {2}).videoData(new byte[] {3}).build());
                } catch (MultimodalException interrupted) {
                    failure.set(interrupted);
                    interruptRestored.set(Thread.currentThread().isInterrupted());
                }
            }, "multimodal-parent-cancellation-test");

            caller.start();
            assertTrue(childrenStarted.await(2, TimeUnit.SECONDS));
            caller.interrupt();
            caller.join(2_000);

            assertFalse(caller.isAlive());
            assertEquals("Analysis interrupted", failure.get().getMessage());
            assertTrue(interruptRestored.get());
            assertTrue(childrenInterrupted.await(2, TimeUnit.SECONDS));
        }
    }

    @Test
    @DisplayName("Caller interruption cancels queued modality work before provider dispatch")
    void callerInterruptionCancelsQueuedChildBeforeDispatch() throws Exception {
        CountDownLatch activeChildrenStarted = new CountDownLatch(2);
        CountDownLatch activeChildrenInterrupted = new CountDownLatch(2);
        CountDownLatch queuedVideoStarted = new CountDownLatch(1);
        MultimodalMediaGateway gateway = new FakeMediaGateway(AudioResult.error("unused"),
                VisualResult.error("unused"), VisualResult.error("unused")) {
            private void awaitCancellation() {
                activeChildrenStarted.countDown();
                try {
                    new CountDownLatch(1).await();
                } catch (InterruptedException cancelled) {
                    activeChildrenInterrupted.countDown();
                    throw new CancellationException("child cancelled");
                }
            }

            @Override public AudioResult transcribe(byte[] input) {
                awaitCancellation();
                return AudioResult.error("unexpected completion");
            }

            @Override public VisualResult analyseImage(byte[] input) {
                awaitCancellation();
                return VisualResult.error("unexpected completion");
            }

            @Override public VisualResult analyseVideo(byte[] input, int sampleFps, int maxFrames) {
                queuedVideoStarted.countDown();
                awaitCancellation();
                return VisualResult.error("unexpected completion");
            }
        };
        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                gateway, AudioVideoRuntimeSettings.defaults(), TimeUnit.SECONDS.toNanos(5))) {
            AtomicReference<MultimodalException> failure = new AtomicReference<>();
            Thread caller = new Thread(() -> {
                try {
                    engine.analyse(MultimodalRequest.builder().audioData(new byte[] {1})
                            .imageData(new byte[] {2}).videoData(new byte[] {3}).build());
                } catch (MultimodalException interrupted) {
                    failure.set(interrupted);
                }
            }, "multimodal-queued-cancellation-test-caller");

            caller.start();
            assertTrue(activeChildrenStarted.await(2, TimeUnit.SECONDS));
            caller.interrupt();
            caller.join(2_000);

            assertFalse(caller.isAlive());
            assertEquals("Analysis interrupted", failure.get().getMessage());
            assertTrue(activeChildrenInterrupted.await(2, TimeUnit.SECONDS));
            assertFalse(queuedVideoStarted.await(100, TimeUnit.MILLISECONDS));
        }
    }

    @Test
    @DisplayName("Gateway close failure still shuts down the bounded child executor")
    void gatewayCloseFailureStillShutsDownExecutor() {
        AtomicInteger providerCalls = new AtomicInteger();
        MultimodalMediaGateway gateway = new FakeMediaGateway(AudioResult.builder().build(),
                VisualResult.error("unused"), VisualResult.error("unused")) {
            @Override public AudioResult transcribe(byte[] input) {
                providerCalls.incrementAndGet();
                return AudioResult.builder().transcription("unexpected").build();
            }

            @Override public void close() {
                throw new IllegalStateException("fixture close failure");
            }
        };
        MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                gateway, AudioVideoRuntimeSettings.defaults());

        assertThrows(IllegalStateException.class, engine::close);
        assertThrows(MultimodalException.class, () -> engine.analyse(
                MultimodalRequest.builder().audioData(new byte[] {1}).build()));
        assertEquals(0, providerCalls.get());
    }

    @Test
    @DisplayName("Admission limit rejects excess concurrent analysis")
    void capacityLimitAppliesBackpressure() throws Exception {
        CountDownLatch audioStarted = new CountDownLatch(1);
        CountDownLatch releaseAudio = new CountDownLatch(1);
        MultimodalMediaGateway gateway = new FakeMediaGateway(AudioResult.builder().build(),
                VisualResult.error("unused"), VisualResult.error("unused")) {
            @Override public AudioResult transcribe(byte[] input) {
                audioStarted.countDown();
                try {
                    releaseAudio.await();
                    return AudioResult.builder().transcription("done").build();
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException("interrupted");
                }
            }
        };
        AudioVideoRuntimeSettings base = AudioVideoRuntimeSettings.defaults();
        AudioVideoRuntimeSettings singleAdmission = new AudioVideoRuntimeSettings(base.languageTag(),
                base.sttSampleRate(), base.sttChannels(), base.sttBitsPerSample(), base.defaultImageWidth(),
                base.defaultImageHeight(), base.syncToleranceMs(), base.syncAudioBufferMs(),
                base.syncVideoBufferMs(), base.defaultVideoSampleFps(), base.defaultVideoMaxFrames(),
                base.sttModelId(), base.visionModelId(), base.ttsVoiceId(), base.metricsEnabled(),
                1, base.maxOutputStreams(), base.deviceAcquireTimeoutMs(), base.leakDetectionThresholdMs());
        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                gateway, singleAdmission, TimeUnit.SECONDS.toNanos(2))) {
            FutureTask<MultimodalResult> first = new FutureTask<>(() -> engine.analyse(
                    MultimodalRequest.builder().audioData(new byte[] {1}).build()));
            Thread caller = new Thread(first, "multimodal-capacity-test-caller");
            caller.start();
            assertTrue(audioStarted.await(1, TimeUnit.SECONDS));
            MultimodalException rejected = assertThrows(MultimodalException.class,
                    () -> engine.analyse(MultimodalRequest.builder()
                            .audioData(new byte[] {2}).build()));
            assertEquals("Analysis capacity unavailable", rejected.getMessage());
            releaseAudio.countDown();
            assertTrue(first.get(1, TimeUnit.SECONDS).getAudioResult() != null);
        } finally {
            releaseAudio.countDown();
        }
    }

    @Test
    @DisplayName("child provider calls inherit the caller trace context")
    void childProviderCallsInheritCallerTraceContext() {
        Span parent = Span.wrap(SpanContext.create("0123456789abcdef0123456789abcdef",
                "0123456789abcdef", TraceFlags.getSampled(), TraceState.getDefault()));
        AtomicReference<SpanContext> observed = new AtomicReference<>();
        MultimodalMediaGateway gateway = new FakeMediaGateway(
                AudioResult.builder().transcription("fixture").build(),
                VisualResult.builder().build(), VisualResult.builder().build()) {
            @Override public AudioResult transcribe(byte[] input) {
                observed.set(Span.current().getSpanContext());
                return AudioResult.builder().transcription("fixture").build();
            }
        };

        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                gateway, AudioVideoRuntimeSettings.defaults())) {
            try (Scope ignored = Context.current().with(parent).makeCurrent()) {
                engine.analyse(MultimodalRequest.builder().audioData(new byte[] {1}).build());
            }

            assertEquals(parent.getSpanContext().getTraceId(), observed.get().getTraceId());
            assertEquals(parent.getSpanContext().getSpanId(), observed.get().getSpanId());
            assertFalse(Span.current().getSpanContext().isValid());
        }
    }

    private static MediaClockTimestamp sourcePts(long ticks, long numerator, long denominator) {
        return new MediaClockTimestamp(MediaClockTimestamp.Status.KNOWN, ticks, numerator, denominator,
                MediaClockTimestamp.ClockDomain.SOURCE, "test-video-clock", null);
    }

    private static AudioVideoRuntimeSettings settingsWithMaxInputStreams(int maxInputStreams) {
        AudioVideoRuntimeSettings base = AudioVideoRuntimeSettings.defaults();
        return new AudioVideoRuntimeSettings(base.languageTag(), base.sttSampleRate(), base.sttChannels(),
                base.sttBitsPerSample(), base.defaultImageWidth(), base.defaultImageHeight(),
                base.syncToleranceMs(), base.syncAudioBufferMs(), base.syncVideoBufferMs(),
                base.defaultVideoSampleFps(), base.defaultVideoMaxFrames(), base.sttModelId(),
                base.visionModelId(), base.ttsVoiceId(), base.metricsEnabled(), maxInputStreams,
                base.maxOutputStreams(), base.deviceAcquireTimeoutMs(), base.leakDetectionThresholdMs());
    }

    private static MediaClockTimestamp mediaTime(long ticks, long numerator, long denominator) {
        return clockTime(ticks, numerator, denominator, MediaClockTimestamp.ClockDomain.MEDIA, "media-ms");
    }

    private static MediaClockTimestamp clockTime(long ticks, long numerator, long denominator,
                                                   MediaClockTimestamp.ClockDomain domain, String clockId) {
        return new MediaClockTimestamp(MediaClockTimestamp.Status.KNOWN, ticks, numerator, denominator,
                domain, clockId, null);
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
            assertEquals("ABSTAIN: SOURCE_REFERENCES_INCOMPLETE", result.getCombinedNarrative());
        }
    }

    @Test
    @DisplayName("Audio-only or video-only evidence does not create a grounded narrative")
    void incompleteSingleModalityEvidenceAbstains() {
        AudioResult audio = AudioResult.builder().transcription("unreferenced words").build();
        VisualResult video = VisualResult.builder().sceneDescription("unversioned scene")
                .detections(List.of(new DetectionResult("object", 0.9, 1, 2, 3, 4))).build();

        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                new FakeMediaGateway(audio, VisualResult.error("unused"), VisualResult.error("unused")),
                AudioVideoRuntimeSettings.defaults())) {
            MultimodalResult result = runPromise(() -> Promise.of(engine.analyse(
                    MultimodalRequest.builder().audioData(new byte[] {1}).build())));
            assertEquals("ABSTAIN: SOURCE_REFERENCES_INCOMPLETE", result.getCombinedAnalysis());
        }

        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                new FakeMediaGateway(AudioResult.error("unused"), VisualResult.error("unused"), video),
                AudioVideoRuntimeSettings.defaults())) {
            VideoAudioResult result = runPromise(() -> Promise.of(
                    engine.analyseVideoWithAudio(new byte[] {1}, false, true, 1)));
            assertEquals("ABSTAIN: SOURCE_REFERENCES_INCOMPLETE", result.getCombinedNarrative());
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

    private static class FakeMediaGateway implements MultimodalMediaGateway {
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
