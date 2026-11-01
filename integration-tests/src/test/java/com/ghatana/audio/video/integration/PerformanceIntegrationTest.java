package com.ghatana.audio.video.integration;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Bounded synthetic stream workload for IT-03 fixture behavior.
 *
 * <p>This test measures only in-process byte-frame dispatch. It does not exercise
 * audio/video transport, codecs, source clocks, or provider behavior.
 */
@Tag("integration")
@Tag("performance")
@DisplayName("Bounded synthetic stream workload (IT-03)")
class PerformanceIntegrationTest {

    private static final int[] CLIENT_COUNTS = {1, 16, 64};
    private static final int FRAMES_PER_CLIENT = 8;
    private static final int FRAME_BYTES = 256;
    private static final Duration CLIENT_TIMEOUT = Duration.ofSeconds(5);
    private static final Duration SHUTDOWN_TIMEOUT = Duration.ofSeconds(2);

    @Test
    @DisplayName("bounds 1/16/64 synthetic clients and preserves tenant byte isolation")
    void boundedSyntheticStreamWorkload() throws Exception {
        TenantInboxDispatcher negativeCase = new TenantInboxDispatcher(2);
        assertThat(negativeCase.dispatch(1, SyntheticFrame.forTenant(0, 0))).isFalse();
        assertThat(negativeCase.drain(1)).isEmpty();

        for (int clients : CLIENT_COUNTS) {
            WorkloadResult result = runWorkload(clients);

            assertThat(result.receivedFrames()).isEqualTo(clients * FRAMES_PER_CLIENT);
            assertThat(result.crossTenantLeaks()).isZero();
            assertThat(result.p50Nanos()).isGreaterThanOrEqualTo(0);
            assertThat(result.p95Nanos()).isGreaterThanOrEqualTo(result.p50Nanos());
            assertThat(result.p99Nanos()).isGreaterThanOrEqualTo(result.p95Nanos());
            assertThat(result.codecQualification()).isEqualTo(Qualification.UNVERIFIED);

            System.out.printf(
                    "Synthetic stream fixture: clients=%d frames=%d p50=%dns p95=%dns p99=%dns " +
                            "crossTenantLeaks=%d codec=%s%n",
                    clients, result.receivedFrames(), result.p50Nanos(), result.p95Nanos(),
                    result.p99Nanos(), result.crossTenantLeaks(), result.codecQualification());
        }
    }

    private static WorkloadResult runWorkload(int clientCount) throws Exception {
        ExecutorService workers = Executors.newFixedThreadPool(clientCount);
        TenantInboxDispatcher dispatcher = new TenantInboxDispatcher(clientCount);
        List<Future<ClientResult>> futures = new ArrayList<>(clientCount);
        long deadline = System.nanoTime() + CLIENT_TIMEOUT.toNanos();
        try {
            for (int client = 0; client < clientCount; client++) {
                final int tenantId = client;
                futures.add(workers.submit(sendSyntheticFrames(tenantId, dispatcher)));
            }

            List<Long> latencies = new ArrayList<>(clientCount * FRAMES_PER_CLIENT);
            for (Future<ClientResult> future : futures) {
                long remaining = deadline - System.nanoTime();
                if (remaining <= 0) {
                    throw new TimeoutException("synthetic stream workload exceeded finite deadline");
                }
                ClientResult clientResult = future.get(remaining, TimeUnit.NANOSECONDS);
                latencies.addAll(clientResult.latenciesNanos());
            }
            int received = 0;
            int leaks = 0;
            for (int tenant = 0; tenant < clientCount; tenant++) {
                final int expectedTenant = tenant;
                List<SyntheticFrame> inbox = dispatcher.drain(tenant);
                received += inbox.size();
                leaks += (int) inbox.stream().filter(frame -> !frame.belongsTo(expectedTenant)).count();
            }
            long[] samples = latencies.stream().mapToLong(Long::longValue).sorted().toArray();
            return new WorkloadResult(received, leaks, percentile(samples, 0.50),
                    percentile(samples, 0.95), percentile(samples, 0.99), Qualification.UNVERIFIED);
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof Exception exception) {
                throw exception;
            }
            throw e;
        } finally {
            workers.shutdownNow();
            if (!workers.awaitTermination(SHUTDOWN_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS)) {
                throw new IllegalStateException("synthetic workload workers did not terminate");
            }
        }
    }

    private static Callable<ClientResult> sendSyntheticFrames(int expectedTenant,
                                                               TenantInboxDispatcher dispatcher) {
        return () -> {
            List<Long> latencies = new ArrayList<>(FRAMES_PER_CLIENT);
            for (int sequence = 0; sequence < FRAMES_PER_CLIENT; sequence++) {
                long started = System.nanoTime();
                SyntheticFrame frame = SyntheticFrame.forTenant(expectedTenant, sequence);
                if (!dispatcher.dispatch(expectedTenant, frame)) {
                    throw new IllegalStateException("valid synthetic frame was rejected");
                }
                latencies.add(System.nanoTime() - started);
            }
            return new ClientResult(List.copyOf(latencies));
        };
    }

    private static long percentile(long[] sortedSamples, double percentile) {
        if (sortedSamples.length == 0) {
            throw new IllegalArgumentException("at least one latency sample is required");
        }
        int index = (int) Math.ceil(percentile * sortedSamples.length) - 1;
        return sortedSamples[Math.max(0, Math.min(index, sortedSamples.length - 1))];
    }

    private enum Qualification { UNVERIFIED }

    private record SyntheticFrame(int tenantId, int sequence, byte[] payload) {
        private static SyntheticFrame forTenant(int tenantId, int sequence) {
            byte[] payload = new byte[FRAME_BYTES];
            Arrays.fill(payload, (byte) (tenantId & 0xff));
            return new SyntheticFrame(tenantId, sequence, payload);
        }

        private boolean belongsTo(int tenant) {
            if (tenantId != tenant || payload.length != FRAME_BYTES) {
                return false;
            }
            for (byte value : payload) {
                if (value != (byte) (tenant & 0xff)) {
                    return false;
                }
            }
            return true;
        }
    }

    private record ClientResult(List<Long> latenciesNanos) { }

    /** Test-owned bounded router; this is not a production isolation primitive. */
    private static final class TenantInboxDispatcher {
        private final ConcurrentHashMap<Integer, ArrayBlockingQueue<SyntheticFrame>> inboxes =
                new ConcurrentHashMap<>();

        private TenantInboxDispatcher(int tenants) {
            for (int tenant = 0; tenant < tenants; tenant++) {
                inboxes.put(tenant, new ArrayBlockingQueue<>(FRAMES_PER_CLIENT));
            }
        }

        private boolean dispatch(int targetTenant, SyntheticFrame frame) {
            if (frame.tenantId() != targetTenant) {
                return false;
            }
            ArrayBlockingQueue<SyntheticFrame> inbox = inboxes.get(targetTenant);
            return inbox != null && inbox.offer(frame);
        }

        private List<SyntheticFrame> drain(int tenant) {
            ArrayBlockingQueue<SyntheticFrame> inbox = inboxes.get(tenant);
            if (inbox == null) {
                throw new IllegalArgumentException("unknown synthetic tenant inbox: " + tenant);
            }
            List<SyntheticFrame> frames = new ArrayList<>(FRAMES_PER_CLIENT);
            inbox.drainTo(frames, FRAMES_PER_CLIENT);
            return List.copyOf(frames);
        }
    }

    private record WorkloadResult(int receivedFrames, int crossTenantLeaks,
                                  long p50Nanos, long p95Nanos, long p99Nanos,
                                  Qualification codecQualification) { }
}
