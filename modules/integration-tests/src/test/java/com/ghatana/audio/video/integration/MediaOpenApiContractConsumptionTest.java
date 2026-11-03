package com.ghatana.audio.video.integration;

import com.ghatana.servicecontracts.testing.OpenApiContractAssertions;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.dataformat.yaml.YAMLFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

@DisplayName("Media OpenAPI contract consumption")
class MediaOpenApiContractConsumptionTest {

    private record OperationRoute(String operationId, String routeId) {}

    private static final String CONTRACT_PATH = "contracts/openapi/media.yaml";
    private static final Path ROUTE_MANIFEST_PATH = Path.of("config/route-manifest.json");
    private static final Set<String> HTTP_METHODS = Set.of(
            "get", "put", "post", "delete", "options", "head", "patch", "trace");
    private static final ObjectMapper YAML = new ObjectMapper(new YAMLFactory());
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void consumesCanonicalOpenApiContract() {
        OpenApiContractAssertions.assertRuntimeMatchesContract(
                "media",
                CONTRACT_PATH,
                ROUTE_MANIFEST_PATH);
    }

    @Test
    void routeManifestAndOpenApiOperationsMatchInBothDirections() throws IOException {
        Path root = findRepositoryRoot();
        JsonNode spec = YAML.readTree(Files.readString(root.resolve(CONTRACT_PATH)));
        JsonNode manifest = JSON.readTree(Files.readString(root.resolve(ROUTE_MANIFEST_PATH)));
        Assertions.assertEquals("media", textOrEmpty(manifest.path("serviceId")));

        Map<String, OperationRoute> contractOperations = new HashMap<>();
        for (Map.Entry<String, JsonNode> path : spec.path("paths").properties()) {
            for (Map.Entry<String, JsonNode> method : path.getValue().properties()) {
                String normalizedMethod = method.getKey().toLowerCase(Locale.ROOT);
                if (!HTTP_METHODS.contains(normalizedMethod)) continue;
                String key = normalizedMethod + " " + normalizePath(path.getKey());
                String operationId = textOrEmpty(method.getValue().path("operationId"));
                String routeId = textOrEmpty(method.getValue().path("x-ghatana-routeId"));
                Assertions.assertFalse(operationId.isBlank(), "OpenAPI operationId is required for " + key);
                Assertions.assertFalse(routeId.isBlank(), "OpenAPI route id is required for " + key);
                Assertions.assertNull(contractOperations.putIfAbsent(key, new OperationRoute(operationId, routeId)),
                        "OpenAPI route must be unique: " + key);
            }
        }

        Map<String, OperationRoute> runtimeRoutes = new HashMap<>();
        Set<String> routeIds = new HashSet<>();
        for (JsonNode route : manifest.path("routes")) {
            String method = textOrEmpty(route.path("method")).toLowerCase(Locale.ROOT);
            String path = textOrEmpty(route.path("path"));
            String operationId = textOrEmpty(route.path("operationId"));
            String routeId = textOrEmpty(route.path("id"));
            Assertions.assertTrue(HTTP_METHODS.contains(method), "Unsupported route method: " + method);
            Assertions.assertFalse(path.isBlank(), "Runtime route path is required");
            Assertions.assertFalse(operationId.isBlank(), "Runtime operationId is required for " + path);
            Assertions.assertFalse(routeId.isBlank(), "Runtime route id is required for " + path);
            Assertions.assertTrue(routeIds.add(routeId), "Duplicate runtime route id: " + routeId);
            String key = method + " " + normalizePath(path);
            Assertions.assertNull(runtimeRoutes.putIfAbsent(key, new OperationRoute(operationId, routeId)),
                    "Runtime route must be unique: " + key);
        }

        Assertions.assertEquals(contractOperations, runtimeRoutes,
                "OpenAPI and runtime route manifest must have identical method/path/operation/route-id mappings");
    }

    private static String normalizePath(String value) {
        return value.replaceAll(":([A-Za-z_][A-Za-z0-9_]*)", "{$1}").replaceAll("/+$", "");
    }

    private static String textOrEmpty(JsonNode value) {
        return value.stringValueOpt().orElse("");
    }

    private static Path findRepositoryRoot() {
        Path candidate = Path.of("").toAbsolutePath().normalize();
        while (candidate != null) {
            if (Files.isRegularFile(candidate.resolve(CONTRACT_PATH))
                    && Files.isRegularFile(candidate.resolve(ROUTE_MANIFEST_PATH))) {
                return candidate;
            }
            candidate = candidate.getParent();
        }
        throw new IllegalStateException("could not locate Media repository root from the test working directory");
    }
}
