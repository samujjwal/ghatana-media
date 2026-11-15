package com.ghatana.media.launcher;

import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.util.Map;

/**
 * DEV_ONLY {@code GET /dev/v1/providers/catalog} (outside the canonical manifest/OpenAPI): the observed readiness of
 * every local provider. The view is produced by {@link MediaDevProviderCatalog}; it contains no filesystem path,
 * endpoint or token and never reports READY from configuration alone.
 */
final class MediaDevProviderCatalogRoutes {
    static final String CATALOG = "/dev/v1/providers/catalog";

    private final MediaDevProviderCatalog catalog;

    MediaDevProviderCatalogRoutes(MediaDevProviderCatalog catalog) {
        this.catalog = catalog;
    }

    static boolean handles(String path) {
        return path.startsWith("/dev/v1/providers/");
    }

    void handle(HttpExchange exchange, String path, String method, MediaDevCreativeOutputRoutes.Responder out)
            throws IOException {
        if (!CATALOG.equals(path)) {
            out.error(exchange, 404, "NOT_FOUND", "Provider catalog route not found", Map.of());
            return;
        }
        if (!"GET".equals(method)) {
            exchange.getResponseHeaders().set("Allow", "GET");
            out.error(exchange, 405, "METHOD_NOT_ALLOWED", "Method not allowed", Map.of());
            return;
        }
        try {
            out.json(exchange, 200, catalog.view());
        } catch (MediaDevProviderCatalog.CatalogBusyException busy) {
            out.error(exchange, 503, "PROVIDER_CATALOG_BUSY", busy.getMessage(), Map.of());
        }
    }
}
