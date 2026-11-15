package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** The J-19 DEV_ONLY quality routes are guarded by exact method and path, never by a prefix. */
class MediaDevOnlyQualityPermissionsTest {

    @Test
    void postsNeedProjectWriteAndReadsNeedProjectRead() {
        for (String[] write : new String[][] {{"POST", "/dev/v1/quality/optimizations"},
                {"POST", "/dev/v1/quality/optimizations/req-1/cancel"}, {"POST", "/dev/v1/quality/lineages/l-1/undo"}}) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission(write[0], write[1])).as(write[1])
                    .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_WRITE);
        }
        for (String read : new String[] {"/dev/v1/quality/status", "/dev/v1/quality/optimizations/abc",
                "/dev/v1/quality/lineages/abc"}) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", read)).as(read)
                    .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
        }
    }

    @Test
    void anythingElseOnTheNewPathsHasNoPermissionMapping() {
        for (String[] route : new String[][] {
                {"GET", "/dev/v1/quality/optimizations"}, {"PUT", "/dev/v1/quality/optimizations"},
                {"DELETE", "/dev/v1/quality/optimizations/abc"}, {"DELETE", "/dev/v1/quality/lineages/abc"},
                {"POST", "/dev/v1/quality/status"}, {"POST", "/dev/v1/quality/optimizations/abc"},
                {"GET", "/dev/v1/quality/optimizations/abc/cancel"}, {"GET", "/dev/v1/quality/lineages/abc/undo"},
                {"POST", "/dev/v1/quality/lineages/abc"}, {"POST", "/dev/v1/quality/lineages/a/b/undo"},
                {"GET", "/dev/v1/quality/lineages/a/b"}, {"POST", "/dev/v1/quality"}, {"POST", "/dev/v1/quality/optimizations/"}}) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission(route[0], route[1]))
                    .as(route[0] + " " + route[1]).isNull();
        }
    }
}
