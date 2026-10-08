package com.ghatana.media.provider.aws;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;
import com.ghatana.launcher.config.RuntimeSecretReference;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/** Shared bounded HTTP transport and explicit processing-region configuration for Media adapters. */
final class MediaHttpProviderClient {
    private static final int DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
    private static final int ABSOLUTE_MAX_RESPONSE_BYTES = 256 * 1024 * 1024;

    private final ObjectMapper mapper = JsonMapper.builder().addModules(tools.jackson.databind.cfg.MapperBuilder.findModules()).build();
    private final HttpClient client;
    private final URI baseUri;
    private final String token;
    private final Duration timeout;
    private final int priority;
    private final int maximumResponseBytes;
    private final String processingRegion;
    private final ProviderDataRetention providerDataRetention;
    private final boolean configured;

    MediaHttpProviderClient(Map<String, String> environment) {
        timeout = Duration.ofMillis(number(environment,
                "MEDIA_HTTP_PROVIDER_TIMEOUT_MS", 900_000L, 100L, 86_400_000L));
        priority = (int) number(environment, "MEDIA_HTTP_PROVIDER_PRIORITY", 100L, 0L, 10_000L);
        maximumResponseBytes = (int) number(
                environment, "MEDIA_HTTP_PROVIDER_MAX_RESPONSE_BYTES",
                DEFAULT_MAX_RESPONSE_BYTES, 1L, ABSOLUTE_MAX_RESPONSE_BYTES);
        processingRegion = environment.getOrDefault("MEDIA_HTTP_PROVIDER_REGION", "").trim()
                .toLowerCase(Locale.ROOT);
        providerDataRetention = providerDataRetention(environment.getOrDefault(
                "MEDIA_HTTP_PROVIDER_DATA_RETENTION", "UNKNOWN"));
        client = HttpClient.newBuilder().connectTimeout(timeout)
                .followRedirects(HttpClient.Redirect.NEVER).build();
        String endpoint = environment.getOrDefault("MEDIA_HTTP_PROVIDER_ENDPOINT", "").trim();
        if (endpoint.isBlank()) {
            baseUri = null;
            token = "";
            configured = false;
            return;
        }
        baseUri = normalized(endpoint);
        boolean productionLike = productionLike(environment.getOrDefault(
                "MEDIA_RUNTIME_ENVIRONMENT", environment.getOrDefault("MEDIA_PROFILE", "local")));
        token = RuntimeSecretReference.resolveOptionalEnvironment(
                environment,
                environment.getOrDefault("MEDIA_HTTP_PROVIDER_TOKEN_REFERENCE", ""),
                "Media HTTP provider token",
                productionLike);
        if (productionLike && !"https".equalsIgnoreCase(baseUri.getScheme())) {
            throw new IllegalStateException("Production Media HTTP provider requires HTTPS");
        }
        if (productionLike && processingRegion.isBlank()) {
            throw new IllegalStateException(
                    "Production Media HTTP provider requires MEDIA_HTTP_PROVIDER_REGION for residency enforcement");
        }
        configured = true;
    }

    boolean configured() { return configured; }
    int priority() { return priority; }
    Duration timeout() { return timeout; }
    String processingRegion() { return processingRegion; }
    ProviderDataRetention providerDataRetention() { return providerDataRetention; }
    URI resolve(String relative) { requireConfigured(); return baseUri.resolve(relative); }
    ObjectMapper mapper() { return mapper; }

    boolean productionEligible() {
        return configured && "https".equalsIgnoreCase(baseUri.getScheme())
                && !token.isBlank() && !processingRegion.isBlank()
                && providerDataRetention != ProviderDataRetention.UNKNOWN;
    }

