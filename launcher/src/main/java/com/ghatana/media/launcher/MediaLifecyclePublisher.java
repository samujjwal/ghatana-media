package com.ghatana.media.launcher;

import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;
import com.ghatana.launcher.config.RuntimeSecretReference;
import com.ghatana.media.runtime.MediaLifecycleEvent;
import com.ghatana.media.runtime.MediaLifecycleEventPublisher;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/** Typed Event Plane client for neutral Media lifecycle events. */
final class MediaLifecyclePublisher implements MediaLifecycleEventPublisher {
    private final ObjectMapper mapper = JsonMapper.builder().addModules(tools.jackson.databind.cfg.MapperBuilder.findModules()).build();
    private final HttpClient client;
    private final URI endpoint;
    private final String bearerToken;
    private final Duration timeout;
    private final boolean productionEligible;
    private final AtomicBoolean closed = new AtomicBoolean(false);

    private MediaLifecyclePublisher(
            URI endpoint, String bearerToken, Duration timeout, boolean productionEligible) {
        this.endpoint = endpoint;
        this.bearerToken = bearerToken;
        this.timeout = timeout;
        this.productionEligible = productionEligible;
        this.client = endpoint == null ? null : HttpClient.newBuilder()
                .connectTimeout(timeout).followRedirects(HttpClient.Redirect.NEVER).build();
    }

    static MediaLifecyclePublisher compose(Map<String, String> environment, boolean productionLike) {
        String base = environment.getOrDefault("MEDIA_EVENT_PLANE_URL", "").trim();
        if (base.isBlank()) {
            if (productionLike) {
                throw new IllegalStateException(
                        "MEDIA_EVENT_PLANE_URL is required for production Media lifecycle publication");
            }
            return disabled();
        }
        URI baseUri = URI.create(base.endsWith("/") ? base : base + "/");
        if (!baseUri.isAbsolute() || baseUri.getHost() == null
                || !("http".equalsIgnoreCase(baseUri.getScheme())
                || "https".equalsIgnoreCase(baseUri.getScheme()))) {
            throw new IllegalArgumentException("MEDIA_EVENT_PLANE_URL must be an absolute HTTP(S) URI");
        }
        if (productionLike && !"https".equalsIgnoreCase(baseUri.getScheme())) {
            throw new IllegalStateException("Production Media Event Plane publication requires HTTPS");
        }
        String streamId = environment.getOrDefault(
                "MEDIA_EVENT_PLANE_STREAM_ID", "media-lifecycle").trim();
        if (streamId.isBlank() || streamId.length() > 255) {
            throw new IllegalArgumentException("MEDIA_EVENT_PLANE_STREAM_ID must be bounded and non-blank");
        }
        String token = RuntimeSecretReference.resolveOptionalEnvironment(
                environment,
                environment.getOrDefault("MEDIA_EVENT_PLANE_TOKEN_REFERENCE", ""),
                "Media Event Plane bearer token",
                productionLike);
        Duration timeout = Duration.ofMillis(longValue(
                environment, "MEDIA_EVENT_PLANE_TIMEOUT_MS", 5_000L, 100L, 60_000L));
        URI endpoint = baseUri.resolve("api/v1/streams/"
                + URLEncoder.encode(streamId, StandardCharsets.UTF_8).replace("+", "%20")
                + "/events");
        return new MediaLifecyclePublisher(
                endpoint, token, timeout, "https".equalsIgnoreCase(endpoint.getScheme())
                && !token.isBlank());
    }

    static MediaLifecyclePublisher disabled() {
        return new MediaLifecyclePublisher(null, "", Duration.ofSeconds(1), false);
    }

    @Override public String publisherId() { return endpoint == null ? "disabled" : "event-plane-http"; }
    @Override public boolean ready() { return !closed.get() && endpoint != null; }
    @Override public boolean productionEligible() { return ready() && productionEligible; }

    @Override
    public void publish(MediaLifecycleEvent event) {
        if (!ready()) return;
        java.util.Objects.requireNonNull(event, "event");
        try {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("aggregateType", event.aggregateType());
            payload.put("aggregateId", event.aggregateId());
            payload.put("aggregateVersion", event.aggregateVersion());
            payload.put("classification", event.classification());
            payload.put("attributes", event.attributes());
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("eventId", event.eventId());
            body.put("eventType", event.eventType());
            body.put("eventVersion", "1.0");
            body.put("timestamp", event.occurredAt().toString());
            body.put("correlationId", event.correlationId());
            if (!event.causationId().isBlank()) body.put("causationId", event.causationId());
            body.put("source", "media");
            body.put("userId", event.principalId());
            body.put("contentType", "application/json");
            body.put("payload", payload);
            HttpRequest.Builder request = HttpRequest.newBuilder(endpoint)
                    .timeout(timeout)
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .header("X-Tenant-Id", event.tenantId())
                    .header("X-Principal-Id", event.principalId())
                    .header("X-Correlation-Id", event.correlationId())
                    .header("Idempotency-Key", event.eventId())
                    .POST(HttpRequest.BodyPublishers.ofByteArray(mapper.writeValueAsBytes(body)));
            if (!bearerToken.isBlank()) request.header("Authorization", "Bearer " + bearerToken);
            HttpResponse<Void> response = client.send(request.build(), HttpResponse.BodyHandlers.discarding());
            if (response.statusCode() != 200 && response.statusCode() != 201) {
                throw new IllegalStateException(
                        "Event Plane rejected Media lifecycle event with status " + response.statusCode());
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Media lifecycle publication was interrupted", interrupted);
        } catch (Exception failure) {
            if (failure instanceof RuntimeException runtime) throw runtime;
            throw new IllegalStateException("Unable to publish Media lifecycle event", failure);
        }
    }

    @Override public void close() { closed.set(true); }

    private static long longValue(
            Map<String, String> environment, String key, long fallback, long minimum, long maximum) {
        try {
            long value = Long.parseLong(environment.getOrDefault(key, Long.toString(fallback)).trim());
            if (value < minimum || value > maximum) {
                throw new IllegalArgumentException(key + " must be between " + minimum + " and " + maximum);
            }
            return value;
        } catch (NumberFormatException failure) {
            throw new IllegalArgumentException(key + " must be an integer", failure);
        }
    }
}
