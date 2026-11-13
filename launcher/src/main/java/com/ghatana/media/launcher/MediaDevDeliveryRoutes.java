package com.ghatana.media.launcher;

import com.ghatana.media.production.delivery.MediaDeliveryEngine;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.DeliveryException;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.DeliveryResult;
import com.sun.net.httpserver.HttpExchange;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DEV_ONLY routes for the hosted export. Kept out of the canonical manifest and OpenAPI.
 *
 * <ul>
 *   <li>{@code POST /dev/v1/exports} body {@code {requestId, artifactId, artifactVersionId, destinationId}}
 *       (permissions {@code media:delivery:dev:export} and {@code media:artifact:read}).
 *       201 only when a destination readback receipt confirmed the first export; 200 when an existing
 *       operation is replayed; 202 for any operation not yet destination-confirmed.</li>
 *   <li>{@code GET /dev/v1/exports/{requestId}} (permission {@code media:delivery:dev:read}).</li>
 * </ul>
 */
final class MediaDevDeliveryRoutes {
    private static final String BASE = "/dev/v1/exports";
    private static final Pattern READ = Pattern.compile("^/dev/v1/exports/([^/]+)$");
    private static final Pattern ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}");
    private final ObjectMapper mapper = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();
    private final MediaRuntime runtime;
    private final MediaDevDeliveryRuntime delivery;

    MediaDevDeliveryRoutes(MediaRuntime runtime, MediaDevDeliveryRuntime delivery) {
        this.runtime = java.util.Objects.requireNonNull(runtime, "runtime");
        this.delivery = java.util.Objects.requireNonNull(delivery, "delivery");
    }

    static boolean handles(String path) { return BASE.equals(path) || path.startsWith(BASE + "/"); }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId)
            throws IOException {
        try {
            if (BASE.equals(path)) {
                if (!"POST".equals(method)) { methodNotAllowed(exchange, "POST"); return; }
                // media:delivery:dev:export is enforced by MediaSecurityFilter from the route permission map
                // (the handler-visible permission attribute only carries artifact/job permissions).
                if (!MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")) {
                    runtime.recordDeniedRequest();
                    error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                            "DEV_ONLY artifact read permission is required to export an artifact");
                    return;
                }
                Map<String, Object> body = mapper.readValue(
                        MediaHttpHandler.boundedBody(exchange, runtime.config().maximumBodyBytes(), false),
                        new TypeReference<>() { });
                if (body == null || !body.keySet().equals(
                        Set.of("requestId", "artifactId", "artifactVersionId", "destinationId"))) {
                    throw new IllegalArgumentException("export request fields do not match its declared shape");
                }
                var request = new MediaDevDeliveryRuntime.Export(
                        id(body.get("requestId"), "requestId"), text(body.get("artifactId"), "artifactId"),
                        text(body.get("artifactVersionId"), "artifactVersionId"),
                        text(body.get("destinationId"), "destinationId"));
                var outcome = delivery.export(tenantId, principalId, request);
                boolean confirmed = outcome.result().status() == MediaDeliveryEngine.Status.DESTINATION_CONFIRMED;
                int status = !confirmed ? 202 : outcome.replayed() ? 200 : 201;
                json(exchange, status, view(outcome.result(), outcome.replayed()));
                return;
            }
            Matcher read = READ.matcher(path);
            if (read.matches()) {
                if (!"GET".equals(method)) { methodNotAllowed(exchange, "GET"); return; }
                var found = delivery.find(tenantId, principalId, decodeSegment(read.group(1)));
                if (found.isEmpty()) {
                    error(exchange, 404, "EXPORT_NOT_FOUND", "Export is not available in this tenant and owner scope");
                    return;
                }
                json(exchange, 200, view(found.get(), true));
                return;
            }
            error(exchange, 404, "NOT_FOUND", "Local delivery route not found");
        } catch (MediaDevDeliveryRuntime.UnavailableException failure) {
            error(exchange, 503, "DELIVERY_DESTINATION_UNAVAILABLE", failure.getMessage());
        } catch (MediaDevDeliveryRuntime.UnknownDestinationException failure) {
            error(exchange, 404, "DESTINATION_NOT_FOUND", "The destination is not configured on this DEV_ONLY host");
        } catch (MediaDevDeliveryRuntime.ArtifactVersionUnavailableException failure) {
            runtime.recordDeniedRequest();
            error(exchange, 404, "ARTIFACT_VERSION_NOT_FOUND",
                    "The exact artifact version is not available to this DEV_ONLY principal");
        } catch (MediaDevDeliveryRuntime.ExportLimitException failure) {
            error(exchange, 422, "EXPORT_LIMIT_EXCEEDED", failure.getMessage());
        } catch (DeliveryException failure) {
            switch (failure.code()) {
                case IDEMPOTENCY_CONFLICT -> error(exchange, 409, "EXPORT_REQUEST_CONFLICT",
                        "requestId is already bound to a different artifact version or destination");
                case AUTHORIZATION_DENIED -> { runtime.recordDeniedRequest();
                    error(exchange, 403, "EXPORT_AUTHORIZATION_DENIED", "Transfer authorization was denied"); }
                case AUTHORIZATION_UNAVAILABLE -> error(exchange, 503, "EXPORT_AUTHORIZATION_UNAVAILABLE",
                        "Transfer authorization is unavailable; retry the same requestId");
                case INVALID_DESTINATION_EVIDENCE -> error(exchange, 502, "DESTINATION_EVIDENCE_INVALID",
                        "Destination evidence was invalid; the export is not confirmed");
                default -> error(exchange, 422, "EXPORT_INVALID", "Export request is invalid");
            }
        } catch (IllegalArgumentException failure) {
            error(exchange, 400, "INVALID_REQUEST", "Local delivery request is invalid");
        } catch (IllegalStateException failure) {
            error(exchange, 503, "DELIVERY_STATE_UNAVAILABLE",
                    "Delivery state could not be read or updated; retry the same requestId");
        }
    }

    private static Map<String, Object> view(DeliveryResult result, boolean replayed) {
        MediaDeliveryEngine.Status status = result.status();
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("requestId", result.requestId());
        view.put("artifactId", result.artifactId());
        view.put("artifactVersionId", result.versionRef());
        view.put("artifactDigest", result.artifactDigest());
        view.put("destinationId", result.destinationRef());
        view.put("status", status.name());
        view.put("acknowledgedBytes", result.acknowledgedBytes());
        view.put("destinationConfirmed", status == MediaDeliveryEngine.Status.DESTINATION_CONFIRMED);
        view.put("destinationReceiptRef", result.destinationReceiptRef().orElse(null));
        view.put("replayed", replayed);
        view.put("scope", "DEV_ONLY");
        return view;
    }

    private static String id(Object value, String name) {
        String text = text(value, name);
        if (!ID.matcher(text).matches()) throw new IllegalArgumentException(name + " must be a 1-128 character opaque id");
        return text;
    }

    private static String text(Object value, String name) {
        if (!(value instanceof String text) || text.isBlank() || !text.equals(text.strip()) || text.length() > 384) {
            throw new IllegalArgumentException(name + " must be an exact non-blank string");
        }
        return text;
    }

    private static String decodeSegment(String raw) {
        String decoded = URLDecoder.decode(raw.replace("+", "%2B"), StandardCharsets.UTF_8);
        if (decoded.indexOf('/') >= 0 || decoded.indexOf('\\') >= 0) {
            throw new IllegalArgumentException("Path identifier must not contain a separator");
        }
        return decoded;
    }

    private void methodNotAllowed(HttpExchange exchange, String allow) throws IOException {
        exchange.getResponseHeaders().set("Allow", allow);
        error(exchange, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
    }

    private void error(HttpExchange exchange, int status, String code, String message) throws IOException {
        String requestId = exchange.getRequestHeaders().getFirst("X-Request-ID");
        if (requestId == null || !ID.matcher(requestId).matches()) requestId = UUID.randomUUID().toString();
        exchange.getResponseHeaders().set("X-Request-ID", requestId);
        boolean retryable = status == 502 || status == 503;
        json(exchange, status, Map.of(
                "error", Map.of("code", code, "message", message, "retryable", retryable,
                        "evidenceRefs", List.of(), "actionRefs", List.of()),
                "meta", Map.of("requestId", requestId, "correlationId", requestId,
                        "timestamp", Instant.now().toString(), "apiVersion", "1.0.0")));
    }

    private void json(HttpExchange exchange, int status, Object body) throws IOException {
        byte[] bytes = mapper.writeValueAsBytes(body);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, bytes.length);
        try (var output = exchange.getResponseBody()) { output.write(bytes); }
    }
}
