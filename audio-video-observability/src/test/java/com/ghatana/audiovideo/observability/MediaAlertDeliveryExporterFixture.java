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
    private static final int MAX_ALERT_WEBHOOK_BYTES = 64 * 1024;

    /** Counts actual HTTP POSTs from Alertmanager, not merely routed receiver metadata. */
    private static final class WebhookReceipts {
        final java.util.concurrent.atomic.AtomicInteger firing = new java.util.concurrent.atomic.AtomicInteger();
        final java.util.concurrent.atomic.AtomicInteger resolved = new java.util.concurrent.atomic.AtomicInteger();
    }

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
        WebhookReceipts receipts = new WebhookReceipts();

        HttpServer server = HttpServer.create(new InetSocketAddress("0.0.0.0", 0), 0);
        server.createContext("/metrics", exchange -> handleMetrics(exchange, stateFile, metrics, registry, stop));
        // Both webhook and receipt collection are confined to the opt-in test exporter.
        // No production metric endpoint or alert rule is modified by this fixture.
        server.createContext("/alert-webhook",
                exchange -> handleAlertWebhook(exchange, receipts));
        server.createContext("/alert-receipts",
                exchange -> handleAlertReceipts(exchange, receipts));
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

    /** Test-only actual HTTP delivery target. The payload is bounded and never logged. */
    private static void handleAlertWebhook(
            HttpExchange exchange, WebhookReceipts receipts) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())
                || !"/alert-webhook".equals(exchange.getRequestURI().getPath())) {
            send(exchange, 405, "POST required\n");
            return;
        }
        String contentType = exchange.getRequestHeaders().getFirst("Content-Type");
        if (contentType == null || !contentType.toLowerCase(java.util.Locale.ROOT)
                .startsWith("application/json")) {
            send(exchange, 415, "JSON required\n");
            return;
        }
        byte[] bytes = exchange.getRequestBody().readNBytes(MAX_ALERT_WEBHOOK_BYTES + 1);
        if (bytes.length > MAX_ALERT_WEBHOOK_BYTES) {
            send(exchange, 413, "alert payload exceeded bound\n");
            return;
        }
        String body = new String(bytes, StandardCharsets.UTF_8);
        if (!body.matches("(?s).*\\\"receiver\\\"\\s*:\\s*\\\"media-local-test\\\".*")
                || !body.contains("MediaProviderProfileUnavailableFixture")) {
            send(exchange, 400, "unexpected test-only alert\n");
            return;
        }
        if (body.matches("(?s).*\\\"status\\\"\\s*:\\s*\\\"firing\\\".*")) {
            receipts.firing.incrementAndGet();
        } else if (body.matches("(?s).*\\\"status\\\"\\s*:\\s*\\\"resolved\\\".*")) {
            receipts.resolved.incrementAndGet();
        } else {
            send(exchange, 400, "unknown alert status\n");
            return;
        }
        send(exchange, 200, "delivered\n");
    }

    /** Exposes only aggregate receipt counters; never emits Alertmanager payload/labels. */
    private static void handleAlertReceipts(
            HttpExchange exchange, WebhookReceipts receipts) throws IOException {
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())
                || !"/alert-receipts".equals(exchange.getRequestURI().getPath())) {
            send(exchange, 405, "GET required\n");
            return;
        }
        send(exchange, 200, "{\"firing\":" + receipts.firing.get()
                + ",\"resolved\":" + receipts.resolved.get() + "}\n");
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
