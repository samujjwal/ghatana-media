package com.ghatana.audio.streaming;

import com.ghatana.audio.streaming.BoundedAudioFrameDecoder.DecodeVerdict;
import com.ghatana.audio.streaming.BoundedAudioFrameDecoder.SessionBudget;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static org.assertj.core.api.Assertions.assertThat;

/** Local AS-07 PCM framing/timebase exercise; it does not qualify a real transport. */
@DisplayName("Generated PCM framing and source timebase tiers")
class AudioPcmSourceTimebaseTierTest {
    private static final int SAMPLE_RATE = 48_000;
    private static final int FRAMES_PER_SESSION = 32;
    private static final int SAMPLES_PER_FRAME = 512;
    private static final int FRAME_BYTES = SAMPLES_PER_FRAME * Short.BYTES;
    private static final long MAX_TOTAL_PCM_BYTES = 64L * FRAMES_PER_SESSION * FRAME_BYTES;
    private static final long START_TIMEOUT_SECONDS = 10;
    private static final long COMPLETION_TIMEOUT_SECONDS = 30;

    @Test
    @DisplayName("generated PCM survives frame encode/decode with exact samples and rational source positions at 1/16/64 sessions")
    void generatedPcmAtSessionTiers() throws InterruptedException, ExecutionException, TimeoutException {
        for (int sessions : new int[]{1, 16, 64}) {
            ExecutorService workers = Executors.newFixedThreadPool(sessions);
            CountDownLatch ready = new CountDownLatch(sessions);
            CountDownLatch start = new CountDownLatch(1);
            List<Future<Long>> results = new ArrayList<>(sessions);
            try {
                for (int session = 0; session < sessions; session++) {
                    final int sessionId = session;
                    results.add(workers.submit(() -> runSession(sessionId, ready, start)));
                }
                if (!ready.await(START_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                    throw new TimeoutException("PCM sessions did not reach the synchronized start");
                }
                long tierStarted = System.nanoTime();
                start.countDown();
                long admittedBytes = 0;
                for (Future<Long> result : results) {
                    admittedBytes += result.get(COMPLETION_TIMEOUT_SECONDS, TimeUnit.SECONDS);
                }
                long elapsedNanos = Math.max(1, System.nanoTime() - tierStarted);
                long expectedBytes = (long) sessions * FRAMES_PER_SESSION * FRAME_BYTES;
                assertThat(admittedBytes).isLessThanOrEqualTo(MAX_TOTAL_PCM_BYTES);
                assertThat(admittedBytes).isEqualTo(expectedBytes);
                System.out.printf(
                        "AS-07 in-process generated-PCM throughput sessions=%d frames=%d bytes=%d elapsed_ms=%d bytes_per_second=%.0f%n",
                        sessions, sessions * FRAMES_PER_SESSION, admittedBytes,
                        Math.max(1, TimeUnit.NANOSECONDS.toMillis(elapsedNanos)),
                        admittedBytes * 1_000_000_000.0d / elapsedNanos);
            } finally {
                start.countDown();
                workers.shutdownNow();
                if (!workers.awaitTermination(START_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                    throw new TimeoutException("PCM session workers did not stop within the bounded timeout");
                }
            }
        }
    }

    private static long runSession(int session, CountDownLatch ready, CountDownLatch start)
            throws InterruptedException {
        ready.countDown();
        if (!start.await(START_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            throw new IllegalStateException("PCM session timed out waiting for synchronized start");
        }
        AudioStreamSession wire = new AudioStreamSession();
        BoundedAudioFrameDecoder decoder = BoundedAudioFrameDecoder.declare(
                "PCM_S16LE", 1, SAMPLE_RATE,
                new SessionBudget(FRAMES_PER_SESSION, (long) FRAMES_PER_SESSION * FRAME_BYTES));
        long admittedBytes = 0;
        for (int frameIndex = 0; frameIndex < FRAMES_PER_SESSION; frameIndex++) {
            long firstSample = (long) frameIndex * SAMPLES_PER_FRAME;
            byte[] pcm = generatedPcm(session, firstSample);
            var decoded = decoder.decode(pcm, firstSample, false);
            assertThat(decoded.verdict()).isEqualTo(DecodeVerdict.DECODED);
            assertThat(decoded.frame().position().numerator()).isEqualTo(firstSample);
            assertThat(decoded.frame().position().denominator()).isEqualTo(SAMPLE_RATE);

            long timestampMillis = firstSample * 1_000 / SAMPLE_RATE;
            byte[] encoded = wire.encodeFrame(frameIndex, timestampMillis, decoded.frame().payload());
            var received = wire.decodeFrame(encoded);
            assertThat(received.sequenceNumber()).isEqualTo(frameIndex);
            assertThat(received.timestampMillis()).isEqualTo(timestampMillis);
            assertThat(received.payload()).containsExactly(pcm);
            assertSamples(received.payload(), session, firstSample);
            admittedBytes += received.payload().length;
        }
        assertThat(decoder.framesDecoded()).isEqualTo(FRAMES_PER_SESSION);
        assertThat(decoder.bytesDecoded()).isEqualTo((long) FRAMES_PER_SESSION * FRAME_BYTES);
        return admittedBytes;
    }

    private static byte[] generatedPcm(int session, long firstSample) {
        ByteBuffer pcm = ByteBuffer.allocate(FRAME_BYTES).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < SAMPLES_PER_FRAME; i++) {
            pcm.putShort(sampleValue(session, firstSample + i));
        }
        return pcm.array();
    }

    private static void assertSamples(byte[] pcmBytes, int session, long firstSample) {
        ByteBuffer pcm = ByteBuffer.wrap(pcmBytes).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < SAMPLES_PER_FRAME; i++) {
            assertThat(pcm.getShort()).isEqualTo(sampleValue(session, firstSample + i));
        }
    }

    private static short sampleValue(int session, long sampleIndex) {
        // Deterministic full-range ramp with session-dependent phase, including signed values.
        return (short) ((sampleIndex * 97 + session * 7_919) & 0xffff);
    }
}
