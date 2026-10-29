package com.ghatana.audio.video.vision.yolo;

import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.image.BoundedImageDecoder;
import com.ghatana.audio.video.vision.image.SrgbToBgr;
import com.ghatana.audio.video.vision.model.DetectedObject;
import com.ghatana.audio.video.vision.model.DetectionOptions;
import com.ghatana.audio.video.vision.model.VisionModelProfile;
import com.ghatana.audio.video.vision.model.VisionProviderAdmission;
import java.awt.image.BufferedImage;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;
import org.opencv.core.Core;
import org.opencv.core.CvType;
import org.opencv.core.Mat;
import org.opencv.core.Scalar;
import org.opencv.core.Size;
import org.opencv.dnn.Dnn;
import org.opencv.dnn.Net;
import org.opencv.imgproc.Imgproc;
import org.scijava.nativelib.NativeLoader;

/** Independent YOLOX-Nano ONNX path; it does not use the YOLOv8 tensor parser. */
public final class YoloXNanoAdapter implements VisionDetector, AutoCloseable {
    private static final String MODEL_ID = "yolox_nano";
    private static final String MODEL_VERSION = "0.1.1rc0";
    private static final String MODEL_SHA256 = "c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d";
    private static final long MODEL_BYTES = 3_659_407L;
    private final Path modelDirectory;
    private final double confidenceThreshold;
    private final double nmsThreshold;
    private final AtomicBoolean closed = new AtomicBoolean();
    private volatile Net net;
    private volatile VisionModelProfile profile;

    public YoloXNanoAdapter(Path modelDirectory, double confidenceThreshold, double nmsThreshold) {
        this.modelDirectory = Objects.requireNonNull(modelDirectory, "modelDirectory").toAbsolutePath().normalize();
        if (!Double.isFinite(confidenceThreshold) || confidenceThreshold < 0 || confidenceThreshold > 1
                || !Double.isFinite(nmsThreshold) || nmsThreshold < 0 || nmsThreshold > 1) {
            throw new IllegalArgumentException("YOLOX confidence and NMS thresholds must be in [0,1]");
        }
        this.confidenceThreshold = confidenceThreshold;
        this.nmsThreshold = nmsThreshold;
    }

    public synchronized void initialize(VisionModelProfile candidate) {
        ensureOpen();
        validateProfile(candidate, modelDirectory);
        if (net != null) throw new IllegalStateException("YOLOX-Nano adapter is already initialized");
        VisionProviderAdmission.requireAdmitted(candidate);
        try {
            NativeLoader.loadLibrary(Core.NATIVE_LIBRARY_NAME);
            candidate.verifyUnchanged();
            Net loaded = Dnn.readNetFromONNX(candidate.modelFile().toString());
            if (loaded == null || loaded.empty()) throw new IllegalStateException("OpenCV returned an empty YOLOX network");
            loaded.setPreferableBackend(Dnn.DNN_BACKEND_DEFAULT);
            loaded.setPreferableTarget(Dnn.DNN_TARGET_CPU);
            candidate.verifyUnchanged();
            profile = candidate;
            net = loaded;
        } catch (Exception | LinkageError failure) {
            throw new VisionModelProfile.VisionProviderUnavailableException(
                    VisionModelProfile.UnavailableReason.NATIVE_INITIALIZATION_FAILED,
                    "YOLOX-Nano native initialization failed", failure);
        }
    }

