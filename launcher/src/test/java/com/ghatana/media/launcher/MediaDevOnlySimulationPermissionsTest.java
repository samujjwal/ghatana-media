package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** The J-14/J-15 DEV_ONLY simulation routes are guarded by exact method and path, never by a prefix. */
class MediaDevOnlySimulationPermissionsTest {
    @Test
    void postNeedsProjectWriteAndReadsNeedProjectRead() {
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/simulations")).isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_WRITE);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/simulations/abc")).isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/simulations/status")).isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
    }

    @Test
    void anythingElseOnTheNewPathsHasNoPermissionMapping() {
        for (String[] route : new String[][] {
                {"GET", "/dev/v1/simulations"}, {"PUT", "/dev/v1/simulations"}, {"DELETE", "/dev/v1/simulations/abc"},
                {"POST", "/dev/v1/simulations/abc"}, {"POST", "/dev/v1/simulations/"}, {"GET", "/dev/v1/simulations/a/b"},
                {"POST", "/dev/v1/simulations/status"}, {"GET", "/dev/v1/simulations/"}, {"POST", "/dev/v1/simulationsx"}}) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission(route[0], route[1])).as(route[0] + " " + route[1]).isNull();
        }
    }
}
