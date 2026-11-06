package com.ghatana.audio.streaming;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

/** In-process guarded-session concurrency only; this does not exercise MediaRuntime or a transport. */
class GuardedAudioSessionClientTierTest {
    private static final int FRAMES_PER_CLIENT = 16;
    private static final long START_TIMEOUT_SECONDS = 10;
    private static final long COMPLETION_TIMEOUT_SECONDS = 20;

    @Test
    void boundedConcurrentGuardedSessionsAtOneSixteenAndSixtyFourClients() throws Exception {
        for (int clientCount : new int[] {1, 16, 64}) {
            ExecutorService clients = Executors.newFixedThreadPool(clientCount);
            CountDownLatch ready = new CountDownLatch(clientCount);
            CountDownLatch start = new CountDownLatch(1);
            List<Future<Integer>> results = new ArrayList<>(clientCount);
            try {
                for (int client = 0; client < clientCount; client++) {
                    final int clientId = client;
                    results.add(clients.submit(() -> runClient(clientId, ready, start)));
                }
                assertThat(ready.await(START_TIMEOUT_SECONDS, TimeUnit.SECONDS)).isTrue();
                long started = System.nanoTime();
                start.countDown();
                int delivered = 0;
                for (Future<Integer> result : results) {
                    delivered += result.get(COMPLETION_TIMEOUT_SECONDS, TimeUnit.SECONDS);
                }
                long elapsedNanos = System.nanoTime() - started;
                assertThat(delivered).isEqualTo(clientCount * (FRAMES_PER_CLIENT + 1));
                assertThat(elapsedNanos).isPositive();
                System.out.printf("AS local guarded-session clients=%d frames=%d elapsed_ms=%.3f%n",
                        clientCount, delivered, elapsedNanos / 1_000_000.0d);
            } finally {
                start.countDown();
                clients.shutdownNow();
                assertThat(clients.awaitTermination(START_TIMEOUT_SECONDS, TimeUnit.SECONDS)).isTrue();
            }
        }
    }

    private static int runClient(int clientId, CountDownLatch ready, CountDownLatch start) throws Exception {
        ready.countDown();
        if (!start.await(START_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            throw new IllegalStateException("guarded audio client did not receive bounded tier start");
        }
        var identity = new StreamFrameReconciler.SessionIdentity(
                "audio-tier-stream-" + clientId, "audio-tier-tenant-" + clientId,
                "audio-tier-principal-" + clientId, "audio-tier-purpose", 1L);
        var session = GuardedAudioStreamSession.connect(identity,
                context -> StreamConsentGate.Decision.ADMITTED);
        int delivered = 0;
        for (int sequence = 0; sequence < FRAMES_PER_CLIENT; sequence++) {
            var frame = new AudioStreamSession.DecodedFrame(sequence, sequence, new byte[] {(byte) sequence});
            if (session.submitFrame(frame) != StreamFrameReconciler.Disposition.DELIVERED) {
                throw new AssertionError("contiguous fixture frame was not delivered");
            }
            session.dispatchToProvider(frame, ignored -> { });
            delivered++;
        }
        session.detach();
        session.reconnect(1L);
        var resumed = new AudioStreamSession.DecodedFrame(FRAMES_PER_CLIENT, FRAMES_PER_CLIENT, new byte[] {0x7f});
        if (session.submitFrame(resumed) != StreamFrameReconciler.Disposition.DELIVERED) {
            throw new AssertionError("post-reconnect fixture frame was not delivered");
        }
        session.dispatchToProvider(resumed, ignored -> { });
        assertThat(session.nextAck()).isEqualTo(FRAMES_PER_CLIENT);
        return delivered + 1;
    }
}
