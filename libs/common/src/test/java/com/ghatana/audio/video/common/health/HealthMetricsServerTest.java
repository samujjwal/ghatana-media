package com.ghatana.audio.video.common.health;

import org.junit.jupiter.api.Test;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

class HealthMetricsServerTest {
    @Test
    void readinessExceptionReturnsGenericUnavailableWithoutDetails() throws Exception {
        String marker = "tenant-model-path-token-secret";
        HealthMetricsServer server = new HealthMetricsServer(
                "internal-service-name", () -> { throw new IllegalStateException(marker); }, 0, 2, 2, 2);
        server.start();
        try {
            HttpResponse<String> response = get(server.getPort(), "/health");

            assertThat(response.statusCode()).isEqualTo(503);
            assertThat(response.body()).isEqualTo("{\"service\":\"internal-service-name\",\"status\":\"DOWN\"}");
            assertThat(response.body()).doesNotContain(marker);
        } finally {
            server.close();
        }
    }

    @Test
    void saturatedReadinessAdmissionReturnsDeterministic503AndRecovers() throws Exception {
        CountDownLatch probeStarted = new CountDownLatch(1);
        CountDownLatch releaseProbe = new CountDownLatch(1);
        HealthMetricsServer server = new HealthMetricsServer("test-service", () -> {
            probeStarted.countDown();
            try {
                releaseProbe.await();
                return true;
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return false;
            }
        }, 0, 2, 2, 1);
        server.start();
        try {
            HttpClient client = HttpClient.newHttpClient();
            HttpRequest firstRequest = request(server.getPort(), "/ready");
            var first = client.sendAsync(firstRequest, HttpResponse.BodyHandlers.ofString());
            assertThat(probeStarted.await(2, TimeUnit.SECONDS)).isTrue();

            HttpResponse<String> overloaded = client.send(
                    request(server.getPort(), "/health"), HttpResponse.BodyHandlers.ofString());
            assertThat(overloaded.statusCode()).isEqualTo(503);
            assertThat(overloaded.body()).isEqualTo("{\"service\":\"test-service\",\"status\":\"DOWN\"}");

            releaseProbe.countDown();
            HttpResponse<String> recovered = first.get(2, TimeUnit.SECONDS);
            assertThat(recovered.statusCode()).isEqualTo(200);
            assertThat(recovered.body()).isEqualTo("{\"service\":\"test-service\",\"status\":\"UP\"}");
        } finally {
            releaseProbe.countDown();
            server.close();
        }
    }

    private static HttpResponse<String> get(int port, String path) throws Exception {
        return HttpClient.newHttpClient().send(request(port, path), HttpResponse.BodyHandlers.ofString());
    }

    private static HttpRequest request(int port, String path) {
        return HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path)).GET().build();
    }
}
