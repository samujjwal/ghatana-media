package com.ghatana.audio.video.vision.yolo;

import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.model.BoundingBox;
import com.ghatana.audio.video.vision.model.DetectedObject;
import com.ghatana.audio.video.vision.model.DetectionOptions;
import com.ghatana.audio.video.vision.model.ObjectAttributes;
import org.opencv.core.Core;
import org.opencv.core.CvType;
import org.opencv.core.Mat;
import org.opencv.core.MatOfInt;
import org.opencv.core.Scalar;
import org.opencv.core.Size;
import org.opencv.dnn.Dnn;
import org.opencv.dnn.Net;
import org.opencv.imgproc.Imgproc;
import org.scijava.nativelib.NativeLoader;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * YOLOv8 ONNX adapter for object detection through OpenCV DNN.
 *
 * <p>Every request releases all transient {@link Mat} instances deterministically. The adapter is
 * lifecycle-owned by the production Vision service and rejects use after close. OpenCV's Java
 * {@link Net} wrapper has no public close operation in the supported API, so close removes the
 * provider reference after all request-owned native matrices have been released.
 *
 * @doc.type component
 * @doc.purpose Object detection using a YOLOv8 ONNX model
 * @doc.layer vision-core
 * @doc.pattern Adapter
 */
public final class YoloV8Adapter implements VisionDetector, AutoCloseable {

    private static final Logger LOG = LoggerFactory.getLogger(YoloV8Adapter.class);
    private static final int INPUT_SIZE = 640;

    private static final List<String> COCO_CLASSES = List.of(
            "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck",
            "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench",
            "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra",
            "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
            "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove",
            "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup", "fork",
            "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange", "broccoli",
            "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant",
            "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard",
            "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator", "book",
            "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush");

    static {
        try {
            NativeLoader.loadLibrary(Core.NATIVE_LIBRARY_NAME);
            LOG.info("OpenCV native library loaded successfully");
        } catch (Exception failure) {
            LOG.error("Failed to load OpenCV native library", failure);
            throw new ExceptionInInitializerError(failure);
        }
    }

    private final AtomicBoolean initialized = new AtomicBoolean();
    private final AtomicBoolean closed = new AtomicBoolean();
    private final Path modelDirectory;
    private final Map<String, Integer> classMapping;
    private final double confidenceThreshold;
    private final double nmsThreshold;
    private volatile Net net;

    public YoloV8Adapter(Path modelDirectory, double confidenceThreshold, double nmsThreshold) {
        this.modelDirectory = Objects.requireNonNull(modelDirectory, "modelDirectory")
                .toAbsolutePath()
                .normalize();
        if (!Double.isFinite(confidenceThreshold)
                || confidenceThreshold < 0.0
                || confidenceThreshold > 1.0) {
            throw new IllegalArgumentException("confidenceThreshold must be in [0.0, 1.0]");
        }
        if (!Double.isFinite(nmsThreshold) || nmsThreshold < 0.0 || nmsThreshold > 1.0) {
            throw new IllegalArgumentException("nmsThreshold must be in [0.0, 1.0]");
        }
        this.confidenceThreshold = confidenceThreshold;
        this.nmsThreshold = nmsThreshold;
        this.classMapping = createClassMapping();
    }

    public synchronized void initialize(String modelName) {
        ensureOpen();
        modelName = requireModelName(modelName);
        if (initialized.get()) {
            throw new IllegalStateException("YOLOv8 adapter is already initialized");
        }

        Path modelFile = modelDirectory.resolve(modelName + ".onnx").normalize();
        if (!modelFile.getParent().equals(modelDirectory)) {
            throw new IllegalArgumentException("modelName escapes the configured model directory");
        }
        if (!Files.isRegularFile(modelFile) || !Files.isReadable(modelFile)) {
            throw new IllegalStateException("YOLOv8 ONNX model not found or unreadable: " + modelFile);
        }

        try {
            Net loaded = Dnn.readNetFromONNX(modelFile.toString());
            if (loaded == null || loaded.empty()) {
                throw new IllegalStateException("OpenCV DNN returned an empty network: " + modelFile);
            }
            loaded.setPreferableBackend(Dnn.DNN_BACKEND_DEFAULT);
            loaded.setPreferableTarget(Dnn.DNN_TARGET_CPU);
            this.net = loaded;
            initialized.set(true);
            LOG.info("YOLOv8 ONNX model initialized: {}", modelName);
        } catch (RuntimeException failure) {
            this.net = null;
            initialized.set(false);
            throw new IllegalStateException("YOLOv8 initialization failed", failure);
        }
    }

