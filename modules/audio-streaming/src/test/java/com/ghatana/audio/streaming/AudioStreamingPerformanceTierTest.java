package com.ghatana.audio.streaming;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * @doc.type class
 * @doc.purpose Performance tier for audio frame encode/decode throughput.
 * @doc.layer product
 * @doc.pattern Test
 */
@DisplayName("Audio Streaming Performance Tier")
class AudioStreamingPerformanceTierTest {

    private static final int FRAMES_PER_WORKER = 128;
    private static final long START_TIMEOUT_SECONDS = 10;
    private static final long COMPLETION_TIMEOUT_SECONDS = 30;
    private static final byte[] PAYLOAD = "fixture-pcm-frame".getBytes(StandardCharsets.UTF_8);

    @Test
    @DisplayName("fixture-local bounded encode/decode latency at 1, 16, and 64 workers")
    void measuresBoundedConcurrentFixtureTiers() throws InterruptedException, ExecutionException,
            TimeoutException {
        for (int workerCount : new int[] {1, 16, 64}) {
            TierMeasurement measurement = measureTier(workerCount);
            assertThat(measurement.completedFrames()).isEqualTo(workerCount * FRAMES_PER_WORKER);
            assertThat(measurement.latenciesNanos()).hasSize(measurement.completedFrames());
            assertThat(measurement.p50Nanos()).isPositive();
            assertThat(measurement.p95Nanos()).isGreaterThanOrEqualTo(measurement.p50Nanos());
            assertThat(measurement.p99Nanos()).isGreaterThanOrEqualTo(measurement.p95Nanos());

            System.out.printf(
                    "AS-07 fixture-local encode/decode workers=%d frames=%d p50_ns=%d p95_ns=%d p99_ns=%d elapsed_ms=%d%n",
                    workerCount,
                    measurement.completedFrames(),
                    measurement.p50Nanos(),
                    measurement.p95Nanos(),
                    measurement.p99Nanos(),
                    measurement.elapsedMillis());
        }
    }

    private TierMeasurement measureTier(int workerCount) throws InterruptedException, ExecutionException,
            TimeoutException {
        ExecutorService workers = Executors.newFixedThreadPool(workerCount);
        CountDownLatch ready = new CountDownLatch(workerCount);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<long[]>> results = new ArrayList<>(workerCount);
        try {
            for (int worker = 0; worker < workerCount; worker++) {
                final int workerId = worker;
                results.add(workers.submit(() -> {
                    ready.countDown();
                    if (!start.await(START_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("timed out waiting for synchronized fixture start");
                    }
                    long[] latencies = new long[FRAMES_PER_WORKER];
                    AudioStreamSession session = new AudioStreamSession();
                    for (int frame = 0; frame < FRAMES_PER_WORKER; frame++) {
                        int sequence = frame;
                        long timestamp = 1_700_000_000_000L + (long) workerId * FRAMES_PER_WORKER + frame;
                        long operationStarted = System.nanoTime();
                        byte[] encoded = session.encodeFrame(sequence, timestamp, PAYLOAD);
                        AudioStreamSession.DecodedFrame decoded = session.decodeFrame(encoded);
                        latencies[frame] = Math.max(1, System.nanoTime() - operationStarted);
                        if (decoded.sequenceNumber() != sequence
                                || decoded.timestampMillis() != timestamp
                                || !Arrays.equals(decoded.payload(), PAYLOAD)) {
                            throw new AssertionError("audio fixture frame output mismatch");
                        }
                    }
                    return latencies;
                }));
            }

            if (!ready.await(START_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                throw new TimeoutException("workers did not reach the synchronized fixture start");
            }
            long tierStarted = System.nanoTime();
            start.countDown();
            long[] latencies = new long[workerCount * FRAMES_PER_WORKER];
            int offset = 0;
            for (Future<long[]> result : results) {
                long[] workerLatencies = result.get(COMPLETION_TIMEOUT_SECONDS, TimeUnit.SECONDS);
                System.arraycopy(workerLatencies, 0, latencies, offset, workerLatencies.length);
                offset += workerLatencies.length;
            }
            long elapsedMillis = Math.max(1, TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - tierStarted));
            Arrays.sort(latencies);
            return new TierMeasurement(
                    latencies.length,
                    percentile(latencies, 0.50),
                    percentile(latencies, 0.95),
                    percentile(latencies, 0.99),
                    elapsedMillis,
                    latencies);
        } finally {
            start.countDown();
            workers.shutdownNow();
            if (!workers.awaitTermination(START_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                throw new TimeoutException("fixture workers did not terminate within the bounded timeout");
            }
        }
    }

    private long percentile(long[] sortedLatencies, double percentile) {
        int index = (int) Math.ceil(percentile * sortedLatencies.length) - 1;
        return sortedLatencies[Math.max(0, Math.min(index, sortedLatencies.length - 1))];
    }

    private record TierMeasurement(
            int completedFrames,
            long p50Nanos,
            long p95Nanos,
            long p99Nanos,
            long elapsedMillis,
            long[] latenciesNanos) {
    }
}

