package com.ghatana.tts.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.config.TtsConfig;
import com.ghatana.media.tts.api.TtsEngine;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.StandardCopyOption;
import java.nio.channels.FileChannel;
import java.security.MessageDigest;
import java.util.Map;
import java.util.HexFormat;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
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
        Path model = createModelFile("tts-model");
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
    void incompleteProviderProfileRemainsNotAdmittedBeforeInitialization() {
        Map<String, String> incomplete = Map.of("TTS_PROVIDER_MODE", "LOCAL_ONNX");
        var profile = ProductionTtsGrpcService.resolveProviderProfile(incomplete);
        assertThat(profile.status()).isEqualTo("NOT_ADMITTED");
        assertThat(profile.reason()).contains("TTS_MODEL_ID", "TTS_MODEL_LICENSE", "TTS_MODEL_PATH");
        assertRejectedBeforeInitialization(incomplete, IllegalStateException.class,
                "TTS_PROVIDER_NOT_ADMITTED");
    }

    @Test
    void modelDigestMismatchFailsBeforeLibraryConstructionOrWarmup() throws Exception {
        Path model = createModelFile("tts-model-mismatch");
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
    void rejectsModelPathWithSymlinkedParentBeforeLibraryConstructionOrWarmup() throws Exception {
        Path root = Files.createTempDirectory(Path.of(".").toAbsolutePath().normalize(), "tts-model-link");
        Path targetDirectory = Files.createDirectory(root.resolve("target"));
        Path model = targetDirectory.resolve("model.onnx");
        Path aliasDirectory = root.resolve("alias");
        try {
            Files.writeString(model, "model bytes behind a directory alias");
            Files.createSymbolicLink(aliasDirectory, targetDirectory);
            Path aliasedModel = aliasDirectory.resolve("model.onnx");
            Map<String, String> environment = localProfile(aliasedModel, "0".repeat(64));

            var profile = ProductionTtsGrpcService.resolveProviderProfile(environment);
            assertThat(profile.status()).isEqualTo("NOT_ADMITTED");
            assertThat(profile.reason()).contains("unavailable", "regular readable file");
            assertRejectedBeforeInitialization(environment, IllegalStateException.class,
                    "TTS_PROVIDER_NOT_ADMITTED");
        } finally {
            Files.deleteIfExists(aliasDirectory);
            Files.deleteIfExists(model);
            Files.deleteIfExists(targetDirectory);
            Files.deleteIfExists(root);
        }
    }

    @Test
    void permitsOnlyCanonicalMacOsTmpSystemAlias() throws Exception {
        Path tmpAlias = Path.of("/tmp");
        assumeTrue(Files.isSymbolicLink(tmpAlias)
                && tmpAlias.toRealPath().equals(Path.of("/private/tmp")));
        Path model = Files.createTempFile(tmpAlias, "tts-model-canonical-tmp", ".onnx");
        try {
            Files.writeString(model, "model bytes through the canonical system alias");
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(Files.readAllBytes(model)));
            var profile = ProductionTtsGrpcService.resolveProviderProfile(localProfile(model, digest));
            assertThat(profile.modelId()).isEqualTo("fixture-model");
            assertThat(profile.status()).isEqualTo("NOT_ADMITTED");
        } finally {
            Files.deleteIfExists(model);
        }
    }

    @Test
    void rejectsFileChangedDuringDigestBeforeLibraryConstructionOrWarmup() throws Exception {
        Path model = createModelFile("tts-model-changing");
        try {
            Files.writeString(model, "stable model bytes before verification");
            Map<String, String> environment = localProfile(model, "0".repeat(64));
            assertRejectedBeforeInitialization(environment, IllegalArgumentException.class,
                    "changed during digest verification", channel -> {
                        try {
                            Files.writeString(model, "changed model content", StandardOpenOption.WRITE,
                                    StandardOpenOption.TRUNCATE_EXISTING);
                        } catch (java.io.IOException exception) {
                            throw new java.io.UncheckedIOException(exception);
                        }
                    });
        } finally {
            Files.deleteIfExists(model);
        }
    }

    @Test
    void rejectsFileReplacementDuringDigestBeforeLibraryConstructionOrWarmup() throws Exception {
        Path model = createModelFile("tts-model-replaced");
        Path replacement = model.resolveSibling(model.getFileName() + ".replacement");
        try {
            Files.writeString(model, "original model bytes for hashing");
            Files.writeString(replacement, "replacement model bytes");
            Map<String, String> environment = localProfile(model, "0".repeat(64));
            assertRejectedBeforeInitialization(environment, IllegalArgumentException.class,
                    "changed during digest verification", ignored -> {
                        try {
                            Files.move(replacement, model, StandardCopyOption.REPLACE_EXISTING);
                        } catch (java.io.IOException exception) {
                            throw new java.io.UncheckedIOException(exception);
                        }
                    });
        } finally {
            Files.deleteIfExists(replacement);
            Files.deleteIfExists(model);
        }
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

    private static Path createModelFile(String prefix) throws java.io.IOException {
        return Files.createTempFile(Path.of(".").toAbsolutePath().normalize(), prefix, ".onnx");
    }

    private static void assertRejectedBeforeInitialization(
            Map<String, String> environment,
            Class<? extends RuntimeException> expectedType,
            String reason) {
        assertRejectedBeforeInitialization(environment, expectedType, reason, ignored -> {});
    }

    private static void assertRejectedBeforeInitialization(
            Map<String, String> environment,
            Class<? extends RuntimeException> expectedType,
            String reason,
            Consumer<FileChannel> beforeModelHash) {
        AtomicInteger factoryCalls = new AtomicInteger();
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        TtsEngine engine = mock(TtsEngine.class);
        when(library.getTtsEngine()).thenReturn(engine);

        assertThatThrownBy(() -> ProductionTtsGrpcService.createInitializedLibrary(
                environment,
                (TtsConfig ignored) -> {
                    factoryCalls.incrementAndGet();
                    return library;
                },
                beforeModelHash))
                .isInstanceOf(expectedType)
                .hasMessageContaining(reason);

        assertThat(factoryCalls).hasValue(0);
        verifyNoInteractions(library, engine);
    }
}
