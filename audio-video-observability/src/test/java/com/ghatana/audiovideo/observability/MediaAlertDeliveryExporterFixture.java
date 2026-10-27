package com.ghatana.audiovideo.observability;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.micrometer.prometheusmetrics.PrometheusConfig;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.concurrent.CountDownLatch;

/**
 * Test-only Media exporter used by the opt-in Prometheus-to-Alertmanager smoke.
 * The profile observation is synthetic wiring data; quality observation remains absent.
 */
public final class MediaAlertDeliveryExporterFixture {
    private static final int MAX_STATE_BYTES = 32;

    private MediaAlertDeliveryExporterFixture() { }

    public static void main(String[] args) throws IOException, InterruptedException {
        if (args.length != 2) {
            throw new IllegalArgumentException("usage: <state-file> <port-file>");
        }
        Path stateFile = Path.of(args[0]).toAbsolutePath().normalize();
        Path portFile = Path.of(args[1]).toAbsolutePath().normalize();
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        MediaWorkflowMetrics metrics = new MediaWorkflowMetrics(registry, "stt");
        CountDownLatch stop = new CountDownLatch(1);

        HttpServer server = HttpServer.create(new InetSocketAddress("0.0.0.0", 0), 0);
        server.createContext("/metrics", exchange -> handleMetrics(exchange, stateFile, metrics, registry, stop));
        server.start();
        try {
            Files.writeString(portFile, Integer.toString(server.getAddress().getPort()), StandardCharsets.US_ASCII);
            stop.await();
        } finally {
            server.stop(0);
            registry.close();
        }
    }

    private static void handleMetrics(
            HttpExchange exchange,
            Path stateFile,
            MediaWorkflowMetrics metrics,
            PrometheusMeterRegistry registry,
            CountDownLatch stop) throws IOException {
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod()) || !"/metrics".equals(exchange.getRequestURI().getPath())) {
            send(exchange, 404, "not found\n");
            return;
        }
        String state;
        try {
            if (Files.size(stateFile) > MAX_STATE_BYTES) {
                send(exchange, 400, "invalid fixture state\n");
                return;
            }
            state = Files.readString(stateFile, StandardCharsets.US_ASCII).trim();
        } catch (IOException unavailable) {
            send(exchange, 503, "fixture state unavailable\n");
            return;
        }
        if ("stop".equals(state)) {
            stop.countDown();
            send(exchange, 410, "fixture stopping\n");
            return;
        }
        MediaWorkflowMetrics.ProviderReadiness readiness = switch (state) {
            case "healthy" -> MediaWorkflowMetrics.ProviderReadiness.HEALTHY;
            case "unavailable" -> MediaWorkflowMetrics.ProviderReadiness.UNAVAILABLE;
            default -> {
                send(exchange, 400, "invalid fixture state\n");
                yield null;
            }
        };
        if (readiness == null) return;

        Instant checkedAt = Instant.now();
        metrics.recordProviderProfile(MediaWorkflowMetrics.Modality.STT,
                new MediaWorkflowMetrics.ProviderProfileObservation(
                        "alert-delivery-fixture", "fixture-v1", "fixture-model", "fixture-r1",
                        readiness, checkedAt, null));
        send(exchange, 200, registry.scrape());
    }

    private static void send(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, bytes.length);
        try (var output = exchange.getResponseBody()) {
            output.write(bytes);
        }
    }
}
