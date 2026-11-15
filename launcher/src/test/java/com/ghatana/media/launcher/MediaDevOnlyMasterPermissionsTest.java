package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** The J-17 master routes are DEV_ONLY, owner-scoped and exactly enumerated; nothing else under the prefix is admitted. */
class MediaDevOnlyMasterPermissionsTest {
    @Test
    void masterRoutesMapToTheDevProjectPermissionsAndNothingElseIsAdmitted() {
        String read = MediaDevOnlyRoutePermissions.PROJECT_READ;
        String write = MediaDevOnlyRoutePermissions.PROJECT_WRITE;
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/masters/status")).isEqualTo(read);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/masters/stems")).isEqualTo(write);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/masters")).isEqualTo(write);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/masters/stems/abc")).isEqualTo(read);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/masters/abc")).isEqualTo(read);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("DELETE", "/dev/v1/masters/abc")).isNull();
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("PUT", "/dev/v1/masters")).isNull();
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/masters/status")).isNull();
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/masters/abc")).isNull();
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/masters/a/b")).isNull();
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/masters")).isNull();
        assertThat(MediaDevMasterRoutes.handles("/dev/v1/masters/status")).isTrue();
        assertThat(MediaDevMasterRoutes.handles("/dev/v1/mastersX")).isFalse();
    }

    @Test
    void theHostCanonicalizesEveryDigestInputSoARestartCannotChangeAFingerprint() {
        // Map.of iteration order is randomized per JVM; the request's canonical form must not depend on it.
        var request = MediaDevMasterSpec.parseMaster(java.util.Map.of("requestId", "r1", "stems",
                java.util.List.of(java.util.Map.of("artifactId", "a", "artifactVersionId", "v")),
                "target", java.util.Map.of("truePeakDbtp", -1.5, "integratedLufs", -18.0)));
        assertThat(request.canonical().keySet()).containsExactly("stems", "durationFrames", "target");
        assertThat(request.canonical().get("target")).isInstanceOf(java.util.Map.class);
        tools.jackson.databind.ObjectMapper sorted = tools.jackson.databind.json.JsonMapper.builder()
                .enable(tools.jackson.databind.SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS).build();
        assertThat(sorted.writeValueAsString(request.canonical()))
                .contains("\"target\":{\"integratedLufs\":-18.0,\"truePeakDbtp\":-1.5}");
    }
}
