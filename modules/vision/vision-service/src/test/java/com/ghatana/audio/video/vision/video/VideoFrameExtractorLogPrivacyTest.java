package com.ghatana.audio.video.vision.video;

import com.ghatana.audio.video.vision.VisionLogCapture;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

class VideoFrameExtractorLogPrivacyTest {
    @TempDir Path tempDir;

    @Test
    void emptyExtractionLogDoesNotIncludeOutputDirectory() throws Exception {
        Path outputDirectory = Files.createDirectory(tempDir.resolve("output-path-marker-private"));
        VideoFrameExtractor extractor = new VideoFrameExtractor();

        try (VisionLogCapture logs = new VisionLogCapture(VideoFrameExtractor.class)) {
            assertThat(extractor.collectExtractedFrames(outputDirectory,
                    VideoFrameExtractor.ExtractionConfig.builder().build())).isEmpty();

            String output = String.join("\n", logs.messages());
            assertThat(output).contains("No frames extracted");
            assertThat(output).doesNotContain(outputDirectory.toString());
        }
    }
}
