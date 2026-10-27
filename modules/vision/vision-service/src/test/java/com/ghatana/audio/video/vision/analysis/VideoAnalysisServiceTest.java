package com.ghatana.audio.video.vision.analysis;

import com.ghatana.audio.video.vision.VisionLogCapture;
import com.ghatana.audio.video.vision.analysis.VideoAnalysisService.VideoAnalysisResult;
import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.model.BoundingBox;
import com.ghatana.audio.video.vision.model.DetectedObject;
import com.ghatana.audio.video.vision.model.DetectionOptions;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.ghatana.audio.video.vision.video.SourceMediaTimestamp;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import javax.imageio.ImageIO;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * Unit tests for {@link VideoAnalysisService} (AV-009.4). 
 */
@ExtendWith(MockitoExtension.class) 
@DisplayName("VideoAnalysisService — AV-009.4")
class VideoAnalysisServiceTest {

    @Mock
    private VisionDetector detector;

    @Mock
    private VideoFrameExtractor frameExtractor;

    @TempDir
    Path tempDir;

    private VideoAnalysisService service;
    private DetectionOptions defaultOptions;

    @BeforeEach
    void setUp() throws IOException { 
        service = VideoAnalysisService.builder() 
                .detector(detector) 
                .frameExtractor(frameExtractor) 
                .iouThreshold(0.5) 
                .build(); 
        defaultOptions = DetectionOptions.builder().confidenceThreshold(0.5).build(); 

        lenient().when(detector.isInitialized()).thenReturn(true); 
    }

    @Test
    @DisplayName("analyze processes frames and returns result with correct frame count")
    void analyzeReturnsCorrectFrameCount() throws IOException { 
        // Arrange: 3 frames in temp dir
        Path frame1 = tempDir.resolve("frame_0001.jpg");
        Path frame2 = tempDir.resolve("frame_0002.jpg");
        Path frame3 = tempDir.resolve("frame_0003.jpg");
        Files.write(frame1, new byte[]{0x01}); 
        Files.write(frame2, new byte[]{0x02}); 
        Files.write(frame3, new byte[]{0x03}); 

        List<VideoFrameExtractor.ExtractedFrame> frames = List.of( 
                new VideoFrameExtractor.ExtractedFrame(frame1, 0L, 0), 
                new VideoFrameExtractor.ExtractedFrame(frame2, 1000L, 1), 
                new VideoFrameExtractor.ExtractedFrame(frame3, 2000L, 2) 
        );

        Path fakeVideo = tempDir.resolve("test.mp4");
        Files.write(fakeVideo, new byte[]{0x00}); 

        when(frameExtractor.extractFrames(eq(fakeVideo), any(), any())).thenReturn(frames); 
        when(detector.detectObjects(any(), any())).thenReturn(List.of( 
                buildDetection("person", 0.90, 10, 10, 50, 100) 
        ));

        VideoFrameExtractor.ExtractionConfig config = VideoFrameExtractor.ExtractionConfig.builder() 
                .fps(1).maxFrames(3).build(); 

        // Act
        VideoAnalysisResult result = service.analyze(fakeVideo, config, defaultOptions); 

        // Assert
        assertThat(result.framesAnalysed()).isEqualTo(3); 
        assertThat(result.frameDetections()).hasSize(3); 
        assertThat(result.frameDetections().get(1).timestampMs()).isEqualTo(1000L);
        assertThat(result.frameDetections().get(1).sourceTimestamp().pts()).isEqualTo(1000L);
        assertThat(result.frameDetections().get(1).trackIds()).containsExactly(1);
        assertThat(result.trackingStatus()).isEqualTo("HEURISTIC_UNCALIBRATED");
        assertThat(result.processingTime()).isNotNull(); 
    }

