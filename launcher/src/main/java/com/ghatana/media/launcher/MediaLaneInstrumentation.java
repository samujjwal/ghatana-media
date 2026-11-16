package com.ghatana.media.launcher;

import com.ghatana.audiovideo.observability.MediaLaneMetrics;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;

import java.io.IOException;
import java.util.Set;

/**
 * Outermost HTTP edge instrumentation (journey {@code media.dev.service-observability}): per-lane request counts with
 * typed outcomes, and a latency histogram per lane. It sees every response including those written by the security
 * filter, observes only the response status and the server-defined error code, and never throws into the request.
 * Health and scrape routes are not counted (a scrape must not move the series it reads).
 *
 * @doc.type class
 * @doc.purpose Truthful per-lane request metrics at the HTTP edge
 * @doc.layer product
 * @doc.pattern Decorator
 */
final class MediaLaneInstrumentation implements HttpHandler {
    /** Exchange attribute carrying the server-defined error code written by {@code MediaHttpHandler#error}. */
    static final String ERROR_CODE_ATTRIBUTE = MediaLaneInstrumentation.class.getName() + ".errorCode";
    private static final Set<String> UNCOUNTED = Set.of(
            "/health/live", "/health/ready", "/health/startup", "/ready", "/metrics", "/info", "/api/v1/health");

    private final HttpHandler delegate;
    private final MediaLaneMetrics metrics;

    private MediaLaneInstrumentation(HttpHandler delegate, MediaLaneMetrics metrics) {
        this.delegate = delegate;
        this.metrics = metrics;
    }

    static HttpHandler wrap(MediaRuntime runtime, HttpHandler delegate) {
        return new MediaLaneInstrumentation(delegate, runtime.laneMetrics());
    }

    @Override
    public void handle(HttpExchange exchange) throws IOException {
        String path = exchange.getRequestURI().getRawPath();
        if (path == null || UNCOUNTED.contains(path)) {
            delegate.handle(exchange);
            return;
        }
        String lane = MediaLaneMetrics.lane(path);
        long started = System.nanoTime();
        try {
            delegate.handle(exchange);
        } finally {
            int status = exchange.getResponseCode();
            Object code = exchange.getAttribute(ERROR_CODE_ATTRIBUTE);
            metrics.record(lane, status, code instanceof String text ? text : null, System.nanoTime() - started);
        }
    }
}
