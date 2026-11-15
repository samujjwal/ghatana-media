package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** The J-25 read-only request-outcome route is guarded by exact method and path and only names known lanes. */
class MediaDevOnlyRequestOutcomePermissionsTest {

    @Test
    void outcomeLookupNeedsProjectReadAndNothingElseIsMapped() {
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/request-outcomes/speech.synthesize/agtool-abc"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
        for (String[] route : new String[][] {
                {"POST", "/dev/v1/request-outcomes/speech.synthesize/x"}, {"PUT", "/dev/v1/request-outcomes/a.b/x"},
                {"DELETE", "/dev/v1/request-outcomes/a.b/x"}, {"GET", "/dev/v1/request-outcomes/a.b"},
                {"GET", "/dev/v1/request-outcomes/a.b/x/y"}, {"GET", "/dev/v1/request-outcomes"}}) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission(route[0], route[1])).as(route[0] + " " + route[1]).isNull();
        }
    }

    @Test
    void onlyTheLedgerBackedModelLanesAreReadable() {
        assertThat(MediaDevRequestOutcomeRoutes.LANES).containsExactlyInAnyOrder("speech.transcribe", "speech.synthesize",
                "vision.analyze", "vision.ask", "vision.track", "vision.roi");
        assertThat(MediaDevRequestOutcomeRoutes.handles("/dev/v1/request-outcomes/speech.synthesize/x")).isTrue();
        assertThat(MediaDevRequestOutcomeRoutes.handles("/dev/v1/speech/outputs/x")).isFalse();
    }
}
