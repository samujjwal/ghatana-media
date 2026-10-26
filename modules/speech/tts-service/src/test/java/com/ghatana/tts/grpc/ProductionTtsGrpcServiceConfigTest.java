package com.ghatana.tts.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.config.TtsConfig;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.tts.core.grpc.proto.AudioChunk;
import com.ghatana.tts.core.grpc.proto.SynthesizeRequest;
import com.ghatana.tts.core.grpc.proto.SynthesizeResponse;
import io.grpc.Status;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.StandardCopyOption;
import java.nio.channels.FileChannel;
import java.security.MessageDigest;
import java.util.List;
import java.util.Map;
import java.util.HexFormat;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
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
            assertThat(profile.reason()).contains("source-authoritative", "resolver");
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
    void oneFixtureAdmissionDecisionGatesReadinessSynthesisAndStreaming() throws Exception {
        Path model = createModelFile("tts-model-local-fixture-admission");
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        TtsEngine engine = mock(TtsEngine.class);
        AtomicReference<TtsConfig> configured = new AtomicReference<>();
        when(library.getTtsEngine()).thenReturn(engine);
        when(engine.getStatus()).thenReturn(new EngineStatus(
                EngineStatus.State.READY, "fixture", "v1", 1L, null));
        when(engine.synthesize(org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.any())).thenThrow(new com.ghatana.tts.engine.TtsSynthesisEngine.SynthesisException(
                "fixture invocation stopped before provider output",
                com.ghatana.tts.engine.TtsSynthesisEngine.FailureReason.NOT_ADMITTED));
        try {
            Files.writeString(model, "local fixture model bytes");
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(Files.readAllBytes(model)));
            Map<String, String> environment = localProfile(model, digest);
            TtsProviderAdmission localFixtureResolver = candidate -> {
                assertThat(candidate.modelDigest()).isEqualTo(digest);
                assertThat(candidate.defaultVoiceId()).isEqualTo("piper-en");
                return new TtsProviderAdmission.Decision(
                        java.util.Set.of(TtsProviderAdmission.Capability.SYNTHESIS),
                        "local-fixture-resolver:test-only", "test fixture decision");
            };
            ProductionTtsGrpcService service = new ProductionTtsGrpcService(
                    environment, new SimpleMeterRegistry(), localFixtureResolver, config -> {
                        configured.set(config);
                        return library;
                    });
            try {
                assertThat(configured.get()).isNotNull();
                assertThat(configured.get().enableStreaming()).isFalse();
                assertThat(service.isProviderReady()).isTrue();

                RecordingObserver<SynthesizeResponse> synthesis = new RecordingObserver<>();
                service.synthesize(SynthesizeRequest.newBuilder().setText("fixture request").build(), synthesis);
                assertThat(Status.fromThrowable(synthesis.error.get()).getCode()).isEqualTo(Status.Code.UNAUTHENTICATED);
                assertThat(synthesis.value.get()).isNull();
                org.mockito.Mockito.verify(engine, org.mockito.Mockito.never()).synthesize(
                        org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.any());
                org.mockito.Mockito.clearInvocations(library, engine);

                for (String language : List.of("en", "en-GB", "ne", "ne-NP", "hi", "hi-IN")) {
                    RecordingObserver<SynthesizeResponse> mismatchedLocale = new RecordingObserver<>();
                    service.synthesize(SynthesizeRequest.newBuilder().setText("locale fixture")
                            .setOptions(com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder()
                                    .setLanguage(language).build()).build(), mismatchedLocale);
                    assertThat(Status.fromThrowable(mismatchedLocale.error.get()).getCode())
                            .as("locale %s must not use the admitted en-US profile", language)
                            .isEqualTo(Status.Code.UNAVAILABLE);
                    assertThat(mismatchedLocale.value.get()).isNull();
                }
                // The only admitted profile is the exact configured default voice and en-US.
                assertThat(ProductionTtsGrpcService.matchesAdmittedProfile(
                        "piper-en", "en-US", "piper-ne", java.util.Locale.forLanguageTag("en-US"))).isFalse();
                assertThat(ProductionTtsGrpcService.matchesAdmittedProfile(
                        "piper-en", "en-US", "piper-en", java.util.Locale.forLanguageTag("ne-NP"))).isFalse();
                verifyNoInteractions(library, engine);

                RecordingObserver<AudioChunk> streaming = new RecordingObserver<>();
                service.streamSynthesize(SynthesizeRequest.newBuilder().setText("fixture stream").build(), streaming);
                assertThat(Status.fromThrowable(streaming.error.get()).getCode()).isEqualTo(Status.Code.UNAVAILABLE);
                org.mockito.Mockito.verify(engine, org.mockito.Mockito.never()).startStreaming(
                        org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.any(),
                        org.mockito.ArgumentMatchers.any());
            } finally {
                service.close();
            }
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

    private static final class RecordingObserver<T> implements StreamObserver<T> {
        private final AtomicReference<T> value = new AtomicReference<>();
        private final AtomicReference<Throwable> error = new AtomicReference<>();

        @Override public void onNext(T next) { value.set(next); }
        @Override public void onError(Throwable failure) { error.set(failure); }
        @Override public void onCompleted() { }
    }
}
