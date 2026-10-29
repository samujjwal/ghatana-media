package com.ghatana.audio.video.vision.yolo;

import com.ghatana.audio.video.vision.model.DetectedObject;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.opencv.core.Core;
import org.opencv.core.CvType;
import org.opencv.core.Mat;
import org.opencv.core.Scalar;
import org.opencv.dnn.Dnn;
import org.opencv.dnn.Net;
import org.opencv.imgcodecs.Imgcodecs;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Opt-in real positive/negative image evidence for the pinned YOLOX-Nano ONNX
 * weights. The positive fixture is the Apache-2.0 opencv_extra 4.9.0
 * {@code testdata/dnn/dog416.png} (a real dog photograph); the negative fixture
 * is an original generated blank frame. This is a local qualification record,
 * not a held-out mAP corpus or provider admission.
 */
class YoloXNanoRealImageEvidenceTest {
    private static final String MODEL_SHA256 = "c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d";
    private static final long MODEL_BYTES = 3_659_407L;
    private static final String POSITIVE_SHA256 = "61db162464c0770138c5136af0e999ce3b6556244cec257945427396480d9caf";
    private static final double CONFIDENCE_THRESHOLD = 0.25;
    private static final double NMS_THRESHOLD = 0.45;

    @BeforeAll
    static void loadOpenCv() { nu.pattern.OpenCV.loadLocally(); }

    @Test
    void pinnedModelDetectsDogClassInLawfulRealPhotograph() throws Exception {
        Path model = pinnedModel();
        Path positive = pinnedPositive();
        List<DetectedObject> detections = detect(model, Imgcodecs.imread(positive.toString()));
        List<DetectedObject> dogs = detections.stream()
                .filter(d -> d.getClassName().equals("dog")
                        && d.getConfidence() >= CONFIDENCE_THRESHOLD).toList();
        System.out.printf("YOLOX_NANO_POSITIVE_EVAL image=opencv-extra-4.9.0-dog416 "
                        + "license=Apache-2.0 imageSha256=%s modelSha256=%s decodedDetections=%d "
                        + "dogDetections=%d topConfidence=%.4f%n",
                POSITIVE_SHA256, MODEL_SHA256, detections.size(), dogs.size(),
                dogs.stream().mapToDouble(DetectedObject::getConfidence).max().orElse(0.0));
        assertThat(dogs).as("the pinned model must detect the photographed dog").isNotEmpty();
        DetectedObject best = dogs.stream()
                .max(java.util.Comparator.comparingDouble(DetectedObject::getConfidence)).orElseThrow();
        var box = best.getBoundingBox();
        assertThat(box.getX()).isBetween(0.0, 416.0);
        assertThat(box.getY()).isBetween(0.0, 416.0);
        assertThat(box.getWidth()).isPositive();
        assertThat(box.getHeight()).isPositive();
    }

    @Test
    void pinnedModelReturnsNoDetectionOnGeneratedBlankFrame() throws Exception {
        Path model = pinnedModel();
        Mat blank = new Mat(416, 416, CvType.CV_8UC3, new Scalar(24, 24, 24));
        List<DetectedObject> detections;
        try {
            detections = detect(model, blank);
        } finally {
            blank.release();
        }
        System.out.printf("YOLOX_NANO_NEGATIVE_EVAL image=generated-blank-416 "
                        + "modelSha256=%s decodedDetections=%d%n", MODEL_SHA256, detections.size());
        assertThat(detections).as("a blank frame must produce no detections").isEmpty();
    }

    private static Path pinnedModel() throws Exception {
        String configured = System.getenv("GHATANA_MEDIA_YOLOX_NANO_MODEL");
        Assumptions.assumeTrue(configured != null && !configured.isBlank(),
                "set GHATANA_MEDIA_YOLOX_NANO_MODEL to the off-repo official release");
        Path model = Path.of(configured).toRealPath();
        assertThat(Files.size(model)).isEqualTo(MODEL_BYTES);
        assertThat(sha256(model)).isEqualTo(MODEL_SHA256);
        return model;
    }

    private static Path pinnedPositive() throws Exception {
        String configured = System.getenv("GHATANA_MEDIA_YOLOX_POSITIVE_IMAGE");
        Assumptions.assumeTrue(configured != null && !configured.isBlank(),
                "set GHATANA_MEDIA_YOLOX_POSITIVE_IMAGE to the off-repo lawful positive fixture");
        Path image = Path.of(configured).toRealPath();
        assertThat(sha256(image)).isEqualTo(POSITIVE_SHA256);
        return image;
    }

    private static List<DetectedObject> detect(Path model, Mat image) throws Exception {
        Net network = null;
        Mat blob = null;
        try {
            YoloXNanoAdapter.PreprocessedInput prepared = YoloXNanoAdapter.preprocess(image);
            blob = prepared.blob();
            network = Dnn.readNetFromONNX(model.toString());
            assertThat(network).isNotNull();
            assertThat(network.empty()).isFalse();
            network.setPreferableBackend(Dnn.DNN_BACKEND_DEFAULT);
            network.setPreferableTarget(Dnn.DNN_TARGET_CPU);
            network.setInput(blob);
            List<Mat> outputs = new ArrayList<>();
            try {
                network.forward(outputs, network.getUnconnectedOutLayersNames());
                assertThat(outputs).hasSize(1);
                Mat output = outputs.getFirst();
                Mat flat = output.reshape(1, 1);
                try {
                    float[] values = new float[3549 * 85];
                    assertThat(flat.get(0, 0, values)).isEqualTo(Math.multiplyExact(values.length, Float.BYTES));
                    List<YoloOutputParser.Detection> raw =
                            YoloXNanoOutputParser.decode(1, 3549, 85, values, 0.01);
                    return YoloDetectionPostProcessor.process(raw,
                            YoloV8Adapter.supportedClassLabels(), prepared.transform(), NMS_THRESHOLD, 1,
                            new YoloDetectionPostProcessor.Provenance(
                                    "yolox_nano", "0.1.1rc0", MODEL_SHA256));
                } finally { flat.release(); }
            } finally { outputs.forEach(Mat::release); }
        } finally {
            if (blob != null) blob.release();
        }
    }

    private static String sha256(Path path) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (var in = Files.newInputStream(path)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = in.read(buffer)) >= 0) digest.update(buffer, 0, count);
        }
        return HexFormat.of().formatHex(digest.digest());
    }
}