    @Test
    @DisplayName("analyze logs do not include the source filename while result retains it")
    void analyzeDoesNotLogSourceFilename() throws IOException {
        Path video = tempDir.resolve("video-name-marker-private.mp4");
        when(frameExtractor.extractFrames(eq(video), any(), any())).thenReturn(List.of());
        try (VisionLogCapture logs = new VisionLogCapture(VideoAnalysisService.class)) {
            VideoAnalysisResult result = service.analyze(video,
                    VideoFrameExtractor.ExtractionConfig.builder().build(), defaultOptions);

            assertThat(result.videoName()).isEqualTo(video.getFileName().toString());
            String output = String.join("\n", logs.messages());
            assertThat(output).contains("Analysing 0 frames from video");
            assertThat(output).doesNotContain(video.getFileName().toString());
        }
    }

    @Test
    @DisplayName("classCounts returns aggregated object class frequencies")
    void classCountsAggregated() throws IOException { 
        Path frame1 = tempDir.resolve("frame_0001.jpg");
        Files.write(frame1, new byte[]{0x01}); 
        Path fakeVideo = tempDir.resolve("v.mp4");
        Files.write(fakeVideo, new byte[]{0x00}); 

        when(frameExtractor.extractFrames(any(), any(), any())).thenReturn(List.of( 
                new VideoFrameExtractor.ExtractedFrame(frame1, 0L, 0) 
        ));
        when(detector.detectObjects(any(), any())).thenReturn(List.of( 
                buildDetection("person", 0.9, 0, 0, 50, 100), 
                buildDetection("car", 0.8, 100, 0, 50, 50) 
        ));

        VideoFrameExtractor.ExtractionConfig config = VideoFrameExtractor.ExtractionConfig.builder().fps(1).build(); 
        VideoAnalysisResult result = service.analyze(fakeVideo, config, defaultOptions); 

        Map<String, Long> counts = result.classCounts(); 
        assertThat(counts).containsKey("person");
        assertThat(counts).containsKey("car");
    }

    @Test
    @DisplayName("analyze with no detections returns result with 0 tracks")
    void analyzeNoDetections() throws IOException { 
        Path frame1 = tempDir.resolve("frame_0001.jpg");
        Files.write(frame1, new byte[]{0x01}); 
        Path fakeVideo = tempDir.resolve("v.mp4");
        Files.write(fakeVideo, new byte[]{0x00}); 

        when(frameExtractor.extractFrames(any(), any(), any())).thenReturn(List.of( 
                new VideoFrameExtractor.ExtractedFrame(frame1, 0L, 0) 
        ));
        when(detector.detectObjects(any(), any())).thenReturn(List.of()); 

        VideoFrameExtractor.ExtractionConfig config = VideoFrameExtractor.ExtractionConfig.builder().fps(1).build(); 
        VideoAnalysisResult result = service.analyze(fakeVideo, config, defaultOptions); 

        assertThat(result.uniqueTracks()).isEqualTo(0); 
    }

    @Test
    void actualPixelCutProducesOnlyAnUncalibratedTimestampedCandidate() throws IOException {
        Path darkFrame = writeSolidPng("dark.png", 0x000000);
        Path brightFrame = writeSolidPng("bright.png", 0xffffff);
        Path video = tempDir.resolve("pixel-cut.mp4");
        Files.write(video, new byte[] {0});
        when(frameExtractor.extractFrames(any(), any(), any())).thenReturn(List.of(
                new VideoFrameExtractor.ExtractedFrame(darkFrame,
                        SourceMediaTimestamp.fromPts("0", "1/25"), 0),
                new VideoFrameExtractor.ExtractedFrame(brightFrame,
                        SourceMediaTimestamp.fromPts("1", "1/25"), 1)));
        when(detector.detectObjects(any(), any())).thenReturn(List.of());

        VideoAnalysisResult result = service.analyze(video,
                VideoFrameExtractor.ExtractionConfig.builder().fps(1).build(), defaultOptions);

        assertThat(result.shotBoundaryStatus()).isEqualTo("HEURISTIC_UNCALIBRATED");
        assertThat(result.shotBoundaryAssessments()).hasSize(1);
        var assessment = result.shotBoundaryAssessments().getFirst();
        assertThat(assessment.disposition()).isEqualTo(ShotBoundaryHeuristic.Disposition.BOUNDARY_CANDIDATE);
        assertThat(assessment.sourceTimestamp().pts()).isEqualTo(1L);
        assertThat(assessment.meanAbsoluteLumaDifference()).isEqualTo(1.0);
        assertThat(assessment.methodStatus()).isEqualTo("HEURISTIC_UNCALIBRATED");
        assertThat(assessment.uncertaintyDisposition()).isEqualTo("QUALITATIVE");
    }

