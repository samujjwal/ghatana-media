package com.ghatana.audio.video.integration;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.dataformat.yaml.YAMLFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** Guards the CT-01 observed HTTP route denominator without creating a second registry. */
class MediaHttpRouteInventoryCountTest {

    private static final int OBSERVED_HTTP_ROUTE_COUNT = 30;
    private static final Path OPENAPI_RELATIVE_PATH = Path.of("contracts/openapi/media.yaml");
    private static final Path ROUTE_MANIFEST_RELATIVE_PATH = Path.of("config/route-manifest.json");
    private static final Set<String> HTTP_METHODS = Set.of(
            "get", "put", "post", "delete", "options", "head", "patch", "trace");
    private static final ObjectMapper YAML = new ObjectMapper(new YAMLFactory());
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void openApiAndRuntimeManifestRetainTheObservedThirtyRouteDenominator() throws IOException {
        Path root = findRepositoryRoot();
        JsonNode openApi = YAML.readTree(Files.readString(root.resolve(OPENAPI_RELATIVE_PATH)));
        JsonNode routeManifest = JSON.readTree(Files.readString(root.resolve(ROUTE_MANIFEST_RELATIVE_PATH)));

        assertThat(countOpenApiRoutes(openApi)).isEqualTo(OBSERVED_HTTP_ROUTE_COUNT);
        assertThat(routeManifest.path("routes").size()).isEqualTo(OBSERVED_HTTP_ROUTE_COUNT);
    }

    private static int countOpenApiRoutes(JsonNode openApi) {
        int count = 0;
        for (var path : openApi.path("paths").properties()) {
            for (var method : path.getValue().properties()) {
                if (HTTP_METHODS.contains(method.getKey().toLowerCase(Locale.ROOT))) count++;
            }
        }
        return count;
    }

    private static Path findRepositoryRoot() {
        Path candidate = Path.of("").toAbsolutePath().normalize();
        while (candidate != null) {
            if (Files.isRegularFile(candidate.resolve(OPENAPI_RELATIVE_PATH))
                    && Files.isRegularFile(candidate.resolve(ROUTE_MANIFEST_RELATIVE_PATH))) {
                return candidate;
            }
            candidate = candidate.getParent();
        }
        throw new IllegalStateException("could not locate Media repository root from test working directory");
    }
}
