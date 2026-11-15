package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** The J-10 DEV_ONLY reference scene routes are guarded by exact method and path, never by a prefix. */
class MediaDevOnlyReferenceScenePermissionsTest {
    private static final String BASE = "/dev/v1/reference-scenes";

    @Test
    void postsNeedProjectWriteAndReadsNeedProjectRead() {
        for (String path : new String[] {BASE + "/reference-sets", BASE + "/runs", BASE + "/runs/abc/regenerations"}) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", path)).as(path)
                    .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_WRITE);
        }
        for (String path : new String[] {BASE + "/status", BASE + "/reference-sets/abc", BASE + "/runs/abc"}) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", path)).as(path)
                    .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
        }
    }

    @Test
    void anythingElseOnTheNewPathsHasNoPermissionMapping() {
        for (String[] route : new String[][] {
                {"GET", BASE + "/runs"}, {"GET", BASE + "/reference-sets"}, {"PUT", BASE + "/runs"},
                {"DELETE", BASE + "/runs/abc"}, {"DELETE", BASE + "/reference-sets/abc"}, {"POST", BASE + "/runs/abc"},
                {"GET", BASE + "/runs/abc/regenerations"}, {"POST", BASE + "/runs/"}, {"GET", BASE + "/runs/a/b"},
                {"POST", BASE + "/status"}, {"GET", BASE}, {"GET", BASE + "/"}, {"POST", BASE + "/runsx"}}) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission(route[0], route[1]))
                    .as(route[0] + " " + route[1]).isNull();
        }
    }
}
