package com.ghatana.audio.video.vision.yolo;

import java.util.ArrayList;
import java.util.List;

/** Decoder for the upstream YOLOX-Nano raw [1,3549,85] output tensor. */
final class YoloXNanoOutputParser {
    static final int INPUT_SIZE = 416;
    static final int CLASS_COUNT = 80;
    static final int PREDICTION_COUNT = 3_549;
    static final int ATTRIBUTES = 5 + CLASS_COUNT;
    private static final int[] STRIDES = {8, 16, 32};
    private static final double MAX_LOG_SIZE = 20.0;
    private static final double MAX_COORDINATE = INPUT_SIZE * 16.0;

    private YoloXNanoOutputParser() { }

    static List<YoloOutputParser.Detection> decode(
            int batch, int predictions, int attributes, float[] values, double confidenceThreshold) {
        if (batch != 1 || predictions != PREDICTION_COUNT || attributes != ATTRIBUTES) {
            throw new IllegalArgumentException("YOLOX-Nano output shape must be exactly [1,3549,85]");
        }
        if (values == null || values.length != Math.multiplyExact(predictions, attributes)) {
            throw new IllegalArgumentException("YOLOX-Nano tensor element count does not match [1,3549,85]");
        }
        if (!Double.isFinite(confidenceThreshold) || confidenceThreshold < 0 || confidenceThreshold > 1) {
            throw new IllegalArgumentException("Confidence threshold must be in [0,1]");
        }

        List<YoloOutputParser.Detection> detections = new ArrayList<>();
        int prediction = 0;
        for (int stride : STRIDES) {
            int grid = INPUT_SIZE / stride;
            for (int gy = 0; gy < grid; gy++) {
                for (int gx = 0; gx < grid; gx++, prediction++) {
                    int offset = prediction * ATTRIBUTES;
                    float rawX = finite(values[offset], "center x");
                    float rawY = finite(values[offset + 1], "center y");
                    float rawW = finite(values[offset + 2], "width logit");
                    float rawH = finite(values[offset + 3], "height logit");
                    if (Math.abs(rawX) > MAX_COORDINATE || Math.abs(rawY) > MAX_COORDINATE
                            || Math.abs(rawW) > MAX_LOG_SIZE || Math.abs(rawH) > MAX_LOG_SIZE) {
                        throw new IllegalArgumentException("YOLOX-Nano coordinates are outside the supported decode bound");
                    }
                    float objectness = probability(values[offset + 4], "objectness");
                    int bestClass = -1;
                    float bestClassScore = -1;
                    for (int classId = 0; classId < CLASS_COUNT; classId++) {
                        float score = probability(values[offset + 5 + classId], "class score");
                        if (score > bestClassScore) {
                            bestClass = classId;
                            bestClassScore = score;
                        }
                    }
                    double confidence = objectness * bestClassScore;
                    // A zero score is never a positive model prediction, including when callers
                    // deliberately select the lowest legal threshold (0.0). Skipping it also
                    // keeps an all-zero tensor from expanding into thousands of empty boxes.
                    if (confidence <= 0.0 || confidence < confidenceThreshold) continue;

                    double centerX = (rawX + gx) * stride;
                    double centerY = (rawY + gy) * stride;
                    double width = Math.exp(rawW) * stride;
                    double height = Math.exp(rawH) * stride;
                    requireDecodedCoordinate(centerX, "center x");
                    requireDecodedCoordinate(centerY, "center y");
                    requireDecodedCoordinate(width, "width");
                    requireDecodedCoordinate(height, "height");
                    detections.add(new YoloOutputParser.Detection(bestClass, confidence,
                            centerX - width / 2.0, centerY - height / 2.0, width, height));
                }
            }
        }
        return List.copyOf(detections);
    }

    private static float finite(float value, String field) {
        if (!Float.isFinite(value)) throw new IllegalArgumentException("YOLOX-Nano " + field + " must be finite");
        return value;
    }

    private static float probability(float value, String field) {
        finite(value, field);
        if (value < 0 || value > 1) throw new IllegalArgumentException("YOLOX-Nano " + field + " must be in [0,1]");
        return value;
    }

    private static void requireDecodedCoordinate(double value, String field) {
        if (!Double.isFinite(value) || Math.abs(value) > MAX_COORDINATE || value <= 0 && !field.equals("center x")
                && !field.equals("center y")) {
            throw new IllegalArgumentException("YOLOX-Nano decoded " + field + " is outside the supported bound");
        }
    }
}
