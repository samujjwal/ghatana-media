package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** Confirms PXD-232 candidate route identities retain their source-enforced base permission. */
class MediaDevOnlyCandidateRoutePermissionsTest {
    @Test
    void sevenCandidateRoutesUseTheirExactBasePermission() {
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission(
                "POST", "/dev/v1/projects/project-a/renders"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_WRITE);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission(
                "GET", "/dev/v1/projects/project-a/renders/render-a"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/exports"))
                .isEqualTo(MediaDevOnlyRoutePermissions.DELIVERY_EXPORT);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/exports/request-a"))
                .isEqualTo(MediaDevOnlyRoutePermissions.DELIVERY_READ);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission(
                "POST", "/dev/v1/jobs/job-a/cancel"))
                .isEqualTo(MediaDevOnlyRoutePermissions.JOB_CANCEL);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission(
                "GET", "/dev/v1/simulations/simulation-a"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission(
                "GET", "/dev/v1/creative-outputs/output-a"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
    }

    @Test
    void candidatePermissionPatternsDoNotAcceptSiblingOrWrongMethodRoutes() {
        for (String[] route : new String[][] {
                {"GET", "/dev/v1/projects/project-a/renders"},
                {"POST", "/dev/v1/projects/project-a/renders/render-a"},
                {"GET", "/dev/v1/exports"},
                {"POST", "/dev/v1/exports/request-a"},
                {"GET", "/dev/v1/jobs/job-a/cancel"},
                {"POST", "/dev/v1/simulations/simulation-a"},
                {"POST", "/dev/v1/creative-outputs/output-a"}}) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission(route[0], route[1]))
                    .as(route[0] + " " + route[1]).isNull();
        }
    }
}