    @Test
    void shotBoundaryCandidateBreaksHeuristicTrackIdentityAcrossTheCut() throws IOException {
        Path darkFrame = writeSolidPng("track-cut-dark.png", 0x000000);
        Path brightFrame = writeSolidPng("track-cut-bright.png", 0xffffff);
        Path video = tempDir.resolve("track-cut.mp4");
        Files.write(video, new byte[] {0});
        when(frameExtractor.extractFrames(any(), any(), any())).thenReturn(List.of(
                new VideoFrameExtractor.ExtractedFrame(darkFrame,
                        SourceMediaTimestamp.fromPts("0", "1/25"), 0),
                new VideoFrameExtractor.ExtractedFrame(brightFrame,
                        SourceMediaTimestamp.fromPts("1", "1/25"), 1)));
        DetectedObject sameBox = buildDetection("person", 0.9, 10, 10, 20, 30);
        when(detector.detectObjects(any(), any())).thenReturn(List.of(sameBox), List.of(sameBox));

        VideoAnalysisResult result = service.analyze(video,
                VideoFrameExtractor.ExtractionConfig.builder().fps(1).build(), defaultOptions);

        assertThat(result.shotBoundaryAssessments().getFirst().disposition())
                .isEqualTo(ShotBoundaryHeuristic.Disposition.BOUNDARY_CANDIDATE);
        assertThat(result.frameDetections()).extracting(frame -> frame.sourceTimestamp().pts())
                .containsExactly(0L, 1L);
        // The pixel-change result is an uncalibrated candidate; conservatively do not carry
        // a local heuristic ID across that uncertain boundary as if identity were established.
        assertThat(result.frameDetections()).extracting(frame -> frame.trackIds().getFirst())
                .containsExactly(1, 2);
        assertThat(result.trackingStatus()).isEqualTo("HEURISTIC_UNCALIBRATED");
    }

    @Test
    void shotBoundaryCandidateMakesCameraMotionUnknownForThatFramePair() throws IOException {
        Path darkFrame = writeSolidPng("motion-cut-dark.png", 0x000000);
        Path brightFrame = writeSolidPng("motion-cut-bright.png", 0xffffff);
        Path video = tempDir.resolve("motion-cut.mp4");
        Files.write(video, new byte[] {0});
        when(frameExtractor.extractFrames(any(), any(), any())).thenReturn(List.of(
                new VideoFrameExtractor.ExtractedFrame(darkFrame,
                        SourceMediaTimestamp.fromPts("0", "1/25"), 0),
                new VideoFrameExtractor.ExtractedFrame(brightFrame,
                        SourceMediaTimestamp.fromPts("1", "1/25"), 1)));
        when(detector.detectObjects(any(), any())).thenReturn(List.of());

        VideoAnalysisResult result = service.analyze(video,
                VideoFrameExtractor.ExtractionConfig.builder().fps(1).build(), defaultOptions);

        assertThat(result.shotBoundaryAssessments()).hasSize(1);
        assertThat(result.shotBoundaryAssessments().getFirst().disposition())
                .isEqualTo(ShotBoundaryHeuristic.Disposition.BOUNDARY_CANDIDATE);
        assertThat(result.cameraMotionAssessments()).hasSize(1);
        var cameraMotion = result.cameraMotionAssessments().getFirst();
        assertThat(cameraMotion.disposition()).isEqualTo(CameraMotionHeuristic.Disposition.UNKNOWN);
        assertThat(cameraMotion.unknownReason())
                .isEqualTo(CameraMotionHeuristic.UnknownReason.SHOT_BOUNDARY_CANDIDATE);
        assertThat(cameraMotion.xTranslationPixels()).isNull();
        assertThat(cameraMotion.yTranslationPixels()).isNull();
        assertThat(cameraMotion.uncertaintyDisposition()).isEqualTo("UNKNOWN");
    }

