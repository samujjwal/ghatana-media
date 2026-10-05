package com.ghatana.audio.video.common.health;

import com.ghatana.audio.video.common.observability.MetricsServerInterceptor;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;

/**
 * Lightweight HTTP server exposing readiness and Prometheus metrics endpoints.
 *
 * <p>Endpoints:
 * <ul>
 *   <li>{@code GET /health} — returns {@code 200 OK} with JSON body when the service
 *       is ready, {@code 503 Service Unavailable} otherwise.</li>
 *   <li>{@code GET /metrics} — returns Prometheus text-format metrics scraped from
 *       {@link MetricsServerInterceptor#scrape()}.</li>
 *   <li>{@code GET /ready} — alias for {@code /health}.</li>
 * </ul>
 *
 * <p>Configuration via environment variable:
 * <ul>
 *   <li>{@code AV_HEALTH_PORT} — HTTP port for this server (default 8090)</li>
 * </ul>
 *
 * <p>Usage:
 * <pre>{@code
 *   HealthMetricsServer hms = new HealthMetricsServer("stt-service", () -> engine.isReady());
 *   hms.start();
 *   // on shutdown:
 *   hms.stop();
 * }</pre>
  * @doc.type class
 * @doc.purpose Provides health metrics server functionality.
 * @doc.layer product
 * @doc.pattern Component
*/
public class HealthMetricsServer implements AutoCloseable {

    private static final Logger LOG = LoggerFactory.getLogger(HealthMetricsServer.class);

    private static final int DEFAULT_PORT = 8090;

    private final String serviceName;
    private final Supplier<Boolean> readinessProbe;
    private final int port;
    private HttpServer httpServer;
    private final AtomicBoolean running = new AtomicBoolean(false);

    public HealthMetricsServer(String serviceName, Supplier<Boolean> readinessProbe) {
        this.serviceName   = serviceName;
        this.readinessProbe = readinessProbe;
        this.port = parseEnvInt("AV_HEALTH_PORT", DEFAULT_PORT);
    }

    public void start() throws IOException {
        httpServer = HttpServer.create(new InetSocketAddress(port), 0);
        httpServer.setExecutor(Executors.newFixedThreadPool(2));

        httpServer.createContext("/health",  ex -> handleHealth(ex));
        httpServer.createContext("/ready",   ex -> handleHealth(ex));
        httpServer.createContext("/metrics", ex -> handleMetrics(ex));

        httpServer.start();
        running.set(true);
        LOG.info("Health/metrics HTTP server started on port {} for '{}'", port, serviceName);
    }

    @Override
    public void close() {
        if (httpServer != null && running.compareAndSet(true, false)) {
            httpServer.stop(1);
            LOG.info("Health/metrics HTTP server stopped for '{}'", serviceName);
        }
    }

    public int getPort() { return port; }

    // -------------------------------------------------------------------------
    // Handlers
    // -------------------------------------------------------------------------

    private void handleHealth(HttpExchange ex) throws IOException {
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
            sendResponse(ex, 405, "text/plain", "Method Not Allowed");
            return;
        }
        boolean ready = Boolean.TRUE.equals(readinessProbe.get());
        int code = ready ? 200 : 503;
        String body = """
                {"service":"%s","status":"%s"}
                """.formatted(serviceName, ready ? "UP" : "DOWN").strip();
        sendResponse(ex, code, "application/json", body);
    }

    private void handleMetrics(HttpExchange ex) throws IOException {
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
            sendResponse(ex, 405, "text/plain", "Method Not Allowed");
            return;
        }
        String body = MetricsServerInterceptor.getInstance().scrape();
        sendResponse(ex, 200, "text/plain; version=0.0.4; charset=utf-8", body);
    }

    private static void sendResponse(HttpExchange ex, int code, String contentType, String body)
            throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", contentType);
        ex.sendResponseHeaders(code, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private static int parseEnvInt(String name, int def) {
        String val = System.getenv(name);
        if (val == null) return def;
        try { return Integer.parseInt(val); } catch (NumberFormatException e) { return def; }
    }
}
