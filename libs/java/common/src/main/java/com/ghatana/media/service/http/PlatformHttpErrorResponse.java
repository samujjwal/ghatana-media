package com.ghatana.media.service.http;

import tools.jackson.databind.ObjectMapper;
import io.activej.http.HttpHeaders;
import io.activej.http.HttpRequest;
import io.activej.http.HttpResponse;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Canonical caller-safe platform error envelope for Media HTTP adapters. */
final class PlatformHttpErrorResponse {
    private PlatformHttpErrorResponse() { }

    static HttpResponse of(
            ObjectMapper mapper,
            HttpRequest request,
            int status,
            String code,
            String safeMessage,
            boolean retryable) {
        String requestId = safeIdentity(request.getHeader(HttpHeaders.of("X-Request-ID")));
        if (requestId == null) requestId = UUID.randomUUID().toString();
        String correlationId = safeIdentity(request.getHeader(HttpHeaders.of("X-Correlation-ID")));
        if (correlationId == null) correlationId = requestId;
        Map<String, Object> body = Map.of(
                "error", Map.of(
                        "code", code,
                        "message", safeMessage,
                        "retryable", retryable,
                        "evidenceRefs", List.of(),
                        "actionRefs", List.of()),
                "meta", Map.of(
                        "requestId", requestId,
                        "correlationId", correlationId,
                        "timestamp", Instant.now().toString(),
                        "apiVersion", "1.0.0"));
        try {
            return HttpResponse.ofCode(status)
                    .withHeader(HttpHeaders.CONTENT_TYPE, "application/json")
                    .withHeader(HttpHeaders.of("X-Request-ID"), requestId)
                    .withHeader(HttpHeaders.of("X-Correlation-ID"), correlationId)
                    .withBody(mapper.writeValueAsBytes(body))
                    .build();
        } catch (Exception serializationFailure) {
            return HttpResponse.ofCode(500)
                    .withHeader(HttpHeaders.CONTENT_TYPE, "application/json")
                    .withBody("{\"error\":{\"code\":\"RESPONSE_SERIALIZATION_FAILED\",\"message\":\"Response serialization failed\",\"retryable\":false,\"evidenceRefs\":[],\"actionRefs\":[]},\"meta\":{\"requestId\":\"unavailable\",\"correlationId\":\"unavailable\",\"timestamp\":\"1970-01-01T00:00:00Z\",\"apiVersion\":\"1.0.0\"}}".getBytes(StandardCharsets.UTF_8))
                    .build();
        }
    }

    private static String safeIdentity(String value) {
        if (value == null || value.isBlank() || value.length() > 255) return null;
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character < 0x21 || character > 0x7e) return null;
        }
        return value;
    }
}
