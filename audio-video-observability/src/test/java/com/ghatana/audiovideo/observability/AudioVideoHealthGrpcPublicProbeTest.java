package com.ghatana.audiovideo.observability;

import com.ghatana.audio.video.common.GrpcInterceptorChain;
import com.ghatana.observability.MetricsCollector;
import io.grpc.ManagedChannel;
import io.grpc.Server;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import io.grpc.health.v1.HealthCheckRequest;
import io.grpc.health.v1.HealthCheckResponse;
import io.grpc.health.v1.HealthGrpc;
import io.grpc.stub.ClientCallStreamObserver;
import io.grpc.stub.ClientResponseObserver;
import io.grpc.stub.StreamObserver;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

class AudioVideoHealthGrpcPublicProbeTest {
    private static final String TEST_SECRET = "public-health-probe-test-secret";

    @Test
    void unauthenticatedCheckAndWatchReturnOnlyPublicServingStatusAndWatchCanCancel() throws Exception {
        String previousSecret = System.getProperty("AV_JWT_SECRET");
        String serverName = InProcessServerBuilder.generateName();
        AudioVideoHealthService health = new AudioVideoHealthService(
                "stt-service", mock(MetricsCollector.class), Set.of("provider"));
        Server server = null;
        ManagedChannel channel = null;
        try {
            System.setProperty("AV_JWT_SECRET", TEST_SECRET);
            health.registerCheck("provider", () -> {
                throw new IllegalStateException("tenant/model/path/token-secret-marker");
            });
            assertThat(health.markReady()).isTrue();
            InProcessServerBuilder serverBuilder = InProcessServerBuilder.forName(serverName)
                    .directExecutor()
                    .addService(health);
            GrpcInterceptorChain.build().forEach(serverBuilder::intercept);
            server = serverBuilder.build().start();
            channel = InProcessChannelBuilder.forName(serverName).directExecutor().build();

            HealthCheckResponse check = HealthGrpc.newBlockingStub(channel)
                    .check(HealthCheckRequest.newBuilder().setService("stt-service").build());
            assertThat(check.getStatus()).isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);
            assertThat(check.toByteArray()).isNotEmpty();
            assertThat(check.toString()).doesNotContain("tenant", "model", "path", "token", "secret");

            CountDownLatch watchDelivered = new CountDownLatch(1);
            AtomicReference<ClientCallStreamObserver<HealthCheckRequest>> call = new AtomicReference<>();
            List<HealthCheckResponse> watchResponses = new ArrayList<>();
            HealthGrpc.newStub(channel).watch(
                    HealthCheckRequest.newBuilder().setService("stt-service").build(),
                    new ClientResponseObserver<HealthCheckRequest, HealthCheckResponse>() {
                        @Override
                        public void beforeStart(ClientCallStreamObserver<HealthCheckRequest> requestStream) {
                            call.set(requestStream);
                        }

                        @Override public void onNext(HealthCheckResponse value) {
                            watchResponses.add(value);
                            watchDelivered.countDown();
                        }
                        @Override public void onError(Throwable failure) { watchDelivered.countDown(); }
                        @Override public void onCompleted() { watchDelivered.countDown(); }
                    });

            assertThat(watchDelivered.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(watchResponses).hasSize(1);
            assertThat(watchResponses.get(0).getStatus())
                    .isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);
            assertThat(watchResponses.get(0).toString()).doesNotContain("tenant", "model", "path", "token", "secret");
            assertThat(health.activeWatchSubscriberCount()).isEqualTo(1);

            call.get().cancel("test cancellation", null);
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
            while (health.activeWatchSubscriberCount() != 0 && System.nanoTime() < deadline) {
                Thread.sleep(5);
            }
            assertThat(health.activeWatchSubscriberCount()).isZero();
        } finally {
            if (channel != null) {
                channel.shutdownNow();
                channel.awaitTermination(2, TimeUnit.SECONDS);
            }
            if (server != null) {
                server.shutdownNow();
                server.awaitTermination(2, TimeUnit.SECONDS);
            }
            health.close();
            if (previousSecret == null) System.clearProperty("AV_JWT_SECRET");
            else System.setProperty("AV_JWT_SECRET", previousSecret);
        }
    }

    @Test
    void watchSubscribersAreCappedAndShutdownCompletesTrackedWatches() {
        AudioVideoHealthService health = new AudioVideoHealthService(
                "stt-service", mock(MetricsCollector.class), Set.of("provider"));
        health.registerCheck("provider", () -> true);
        assertThat(health.markReady()).isTrue();
        List<RecordingObserver> observers = new ArrayList<>();
        try {
            for (int index = 0; index < 128; index++) {
                RecordingObserver observer = new RecordingObserver();
                observers.add(observer);
                health.watch(HealthCheckRequest.getDefaultInstance(), observer);
            }
            RecordingObserver overflow = new RecordingObserver();
            health.watch(HealthCheckRequest.getDefaultInstance(), overflow);

            assertThat(observers).allSatisfy(observer -> assertThat(observer.responses).hasSize(1));
            assertThat(health.activeWatchSubscriberCount()).isEqualTo(128);
            assertThat(overflow.error).hasMessageContaining("Health watch capacity reached");

            health.close();
            assertThat(health.activeWatchSubscriberCount()).isZero();
            assertThat(observers).allSatisfy(observer -> {
                assertThat(observer.responses).hasSize(
                        observer.responses.getFirst().getStatus()
                                == HealthCheckResponse.ServingStatus.SERVING ? 2 : 1);
                assertThat(observer.responses.getLast().getStatus())
                        .isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);
                assertThat(observer.completed).isTrue();
            });
        } finally {
            health.close();
        }
    }

    @Test
    void watchPublishesProviderReadinessTransitionsUntilClosed() throws InterruptedException {
        AtomicBoolean providerReady = new AtomicBoolean(true);
        AudioVideoHealthService health = new AudioVideoHealthService(
                "vision-service", mock(MetricsCollector.class), Set.of("provider"));
        health.registerCheck("provider", providerReady::get);
        assertThat(health.markReady()).isTrue();
        RecordingObserver observer = new RecordingObserver();
        try {
            health.watch(HealthCheckRequest.newBuilder().setService("vision-service").build(), observer);
            assertThat(observer.responses).hasSize(1);
            assertThat(observer.responses.getFirst().getStatus())
                    .isEqualTo(HealthCheckResponse.ServingStatus.SERVING);

            providerReady.set(false);
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
            while (observer.responses.size() < 2 && System.nanoTime() < deadline) Thread.sleep(5);

            assertThat(observer.responses).extracting(HealthCheckResponse::getStatus)
                    .containsExactly(HealthCheckResponse.ServingStatus.SERVING,
                            HealthCheckResponse.ServingStatus.NOT_SERVING);
            health.close();
            assertThat(observer.completed).isTrue();
        } finally {
            health.close();
        }
    }

    @Test
    void concurrentWatchRegistrationAndCloseLeaveNoTrackedSubscribers() throws InterruptedException {
        AudioVideoHealthService health = new AudioVideoHealthService(
                "stt-service", mock(MetricsCollector.class), Set.of("provider"));
        health.registerCheck("provider", () -> true);
        assertThat(health.markReady()).isTrue();

        int watcherCount = 32;
        ExecutorService executor = Executors.newFixedThreadPool(watcherCount + 1);
        CountDownLatch begin = new CountDownLatch(1);
        List<RecordingObserver> observers = new ArrayList<>();
        try {
            for (int index = 0; index < watcherCount; index++) {
                RecordingObserver observer = new RecordingObserver();
                observers.add(observer);
                executor.submit(() -> {
                    await(begin);
                    health.watch(HealthCheckRequest.getDefaultInstance(), observer);
                });
            }
            executor.submit(() -> {
                await(begin);
                health.close();
            });

            begin.countDown();
            executor.shutdown();
            assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
            assertThat(health.activeWatchSubscriberCount()).isZero();
            assertThat(observers).allSatisfy(observer -> assertThat(
                    observer.completed || observer.error != null || !observer.responses.isEmpty()).isTrue());
        } finally {
            begin.countDown();
            executor.shutdownNow();
            health.close();
        }
    }

    private static void await(CountDownLatch latch) {
        try {
            latch.await();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private static final class RecordingObserver implements StreamObserver<HealthCheckResponse> {
        private final List<HealthCheckResponse> responses = new CopyOnWriteArrayList<>();
        private volatile Throwable error;
        private volatile boolean completed;

        @Override public void onNext(HealthCheckResponse response) { responses.add(response); }
        @Override public void onError(Throwable failure) { error = failure; }
        @Override public void onCompleted() { completed = true; }
    }
}
