package com.ghatana.audio.video.common.platform;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * @doc.type class
 * @doc.purpose Optional HTTP client for the Ghatana Feature Store.
 *              Allows audio-video services to asynchronously record inference
 *              events (transcriptions, detections, voice generations) as feature
 *              data for downstream ML training and analytics.
 * @doc.layer product
 * @doc.pattern Service
 *
 * <p>Configuration: set {@code FEATURE_STORE_URL} to the platform Feature Store
 * base URL (e.g. {@code http://feature-store:8080}). When absent every ingest
 * call is a silent no-op — the inference path is never blocked.
 *
 * <p>All ingest calls are fire-and-forget: a background thread sends the HTTP
 * request; exceptions are swallowed and logged as WARN.
 */
public final class FeatureStoreClient {

    private static final Logger LOG = Logger.getLogger(FeatureStoreClient.class.getName());
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(5);

    private static volatile FeatureStoreClient instance;

    private final String baseUrl;
    private final HttpClient http;
    private final java.util.concurrent.ExecutorService bgExecutor;

    private FeatureStoreClient(String baseUrl) {
        this.baseUrl = baseUrl;
        this.http = HttpClient.newBuilder()
                .connectTimeout(REQUEST_TIMEOUT)
                .build();
        this.bgExecutor = java.util.concurrent.Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "av-feature-store-ingest");
            t.setDaemon(true);
            return t;
        });
    }

    /**
     * Return the singleton instance, configured from {@code FEATURE_STORE_URL}.
     */
    public static FeatureStoreClient getInstance() {
        if (instance == null) {
            synchronized (FeatureStoreClient.class) {
                if (instance == null) {
                    String url = System.getenv("FEATURE_STORE_URL");
                    if (url == null || url.isBlank()) {
                        LOG.warning("[FeatureStoreClient] FEATURE_STORE_URL not set — feature ingest disabled");
                        url = "";
                    }
                    instance = new FeatureStoreClient(url);
                }
            }
        }
        return instance;
    }

    /**
     * Ingest a set of features for an entity (fire-and-forget).
     * Returns immediately; the HTTP call is made on a background daemon thread.
     *
     * @param tenantId   Tenant identifier.
     * @param entityId   Entity identifier (e.g. user ID, session ID).
     * @param features   Key-value pairs to record.
     */
    public void ingestAsync(String tenantId, String entityId, Map<String, Object> features) {
        if (baseUrl.isBlank() || features.isEmpty()) return;
        bgExecutor.execute(() -> {
            try {
                ingest(tenantId, entityId, features);
            } catch (Exception e) {
                LOG.log(Level.WARNING, "[FeatureStoreClient] ingestAsync failed for entity " + entityId, e);
            }
        });
    }

    /**
     * Ingest features synchronously. Callers should prefer {@link #ingestAsync} on
     * the hot inference path.
     *
     * @param tenantId  Tenant identifier.
     * @param entityId  Entity identifier.
     * @param features  Feature map to persist.
     * @throws IOException          On network or server error.
     * @throws InterruptedException If the calling thread is interrupted.
     */
    public void ingest(String tenantId, String entityId, Map<String, Object> features)
            throws IOException, InterruptedException {
        if (baseUrl.isBlank() || features.isEmpty()) return;

        String body = toJson(features);
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + "/api/v1/features/"
                        + encode(tenantId) + "/" + encode(entityId) + "/batch"))
                .timeout(REQUEST_TIMEOUT)
                .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                .header("Content-Type", "application/json")
                .build();

        HttpResponse<Void> resp = http.send(req, HttpResponse.BodyHandlers.discarding());
        if (resp.statusCode() >= 400) {
            throw new IOException("Feature Store returned HTTP " + resp.statusCode());
        }
    }

    /** Minimal JSON object serializer for primitive values only. */
    private static String toJson(Map<String, Object> map) {
        StringBuilder sb = new StringBuilder("{\"features\":{");
        boolean first = true;
        for (Map.Entry<String, Object> e : map.entrySet()) {
            if (!first) sb.append(',');
            sb.append('"').append(e.getKey().replace("\"", "\\\"")).append("\":");
            Object v = e.getValue();
            if (v instanceof Number || v instanceof Boolean) {
                sb.append(v);
            } else {
                sb.append('"').append(String.valueOf(v).replace("\"", "\\\"")).append('"');
            }
            first = false;
        }
        sb.append("}}");
        return sb.toString();
    }

    private static String encode(String s) {
        return java.net.URLEncoder.encode(s, StandardCharsets.UTF_8);
    }
}
