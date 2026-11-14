package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** The J-05 DEV_ONLY vision routes are guarded by exact method and path, never by a prefix. */
class MediaDevOnlyVisionTrackingPermissionsTest {

    @Test
    void trackAndRoiRoutesNeedProjectWriteAndOutputsNeedProjectRead() {
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/vision/tracks"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_WRITE);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/vision/roi-analyses"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_WRITE);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/vision/outputs/abc"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
    }

    @Test
    void anythingElseOnTheNewPathsHasNoPermissionMapping() {
        for (String[] route : new String[][] {
                {"GET", "/dev/v1/vision/tracks"}, {"PUT", "/dev/v1/vision/tracks"}, {"DELETE", "/dev/v1/vision/tracks"},
                {"POST", "/dev/v1/vision/tracks/"}, {"POST", "/dev/v1/vision/tracks/extra"},
                {"GET", "/dev/v1/vision/roi-analyses"}, {"POST", "/dev/v1/vision/roi-analyses/x"},
                {"POST", "/dev/v1/vision/outputs/abc"}, {"POST", "/dev/v1/vision/trackz"}}) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission(route[0], route[1]))
                    .as(route[0] + " " + route[1]).isNull();
        }
    }
}
