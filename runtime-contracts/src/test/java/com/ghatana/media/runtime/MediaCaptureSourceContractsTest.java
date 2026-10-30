package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaCaptureSourceContracts.AdapterEligibility;
import com.ghatana.media.runtime.MediaCaptureSourceContracts.CaptureRequest;
import com.ghatana.media.runtime.MediaCaptureSourceContracts.CaptureSourceKind;
import com.ghatana.media.runtime.MediaCaptureSourceContracts.Eligibility;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** H-04: capture eligibility contracts — admitted only via the trusted seam. */
class MediaCaptureSourceContractsTest {

    private static CaptureRequest request(CaptureSourceKind kind) {
        return new CaptureRequest(kind, "src-1", "purpose/v1", "src@v2", "secrets/1", "clock/30hz");
    }

    @Test
    void onlyAdmittedEligibilityPermitsCapture() {
        for (CaptureSourceKind kind : CaptureSourceKind.values()) {
            assertThat(MediaCaptureSourceContracts.mayCapture(
                    AdapterEligibility.none(), request(kind))).isFalse();
            assertThat(MediaCaptureSourceContracts.mayCapture(
                    r -> Eligibility.ADMITTED, request(kind))).isTrue();
            assertThat(MediaCaptureSourceContracts.mayCapture(
                    r -> Eligibility.UNAVAILABLE, request(kind))).isFalse();
        }
    }

    @Test
    void requestRequiresBoundedCanonicalFields() {
        for (CaptureSourceKind kind : CaptureSourceKind.values()) {
            assertThatThrownBy(() -> new CaptureRequest(
                    kind, " ", "p", "v", "s", "c"))
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }
}