    boolean ready() {
        if (!configured) return false;
        try {
            HttpResponse<Void> response = client.send(
                    request(resolve("health/ready")).GET().timeout(timeout).build(),
                    HttpResponse.BodyHandlers.discarding());
            return success(response.statusCode());
        } catch (Exception failure) {
            if (failure instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            return false;
        }
    }

    HttpRequest.Builder request(URI uri) {
        HttpRequest.Builder builder = HttpRequest.newBuilder(uri);
        if (!token.isBlank()) builder.header("Authorization", "Bearer " + token);
        return builder;
    }

    CompletableFuture<HttpResponse<byte[]>> send(HttpRequest request) {
        requireConfigured();
        return client.sendAsync(request, boundedByteArrayHandler());
    }

    void requireSuccess(HttpResponse<?> response, String operation) {
        if (!success(response.statusCode())) {
            throw new IllegalStateException(operation + " returned status " + response.statusCode());
        }
    }

    JsonNode json(HttpResponse<byte[]> response, String operation) {
        requireSuccess(response, operation);
        if (response.body() == null || response.body().length == 0) {
            throw new IllegalStateException(operation + " returned an empty response");
        }
        try { return mapper.readTree(response.body()); }
        catch (Exception failure) { throw new IllegalStateException(operation + " response is malformed", failure); }
    }

    void requireConfigured() {
        if (!configured) throw new IllegalStateException("Media HTTP provider is not configured");
    }

    private HttpResponse.BodyHandler<byte[]> boundedByteArrayHandler() {
        return responseInfo -> {
            long declaredLength = responseInfo.headers().firstValueAsLong("Content-Length").orElse(-1L);
            if (declaredLength > maximumResponseBytes) throw responseTooLarge(declaredLength);
            return HttpResponse.BodySubscribers.mapping(
                    HttpResponse.BodySubscribers.ofInputStream(), this::readBoundedBody);
        };
    }

    private byte[] readBoundedBody(InputStream input) {
        try (InputStream body = input) {
            byte[] bytes = body.readNBytes(maximumResponseBytes + 1);
            if (bytes.length > maximumResponseBytes) throw responseTooLarge(bytes.length);
            return bytes;
        } catch (Exception failure) {
            throw new RuntimeException("Unable to read Media HTTP provider response", failure);
        }
    }

    private IllegalStateException responseTooLarge(long observedBytes) {
        return new IllegalStateException(
                "Media HTTP provider response exceeds " + maximumResponseBytes
                        + " bytes (observed=" + observedBytes + ")");
    }

    private static boolean success(int status) { return status >= 200 && status < 300; }

    private static ProviderDataRetention providerDataRetention(String value) {
        try {
            return ProviderDataRetention.valueOf(value.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException failure) {
            throw new IllegalArgumentException(
                    "MEDIA_HTTP_PROVIDER_DATA_RETENTION must be one of UNKNOWN, NONE, TRANSIENT, PERSISTENT",
                    failure);
        }
    }

    private static URI normalized(String value) {
        URI uri = URI.create(value.trim());
        if (uri.getScheme() == null || uri.getHost() == null
                || !("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme()))) {
            throw new IllegalArgumentException("MEDIA_HTTP_PROVIDER_ENDPOINT must be an absolute HTTP(S) URI");
        }
        return URI.create(uri.toString().endsWith("/") ? uri.toString() : uri + "/");
    }

    private static long number(Map<String, String> environment, String key, long fallback, long min, long max) {
        try {
            long value = Long.parseLong(environment.getOrDefault(key, Long.toString(fallback)).trim());
            if (value < min || value > max) throw new IllegalArgumentException(key + " is outside the supported range");
            return value;
        } catch (NumberFormatException failure) {
            throw new IllegalArgumentException(key + " must be an integer", failure);
        }
    }

    private static boolean productionLike(String profile) {
        String normalized = profile == null ? "" : profile.trim();
        return "production".equalsIgnoreCase(normalized)
                || "staging".equalsIgnoreCase(normalized)
                || "sovereign".equalsIgnoreCase(normalized);
    }
}
