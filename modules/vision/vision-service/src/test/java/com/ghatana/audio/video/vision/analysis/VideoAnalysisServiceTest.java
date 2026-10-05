package com.ghatana.audio.video.vision.analysis;

import com.ghatana.audio.video.vision.analysis.VideoAnalysisService.VideoAnalysisResult;
import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.model.BoundingBox;
import com.ghatana.audio.video.vision.model.DetectedObject;
import com.ghatana.audio.video.vision.model.DetectionOptions;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.lenient;
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
        assertThat(result.processingTime()).isNotNull(); 
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

    // ─── Helpers ───────────────────────────────────────────────────────────────

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
