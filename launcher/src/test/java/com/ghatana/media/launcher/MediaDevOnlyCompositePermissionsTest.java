package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** The J-18 DEV_ONLY composite render routes are guarded by exact method and path, never by a prefix. */
class MediaDevOnlyCompositePermissionsTest {

    @Test
    void postsNeedProjectWriteAndReadsNeedProjectRead() {
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/composite-renders"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_WRITE);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/composite-renders/req-1/cancel"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_WRITE);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/composite-renders/abc"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/composite-renders/capabilities"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
    }

    @Test
    void anythingElseOnTheNewPathsHasNoPermissionMapping() {
        for (String[] route : new String[][] {
                {"GET", "/dev/v1/composite-renders"}, {"PUT", "/dev/v1/composite-renders"}, {"DELETE", "/dev/v1/composite-renders/abc"},
                {"POST", "/dev/v1/composite-renders/abc"}, {"POST", "/dev/v1/composite-renders/"}, {"GET", "/dev/v1/composite-renders/a/b"},
                {"GET", "/dev/v1/composite-renders/abc/cancel"}, {"POST", "/dev/v1/composite-renders/capabilities"},
                {"POST", "/dev/v1/composite-renders/a/b/cancel"}, {"POST", "/dev/v1/composite-rendersx"}}) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission(route[0], route[1])).as(route[0] + " " + route[1]).isNull();
        }
    }
}
