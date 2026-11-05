package com.ghatana.media.launcher;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.dataformat.yaml.YAMLFactory;
import com.ghatana.launcher.routemanifest.RouteEntry;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** Verifies that executable HTTP routes, the generated route inventory, and OpenAPI describe the same API. */
class MediaHttpContractParityTest {
    private static final Set<String> HTTP_METHODS = Set.of(
            "get", "put", "post", "delete", "patch", "options", "head");
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final ObjectMapper YAML = new ObjectMapper(new YAMLFactory());

    @Test
    void runtimeManifestRouteInventoryAndOpenApiOperationsAreIdentical() throws Exception {
        JsonNode routeDocument = JSON.readTree(Files.readString(repositoryFile("config/route-manifest.json")));
        JsonNode openApi = YAML.readTree(Files.readString(repositoryFile("contracts/openapi/media.yaml")));
        assertThat(openApi.path("security").isArray()).isTrue();
        assertThat(openApi.path("security").size()).isGreaterThan(0);

        Map<String, JsonNode> configuredRoutes = new HashMap<>();
        for (JsonNode route : routeDocument.path("routes")) {
            configuredRoutes.put(route.path("id").asText(), route);
        }
        Set<String> runtimeRoutes = MediaRouteManifest.all().stream()
                .map(MediaHttpContractParityTest::routeId)
                .collect(java.util.stream.Collectors.toUnmodifiableSet());
        Set<String> operationIds = new java.util.HashSet<>();

        Map<String, JsonNode> documentedOperations = new HashMap<>();
        JsonNode paths = openApi.path("paths");
        Iterator<String> pathNames = paths.propertyNames().iterator();
        while (pathNames.hasNext()) {
            String path = pathNames.next();
            JsonNode pathItem = paths.path(path);
            Iterator<String> methods = pathItem.propertyNames().iterator();
            while (methods.hasNext()) {
                String method = methods.next().toLowerCase(java.util.Locale.ROOT);
                if (!HTTP_METHODS.contains(method)) continue;
                JsonNode operation = pathItem.path(method);
                String id = method.toUpperCase(java.util.Locale.ROOT) + " " + path;
                documentedOperations.put(id, operation);
            }
        }

        assertThat(configuredRoutes.keySet()).containsExactlyInAnyOrderElementsOf(runtimeRoutes);
        assertThat(documentedOperations.keySet()).containsExactlyInAnyOrderElementsOf(runtimeRoutes);
        for (RouteEntry route : MediaRouteManifest.all()) {
            String id = routeId(route);
            JsonNode configured = configuredRoutes.get(id);
            JsonNode operation = documentedOperations.get(id);
            assertThat(configured).as("configured route %s", id).isNotNull();
            assertThat(operation).as("OpenAPI operation %s", id).isNotNull();
            assertThat(configured.path("method").asText()).isEqualTo(route.method());
            assertThat(configured.path("path").asText()).isEqualTo(route.path());
            assertThat(operation.path("operationId").asText()).isEqualTo(configured.path("operationId").asText());
            assertThat(operationIds.add(operation.path("operationId").asText()))
                    .as("operationId for %s must be unique", id)
                    .isTrue();
            assertThat(operation.path("x-ghatana-routeId").asText()).isEqualTo(id);
            assertThat(configured.path("visibility").asText())
                    .isEqualTo(route.publicAccess() ? "public" : "authenticated");

            if (route.publicAccess()) {
                assertThat(operation.path("security").isArray()).isTrue();
                assertThat(operation.path("security").size()).isZero();
                assertThat(operation.path("x-ghatana-security").path("requiresAuth").asBoolean()).isFalse();
            } else {
                assertThat(operation.has("security") && operation.path("security").size() == 0)
                        .as("protected route %s must not override inherited OpenAPI authentication", id)
                        .isFalse();
                assertThat(MediaRouteManifest.requiredPermission(route.method(), concretePath(route.path())))
                        .as("protected route %s must have a runtime permission", id)
                        .isNotBlank();
                assertThat(operation.path("x-ghatana-security").path("requiresAuth").asBoolean())
                        .as("protected route %s must declare authentication", id)
                        .isTrue();
            }
            assertThat(operation.path("responses").isObject())
                    .as("route %s must document typed outcomes", id)
                    .isTrue();
            if (!route.publicAccess()) {
                assertThat(operation.path("responses").has("401"))
                        .as("protected route %s must document missing authentication", id)
                        .isTrue();
                assertThat(operation.path("responses").has("503"))
                        .as("protected route %s must document runtime/provider unavailability", id)
                        .isTrue();
            }
        }
    }

    private static String routeId(RouteEntry route) {
        return route.method() + " " + route.path();
    }

    private static Path repositoryFile(String relativePath) {
        Path fromRepositoryRoot = Path.of(relativePath);
        if (Files.exists(fromRepositoryRoot)) return fromRepositoryRoot;
        Path fromLauncherProject = Path.of("..", relativePath);
        if (Files.exists(fromLauncherProject)) return fromLauncherProject;
        throw new AssertionError("Repository contract file does not exist: " + relativePath);
    }

    private static String concretePath(String template) {
        return template
                .replace("{consentId}", "consent-a")
                .replace("{uploadId}", "upload-a")
                .replace("{chunkIndex}", "0")
                .replace("{artifactId}", "artifact-a")
                .replace("{jobId}", "job-a")
                .replace("{sessionId}", "session-a")
                .replace("{sequence}", "0")
                .replace("{captionVersionId}", "caption-a");
    }
}
