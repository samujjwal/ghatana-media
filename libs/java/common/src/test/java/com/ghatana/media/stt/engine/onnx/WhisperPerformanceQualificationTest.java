package com.ghatana.media.stt.engine.onnx;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.common.ResourceExhaustedError;
import com.ghatana.media.config.SttConfig;
import com.ghatana.media.stt.api.TranscriptionOptions;
import org.junit.jupiter.api.Test;

import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/** Opt-in, local-only performance evidence for the hash-pinned Whisper ONNX reference export. */
class WhisperPerformanceQualificationTest {
    private static final String PROFILE_ENV = "GHATANA_MEDIA_WHISPER_PROFILE";
    private static final String AUDIO_ENV = "GHATANA_MEDIA_WHISPER_AUDIO";
    private static final String RUN_ENV = "WHISPER_PERF_QUALIFICATION";
    private static final int[] CONCURRENCY_LEVELS = {1, 16, 64};
    private static final int MAX_CONCURRENCY = 64;
    private static final int MEASURED_REQUESTS_PER_LEVEL = 64;
    private static final long DEFAULT_TIMEOUT_SECONDS = 900;
    private static final long MAX_TIMEOUT_SECONDS = 1800;
    // Linux ARM64 containers can be heavily CPU-constrained while bringing up 64 virtual workers.
    // Keep the barrier bounded, but allow the coordinator to be rescheduled before workers time out.
    private static final long START_BARRIER_TIMEOUT_SECONDS = 120;
    private static final String INPUT_PCM_SHA256 =
            "9dfb1b2f033873cc08266bb0ffb2754a52e6c23b3c071e55969ad1c6d8af4c26";
    private static final String INPUT_WAV_SHA256 =
            "3a4b3edcd1b2bd6b9237434f92d9225c2907cfbb85054348a03d4341c235be75";
    private static final String ENCODER_SHA256 =
            "2af4a414ca47aa30f61246017e5fe82b0a8d229281d1255ba666a2a7f6b84d19";
    private static final String DECODER_SHA256 =
            "25e807a962b6349356d0ea5d0dfe530b7e5bf0e2a484aeca0359d03143faddd3";

