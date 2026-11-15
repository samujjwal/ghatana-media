package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** The J-21 DEV_ONLY version-review read routes are guarded by exact method and path, never by a prefix. */
class MediaDevOnlyVersionedReviewPermissionsTest {

    @Test
    void readsNeedProjectReadAndWritesNeedProjectWrite() {
        for (String path : new String[] {"/dev/v1/reviews", "/dev/v1/reviews/c1", "/dev/v1/reviews/c1/versions",
                "/dev/v1/reviews/c1/content", "/dev/v1/review-lineages/l1"}) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", path)).as(path)
                    .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
        }
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/reviews"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_WRITE);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/reviews/c1/decisions"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_WRITE);
    }

    @Test
    void anythingElseOnTheNewPathsHasNoPermissionMapping() {
        for (String[] route : new String[][] {
                {"POST", "/dev/v1/reviews/c1/versions"}, {"POST", "/dev/v1/reviews/c1/content"},
                {"PUT", "/dev/v1/reviews/c1/content"}, {"DELETE", "/dev/v1/reviews/c1"},
                {"GET", "/dev/v1/reviews/c1/versions/x"}, {"GET", "/dev/v1/reviews/c1/content/x"},
                {"POST", "/dev/v1/review-lineages/l1"}, {"GET", "/dev/v1/review-lineages"},
                {"GET", "/dev/v1/review-lineages/a/b"}, {"GET", "/dev/v1/review-lineagesx/l1"},
                {"PUT", "/dev/v1/reviews"}}) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission(route[0], route[1]))
                    .as(route[0] + " " + route[1]).isNull();
        }
    }
}
