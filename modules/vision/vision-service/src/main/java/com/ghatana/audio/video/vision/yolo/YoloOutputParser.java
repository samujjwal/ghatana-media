package com.ghatana.audio.video.vision.yolo;

import java.util.ArrayList;
import java.util.List;

/** Pure-Java decoder for the admitted YOLOv8 ONNX [1, 4 + classes, boxes] float tensor layout. */
final class YoloOutputParser {
    static final int MAX_BOXES = 30_000;
    private static final float MAX_ABS_MODEL_COORDINATE = 640.0f * 16.0f;

    private YoloOutputParser() { }

    static List<Detection> parse(int batch, int channels, int boxes, float[] tensor,
            int classCount, double confidenceThreshold) {
        if (batch != 1) throw new IllegalArgumentException("YOLO output batch dimension must be 1");
        if (classCount < 1 || classCount > 1000 || channels != 4 + classCount) {
            throw new IllegalArgumentException("YOLO output must use [cx,cy,w,h,class scores] channel layout");
        }
        if (boxes < 1 || boxes > MAX_BOXES) {
            throw new IllegalArgumentException("YOLO output box count is outside the supported bound");
        }
        if (tensor == null || tensor.length != Math.multiplyExact(channels, boxes)) {
            throw new IllegalArgumentException("YOLO output tensor size does not match its declared shape");
        }
        if (!Double.isFinite(confidenceThreshold) || confidenceThreshold < 0 || confidenceThreshold > 1) {
            throw new IllegalArgumentException("Confidence threshold must be in [0,1]");
        }

        List<Detection> result = new ArrayList<>();
        for (int box = 0; box < boxes; box++) {
            float centerX = at(tensor, channels, 0, box);
            float centerY = at(tensor, channels, 1, box);
            float width = at(tensor, channels, 2, box);
            float height = at(tensor, channels, 3, box);
            requireCoordinate(centerX, "center x");
            requireCoordinate(centerY, "center y");
            requireCoordinate(width, "width");
            requireCoordinate(height, "height");
            if (width <= 0 || height <= 0) {
                throw new IllegalArgumentException("YOLO output box dimensions must be positive");
            }

            float bestScore = -1;
            int bestClass = -1;
            for (int classIndex = 0; classIndex < classCount; classIndex++) {
                float score = at(tensor, channels, 4 + classIndex, box);
                if (!Float.isFinite(score) || score < 0 || score > 1) {
                    throw new IllegalArgumentException("YOLO class scores must be finite values in [0,1]");
                }
                if (score > bestScore) {
                    bestScore = score;
                    bestClass = classIndex;
                }
            }
            if (bestScore >= confidenceThreshold) {
                result.add(new Detection(bestClass, bestScore,
                        centerX - width / 2.0, centerY - height / 2.0, width, height));
            }
        }
        return List.copyOf(result);
    }

    private static float at(float[] tensor, int channels, int channel, int box) {
        return tensor[channel * (tensor.length / channels) + box];
    }

    private static void requireCoordinate(float value, String name) {
        if (!Float.isFinite(value) || Math.abs(value) > MAX_ABS_MODEL_COORDINATE) {
            throw new IllegalArgumentException("YOLO output " + name + " is non-finite or outside supported bounds");
        }
    }

    record Detection(int classId, double confidence, double x, double y, double width, double height) { }
}
