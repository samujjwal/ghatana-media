/**
 * @doc.type implementation
 * @doc.purpose ONNX Runtime based YOLOv8 Vision Engine
 * @doc.layer platform
 * @doc.pattern Strategy
 */
package com.ghatana.media.vision.engine.onnx;

import ai.onnxruntime.*;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.*;
import com.ghatana.media.config.VisionConfig;
import com.ghatana.media.vision.api.*;
import io.activej.promise.Promise;

import java.nio.FloatBuffer;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.Consumer;
import java.util.stream.Collectors;
import java.util.logging.Logger;

/**
 * ONNX Runtime based YOLOv8 object detection engine.
 *
 * <p>Uses Microsoft ONNX Runtime for fast, local object detection.
 * Supports multiple model sizes (nano, small, medium, large).
 */
public final class YoloOnnxEngine implements VisionEngine {

    private static final Logger LOG = Logger.getLogger(YoloOnnxEngine.class.getName());

    // COCO class names (80 classes)
    private static final String[] COCO_CLASSES = {
        "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
        "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat",
        "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack",
        "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball",
        "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
        "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
        "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake",
        "chair", "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop",
        "mouse", "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
        "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush"
    };

    private final VisionConfig config;
    private final OrtEnvironment environment;
    private final OrtSession session;
    private final Semaphore concurrencyLimiter;
    private final ExecutorService executor;
    private final AtomicLong requestCount = new AtomicLong(0);
    private final AtomicLong errorCount = new AtomicLong(0);
    private final AtomicReference<EngineStatus.State> state;

