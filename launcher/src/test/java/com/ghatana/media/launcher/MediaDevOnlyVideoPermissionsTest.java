package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** The J-08 DEV_ONLY video routes are guarded by exact method and path, never by a prefix. */
class MediaDevOnlyVideoPermissionsTest {

    @Test
    void postsNeedProjectWriteAndReadsNeedProjectRead() {
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/video/enhancements"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_WRITE);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/video/comparisons"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_WRITE);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/video/enhancements/abc"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/video/comparisons/abc"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
    }

    @Test
    void anythingElseOnTheNewPathsHasNoPermissionMapping() {
        for (String[] route : new String[][] {
                {"GET", "/dev/v1/video/enhancements"}, {"GET", "/dev/v1/video/comparisons"},
                {"PUT", "/dev/v1/video/enhancements"}, {"DELETE", "/dev/v1/video/comparisons/abc"},
                {"POST", "/dev/v1/video/enhancements/"}, {"POST", "/dev/v1/video/enhancements/abc"},
                {"POST", "/dev/v1/video/comparisons/abc"}, {"POST", "/dev/v1/video/comparisonz"},
                {"GET", "/dev/v1/video/enhancements/a/b"}, {"POST", "/dev/v1/video"}}) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission(route[0], route[1]))
                    .as(route[0] + " " + route[1]).isNull();
        }
    }
}
