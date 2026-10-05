package com.ghatana.audio.video.benchmarks;

import com.ghatana.audio.video.infrastructure.cache.AudioVideoCache;
import com.ghatana.cache.InMemoryCacheAdapter;
import io.activej.promise.Promise;
import org.openjdk.jmh.annotations.*;
import org.openjdk.jmh.runner.Runner;
import org.openjdk.jmh.runner.RunnerException;
import org.openjdk.jmh.runner.options.Options;
import org.openjdk.jmh.runner.options.OptionsBuilder;

import java.time.Duration;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * JMH performance benchmarks for Audio-Video cache layer (AV-P1-05).
 *
 * <p>Establishes baseline latency and throughput metrics for:
 * <ul>
 *   <li>In-memory cache get (hit / miss)</li>
 *   <li>In-memory cache put with TTL</li>
 *   <li>Cache hit-rate measurement under synthetic workload</li>
 *   <li>JSON serialization round-trip (audio-video payload shape)</li>
 * </ul>
 *
 * <p>Run with:
 * <pre>
 *   ./gradlew :products:audio-video:benchmarks:jmh
 * </pre>
 *
 * @doc.type class
 * @doc.purpose JMH benchmarks for Audio-Video cache and serialization (AV-P1-05)
 * @doc.layer test
 * @doc.pattern Benchmark
 */
@BenchmarkMode(Mode.Throughput)
@OutputTimeUnit(TimeUnit.MILLISECONDS)
@State(Scope.Benchmark)
@Fork(value = 1, jvmArgs = {"-Xms512m", "-Xmx512m"})
@Warmup(iterations = 3, time = 1)
@Measurement(iterations = 5, time = 1)
public class CacheAndSerializationBenchmarks {

    private AudioVideoCache<String, String> audioVideoCache;
    private tools.jackson.databind.ObjectMapper objectMapper;

    // Synthetic cache state for hit-rate benchmarking
    private static final String[] PRE_POPULATED_KEYS = new String[1000];
    private final AtomicLong hitCount = new AtomicLong();
    private final AtomicLong totalRequests = new AtomicLong();

    @Setup(Level.Trial)
    public void setUp() {
        InMemoryCacheAdapter<String, String> cachePort =
                new InMemoryCacheAdapter<>(Duration.ofMinutes(30));
        audioVideoCache = new AudioVideoCache<>(cachePort, "benchmark");

        objectMapper = new tools.jackson.databind.ObjectMapper()
                .registerModule(new tools.jackson.datatype.jsr310.JavaTimeModule());

        // Pre-populate cache with 1000 entries for hit-rate testing
        for (int i = 0; i < PRE_POPULATED_KEYS.length; i++) {
            PRE_POPULATED_KEYS[i] = "benchmark:benchmark-tenant:" + UUID.randomUUID();
            audioVideoCache.put(PRE_POPULATED_KEYS[i], "{\"id\":\"" + i + "\",\"text\":\"transcript " + i + "\"}").getResult();
        }
    }

    // ── Cache throughput benchmarks ────────────────────────────────────────

    @Benchmark
    @BenchmarkMode(Mode.Throughput)
    @OutputTimeUnit(TimeUnit.MILLISECONDS)
    public Optional<String> benchmarkCacheHit() {
        // All keys are pre-populated — 100% hit rate
        String key = PRE_POPULATED_KEYS[(int) (System.nanoTime() % PRE_POPULATED_KEYS.length)];
        Optional<String> result = audioVideoCache.get(key).getResult();
        if (result.isPresent()) hitCount.incrementAndGet();
        totalRequests.incrementAndGet();
        return result;
    }

    @Benchmark
    @BenchmarkMode(Mode.Throughput)
    @OutputTimeUnit(TimeUnit.MILLISECONDS)
    public Optional<String> benchmarkCacheMiss() {
        // Random UUIDs → always a miss
        String key = "benchmark:miss-tenant:" + UUID.randomUUID();
        return audioVideoCache.get(key).getResult();
    }

    @Benchmark
    @BenchmarkMode(Mode.AverageTime)
    @OutputTimeUnit(TimeUnit.MICROSECONDS)
    public void benchmarkCachePut() {
        String key = "benchmark:write-tenant:" + Thread.currentThread().getId();
        audioVideoCache.put(key, "{\"text\":\"write benchmark\"}").getResult();
    }

    @Benchmark
    @BenchmarkMode(Mode.AverageTime)
    @OutputTimeUnit(TimeUnit.MICROSECONDS)
    public void benchmarkCachePutWithTtl() {
        String key = "benchmark:write-ttl:" + Thread.currentThread().getId();
        audioVideoCache.put(key, "{\"text\":\"ttl benchmark\"}", Duration.ofMinutes(5)).getResult();
    }

    @Benchmark
    @BenchmarkMode(Mode.AverageTime)
    @OutputTimeUnit(TimeUnit.MICROSECONDS)
    public void benchmarkCacheInvalidate() {
        // Re-populate and immediately invalidate to benchmark invalidation path
        String key = "benchmark:inval:" + Thread.currentThread().getId();
        audioVideoCache.put(key, "value").getResult();
        audioVideoCache.invalidate(key).getResult();
    }

    // ── Serialization benchmarks ────────────────────────────────────────────

    @State(Scope.Thread)
    public static class SerializationState {
        private static final String SAMPLE_JSON = """
                {
                    "id": "550e8400-e29b-41d4-a716-446655440000",
                    "tenantId": "tenant-bench",
                    "text": "This is a sample transcription result for benchmarking the JSON serialization round-trip.",
                    "language": "en",
                    "confidence": 0.97,
                    "status": "COMPLETED",
                    "processingTimeMs": 142
                }
                """;
    }

    @Benchmark
    @BenchmarkMode(Mode.Throughput)
    @OutputTimeUnit(TimeUnit.MILLISECONDS)
    public String benchmarkJsonSerialize(SerializationState state) throws Exception {
        var payload = new ConcurrentHashMap<String, Object>();
        payload.put("id", UUID.randomUUID().toString());
        payload.put("text", "benchmark transcription payload");
        payload.put("confidence", 0.95);
        return objectMapper.writeValueAsString(payload);
    }

    @Benchmark
    @BenchmarkMode(Mode.Throughput)
    @OutputTimeUnit(TimeUnit.MILLISECONDS)
    public java.util.Map<?, ?> benchmarkJsonDeserialize(SerializationState state) throws Exception {
        return objectMapper.readValue(SerializationState.SAMPLE_JSON, java.util.Map.class);
    }

    public static void main(String[] args) throws RunnerException {
        Options opt = new OptionsBuilder()
                .include(CacheAndSerializationBenchmarks.class.getSimpleName())
                .forks(1)
                .build();
        new Runner(opt).run();
    }
}

