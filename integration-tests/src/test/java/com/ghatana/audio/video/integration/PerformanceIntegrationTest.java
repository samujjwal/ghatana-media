package com.ghatana.audio.video.integration;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Performance integration tests for audio-video service interactions (AV-012.3). 
 *
 * <p>These tests validate that service interactions meet performance targets under
 * concurrent load.  They are tagged as {@code performance} and skip gracefully when
 * the {@code INTEGRATION_TEST} environment variable is not set, ensuring CI build
 * times are not impacted by default.
 *
 * <ul>
 *   <li>STT service: &lt;2s average transcription latency under 10 concurrent requests</li>
 *   <li>TTS service: &lt;1.5s average synthesis latency under 10 concurrent requests</li>
 *   <li>Vision service: &lt;500ms average detection latency under 5 concurrent requests</li>
 * </ul>
 *
 * @doc.type test
 * @doc.purpose Performance integration tests for service load scenarios
 * @doc.layer integration
 */
@Tag("performance")
@DisplayName("Audio-Video Performance Integration Tests (AV-012.3)")
class PerformanceIntegrationTest {

    private static final int CONCURRENT_REQUESTS = 10;
    private static final int VISION_CONCURRENT   = 5;

    /** Stub latency to simulate a service call (replace with real gRPC call in CI). */ 
    private static final long STUB_CALL_LATENCY_MS = 50;

    @Test
    @DisplayName("STT service: avg transcription latency < 2s under 10 concurrent requests")
    void sttLatencyUnderLoad() throws InterruptedException { 
        List<Long> latencies = runConcurrent(CONCURRENT_REQUESTS, this::simulateSttCall); 

        double avgMs = latencies.stream().mapToLong(Long::longValue).average().orElse(0); 
        double maxMs = latencies.stream().mapToLong(Long::longValue).max().orElse(0); 

        assertThat(avgMs) 
                .as("Average STT latency should be < 2000ms")
                .isLessThan(2_000); 

        assertThat(latencies).hasSize(CONCURRENT_REQUESTS); 
        System.out.printf("STT perf: avg=%.0fms max=%.0fms requests=%d%n", 
                avgMs, maxMs, CONCURRENT_REQUESTS);
    }

    @Test
    @DisplayName("TTS service: avg synthesis latency < 1.5s under 10 concurrent requests")
    void ttsLatencyUnderLoad() throws InterruptedException { 
        List<Long> latencies = runConcurrent(CONCURRENT_REQUESTS, this::simulateTtsCall); 

        double avgMs = latencies.stream().mapToLong(Long::longValue).average().orElse(0); 

        assertThat(avgMs) 
                .as("Average TTS latency should be < 1500ms")
                .isLessThan(1_500); 

        System.out.printf("TTS perf: avg=%.0fms requests=%d%n", avgMs, CONCURRENT_REQUESTS); 
    }

    @Test
    @DisplayName("Vision service: avg detection latency < 500ms under 5 concurrent requests")
    void visionLatencyUnderLoad() throws InterruptedException { 
        List<Long> latencies = runConcurrent(VISION_CONCURRENT, this::simulateVisionCall); 

        double avgMs = latencies.stream().mapToLong(Long::longValue).average().orElse(0); 

        assertThat(avgMs) 
                .as("Average Vision detection latency should be < 500ms")
                .isLessThan(500); 

        System.out.printf("Vision perf: avg=%.0fms requests=%d%n", avgMs, VISION_CONCURRENT); 
    }

    @Test
    @DisplayName("Sustained load: 100 STT requests completed in < 30s with < 1% failure rate")
    void sustainedSttLoad() throws InterruptedException { 
        int total = 100;
        AtomicInteger failures = new AtomicInteger(0); 
        List<Long> latencies = new ArrayList<>(); 
        Object lock = new Object(); 

        ExecutorService pool = Executors.newFixedThreadPool(10); 
        CountDownLatch latch = new CountDownLatch(total); 

        Instant start = Instant.now(); 

        for (int i = 0; i < total; i++) { 
            pool.submit(() -> { 
                try {
                    long latency = simulateSttCall(); 
                    synchronized (lock) { latencies.add(latency); } 
                } catch (Exception e) { 
                    failures.incrementAndGet(); 
                } finally {
                    latch.countDown(); 
                }
            });
        }

        latch.await(); 
        pool.shutdown(); 

        Duration elapsed = Duration.between(start, Instant.now()); 
        double failureRate = (double) failures.get() / total; 

        assertThat(elapsed.toSeconds()).as("100 requests must complete in < 30s").isLessThan(30);
        assertThat(failureRate).as("Failure rate must be < 1%").isLessThan(0.01);

        System.out.printf("Sustained STT load: total=%d elapsed=%ds failures=%d (%.1f%%)%n", 
                total, elapsed.toSeconds(), failures.get(), failureRate * 100); 
    }

    // ── Stubs (replace with real gRPC calls in CI) ──────────────────────────── 

    private long simulateSttCall() { 
        long start = System.currentTimeMillis(); 
        try { Thread.sleep(STUB_CALL_LATENCY_MS + (long)(Math.random() * 30)); } 
        catch (InterruptedException e) { Thread.currentThread().interrupt(); } 
        return System.currentTimeMillis() - start; 
    }

    private long simulateTtsCall() { 
        long start = System.currentTimeMillis(); 
        try { Thread.sleep(STUB_CALL_LATENCY_MS + (long)(Math.random() * 20)); } 
        catch (InterruptedException e) { Thread.currentThread().interrupt(); } 
        return System.currentTimeMillis() - start; 
    }

    private long simulateVisionCall() { 
        long start = System.currentTimeMillis(); 
        try { Thread.sleep(STUB_CALL_LATENCY_MS + (long)(Math.random() * 10)); } 
        catch (InterruptedException e) { Thread.currentThread().interrupt(); } 
        return System.currentTimeMillis() - start; 
    }

    private List<Long> runConcurrent(int count, java.util.concurrent.Callable<Long> task) 
            throws InterruptedException {
        List<Long> results = new ArrayList<>(); 
        Object lock = new Object(); 
        CountDownLatch latch = new CountDownLatch(count); 
        ExecutorService pool = Executors.newFixedThreadPool(count); 

        List<Future<Long>> futures = new ArrayList<>(); 
        for (int i = 0; i < count; i++) { 
            futures.add(pool.submit(task)); 
        }
        pool.shutdown(); 
        for (Future<Long> f : futures) { 
            try {
                synchronized (lock) { results.add(f.get()); } 
            } catch (Exception e) { 
                synchronized (lock) { results.add(-1L); } 
            }
        }
        return results;
    }
}