    @Test
    void unchangedFramePixelsDoNotProduceShotBoundaryCandidate() throws IOException {
        Path firstFrame = writeSolidPng("same-1.png", 0x808080);
        Path secondFrame = writeSolidPng("same-2.png", 0x808080);
        Path video = tempDir.resolve("same-pixels.mp4");
        Files.write(video, new byte[] {0});
        when(frameExtractor.extractFrames(any(), any(), any())).thenReturn(List.of(
                new VideoFrameExtractor.ExtractedFrame(firstFrame,
                        SourceMediaTimestamp.fromPts("0", "1/25"), 0),
                new VideoFrameExtractor.ExtractedFrame(secondFrame,
                        SourceMediaTimestamp.fromPts("1", "1/25"), 1)));
        when(detector.detectObjects(any(), any())).thenReturn(List.of());

        VideoAnalysisResult result = service.analyze(video,
                VideoFrameExtractor.ExtractionConfig.builder().fps(1).build(), defaultOptions);

        var assessment = result.shotBoundaryAssessments().getFirst();
        assertThat(assessment.disposition()).isEqualTo(ShotBoundaryHeuristic.Disposition.NO_BOUNDARY_CANDIDATE);
        assertThat(assessment.meanAbsoluteLumaDifference()).isEqualTo(0.0);
    }

    @Test
    void unknownPtsOrMissingEmittedFrameYieldsUnknownShotBoundaryAssessment() throws IOException {
        Path firstFrame = writeSolidPng("unknown-1.png", 0x000000);
        Path secondFrame = writeSolidPng("unknown-2.png", 0xffffff);
        Path thirdFrame = writeSolidPng("unknown-3.png", 0xffffff);
        Path video = tempDir.resolve("unknown-cut.mp4");
        Files.write(video, new byte[] {0});
        when(frameExtractor.extractFrames(any(), any(), any())).thenReturn(List.of(
                new VideoFrameExtractor.ExtractedFrame(firstFrame,
                        SourceMediaTimestamp.unknown("SOURCE_PTS_MISSING"), 0),
                new VideoFrameExtractor.ExtractedFrame(secondFrame,
                        SourceMediaTimestamp.fromPts("1", "1/25"), 1),
                new VideoFrameExtractor.ExtractedFrame(thirdFrame,
                        SourceMediaTimestamp.fromPts("2", "1/25"), 3)));
        when(detector.detectObjects(any(), any())).thenReturn(List.of());

        VideoAnalysisResult result = service.analyze(video,
                VideoFrameExtractor.ExtractionConfig.builder().fps(1).build(), defaultOptions);

        assertThat(result.shotBoundaryAssessments()).extracting(ShotBoundaryHeuristic.Assessment::disposition)
                .containsExactly(ShotBoundaryHeuristic.Disposition.UNKNOWN,
                        ShotBoundaryHeuristic.Disposition.UNKNOWN);
        assertThat(result.shotBoundaryAssessments().get(0).unknownReason())
                .isEqualTo(ShotBoundaryHeuristic.UnknownReason.SOURCE_TIMESTAMP_UNKNOWN);
        assertThat(result.shotBoundaryAssessments().get(1).unknownReason())
                .isEqualTo(ShotBoundaryHeuristic.UnknownReason.FRAME_GAP);
        assertThat(result.shotBoundaryAssessments()).allSatisfy(assessment ->
                assertThat(assessment.meanAbsoluteLumaDifference()).isNull());
    }