    @Override
    public List<DetectedObject> detectObjects(byte[] imageData, DetectionOptions options) {
        ensureInitialized();
        Objects.requireNonNull(imageData, "imageData");
        Objects.requireNonNull(options, "options");
        if (imageData.length == 0) {
            throw new IllegalArgumentException("imageData must not be empty");
        }

        Mat image = null;
        Mat processed = null;
        try {
            image = bytesToMat(imageData);
            processed = preprocessImage(image);
            List<DetectedObject> detections = postProcessDetections(runInference(processed), image.size());
            return finalizeDetections(detections, options);
        } catch (RuntimeException failure) {
            throw new VisionDetector.DetectionException("Object detection failed", failure);
        } finally {
            release(processed);
            release(image);
        }
    }

    public List<DetectedObject> detectObjectsInFrame(Mat frame, DetectionOptions options) {
        ensureInitialized();
        Objects.requireNonNull(frame, "frame");
        Objects.requireNonNull(options, "options");
        if (frame.empty()) throw new IllegalArgumentException("frame must not be empty");

        Mat processed = null;
        try {
            processed = preprocessImage(frame);
            List<DetectedObject> detections = postProcessDetections(runInference(processed), frame.size());
            return finalizeDetections(detections, options);
        } catch (RuntimeException failure) {
            throw new VisionDetector.DetectionException("Frame object detection failed", failure);
        } finally {
            release(processed);
        }
    }

    @Override
    public boolean isInitialized() {
        return initialized.get() && !closed.get();
    }

    public List<String> getSupportedClasses() {
        return COCO_CLASSES;
    }

    @Override
    public synchronized void close() {
        if (!closed.compareAndSet(false, true)) return;
        initialized.set(false);
        net = null;
    }

    private List<DetectedObject> finalizeDetections(
            List<DetectedObject> detections,
            DetectionOptions options) {
        List<DetectedObject> filtered = detections;
        if (options.getTargetClasses() != null && !options.getTargetClasses().isEmpty()) {
            filtered = filterByClasses(filtered, options.getTargetClasses());
        }
        filtered.sort((left, right) -> Double.compare(right.getConfidence(), left.getConfidence()));
        int maximum = options.getMaxDetections() > 0
                ? options.getMaxDetections()
                : filtered.size();
        return List.copyOf(filtered.subList(0, Math.min(filtered.size(), maximum)));
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("YOLOv8 adapter is closed");
    }

    private void ensureInitialized() {
        ensureOpen();
        Net active = net;
        if (!initialized.get() || active == null || active.empty()) {
            throw new IllegalStateException("YOLOv8 adapter is not initialized");
        }
    }

    private Map<String, Integer> createClassMapping() {
        Map<String, Integer> mapping = new HashMap<>();
        for (int index = 0; index < COCO_CLASSES.size(); index++) {
            mapping.put(COCO_CLASSES.get(index), index);
        }
        return Map.copyOf(mapping);
    }

    private Mat bytesToMat(byte[] imageData) {
        try {
            BufferedImage bufferedImage = ImageIO.read(new ByteArrayInputStream(imageData));
            if (bufferedImage == null) {
                throw new IllegalArgumentException("Unsupported or malformed image encoding");
            }
            return bufferedImageToMat(bufferedImage);
        } catch (IOException failure) {
            throw new IllegalArgumentException("Failed to decode image data", failure);
        }
    }

