package com.ghatana.audio.video.vision.yolo;

import com.ghatana.audio.video.vision.model.DetectedObject;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.opencv.core.CvType;
import org.opencv.core.Core;
import org.opencv.core.Mat;
import org.opencv.core.Scalar;
import org.opencv.dnn.Dnn;
import org.opencv.dnn.Net;
import org.opencv.imgproc.Imgproc;

import static org.assertj.core.api.Assertions.assertThat;

/** Opt-in real ONNX smoke evaluation using an original, synthetic labeled fixture. */
class YoloXNanoCandidateLocalEvaluationTest {
    private static final String SHA256 = "c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d";
    private static final long MODEL_BYTES = 3_659_407L;

    @BeforeAll
    static void loadOpenCv() { nu.pattern.OpenCV.loadLocally(); }

    @Test
    void actualOnnxOutputDecodesOnOriginalSyntheticPersonGlyph() throws Exception {
        String configured = System.getenv("GHATANA_MEDIA_YOLOX_NANO_MODEL");
        Assumptions.assumeTrue(configured != null && !configured.isBlank(),
                "set GHATANA_MEDIA_YOLOX_NANO_MODEL to the off-repo official release for local evaluation");
        Path model = Path.of(configured).toRealPath();
        assertThat(Files.size(model)).isEqualTo(MODEL_BYTES);
        assertThat(sha256(model)).isEqualTo(SHA256);

        // This geometric person glyph is generated in the test from original primitives; the
        // annotated box is source-owned. It is a decoder smoke fixture, not a quality corpus.
        Mat image = new Mat(416, 416, CvType.CV_8UC3, new Scalar(24, 24, 24));
        Net network = null;
        Mat blob = null;
        try {
            Imgproc.circle(image, new org.opencv.core.Point(208, 91), 25, new Scalar(210, 210, 210), -1);
            Imgproc.rectangle(image, new org.opencv.core.Point(176, 120), new org.opencv.core.Point(240, 248),
                    new Scalar(210, 210, 210), -1);
            Imgproc.line(image, new org.opencv.core.Point(181, 141), new org.opencv.core.Point(132, 220),
                    new Scalar(210, 210, 210), 18);
            Imgproc.line(image, new org.opencv.core.Point(235, 141), new org.opencv.core.Point(284, 220),
                    new Scalar(210, 210, 210), 18);
            Imgproc.line(image, new org.opencv.core.Point(190, 242), new org.opencv.core.Point(166, 361),
                    new Scalar(210, 210, 210), 20);
            Imgproc.line(image, new org.opencv.core.Point(226, 242), new org.opencv.core.Point(250, 361),
                    new Scalar(210, 210, 210), 20);
            byte[] originalPixels = new byte[416 * 416 * 3];
            assertThat(image.get(0, 0, originalPixels)).isEqualTo(originalPixels.length);
            String fixtureSha256 = sha256(originalPixels);

            YoloXNanoAdapter.PreprocessedInput prepared = YoloXNanoAdapter.preprocess(image);
            blob = prepared.blob();
            network = Dnn.readNetFromONNX(model.toString());
            assertThat(network).isNotNull();
            assertThat(network.empty()).isFalse();
            network.setPreferableBackend(Dnn.DNN_BACKEND_DEFAULT);
            network.setPreferableTarget(Dnn.DNN_TARGET_CPU);
            network.setInput(blob);
            List<Mat> outputs = new java.util.ArrayList<>();
            try {
                network.forward(outputs, network.getUnconnectedOutLayersNames());
                assertThat(outputs).hasSize(1);
                Mat output = outputs.getFirst();
                assertThat(output.dims()).isEqualTo(3);
                assertThat(output.size(0)).isEqualTo(1);
                assertThat(output.size(1)).isEqualTo(3549);
                assertThat(output.size(2)).isEqualTo(85);
                Mat flat = output.reshape(1, 1);
                try {
                    float[] values = new float[3549 * 85];
                    assertThat(flat.get(0, 0, values)).isEqualTo(Math.multiplyExact(values.length, Float.BYTES));
                    List<YoloOutputParser.Detection> raw = YoloXNanoOutputParser.decode(1, 3549, 85, values, 0.01);
                    List<DetectedObject> detections = YoloDetectionPostProcessor.process(raw,
                            YoloV8Adapter.supportedClassLabels(), prepared.transform(), 0.45, 1,
                            new YoloDetectionPostProcessor.Provenance("yolox_nano", "0.1.1rc0", SHA256));
                    double maxPersonIou = detections.stream().filter(d -> d.getClassName().equals("person"))
                            .mapToDouble(d -> iou(d, 120, 66, 176, 300)).max().orElse(0.0);
                    System.out.printf("YOLOX_NANO_LOCAL_EVAL fixture=synthetic-person-glyph source=local-original "
                                    + "image=416x416_BGR8 rawPixelSha256=%s opencv=%s modelBytes=%d modelSha256=%s "
                                    + "confidenceThreshold=0.01 nmsThreshold=0.45 decodedDetections=%d "
                                    + "personMaxIoU=%.4f%n",
                            fixtureSha256, Core.getVersionString(), MODEL_BYTES, SHA256, detections.size(), maxPersonIou);
                } finally { flat.release(); }
            } finally { outputs.forEach(Mat::release); }
        } finally {
            if (blob != null) blob.release();
            if (network != null) network = null; // OpenCV Net has no deterministic Java release method.
            image.release();
        }
    }

    private static double iou(DetectedObject detection, double x, double y, double width, double height) {
        var box = detection.getBoundingBox();
        double x1 = Math.max(box.getX(), x);
        double y1 = Math.max(box.getY(), y);
        double x2 = Math.min(box.getX() + box.getWidth(), x + width);
        double y2 = Math.min(box.getY() + box.getHeight(), y + height);
        double intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        double union = box.getWidth() * box.getHeight() + width * height - intersection;
        return union <= 0 ? 0 : intersection / union;
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

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
}
