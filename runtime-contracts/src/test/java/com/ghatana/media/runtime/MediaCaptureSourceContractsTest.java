package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaCaptureSourceContracts.AdapterEligibility;
import com.ghatana.media.runtime.MediaCaptureSourceContracts.CaptureRequest;
import com.ghatana.media.runtime.MediaCaptureSourceContracts.CapturedBytes;
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
            assertThat(AdapterEligibility.none().check(request(kind)))
                    .isEqualTo(Eligibility.NOT_ADMITTED);
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
    @Test
    void captureBytesAreBoundedAndDoNotShareMutableArrays() {
        byte[] source = {1, 2};
        var frame = new CapturedBytes("src-1", "clock/30hz", source, 1);
        source[0] = 9;
        byte[] read = frame.bytes();
        assertThat(read).containsExactly(1, 2);
        read[1] = 9;
        assertThat(frame.bytes()).containsExactly(1, 2);
        assertThatThrownBy(() -> new CapturedBytes("src-1", "clock", new byte[0], 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new CapturedBytes("src-1", "clock", new byte[1], -1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new CapturedBytes("src-1", "clock", new byte[1], 9_007_199_254_740_992L))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new CaptureRequest(CaptureSourceKind.CAMERA, " src-1", "p", "v", "s", "c"))
                .isInstanceOf(IllegalArgumentException.class);
    }

}
