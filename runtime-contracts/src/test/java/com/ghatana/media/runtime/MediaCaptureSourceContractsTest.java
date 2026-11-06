package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaCaptureSourceContracts.AdapterEligibility;
import com.ghatana.media.runtime.MediaCaptureSourceContracts.AdapterProbe;
import com.ghatana.media.runtime.MediaCaptureSourceContracts.CaptureRequest;
import com.ghatana.media.runtime.MediaCaptureSourceContracts.CapturedBytes;
import com.ghatana.media.runtime.MediaCaptureSourceContracts.CaptureSourceKind;
import com.ghatana.media.runtime.MediaCaptureSourceContracts.Eligibility;
import com.ghatana.media.runtime.MediaCaptureSourceContracts.ProbeDisposition;
import com.ghatana.media.runtime.MediaCaptureSourceContracts.ProbeRequest;
import com.ghatana.media.runtime.MediaCaptureSourceContracts.ProbeResult;
import org.junit.jupiter.api.Test;

import java.util.AbstractList;
import java.util.Iterator;
import java.util.NoSuchElementException;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** H-04: capture eligibility contracts — admitted only via the trusted seam. */
class MediaCaptureSourceContractsTest {

    private static CaptureRequest request(CaptureSourceKind kind) {
        return new CaptureRequest(kind, "src-1", "purpose/v1", "rights/src-1/v1", "src@v2", "secrets/1", "clock/30hz");
    }

    private static CapturedBytes captured(
            String sourceIdentity,
            String purposeRef,
            String exactRightsScope,
            String sourceVersionRef,
            String frameClockRef) {
        return new CapturedBytes(sourceIdentity, purposeRef, exactRightsScope,
                sourceVersionRef, frameClockRef, new byte[]{1}, 1);
    }

    @Test
    void onlyAdmittedEligibilityPermitsCapture() {
        assertThat(CaptureSourceKind.values()).containsExactly(
                CaptureSourceKind.BROWSER,
                CaptureSourceKind.DESKTOP,
                CaptureSourceKind.MOBILE,
                CaptureSourceKind.TERMINAL,
                CaptureSourceKind.HTTP_API,
                CaptureSourceKind.GRPC_API,
                CaptureSourceKind.CAMERA,
                CaptureSourceKind.MEDIA_FILE);
        for (CaptureSourceKind kind : CaptureSourceKind.values()) {
            assertThat(AdapterEligibility.none().check(request(kind)))
                    .isEqualTo(Eligibility.NOT_ADMITTED);
            assertThat(MediaCaptureSourceContracts.mayCapture(
                    AdapterEligibility.none(), request(kind))).isFalse();
            assertThat(MediaCaptureSourceContracts.mayCapture(
                    r -> Eligibility.ADMITTED, request(kind))).isTrue();
            assertThat(MediaCaptureSourceContracts.mayCapture(
                    r -> Eligibility.UNAVAILABLE, request(kind))).isFalse();
            assertThat(MediaCaptureSourceContracts.mayCapture(r -> {
                throw new IllegalStateException("source=private credential=private");
            }, request(kind))).isFalse();
        }
    }

    @Test
    void captureProbeUsesSourceDefinedVariantsAndDefaultsToNotQualified() {
        ProbeRequest request = new ProbeRequest("tenant-1", "source-1", "profile-1",
                java.util.List.of("screen", "clock"), "policy/v1");
        assertThat(MediaCaptureSourceContracts.probe(AdapterProbe.none(), request).disposition())
                .isEqualTo(ProbeDisposition.NOT_QUALIFIED);
        for (ProbeDisposition disposition : ProbeDisposition.values()) {
            assertThat(MediaCaptureSourceContracts.probe(
                    candidate -> new ProbeResult(disposition), request).disposition())
                    .isEqualTo(disposition);
        }
    }

    @Test
    void captureProbeRequiresBoundedSourceDefinedFields() {
        assertThatThrownBy(() -> new ProbeRequest("tenant-1", "source-1", "profile-1",
                java.util.List.of(), "policy/v1")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ProbeRequest("tenant-1", "source-1", "profile-1",
                java.util.List.of(" "), "policy/v1")).isInstanceOf(IllegalArgumentException.class);
        ProbeRequest duplicated = new ProbeRequest("tenant-1", "source-1", "profile-1",
                java.util.List.of("screen", "clock", "screen"), "policy/v1");
        assertThat(duplicated.requestedSignals()).containsExactly("screen", "clock", "screen");
        assertThatThrownBy(() -> duplicated.requestedSignals().add("mutate"))
                .isInstanceOf(UnsupportedOperationException.class);
    }