    public YoloOnnxEngine(VisionConfig config, AudioVideoLibrary.LibraryState libraryState) throws ModelLoadingError {
        this.config = config;
        this.state = new AtomicReference<>(EngineStatus.State.INITIALIZING);
        this.concurrencyLimiter = new Semaphore(config.maxConcurrentRequests());
        this.executor = Executors.newVirtualThreadPerTaskExecutor();

        try {
            LOG.info("Loading YOLOv8 ONNX model from: " + config.modelPath());

            this.environment = OrtEnvironment.getEnvironment();

            OrtSession.SessionOptions options = new OrtSession.SessionOptions();
            options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);

            // Configure GPU if enabled
            if (config.useGpu()) {
                try {
                    options.addCUDA(0);
                    LOG.info("CUDA execution provider enabled for YOLO");
                } catch (OrtException e) {
                    LOG.warning("CUDA not available for YOLO, using CPU: " + e.getMessage());
                }
            }

            this.session = environment.createSession(config.modelPath().toString(), options);

            LOG.info("YOLOv8 model loaded. Input info: " + session.getInputInfo().values().iterator().next());

            state.set(EngineStatus.State.READY);

        } catch (OrtException e) {
            state.set(EngineStatus.State.ERROR);
            throw new ModelLoadingError("Failed to load YOLO ONNX model", e);
        }
    }

    @Override
    public DetectionResult detect(ImageData image, DetectionOptions options) {
        ensureReady();
        validateImage(image);

        long startTime = System.currentTimeMillis();
        requestCount.incrementAndGet();

        try {
            concurrencyLimiter.acquire();
            try {
                // Preprocess image
                float[][][] inputTensor = preprocess(image);

                // Run inference
                float[][] detections = runInference(inputTensor);

                // Post-process (NMS, filtering)
                List<DetectedObject> objects = postProcess(detections, options, image.width(), image.height());

                long latency = System.currentTimeMillis() - startTime;

                return new DetectionResult(
                    objects,
                    image.width(),
                    image.height(),
                    latency,
                    config.modelId()
                );

            } finally {
                concurrencyLimiter.release();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            errorCount.incrementAndGet();
            throw new InferenceError("Detection interrupted", e, true);
        } catch (Exception e) {
            errorCount.incrementAndGet();
            throw new InferenceError("Detection failed", e, false);
        }
    }

    @Override
    public Promise<DetectionResult> detectAsync(ImageData image, DetectionOptions options) {
        return Promise.ofBlocking(executor, () -> detect(image, options));
    }

    @Override
    public StreamingDetectionSession createStreamingSession(DetectionOptions options, Consumer<DetectionResult> resultCallback) {
        ensureReady();
        return new YoloStreamingSession(options, resultCallback, this);
    }

    @Override
    public String caption(ImageData image) {
        DetectionResult result = detect(image);
        return generateCaption(result);
    }

    @Override
    public List<Classification> classify(ImageData image, int topK) {
        // Use detection as classification by aggregating detected classes
        DetectionResult result = detect(image);

        Map<String, Double> classScores = new HashMap<>();
        for (DetectedObject obj : result.objects()) {
            classScores.merge(obj.className(), obj.confidence(), Double::sum);
        }

        return classScores.entrySet().stream()
            .map(e -> new Classification(e.getKey(), e.getValue()))
            .sorted(Comparator.comparingDouble(Classification::confidence).reversed())
            .limit(topK)
            .toList();
    }

    @Override
    public List<DetectionModelInfo> getAvailableModels() {
        return List.of(
            new DetectionModelInfo("yolov8n", "YOLOv8 Nano", "8.0", COCO_CLASSES, 6000000L, true, 640, 640, Optional.of("Fastest, lowest accuracy")),
            new DetectionModelInfo("yolov8s", "YOLOv8 Small", "8.0", COCO_CLASSES, 22000000L, true, 640, 640, Optional.of("Balanced speed/accuracy")),
            new DetectionModelInfo("yolov8m", "YOLOv8 Medium", "8.0", COCO_CLASSES, 54000000L, true, 640, 640, Optional.of("Good accuracy")),
            new DetectionModelInfo("yolov8l", "YOLOv8 Large", "8.0", COCO_CLASSES, 90000000L, true, 640, 640, Optional.of("High accuracy")),
            new DetectionModelInfo("yolov8x", "YOLOv8 XLarge", "8.0", COCO_CLASSES, 137000000L, true, 640, 640, Optional.of("Highest accuracy"))
        );
    }

    @Override
    public void loadModel(String modelId) {
        LOG.info("Model switching requested: " + modelId);
        // Would reload session with new model
    }

    @Override
    public DetectionModelInfo getActiveModel() {
        return new DetectionModelInfo(
            config.modelId(),
            config.modelId(),
            "8.0",
            COCO_CLASSES,
            0L,
            config.useGpu(),
            config.inputSize(),
            config.inputSize(),
            Optional.empty()
        );
    }

    @Override
    public void warmup() {
        LOG.info("Warming up YOLO engine...");
        try {
            // Create dummy image
            ImageData dummy = ImageData.builder()
                .data(new byte[config.inputSize() * config.inputSize() * 3])
                .width(config.inputSize())
                .height(config.inputSize())
                .format(ImageFormat.RAW)
                .build();

            detect(dummy, DetectionOptions.defaults());
            LOG.info("Warmup complete");
        } catch (Exception e) {
            LOG.warning("Warmup failed: " + e.getMessage());
        }
    }

    @Override
    public void close() {
        LOG.info("Closing YOLO ONNX engine...");
        state.set(EngineStatus.State.CLOSED);

        try {
            session.close();
            environment.close();
        } catch (OrtException e) {
            LOG.warning("Error closing YOLO ONNX session: " + e.getMessage());
        }

        executor.shutdown();
    }

    @Override
    public EngineStatus getStatus() {
        return new EngineStatus(
            state.get(),
            config.modelId(),
            "8.0",
            0L,
            null
        );
    }

    @Override
    public EngineMetrics getMetrics() {
        long requests = requestCount.get();
        long errors = errorCount.get();

        return new EngineMetrics(
            requests,
            errors,
            50.0,
            config.maxConcurrentRequests() - concurrencyLimiter.availablePermits(),
            0L
        );
    }

    // ====================================================================================
    // Private Implementation
    // ====================================================================================

    private void ensureReady() {
        if (state.get() != EngineStatus.State.READY) {
            throw new IllegalStateException("Vision engine not ready. State: " + state.get());
        }
    }

    private void validateImage(ImageData image) {
        if (image == null) {
            throw new ValidationError("Image data cannot be null");
        }
        if (image.width() <= 0 || image.height() <= 0) {
            throw new ValidationError("Invalid image dimensions");
        }
    }

    /**
     * Preprocess image to model input format (NCHW, normalized).
     */
    private float[][][] preprocess(ImageData image) {
        int size = config.inputSize();
        float[][][] tensor = new float[3][size][size]; // CHW format

        // Convert and resize image
        byte[] data = image.data();
        int srcWidth = image.width();
        int srcHeight = image.height();

        // Simple bilinear resize and normalization
        float scaleX = (float) srcWidth / size;
        float scaleY = (float) srcHeight / size;

        for (int y = 0; y < size; y++) {
            for (int x = 0; x < size; x++) {
                int srcX = (int) (x * scaleX);
                int srcY = (int) (y * scaleY);
                int srcIdx = (srcY * srcWidth + srcX) * 3;

                if (srcIdx + 2 < data.length) {
                    // Normalize to [0, 1] and convert RGB to model input
                    tensor[0][y][x] = (data[srcIdx] & 0xFF) / 255.0f;     // R
                    tensor[1][y][x] = (data[srcIdx + 1] & 0xFF) / 255.0f; // G
                    tensor[2][y][x] = (data[srcIdx + 2] & 0xFF) / 255.0f; // B
                }
            }
        }

        return tensor;
    }

    /**
     * Run ONNX inference.
     */
    private float[][] runInference(float[][][] inputTensor) throws OrtException {
        int size = config.inputSize();

        // Flatten to 1D array
        float[] flatInput = new float[3 * size * size];
        int idx = 0;
        for (int c = 0; c < 3; c++) {
            for (int h = 0; h < size; h++) {
                for (int w = 0; w < size; w++) {
                    flatInput[idx++] = inputTensor[c][h][w];
                }
            }
        }

        OnnxTensor input = OnnxTensor.createTensor(
            environment,
            FloatBuffer.wrap(flatInput),
            new long[]{1, 3, size, size}
        );

        Map<String, OnnxTensor> inputs = new HashMap<>();
        inputs.put(session.getInputNames().iterator().next(), input);

        OrtSession.Result results = session.run(inputs);

        // Extract output tensor
        // YOLOv8 output: [batch, 84, 8400] where 84 = 4 (bbox) + 80 (classes)
        OnnxTensor outputTensor = (OnnxTensor) results.get(0);
        float[][] output = (float[][]) outputTensor.getValue();

        return output;
    }

    /**
     * Post-process detections: filter by confidence, apply NMS.
     */
    private List<DetectedObject> postProcess(float[][] detections, DetectionOptions options, int imgWidth, int imgHeight) {
        List<DetectedObject> candidates = new ArrayList<>();

        // YOLOv8 output format: [num_predictions, 84]
        // Each row: [x_center, y_center, width, height, class_scores...]
        int numClasses = COCO_CLASSES.length;

        for (float[] detection : detections) {
            if (detection.length < 4 + numClasses) continue;

            // Find best class
            float maxScore = 0;
            int bestClass = -1;
            for (int i = 0; i < numClasses; i++) {
                float score = detection[4 + i];
                if (score > maxScore) {
                    maxScore = score;
                    bestClass = i;
                }
            }

            if (maxScore < options.confidenceThreshold()) continue;

            // Convert bbox from center format to corner format
            float x = detection[0] - detection[2] / 2;
            float y = detection[1] - detection[3] / 2;
            float w = detection[2];
            float h = detection[3];

            // Scale to original image dimensions
            float scaleX = (float) imgWidth / config.inputSize();
            float scaleY = (float) imgHeight / config.inputSize();

            BoundingBox bbox = new BoundingBox(
                x * scaleX,
                y * scaleY,
                w * scaleX,
                h * scaleY,
                maxScore
            );

            candidates.add(new DetectedObject(
                COCO_CLASSES[bestClass],
                maxScore,
                bbox
            ));
        }

        // Apply NMS
        if (options.nms().enabled()) {
            candidates = applyNMS(candidates, options.nms().iouThreshold());
        }

        // Sort by confidence and limit
        return candidates.stream()
            .sorted(Comparator.comparingDouble(o -> -o.confidence()))
            .limit(options.maxDetections())
            .toList();
    }

    private List<DetectedObject> applyNMS(List<DetectedObject> detections, double iouThreshold) {
        List<DetectedObject> result = new ArrayList<>();
        boolean[] suppressed = new boolean[detections.size()];

        for (int i = 0; i < detections.size(); i++) {
            if (suppressed[i]) continue;

            DetectedObject current = detections.get(i);
            result.add(current);

            for (int j = i + 1; j < detections.size(); j++) {
                if (suppressed[j]) continue;

                if (current.className().equals(detections.get(j).className())) {
                    double iou = current.bbox().iou(detections.get(j).bbox());
                    if (iou > iouThreshold) {
                        suppressed[j] = true;
                    }
                }
            }
        }

        return result;
    }

    private String generateCaption(DetectionResult result) {
        if (result.objects().isEmpty()) {
            return "No objects detected";
        }

        Map<String, Long> counts = result.objects().stream()
            .collect(Collectors.groupingBy(DetectedObject::className, Collectors.counting()));

        StringBuilder caption = new StringBuilder("I see ");
        int i = 0;
        for (Map.Entry<String, Long> entry : counts.entrySet()) {
            if (i > 0) caption.append(i == counts.size() - 1 ? " and " : ", ");
            caption.append(entry.getValue()).append(" ").append(entry.getKey());
            if (entry.getValue() > 1) caption.append("s");
            i++;
        }

        return caption.toString();
    }

    // ====================================================================================
    // Streaming Session
    // ====================================================================================

    private static class YoloStreamingSession implements StreamingDetectionSession {
        private final DetectionOptions options;
        private final Consumer<DetectionResult> callback;
        private final YoloOnnxEngine engine;
        private final AtomicBoolean active = new AtomicBoolean(true);

        YoloStreamingSession(DetectionOptions options, Consumer<DetectionResult> callback, YoloOnnxEngine engine) {
            this.options = options;
            this.callback = callback;
            this.engine = engine;
        }

        @Override
        public void feedFrame(ImageData frame, long frameNumber) {
            if (!active.get()) return;

            DetectionResult result = engine.detect(frame, options);
            callback.accept(result);
        }

        @Override
        public void endStream() {
            active.set(false);
        }

        @Override
        public boolean isActive() {
            return active.get();
        }

        @Override
        public void close() {
            active.set(false);
        }
    }
}
