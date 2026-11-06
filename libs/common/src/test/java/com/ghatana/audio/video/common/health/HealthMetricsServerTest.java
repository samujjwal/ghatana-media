package com.ghatana.audio.video.common.health;

import org.junit.jupiter.api.Test;
import io.micrometer.prometheusmetrics.PrometheusConfig;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import io.micrometer.core.instrument.Gauge;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

class HealthMetricsServerTest {
    @Test
    void scrapeIncludesTheSameServiceLocalPrometheusRegistryWithoutIdentityLabels() throws Exception {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        registry.counter("media_modality_boundary_calls", "service", "stt",
                "modality", "stt", "boundary", "provider", "outcome", "success",
                "contract_version", "v1").increment();
        var absentQuality = new java.util.concurrent.atomic.AtomicReference<>(Double.NaN);
        Gauge.builder("media.provider.quality.observation.timestamp.seconds", absentQuality,
                        java.util.concurrent.atomic.AtomicReference::get)
                .tag("service", "stt").tag("modality", "stt")
                .tag("provider_id", "scrape-fixture").tag("contract_version", "v1")
                .register(registry);
        HealthMetricsServer server = new HealthMetricsServer(
                "test-service", () -> true, registry::scrape, 0, 1, 1, 1);
        server.start();
        try {
            var response = java.net.http.HttpClient.newHttpClient().send(
                    java.net.http.HttpRequest.newBuilder(java.net.URI.create(
                            "http://127.0.0.1:" + server.getPort() + "/metrics")).GET().build(),
                    java.net.http.HttpResponse.BodyHandlers.ofString());

            assertThat(response.statusCode()).isEqualTo(200);
            assertThat(response.headers().firstValue("Content-Type").orElse(""))
                    .startsWith("text/plain; version=0.0.4");
            assertThat(java.util.regex.Pattern.compile(
                    "(?m)^media_modality_boundary_calls_total\\{[^}]*service=\"stt\"[^}]*} 1\\.0$")
                    .matcher(response.body()).find()).isTrue();
            assertThat(java.util.regex.Pattern.compile(
                    "(?m)^media_provider_quality_observation_timestamp_seconds\\{[^}]*provider_id=\"scrape-fixture\"[^}]*} NaN$")
                    .matcher(response.body()).find()).isTrue();
            assertThat(response.body()).doesNotContain("tenant_id", "principal_id", "request_id", "job_id");
            assertThat(response.body()).doesNotContain("media_provider_quality_measured_value");
        } finally {
            server.close();
            registry.close();
        }
    }

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
    void healthAndMetricsRejectContextPrefixPaths() throws Exception {
        HealthMetricsServer server = new HealthMetricsServer(
                "test-service", () -> true, () -> "", 0, 1, 1, 1);
        server.start();
        try {
            HttpResponse<String> health = get(server.getPort(), "/health/extra");
            HttpResponse<String> ready = get(server.getPort(), "/ready/extra");
            HttpResponse<String> metrics = get(server.getPort(), "/metrics/extra");

            assertThat(health.statusCode()).isEqualTo(404);
            assertThat(health.body()).isEqualTo("Not Found");
            assertThat(ready.statusCode()).isEqualTo(404);
            assertThat(metrics.statusCode()).isEqualTo(404);
            assertThat(metrics.body()).isEqualTo("Not Found");
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
