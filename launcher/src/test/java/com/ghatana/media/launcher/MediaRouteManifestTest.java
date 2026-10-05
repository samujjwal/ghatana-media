package com.ghatana.media.launcher;

import com.ghatana.launcher.routemanifest.RouteEntry;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Truth reconciliation tests for Media route manifest.
 *
 * @doc.type class
 * @doc.purpose Truth reconciliation tests for Media route manifest (Contract 10)
 * @doc.layer test
 * @doc.pattern TruthReconciliationTest
 */
@DisplayName("Media Route Manifest Truth Reconciliation")
class MediaRouteManifestTest {

    @Nested
    @DisplayName("canonical manifest integrity")
    class CanonicalManifestIntegrity {

        @Test
        @DisplayName("manifest has expected number of routes")
        void manifestHasExpectedRouteCount() {
            assertThat(MediaRouteManifest.routeCount()).isEqualTo(27);
        }

        @Test
        @DisplayName("all public routes are GET")
        void allPublicRoutesAreGet() {
            assertThat(MediaRouteManifest.all().stream().filter(RouteEntry::publicAccess).toList())
                    .allSatisfy(route -> assertThat(route.method()).isEqualTo("GET"));
        }

        @Test
        @DisplayName("public routes and application routes are distinct")
        void publicAndApplicationRoutesAreDistinct() {
            assertThat(MediaRouteManifest.all())
                    .anySatisfy(route -> assertThat(route.publicAccess()).isTrue())
                    .anySatisfy(route -> assertThat(route.publicAccess()).isFalse());
        }

        @Test
        @DisplayName("manifest includes health, metrics, info, and application categories")
        void manifestIncludesExpectedCategories() {
            Set<String> categories = MediaRouteManifest.all().stream()
                    .map(r -> r.category().name())
                    .collect(java.util.stream.Collectors.toSet());
            assertThat(categories).contains("HEALTH", "METRICS", "INFO", "APPLICATION");
        }

        @Test
        @DisplayName("manifest toManifest produces valid structure")
        void toManifestProducesValidStructure() {
            var manifest = MediaRouteManifest.toManifest();
            assertThat(manifest.get("service")).isEqualTo("media");
            assertThat(manifest.get("version")).isEqualTo("1.3.0");
            assertThat(manifest.get("totalRoutes")).isEqualTo(27);
            assertThat(manifest.get("routes")).isInstanceOf(java.util.List.class);
        }

        @Test
        @DisplayName("every protected route resolves one canonical permission and public routes resolve none")
        void everyProtectedRouteHasCanonicalPermission() {
            assertThat(MediaRouteManifest.all()).allSatisfy(route -> {
                String concretePath = route.path()
                        .replace("{consentId}", "consent-a")
                        .replace("{uploadId}", "upload-a")
                        .replace("{chunkIndex}", "0")
                        .replace("{artifactId}", "artifact-a")
                        .replace("{jobId}", "job-a")
                        .replace("{sessionId}", "session-a")
                        .replace("{sequence}", "0");
                String permission = MediaRouteManifest.requiredPermission(route.method(), concretePath);
                if (route.publicAccess()) {
                    assertThat(permission).as(route.method() + " " + route.path()).isNull();
                } else {
                    assertThat(permission)
                            .as(route.method() + " " + route.path())
                            .matches("^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*){1,3}$");
                }
            });
        }
    }

    @Nested
    @DisplayName("drift detection")
    class DriftDetection {

        @Test
        @DisplayName("no drift when served paths match canonical")
        void noDriftWhenPathsMatch() {
            Set<String> served = MediaRouteManifest.allPaths();
            var result = MediaRouteManifest.reconcile(served);
            assertThat(result.ok()).isTrue();
            assertThat(result.drift()).isFalse();
            assertThat(result.missingRoutes()).isEmpty();
            assertThat(result.extraRoutes()).isEmpty();
        }

        @Test
        @DisplayName("detects missing routes")
        void detectsMissingRoutes() {
            Set<String> served = Set.of("/health", "/health/live", "/metrics", "/info");
            var result = MediaRouteManifest.reconcile(served);
            assertThat(result.drift()).isTrue();
            assertThat(result.missingRoutes()).contains("/health/ready", "/health/startup", "/ready");
        }

        @Test
        @DisplayName("detects extra routes")
        void detectsExtraRoutes() {
            Set<String> served = new java.util.HashSet<>(MediaRouteManifest.allPaths());
            served.add("/unknown");
            served.add("/deprecated");
            var result = MediaRouteManifest.reconcile(served);
            assertThat(result.drift()).isTrue();
            assertThat(result.extraRoutes()).contains("/unknown", "/deprecated");
        }

        @Test
        @DisplayName("detects both missing and extra routes simultaneously")
        void detectsBothMissingAndExtra() {
            Set<String> served = new java.util.HashSet<>(MediaRouteManifest.allPaths());
            served.remove("/ready");
            served.add("/unknown");
            var result = MediaRouteManifest.reconcile(served);
            assertThat(result.drift()).isTrue();
            assertThat(result.missingRoutes()).contains("/ready");
            assertThat(result.extraRoutes()).contains("/unknown");
        }
    }

    @Nested
    @DisplayName("health handler alignment")
    class HealthHandlerAlignment {

        @Test
        @DisplayName("health handler paths are subset of canonical manifest")
        void healthHandlerPathsAreSubsetOfCanonical() {
            Set<String> healthPaths = Set.of(
                    "/health",
                    "/health/live",
                    "/health/ready",
                    "/health/startup",
                    "/metrics",
                    "/info"
            );
            for (String path : healthPaths) {
                assertThat(MediaRouteManifest.isKnownPath(path))
                        .as("Health handler path %s must be in canonical manifest", path)
                        .isTrue();
            }
        }

        @Test
        @DisplayName("security filter public paths match manifest public paths")
        void securityFilterPublicPathsMatchManifest() {
            Set<String> manifestPublic = MediaRouteManifest.publicPaths();
            assertThat(manifestPublic).contains(
                    "/health", "/health/live", "/health/ready", "/health/startup",
                    "/metrics", "/info", "/ready"
            );
        }
    }
}
