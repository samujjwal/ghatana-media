package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** The J-13 DEV_ONLY rig routes are guarded by exact method and path, never by a prefix. */
class MediaDevOnlyRigPermissionsTest {

    @Test
    void postNeedsProjectWriteAndReadsNeedProjectRead() {
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/rigs/renders"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_WRITE);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/rigs/renders/abc"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/rigs/status"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
    }

    @Test
    void anythingElseOnTheNewPathsHasNoPermissionMapping() {
        for (String[] route : new String[][] {
                {"GET", "/dev/v1/rigs/renders"}, {"PUT", "/dev/v1/rigs/renders"}, {"DELETE", "/dev/v1/rigs/renders/abc"},
                {"POST", "/dev/v1/rigs/renders/abc"}, {"POST", "/dev/v1/rigs/renders/"}, {"GET", "/dev/v1/rigs/renders/a/b"},
                {"POST", "/dev/v1/rigs/status"}, {"GET", "/dev/v1/rigs"}, {"GET", "/dev/v1/rigs/"},
                {"POST", "/dev/v1/rigs/rendersx"}}) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission(route[0], route[1]))
                    .as(route[0] + " " + route[1]).isNull();
        }
    }
}
