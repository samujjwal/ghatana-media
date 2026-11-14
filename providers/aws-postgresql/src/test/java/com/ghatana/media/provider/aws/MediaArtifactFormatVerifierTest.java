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
    @Test
        void acceptsGlbOnlyWithGltfMagicAndVersionTwo() {
            byte[] glb = {'g', 'l', 'T', 'F', 2, 0, 0, 0, 12, 0, 0, 0};
            assertThat(MediaArtifactFormatVerifier.matches("model/gltf-binary", glb)).isTrue();
            assertThat(MediaArtifactFormatVerifier.verify("rig.glb", "model/gltf-binary", glb).state())
                    .isEqualTo("SIGNATURE_MATCH");
            byte[] versionOne = {'g', 'l', 'T', 'F', 1, 0, 0, 0, 12, 0, 0, 0};
            assertThat(MediaArtifactFormatVerifier.matches("model/gltf-binary", versionOne)).isFalse();
            assertThat(MediaArtifactFormatVerifier.matches("model/gltf-binary", bytes("RIFFxxxxWAVE"))).isFalse();
            assertThat(MediaArtifactFormatVerifier.verify("rig.glb", "model/gltf-binary", bytes("RIFFxxxxWAVE")).state())
                    .isEqualTo("SIGNATURE_MISMATCH");
            assertThat(MediaArtifactFormatVerifier.verify("rig.glb", "audio/wav", glb).state())
                    .isEqualTo("SIGNATURE_MISMATCH");
        }

    @Test
    void acceptsJsonOnlyWhenItStartsAsAnObjectOrArrayOfValidUtf8() {
        byte[] document = bytes("{\"outputKind\":\"SIMULATED_OUTPUT_NOT_MEASUREMENT\"}");
        assertThat(MediaArtifactFormatVerifier.matches("application/json", document)).isTrue();
        assertThat(MediaArtifactFormatVerifier.matches("application/json", bytes(" \n[1,2]"))).isTrue();
        assertThat(MediaArtifactFormatVerifier.verify("sim.json", "application/json", document).state())
                .isEqualTo("SIGNATURE_MATCH");
        assertThat(MediaArtifactFormatVerifier.verify("sim.bin", "application/json", document).state())
                .isEqualTo("SIGNATURE_MATCH");
        assertThat(MediaArtifactFormatVerifier.matches("application/json", bytes("not json"))).isFalse();
        assertThat(MediaArtifactFormatVerifier.matches("application/json", new byte[] {'{', 0, '}'})).isFalse();
        assertThat(MediaArtifactFormatVerifier.matches("application/json", bytes("RIFFxxxxWAVE"))).isFalse();
        assertThat(MediaArtifactFormatVerifier.verify("sim.json", "application/json", bytes("RIFFxxxxWAVE")).state())
                .isEqualTo("SIGNATURE_MISMATCH");
        assertThat(MediaArtifactFormatVerifier.verify("clip.wav", "audio/wav", document).state())
                .isEqualTo("SIGNATURE_MISMATCH");
    }

    @Test
    void acceptsWebVttOnlyWithSignatureAndValidUtf8WithoutNul() {
        byte[] vtt = bytes("WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n");
        assertThat(MediaArtifactFormatVerifier.matches("text/vtt", vtt)).isTrue();
        assertThat(MediaArtifactFormatVerifier.matches("text/vtt; charset=utf-8", vtt)).isTrue();
        assertThat(MediaArtifactFormatVerifier.verify("cues.vtt", "text/vtt", vtt).state()).isEqualTo("SIGNATURE_MATCH");
        assertThat(MediaArtifactFormatVerifier.verify("cues.bin", "text/vtt", vtt).state()).isEqualTo("SIGNATURE_MATCH");
        assertThat(MediaArtifactFormatVerifier.verify("cues.vtt", "text/vtt", vtt).detectedFormat()).isEqualTo("webvtt");
        byte[] bom = new byte[] {(byte) 0xef, (byte) 0xbb, (byte) 0xbf, 'W', 'E', 'B', 'V', 'T', 'T', '\n'};
        assertThat(MediaArtifactFormatVerifier.matches("text/vtt", bom)).isTrue();
        assertThat(MediaArtifactFormatVerifier.matches("text/vtt", bytes("WEBVTT"))).isTrue();
        assertThat(MediaArtifactFormatVerifier.matches("text/vtt", bytes("WEBVTT - title\n"))).isTrue();
        // Multi-byte text is accepted; a prefix cut mid-sequence is tolerated by the prefix check only.
        byte[] utf8 = "WEBVTT\n\n00:00.000 --> 00:01.000\ncaf\u00e9\n".getBytes(StandardCharsets.UTF_8);
        assertThat(MediaArtifactFormatVerifier.matches("text/vtt", utf8)).isTrue();
        byte[] cut = java.util.Arrays.copyOf(utf8, utf8.length - 2);
        assertThat(MediaArtifactFormatVerifier.verify("cues.vtt", "text/vtt", cut).state()).isEqualTo("SIGNATURE_MATCH");
        assertThat(MediaArtifactFormatVerifier.matches("text/vtt", cut)).isFalse();
    }

    @Test
    void rejectsWebVttWithoutSignatureWithNulOrInvalidUtf8() {
        assertThat(MediaArtifactFormatVerifier.matches("text/vtt", bytes("hello"))).isFalse();
        assertThat(MediaArtifactFormatVerifier.matches("text/vtt", bytes("WEBVTTX\n"))).isFalse();
        assertThat(MediaArtifactFormatVerifier.matches("text/vtt", bytes("webvtt\n"))).isFalse();
        assertThat(MediaArtifactFormatVerifier.matches("text/vtt", bytes("\nWEBVTT\n"))).isFalse();
        assertThat(MediaArtifactFormatVerifier.matches("text/vtt", new byte[] {'W', 'E', 'B', 'V', 'T', 'T', '\n', 0})).isFalse();
        assertThat(MediaArtifactFormatVerifier.matches("text/vtt", new byte[] {'W', 'E', 'B', 'V', 'T', 'T', '\n', (byte) 0xff})).isFalse();
        assertThat(MediaArtifactFormatVerifier.matches("text/vtt", bytes("RIFFxxxxWAVE"))).isFalse();
        assertThat(MediaArtifactFormatVerifier.verify("cues.vtt", "text/vtt", bytes("RIFFxxxxWAVE")).state())
                .isEqualTo("SIGNATURE_MISMATCH");
        assertThat(MediaArtifactFormatVerifier.verify("cues.vtt", "text/vtt",
                new byte[] {'W', 'E', 'B', 'V', 'T', 'T', '\n', 0}).state()).isEqualTo("SIGNATURE_MISMATCH");
        assertThat(MediaArtifactFormatVerifier.verify("cues.vtt", "audio/wav", bytes("WEBVTT\n")).state())
                .isEqualTo("SIGNATURE_MISMATCH");
        assertThat(MediaArtifactFormatVerifier.verify("cues.vtt", "application/json", bytes("WEBVTT\n")).state())
                .isEqualTo("SIGNATURE_MISMATCH");
    }

    private static byte[] bytes(String value) {
        return value.getBytes(StandardCharsets.ISO_8859_1);
    }
}