    private Mat bufferedImageToMat(BufferedImage image) {
        int width = image.getWidth();
        int height = image.getHeight();
        int channels = image.getColorModel().hasAlpha() ? 4 : 3;
        Mat mat = new Mat(height, width, CvType.CV_8UC(channels));
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                int rgb = image.getRGB(x, y);
                if (channels == 3) {
                    mat.put(y, x, (rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF);
                } else {
                    mat.put(
                            y,
                            x,
                            (rgb >> 16) & 0xFF,
                            (rgb >> 8) & 0xFF,
                            rgb & 0xFF,
                            (rgb >> 24) & 0xFF);
                }
            }
        }
        return mat;
    }

    private Mat preprocessImage(Mat image) {
        Mat resized = new Mat();
        Mat normalized = new Mat();
        try {
            Imgproc.resize(image, resized, new Size(INPUT_SIZE, INPUT_SIZE));
            resized.convertTo(normalized, CvType.CV_32F, 1.0 / 255.0);
            return Dnn.blobFromImage(
                    normalized,
                    1.0,
                    new Size(INPUT_SIZE, INPUT_SIZE),
                    new Scalar(0, 0, 0),
                    true,
                    false);
        } finally {
            release(normalized);
            release(resized);
        }
    }

    private List<YoloDetection> runInference(Mat processedImage) {
        Net active = net;
        if (active == null || active.empty()) {
            throw new IllegalStateException("YOLOv8 network is unavailable");
        }
        active.setInput(processedImage);
        List<Mat> outputs = new ArrayList<>();
        try {
            active.forward(outputs, getOutputLayerNames(active));
            return parseYoloOutput(outputs);
        } finally {
            outputs.forEach(YoloV8Adapter::release);
        }
    }

    private List<String> getOutputLayerNames(Net active) {
        MatOfInt outputLayerIds = active.getUnconnectedOutLayers();
        try {
            List<String> layerNames = active.getLayerNames();
            List<String> outputs = new ArrayList<>();
            for (int id : outputLayerIds.toArray()) {
                int index = id - 1;
                if (index < 0 || index >= layerNames.size()) {
                    throw new IllegalStateException("OpenCV returned an invalid output-layer index: " + id);
                }
                outputs.add(layerNames.get(index));
            }
            if (outputs.isEmpty()) {
                throw new IllegalStateException("YOLOv8 network has no output layers");
            }
            return List.copyOf(outputs);
        } finally {
            outputLayerIds.release();
        }
    }

    private List<YoloDetection> parseYoloOutput(List<Mat> outputs) {
        if (outputs.isEmpty() || outputs.getFirst().empty()) return List.of();
        Mat result = outputs.getFirst().reshape(1, outputs.getFirst().size(1));
        try {
            int numberOfBoxes = result.cols();
            int numberOfClasses = result.rows() - 4;
            if (numberOfClasses < 1) {
                throw new IllegalStateException("YOLOv8 output has no class scores");
            }

            List<YoloDetection> candidates = new ArrayList<>();
            for (int box = 0; box < numberOfBoxes; box++) {
                double bestScore = 0.0;
                int bestClass = -1;
                for (int classIndex = 0; classIndex < numberOfClasses; classIndex++) {
                    double[] value = result.get(4 + classIndex, box);
                    if (value == null || value.length == 0) continue;
                    if (value[0] > bestScore) {
                        bestScore = value[0];
                        bestClass = classIndex;
                    }
                }
                if (bestClass < 0 || bestClass >= COCO_CLASSES.size()
                        || bestScore < confidenceThreshold) {
                    continue;
                }
                double centerX = scalar(result, 0, box);
                double centerY = scalar(result, 1, box);
                double width = scalar(result, 2, box);
                double height = scalar(result, 3, box);
                candidates.add(new YoloDetection(
                        bestClass,
                        bestScore,
                        centerX - width / 2.0,
                        centerY - height / 2.0,
                        width,
                        height));
            }
            return List.copyOf(candidates);
        } finally {
            result.release();
        }
    }

    private static double scalar(Mat mat, int row, int column) {
        double[] value = mat.get(row, column);
        if (value == null || value.length == 0) {
            throw new IllegalStateException("YOLOv8 output contains a missing scalar");
        }
        return value[0];
    }

    private List<DetectedObject> postProcessDetections(
            List<YoloDetection> rawDetections,
            Size originalSize) {
        List<DetectedObject> detections = new ArrayList<>();
        double scaleX = originalSize.width / INPUT_SIZE;
        double scaleY = originalSize.height / INPUT_SIZE;
        for (YoloDetection detection : rawDetections) {
            double width = detection.width() * scaleX;
            double height = detection.height() * scaleY;
            BoundingBox boundingBox = BoundingBox.builder()
                    .x(detection.x() * scaleX)
                    .y(detection.y() * scaleY)
                    .width(width)
                    .height(height)
                    .build();
            ObjectAttributes attributes = ObjectAttributes.builder()
                    .size(calculateObjectSize(width, height))
                    .build();
            detections.add(DetectedObject.builder()
                    .className(COCO_CLASSES.get(detection.classId()))
                    .confidence(detection.confidence())
                    .boundingBox(boundingBox)
                    .attributes(attributes)
                    .build());
        }
        return applyNonMaximumSuppression(detections);
    }

    private List<DetectedObject> applyNonMaximumSuppression(List<DetectedObject> detections) {
        List<DetectedObject> filtered = new ArrayList<>();
        for (DetectedObject candidate : detections.stream()
                .sorted((left, right) -> Double.compare(right.getConfidence(), left.getConfidence()))
                .toList()) {
            boolean keep = true;
            for (DetectedObject retained : filtered) {
                if (candidate.getClassName().equals(retained.getClassName())
                        && candidate.getBoundingBox().calculateIoU(retained.getBoundingBox()) > nmsThreshold) {
                    keep = false;
                    break;
                }
            }
            if (keep) filtered.add(candidate);
        }
        return filtered;
    }

    private static List<DetectedObject> filterByClasses(
            List<DetectedObject> detections,
            Set<String> targetClasses) {
        return detections.stream()
                .filter(detection -> targetClasses.contains(detection.getClassName()))
                .toList();
    }

    private static String calculateObjectSize(double width, double height) {
        double area = width * height;
        if (area < 10_000) return "small";
        if (area < 50_000) return "medium";
        return "large";
    }

    private static String requireModelName(String value) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("modelName must not be blank");
        }
        String normalized = value.trim();
        if (normalized.length() > 128 || !normalized.matches("[A-Za-z0-9._-]+")) {
            throw new IllegalArgumentException(
                    "modelName must contain only letters, digits, '.', '_', or '-' and be <= 128 characters");
        }
        return normalized;
    }

    private static void release(Mat mat) {
        if (mat != null) mat.release();
    }

    private record YoloDetection(
            int classId,
            double confidence,
            double x,
            double y,
            double width,
            double height) {}
}
