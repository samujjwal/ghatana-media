package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** The J-11 DEV_ONLY region edit routes are guarded by exact method and path, never by a prefix. */
class MediaDevOnlyRegionEditPermissionsTest {

    @Test
    void writesNeedProjectWriteAndReadsNeedProjectRead() {
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/region-edits/lineages"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_WRITE);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/region-edits/lineages/l1/edits"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_WRITE);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/region-edits/lineages/l1/undo"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_WRITE);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/region-edits/lineages/l1"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/region-edits/status"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
    }

    @Test
    void anythingElseOnTheNewPathsHasNoPermissionMapping() {
        for (String[] route : new String[][] {
                {"GET", "/dev/v1/region-edits/lineages"}, {"PUT", "/dev/v1/region-edits/lineages"},
                {"DELETE", "/dev/v1/region-edits/lineages/l1"}, {"POST", "/dev/v1/region-edits/lineages/l1"},
                {"GET", "/dev/v1/region-edits/lineages/l1/edits"}, {"GET", "/dev/v1/region-edits/lineages/l1/undo"},
                {"POST", "/dev/v1/region-edits/lineages/l1/redo"}, {"POST", "/dev/v1/region-edits/lineages/a/b/edits"},
                {"POST", "/dev/v1/region-edits/status"}, {"GET", "/dev/v1/region-edits"}, {"GET", "/dev/v1/region-edits/"},
                {"POST", "/dev/v1/region-edits/lineagesx"}}) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission(route[0], route[1]))
                    .as(route[0] + " " + route[1]).isNull();
        }
    }
}