    public static void validateProfile(VisionModelProfile candidate, Path expectedDirectory) {
        Objects.requireNonNull(candidate, "candidate");
        Path expected = Objects.requireNonNull(expectedDirectory, "expectedDirectory").toAbsolutePath().normalize();
        if (!candidate.modelDirectory().equals(expected) || !candidate.modelFile().getParent().equals(expected)) {
            throw new IllegalArgumentException("Verified YOLOX model profile does not match adapter directory");
        }
        if (!candidate.modelId().equals(MODEL_ID) || !candidate.version().equals(MODEL_VERSION)
                || !candidate.sha256().equalsIgnoreCase(MODEL_SHA256) || candidate.sizeBytes() != MODEL_BYTES) {
            throw new VisionModelProfile.VisionProviderUnavailableException(
                    VisionModelProfile.UnavailableReason.MODEL_DIGEST_MISMATCH,
                    "YOLOX-Nano profile does not match the pinned 0.1.1rc0 release artifact");
        }
        if (!candidate.classLabels().equals(YoloV8Adapter.supportedClassLabels())
                || candidate.device() != VisionModelProfile.Device.CPU) {
            throw new VisionModelProfile.VisionProviderUnavailableException(
                    VisionModelProfile.UnavailableReason.MODEL_CLASS_MISMATCH,
                    "YOLOX-Nano requires its exact 80-class COCO mapping on CPU");
        }
    }

    @Override
    public List<DetectedObject> detectObjects(byte[] imageData, DetectionOptions options) {
        ensureInitialized();
        Objects.requireNonNull(options, "options");
        if (imageData == null || imageData.length == 0) throw new IllegalArgumentException("imageData must not be empty");
        BoundedImageDecoder.DecodedImage decoded = BoundedImageDecoder.decodeWithMetadata(imageData);
        Mat source = bufferedImageToMat(decoded.image());
        Mat blob = null;
        try {
            PreprocessedInput input = preprocess(source);
            blob = input.blob();
            List<YoloOutputParser.Detection> raw = infer(blob,
                    options.isConfidenceThresholdSpecified() ? options.getConfidenceThreshold() : confidenceThreshold);
            double nms = options.isNmsThresholdSpecified() ? options.getNmsThreshold() : nmsThreshold;
            VisionModelProfile activeProfile = profile;
            List<DetectedObject> detections = YoloDetectionPostProcessor.process(raw, activeProfile.classLabels(),
                    input.transform(), nms, decoded.orientation(), new YoloDetectionPostProcessor.Provenance(
                            activeProfile.modelId(), activeProfile.version(), activeProfile.sha256()));
            detections = detections.stream().sorted((a, b) -> Double.compare(b.getConfidence(), a.getConfidence())).toList();
            int max = options.getMaxDetections() > 0 ? options.getMaxDetections() : detections.size();
            return List.copyOf(detections.subList(0, Math.min(max, detections.size())));
        } catch (RuntimeException failure) {
            if (failure instanceof BoundedImageDecoder.UnsupportedImageMetadataException) throw failure;
            throw new VisionDetector.DetectionException("YOLOX-Nano detection failed", failure);
        } finally {
            if (blob != null) blob.release();
            source.release();
        }
    }

    public List<DetectedObject> detectObjectsInFrame(Mat frame, DetectionOptions options) {
        ensureInitialized();
        if (frame == null || frame.empty()) throw new IllegalArgumentException("frame must not be empty");
        Objects.requireNonNull(options, "options");
        PreprocessedInput input = preprocess(frame);
        try {
            VisionModelProfile activeProfile = profile;
            List<YoloOutputParser.Detection> raw = infer(input.blob(),
                    options.isConfidenceThresholdSpecified() ? options.getConfidenceThreshold() : confidenceThreshold);
            double nms = options.isNmsThresholdSpecified() ? options.getNmsThreshold() : nmsThreshold;
            List<DetectedObject> detections = YoloDetectionPostProcessor.process(raw, activeProfile.classLabels(), input.transform(), nms, 1,
                    new YoloDetectionPostProcessor.Provenance(activeProfile.modelId(), activeProfile.version(), activeProfile.sha256()));
            int max = options.getMaxDetections() > 0 ? options.getMaxDetections() : detections.size();
            return List.copyOf(detections.subList(0, Math.min(max, detections.size())));
        } finally { input.blob().release(); }
    }

