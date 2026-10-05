package com.ghatana.media.api.openapi;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.dataformat.yaml.YAMLFactory;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * OpenAPI drift detection tests for the Media API.
 *
 * @doc.type class
 * @doc.purpose OpenAPI spec completeness and route identity verification
 * @doc.layer test
 * @doc.pattern ContractTest
 */
@DisplayName("Media OpenApi Drift Test")
@Tag("api")
@Tag("openapi")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class MediaOpenApiDriftTest {

    private static final ObjectMapper YAML = new ObjectMapper(new YAMLFactory());
    private static final Set<String> HTTP_METHODS = Set.of("get", "put", "post", "delete", "patch", "options", "head");

    private JsonNode spec;
    private Set<String> documentedRouteKeys;
    private Set<String> operationIds;

    @BeforeAll
    void loadSpec() throws IOException {
        Path specPath = Path.of("contracts/openapi/media.yaml");
        assertThat(Files.exists(specPath)).as("OpenAPI spec file must exist").isTrue();
        spec = YAML.readTree(Files.readString(specPath));
        documentedRouteKeys = extractRouteKeys(spec);
        operationIds = extractOperationIds(spec);
    }

    @Test
    void specHasInfoSection() {
        assertThat(spec.has("info")).isTrue();
        assertThat(spec.get("info").get("title").asText()).isNotBlank();
        assertThat(spec.get("info").get("version").asText()).isNotBlank();
    }

    @Test
    void specHasPathsSection() {
        assertThat(spec.has("paths")).isTrue();
        assertThat(spec.get("paths").size()).isGreaterThan(0);
    }

    @Test
    void everyOperationHasOperationId() {
        for (String routeKey : documentedRouteKeys) {
            String[] parts = routeKey.split(" ", 2);
            String method = parts[0].toLowerCase();
            String path = parts[1];
            JsonNode operation = spec.get("paths").get(path).get(method);
            assertThat(operation.has("operationId"))
                    .as("Missing operationId for %s %s", method, path)
                    .isTrue();
        }
    }

    @Test
    void operationIdsAreUnique() {
        assertThat(operationIds.size())
                .as("All operationIds must be unique")
                .isEqualTo(documentedRouteKeys.size());
    }

    private Set<String> extractRouteKeys(JsonNode spec) {
        Set<String> keys = new HashSet<>();
        JsonNode paths = spec.get("paths");
        if (paths == null) return keys;
        paths.propertyNames().forEach(path -> {
            JsonNode pathItem = paths.get(path);
            pathItem.propertyNames().forEach(method -> {
                if (HTTP_METHODS.contains(method.toLowerCase())) {
                    keys.add(method.toUpperCase() + " " + path);
                }
            });
        });
        return keys;
    }

    private Set<String> extractOperationIds(JsonNode spec) {
        Set<String> ids = new HashSet<>();
        JsonNode paths = spec.get("paths");
        if (paths == null) return ids;
        paths.propertyNames().forEach(path -> {
            JsonNode pathItem = paths.get(path);
            pathItem.propertyNames().forEach(method -> {
                if (HTTP_METHODS.contains(method.toLowerCase())) {
                    JsonNode operation = pathItem.get(method);
                    if (operation.has("operationId")) {
                        ids.add(operation.get("operationId").asText());
                    }
                }
            });
        });
        return ids;
    }
}