    @Test
    void malformedFramePixelsYieldUnknownShotBoundaryAssessment() throws IOException {
        Path validFrame = writeSolidPng("valid-pixels.png", 0x000000);
        Path malformedFrame = tempDir.resolve("malformed-pixels.jpg");
        Files.write(malformedFrame, new byte[] {0, 1, 2, 3});
        Path video = tempDir.resolve("malformed-frame-pixels.mp4");
        Files.write(video, new byte[] {0});
        when(frameExtractor.extractFrames(any(), any(), any())).thenReturn(List.of(
                new VideoFrameExtractor.ExtractedFrame(validFrame,
                        SourceMediaTimestamp.fromPts("0", "1/25"), 0),
                new VideoFrameExtractor.ExtractedFrame(malformedFrame,
                        SourceMediaTimestamp.fromPts("1", "1/25"), 1)));
        when(detector.detectObjects(any(), any())).thenReturn(List.of());

        VideoAnalysisResult result = service.analyze(video,
                VideoFrameExtractor.ExtractionConfig.builder().fps(1).build(), defaultOptions);

        var assessment = result.shotBoundaryAssessments().getFirst();
        assertThat(assessment.disposition()).isEqualTo(ShotBoundaryHeuristic.Disposition.UNKNOWN);
        assertThat(assessment.unknownReason()).isEqualTo(ShotBoundaryHeuristic.UnknownReason.FRAME_PIXELS_UNAVAILABLE);
        assertThat(assessment.meanAbsoluteLumaDifference()).isNull();
    }

    @Test
    void reorderedSourcePtsYieldUnknownShotBoundaryAssessment() throws IOException {
        Path firstFrame = writeSolidPng("reordered-1.png", 0x000000);
        Path secondFrame = writeSolidPng("reordered-2.png", 0xffffff);
        Path video = tempDir.resolve("reordered-shot-boundary.mp4");
        Files.write(video, new byte[] {0});
        when(frameExtractor.extractFrames(any(), any(), any())).thenReturn(List.of(
                new VideoFrameExtractor.ExtractedFrame(firstFrame,
                        SourceMediaTimestamp.fromPts("2", "1/25"), 0),
                new VideoFrameExtractor.ExtractedFrame(secondFrame,
                        SourceMediaTimestamp.fromPts("1", "1/25"), 1)));
        when(detector.detectObjects(any(), any())).thenReturn(List.of());

        VideoAnalysisResult result = service.analyze(video,
                VideoFrameExtractor.ExtractionConfig.builder().fps(1).build(), defaultOptions);

        var assessment = result.shotBoundaryAssessments().getFirst();
        assertThat(assessment.disposition()).isEqualTo(ShotBoundaryHeuristic.Disposition.UNKNOWN);
        assertThat(assessment.unknownReason())
                .isEqualTo(ShotBoundaryHeuristic.UnknownReason.SOURCE_TIMESTAMP_NOT_MONOTONIC);
        assertThat(assessment.meanAbsoluteLumaDifference()).isNull();
    }

    @Test
    void unknownSourcePtsPropagatesAndStartsFreshHeuristicTrackEpoch() throws IOException {
        Path frame = tempDir.resolve("frame_unknown.jpg");
        Files.write(frame, new byte[] {1});
        Path fakeVideo = tempDir.resolve("unknown.mp4");
        Files.write(fakeVideo, new byte[] {0});
        when(frameExtractor.extractFrames(any(), any(), any())).thenReturn(List.of(
                new VideoFrameExtractor.ExtractedFrame(frame,
                        SourceMediaTimestamp.unknown("SOURCE_PTS_MISSING"), 0)));
        when(detector.detectObjects(any(), any())).thenReturn(List.of(
                buildDetection("person", 0.9, 0, 0, 50, 100)));

        var result = service.analyze(fakeVideo,
                VideoFrameExtractor.ExtractionConfig.builder().fps(1).build(), defaultOptions);

        assertThat(result.frameDetections().getFirst().timestampMs()).isNull();
        assertThat(result.frameDetections().getFirst().sourceTimestamp().reason()).isEqualTo("SOURCE_PTS_MISSING");
        assertThat(result.frameDetections().getFirst().trackIds()).containsExactly(1);
        assertThat(result.uniqueTracks()).isEqualTo(1);
        assertThat(result.trackingStatus()).isEqualTo("HEURISTIC_UNCALIBRATED");
    }

