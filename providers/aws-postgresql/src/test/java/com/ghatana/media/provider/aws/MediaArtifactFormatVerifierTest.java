package com.ghatana.media.provider.aws;

import org.junit.jupiter.api.Test;
import java.nio.charset.StandardCharsets;
import static org.assertj.core.api.Assertions.assertThat;

class MediaArtifactFormatVerifierTest {
    @Test
        void acceptsMatchingCommonMediaHeaders() {
            assertThat(MediaArtifactFormatVerifier.matches("audio/wav", bytes("RIFFxxxxWAVE"))).isTrue();
            assertThat(MediaArtifactFormatVerifier.matches("video/mp4", bytes("xxxxftypisom"))).isTrue();
            assertThat(MediaArtifactFormatVerifier.matches("image/png", new byte[]{(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10})).isTrue();
        }

    @Test
        void rejectsMimeContainerMismatchAndUnsupportedTypes() {
            assertThat(MediaArtifactFormatVerifier.matches("audio/wav", bytes("not a wave"))).isFalse();
            assertThat(MediaArtifactFormatVerifier.matches("application/pdf", bytes("%PDF-"))).isFalse();
            assertThat(MediaArtifactFormatVerifier.matches("image/jpeg", new byte[]{1, 2, 3})).isFalse();
        }

    @Test
        void rejectsKnownExtensionAndMimeSpoofing() {
            var mismatch = MediaArtifactFormatVerifier.verify(
                    "photo.png", "image/png", "MZ executable".getBytes(StandardCharsets.US_ASCII));
            assertThat(mismatch.state()).isEqualTo("SIGNATURE_MISMATCH");
            assertThat(mismatch.detectedFormat()).isEqualTo("unknown");
        }

    @Test
        void rejectsConflictingKnownExtensionAndMimeClaims() {
            var mismatch = MediaArtifactFormatVerifier.verify(
                    "photo.png", "video/mp4", new byte[] {0, 0, 0, 8, 'f', 't', 'y', 'p'});
            assertThat(mismatch.state()).isEqualTo("SIGNATURE_MISMATCH");
            assertThat(mismatch.detail()).contains("claims conflict");
        }

    @Test
        void recordsUnknownOpaqueInputsWithoutCallingThemVerified() {
            var unrecognized = MediaArtifactFormatVerifier.verify(
                    "capture.bin", "application/octet-stream", "opaque".getBytes(StandardCharsets.US_ASCII));
            assertThat(unrecognized.state()).isEqualTo("SIGNATURE_UNRECOGNIZED");
            assertThat(unrecognized.detectedFormat()).isEqualTo("unknown");
        }

    @Test
        void acceptsARecognizedSignatureOnlyAsAConsistencyCheck() {
            var match = MediaArtifactFormatVerifier.verify(
                    "photo.png", "image/png", new byte[] {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10});
            assertThat(match.state()).isEqualTo("SIGNATURE_MATCH");
            assertThat(match.detectedFormat()).isEqualTo("png");
        }
    private static byte[] bytes(String value) {
        return value.getBytes(StandardCharsets.ISO_8859_1);
    }
}
