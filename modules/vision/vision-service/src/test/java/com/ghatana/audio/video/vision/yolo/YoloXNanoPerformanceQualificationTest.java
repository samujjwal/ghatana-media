package com.ghatana.audio.video.vision.yolo;

import com.ghatana.audio.video.vision.model.DetectedObject;
import java.lang.management.ManagementFactory;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.opencv.core.Core;
import org.opencv.core.CvType;
import org.opencv.core.Mat;
import org.opencv.core.Scalar;
import org.opencv.dnn.Dnn;
import org.opencv.dnn.Net;
import org.opencv.imgproc.Imgproc;

import static org.assertj.core.api.Assertions.assertThat;

/** Opt-in local performance profile; results are REVIEW_ONLY, not provider-quality admission. */
class YoloXNanoPerformanceQualificationTest {
    private static final String MODEL_SHA256 = "c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d";
    private static final long MODEL_BYTES = 3_659_407L;
    private static final int INPUT_SIZE = 416;
    private static final int FRAMES_PER_LEVEL = 64;
    private static final double CONFIDENCE_THRESHOLD = 0.01;
    private static final double NMS_THRESHOLD = 0.45;
    private static final int[] CONCURRENCY_LEVELS = {1, 16, 64};

    @BeforeAll
    static void loadOpenCv() { nu.pattern.OpenCV.loadLocally(); }

    @Test
    void measuresPinnedOnnxSyntheticGlyphAtConcurrency1_16_64() throws Exception {
        String configured = System.getenv("GHATANA_MEDIA_YOLOX_NANO_MODEL");
        Assumptions.assumeTrue(configured != null && !configured.isBlank(),
                "set GHATANA_MEDIA_YOLOX_NANO_MODEL to the off-repo official release for local profiling");
        Path modelPath = Path.of(configured).toRealPath();
        assertThat(Files.size(modelPath)).isEqualTo(MODEL_BYTES);
        assertThat(sha256(modelPath)).isEqualTo(MODEL_SHA256);

        Mat fixture = syntheticPersonGlyph();
        Net net = null;
        try {
            byte[] pixels = new byte[INPUT_SIZE * INPUT_SIZE * 3];
            assertThat(fixture.get(0, 0, pixels)).isEqualTo(pixels.length);
            String fixtureSha256 = sha256(pixels);
            net = Dnn.readNetFromONNX(modelPath.toString());
            assertThat(net).isNotNull();
            assertThat(net.empty()).isFalse();
            net.setPreferableBackend(Dnn.DNN_BACKEND_DEFAULT);
            net.setPreferableTarget(Dnn.DNN_TARGET_CPU);

            try (RssSampler rss = new RssSampler()) {
                for (int concurrency : CONCURRENCY_LEVELS) {
                    // Match the production adapter's mutable Net discipline: setInput and
                    // forward are synchronized on one network. Preprocess/decode remain per call.
                    for (int warmup = 0; warmup < 4; warmup++) evaluateOne(net, fixture);
                    rss.resetPeak();
                    long cpuBefore = processCpuTimeNanos();
                    long wallStart = System.nanoTime();
                    List<Long> latencyNanos = evaluateLevel(net, fixture, concurrency);
                    long wallElapsed = System.nanoTime() - wallStart;
                    long cpuAfter = processCpuTimeNanos();
                    long cpuElapsed = cpuBefore < 0 || cpuAfter < 0 ? -1 : cpuAfter - cpuBefore;
                    double seconds = wallElapsed / 1_000_000_000.0;
                    long peakRssBytes = rss.peakBytes();
                    double fps = latencyNanos.size() / seconds;
                    double[] percentiles = percentilesMillis(latencyNanos);
                    System.out.printf("YOLOX_NANO_PERFORMANCE_REVIEW_ONLY fixture=synthetic-person-glyph "
                                    + "image=%dx%d_BGR8 rawPixelSha256=%s modelBytes=%d modelSha256=%s "
                                    + "opencv=%s serializedNet=true concurrency=%d frames=%d "
                                    + "confidenceThreshold=%.3f nmsThreshold=%.2f wallSeconds=%.3f "
                                    + "p50Ms=%.3f p95Ms=%.3f p99Ms=%.3f fps=%.3f processCpuMs=%s "
                                    + "sampledProcessPeakRssBytes=%s rssSampleIntervalMs=250 "
                                    + "outcome=NEGATIVE_SMOKE_NO_QUALITY_ADMISSION%n",
                            INPUT_SIZE, INPUT_SIZE, fixtureSha256, MODEL_BYTES, MODEL_SHA256,
                            Core.getVersionString(), concurrency, latencyNanos.size(),
                            CONFIDENCE_THRESHOLD, NMS_THRESHOLD, seconds,
                            percentiles[0], percentiles[1], percentiles[2], fps,
                            cpuElapsed < 0 ? "NOT_MEASURED" : String.format("%.3f", cpuElapsed / 1_000_000.0),
                            peakRssBytes <= 0 ? "NOT_MEASURED" : Long.toString(peakRssBytes));
                }
            }
        } finally {
            fixture.release();
            // OpenCV 4.9 Net has no deterministic Java release API.
            net = null;
        }
    }

