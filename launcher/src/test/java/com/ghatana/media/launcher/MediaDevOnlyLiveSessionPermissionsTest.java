package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** The J-29 live session routes are DEV_ONLY, owner-scoped and exactly enumerated; nothing else under the prefix is admitted. */
class MediaDevOnlyLiveSessionPermissionsTest {
    @Test
    void liveSessionRoutesMapToTheDevProjectPermissionsAndNothingElseIsAdmitted() {
        String read = MediaDevOnlyRoutePermissions.PROJECT_READ;
        String write = MediaDevOnlyRoutePermissions.PROJECT_WRITE;
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/live-sessions/status")).isEqualTo(read);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/live-sessions")).isEqualTo(write);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/live-sessions/ls-1")).isEqualTo(read);
        for (String action : new String[] {"frames", "eos", "abort"}) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/live-sessions/ls-1/" + action)).isEqualTo(write);
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/live-sessions/ls-1/" + action)).isNull();
        }
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("DELETE", "/dev/v1/live-sessions/ls-1")).isNull();
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("PUT", "/dev/v1/live-sessions")).isNull();
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/live-sessions/status")).isNull();
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/live-sessions/ls-1/restart")).isNull();
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/live-sessions/a/b")).isNull();
        assertThat(MediaDevLiveSessionRoutes.handles("/dev/v1/live-sessions/status")).isTrue();
        assertThat(MediaDevLiveSessionRoutes.handles("/dev/v1/live-sessionsX")).isFalse();
    }
}