    @Test
    void iouAssociatesSameClassDetectionsAndBreaksTiesConservatively() throws IOException {
        Path f0 = tempDir.resolve("tie-0.jpg"), f1 = tempDir.resolve("tie-1.jpg");
        Files.write(f0, new byte[] {1}); Files.write(f1, new byte[] {2});
        Path video = tempDir.resolve("tie.mp4"); Files.write(video, new byte[] {0});
        when(frameExtractor.extractFrames(any(), any(), any())).thenReturn(List.of(
                new VideoFrameExtractor.ExtractedFrame(f0, SourceMediaTimestamp.fromPts("0", "1/1"), 0),
                new VideoFrameExtractor.ExtractedFrame(f1, SourceMediaTimestamp.fromPts("1", "1/1"), 1)));
        when(detector.detectObjects(any(), any())).thenReturn(
                List.of(buildDetection("car", .9, 0, 0, 20, 10), buildDetection("car", .8, 10, 0, 20, 10)),
                List.of(buildDetection("car", .9, 5, 0, 20, 10)));

        var result = service.analyze(video, VideoFrameExtractor.ExtractionConfig.builder().fps(1).build(), defaultOptions);
        assertThat(result.frameDetections().get(0).trackIds()).containsExactly(1, 2);
        assertThat(result.frameDetections().get(1).trackIds()).containsExactly(3); // equal IoU tie => no identity guess
    }

    @Test
    void unknownPtsLargeGapAndReorderedPtsDoNotBridgeTrackIds() throws IOException {
        Path a = tempDir.resolve("epoch-a.jpg"), b = tempDir.resolve("epoch-b.jpg"), c = tempDir.resolve("epoch-c.jpg");
        Files.write(a, new byte[] {1}); Files.write(b, new byte[] {2}); Files.write(c, new byte[] {3});
        Path video = tempDir.resolve("epochs.mp4"); Files.write(video, new byte[] {0});
        when(frameExtractor.extractFrames(any(), any(), any())).thenReturn(List.of(
                new VideoFrameExtractor.ExtractedFrame(a, SourceMediaTimestamp.fromPts("2", "1/1"), 0),
                new VideoFrameExtractor.ExtractedFrame(b, SourceMediaTimestamp.fromPts("1", "1/1"), 1),
                new VideoFrameExtractor.ExtractedFrame(c, SourceMediaTimestamp.fromPts("100", "1/1"), 2)));
        when(detector.detectObjects(any(), any())).thenReturn(
                List.of(buildDetection("person", .9, 0, 0, 10, 10)));

        var result = service.analyze(video, VideoFrameExtractor.ExtractionConfig.builder().fps(1).build(), defaultOptions);
        assertThat(result.frameDetections()).extracting(d -> d.sourceTimestamp().pts()).containsExactly(2L, 1L, 100L);
        assertThat(result.frameDetections()).extracting(d -> d.trackIds().getFirst()).containsExactly(1, 2, 3);
    }

    @Test
    void missingEmittedFrameOrdinalBreaksHeuristicTrackEpoch() throws IOException {
        Path a = tempDir.resolve("missing-a.jpg"), b = tempDir.resolve("missing-b.jpg");
        Files.write(a, new byte[] {1});
        Files.write(b, new byte[] {2});
        Path video = tempDir.resolve("missing-ordinal.mp4");
        Files.write(video, new byte[] {0});
        when(frameExtractor.extractFrames(any(), any(), any())).thenReturn(List.of(
                new VideoFrameExtractor.ExtractedFrame(a, SourceMediaTimestamp.fromPts("0", "1/10"), 4),
                // PTS gap is within the normal sampling tolerance, but emitted ordinal 5 is absent.
                new VideoFrameExtractor.ExtractedFrame(b, SourceMediaTimestamp.fromPts("1", "1/10"), 6)));
        when(detector.detectObjects(any(), any())).thenReturn(
                List.of(buildDetection("person", .9, 0, 0, 10, 10)));

        var result = service.analyze(video, VideoFrameExtractor.ExtractionConfig.builder().fps(1).build(), defaultOptions);

        assertThat(result.frameDetections()).extracting(d -> d.frameNumber()).containsExactly(4, 6);
        assertThat(result.frameDetections()).extracting(d -> d.trackIds().getFirst()).containsExactly(1, 2);
        assertThat(result.trackingStatus()).isEqualTo("HEURISTIC_UNCALIBRATED");
    }

