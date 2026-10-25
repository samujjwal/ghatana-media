package com.ghatana.audio.video.vision.yolo;

import com.ghatana.audio.video.vision.model.BoundingBox;
import com.ghatana.audio.video.vision.model.DetectedObject;
import com.ghatana.audio.video.vision.model.ObjectAttributes;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Pure-Java mapping, clipping, provenance labeling, and class-wise NMS for parsed YOLO outputs. */
final class YoloDetectionPostProcessor {
    private YoloDetectionPostProcessor() { }

    static List<DetectedObject> process(List<YoloOutputParser.Detection> raw, List<String> classes,
            LetterboxTransform transform, double nmsThreshold, int orientation, Provenance provenance) {
        if (classes == null || classes.isEmpty() || classes.size() > 1000) {
            throw new IllegalArgumentException("A bounded model class mapping is required");
        }
        if (!Double.isFinite(nmsThreshold) || nmsThreshold < 0 || nmsThreshold > 1) {
            throw new IllegalArgumentException("NMS threshold must be in [0,1]");
        }
        if (orientation < 1 || orientation > 8 || provenance == null) {
            throw new IllegalArgumentException("Validated image orientation and model provenance are required");
        }
        List<DetectedObject> candidates = new ArrayList<>();
        for (YoloOutputParser.Detection detection : raw) {
            if (detection.classId() < 0 || detection.classId() >= classes.size()) {
                throw new IllegalArgumentException("YOLO output class id is not present in the admitted class mapping");
            }
            LetterboxTransform.Box sourceBox = transform.toSourcePixels(new LetterboxTransform.Box(
                    detection.x(), detection.y(), detection.width(), detection.height()));
            if (sourceBox.width() <= 0 || sourceBox.height() <= 0) continue;
            String orientationLabel = "EXIF_ORIENTATION_" + orientation
                    + (orientation == 1 ? "_OR_ABSENT" : "_APPLIED");
            ObjectAttributes attributes = ObjectAttributes.builder()
                    .size(objectSize(sourceBox.width(), sourceBox.height()))
                    .orientation(orientationLabel)
                    .additionalProperties(Map.of(
                            "bbox.coordinate_space", "exif_oriented_source_raster_pixel_xywh",
                            "confidence.unit", "raw_yolo_score_0_1_uncalibrated",
                            "input.color", "sRGB_composited_gray114_then_RGB_model_input",
                            "source.orientation", orientationLabel,
                            "source.content_version", "NOT_PROVIDED_BY_CONTRACT",
                            "model.id", provenance.modelId(),
                            "model.version", provenance.version(),
                            "model.sha256", provenance.sha256()))
                    .build();
            candidates.add(DetectedObject.builder()
                    .className(classes.get(detection.classId()))
                    .confidence(detection.confidence())
                    .boundingBox(BoundingBox.builder().x(sourceBox.x()).y(sourceBox.y())
                            .width(sourceBox.width()).height(sourceBox.height()).build())
                    .attributes(attributes)
                    .build());
        }
        return suppress(candidates, nmsThreshold);
    }

    private static List<DetectedObject> suppress(List<DetectedObject> detections, double threshold) {
        List<DetectedObject> filtered = new ArrayList<>();
        for (DetectedObject candidate : detections.stream()
                .sorted((left, right) -> Double.compare(right.getConfidence(), left.getConfidence()))
                .toList()) {
            boolean keep = filtered.stream().noneMatch(retained ->
                    candidate.getClassName().equals(retained.getClassName())
                            && candidate.getBoundingBox().calculateIoU(retained.getBoundingBox()) > threshold);
            if (keep) filtered.add(candidate);
        }
        return List.copyOf(filtered);
    }

    private static String objectSize(double width, double height) {
        double area = width * height;
        if (area < 10_000) return "small";
        if (area < 50_000) return "medium";
        return "large";
    }

    record Provenance(String modelId, String version, String sha256) {
        Provenance {
            if (modelId == null || modelId.isBlank() || version == null || version.isBlank()
                    || sha256 == null || !sha256.matches("[a-fA-F0-9]{64}")) {
                throw new IllegalArgumentException("Verified model identity, version, and SHA-256 are required");
            }
        }
    }
}
