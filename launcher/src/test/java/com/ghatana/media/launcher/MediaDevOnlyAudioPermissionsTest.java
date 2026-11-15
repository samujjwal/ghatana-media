package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** The J-07 DEV_ONLY audio routes are guarded by exact method and path, never by a prefix. */
class MediaDevOnlyAudioPermissionsTest {

    @Test
    void restoreAndCompareNeedProjectWriteAndReadsNeedProjectRead() {
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/audio/restorations"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_WRITE);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/audio/comparisons"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_WRITE);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/audio/status"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/audio/outputs/abc"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
    }

    @Test
    void anythingElseOnTheAudioPathsHasNoPermissionMapping() {
        for (String[] route : new String[][] {
                {"GET", "/dev/v1/audio/restorations"}, {"PUT", "/dev/v1/audio/restorations"},
                {"DELETE", "/dev/v1/audio/outputs/abc"}, {"POST", "/dev/v1/audio/outputs/abc"},
                {"POST", "/dev/v1/audio/restorations/"}, {"POST", "/dev/v1/audio/restorations/x"},
                {"GET", "/dev/v1/audio/comparisons"}, {"POST", "/dev/v1/audio/status"}}) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission(route[0], route[1]))
                    .as(route[0] + " " + route[1]).isNull();
        }
    }
}
