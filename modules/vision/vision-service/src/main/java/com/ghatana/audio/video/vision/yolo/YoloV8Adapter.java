package com.ghatana.audio.video.vision.yolo;

import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.model.DetectedObject;
import com.ghatana.audio.video.vision.model.DetectionOptions;
import com.ghatana.audio.video.vision.model.VisionProviderAdmission;
import com.ghatana.audio.video.vision.model.VisionModelProfile;
import com.ghatana.audio.video.vision.image.BoundedImageDecoder;
import com.ghatana.audio.video.vision.image.SrgbToBgr;
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

import java.awt.image.BufferedImage;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * YOLOv8 ONNX adapter for object detection through OpenCV DNN.
 *
 * <p>Every request releases all transient {@link Mat} instances deterministically. The adapter is
 * lifecycle-owned by the production Vision service and rejects use after close. Every request-owned
 * {@link Mat} is explicitly released. OpenCV 4.9's Java {@link Net} wrapper has no public close or
 * release operation; this adapter owns one bounded Net for its lifetime and drops the reference on
 * close so the wrapper's native finalizer can reclaim it. Dynamic model replacement is not exposed.
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

    private final AtomicBoolean initialized = new AtomicBoolean();
    private final AtomicBoolean closed = new AtomicBoolean();
    private final Path modelDirectory;
    private final double confidenceThreshold;
    private final double nmsThreshold;
    private volatile Net net;
    private volatile VisionModelProfile activeProfile;

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
    }

    public synchronized void initialize(VisionModelProfile profile) {
        ensureOpen();
        validateProfileMetadata(profile, modelDirectory);
        if (initialized.get()) {
            throw new IllegalStateException("YOLOv8 adapter is already initialized");
        }
        VisionProviderAdmission.requireAdmitted(profile);

        try {
            loadOpenCvNativeLibrary();
            profile.verifyUnchanged();
            Net loaded = Dnn.readNetFromONNX(profile.modelFile().toString());
            if (loaded == null || loaded.empty()) {
                throw new IllegalStateException("OpenCV DNN returned an empty network");
            }
            loaded.setPreferableBackend(Dnn.DNN_BACKEND_DEFAULT);
            loaded.setPreferableTarget(Dnn.DNN_TARGET_CPU);
            profile.verifyUnchanged();
            this.net = loaded;
            this.activeProfile = profile;
            initialized.set(true);
            LOG.info("YOLOv8 ONNX model initialized: {} version {} sha256 {} on CPU",
                    profile.modelId(), profile.version(), profile.sha256());
        } catch (LinkageError failure) {
            this.net = null;
            initialized.set(false);
            throw new VisionModelProfile.VisionProviderUnavailableException(
                    VisionModelProfile.UnavailableReason.NATIVE_INITIALIZATION_FAILED,
                    "Vision native runtime initialization failed", failure);
        } catch (RuntimeException failure) {
            this.net = null;
            initialized.set(false);
            if (failure instanceof VisionModelProfile.VisionProviderUnavailableException unavailable) {
                throw unavailable;
            }
            throw new VisionModelProfile.VisionProviderUnavailableException(
                    VisionModelProfile.UnavailableReason.NATIVE_INITIALIZATION_FAILED,
                    "YOLOv8 ONNX initialization failed", failure);
        }
    }

    /**
     * Legacy unpinned model-name loading is rejected. Production initialization requires a
     * digest-verified {@link VisionModelProfile}.
     */
    @Deprecated(forRemoval = false)
    public synchronized void initialize(String modelName) {
        requireModelName(modelName);
        throw new IllegalStateException("A digest-verified VisionModelProfile is required to initialize YOLOv8");
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
            BoundedImageDecoder.DecodedImage decoded = BoundedImageDecoder.decodeWithMetadata(imageData);
            image = bufferedImageToMat(decoded.image());
            PreprocessedInput input = preprocessImage(image);
            processed = input.blob();
            List<DetectedObject> detections = postProcessDetections(
                    runInference(processed, confidenceThresholdFor(options)), input.transform(),
                    decoded.orientation(), nmsThresholdFor(options));
            return finalizeDetections(detections, options);
        } catch (BoundedImageDecoder.UnsupportedImageMetadataException unsupported) {
            throw unsupported;
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
            PreprocessedInput input = preprocessImage(frame);
            processed = input.blob();
            List<DetectedObject> detections = postProcessDetections(
                    runInference(processed, confidenceThresholdFor(options)), input.transform(),
                    1, nmsThresholdFor(options));
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

    public static List<String> supportedClassLabels() {
        return COCO_CLASSES;
    }

    /** Validates local metadata without loading OpenCV or initializing the model. */
    public static void validateProfileMetadata(VisionModelProfile profile, Path expectedModelDirectory) {
        Objects.requireNonNull(profile, "profile");
        Path expected = Objects.requireNonNull(expectedModelDirectory, "expectedModelDirectory")
                .toAbsolutePath().normalize();
        if (!profile.modelDirectory().equals(expected) || !profile.modelFile().getParent().equals(expected)) {
            throw new IllegalArgumentException("Verified Vision model profile does not match adapter directory");
        }
        if (profile.device() != VisionModelProfile.Device.CPU
                || !profile.classLabels().equals(COCO_CLASSES)) {
            throw new VisionModelProfile.VisionProviderUnavailableException(
                    VisionModelProfile.UnavailableReason.MODEL_CLASS_MISMATCH,
                    "YOLOv8 model class labels or execution device are not supported");
        }
    }

    @Override
    public synchronized void close() {
        if (!closed.compareAndSet(false, true)) return;
        initialized.set(false);
        // OpenCV 4.9 Net exposes no deterministic native release API.
        net = null;
        activeProfile = null;
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

    private static void loadOpenCvNativeLibrary() {
        try {
            NativeLoader.loadLibrary(Core.NATIVE_LIBRARY_NAME);
            LOG.info("OpenCV native library loaded successfully");
        } catch (Exception | LinkageError failure) {
            logNativeLibraryLoadFailure(failure);
            throw new VisionModelProfile.VisionProviderUnavailableException(
                    VisionModelProfile.UnavailableReason.NATIVE_INITIALIZATION_FAILED,
                    "Vision native runtime initialization failed", failure);
        }
    }

    static void logNativeLibraryLoadFailure(Throwable failure) {
        LOG.error("Failed to load OpenCV native library ({})", failure.getClass().getSimpleName());
    }

    private void ensureInitialized() {
        ensureOpen();
        Net active = net;
        if (!initialized.get() || active == null || active.empty()) {
            throw new IllegalStateException("YOLOv8 adapter is not initialized");
        }
    }

    private Mat bufferedImageToMat(BufferedImage image) {
        int width = image.getWidth();
        int height = image.getHeight();
        Mat mat = new Mat(height, width, CvType.CV_8UC3);
        try {
            for (int y = 0; y < height; y++) {
                for (int x = 0; x < width; x++) {
                    double[] bgr = SrgbToBgr.convert(image.getRGB(x, y));
                    mat.put(y, x, bgr);
                }
            }
            return mat;
        } catch (RuntimeException failure) {
            mat.release();
            throw failure;
        }
    }

    PreprocessedInput preprocessImage(Mat image) {
        LetterboxTransform transform = LetterboxTransform.fit(image.cols(), image.rows(), INPUT_SIZE);
        Mat resized = new Mat();
        Mat letterboxed = new Mat();
        Mat normalized = new Mat();
        try {
            Imgproc.resize(image, resized, new Size(transform.resizedWidth(), transform.resizedHeight()));
            int right = INPUT_SIZE - transform.resizedWidth() - transform.padLeft();
            int bottom = INPUT_SIZE - transform.resizedHeight() - transform.padTop();
            Core.copyMakeBorder(resized, letterboxed, transform.padTop(), bottom,
                    transform.padLeft(), right, Core.BORDER_CONSTANT, new Scalar(114, 114, 114));
            letterboxed.convertTo(normalized, CvType.CV_32F, 1.0 / 255.0);
            Mat blob = Dnn.blobFromImage(normalized, 1.0, new Size(INPUT_SIZE, INPUT_SIZE),
                    new Scalar(0, 0, 0), true, false);
            return new PreprocessedInput(blob, transform);
        } finally {
            release(normalized);
            release(letterboxed);
            release(resized);
        }
    }

    private List<YoloOutputParser.Detection> runInference(Mat processedImage, double requestConfidenceThreshold) {
        Net active = net;
        if (active == null || active.empty()) {
            throw new IllegalStateException("YOLOv8 network is unavailable");
        }
        active.setInput(processedImage);
        List<Mat> outputs = new ArrayList<>();
        try {
            active.forward(outputs, getOutputLayerNames(active));
            return parseYoloOutput(outputs, requestConfidenceThreshold);
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

    private List<YoloOutputParser.Detection> parseYoloOutput(List<Mat> outputs, double threshold) {
        if (outputs.size() != 1) {
            throw new IllegalStateException("YOLOv8 ONNX must return exactly one detection tensor");
        }
        Mat output = outputs.getFirst();
        if (output == null || output.empty() || output.dims() != 3 || output.channels() != 1
                || output.depth() != CvType.CV_32F) {
            throw new IllegalStateException("YOLOv8 output must be a non-empty single-channel float32 rank-3 tensor");
        }
        int batch = output.size(0);
        int channels = output.size(1);
        int numberOfBoxes = output.size(2);
        if (batch != 1 || channels != 4 + COCO_CLASSES.size()
                || numberOfBoxes < 1 || numberOfBoxes > YoloOutputParser.MAX_BOXES) {
            throw new IllegalStateException("YOLOv8 output layout must be [1, 4 + 80 classes, boxes]");
        }
        Mat flattened = output.reshape(1, 1);
        try {
            float[] values = new float[Math.multiplyExact(channels, numberOfBoxes)];
            int copied = flattened.get(0, 0, values);
            if (copied != values.length) {
                throw new IllegalStateException("YOLOv8 output tensor could not be read completely");
            }
            return YoloOutputParser.parse(batch, channels, numberOfBoxes, values,
                    COCO_CLASSES.size(), threshold);
        } finally {
            flattened.release();
        }
    }

    private List<DetectedObject> postProcessDetections(
            List<YoloOutputParser.Detection> rawDetections,
            LetterboxTransform transform,
            int orientation,
            double requestNmsThreshold) {
        VisionModelProfile profile = activeProfile;
        if (profile == null) {
            throw new IllegalStateException("Verified Vision model provenance is unavailable");
        }
        return YoloDetectionPostProcessor.process(rawDetections, profile.classLabels(), transform, requestNmsThreshold,
                orientation, new YoloDetectionPostProcessor.Provenance(
                        profile.modelId(), profile.version(), profile.sha256()));
    }

    double confidenceThresholdFor(DetectionOptions options) {
        Objects.requireNonNull(options, "options");
        // An explicit per-request threshold is the caller's inclusion policy;
        // retain the admitted adapter setting only when the field was omitted.
        return options.isConfidenceThresholdSpecified()
                ? options.getConfidenceThreshold()
                : confidenceThreshold;
    }

    double nmsThresholdFor(DetectionOptions options) {
        Objects.requireNonNull(options, "options");
        // NMS is adapter-configured by default and can be explicitly tuned per request.
        return options.isNmsThresholdSpecified() ? options.getNmsThreshold() : nmsThreshold;
    }

    private static List<DetectedObject> filterByClasses(
            List<DetectedObject> detections,
            Set<String> targetClasses) {
        return detections.stream()
                .filter(detection -> targetClasses.contains(detection.getClassName()))
                .toList();
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

    record PreprocessedInput(Mat blob, LetterboxTransform transform) { }

}
