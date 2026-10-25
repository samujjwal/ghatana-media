package com.ghatana.tts.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.config.TtsConfig;
import com.ghatana.media.tts.api.TtsEngine;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Map;
import java.util.HexFormat;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

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
        assertRejectedBeforeInitialization(Map.of(), IllegalStateException.class,
                "TTS_PROVIDER_NOT_ADMITTED");
    }

    @Test
    void syntheticFallbackIsRejectedForEveryRuntimeProfile() {
        assertThatThrownBy(() -> ProductionTtsGrpcService.createConfig(Map.of(
                        "MEDIA_RUNTIME_ENVIRONMENT", "local",
                        "MEDIA_TTS_ALLOW_SYNTHETIC_FALLBACK", "true")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Synthetic TTS fallback is forbidden");
    }

    @Test
    void completeLocalProfileVerifiesDigestButIsNotProviderAdmission() throws Exception {
        Path model = Files.createTempFile("tts-model", ".onnx");
        try {
            Files.writeString(model, "fixture model bytes");
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(Files.readAllBytes(model)));
            Map<String, String> environment = localProfile(model, digest);
            var profile = ProductionTtsGrpcService.resolveProviderProfile(environment);
            assertThat(profile.modelId()).isEqualTo("fixture-model");
            assertThat(profile.status()).isEqualTo("NOT_ADMITTED");
            assertThat(profile.reason()).contains("not source-admitted");
            assertThatThrownBy(() -> ProductionTtsGrpcService.createConfig(environment))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("TTS_PROVIDER_NOT_ADMITTED");
            assertRejectedBeforeInitialization(environment, IllegalStateException.class,
                    "TTS_PROVIDER_NOT_ADMITTED");
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
    void modelDigestMismatchFailsBeforeLibraryConstructionOrWarmup() throws Exception {
        Path model = Files.createTempFile("tts-model-mismatch", ".onnx");
        try {
            Files.writeString(model, "immutable fixture model bytes");
            Map<String, String> environment = localProfile(model, "0".repeat(64));
            assertRejectedBeforeInitialization(environment, IllegalArgumentException.class,
                    "does not match TTS_MODEL_SHA256");
        } finally {
            Files.deleteIfExists(model);
        }
    }

    @Test
    void unavailableModelFailsBeforeLibraryConstructionOrWarmup() {
        Path unavailable = Path.of(System.getProperty("java.io.tmpdir"),
                "missing-tts-model-" + java.util.UUID.randomUUID() + ".onnx");
        assertRejectedBeforeInitialization(localProfile(unavailable, "0".repeat(64)),
                IllegalStateException.class, "TTS_PROVIDER_NOT_ADMITTED");
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

    private static Map<String, String> localProfile(Path model, String digest) {
        return Map.of(
                "TTS_PROVIDER_MODE", "LOCAL_ONNX",
                "TTS_MODEL_PATH", model.toString(),
                "TTS_MODEL_ID", "fixture-model",
                "TTS_MODEL_VERSION", "fixture-version",
                "TTS_MODEL_SHA256", digest,
                "TTS_MODEL_LICENSE", "test-fixture-license-placeholder",
                "TTS_MODEL_LANGUAGE", "en-US",
                "TTS_MODEL_REGION", "test-fixture-region",
                "TTS_MODEL_RETENTION", "test-fixture-policy-placeholder",
                "TTS_MODEL_HARDWARE", "test-fixture-hardware-placeholder");
    }

    private static void assertRejectedBeforeInitialization(
            Map<String, String> environment,
            Class<? extends RuntimeException> expectedType,
            String reason) {
        AtomicInteger factoryCalls = new AtomicInteger();
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        TtsEngine engine = mock(TtsEngine.class);
        when(library.getTtsEngine()).thenReturn(engine);

        assertThatThrownBy(() -> ProductionTtsGrpcService.createInitializedLibrary(
                environment,
                (TtsConfig ignored) -> {
                    factoryCalls.incrementAndGet();
                    return library;
                }))
                .isInstanceOf(expectedType)
                .hasMessageContaining(reason);

        assertThat(factoryCalls).hasValue(0);
        verifyNoInteractions(library, engine);
    }
}
