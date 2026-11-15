package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** The J-09 DEV_ONLY storyboard routes are guarded by exact method and path, never by a prefix. */
class MediaDevOnlyStoryboardPermissionsTest {

    @Test
    void readsNeedProjectReadAndWritesNeedProjectWrite() {
        for (String path : new String[] {"/dev/v1/storyboards/capabilities", "/dev/v1/storyboards/sb-1",
                "/dev/v1/storyboards/sb-1/versions", "/dev/v1/storyboards/sb-1/readiness",
                "/dev/v1/storyboards/sb-1/versions/2", "/dev/v1/storyboards/sb-1/versions/2/render",
                "/dev/v1/storyboards/sb-1/versions/2/review"}) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", path)).as("GET " + path)
                    .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
        }
        for (String path : new String[] {"/dev/v1/storyboards", "/dev/v1/storyboards/sb-1/versions",
                "/dev/v1/storyboards/sb-1/renders", "/dev/v1/storyboards/sb-1/versions/2/review"}) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", path)).as("POST " + path)
                    .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_WRITE);
        }
    }

    @Test
    void anythingElseOnTheNewPathsHasNoPermissionMapping() {
        for (String[] route : new String[][] {
                {"GET", "/dev/v1/storyboards"}, {"PUT", "/dev/v1/storyboards/sb-1"}, {"DELETE", "/dev/v1/storyboards/sb-1"},
                {"POST", "/dev/v1/storyboards/sb-1"}, {"POST", "/dev/v1/storyboards/sb-1/readiness"},
                {"POST", "/dev/v1/storyboards/capabilities"}, {"GET", "/dev/v1/storyboards/sb-1/renders"},
                {"POST", "/dev/v1/storyboards/sb-1/versions/2"}, {"POST", "/dev/v1/storyboards/sb-1/versions/2/render"},
                {"GET", "/dev/v1/storyboards/sb-1/versions/x"}, {"GET", "/dev/v1/storyboards/a/b/c/d"},
                {"POST", "/dev/v1/storyboardsx"}, {"GET", "/dev/v1/storyboards/sb-1/versions/2/review/extra"}}) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission(route[0], route[1])).as(route[0] + " " + route[1]).isNull();
        }
    }
}
