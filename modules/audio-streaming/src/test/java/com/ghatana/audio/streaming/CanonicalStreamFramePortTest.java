package com.ghatana.audio.streaming;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class CanonicalStreamFramePortTest {

    @Test
    void missingCanonicalAdapterFailsClosedWithoutAnAcknowledgement() {
        CanonicalStreamFramePort port = CanonicalStreamFramePort.notAdmitted(
                "purpose-bound canonical stream session is unavailable");

        assertThat(port.currentBinding("tenant-1", "stream-1", "principal-1"))
                .isEmpty();
        assertThat(port.offer(
                        binding(), new AudioStreamSession.DecodedFrame(0, 0L, new byte[] {1})))
                .isEqualTo(CanonicalStreamFramePort.Result.notAdmitted(
                        "purpose-bound canonical stream session is unavailable"));
    }

    @Test
    void bindingRequiresACompleteTrustedIdentityAndDurableCursor() {
        assertThat(new CanonicalStreamFramePort.Binding(
                        "stream-1", "tenant-1", "principal-1", "purpose-1", 1, 1, -1,
                        java.time.Instant.now().plusSeconds(30)))
                .satisfies(binding -> {
                    assertThat(binding.lastAcknowledgedSequence()).isEqualTo(-1);
                    assertThat(binding.sessionRevision()).isEqualTo(1);
                    assertThat(binding.storeVersion()).isEqualTo(1);
                });
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new CanonicalStreamFramePort.Binding(
                        "stream-1", "tenant-1", "principal-1", " ", 1, 1, -1,
                        java.time.Instant.now().plusSeconds(30)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private static CanonicalStreamFramePort.Binding binding() {
        return new CanonicalStreamFramePort.Binding(
                "stream-1", "tenant-1", "principal-1", "purpose-1", 1, 1, -1,
                java.time.Instant.now().plusSeconds(30));
    }
}