    @Test
    void frameObservationsRequireNonNegativeOrdinalAndSnapshotTheirCollections() {
        var timestamp = SourceMediaTimestamp.fromPts("90000", "1/90000");
        List<DetectedObject> detections = new java.util.ArrayList<>(List.of(
                buildDetection("person", 0.9, 1, 2, 3, 4)));
        List<Integer> trackIds = new java.util.ArrayList<>(List.of(7));
        var observation = new VideoAnalysisService.FrameDetections(
                2, timestamp.timestampMs(), timestamp, detections, trackIds);

        detections.clear();
        trackIds.clear();
        assertThat(observation.detections()).hasSize(1);
        assertThat(observation.trackIds()).containsExactly(7);
        assertThatThrownBy(() -> new VideoAnalysisService.FrameDetections(
                -1, timestamp.timestampMs(), timestamp, List.of(), List.of()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("non-negative emitted-frame ordinal");
        assertThatThrownBy(() -> new VideoAnalysisService.FrameDetections(
                0, timestamp.timestampMs(), timestamp,
                List.of(buildDetection("person", 0.9, 1, 2, 3, 4)), List.of()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("exactly one track ID");
        assertThatThrownBy(() -> new VideoAnalysisService.FrameDetections(
                0, timestamp.timestampMs(), timestamp,
                List.of(buildDetection("person", 0.9, 1, 2, 3, 4)), List.of(0)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("positive and unique");
    }

    @Test
    void analysisResultSnapshotsFrameTimeline() {
        List<VideoAnalysisService.FrameDetections> timeline = new java.util.ArrayList<>();
        var result = new VideoAnalysisResult("clip.mp4", java.time.Instant.EPOCH, 0, 0,
                timeline, java.time.Duration.ZERO, "NOT_ADMITTED");

        timeline.add(new VideoAnalysisService.FrameDetections(0,
                SourceMediaTimestamp.unknown("SOURCE_PTS_MISSING").timestampMs(),
                SourceMediaTimestamp.unknown("SOURCE_PTS_MISSING"), List.of(), List.of()));
        assertThat(result.frameDetections()).isEmpty();
        assertThatThrownBy(() -> new VideoAnalysisResult("clip.mp4", java.time.Instant.EPOCH,
                1, 0, List.of(), java.time.Duration.ZERO, "HEURISTIC_UNCALIBRATED"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("counts must match");
    }

    @Test
    void rationalClockEqualityAndUnknownPtsDoNotBridgeHeuristicTrackEpochs() throws IOException {
        Path a = tempDir.resolve("clock-a.jpg"), b = tempDir.resolve("clock-b.jpg"), c = tempDir.resolve("clock-c.jpg");
        Files.write(a, new byte[] {1}); Files.write(b, new byte[] {2}); Files.write(c, new byte[] {3});
        Path video = tempDir.resolve("clock-epochs.mp4"); Files.write(video, new byte[] {0});
        when(frameExtractor.extractFrames(any(), any(), any())).thenReturn(List.of(
                new VideoFrameExtractor.ExtractedFrame(a, SourceMediaTimestamp.fromPts("90000", "1/90000"), 0),
                new VideoFrameExtractor.ExtractedFrame(b, SourceMediaTimestamp.unknown("SOURCE_PTS_MISSING"), 1),
                new VideoFrameExtractor.ExtractedFrame(c, SourceMediaTimestamp.fromPts("2", "1/2"), 2)));
        when(detector.detectObjects(any(), any())).thenReturn(
                List.of(buildDetection("person", 0.9, 0, 0, 10, 10)));

        var result = service.analyze(video, VideoFrameExtractor.ExtractionConfig.builder().fps(1).build(), defaultOptions);

        assertThat(result.frameDetections()).extracting(d -> d.timestampMs()).containsExactly(1000L, null, 1000L);
        assertThat(result.frameDetections()).extracting(d -> d.trackIds().getFirst()).containsExactly(1, 2, 3);
        assertThat(result.uniqueTracks()).isEqualTo(3);
    }

    @Test
    void refusesFramesBeyondExtractionBudgetBeforeDetection() throws IOException {
        Path first = tempDir.resolve("over-budget-1.jpg");
        Path second = tempDir.resolve("over-budget-2.jpg");
        Files.write(first, new byte[] {1});
        Files.write(second, new byte[] {2});
        Path fakeVideo = tempDir.resolve("over-budget.mp4");
        Files.write(fakeVideo, new byte[] {0});
        when(frameExtractor.extractFrames(eq(fakeVideo), any(), any())).thenReturn(List.of(
                new VideoFrameExtractor.ExtractedFrame(first, SourceMediaTimestamp.fromPts("0", "1/1000"), 0),
                new VideoFrameExtractor.ExtractedFrame(second, SourceMediaTimestamp.fromPts("1", "1/1000"), 1)));

        assertThatThrownBy(() -> service.analyze(fakeVideo,
                VideoFrameExtractor.ExtractionConfig.builder().maxFrames(1).build(), defaultOptions))
                .isInstanceOf(VideoAnalysisService.VideoAnalysisException.class)
                .hasMessageContaining("configured frame-count limit");
        verifyNoInteractions(detector);
    }

    @Test
    @DisplayName("Builder rejects null detector")
    void builderRejectsNullDetector() { 
        assertThatThrownBy(() -> VideoAnalysisService.builder() 
                .frameExtractor(frameExtractor) 
                .build()) 
                .isInstanceOf(NullPointerException.class); 
    }

    @Test
    @DisplayName("Builder rejects invalid IoU threshold")
    void builderRejectsInvalidIou() { 
        assertThatThrownBy(() -> VideoAnalysisService.builder().iouThreshold(1.5)) 
                .isInstanceOf(IllegalArgumentException.class); 
    }

    @Test
    @DisplayName("Builder rejects non-finite IoU and accepts inclusive bounds")
    void builderRejectsNonFiniteIouAndAcceptsInclusiveBounds() {
        for (double invalid : new double[] {
                Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY
        }) {
            assertThatThrownBy(() -> VideoAnalysisService.builder().iouThreshold(invalid))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        for (double boundary : new double[] {0.0, 1.0}) {
            org.assertj.core.api.Assertions.assertThatCode(
                    () -> VideoAnalysisService.builder().iouThreshold(boundary))
                    .doesNotThrowAnyException();
        }
    }

    // ─── Helpers ───────────────────────────────────────────────────────────────

    private Path writeSolidPng(String name, int rgb) throws IOException {
        BufferedImage image = new BufferedImage(32, 32, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < image.getHeight(); y++) {
            for (int x = 0; x < image.getWidth(); x++) image.setRGB(x, y, rgb);
        }
        Path path = tempDir.resolve(name);
        try (ByteArrayOutputStream encoded = new ByteArrayOutputStream()) {
            ImageIO.write(image, "png", encoded);
            Files.write(path, encoded.toByteArray());
        }
        return path;
    }

    private DetectedObject buildDetection(String className, double confidence, 
                                           double x, double y, double w, double h) {
        BoundingBox bbox = BoundingBox.builder().x(x).y(y).width(w).height(h).build(); 
        return DetectedObject.builder() 
                .className(className) 
                .confidence(confidence) 
                .boundingBox(bbox) 
                .build(); 
    }
}
