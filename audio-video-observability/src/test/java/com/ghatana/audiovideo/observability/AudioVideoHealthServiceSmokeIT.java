package com.ghatana.audiovideo.observability;

import com.ghatana.observability.MetricsCollector;
import io.grpc.ManagedChannel;
import io.grpc.Server;
import io.grpc.health.v1.HealthCheckRequest;
import io.grpc.health.v1.HealthCheckResponse;
import io.grpc.health.v1.HealthGrpc;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.lenient;

/**
 * Smoke tests for {@link AudioVideoHealthService} endpoints using an in-process
 * gRPC server.  These tests verify end-to-end wire behaviour without requiring
 * external infrastructure.
 *
 * @doc.type class
 * @doc.purpose Smoke tests for AudioVideoHealthService gRPC endpoints (AV-L3)
 * @doc.layer test
 * @doc.pattern IntegrationTest
 */
@ExtendWith(MockitoExtension.class)
@DisplayName("AudioVideoHealthService Smoke Tests (AV-L3)")
class AudioVideoHealthServiceSmokeIT {

    private static final String SERVER_NAME = "av-health-smoke-test";

    @Mock
    private MetricsCollector metricsCollector;

    private Server server;
    private ManagedChannel channel;
    private HealthGrpc.HealthBlockingStub stub;
    private AudioVideoHealthService healthService;

    @BeforeEach
    void startServer() throws Exception {
        healthService = new AudioVideoHealthService("stt-service", metricsCollector);
        lenient().doNothing().when(metricsCollector).incrementCounter(anyString(), any(String[].class));

        server = InProcessServerBuilder
                .forName(SERVER_NAME)
                .directExecutor()
                .addService(healthService)
                .build()
                .start();

        channel = InProcessChannelBuilder
                .forName(SERVER_NAME)
                .directExecutor()
                .build();

        stub = HealthGrpc.newBlockingStub(channel);
    }

    @AfterEach
    void stopServer() throws InterruptedException {
        channel.shutdownNow().awaitTermination(5, TimeUnit.SECONDS);
        server.shutdownNow().awaitTermination(5, TimeUnit.SECONDS);
    }

    @Test
    @DisplayName("Check RPC returns SERVING when all health checks pass")
    void checkReturnsServingWhenAllHealthy() {
        healthService.registerCheck("channel-ok", () -> true);
        healthService.registerCheck("model-loaded", () -> true);

        HealthCheckResponse response = stub.check(HealthCheckRequest.getDefaultInstance());

        assertThat(response.getStatus())
                .isEqualTo(HealthCheckResponse.ServingStatus.SERVING);
    }

    @Test
    @DisplayName("Check RPC returns NOT_SERVING when any health check fails")
    void checkReturnsNotServingOnFailingCheck() {
        healthService.registerCheck("channel-ok", () -> true);
        healthService.registerCheck("model-loaded", () -> false);

        HealthCheckResponse response = stub.check(HealthCheckRequest.getDefaultInstance());

        assertThat(response.getStatus())
                .isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);
    }

    @Test
    @DisplayName("Check RPC returns NOT_SERVING when setNotServing() was called")
    void checkReturnsNotServingAfterShutdown() {
        healthService.registerCheck("all-good", () -> true);
        healthService.setNotServing();

        HealthCheckResponse response = stub.check(HealthCheckRequest.getDefaultInstance());

        assertThat(response.getStatus())
                .isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);
    }

    @Test
    @DisplayName("Check RPC returns NOT_SERVING when a check throws an exception")
    void checkReturnsNotServingOnException() {
        healthService.registerCheck("crasher", () -> {
            throw new RuntimeException("dependency unavailable");
        });

        HealthCheckResponse response = stub.check(HealthCheckRequest.getDefaultInstance());

        assertThat(response.getStatus())
                .isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);
    }

    @Test
    @DisplayName("Check RPC returns SERVING with no checks registered (no-op baseline)")
    void checkReturnsServingWithNoChecksRegistered() {
        HealthCheckResponse response = stub.check(HealthCheckRequest.getDefaultInstance());

        assertThat(response.getStatus())
                .isEqualTo(HealthCheckResponse.ServingStatus.SERVING);
    }
}
