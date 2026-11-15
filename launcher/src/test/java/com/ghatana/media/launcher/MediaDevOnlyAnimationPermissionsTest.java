package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** The J-12 DEV_ONLY animation routes are guarded by exact method and path, never by a prefix. */
class MediaDevOnlyAnimationPermissionsTest {

    @Test
    void postNeedsProjectWriteAndReadsNeedProjectRead() {
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/animations/renders"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_WRITE);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/animations/renders/abc"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/animations/status"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
    }

    @Test
    void anythingElseOnTheNewPathsHasNoPermissionMapping() {
        for (String[] route : new String[][] {
                {"GET", "/dev/v1/animations/renders"}, {"PUT", "/dev/v1/animations/renders"},
                {"DELETE", "/dev/v1/animations/renders/abc"}, {"POST", "/dev/v1/animations/renders/abc"},
                {"POST", "/dev/v1/animations/renders/"}, {"GET", "/dev/v1/animations/renders/a/b"},
                {"POST", "/dev/v1/animations/status"}, {"GET", "/dev/v1/animations"},
                {"GET", "/dev/v1/animations/"}, {"POST", "/dev/v1/animations/rendersx"}}) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission(route[0], route[1]))
                    .as(route[0] + " " + route[1]).isNull();
        }
    }
}