    @Test
    void measuresPinnedWhisperCpuInferenceAtBoundedConcurrency() throws Exception {
        assumeTrue("RUN".equals(System.getenv(RUN_ENV)),
                "Opt in with WHISPER_PERF_QUALIFICATION=RUN to execute the local Whisper load probe");
        Path profile = requiredPrivatePath(PROFILE_ENV, true);
        Path wav = requiredPrivatePath(AUDIO_ENV, false);
        assertEquals(INPUT_WAV_SHA256, sha256(Files.readAllBytes(wav)), "WAV fixture must match the recorded pin");
        AudioData audio = readPcm16MonoWav(wav);
        assertEquals(INPUT_PCM_SHA256, sha256(audio.data()), "PCM fixture must match the recorded pin");

        SttConfig config = SttConfig.builder()
                .modelPath(profile.resolve("encoder_model_quantized.onnx"))
                .modelId("whisper-tiny-multilingual-onnx-reference")
                .maxConcurrentRequests(MAX_CONCURRENCY)
                .maxAudioLengthSeconds(30)
                .timeout(Duration.ofMinutes(10))
                .build();
        TranscriptionOptions options = TranscriptionOptions.builder()
                .language(Locale.ENGLISH)
                .enableTimestamps(false)
                .build();

        RssSampler rssSampler = new RssSampler();
        rssSampler.sampleNow();
        rssSampler.start();
        long loadStarted = System.nanoTime();
        try (WhisperOnnxEngine engine = new WhisperOnnxEngine(config, new AudioVideoLibrary.LibraryState())) {
            long modelLoadMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - loadStarted);
            assertSaturationRejectsBeforeInference(engine, audio, options);
            ExecutorService workers = Executors.newFixedThreadPool(MAX_CONCURRENCY, Thread.ofVirtual().factory());
            List<LevelResult> results = new ArrayList<>();
            boolean workersStopped = false;
            long deadlineNanos = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSeconds());
            try {
                for (int concurrency : CONCURRENCY_LEVELS) {
                    assertTrue(concurrency <= MAX_CONCURRENCY, "benchmark concurrency must remain bounded");
                    runBatch(engine, workers, concurrency, audio, options, deadlineNanos); // warmup, not measured
                    results.add(runMeasuredLevel(engine, workers, concurrency, audio, options, deadlineNanos));
                }
                workers.shutdown();
                workersStopped = workers.awaitTermination(10, TimeUnit.SECONDS);
                assertTrue(workersStopped, "Whisper benchmark workers did not terminate cleanly");
            } finally {
                if (!workersStopped) {
                    workers.shutdownNow();
                    workers.awaitTermination(10, TimeUnit.SECONDS);
                }
            }
            rssSampler.sampleNow();
            System.out.printf(Locale.ROOT,
                    "WHISPER_PERF_RESULT={\"profile\":\"whisper-tiny-multilingual-onnx-review\","
                            + "\"encoderSha256\":\"%s\",\"decoderSha256\":\"%s\","
                            + "\"inputWavSha256\":\"%s\",\"inputPcmSha256\":\"%s\","
                            + "\"inputSamples\":%d,\"audioSeconds\":%.6f,\"hostOs\":\"%s\","
                            + "\"hostArch\":\"%s\",\"javaVersion\":\"%s\",\"runtime\":\"ONNX Runtime Java 1.29.0 CPU\","
                            + "\"modelLoadMs\":%d,\"availableProcessors\":%d,\"maxConcurrentRequests\":%d,"
                            + "\"saturationRejection\":\"PASS_TYPED_RESOURCE_EXHAUSTED_WITH_ALL_PERMITS_HELD\","
                            + "\"measuredRequestsPerLevel\":%d,\"qualificationBoundary\":\"REVIEW_ONLY_LOCAL_EVALUATION_NO_RIGHTS_OR_QUALITY_ADMISSION\","
                            + "\"timeoutSeconds\":%d,\"processRssPeakBytes\":%d,\"processRssAvailable\":%s,"
                            + "\"levels\":[%s]}%n",
                    ENCODER_SHA256, DECODER_SHA256, INPUT_WAV_SHA256, INPUT_PCM_SHA256,
                    audio.data().length / 2, audio.duration().toNanos() / 1_000_000_000.0,
                    System.getProperty("os.name"), System.getProperty("os.arch"),
                    System.getProperty("java.version"), modelLoadMillis,
                    Runtime.getRuntime().availableProcessors(), MAX_CONCURRENCY,
                    MEASURED_REQUESTS_PER_LEVEL, timeoutSeconds(), rssSampler.peakBytes(),
                    rssSampler.available(),
                    results.stream().map(LevelResult::toJson).reduce((a, b) -> a + "," + b).orElse("")
            );
        } finally {
            rssSampler.stop();
        }
    }

    private static void assertSaturationRejectsBeforeInference(
            WhisperOnnxEngine engine, AudioData audio, TranscriptionOptions options) throws Exception {
        java.lang.reflect.Field field = WhisperOnnxEngine.class.getDeclaredField("concurrencyLimiter");
        field.setAccessible(true);
        Semaphore permits = (Semaphore) field.get(engine);
        assertTrue(permits.tryAcquire(MAX_CONCURRENCY), "test must reserve every configured inference permit");
        try {
            assertThrows(ResourceExhaustedError.class, () -> engine.transcribe(audio, options),
                    "saturated Whisper admission must reject without waiting or entering ONNX inference");
        } finally {
            permits.release(MAX_CONCURRENCY);
        }
    }

    private static LevelResult runMeasuredLevel(
            WhisperOnnxEngine engine,
            ExecutorService workers,
            int concurrency,
            AudioData audio,
            TranscriptionOptions options,
            long deadlineNanos) throws Exception {
        List<Measurement> measurements = new ArrayList<>(MEASURED_REQUESTS_PER_LEVEL);
        long elapsedNanos = 0;
        long cpuStart = processCpuTimeNanos();
        while (measurements.size() < MEASURED_REQUESTS_PER_LEVEL) {
            int batch = Math.min(concurrency, MEASURED_REQUESTS_PER_LEVEL - measurements.size());
            long started = System.nanoTime();
            measurements.addAll(runBatch(engine, workers, batch, audio, options, deadlineNanos));
            elapsedNanos += System.nanoTime() - started;
        }
        long cpuEnd = processCpuTimeNanos();
        long processCpuNanos = cpuStart < 0 || cpuEnd < cpuStart ? -1L : cpuEnd - cpuStart;
        double elapsedSeconds = elapsedNanos / 1_000_000_000.0d;
        double audioSeconds = measurements.size() * audio.duration().toNanos() / 1_000_000_000.0d;
        double[] latencies = measurements.stream().mapToDouble(Measurement::latencyMillis).sorted().toArray();
        return new LevelResult(concurrency, measurements.size(), elapsedSeconds,
                measurements.size() / elapsedSeconds, percentile(latencies, 0.50),
                percentile(latencies, 0.95), percentile(latencies, 0.99),
                elapsedSeconds / audioSeconds, audioSeconds, processCpuNanos,
                Runtime.getRuntime().availableProcessors(),
                measurements.stream().map(Measurement::transcriptSha256).distinct().count());
    }

    private static List<Measurement> runBatch(
            WhisperOnnxEngine engine,
            ExecutorService workers,
            int concurrency,
            AudioData audio,
            TranscriptionOptions options,
            long deadlineNanos) throws Exception {
        CountDownLatch ready = new CountDownLatch(concurrency);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<Measurement>> futures = new ArrayList<>(concurrency);
        for (int i = 0; i < concurrency; i++) {
            futures.add(workers.submit(() -> {
                ready.countDown();
                if (!start.await(START_BARRIER_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                    throw new TimeoutException("Whisper benchmark start barrier timed out");
                }
                long requestStarted = System.nanoTime();
                var result = engine.transcribe(audio, options);
                long latency = System.nanoTime() - requestStarted;
                String text = result.getText();
                assertNotNull(text, "Whisper returned no transcript");
                assertFalse(text.isBlank(), "Whisper must produce genuine nonempty model output");
                return new Measurement(latency / 1_000_000.0d,
                        sha256(text.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
            }));
        }
        if (!ready.await(START_BARRIER_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            futures.forEach(f -> f.cancel(true));
            throw new TimeoutException("Whisper benchmark workers did not reach the start barrier");
        }
        start.countDown();
        List<Measurement> measurements = new ArrayList<>(concurrency);
        try {
            for (Future<Measurement> future : futures) {
                long remaining = deadlineNanos - System.nanoTime();
                if (remaining <= 0) throw new TimeoutException("Whisper benchmark exceeded its total timeout");
                measurements.add(future.get(remaining, TimeUnit.NANOSECONDS));
            }
            return measurements;
        } catch (Exception failure) {
            futures.forEach(f -> f.cancel(true));
            throw failure;
        }
    }

    private static AudioData readPcm16MonoWav(Path path) throws Exception {
        try (AudioInputStream input = AudioSystem.getAudioInputStream(path.toFile())) {
            var format = input.getFormat();
            assertEquals("PCM_SIGNED", format.getEncoding().toString());
            assertEquals(16_000.0f, format.getSampleRate());
            assertEquals(1, format.getChannels());
            assertEquals(16, format.getSampleSizeInBits());
            assertFalse(format.isBigEndian());
            byte[] pcm = input.readAllBytes();
            assertTrue(pcm.length > 0 && (pcm.length & 1) == 0);
            return new AudioData(pcm, 16_000, 1, 16,
                    Duration.ofNanos((long) (pcm.length / 2 * 1_000_000_000.0d / 16_000)), AudioFormat.PCM);
        }
    }

    private static Path requiredPrivatePath(String name, boolean directory) throws IOException {
        String configured = System.getenv(name);
        assumeTrue(configured != null && !configured.isBlank(), "Set " + name + " to a staged private asset");
        Path path = Path.of(configured).toAbsolutePath().normalize();
        assertFalse(path.startsWith(Path.of(System.getProperty("user.dir")).toAbsolutePath().normalize()),
                "reference assets must remain outside the repository");
        assertTrue(directory ? Files.isDirectory(path) : Files.isRegularFile(path),
                "configured reference asset is missing: " + name);
        assertTrue(Files.isReadable(path));
        return path;
    }

    private static long timeoutSeconds() {
        String value = System.getenv("WHISPER_PERF_TIMEOUT_SECONDS");
        long parsed = value == null || value.isBlank() ? DEFAULT_TIMEOUT_SECONDS : Long.parseLong(value);
        assertTrue(parsed >= 60 && parsed <= MAX_TIMEOUT_SECONDS,
                "WHISPER_PERF_TIMEOUT_SECONDS must be between 60 and " + MAX_TIMEOUT_SECONDS);
        return parsed;
    }

    private static long processCpuTimeNanos() {
        return ProcessHandle.current().info().totalCpuDuration().map(Duration::toNanos).orElse(-1L);
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static double percentile(double[] sorted, double quantile) {
        int index = (int) Math.ceil(quantile * sorted.length) - 1;
        return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
    }

    private record Measurement(double latencyMillis, String transcriptSha256) {}

    private record LevelResult(
            int concurrency,
            int requests,
            double elapsedSeconds,
            double requestsPerSecond,
            double p50Millis,
            double p95Millis,
            double p99Millis,
            double realTimeFactor,
            double totalAudioSeconds,
            long processCpuNanos,
            int availableProcessors,
            long distinctTranscriptDigests) {
        String toJson() {
            double cpuHostPercent = processCpuNanos < 0 || elapsedSeconds <= 0 || availableProcessors <= 0
                    ? -1.0d : 100.0d * processCpuNanos / 1_000_000_000.0d
                    / (elapsedSeconds * availableProcessors);
            return String.format(Locale.ROOT,
                    "{\"concurrency\":%d,\"requests\":%d,\"elapsedSeconds\":%.6f,"
                            + "\"requestsPerSecond\":%.6f,\"latencyP50Ms\":%.3f,\"latencyP95Ms\":%.3f,"
                            + "\"latencyP99Ms\":%.3f,\"aggregateRealTimeFactor\":%.6f,"
                            + "\"processCpuSeconds\":%.6f,\"cpuPercentOfHost\":%.3f,"
                            + "\"totalAudioSeconds\":%.6f,\"distinctTranscriptDigests\":%d}",
                    concurrency, requests, elapsedSeconds, requestsPerSecond, p50Millis, p95Millis,
                    p99Millis, realTimeFactor,
                    processCpuNanos < 0 ? -1.0d : processCpuNanos / 1_000_000_000.0d,
                    cpuHostPercent, totalAudioSeconds, distinctTranscriptDigests);
        }
    }

    private static final class RssSampler {
        private final AtomicLong peak = new AtomicLong(-1);
        private final AtomicBoolean available = new AtomicBoolean(false);
        private final java.util.concurrent.ScheduledExecutorService monitor =
                Executors.newSingleThreadScheduledExecutor(Thread.ofPlatform().daemon().factory());

        void start() { monitor.scheduleAtFixedRate(this::sampleNow, 0, 250, TimeUnit.MILLISECONDS); }
        void stop() { monitor.shutdownNow(); }
        long peakBytes() { return peak.get(); }
        boolean available() { return available.get(); }

        void sampleNow() {
            long rss = readRssBytes();
            if (rss >= 0) {
                available.set(true);
                peak.accumulateAndGet(rss, Math::max);
            }
        }

        private static long readRssBytes() {
            Path status = Path.of("/proc", Long.toString(ProcessHandle.current().pid()), "status");
            if (Files.isReadable(status)) {
                try (var lines = Files.lines(status)) {
                    return lines.filter(line -> line.startsWith("VmRSS:"))
                            .map(line -> line.replace("VmRSS:", "").trim().split("\\s+"))
                            .filter(parts -> parts.length > 0)
                            .mapToLong(parts -> Long.parseLong(parts[0]) * 1024)
                            .findFirst().orElse(-1L);
                } catch (IOException | NumberFormatException ignored) {
                    return -1L;
                }
            }
            try {
                Process process = new ProcessBuilder("ps", "-o", "rss=", "-p",
                        Long.toString(ProcessHandle.current().pid())).redirectErrorStream(true).start();
                if (!process.waitFor(500, TimeUnit.MILLISECONDS)) {
                    process.destroyForcibly();
                    return -1L;
                }
                String output = new String(process.getInputStream().readAllBytes()).trim();
                if (process.exitValue() != 0 || output.isBlank()) return -1L;
                return Long.parseLong(output.split("\\s+")[0]) * 1024;
            } catch (IOException | InterruptedException | NumberFormatException ignored) {
                if (Thread.currentThread().isInterrupted()) Thread.currentThread().interrupt();
                return -1L;
            }
        }
    }
}
