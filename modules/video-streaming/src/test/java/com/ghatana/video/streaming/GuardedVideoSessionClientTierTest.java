package com.ghatana.video.streaming;

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
class GuardedVideoSessionClientTierTest {
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
                System.out.printf("VS local guarded-session clients=%d frames=%d elapsed_ms=%.3f%n",
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
            throw new IllegalStateException("guarded video client did not receive bounded tier start");
        }
        var identity = new VideoFrameReconciler.SessionIdentity(
                "video-tier-stream-" + clientId, "video-tier-tenant-" + clientId,
                "video-tier-principal-" + clientId, "video-tier-purpose", 1L);
        var session = GuardedVideoStreamSession.open(identity,
                context -> GuardedVideoStreamSession.ConsentDecision.ADMITTED, "worker-" + clientId);
        long token = 1L;
        int delivered = 0;
        for (int sequence = 0; sequence < FRAMES_PER_CLIENT; sequence++) {
            var frame = new VideoStreamSession.DecodedFrame(
                    sequence, sequence == 0, sequence * 33L, new byte[] {(byte) sequence});
            if (session.submitFrame("worker-" + clientId, token, frame)
                    != GuardedVideoStreamSession.FrameVerdict.DELIVERED_DECODABLE) {
                throw new AssertionError("contiguous fixture frame was not decodable and delivered");
            }
            session.egress("worker-" + clientId, token, frame, ignored -> { });
            delivered++;
        }
        session.detach("worker-" + clientId, token);
        session.resume("worker-" + clientId, token, identity, FRAMES_PER_CLIENT - 1, 0, Long.MIN_VALUE);
        var resumed = new VideoStreamSession.DecodedFrame(
                FRAMES_PER_CLIENT, false, FRAMES_PER_CLIENT * 33L, new byte[] {0x7f});
        if (session.submitFrame("worker-" + clientId, token, resumed)
                != GuardedVideoStreamSession.FrameVerdict.DELIVERED_DECODABLE) {
            throw new AssertionError("post-resume fixture frame was not decodable and delivered");
        }
        session.egress("worker-" + clientId, token, resumed, ignored -> { });
        assertThat(session.nextAck("worker-" + clientId, token)).isEqualTo(FRAMES_PER_CLIENT);
        return delivered + 1;
    }
}
