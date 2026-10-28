package com.ghatana.tts.qualification;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.ResourceExhaustedError;
import com.ghatana.media.config.TtsConfig;
import com.ghatana.media.tts.api.SynthesisOptions;
import com.ghatana.media.tts.engine.onnx.PiperOnnxEngine;
import com.ghatana.media.tts.phoneme.TextToPhonemeConverter;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

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

/**
 * Opt-in, local-only performance evidence for the exact review-only Piper reference voice.
 *
 * <p>Run with {@code PIPER_PERF_QUALIFICATION=RUN}, an absolute private model path, and matching
 * model/sidecar SHA-256 environment variables. This never downloads assets or writes audio. It is
 * not a license, consent, voice-likeness, quality, provider-admission, or release decision.
 * Example: {@code PIPER_PERF_QUALIFICATION=RUN PIPER_PERF_MODEL_PATH=/private/.../en_US-ljspeech-medium.onnx
 * PIPER_PERF_MODEL_SHA256=<pinned-hash> PIPER_PERF_SIDECAR_SHA256=<pinned-sidecar-hash>
 * ./gradlew :services:media:modules:speech:tts-service:test
 * --tests com.ghatana.tts.qualification.PiperPerformanceQualificationTest}.
 */
class PiperPerformanceQualificationTest {
    private static final String EXPECTED_VOICE_ID = "en_US-ljspeech-medium";
    private static final String MODEL_SHA_ENV = "PIPER_PERF_MODEL_SHA256";
    private static final String SIDECAR_SHA_ENV = "PIPER_PERF_SIDECAR_SHA256";
    private static final String MODEL_PATH_ENV = "PIPER_PERF_MODEL_PATH";
    private static final String TIMEOUT_ENV = "PIPER_PERF_TIMEOUT_SECONDS";
    private static final String EXPECTED_MODEL_SHA256 =
            "6f52a751e2349abe7a76735eb09dc1875298c77ea2342ffd2fef79ff81b87f22";
    private static final String EXPECTED_SIDECAR_SHA256 =
            "141d612cc0a95ed7efc1ca936b845c2364967f2e9217c5dbfcf69fc4d6c65860";
    private static final String TEXT = "The quick brown fox jumps over the lazy dog.";
    private static final int SAMPLE_RATE = 22_050;
    private static final int[] CONCURRENCY_LEVELS = {1, 16, 64};
    private static final int MAX_CONCURRENCY = 64;
    private static final int MEASURED_REQUESTS_PER_LEVEL = 64;
    private static final long DEFAULT_TIMEOUT_SECONDS = 300;
    private static final long MAX_TIMEOUT_SECONDS = 900;
    private static final long OUTPUT_MEMORY_LIMIT_BYTES = 32L * 1024 * 1024;
    private static final long START_BARRIER_TIMEOUT_SECONDS = 15;

    @Test
    void measuresPinnedPiperCpuInferenceAtBoundedConcurrency() throws Exception {
        Assumptions.assumeTrue(
                "RUN".equals(System.getenv("PIPER_PERF_QUALIFICATION")),
                "Opt in with PIPER_PERF_QUALIFICATION=RUN to execute the local Piper performance probe");

        Path modelPath = requirePrivateModelPath();
        Path sidecarPath = modelPath.resolveSibling(modelPath.getFileName() + ".json");
        String modelSha = requireSha256(MODEL_SHA_ENV, modelPath);
        String sidecarSha = requireSha256(SIDECAR_SHA_ENV, sidecarPath);
        assertEquals(EXPECTED_MODEL_SHA256, modelSha, "reference model must match the R9 source pin");
        assertEquals(EXPECTED_SIDECAR_SHA256, sidecarSha, "reference sidecar must match the reviewed snapshot");
        long timeoutSeconds = timeoutSeconds();
        long deadlineNanos = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSeconds);

