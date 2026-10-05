package com.ghatana.audio.video.common.platform;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * @doc.type class
 * @doc.purpose Optional HTTP client for the Ghatana AI Registry.
 *              Allows audio-video services to discover which model version is
 *              PRODUCTION / ACTIVE for a given tenant, enabling runtime model
 *              selection without code changes.
 * @doc.layer product
 * @doc.pattern Service
 *
 * <p>Configuration: set the {@code AI_REGISTRY_URL} environment variable to
 * the base URL of the platform AI Registry (e.g. {@code http://ai-registry:8080}).
 * When the variable is absent the client logs a warning and all lookups return
 * {@link Optional#empty()} without throwing.
 *
 * <p>Responses are cached in-process for {@value #CACHE_TTL_MS} ms to avoid
 * hammering the registry on every inference call.
 */
public final class AiRegistryClient {

    private static final Logger LOG = Logger.getLogger(AiRegistryClient.class.getName());
    private static final long CACHE_TTL_MS = 60_000L;
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(5);

    private static volatile AiRegistryClient instance;

    private final String baseUrl;
    private final HttpClient http;
    /** Simple string cache: cacheKey → (json payload, expiresAt). */
    private final ConcurrentHashMap<String, CacheEntry> cache = new ConcurrentHashMap<>();

    private AiRegistryClient(String baseUrl) {
        this.baseUrl = baseUrl;
        this.http = HttpClient.newBuilder()
                .connectTimeout(REQUEST_TIMEOUT)
                .build();
    }

    /**
     * Return the singleton instance, configured from the {@code AI_REGISTRY_URL}
     * environment variable.
     */
    public static AiRegistryClient getInstance() {
        if (instance == null) {
            synchronized (AiRegistryClient.class) {
                if (instance == null) {
                    String url = System.getenv("AI_REGISTRY_URL");
                    if (url == null || url.isBlank()) {
                        LOG.warning("[AiRegistryClient] AI_REGISTRY_URL not set — model registry lookups disabled");
                        url = "";
                    }
                    instance = new AiRegistryClient(url);
                }
            }
        }
        return instance;
    }

    /**
     * Find the active model for a tenant and model name.
     * Checks PRODUCTION first, falls back to ACTIVE.
     *
     * @param tenantId  Tenant identifier.
     * @param modelName Canonical model name (e.g. "whisper-base", "piper-en").
     * @return JSON object string for the matched model record, or empty if
     *         unavailable.
     */
    public Optional<String> findActiveModel(String tenantId, String modelName) {
        if (baseUrl.isBlank()) return Optional.empty();

        Optional<String> prod = listModels(tenantId, "PRODUCTION").stream()
                .filter(m -> m.contains("\"name\":\"" + modelName + "\""))
                .findFirst();
        if (prod.isPresent()) return prod;

        return listModels(tenantId, "ACTIVE").stream()
                .filter(m -> m.contains("\"name\":\"" + modelName + "\""))
                .findFirst();
    }

    /**
     * List all models for a tenant filtered to the given status.
     *
     * @param tenantId Tenant identifier.
     * @param status   Model lifecycle status string (e.g. "PRODUCTION").
     * @return List of JSON object strings, one per model record.  Empty on error.
     */
    public List<String> listModels(String tenantId, String status) {
        if (baseUrl.isBlank()) return List.of();

        String cacheKey = tenantId + ":" + status;
        CacheEntry cached = cache.get(cacheKey);
        if (cached != null && System.currentTimeMillis() < cached.expiresAt) {
            return cached.items;
        }

        try {
            String url = baseUrl + "/api/v1/models?tenantId=" + encode(tenantId)
                    + "&status=" + encode(status);
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .timeout(REQUEST_TIMEOUT)
                    .GET()
                    .header("Accept", "application/json")
                    .build();

            HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() != 200) {
                LOG.warning("[AiRegistryClient] HTTP " + resp.statusCode() + " for " + url);
                return List.of();
            }

            List<String> items = parseModelArray(resp.body());
            cache.put(cacheKey, new CacheEntry(items, System.currentTimeMillis() + CACHE_TTL_MS));
            return items;

        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            LOG.log(Level.WARNING, "[AiRegistryClient] listModels failed", e);
            return List.of();
        }
    }

    /**
     * Minimal JSON array parser that splits a {@code {"models":[{...},{...}],...}}
     * response into individual JSON object strings. Uses simple brace counting to
     * avoid a full JSON dependency in this common lib.
     */
    private static List<String> parseModelArray(String json) {
        int arrStart = json.indexOf('[');
        int arrEnd = json.lastIndexOf(']');
        if (arrStart < 0 || arrEnd <= arrStart) return List.of();

        java.util.List<String> result = new java.util.ArrayList<>();
        int depth = 0;
        int objStart = -1;
        String inner = json.substring(arrStart + 1, arrEnd);
        for (int i = 0; i < inner.length(); i++) {
            char c = inner.charAt(i);
            if (c == '{') { if (depth++ == 0) objStart = i; }
            else if (c == '}') { if (--depth == 0 && objStart >= 0) result.add(inner.substring(objStart, i + 1)); }
        }
        return java.util.Collections.unmodifiableList(result);
    }

    private static String encode(String s) {
        return java.net.URLEncoder.encode(s, java.nio.charset.StandardCharsets.UTF_8);
    }

    private record CacheEntry(List<String> items, long expiresAt) {}
}
