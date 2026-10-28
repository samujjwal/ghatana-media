package com.ghatana.tts.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
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
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.HexFormat;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

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
        Path model = createModelFile("tts-model");
        try {
            Files.writeString(model, "fixture model bytes");
            writeFixtureSidecar(model);
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
            deleteModelFixture(model);
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
            writeFixtureSidecar(model);
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(Files.readAllBytes(model)));
            String sidecarDigest = fixtureSidecarDigest(model);
            Map<String, String> environment = localProfile(model, digest);
            TtsProviderAdmission localFixtureResolver = candidate -> {
                assertThat(candidate.modelDigest()).isEqualTo(digest);
                assertThat(candidate.voiceSidecarDigest()).isEqualTo(sidecarDigest);
                assertThat(candidate.defaultVoiceId()).isEqualTo("piper-en");
                return new TtsProviderAdmission.Decision(
                        java.util.Set.of(TtsProviderAdmission.Capability.SYNTHESIS),
                        "local-fixture-resolver:test-only", "test fixture decision");
            };
            ProductionTtsGrpcService service = new ProductionTtsGrpcService(
                    environment, new SimpleMeterRegistry(), localFixtureResolver,
                    readyFixtureAuthorization(), config -> {
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
            deleteModelFixture(model);
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
    void malformedOrUndefinedLanguageCannotReachTrustedProviderAdmission() throws Exception {
        Path model = createModelFile("tts-model-invalid-language");
        try {
            Files.writeString(model, "fixture model bytes");
            writeFixtureSidecar(model);
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(Files.readAllBytes(model)));
            AtomicInteger resolverCalls = new AtomicInteger();
            TtsProviderAdmission resolver = candidate -> {
                resolverCalls.incrementAndGet();
                return new TtsProviderAdmission.Decision(
                        java.util.Set.of(TtsProviderAdmission.Capability.SYNTHESIS),
                        "local-fixture-resolver:test-only", "controlled fixture only");
            };

            for (String language : List.of("en_US", "en--US", "und", "und-US", "x-private")) {
                Map<String, String> environment = new java.util.HashMap<>(localProfile(model, digest));
                environment.put("TTS_MODEL_LANGUAGE", language);

                var profile = ProductionTtsGrpcService.resolveProviderProfile(environment, resolver);

                assertThat(profile.status()).as("language %s", language).isEqualTo("NOT_ADMITTED");
                assertThat(profile.reason()).contains("well-formed BCP 47");
            }
            assertThat(resolverCalls).hasValue(0);
        } finally {
            deleteModelFixture(model);
        }
    }

    @Test
    void modelDigestMismatchFailsBeforeLibraryConstructionOrWarmup() throws Exception {
        Path model = createModelFile("tts-model-mismatch");
        try {
            Files.writeString(model, "immutable fixture model bytes");
            writeFixtureSidecar(model);
            Map<String, String> environment = localProfile(model, "0".repeat(64));
            assertRejectedBeforeInitialization(environment, IllegalArgumentException.class,
                    "does not match TTS_MODEL_SHA256");
        } finally {
            deleteModelFixture(model);
        }
    }

    @Test
    void missingVoiceSidecarCannotReachTrustedProviderResolver() throws Exception {
        Path model = createModelFile("tts-model-without-voice-sidecar");
        try {
            Files.writeString(model, "fixture model bytes");
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(Files.readAllBytes(model)));
            Map<String, String> environment = localProfile(model, digest);
            Files.deleteIfExists(Path.of(model.toString() + ".json"));
            AtomicInteger resolverCalls = new AtomicInteger();

            var profile = ProductionTtsGrpcService.resolveProviderProfile(environment, candidate -> {
                resolverCalls.incrementAndGet();
                return new TtsProviderAdmission.Decision(java.util.Set.of(), null, "unexpected");
            });

            assertThat(profile.status()).isEqualTo("NOT_ADMITTED");
            assertThat(profile.reason()).contains("voice sidecar", "unavailable");
            assertThat(resolverCalls).hasValue(0);
        } finally {
            deleteModelFixture(model);
        }
    }

    @Test
    void sidecarReplacementDuringProviderInitializationPreventsServiceExposure() throws Exception {
        Path model = createModelFile("tts-model-sidecar-race");
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        TtsEngine engine = mock(TtsEngine.class);
        when(library.getTtsEngine()).thenReturn(engine);
        try {
            Files.writeString(model, "fixture model bytes");
            Map<String, String> environment = localProfile(model, HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(model))));
            var admission = (TtsProviderAdmission) candidate -> new TtsProviderAdmission.Decision(
                    java.util.Set.of(TtsProviderAdmission.Capability.SYNTHESIS),
                    "local-fixture-resolver:test-only", "controlled fixture only");

            assertThatThrownBy(() -> new ProductionTtsGrpcService(environment, new SimpleMeterRegistry(),
                    admission, config -> {
                        try {
                            Files.writeString(Path.of(config.voiceModelPath().toString() + ".json"),
                                    "{\"phoneme_id_map\":{\"^\":[9],\"$\":[8],\"_\":[7]}}\n");
                        } catch (java.io.IOException failure) {
                            throw new java.io.UncheckedIOException(failure);
                        }
                        return library;
                    }))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("TTS_MODEL_SNAPSHOT_CHANGED");
            org.mockito.Mockito.verify(library).close();
        } finally {
            deleteModelFixture(model);
        }
    }

    @Test
    void rejectsOversizedStagedModelBeforeWarmupAndCleansPrivateSnapshot() throws Exception {
        int maxBytes = 1024 * 1024;
        Path model = createModelFile("tts-model-staged-over-bound");
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        TtsEngine engine = mock(TtsEngine.class);
        AtomicReference<Path> stagedModel = new AtomicReference<>();
        when(library.getTtsEngine()).thenReturn(engine);
        try {
            Files.writeString(model, "small admitted fixture model");
            writeFixtureSidecar(model);
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(Files.readAllBytes(model)));
            Map<String, String> environment = new java.util.HashMap<>(localProfile(model, digest));
            environment.put("TTS_MAX_MEMORY_BYTES", Integer.toString(maxBytes));
            var admission = (TtsProviderAdmission) candidate -> new TtsProviderAdmission.Decision(
                    java.util.Set.of(TtsProviderAdmission.Capability.SYNTHESIS),
                    "local-fixture-resolver:test-only", "controlled fixture only");

            assertThatThrownBy(() -> new ProductionTtsGrpcService(
                    environment, new SimpleMeterRegistry(), admission, readyFixtureAuthorization(), config -> {
                        stagedModel.set(config.voiceModelPath());
                        try {
                            Files.write(config.voiceModelPath(), new byte[maxBytes + 1], StandardOpenOption.TRUNCATE_EXISTING);
                        } catch (java.io.IOException failure) {
                            throw new java.io.UncheckedIOException(failure);
                        }
                        return library;
                    }))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("TTS_MODEL_SNAPSHOT_CHANGED");

            assertThat(stagedModel.get()).isNotNull();
            assertThat(Files.exists(stagedModel.get(), java.nio.file.LinkOption.NOFOLLOW_LINKS)).isFalse();
            assertThat(Files.exists(stagedModel.get().getParent(), java.nio.file.LinkOption.NOFOLLOW_LINKS))
                    .isFalse();
            org.mockito.Mockito.verify(library).close();
            org.mockito.Mockito.verify(engine, org.mockito.Mockito.never()).warmup();
        } finally {
            deleteModelFixture(model);
        }
    }

    @Test
    void providerInitializationUsesPrivateModelAndSidecarSnapshotThenRemovesIt() throws Exception {
        Path model = createModelFile("tts-model-snapshot");
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        TtsEngine engine = mock(TtsEngine.class);
        AtomicReference<Path> stagedModel = new AtomicReference<>();
        AtomicReference<Path> stagedSidecar = new AtomicReference<>();
        String originalModel = "fixture model bytes copied into private snapshot";
        String originalSidecar = "{\"phoneme_id_map\":{\"^\":[1],\"$\":[2],\"_\":[0]}}\n";
        when(library.getTtsEngine()).thenReturn(engine);
        byte[] pcm = audiblePcmFixture();
        when(engine.synthesize(org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.any())).thenReturn(
                        new AudioData(pcm, 22_050, 1, 16, Duration.ofMillis(100), AudioFormat.PCM));
        try {
            Files.writeString(model, originalModel);
            writeFixtureSidecar(model);
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(Files.readAllBytes(model)));
            var admission = (TtsProviderAdmission) candidate -> new TtsProviderAdmission.Decision(
                    java.util.Set.of(TtsProviderAdmission.Capability.SYNTHESIS),
                    "local-fixture-resolver:test-only", "controlled fixture only");

            ProductionTtsGrpcService service = new ProductionTtsGrpcService(
                    localProfile(model, digest), new SimpleMeterRegistry(), admission,
                    readyFixtureAuthorization(), config -> {
                        try {
                            Path snapshotModel = config.voiceModelPath();
                            Path snapshotSidecar = Path.of(snapshotModel.toString() + ".json");
                            stagedModel.set(snapshotModel);
                            stagedSidecar.set(snapshotSidecar);
                            assertThat(snapshotModel).isNotEqualTo(model);
                            assertThat(Files.readString(snapshotModel)).isEqualTo(originalModel);
                            assertThat(Files.readString(snapshotSidecar)).isEqualTo(originalSidecar);
                            assertThat(Files.getPosixFilePermissions(snapshotModel.getParent()))
                                    .containsExactlyInAnyOrder(
                                            java.nio.file.attribute.PosixFilePermission.OWNER_READ,
                                            java.nio.file.attribute.PosixFilePermission.OWNER_WRITE,
                                            java.nio.file.attribute.PosixFilePermission.OWNER_EXECUTE);
                            assertThat(Files.getPosixFilePermissions(snapshotModel))
                                    .containsExactlyInAnyOrder(
                                            java.nio.file.attribute.PosixFilePermission.OWNER_READ,
                                            java.nio.file.attribute.PosixFilePermission.OWNER_WRITE);

                            // Source replacement after snapshot creation cannot alter the files passed to the engine.
                            Files.writeString(model, "mutated source model bytes");
                            Files.writeString(Path.of(model.toString() + ".json"), "mutated source sidecar");
                            assertThat(Files.readString(snapshotModel)).isEqualTo(originalModel);
                            assertThat(Files.readString(snapshotSidecar)).isEqualTo(originalSidecar);
                            return library;
                        } catch (java.io.IOException failure) {
                            throw new java.io.UncheckedIOException(failure);
                        }
                    });
            try {
                assertThat(stagedModel.get()).isNotNull();
                assertThat(Files.exists(stagedModel.get(), java.nio.file.LinkOption.NOFOLLOW_LINKS)).isFalse();
                assertThat(Files.exists(stagedSidecar.get(), java.nio.file.LinkOption.NOFOLLOW_LINKS)).isFalse();
                assertThat(Files.exists(stagedModel.get().getParent(), java.nio.file.LinkOption.NOFOLLOW_LINKS))
                        .isFalse();
                RecordingObserver<SynthesizeResponse> observer = new RecordingObserver<>();
                withVerifiedIdentity(() -> service.synthesize(
                        SynthesizeRequest.newBuilder()
                                .setText("snapshot remains loaded")
                                .setVoiceId("piper-en")
                                .setOptions(com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder()
                                        .setLanguage("en-US").build())
                                .build(),
                        observer));
                assertThat(observer.error.get()).isNull();
                assertThat(observer.value.get()).isNotNull();
                org.mockito.Mockito.verify(engine).synthesize(
                        org.mockito.ArgumentMatchers.eq("snapshot remains loaded"),
                        org.mockito.ArgumentMatchers.any());
            } finally {
                service.close();
            }
        } finally {
            deleteModelFixture(model);
        }
    }

    @Test
    void modelByteCeilingIsEnforcedBeforeHashingAndAllowsExactBoundary() throws Exception {
        int maxBytes = 1024 * 1024;
        Path exactModel = createModelFile("tts-model-exact-bound");
        Path oversizedModel = createModelFile("tts-model-over-bound");
        try {
            Files.write(exactModel, new byte[maxBytes]);
            Files.write(oversizedModel, new byte[maxBytes + 1]);
            Map<String, String> exactEnvironment = new java.util.HashMap<>(
                    localProfile(exactModel, HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                            .digest(Files.readAllBytes(exactModel)))));
            exactEnvironment.put("TTS_MAX_MEMORY_BYTES", Integer.toString(maxBytes));
            var exactProfile = ProductionTtsGrpcService.resolveProviderProfile(exactEnvironment);
            assertThat(exactProfile.modelDigest()).isEqualTo(exactEnvironment.get("TTS_MODEL_SHA256"));
            assertThat(exactProfile.status()).isEqualTo("NOT_ADMITTED");

            Map<String, String> oversizedEnvironment = new java.util.HashMap<>(
                    localProfile(oversizedModel, "0".repeat(64)));
            oversizedEnvironment.put("TTS_MAX_MEMORY_BYTES", Integer.toString(maxBytes));
            assertRejectedBeforeInitialization(oversizedEnvironment, IllegalArgumentException.class, "size bound");
        } finally {
            deleteModelFixture(exactModel);
            deleteModelFixture(oversizedModel);
        }
    }

    @Test
    void rejectsSourceReplacementBetweenAdmissionDigestAndPrivateSnapshotCreation() throws Exception {
        Path model = createModelFile("tts-model-snapshot-race");
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        TtsEngine engine = mock(TtsEngine.class);
        when(library.getTtsEngine()).thenReturn(engine);
        try {
            Files.writeString(model, "source bytes hashed before admission");
            writeFixtureSidecar(model);
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(Files.readAllBytes(model)));
            Map<String, String> environment = localProfile(model, digest);
            var replacingAdmission = (TtsProviderAdmission) candidate -> {
                try {
                    Files.writeString(model, "replaced after profile digest");
                } catch (java.io.IOException failure) {
                    throw new java.io.UncheckedIOException(failure);
                }
                return new TtsProviderAdmission.Decision(
                        java.util.Set.of(TtsProviderAdmission.Capability.SYNTHESIS),
                        "local-fixture-resolver:test-only", "controlled fixture only");
            };

            assertThatThrownBy(() -> new ProductionTtsGrpcService(
                    environment, new SimpleMeterRegistry(), replacingAdmission,
                    readyFixtureAuthorization(), ignored -> library))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("changed before private snapshotting");
            org.mockito.Mockito.verifyNoInteractions(library, engine);
        } finally {
            deleteModelFixture(model);
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
            writeFixtureSidecar(model);
            Files.createSymbolicLink(aliasDirectory, targetDirectory);
            Path aliasedModel = aliasDirectory.resolve("model.onnx");
            Map<String, String> environment = localProfile(aliasedModel, "0".repeat(64));

            var profile = ProductionTtsGrpcService.resolveProviderProfile(environment);
            assertThat(profile.status()).isEqualTo("NOT_ADMITTED");
            assertThat(profile.reason()).contains("absolute", "normalized", "non-symbolic", "provider asset");
            assertRejectedBeforeInitialization(environment, IllegalStateException.class,
                    "TTS_PROVIDER_NOT_ADMITTED");
        } finally {
            Files.deleteIfExists(aliasDirectory);
            deleteModelFixture(model);
            Files.deleteIfExists(targetDirectory);
            Files.deleteIfExists(root);
        }
    }

    @Test
    void rejectsSymlinkAliasToSystemTemporaryDirectoryOnMacAndLinux() throws Exception {
        // Exercise a real symlinked parent on either supported OS. The former
        // /tmp -> /private/tmp precondition skipped this protection on Linux.
        Path canonicalTemp = Path.of(System.getProperty("java.io.tmpdir")).toRealPath();
        Path model = Files.createTempFile(canonicalTemp, "tts-model-temp-alias-", ".onnx");
        Path workspace = Files.createTempDirectory(
                Path.of(".").toAbsolutePath().normalize(), "tts-system-temp-link-");
        Path alias = workspace.resolve("temporary-directory-alias");
        try {
            Files.writeString(model, "model bytes through a symlinked temporary parent");
            writeFixtureSidecar(model);
            Files.createSymbolicLink(alias, canonicalTemp);
            Path aliasedModel = alias.resolve(model.getFileName());
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(Files.readAllBytes(model)));
            var profile = ProductionTtsGrpcService.resolveProviderProfile(localProfile(aliasedModel, digest));
            assertThat(profile.status()).isEqualTo("NOT_ADMITTED");
            assertThat(profile.reason()).contains("absolute", "normalized", "non-symbolic", "provider asset");
        } finally {
            Files.deleteIfExists(alias);
            deleteModelFixture(model);
            Files.deleteIfExists(workspace);
        }
    }

    @Test
    void rejectsFileChangedDuringDigestBeforeLibraryConstructionOrWarmup() throws Exception {
        Path model = createModelFile("tts-model-changing");
        try {
            Files.writeString(model, "stable model bytes before verification");
            writeFixtureSidecar(model);
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
            deleteModelFixture(model);
        }
    }

    @Test
    void rejectsFileReplacementDuringDigestBeforeLibraryConstructionOrWarmup() throws Exception {
        Path model = createModelFile("tts-model-replaced");
        Path replacement = model.resolveSibling(model.getFileName() + ".replacement");
        try {
            Files.writeString(model, "original model bytes for hashing");
            Files.writeString(replacement, "replacement model bytes");
            writeFixtureSidecar(model);
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
            deleteModelFixture(model);
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

    private static TtsRequestAuthorization readyFixtureAuthorization() {
        return new TtsRequestAuthorization() {
            @Override
            public Decision authorize(Request request) {
                return Decision.ADMITTED;
            }

            @Override
            public boolean isReady() {
                return true;
            }
        };
    }

    private static Map<String, String> localProfile(Path model, String digest) {
        if (Files.isRegularFile(model, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
            writeFixtureSidecar(model);
        }
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

    private static void writeFixtureSidecar(Path model) {
        Path sidecar = Path.of(model.toString() + ".json");
        try {
            Files.writeString(sidecar, "{\"phoneme_id_map\":{\"^\":[1],\"$\":[2],\"_\":[0]}}\n");
        } catch (java.io.IOException failure) {
            throw new java.io.UncheckedIOException(failure);
        }
    }

    private static String fixtureSidecarDigest(Path model) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(Files.readAllBytes(Path.of(model.toString() + ".json"))));
    }

    private static void deleteModelFixture(Path model) throws java.io.IOException {
        Files.deleteIfExists(Path.of(model.toString() + ".json"));
        Files.deleteIfExists(model);
    }

    private static byte[] audiblePcmFixture() {
        byte[] pcm = new byte[2 * 2_205];
        for (int sample = 0; sample < pcm.length / 2; sample++) {
            short value = (short) (Math.sin(2.0 * Math.PI * 440.0 * sample / 22_050.0) * 8_000.0);
            pcm[sample * 2] = (byte) value;
            pcm[sample * 2 + 1] = (byte) (value >>> 8);
        }
        return pcm;
    }

    @SuppressWarnings("unchecked")
    private static void withVerifiedIdentity(Runnable action) throws ReflectiveOperationException {
        java.lang.reflect.Field identityKeyField =
                com.ghatana.audio.video.common.security.JwtServerInterceptor.class
                        .getDeclaredField("VERIFIED_IDENTITY");
        identityKeyField.setAccessible(true);
        io.grpc.Context.Key<com.ghatana.audio.video.common.security.JwtServerInterceptor.VerifiedIdentity> key =
                (io.grpc.Context.Key<com.ghatana.audio.video.common.security.JwtServerInterceptor.VerifiedIdentity>)
                        identityKeyField.get(null);
        io.grpc.Context context = io.grpc.Context.current().withValue(key,
                new com.ghatana.audio.video.common.security.JwtServerInterceptor.VerifiedIdentity(
                        "fixture-subject", "fixture-tenant"));
        io.grpc.Context previous = context.attach();
        try {
            action.run();
        } finally {
            context.detach(previous);
        }
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