        TtsConfig config = TtsConfig.builder()
                .voiceModelPath(modelPath)
                .defaultVoiceId(EXPECTED_VOICE_ID)
                .availableVoices(List.of(EXPECTED_VOICE_ID))
                .maxConcurrentRequests(MAX_CONCURRENCY)
                .timeout(Duration.ofSeconds(timeoutSeconds))
                .sampleRate(SAMPLE_RATE)
                .maxTextLength(256)
                .enableProsody(false)
                .enableVoiceCloning(false)
                .enableStreaming(false)
                .allowSyntheticFallback(false)
                .maxMemoryBytes(OUTPUT_MEMORY_LIMIT_BYTES)
                .build();

        long loadStarted = System.nanoTime();
        try (PiperOnnxEngine engine = new PiperOnnxEngine(config, new AudioVideoLibrary.LibraryState())) {
            long loadMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - loadStarted);
            assertSaturationRejectsBeforeInference(engine);
            TextToPhonemeConverter phonemizer = TextToPhonemeConverter.forLocale(Locale.ENGLISH);
            RssSampler rssSampler = new RssSampler();
            rssSampler.sampleNow();
            rssSampler.start();
            ExecutorService workers = Executors.newFixedThreadPool(MAX_CONCURRENCY, Thread.ofVirtual().factory());
            List<LevelResult> results = new ArrayList<>();
            boolean workersStopped = false;
            try {
                for (int concurrency : CONCURRENCY_LEVELS) {
                    assertTrue(concurrency <= MAX_CONCURRENCY, "benchmark concurrency must remain bounded");
                    runBatch(engine, workers, concurrency, deadlineNanos); // per-level warmup, not measured
                    results.add(runMeasuredLevel(engine, workers, concurrency, deadlineNanos));
                }
                workers.shutdown();
                workersStopped = workers.awaitTermination(5, TimeUnit.SECONDS);
                assertTrue(workersStopped, "Piper benchmark workers did not terminate cleanly");
            } finally {
                rssSampler.stop();
                if (!workersStopped) {
                    workers.shutdownNow();
                    workers.awaitTermination(5, TimeUnit.SECONDS);
                }
            }