    private static List<Long> evaluateLevel(Net net, Mat fixture, int concurrency) throws Exception {
        ExecutorService executor = Executors.newFixedThreadPool(concurrency);
        try {
            List<Callable<Long>> jobs = new ArrayList<>(FRAMES_PER_LEVEL);
            for (int i = 0; i < FRAMES_PER_LEVEL; i++) jobs.add(() -> evaluateOne(net, fixture));
            List<Future<Long>> futures = executor.invokeAll(jobs, 5, TimeUnit.MINUTES);
            List<Long> latencies = new ArrayList<>(FRAMES_PER_LEVEL);
            for (Future<Long> future : futures) {
                if (future.isCancelled()) throw new IllegalStateException("YOLOX local profile exceeded its 5-minute bound");
                latencies.add(future.get());
            }
            assertThat(latencies).hasSize(FRAMES_PER_LEVEL);
            return List.copyOf(latencies);
        } finally {
            executor.shutdownNow();
            if (!executor.awaitTermination(10, TimeUnit.SECONDS)) {
                throw new IllegalStateException("YOLOX profile workers did not stop after the bounded run");
            }
        }
    }

    private static long evaluateOne(Net net, Mat source) {
        long started = System.nanoTime();
        YoloXNanoAdapter.PreprocessedInput prepared = YoloXNanoAdapter.preprocess(source);
        Mat blob = prepared.blob();
        List<Mat> outputs = new ArrayList<>();
        try {
            synchronized (net) {
                net.setInput(blob);
                net.forward(outputs, net.getUnconnectedOutLayersNames());
            }
            if (outputs.size() != 1) throw new IllegalStateException("YOLOX-Nano must return one output tensor");
            Mat output = outputs.getFirst();
            if (output.empty() || output.dims() != 3 || output.channels() != 1 || output.depth() != CvType.CV_32F
                    || output.size(0) != 1 || output.size(1) != YoloXNanoOutputParser.PREDICTION_COUNT
                    || output.size(2) != YoloXNanoOutputParser.ATTRIBUTES) {
                throw new IllegalStateException("YOLOX-Nano output tensor must be [1,3549,85] float32");
            }
            Mat flattened = output.reshape(1, 1);
            try {
                float[] values = new float[YoloXNanoOutputParser.PREDICTION_COUNT * YoloXNanoOutputParser.ATTRIBUTES];
                if (flattened.get(0, 0, values) != Math.multiplyExact(values.length, Float.BYTES)) {
                    throw new IllegalStateException("YOLOX-Nano output tensor could not be read completely");
                }
                List<YoloOutputParser.Detection> raw = YoloXNanoOutputParser.decode(1,
                        YoloXNanoOutputParser.PREDICTION_COUNT, YoloXNanoOutputParser.ATTRIBUTES,
                        values, CONFIDENCE_THRESHOLD);
                List<DetectedObject> ignored = YoloDetectionPostProcessor.process(raw,
                        YoloV8Adapter.supportedClassLabels(), prepared.transform(), NMS_THRESHOLD, 1,
                        new YoloDetectionPostProcessor.Provenance("yolox_nano", "0.1.1rc0", MODEL_SHA256));
                return System.nanoTime() - started;
            } finally { flattened.release(); }
        } finally {
            blob.release();
            outputs.forEach(Mat::release);
        }
    }

    private static Mat syntheticPersonGlyph() {
        Mat image = new Mat(INPUT_SIZE, INPUT_SIZE, CvType.CV_8UC3, new Scalar(24, 24, 24));
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
        return image;
    }

    private static double[] percentilesMillis(List<Long> latencies) {
        List<Long> sorted = latencies.stream().sorted().toList();
        return new double[] {percentile(sorted, 0.50), percentile(sorted, 0.95), percentile(sorted, 0.99)};
    }

    private static double percentile(List<Long> sortedNanos, double p) {
        int index = Math.max(0, (int) Math.ceil(p * sortedNanos.size()) - 1);
        return sortedNanos.get(index) / 1_000_000.0;
    }

    private static long processCpuTimeNanos() {
        java.lang.management.OperatingSystemMXBean bean = ManagementFactory.getOperatingSystemMXBean();
        if (bean instanceof com.sun.management.OperatingSystemMXBean extended) {
            return extended.getProcessCpuTime();
        }
        return -1;
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

    private static final class RssSampler implements AutoCloseable {
        private final ScheduledExecutorService sampler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread thread = new Thread(r, "yolox-review-rss-sampler");
            thread.setDaemon(true);
            return thread;
        });
        private final AtomicLong peakBytes = new AtomicLong();

        private RssSampler() {
            sampler.scheduleAtFixedRate(this::sample, 0, 250, TimeUnit.MILLISECONDS);
        }

        private void resetPeak() { peakBytes.set(0); }
        private long peakBytes() { return peakBytes.get(); }

        private void sample() {
            try {
                long rss = linuxRssBytes();
                if (rss <= 0) rss = macRssBytes();
                if (rss > 0) peakBytes.accumulateAndGet(rss, Math::max);
            } catch (Exception ignored) { }
        }

        private static long linuxRssBytes() throws Exception {
            Path status = Path.of("/proc/self/status");
            if (!Files.isRegularFile(status)) return -1;
            for (String line : Files.readAllLines(status)) {
                if (line.startsWith("VmRSS:")) return Long.parseLong(line.replaceAll("[^0-9]", "")) * 1024L;
            }
            return -1;
        }

        private static long macRssBytes() throws Exception {
            Process process = new ProcessBuilder("ps", "-o", "rss=", "-p", Long.toString(ProcessHandle.current().pid()))
                    .redirectError(ProcessBuilder.Redirect.DISCARD).start();
            try {
                if (!process.waitFor(2, TimeUnit.SECONDS) || process.exitValue() != 0) return -1;
                String kilobytes = new String(process.getInputStream().readAllBytes()).trim();
                return kilobytes.isEmpty() ? -1 : Long.parseLong(kilobytes) * 1024L;
            } finally { process.destroyForcibly(); }
        }

        @Override public void close() throws Exception {
            sampler.shutdownNow();
            if (!sampler.awaitTermination(2, TimeUnit.SECONDS)) throw new IllegalStateException("RSS sampler did not stop");
        }
    }
}
