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
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;
import com.sun.net.httpserver.HttpHandler;

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
    private static final int DEFAULT_WORKERS = 4;
    private static final int DEFAULT_QUEUE_CAPACITY = 16;
    private static final int DEFAULT_MAX_IN_FLIGHT = 4;

    private final String serviceName;
    private final Supplier<Boolean> readinessProbe;
    private final int port;
    private final int workerCount;
    private final int queueCapacity;
    private final Semaphore admission;
    private HttpServer httpServer;
    private ThreadPoolExecutor executor;
    private final AtomicBoolean running = new AtomicBoolean(false);

    public HealthMetricsServer(String serviceName, Supplier<Boolean> readinessProbe) {
        this(serviceName, readinessProbe, parseEnvInt("AV_HEALTH_PORT", DEFAULT_PORT),
                DEFAULT_WORKERS, DEFAULT_QUEUE_CAPACITY, DEFAULT_MAX_IN_FLIGHT);
    }

    /** Package-private configuration for deterministic local admission tests. */
    HealthMetricsServer(String serviceName, Supplier<Boolean> readinessProbe, int port,
                        int workerCount, int queueCapacity, int maxInFlight) {
        if (serviceName == null || serviceName.isBlank()) {
            throw new IllegalArgumentException("serviceName must not be blank");
        }
        if (readinessProbe == null) throw new NullPointerException("readinessProbe");
        if (port < 0 || port > 65_535) throw new IllegalArgumentException("port must be between 0 and 65535");
        if (workerCount < 1 || queueCapacity < 1 || maxInFlight < 1) {
            throw new IllegalArgumentException("workerCount, queueCapacity, and maxInFlight must be positive");
        }
        this.serviceName = serviceName;
        this.readinessProbe = readinessProbe;
        this.port = port;
        this.workerCount = workerCount;
        this.queueCapacity = queueCapacity;
        this.admission = new Semaphore(maxInFlight);
    }

    public void start() throws IOException {
        try {
            httpServer = HttpServer.create(new InetSocketAddress(port), 0);
            executor = new ThreadPoolExecutor(workerCount, workerCount, 0L, TimeUnit.MILLISECONDS,
                    new ArrayBlockingQueue<>(queueCapacity), runnable -> {
                        Thread thread = new Thread(runnable, "health-http-" + serviceName);
                        thread.setDaemon(true);
                        return thread;
                    }, new ThreadPoolExecutor.CallerRunsPolicy());
            httpServer.setExecutor(executor);

            httpServer.createContext("/health", admitted(this::handleHealth));
            httpServer.createContext("/ready", admitted(this::handleHealth));
            httpServer.createContext("/metrics", admitted(this::handleMetrics));

            httpServer.start();
            running.set(true);
            LOG.info("Health/metrics HTTP server started on port {} for '{}'", getPort(), serviceName);
        } catch (IOException | RuntimeException failure) {
            if (httpServer != null) httpServer.stop(0);
            if (executor != null) executor.shutdownNow();
            throw failure;
        }
    }

    @Override
    public void close() {
        if (httpServer != null && running.compareAndSet(true, false)) {
            httpServer.stop(1);
            if (executor != null) executor.shutdownNow();
            LOG.info("Health/metrics HTTP server stopped for '{}'", serviceName);
        }
    }

    public int getPort() {
        return httpServer == null ? port : httpServer.getAddress().getPort();
    }

    private HttpHandler admitted(HttpHandler handler) {
        return exchange -> {
            if (!admission.tryAcquire()) {
                sendResponse(exchange, 503, "application/json", publicStatusBody("DOWN"));
                return;
            }
            try {
                handler.handle(exchange);
            } finally {
                admission.release();
            }
        };
    }

    // -------------------------------------------------------------------------
    // Handlers
    // -------------------------------------------------------------------------

    private void handleHealth(HttpExchange ex) throws IOException {
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
            sendResponse(ex, 405, "text/plain", "Method Not Allowed");
            return;
        }
        boolean ready;
        try {
            ready = Boolean.TRUE.equals(readinessProbe.get());
        } catch (RuntimeException unavailable) {
            ready = false;
        }
        int code = ready ? 200 : 503;
        String body = publicStatusBody(ready ? "UP" : "DOWN");
        sendResponse(ex, code, "application/json", body);
    }

    private String publicStatusBody(String status) {
        String safeServiceName = serviceName.replace("\\", "\\\\").replace("\"", "\\\"");
        return "{\"service\":\"%s\",\"status\":\"%s\"}".formatted(safeServiceName, status);
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