            long rssPeakBytes = rssSampler.peakBytes();
            System.out.printf(Locale.ROOT,
                    "PIPER_PERF_RESULT={\"voiceId\":\"%s\",\"modelSha256\":\"%s\","
                            + "\"sidecarSha256\":\"%s\",\"hostOs\":\"%s\",\"hostArch\":\"%s\","
                            + "\"javaVersion\":\"%s\",\"sampleRateHz\":%d,\"modelLoadMs\":%d,"
                            + "\"phonemizer\":\"%s\",\"phonemizerQualityTier\":%d,"
                            + "\"availableProcessors\":%d,\"maxConcurrentRequests\":%d,"
                            + "\"warmupsPerLevel\":[1,16,64],\"measuredRequestsPerLevel\":%d,"
                            + "\"saturationRejection\":\"PASS_TYPED_RESOURCE_EXHAUSTED_WITH_ALL_PERMITS_HELD\","
                            + "\"qualificationBoundary\":\"REVIEW_ONLY_LOCAL_EVALUATION_NO_RIGHTS_OR_ADMISSION\","
                            + "\"timeoutSeconds\":%d,\"jvmRssPeakBytes\":%d,\"jvmRssAvailable\":%s,"
                            + "\"levels\":[%s]}%n",
                    EXPECTED_VOICE_ID, modelSha, sidecarSha, System.getProperty("os.name"),
                    System.getProperty("os.arch"), System.getProperty("java.version"), SAMPLE_RATE,
                    loadMillis, phonemizer.getClass().getSimpleName(), phonemizer.qualityTier(),
                    Runtime.getRuntime().availableProcessors(), MAX_CONCURRENCY, MEASURED_REQUESTS_PER_LEVEL,
                    timeoutSeconds, rssPeakBytes, rssSampler.available(),
                    results.stream().map(LevelResult::toJson).reduce((a, b) -> a + "," + b).orElse("")
            );
        }
    }

    private static void assertSaturationRejectsBeforeInference(PiperOnnxEngine engine) throws Exception {
        java.lang.reflect.Field field = PiperOnnxEngine.class.getDeclaredField("concurrencyLimiter");
        field.setAccessible(true);
        Semaphore permits = (Semaphore) field.get(engine);
        assertTrue(permits.tryAcquire(MAX_CONCURRENCY), "test must reserve every configured synthesis permit");
        try {
            assertThrows(ResourceExhaustedError.class,
                    () -> engine.synthesize(TEXT, SynthesisOptions.defaults()),
                    "saturated Piper admission must reject without waiting or entering ONNX inference");
        } finally {
            permits.release(MAX_CONCURRENCY);
        }
    }

    private static LevelResult runMeasuredLevel(
            PiperOnnxEngine engine,
            ExecutorService workers,
            int concurrency,
            long deadlineNanos) throws Exception {
        List<Measurement> measurements = new ArrayList<>(MEASURED_REQUESTS_PER_LEVEL);
        long totalElapsedNanos = 0;
        long cpuStartNanos = processCpuTimeNanos();
        while (measurements.size() < MEASURED_REQUESTS_PER_LEVEL) {
            int batchSize = Math.min(concurrency, MEASURED_REQUESTS_PER_LEVEL - measurements.size());
            long batchStarted = System.nanoTime();
            measurements.addAll(runBatch(engine, workers, batchSize, deadlineNanos));
            totalElapsedNanos += System.nanoTime() - batchStarted;
        }
        double elapsedSeconds = totalElapsedNanos / 1_000_000_000.0;
        long cpuEndNanos = processCpuTimeNanos();
        long cpuNanos = cpuStartNanos < 0 || cpuEndNanos < cpuStartNanos
                ? -1L : cpuEndNanos - cpuStartNanos;
        double totalAudioSeconds = measurements.stream()
                .mapToDouble(m -> m.samples() / (double) SAMPLE_RATE)
                .sum();
        double[] latenciesMs = measurements.stream().mapToDouble(Measurement::latencyMillis).sorted().toArray();
        double throughput = measurements.size() / elapsedSeconds;
        double realTimeFactor = elapsedSeconds / totalAudioSeconds;
        return new LevelResult(concurrency, measurements.size(), elapsedSeconds, throughput,
                percentile(latenciesMs, 0.50), percentile(latenciesMs, 0.95),
                percentile(latenciesMs, 0.99), realTimeFactor, totalAudioSeconds,
                measurements.stream().mapToLong(Measurement::samples).min().orElseThrow(),
                measurements.stream().mapToLong(Measurement::samples).max().orElseThrow(),
                cpuNanos, Runtime.getRuntime().availableProcessors());
    }

    private static List<Measurement> runBatch(
            PiperOnnxEngine engine,
            ExecutorService workers,
            int concurrency,
            long deadlineNanos) throws Exception {
        CountDownLatch ready = new CountDownLatch(concurrency);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<Measurement>> futures = new ArrayList<>(concurrency);
        for (int index = 0; index < concurrency; index++) {
            futures.add(workers.submit(() -> {
                ready.countDown();
                if (!start.await(START_BARRIER_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                    throw new TimeoutException("Piper benchmark start barrier timed out");
                }
                long started = System.nanoTime();
                AudioData audio = engine.synthesize(TEXT, SynthesisOptions.defaults());
                long elapsed = System.nanoTime() - started;
                return validateAndMeasure(audio, elapsed);
            }));
        }

        if (!ready.await(START_BARRIER_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            futures.forEach(f -> f.cancel(true));
            throw new TimeoutException("Piper benchmark workers did not reach the start barrier");
        }
        start.countDown();
        List<Measurement> measurements = new ArrayList<>(concurrency);
        try {
            for (Future<Measurement> future : futures) {
                long remaining = deadlineNanos - System.nanoTime();
                if (remaining <= 0) throw new TimeoutException("Piper benchmark exceeded its configured total timeout");
                measurements.add(future.get(remaining, TimeUnit.NANOSECONDS));
            }
            return measurements;
        } catch (Exception failure) {
            futures.forEach(f -> f.cancel(true));
            throw failure;
        }
    }

    private static Measurement validateAndMeasure(AudioData audio, long elapsedNanos) {
        assertNotNull(audio, "Piper returned no audio");
        assertEquals(SAMPLE_RATE, audio.sampleRate(), "Piper sample rate must match the configured profile");
        assertEquals(1, audio.channels(), "Piper output must be mono");
        assertEquals(16, audio.bitsPerSample(), "Piper output must be PCM16");
        byte[] pcm = audio.data();
        assertNotNull(pcm, "Piper returned no PCM bytes");
        assertTrue(pcm.length >= 2 && (pcm.length & 1) == 0, "Piper PCM must contain whole non-empty samples");

        int uniqueSamples = 0;
        short first = (short) ((pcm[1] << 8) | (pcm[0] & 0xff));
        boolean hasNonZeroSample = false;
        for (int offset = 0; offset < pcm.length; offset += 2) {
            short sample = (short) ((pcm[offset + 1] << 8) | (pcm[offset] & 0xff));
            if (sample != 0) hasNonZeroSample = true;
            if (sample != first) uniqueSamples++;
        }
        assertTrue(hasNonZeroSample, "Piper output must not be silent");
        assertTrue(uniqueSamples > 0, "Piper output must not be a repeated constant sample");
        return new Measurement(elapsedNanos / 1_000_000.0, pcm.length / 2L);
    }

    private static Path requirePrivateModelPath() throws IOException {
        String configured = System.getenv(MODEL_PATH_ENV);
        Assumptions.assumeTrue(configured != null && !configured.isBlank(),
                "Set PIPER_PERF_MODEL_PATH to an already staged private model file");
        Path path = Path.of(configured);
        assertTrue(path.isAbsolute(), "model path must be absolute");
        assertFalse(path.normalize().startsWith(Path.of(System.getProperty("user.dir")).toAbsolutePath().normalize()),
                "private model assets must remain outside the repository");
        assertTrue(Files.isRegularFile(path) && Files.isReadable(path), "private Piper model file must be readable");
        assertEquals("en_US-ljspeech-medium.onnx", path.getFileName().toString(),
                "this reference harness is bound to the selected LJSpeech voice");
        return path;
    }

    private static String requireSha256(String environmentName, Path path) throws Exception {
        String expected = System.getenv(environmentName);
        assertNotNull(expected, "Set " + environmentName + " to the independently pinned SHA-256");
        assertTrue(expected.matches("[0-9a-f]{64}"), environmentName + " must be lowercase SHA-256 hex");
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(path));
        String actual = HexFormat.of().formatHex(digest);
        assertEquals(expected, actual, environmentName + " does not match the staged asset");
        return actual;
    }

    private static long timeoutSeconds() {
        String value = System.getenv(TIMEOUT_ENV);
        if (value == null || value.isBlank()) return DEFAULT_TIMEOUT_SECONDS;
        long parsed = Long.parseLong(value);
        assertTrue(parsed >= 30 && parsed <= MAX_TIMEOUT_SECONDS,
                TIMEOUT_ENV + " must be between 30 and " + MAX_TIMEOUT_SECONDS + " seconds");
        return parsed;
    }

    private static double percentile(double[] sorted, double quantile) {
        if (sorted.length == 0) throw new IllegalArgumentException("percentile requires observations");
        int index = (int) Math.ceil(quantile * sorted.length) - 1;
        return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
    }

    private static long processCpuTimeNanos() {
        return ProcessHandle.current().info().totalCpuDuration()
                .map(Duration::toNanos).orElse(-1L);
    }

    private record Measurement(double latencyMillis, long samples) {}

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
            long minimumSamplesPerResponse,
            long maximumSamplesPerResponse,
            long processCpuNanos,
            int availableProcessors) {
        String toJson() {
            double cpuPercentOfHost = processCpuNanos < 0 || elapsedSeconds <= 0 || availableProcessors <= 0
                    ? -1.0d : 100.0d * processCpuNanos / 1_000_000_000.0d
                    / (elapsedSeconds * availableProcessors);
            return String.format(Locale.ROOT,
                    "{\"concurrency\":%d,\"requests\":%d,\"elapsedSeconds\":%.6f,"
                            + "\"requestsPerSecond\":%.6f,\"latencyP50Ms\":%.3f,\"latencyP95Ms\":%.3f,"
                            + "\"latencyP99Ms\":%.3f,\"aggregateRealTimeFactor\":%.6f,"
                            + "\"processCpuSeconds\":%.6f,\"cpuPercentOfHost\":%.3f,"
                            + "\"totalAudioSeconds\":%.6f,\"minimumSamplesPerResponse\":%d,"
                            + "\"maximumSamplesPerResponse\":%d}",
                    concurrency, requests, elapsedSeconds, requestsPerSecond, p50Millis, p95Millis,
                    p99Millis, realTimeFactor, processCpuNanos < 0 ? -1.0d : processCpuNanos / 1_000_000_000.0d,
                    cpuPercentOfHost, totalAudioSeconds,
                    minimumSamplesPerResponse, maximumSamplesPerResponse);
        }
    }

    private static final class RssSampler {
        private final AtomicLong peak = new AtomicLong(-1);
        private final AtomicBoolean available = new AtomicBoolean(false);
        private final java.util.concurrent.ScheduledExecutorService monitor =
                Executors.newSingleThreadScheduledExecutor(Thread.ofPlatform().daemon().factory());

        void start() {
            monitor.scheduleAtFixedRate(this::sampleNow, 0, 250, TimeUnit.MILLISECONDS);
        }

        void sampleNow() {
            long rss = readRssBytes();
            if (rss >= 0) {
                available.set(true);
                peak.accumulateAndGet(rss, Math::max);
            }
        }

        void stop() {
            monitor.shutdownNow();
        }

        long peakBytes() {
            return peak.get();
        }

        boolean available() {
            return available.get();
        }

        private static long readRssBytes() {
            Path procStatus = Path.of("/proc", Long.toString(ProcessHandle.current().pid()), "status");
            if (Files.isReadable(procStatus)) {
                try (var lines = Files.lines(procStatus)) {
                    return lines.filter(line -> line.startsWith("VmRSS:"))
                            .map(line -> line.replace("VmRSS:", "").trim().split("\\s+"))
                            .filter(parts -> parts.length > 0)
                            .mapToLong(parts -> Long.parseLong(parts[0]) * 1024)
                            .findFirst().orElse(-1);
                } catch (IOException | NumberFormatException ignored) {
                    return -1;
                }
            }
            try {
                Process process = new ProcessBuilder("ps", "-o", "rss=", "-p",
                        Long.toString(ProcessHandle.current().pid())).redirectErrorStream(true).start();
                if (!process.waitFor(500, TimeUnit.MILLISECONDS)) {
                    process.destroyForcibly();
                    return -1;
                }
                String output = new String(process.getInputStream().readAllBytes()).trim();
                if (process.exitValue() != 0 || output.isBlank()) return -1;
                return Long.parseLong(output.split("\\s+")[0]) * 1024;
            } catch (IOException | InterruptedException | NumberFormatException ignored) {
                if (Thread.currentThread().isInterrupted()) Thread.currentThread().interrupt();
                return -1;
            }
        }
    }
}
