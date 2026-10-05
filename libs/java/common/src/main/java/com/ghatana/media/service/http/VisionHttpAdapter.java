package com.ghatana.media.service.http;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.*;
import com.ghatana.media.config.VisionConfig;
import com.ghatana.media.vision.api.*;
import tools.jackson.databind.ObjectMapper;
import io.activej.http.HttpRequest;
import io.activej.http.HttpResponse;
import io.activej.promise.Promise;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * HTTP REST adapter for Vision Engine.
 *
 * <p>Provides REST endpoints:
 * <ul>
 *   <li>POST /api/v1/vision/detect - Object detection</li>
 *   <li>GET /api/v1/vision/models - List available models</li>
 * </ul>
 *
 * @doc.type class
 * @doc.purpose HTTP REST adapter for Vision Engine service endpoints
 * @doc.layer platform
 * @doc.pattern Adapter
 */
public class VisionHttpAdapter {

    private final AudioVideoLibrary library;
    private final ObjectMapper mapper;

    public VisionHttpAdapter(VisionConfig config) {
        this.library = AudioVideoLibrary.builder()
            .withVisionConfig(config)
            .build();
        this.mapper = new ObjectMapper();
    }

    /**
     * Handle POST /api/v1/vision/detect
     */
    public Promise<HttpResponse> detect(HttpRequest request) {
        return Promise.ofBlocking(Runnable::run, () -> {
            var body = request.getBody();
            try {
                DetectRequest req = mapper.readValue(body.getString(StandardCharsets.UTF_8), DetectRequest.class);

                try (VisionEngine vision = library.getVisionEngine()) {
                    ImageData image = ImageData.builder()
                        .data(req.imageData)
                        .width(req.width)
                        .height(req.height)
                        .format(ImageFormat.valueOf(req.format))
                        .build();

                    DetectionOptions options = DetectionOptions.builder()
                        .confidenceThreshold(req.confidenceThreshold)
                        .maxDetections(req.maxDetections)
                        .enableTracking(req.enableTracking)
                        .build();

                    DetectionResult result = vision.detect(image, options);

                    DetectResponse response = new DetectResponse(
                        result.imageWidth(),
                        result.imageHeight(),
                        result.processingTimeMs(),
                        result.objects().stream()
                            .map(o -> new DetectedObjectJson(
                                o.className(),
                                o.confidence(),
                                new BoundingBoxJson(
                                    o.bbox().x(),
                                    o.bbox().y(),
                                    o.bbox().width(),
                                    o.bbox().height()
                                )
                            ))
                            .toList()
                    );

                    return HttpResponse.ok200()
                        .withJson(mapper.writeValueAsString(response))
                        .build();
                }
            } catch (ValidationError e) {
                return PlatformHttpErrorResponse.of(mapper, request, 400,
                    "INVALID_REQUEST", "Vision request is invalid", false);
            } catch (Exception e) {
                return PlatformHttpErrorResponse.of(mapper, request, 500,
                    "VISION_DETECTION_FAILED", "Vision detection failed", false);
            }
        });
    }

    /**
     * Handle GET /api/v1/vision/models
     */
    public Promise<HttpResponse> getModels(HttpRequest request) {
        return Promise.ofBlocking(Runnable::run, () -> {
            try (VisionEngine vision = library.getVisionEngine()) {
                List<DetectionModelInfo> models = vision.getAvailableModels();

                List<ModelJson> response = models.stream()
                    .map(m -> new ModelJson(
                        m.modelId(),
                        m.name(),
                        m.version(),
                        m.sizeBytes(),
                        m.supportsGpu(),
                        m.inputWidth(),
                        m.inputHeight()
                    ))
                    .toList();

                return HttpResponse.ok200()
                    .withJson(mapper.writeValueAsString(Map.of("models", response)))
                    .build();
            }
        });
    }

    public record DetectRequest(
        byte[] imageData,
        int width,
        int height,
        String format,
        float confidenceThreshold,
        int maxDetections,
        boolean enableTracking
    ) {}

    public record DetectResponse(
        int imageWidth,
        int imageHeight,
        long processingTimeMs,
        List<DetectedObjectJson> objects
    ) {}

    public record DetectedObjectJson(
        String className,
        double confidence,
        BoundingBoxJson bbox
    ) {}

    public record BoundingBoxJson(
        double x,
        double y,
        double width,
        double height
    ) {}

    public record ModelJson(
        String modelId,
        String name,
        String version,
        long sizeBytes,
        boolean supportsGpu,
        int inputWidth,
        int inputHeight
    ) {}
}
