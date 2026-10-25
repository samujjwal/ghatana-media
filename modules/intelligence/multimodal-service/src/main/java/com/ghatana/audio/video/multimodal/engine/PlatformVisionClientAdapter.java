package com.ghatana.audio.video.multimodal.engine;

import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.ghatana.media.common.BoundingBox;
import com.ghatana.media.common.ColorSpace;
import com.ghatana.media.common.ImageData;
import com.ghatana.media.common.ImageFormat;
import com.ghatana.media.vision.api.DetectedObject;
import com.ghatana.media.vision.api.DetectionOptions;
import com.ghatana.media.vision.api.VisionEngine;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

/** Routes multimodal vision calls through the published platform VisionEngine SPI. */
final class PlatformVisionClientAdapter implements VisionClientAdapter {
    private static final int MAX_IMAGE_BYTES = 16 * 1024 * 1024;
    private static final long MAX_IMAGE_PIXELS = 16_000_000L;
    private static final int MAX_VIDEO_BYTES = 32 * 1024 * 1024;
    private static final int MAX_FRAMES = 100;

    private final VisionEngine engine;
    private final VideoFrameExtractor frameExtractor;

    PlatformVisionClientAdapter(VisionEngine engine, VideoFrameExtractor frameExtractor,
                                AudioVideoRuntimeSettings settings) {
        this.engine = Objects.requireNonNull(engine, "public VisionEngine SPI unavailable");
        this.frameExtractor = Objects.requireNonNull(frameExtractor, "frameExtractor");
        Objects.requireNonNull(settings, "settings");
    }

    @Override
    public VisualResult detectObjects(byte[] imageData) {
        ImageData image = toImageData(imageData);
        var detections = engine.detect(image, DetectionOptions.defaults()).objects().stream()
                .map(PlatformVisionClientAdapter::toDetection).toList();
        String caption = Objects.requireNonNull(engine.caption(image), "Vision SPI returned no caption result");
        return VisualResult.builder().sceneDescription(caption).detections(detections)
                .build();
    }

    @Override
    public VisualResult analyseVideo(byte[] videoData, int sampleFps, int maxFrames) {
        if (videoData == null || videoData.length == 0 || videoData.length > MAX_VIDEO_BYTES) {
            throw new IllegalArgumentException("Video input is empty or exceeds the 32 MiB modality limit");
        }
        if (sampleFps < 1 || sampleFps > 60 || maxFrames < 1 || maxFrames > MAX_FRAMES) {
            throw new IllegalArgumentException("Video sampling exceeds the bounded FPS/frame limits");
        }
        Path directory = null;
        Path video = null;
        try {
            directory = Files.createTempDirectory("multimodal-vision-frames-");
            video = Files.createTempFile("multimodal-vision-", ".bin");
            Files.write(video, videoData);
            var config = VideoFrameExtractor.ExtractionConfig.builder()
                    .fps(sampleFps).maxFrames(maxFrames).format("jpg").build();
            List<VideoFrameExtractor.ExtractedFrame> frames = frameExtractor.extractFrames(video, directory, config);
            if (frames.size() > maxFrames) throw new IllegalStateException("Frame extractor exceeded requested frame limit");
            List<FrameResult> frameResults = new ArrayList<>();
            List<DetectionResult> allDetections = new ArrayList<>();
            String firstCaption = "";
            for (var frame : frames) {
                if (Files.size(frame.getPath()) > MAX_IMAGE_BYTES) {
                    throw new IllegalStateException("Extracted frame exceeds the 16 MiB image limit");
                }
                VisualResult result = detectObjects(Files.readAllBytes(frame.getPath()));
                if (result.isError()) throw new IllegalStateException("Vision provider returned an error result");
                if (frameResults.isEmpty()) firstCaption = result.getSceneDescription();
                frameResults.add(new FrameResult(frame.getFrameNumber(),
                        MediaClockTimestamp.fromSource(frame.getSourceTimestamp()), result.getDetections()));
                allDetections.addAll(result.getDetections());
            }
            return VisualResult.builder().sceneDescription(firstCaption).frameResults(frameResults)
                    .detections(allDetections).build();
        } catch (IOException e) {
            throw new IllegalStateException("Video frame extraction failed", e);
        } finally {
            delete(video);
            delete(directory);
        }
    }

    private ImageData toImageData(byte[] bytes) {
        if (bytes == null || bytes.length == 0 || bytes.length > MAX_IMAGE_BYTES) {
            throw new IllegalArgumentException("Image input is empty or exceeds the 16 MiB limit");
        }
        try {
            try (ImageInputStream input = ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
                if (input == null) throw new IllegalArgumentException("Unsupported or malformed image data");
                var readers = ImageIO.getImageReaders(input);
                if (!readers.hasNext()) throw new IllegalArgumentException("Unsupported or malformed image data");
                ImageReader reader = readers.next();
                try {
                    reader.setInput(input, true, true);
                    int width = reader.getWidth(0);
                    int height = reader.getHeight(0);
                    if (width <= 0 || height <= 0 || (long) width * height > MAX_IMAGE_PIXELS) {
                        throw new IllegalArgumentException("Image exceeds pixel limit");
                    }
                    // The SPI consumes original bytes; dimensions are read from the bounded header only.
                    ImageFormat format = bytes.length > 2 && (bytes[0] & 0xff) == 0xff && (bytes[1] & 0xff) == 0xd8
                            ? ImageFormat.JPEG : ImageFormat.PNG;
                    return new ImageData(bytes, width, height, format, ColorSpace.RGB);
                } finally {
                    reader.dispose();
                }
            }
        } catch (IOException e) {
            throw new IllegalArgumentException("Malformed image data", e);
        }
    }

    private static DetectionResult toDetection(DetectedObject object) {
        Objects.requireNonNull(object, "Vision SPI returned a null detection");
        BoundingBox box = object.bbox();
        if (box == null) throw new IllegalArgumentException("Vision SPI returned a detection without a bounding box");
        // Validate at the SPI boundary, before the value can reach a gRPC response.
        return new DetectionResult(object.className(), object.confidence(), box.x(), box.y(), box.width(), box.height());
    }

    private static void delete(Path path) {
        if (path == null) return;
        try {
            if (Files.isDirectory(path)) {
                try (var children = Files.list(path)) { children.forEach(PlatformVisionClientAdapter::delete); }
            }
            Files.deleteIfExists(path);
        } catch (IOException ignored) {
            // Scratch cleanup is best effort; processing outcome remains truthful.
        }
    }
}