    @Test
    void captureProbeRejectsUnderreportedSignalListAtObservedLimit() {
        AtomicInteger reads = new AtomicInteger();
        java.util.List<String> underreported = new AbstractList<>() {
            @Override public String get(int index) { throw new AssertionError("iterator should be used"); }
            @Override public int size() { return 1; }
            @Override public Iterator<String> iterator() {
                return new Iterator<>() {
                    private int index;
                    @Override public boolean hasNext() { return index < 100; }
                    @Override public String next() {
                        if (!hasNext()) throw new NoSuchElementException();
                        reads.incrementAndGet();
                        return "signal-" + index++;
                    }
                };
            }
        };

        assertThatThrownBy(() -> new ProbeRequest("tenant-1", "source-1", "profile-1",
                underreported, "policy/v1"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("requestedSignals must contain 1..32 entries");
        assertThat(reads).hasValue(32);
    }

    @Test
    void captureProbeFailureBecomesSanitizedUnavailableResult() {
        ProbeRequest request = new ProbeRequest("tenant-1", "source-1", "profile-1",
                java.util.List.of("screen"), "policy/v1");
        ProbeResult result = MediaCaptureSourceContracts.probe(candidate -> {
            throw new IllegalStateException("credential=do-not-leak");
        }, request);
        assertThat(result.disposition()).isEqualTo(ProbeDisposition.UNAVAILABLE);
    }

    @Test
    void requestRequiresBoundedCanonicalFields() {
        for (CaptureSourceKind kind : CaptureSourceKind.values()) {
            assertThatThrownBy(() -> new CaptureRequest(
                    kind, " ", "p", "rights", "v", "s", "c"))
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }
    @Test
    void captureBytesAreBoundedAndDoNotShareMutableArrays() {
        byte[] source = {1, 2};
        var frame = new CapturedBytes("src-1", "purpose/v1", "rights/src-1/v1", "src@v2", "clock/30hz", source, 1);
        assertThat(frame.isBoundTo(request(CaptureSourceKind.MEDIA_FILE))).isTrue();
        source[0] = 9;
        byte[] read = frame.bytes();
        assertThat(read).containsExactly(1, 2);
        read[1] = 9;
        assertThat(frame.bytes()).containsExactly(1, 2);
        assertThatThrownBy(() -> new CapturedBytes("src-1", "purpose", "rights", "version", "clock", new byte[0], 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new CapturedBytes("src-1", "purpose", "rights", "version", "clock", new byte[1], -1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new CapturedBytes(
                "src-1", "purpose", "rights", "version", "clock", new byte[1], 9_007_199_254_740_992L))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new CaptureRequest(CaptureSourceKind.CAMERA, " src-1", "p", "rights", "v", "s", "c"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new CaptureRequest(CaptureSourceKind.CAMERA, "src-1", "p", " ", "v", "s", "c"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void capturedOutputMustMatchEveryAuthorizedRequestBinding() {
        CaptureRequest request = request(CaptureSourceKind.MEDIA_FILE);

        assertThat(captured("other-source", "purpose/v1", "rights/src-1/v1", "src@v2", "clock/30hz")
                .isBoundTo(request)).isFalse();
        assertThat(captured("src-1", "purpose/other", "rights/src-1/v1", "src@v2", "clock/30hz")
                .isBoundTo(request)).isFalse();
        assertThat(captured("src-1", "purpose/v1", "rights/other", "src@v2", "clock/30hz")
                .isBoundTo(request)).isFalse();
        assertThat(captured("src-1", "purpose/v1", "rights/src-1/v1", "src@v3", "clock/30hz")
                .isBoundTo(request)).isFalse();
        assertThat(captured("src-1", "purpose/v1", "rights/src-1/v1", "src@v2", "clock/other")
                .isBoundTo(request)).isFalse();
    }

}