    static PreprocessedInput preprocess(Mat source) {
        if (source == null || source.empty()) throw new IllegalArgumentException("Image must not be empty");
        int size = YoloXNanoOutputParser.INPUT_SIZE;
        double scale = Math.min((double) size / source.rows(), (double) size / source.cols());
        int resizedWidth = Math.max(1, (int) (source.cols() * scale));
        int resizedHeight = Math.max(1, (int) (source.rows() * scale));
        // YOLOX's official preproc places the resized raster at the upper-left and fills
        // the remaining right/bottom area with 114; it does not center the letterbox.
        LetterboxTransform transform = new LetterboxTransform(source.cols(), source.rows(), size,
                resizedWidth, resizedHeight, 0, 0);
        Mat resized = new Mat();
        Mat letterboxed = new Mat();
        try {
            Imgproc.resize(source, resized, new Size(transform.resizedWidth(), transform.resizedHeight()));
            int right = size - transform.resizedWidth() - transform.padLeft();
            int bottom = size - transform.resizedHeight() - transform.padTop();
            Core.copyMakeBorder(resized, letterboxed, 0, bottom, 0, right,
                    Core.BORDER_CONSTANT, new Scalar(114, 114, 114));
            // YOLOX's official preprocessing feeds the letterboxed raster to the network
            // as raw cv2-order (BGR) uint8 pixels in the 0-255 range; it neither
            // normalizes to [0,1] nor swaps channel order.
            Mat blob = Dnn.blobFromImage(letterboxed, 1.0, new Size(size, size), new Scalar(0, 0, 0), false, false);
            return new PreprocessedInput(blob, transform);
        } finally { resized.release(); letterboxed.release(); }
    }

    private List<YoloOutputParser.Detection> infer(Mat input, double threshold) {
        Net active = net;
        synchronized (active) {
            ensureInitialized();
            active.setInput(input);
            List<Mat> outputs = new ArrayList<>();
            try {
                active.forward(outputs, active.getUnconnectedOutLayersNames());
                if (outputs.size() != 1) throw new IllegalStateException("YOLOX-Nano must return one output tensor");
                Mat output = outputs.getFirst();
                if (output.empty() || output.dims() != 3 || output.channels() != 1 || output.depth() != CvType.CV_32F
                        || output.size(0) != 1 || output.size(1) != YoloXNanoOutputParser.PREDICTION_COUNT
                        || output.size(2) != YoloXNanoOutputParser.ATTRIBUTES) {
                    throw new IllegalStateException("YOLOX-Nano output tensor must be [1,3549,85] float32");
                }
                Mat flat = output.reshape(1, 1);
                try {
                    float[] values = new float[YoloXNanoOutputParser.PREDICTION_COUNT * YoloXNanoOutputParser.ATTRIBUTES];
                    if (flat.get(0, 0, values) != Math.multiplyExact(values.length, Float.BYTES)) {
                        throw new IllegalStateException("YOLOX-Nano output tensor could not be read completely");
                    }
                    return YoloXNanoOutputParser.decode(1, YoloXNanoOutputParser.PREDICTION_COUNT,
                            YoloXNanoOutputParser.ATTRIBUTES, values, threshold);
                } finally { flat.release(); }
            } finally { outputs.forEach(Mat::release); }
        }
    }

    private static Mat bufferedImageToMat(BufferedImage image) {
        Mat mat = new Mat(image.getHeight(), image.getWidth(), CvType.CV_8UC3);
        try {
            for (int y = 0; y < image.getHeight(); y++) for (int x = 0; x < image.getWidth(); x++) {
                mat.put(y, x, SrgbToBgr.convert(image.getRGB(x, y)));
            }
            return mat;
        } catch (RuntimeException failure) { mat.release(); throw failure; }
    }

    @Override public boolean isInitialized() { return net != null && !closed.get(); }

    @Override public synchronized void close() {
        if (closed.compareAndSet(false, true)) { net = null; profile = null; }
    }

    private void ensureOpen() { if (closed.get()) throw new IllegalStateException("YOLOX-Nano adapter is closed"); }
    private void ensureInitialized() {
        ensureOpen();
        if (net == null || profile == null) throw new IllegalStateException("YOLOX-Nano adapter is not initialized");
    }

    record PreprocessedInput(Mat blob, LetterboxTransform transform) { }
}
