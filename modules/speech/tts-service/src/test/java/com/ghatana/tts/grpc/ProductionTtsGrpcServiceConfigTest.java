package com.ghatana.tts.grpc;

import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Map;
import java.util.HexFormat;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * @doc.type class
 * @doc.purpose Verifies fail-closed production TTS environment configuration
 * @doc.layer product
 * @doc.pattern UnitTest
 */
class ProductionTtsGrpcServiceConfigTest {

    @Test
    void requiresExplicitProviderAndFailsClosedWhenNoProfileIsAdmitted() {
        assertThatThrownBy(() -> ProductionTtsGrpcService.createConfig(Map.of()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("TTS_PROVIDER_NOT_ADMITTED");
        assertThat(ProductionTtsGrpcService.resolveProviderProfile(Map.of()).status())
                .isEqualTo("NOT_ADMITTED");
    }

    @Test
    void completeLocalProfileVerifiesDigestButIsNotProviderAdmission() throws Exception {
        Path model = Files.createTempFile("tts-model", ".onnx");
        try {
            Files.writeString(model, "fixture model bytes");
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(Files.readAllBytes(model)));
            var profile = ProductionTtsGrpcService.resolveProviderProfile(Map.of(
                    "TTS_PROVIDER_MODE", "LOCAL_ONNX", "TTS_MODEL_PATH", model.toString(),
                    "TTS_MODEL_ID", "fixture", "TTS_MODEL_VERSION", "1",
                    "TTS_MODEL_SHA256", digest, "TTS_MODEL_LICENSE", "fixture-license",
                    "TTS_MODEL_LANGUAGE", "en-US", "TTS_MODEL_REGION", "local",
                    "TTS_MODEL_RETENTION", "none", "TTS_MODEL_HARDWARE", "cpu"));
            assertThat(profile.modelId()).isEqualTo("fixture");
            assertThat(profile.status()).isEqualTo("NOT_ADMITTED");
            assertThat(profile.reason()).contains("not source-admitted");
            assertThatThrownBy(() -> ProductionTtsGrpcService.createConfig(Map.of(
                    "TTS_PROVIDER_MODE", "LOCAL_ONNX", "TTS_MODEL_PATH", model.toString(),
                    "TTS_MODEL_ID", "fixture", "TTS_MODEL_VERSION", "1",
                    "TTS_MODEL_SHA256", digest, "TTS_MODEL_LICENSE", "fixture-license",
                    "TTS_MODEL_LANGUAGE", "en-US", "TTS_MODEL_REGION", "local",
                    "TTS_MODEL_RETENTION", "none", "TTS_MODEL_HARDWARE", "cpu")))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("TTS_PROVIDER_NOT_ADMITTED");
        } finally {
            Files.deleteIfExists(model);
        }
    }

    @Test
    void rejectsMissingAndMismatchedProviderMetadata() {
        assertThatThrownBy(() -> ProductionTtsGrpcService.resolveProviderProfile(Map.of(
                "TTS_PROVIDER_MODE", "LOCAL_ONNX")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("TTS_MODEL_ID");
    }

    @Test
    void validatesServerPort() {
        assertThat(TtsGrpcServer.parsePort(null)).isEqualTo(50052);
        assertThat(TtsGrpcServer.parsePort(" 51000 ")).isEqualTo(51000);
        assertThatThrownBy(() -> TtsGrpcServer.parsePort("0"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> TtsGrpcServer.parsePort("not-a-port"))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
