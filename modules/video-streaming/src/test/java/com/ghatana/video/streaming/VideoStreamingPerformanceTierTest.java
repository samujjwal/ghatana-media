package com.ghatana.video.streaming;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * @doc.type class
 * @doc.purpose Performance tier for video frame encode/decode throughput.
 * @doc.layer product
 * @doc.pattern Test
 */
@DisplayName("Video Streaming Performance Tier")
class VideoStreamingPerformanceTierTest {

    private final VideoStreamSession session = new VideoStreamSession();
    private static final int FRAMES_PER_WORKER = 64;
    private static final Duration START_TIMEOUT = Duration.ofSeconds(10);
    private static final Duration TIER_TIMEOUT = Duration.ofSeconds(30);
    private static final long SOURCE_TIME_BASE_MILLIS = 1_700_000_000_000L;
    private static final byte[] FIXTURE_PAYLOAD = fixturePayload();

    @Test
    @DisplayName("single-worker frame microbenchmark records fixture-local throughput")
    void shouldRecordSingleWorkerFixtureThroughput() {
        int frameCount = 10_000;
        byte[] payload = "h264-key-frame".getBytes(StandardCharsets.UTF_8);

        long started = System.nanoTime();
        for (int i = 0; i < frameCount; i++) {
            byte[] encoded = session.encodeFrame(i, i % 60 == 0, 1_700_000_000_000L + i, payload);
            VideoStreamSession.DecodedFrame decoded = session.decodeFrame(encoded);
            assertThat(decoded.sequenceNumber()).isEqualTo(i);
        }

        long elapsedNanos = System.nanoTime() - started;
        double fps = frameCount / (elapsedNanos / 1_000_000_000.0d);

        assertThat(fps).isPositive().isFinite();
        System.out.printf("video-fixture microbenchmark workers=1 frames=%d elapsedMs=%.3f fps=%.1f%n",
                frameCount, elapsedNanos / 1_000_000.0d, fps);
    }

    @Test
    @DisplayName("bounded 1/16/64-worker fixture tiers preserve frame order and report latency")
    void shouldMeasureBoundedConcurrentFixtureTiers() throws Exception {
        for (int workerCount : List.of(1, 16, 64)) {
            TierMeasurement measurement = measureTier(workerCount);
            assertThat(measurement.frameCount()).isEqualTo(workerCount * FRAMES_PER_WORKER);
            assertThat(measurement.p50Nanos()).isPositive();
            assertThat(measurement.p95Nanos()).isGreaterThanOrEqualTo(measurement.p50Nanos());
            assertThat(measurement.p99Nanos()).isGreaterThanOrEqualTo(measurement.p95Nanos());
            System.out.printf(
                    "video-fixture tier workers=%d frames=%d elapsedMs=%.3f fps=%.1f "
                            + "roundTripLatencyMs[p50=%.3f,p95=%.3f,p99=%.3f]%n",
                    workerCount, measurement.frameCount(), measurement.elapsedNanos() / 1_000_000.0d,
                    measurement.frameCount() / (measurement.elapsedNanos() / 1_000_000_000.0d),
                    measurement.p50Nanos() / 1_000_000.0d, measurement.p95Nanos() / 1_000_000.0d,
                    measurement.p99Nanos() / 1_000_000.0d);
        }
    }

    private TierMeasurement measureTier(int workerCount) throws Exception {
        ExecutorService workers = Executors.newFixedThreadPool(workerCount);
        CountDownLatch ready = new CountDownLatch(workerCount);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<long[]>> results = new ArrayList<>(workerCount);
        long tierStarted = System.nanoTime();
        try {
            for (int worker = 0; worker < workerCount; worker++) {
                results.add(workers.submit(() -> {
                    VideoStreamSession workerSession = new VideoStreamSession();
                    ready.countDown();
                    if (!start.await(START_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS)) {
                        throw new IllegalStateException("fixture worker did not receive synchronized start");
                    }
                    long[] latencies = new long[FRAMES_PER_WORKER];
                    for (int sequence = 0; sequence < FRAMES_PER_WORKER; sequence++) {
                        long sourceTime = SOURCE_TIME_BASE_MILLIS + sequence;
                        boolean keyFrame = sequence % 16 == 0;
                        long frameStarted = System.nanoTime();
                        byte[] encoded = workerSession.encodeFrame(sequence, keyFrame, sourceTime, FIXTURE_PAYLOAD);
                        VideoStreamSession.DecodedFrame decoded = workerSession.decodeFrame(encoded);
                        latencies[sequence] = System.nanoTime() - frameStarted;
                        assertFixtureFrame(decoded, sequence, keyFrame, sourceTime);
                    }
                    return latencies;
                }));
            }

            if (!ready.await(START_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS)) {
                throw new IllegalStateException("fixture workers were not ready before start timeout");
            }
            tierStarted = System.nanoTime();
            start.countDown();

            long[] allLatencies = new long[workerCount * FRAMES_PER_WORKER];
            long deadline = System.nanoTime() + TIER_TIMEOUT.toNanos();
            int offset = 0;
            for (Future<long[]> result : results) {
                long remainingNanos = deadline - System.nanoTime();
                if (remainingNanos <= 0) {
                    throw new IllegalStateException("fixture tier exceeded its finite completion timeout");
                }
                long[] workerLatencies = result.get(remainingNanos, TimeUnit.NANOSECONDS);
                System.arraycopy(workerLatencies, 0, allLatencies, offset, workerLatencies.length);
                offset += workerLatencies.length;
            }
            long elapsedNanos = System.nanoTime() - tierStarted;
            Arrays.sort(allLatencies);
            return new TierMeasurement(allLatencies.length, elapsedNanos, percentile(allLatencies, 0.50d),
                    percentile(allLatencies, 0.95d), percentile(allLatencies, 0.99d));
        } finally {
            start.countDown();
            workers.shutdownNow();
            if (!workers.awaitTermination(TIER_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS)) {
                throw new IllegalStateException("fixture workers did not terminate before timeout");
            }
        }
    }

    private static void assertFixtureFrame(VideoStreamSession.DecodedFrame decoded, int sequence,
            boolean keyFrame, long sourceTime) {
        assertThat(decoded.sequenceNumber()).isEqualTo(sequence);
        assertThat(decoded.keyFrame()).isEqualTo(keyFrame);
        assertThat(decoded.timestampMillis()).isEqualTo(sourceTime);
        assertThat(decoded.payload()).containsExactly(FIXTURE_PAYLOAD);
    }

    private static long percentile(long[] sortedValues, double percentile) {
        int index = (int) Math.ceil(percentile * sortedValues.length) - 1;
        return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
    }

    private static byte[] fixturePayload() {
        byte[] payload = new byte[256];
        for (int i = 0; i < payload.length; i++) {
            payload[i] = (byte) (i * 31 + 7);
        }
        return payload;
    }

    private record TierMeasurement(int frameCount, long elapsedNanos, long p50Nanos, long p95Nanos,
            long p99Nanos) {
    }
}

