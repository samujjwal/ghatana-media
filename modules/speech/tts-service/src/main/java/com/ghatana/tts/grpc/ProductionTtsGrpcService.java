package com.ghatana.tts.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.config.TtsConfig;
import com.ghatana.media.runtime.MediaDeploymentProfiles;
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.media.tts.engine.onnx.PiperOnnxEngine;
import io.micrometer.core.instrument.MeterRegistry;

import java.nio.file.Path;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.StandardOpenOption;
import java.nio.channels.FileChannel;
import java.nio.ByteBuffer;
import java.nio.file.attribute.FileAttribute;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.io.IOException;
import java.util.EnumSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Consumer;
import java.util.function.Function;

/**
 * Production composition for {@link TtsGrpcService}.
 *
 * <p>Provider admission is checked before an embedded engine is constructed or warmed. Production
 * uses the unavailable resolver until a source-authoritative provider and voice resolver is wired;
 * test composition can inject an explicitly local fixture resolver. Synthetic fallback is never a
 * production synthesis path. Production-like profiles also require durable profile storage.
 *
 * @doc.type class
 * @doc.purpose Fail-closed TTS gRPC composition and owned library lifecycle
 * @doc.layer product
 * @doc.pattern CompositionRoot
 */
public final class ProductionTtsGrpcService extends TtsGrpcService implements AutoCloseable {

    private static final long DEFAULT_TTS_MAX_MEMORY_BYTES = 256L * 1024 * 1024;
    private static final long MAX_TTS_MODEL_BYTES = 4L * 1024 * 1024 * 1024;

    record ProviderProfile(
            String modelId, String modelVersion, String modelDigest, String voiceSidecarDigest, String license,
            String language, String region, String retention, String hardware,
            String status, String reason, TtsProviderAdmission.Decision admission) {}

    private record RuntimeConfiguration(
            TtsConfig config, TtsProviderAdmission.Decision admission, String language,
            ModelSnapshot modelSnapshot) {}
    private record InitializedRuntime(
            AudioVideoLibrary library, TtsProviderAdmission.Decision admission,
            String voiceId, String language) {}
    private record RuntimeAdmission(
            AudioVideoLibrary library, TtsProviderAdmission.Decision admission,
            boolean compatiblePiperPhonemizer) {
        private static RuntimeAdmission capture(
                AudioVideoLibrary library, TtsProviderAdmission.Decision admission) {
            Objects.requireNonNull(library, "library");
            Objects.requireNonNull(admission, "admission");
            boolean admitted = admission.allows(TtsProviderAdmission.Capability.SYNTHESIS)
                    || admission.allows(TtsProviderAdmission.Capability.PCM_STREAMING);
            boolean phonemizerCompatible = !admitted;
            if (admitted) {
                try {
                    phonemizerCompatible = hasCompatiblePiperPhonemizer(library.getTtsEngine());
                } catch (RuntimeException unavailable) {
                    phonemizerCompatible = false;
                }
            }
            return new RuntimeAdmission(library, admission, phonemizerCompatible);
        }

        private boolean allows(TtsProviderAdmission.Capability capability) {
            return compatiblePiperPhonemizer && admission.allows(capability);
        }
    }

    /** Private staged inputs consumed synchronously by Piper before service exposure. */
    private record ModelSnapshot(
            Path directory, Object directoryFileKey, Path modelPath, String modelDigest, long maxModelBytes,
            Path voiceSidecarPath, String voiceSidecarDigest) implements AutoCloseable {
        private void verify() {
            try {
                requireSnapshotDirectory(directory, directoryFileKey);
                if (!modelDigest.equals(fileDigest(modelPath, ignored -> {}, maxModelBytes))
                        || !voiceSidecarDigest.equals(
                                fileDigest(voiceSidecarPath, ignored -> {}, 16L * 1024 * 1024))) {
                    throw new IllegalStateException("TTS_MODEL_SNAPSHOT_CHANGED: staged provider assets changed");
                }
            } catch (IOException | RuntimeException failure) {
                if (failure instanceof IllegalStateException illegal
                        && illegal.getMessage() != null
                        && illegal.getMessage().startsWith("TTS_MODEL_SNAPSHOT_CHANGED")) {
                    throw illegal;
                }
                throw new IllegalStateException("TTS_MODEL_SNAPSHOT_CHANGED: staged provider assets unavailable", failure);
            }
        }

        @Override
        public void close() {
            try {
                requireSnapshotDirectory(directory, directoryFileKey);
                Files.deleteIfExists(voiceSidecarPath);
                Files.deleteIfExists(modelPath);
                requireSnapshotDirectory(directory, directoryFileKey);
                Files.delete(directory);
            } catch (IOException | RuntimeException failure) {
                throw new IllegalStateException(
                        "TTS_MODEL_SNAPSHOT_CLEANUP_FAILED: private provider input cleanup was incomplete", failure);
            }
        }
    }

    private final AudioVideoLibrary ownedLibrary;
    private final TtsProviderAdmission.Decision admission;
    private final boolean compatiblePiperPhonemizer;
    private final String admittedVoiceId;
    private final String admittedLanguage;
    private final TtsRequestAuthorization requestAuthorization;
    private final MediaProcessingRuntimePort mediaRuntimePort;

    public ProductionTtsGrpcService(MeterRegistry metrics) {
        this(metrics, null);
    }

    /** Integration seam for canonical durable Media jobs; it does not grant provider admission. */
    public ProductionTtsGrpcService(MeterRegistry metrics, MediaProcessingRuntimePort mediaRuntimePort) {
        this(createInitializedRuntime(System.getenv(), TtsProviderAdmission.unavailable()), metrics,
                TtsRequestAuthorization.unavailable(), mediaRuntimePort);
    }

    /** Injectable composition for controlled local fixtures; production uses the unavailable default. */
    ProductionTtsGrpcService(
            Map<String, String> environment,
            MeterRegistry metrics,
            TtsProviderAdmission admissionResolver,
            Function<TtsConfig, AudioVideoLibrary> libraryFactory) {
        this(environment, metrics, admissionResolver, TtsRequestAuthorization.unavailable(), libraryFactory);
    }

    /** Package-private trusted-authorizer seam for controlled composition; production defaults stay unavailable. */
    ProductionTtsGrpcService(
            Map<String, String> environment,
            MeterRegistry metrics,
            TtsProviderAdmission admissionResolver,
            TtsRequestAuthorization requestAuthorization,
            Function<TtsConfig, AudioVideoLibrary> libraryFactory) {
        this(createInitializedRuntime(environment, libraryFactory, admissionResolver, ignored -> {}),
                metrics, requestAuthorization);
    }

    private ProductionTtsGrpcService(InitializedRuntime runtime, MeterRegistry metrics) {
        this(runtime, metrics, TtsRequestAuthorization.unavailable());
    }

    private ProductionTtsGrpcService(
            InitializedRuntime runtime, MeterRegistry metrics, TtsRequestAuthorization requestAuthorization) {
        this(runtime, metrics, requestAuthorization, null);
    }

    private ProductionTtsGrpcService(
            InitializedRuntime runtime, MeterRegistry metrics, TtsRequestAuthorization requestAuthorization,
            MediaProcessingRuntimePort mediaRuntimePort) {
        this(runtime.library(), metrics, runtime.admission(), runtime.voiceId(), runtime.language(),
                requestAuthorization, mediaRuntimePort);
    }

    ProductionTtsGrpcService(
            AudioVideoLibrary library,
            MeterRegistry metrics) {
        this(library, metrics, new TtsProviderAdmission.Decision(Set.of(), null,
                "no source-authoritative TTS provider and voice admission decision was supplied"));
    }

    /** Test composition seam. Production construction obtains this decision from the trusted resolver. */
    ProductionTtsGrpcService(
            AudioVideoLibrary library,
            MeterRegistry metrics,
            TtsProviderAdmission.Decision admission) {
        this(library, metrics, admission, null, null);
    }

    ProductionTtsGrpcService(
            AudioVideoLibrary library,
            MeterRegistry metrics,
            TtsProviderAdmission.Decision admission,
            String admittedVoiceId,
            String admittedLanguage) {
        this(library, metrics, admission, admittedVoiceId, admittedLanguage, TtsRequestAuthorization.unavailable());
    }

    ProductionTtsGrpcService(
            AudioVideoLibrary library,
            MeterRegistry metrics,
            TtsProviderAdmission.Decision admission,
            String admittedVoiceId,
            String admittedLanguage,
            TtsRequestAuthorization requestAuthorization) {
        this(library, metrics, admission, admittedVoiceId, admittedLanguage, requestAuthorization, null);
    }

    ProductionTtsGrpcService(
            AudioVideoLibrary library,
            MeterRegistry metrics,
            TtsProviderAdmission.Decision admission,
            String admittedVoiceId,
            String admittedLanguage,
            TtsRequestAuthorization requestAuthorization,
            MediaProcessingRuntimePort mediaRuntimePort) {
        this(RuntimeAdmission.capture(library, admission), metrics, admittedVoiceId, admittedLanguage,
                requestAuthorization, mediaRuntimePort);
    }

    private ProductionTtsGrpcService(
            RuntimeAdmission runtimeAdmission,
            MeterRegistry metrics,
            String admittedVoiceId,
            String admittedLanguage,
            TtsRequestAuthorization requestAuthorization,
            MediaProcessingRuntimePort mediaRuntimePort) {
        super(runtimeAdmission.library(), metrics,
                () -> runtimeAdmission.allows(TtsProviderAdmission.Capability.SYNTHESIS),
                () -> runtimeAdmission.allows(TtsProviderAdmission.Capability.PCM_STREAMING),
                null,
                bindConfiguredDefaultVoice(requestAuthorization, admittedVoiceId),
                (requestedVoice, requestedLanguage) -> matchesAdmittedProfile(
                        admittedVoiceId, admittedLanguage, requestedVoice, requestedLanguage));
        this.ownedLibrary = runtimeAdmission.library();
        this.admission = runtimeAdmission.admission();
        this.compatiblePiperPhonemizer = runtimeAdmission.compatiblePiperPhonemizer();
        this.admittedVoiceId = admittedVoiceId;
        this.admittedLanguage = admittedLanguage;
        this.requestAuthorization = Objects.requireNonNull(requestAuthorization, "requestAuthorization");
        this.mediaRuntimePort = mediaRuntimePort;
    }

    MediaProcessingRuntimePort mediaRuntimePort() { return mediaRuntimePort; }

    static TtsRequestAuthorization bindConfiguredDefaultVoice(
            TtsRequestAuthorization delegate, String configuredDefaultVoice) {
        Objects.requireNonNull(delegate, "requestAuthorization");
        return new TtsRequestAuthorization() {
            @Override
            public Decision authorize(Request request) {
                String selectedVoice = request.voiceId() == null || request.voiceId().isBlank()
                        ? configuredDefaultVoice
                        : request.voiceId();
                return delegate.authorize(new Request(request.identity(), request.operation(),
                        selectedVoice, request.profileId()));
            }

            @Override
            public boolean isConfigured() {
                return delegate.isConfigured();
            }

            @Override
            public boolean isReady() {
                return delegate.isReady();
            }

            @Override
            public String configuredDefaultVoiceId() {
                return configuredDefaultVoice;
            }
        };
    }

    /** Readiness derived from the initialized provider state, without exposing model diagnostics. */
    boolean isProviderReady() {
        // A provider can be healthy while every request is guaranteed to fail. Keep readiness
        // down until the exact startup voice/language profile and the request-time owner/consent
        // resolver used by synthesis are both present.
        if (!admission.allows(TtsProviderAdmission.Capability.SYNTHESIS)
                || !matchesAdmittedProfile(
                        admittedVoiceId,
                        admittedLanguage,
                        admittedVoiceId,
                        admittedLanguage == null ? null : java.util.Locale.forLanguageTag(admittedLanguage))) {
            return false;
        }
        try {
            if (!requestAuthorization.isConfigured() || !requestAuthorization.isReady()) return false;
            TtsEngine engine = ownedLibrary.getTtsEngine();
            return engine.getStatus().isHealthy() && compatiblePiperPhonemizer;
        } catch (RuntimeException unavailable) {
            return false;
        }
    }

    private static boolean hasCompatiblePiperPhonemizer(TtsEngine engine) {
        return !(engine instanceof PiperOnnxEngine piper) || piper.hasProductionCompatiblePhonemizer();
    }

    static TtsConfig createConfig(Map<String, String> environment) {
        return createConfig(environment, TtsProviderAdmission.unavailable(), ignored -> {});
    }

    static TtsConfig createConfig(
            Map<String, String> environment,
            TtsProviderAdmission admissionResolver) {
        return createConfig(environment, admissionResolver, ignored -> {});
    }

    private static TtsConfig createConfig(
            Map<String, String> environment,
            TtsProviderAdmission admissionResolver,
            Consumer<FileChannel> beforeModelHash) {
        return resolveConfiguration(environment, admissionResolver, beforeModelHash).config();
    }

    private static TtsConfig createAdmittedConfig(
            Map<String, String> environment,
            ProviderProfile provider,
            Path modelPath) {
        String profile = firstNonBlank(
                environment.get("MEDIA_RUNTIME_ENVIRONMENT"),
                environment.get("MEDIA_PROFILE"),
                "local");
        boolean productionLike = isProductionLike(profile);

        int maxConcurrent = parseBoundedInt(
                environment,
                "TTS_MAX_CONCURRENT",
                10,
                1,
                1_000);
        int sampleRate = parseBoundedInt(
                environment,
                "TTS_SAMPLE_RATE",
                22_050,
                8_000,
                192_000);
        int maxTextLength = parseBoundedInt(
                environment,
                "TTS_MAX_TEXT_LENGTH",
                5_000,
                1,
                100_000);
        long maxMemoryBytes = configuredModelSizeLimit(environment);
        boolean streamingEnabled = parseBoolean(
                environment,
                "TTS_STREAMING_ENABLED",
                true) && provider.admission().allows(TtsProviderAdmission.Capability.PCM_STREAMING);
        String defaultVoice = requireText(
                environment.getOrDefault("TTS_DEFAULT_VOICE", "piper-en"),
                "TTS_DEFAULT_VOICE");
        String profilePath = environment.getOrDefault("TTS_PROFILE_STORAGE_PATH", "").trim();
        if (productionLike && profilePath.isBlank()) {
            throw new IllegalStateException(
                    "TTS_PROFILE_STORAGE_PATH is required in production-like profiles");
        }

        TtsConfig.Builder builder = TtsConfig.builder()
                .voiceModelPath(modelPath)
                .defaultVoiceId(defaultVoice)
                .availableVoices(List.of(defaultVoice))
                .sampleRate(sampleRate)
                .maxConcurrentRequests(maxConcurrent)
                .maxTextLength(maxTextLength)
                .maxMemoryBytes(maxMemoryBytes)
                .enableProsody(true)
                .enableStreaming(streamingEnabled)
                .enableVoiceCloning(false)
                .allowSyntheticFallback(false);
        if (!profilePath.isBlank()) {
            builder.profileStoragePath(Path.of(profilePath));
        }
        return builder.build();
    }

    static ProviderProfile resolveProviderProfile(Map<String, String> environment) {
        return resolveProviderProfile(environment, TtsProviderAdmission.unavailable(), ignored -> {});
    }

    static ProviderProfile resolveProviderProfile(
            Map<String, String> environment,
            TtsProviderAdmission admissionResolver) {
        return resolveProviderProfile(environment, admissionResolver, ignored -> {});
    }

    private static ProviderProfile resolveProviderProfile(
            Map<String, String> environment,
            TtsProviderAdmission admissionResolver,
            Consumer<FileChannel> beforeModelHash) {
        Objects.requireNonNull(environment, "environment");
        Objects.requireNonNull(admissionResolver, "admissionResolver");
        String mode = environment.getOrDefault("TTS_PROVIDER_MODE", "").trim();
        if (!mode.equals("LOCAL_ONNX")) {
            return notAdmitted("TTS_PROVIDER_MODE must explicitly select an admitted LOCAL_ONNX provider");
        }
        List<String> missing = List.of("TTS_MODEL_ID", "TTS_MODEL_VERSION", "TTS_MODEL_SHA256",
                        "TTS_MODEL_LICENSE", "TTS_MODEL_LANGUAGE", "TTS_MODEL_REGION",
                        "TTS_MODEL_RETENTION", "TTS_MODEL_HARDWARE", "TTS_MODEL_PATH")
                .stream()
                .filter(name -> environment.get(name) == null || environment.get(name).isBlank())
                .toList();
        if (!missing.isEmpty()) {
            return notAdmitted("TTS provider profile is incomplete; missing " + String.join(", ", missing));
        }
        String modelId = environment.get("TTS_MODEL_ID").trim();
        String version = environment.get("TTS_MODEL_VERSION").trim();
        String digest = environment.get("TTS_MODEL_SHA256").trim().toLowerCase(java.util.Locale.ROOT);
        String license = environment.get("TTS_MODEL_LICENSE").trim();
        String language = environment.get("TTS_MODEL_LANGUAGE").trim();
        String region = environment.get("TTS_MODEL_REGION").trim();
        String retention = environment.get("TTS_MODEL_RETENTION").trim();
        String hardware = environment.get("TTS_MODEL_HARDWARE").trim();
        String rawPath = environment.get("TTS_MODEL_PATH").trim();
        if (!digest.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("TTS_MODEL_SHA256 must be a SHA-256 digest");
        if (!isUsableLanguageTag(language)) {
            return notAdmitted("TTS_MODEL_LANGUAGE must be a well-formed BCP 47 language tag with a language subtag");
        }
        Path path = Path.of(rawPath);
        if (!path.isAbsolute() || !path.normalize().equals(path) || containsSymbolicLink(path)
                || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)
                || !Files.isReadable(path)) {
            return notAdmitted(
                    "Configured model path must be an absolute, normalized, non-symbolic regular readable provider asset");
        }
        if (!digest.equals(fileDigest(path, beforeModelHash, configuredModelSizeLimit(environment)))) {
            throw new IllegalArgumentException("TTS model digest does not match TTS_MODEL_SHA256");
        }
        Path voiceSidecar = voiceSidecarPath(path);
        if (containsSymbolicLink(voiceSidecar)
                || !Files.isRegularFile(voiceSidecar, LinkOption.NOFOLLOW_LINKS)
                || !Files.isReadable(voiceSidecar)) {
            return notAdmitted("Configured Piper voice sidecar is unavailable or not a regular readable file");
        }
        String voiceSidecarDigest = fileDigest(voiceSidecar, ignored -> {}, 16L * 1024 * 1024);
        String defaultVoice = requireText(
                environment.getOrDefault("TTS_DEFAULT_VOICE", "piper-en"), "TTS_DEFAULT_VOICE");
        TtsProviderAdmission.Candidate candidate = new TtsProviderAdmission.Candidate(
                mode, modelId, version, digest, voiceSidecarDigest, license, language, region,
                retention, hardware, defaultVoice);
        TtsProviderAdmission.Decision decision;
        try {
            decision = admissionResolver.resolve(candidate);
        } catch (RuntimeException unavailable) {
            decision = new TtsProviderAdmission.Decision(Set.of(), null,
                    "trusted TTS provider admission resolver is unavailable");
        }
        if (decision == null) {
            decision = new TtsProviderAdmission.Decision(Set.of(), null,
                    "trusted TTS provider admission resolver returned no decision");
        }
        if (!decision.admitted()
                || !decision.allows(TtsProviderAdmission.Capability.SYNTHESIS)) {
            String reason = decision.reason() == null
                    ? "trusted source admission for synthesis is unavailable"
                    : decision.reason();
            return new ProviderProfile(modelId, version, digest, voiceSidecarDigest, license,
                    language, region, retention, hardware,
                    "NOT_ADMITTED", reason, decision);
        }
        return new ProviderProfile(modelId, version, digest, voiceSidecarDigest, license,
                language, region, retention, hardware,
                "ADMITTED", decision.reason(), decision);
    }

    private static ProviderProfile notAdmitted(String reason) {
        return new ProviderProfile(null, null, null, null, null, null, null, null, null, "NOT_ADMITTED", reason,
                new TtsProviderAdmission.Decision(Set.of(), null, reason));
    }

    private static Path voiceSidecarPath(Path modelPath) {
        return modelPath.resolveSibling(modelPath.getFileName().toString() + ".json");
    }

    private static String fileDigest(Path path, Consumer<FileChannel> beforeHash) {
        return fileDigest(path, beforeHash, Long.MAX_VALUE);
    }

    private static String fileDigest(Path path, Consumer<FileChannel> beforeHash, long maxBytes) {
        Path absolute = path.toAbsolutePath().normalize();
        try {
            if (containsSymbolicLink(absolute)) {
                throw new IllegalArgumentException("Configured model path contains a symbolic link");
            }
            BasicFileAttributes before = readModelAttributes(absolute);
            if (!before.isRegularFile() || before.fileKey() == null) {
                throw new IllegalArgumentException("Configured model file identity is unavailable");
            }
            if (before.size() > maxBytes) {
                throw new IllegalArgumentException("Configured TTS profile asset exceeds its size bound");
            }
            try (FileChannel channel = FileChannel.open(
                    absolute, Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS))) {
                BasicFileAttributes opened = readModelAttributes(absolute);
                requireStableModelFile(before, opened, channel.size());
                if (channel.size() > maxBytes) {
                    throw new IllegalArgumentException("Configured TTS profile asset exceeds its size bound");
                }
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                beforeHash.accept(channel);
                channel.position(0);
                ByteBuffer buffer = ByteBuffer.allocate(16_384);
                while (channel.read(buffer) >= 0) {
                    buffer.flip();
                    if (buffer.hasRemaining()) digest.update(buffer);
                    buffer.clear();
                }
                BasicFileAttributes after = readModelAttributes(absolute);
                requireStableModelFile(before, after, channel.size());
                if (channel.size() > maxBytes) {
                    throw new IllegalArgumentException("Configured TTS profile asset exceeds its size bound");
                }
                if (containsSymbolicLink(absolute)) {
                    throw new IllegalArgumentException("Configured model path changed to a symbolic link during verification");
                }
                return HexFormat.of().formatHex(digest.digest());
            }
        } catch (IllegalArgumentException exception) {
            throw exception;
        } catch (Exception exception) {
            throw new IllegalArgumentException("Unable to verify configured TTS model digest", exception);
        }
    }

    private static ModelSnapshot createModelSnapshot(
            Path sourceModel, String expectedModelDigest, String expectedSidecarDigest, long maxModelBytes) {
        Path directory = null;
        Path stagedModel = null;
        Path stagedSidecar = null;
        Object directoryFileKey = null;
        try {
            Path canonicalTemp = Path.of(System.getProperty("java.io.tmpdir")).toRealPath();
            directory = Files.createTempDirectory(
                    canonicalTemp, "ghatana-tts-model-", ownerOnlyDirectoryPermissions());
            BasicFileAttributes directoryAttributes = Files.readAttributes(
                    directory, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            directoryFileKey = directoryAttributes.fileKey();
            if (!directoryAttributes.isDirectory() || directoryAttributes.fileKey() == null) {
                throw new IllegalArgumentException("Private TTS model snapshot directory identity is unavailable");
            }
            stagedModel = directory.resolve(sourceModel.getFileName().toString());
            stagedSidecar = voiceSidecarPath(stagedModel);
            String copiedModelDigest = copyVerifiedAsset(sourceModel, stagedModel, maxModelBytes);
            if (!expectedModelDigest.equals(copiedModelDigest)) {
                throw new IllegalArgumentException("Configured TTS model changed before private snapshotting");
            }
            String copiedSidecarDigest = copyVerifiedAsset(
                    voiceSidecarPath(sourceModel), stagedSidecar, 16L * 1024 * 1024);
            if (!expectedSidecarDigest.equals(copiedSidecarDigest)) {
                throw new IllegalArgumentException("Configured TTS voice sidecar changed before private snapshotting");
            }
            return new ModelSnapshot(directory, directoryFileKey, stagedModel, copiedModelDigest, maxModelBytes,
                    stagedSidecar, copiedSidecarDigest);
        } catch (IOException | RuntimeException failure) {
            if (directory != null) {
                try {
                    if (directoryFileKey != null) {
                        requireSnapshotDirectory(directory, directoryFileKey);
                        if (stagedSidecar != null) Files.deleteIfExists(stagedSidecar);
                        if (stagedModel != null) Files.deleteIfExists(stagedModel);
                        requireSnapshotDirectory(directory, directoryFileKey);
                        Files.delete(directory);
                    } else {
                        // The fileKey failure occurs before staging files are created; delete only the empty directory.
                        BasicFileAttributes attributes = Files.readAttributes(
                                directory, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                        if (!attributes.isDirectory() || attributes.isSymbolicLink()) {
                            throw new IllegalStateException("Private TTS snapshot directory is no longer safe to clean");
                        }
                        Files.delete(directory);
                    }
                } catch (IOException | RuntimeException cleanupFailure) {
                    failure.addSuppressed(cleanupFailure);
                }
            }
            if (failure instanceof IllegalArgumentException argument) throw argument;
            throw new IllegalArgumentException("Unable to create private TTS provider input snapshot", failure);
        }
    }

    private static String copyVerifiedAsset(Path source, Path destination, long maxBytes) throws IOException {
        Path absoluteSource = source.toAbsolutePath().normalize();
        if (containsSymbolicLink(absoluteSource)) {
            throw new IllegalArgumentException("Configured TTS provider asset contains a symbolic link");
        }
        BasicFileAttributes before = readModelAttributes(absoluteSource);
        if (!before.isRegularFile() || before.fileKey() == null || before.size() > maxBytes) {
            throw new IllegalArgumentException("Configured TTS provider asset is not a bounded regular file");
        }

        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
        long copied = 0;
        try (FileChannel input = FileChannel.open(
                     absoluteSource, Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS));
             FileChannel output = FileChannel.open(
                     destination,
                     Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS),
                     ownerOnlyFilePermissions())) {
            BasicFileAttributes opened = readModelAttributes(absoluteSource);
            requireStableModelFile(before, opened, input.size());
            ByteBuffer buffer = ByteBuffer.allocate(16_384);
            while (input.read(buffer) >= 0) {
                buffer.flip();
                if (buffer.hasRemaining()) {
                    ByteBuffer digestInput = buffer.asReadOnlyBuffer();
                    digest.update(digestInput);
                    int remaining = buffer.remaining();
                    if (copied > maxBytes - remaining) {
                        throw new IllegalArgumentException("Configured TTS provider asset exceeds its size bound");
                    }
                    copied += remaining;
                    while (buffer.hasRemaining()) output.write(buffer);
                }
                buffer.clear();
            }
            output.force(true);
            BasicFileAttributes after = readModelAttributes(absoluteSource);
            requireStableModelFile(before, after, input.size());
            if (containsSymbolicLink(absoluteSource) || copied != before.size()) {
                throw new IllegalArgumentException("Configured TTS provider asset changed during private snapshotting");
            }
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    private static void requireSnapshotDirectory(Path directory, Object expectedFileKey) throws IOException {
        BasicFileAttributes attributes = Files.readAttributes(
                directory, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (!attributes.isDirectory() || !Objects.equals(expectedFileKey, attributes.fileKey())) {
            throw new IllegalStateException("Private TTS model snapshot directory identity changed");
        }
    }

    private static FileAttribute<Set<PosixFilePermission>> ownerOnlyDirectoryPermissions() {
        return PosixFilePermissions.asFileAttribute(EnumSet.of(
                PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE,
                PosixFilePermission.OWNER_EXECUTE));
    }

    private static FileAttribute<Set<PosixFilePermission>> ownerOnlyFilePermissions() {
        return PosixFilePermissions.asFileAttribute(EnumSet.of(
                PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE));
    }

    private static BasicFileAttributes readModelAttributes(Path path) throws java.io.IOException {
        return Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
    }

    private static void requireStableModelFile(
            BasicFileAttributes before,
            BasicFileAttributes after,
            long openedChannelSize) {
        if (!after.isRegularFile()
                || !Objects.equals(before.fileKey(), after.fileKey())
                || before.size() != after.size()
                || before.size() != openedChannelSize
                || !before.lastModifiedTime().equals(after.lastModifiedTime())) {
            throw new IllegalArgumentException("Configured TTS model file changed during digest verification");
        }
    }

    private static boolean containsSymbolicLink(Path path) {
        Path absolute = path.toAbsolutePath().normalize();
        Path current = absolute.getRoot();
        for (Path component : absolute) {
            current = current == null ? component : current.resolve(component);
            if (Files.isSymbolicLink(current)) return true;
        }
        return false;
    }

    static AudioVideoLibrary createInitializedLibrary(
            Map<String, String> environment,
            Function<TtsConfig, AudioVideoLibrary> libraryFactory,
            Consumer<FileChannel> beforeModelHash) {
        return createInitializedLibrary(environment, libraryFactory,
                TtsProviderAdmission.unavailable(), beforeModelHash);
    }

    private static AudioVideoLibrary createInitializedLibrary(
            Map<String, String> environment,
            Function<TtsConfig, AudioVideoLibrary> libraryFactory,
            TtsProviderAdmission admissionResolver,
            Consumer<FileChannel> beforeModelHash) {
        return createInitializedRuntime(environment, libraryFactory, admissionResolver, beforeModelHash).library();
    }

    private static InitializedRuntime createInitializedRuntime(
            Map<String, String> environment,
            TtsProviderAdmission admissionResolver) {
        return createInitializedRuntime(environment,
                config -> AudioVideoLibrary.builder().withTtsConfig(config).build(), admissionResolver, ignored -> {});
    }

    private static InitializedRuntime createInitializedRuntime(
            Map<String, String> environment,
            Function<TtsConfig, AudioVideoLibrary> libraryFactory,
            TtsProviderAdmission admissionResolver,
            Consumer<FileChannel> beforeModelHash) {
        Objects.requireNonNull(environment, "environment");
        Objects.requireNonNull(libraryFactory, "libraryFactory");
        RuntimeConfiguration runtime = resolveConfiguration(environment, admissionResolver, beforeModelHash);
        AudioVideoLibrary library = null;
        try {
            library = Objects.requireNonNull(libraryFactory.apply(runtime.config()), "libraryFactory returned null");
            runtime.modelSnapshot().verify();
            library.getTtsEngine().warmup();
            runtime.modelSnapshot().verify();
            InitializedRuntime initialized = new InitializedRuntime(
                    library, runtime.admission(), runtime.config().defaultVoiceId(), runtime.language());
            runtime.modelSnapshot().close();
            return initialized;
        } catch (RuntimeException | Error exception) {
            if (library != null) {
                try {
                    library.close();
                } catch (RuntimeException closeFailure) {
                    exception.addSuppressed(closeFailure);
                }
            }
            try {
                runtime.modelSnapshot().close();
            } catch (RuntimeException cleanupFailure) {
                exception.addSuppressed(cleanupFailure);
            }
            throw exception;
        }
    }

    static AudioVideoLibrary createInitializedLibrary(
            Map<String, String> environment,
            Function<TtsConfig, AudioVideoLibrary> libraryFactory) {
        return createInitializedLibrary(environment, libraryFactory, ignored -> {});
    }

    private static RuntimeConfiguration resolveConfiguration(
            Map<String, String> environment,
            TtsProviderAdmission admissionResolver,
            Consumer<FileChannel> beforeModelHash) {
        Objects.requireNonNull(environment, "environment");
        Objects.requireNonNull(admissionResolver, "admissionResolver");
        boolean allowSyntheticFallback = parseBoolean(
                environment, "MEDIA_TTS_ALLOW_SYNTHETIC_FALLBACK", false);
        if (allowSyntheticFallback) {
            throw new IllegalStateException(
                    "Synthetic TTS fallback is forbidden by the provider profile");
        }
        ProviderProfile provider = resolveProviderProfile(environment, admissionResolver, beforeModelHash);
        if (!"ADMITTED".equals(provider.status())) {
            throw new IllegalStateException("TTS_PROVIDER_NOT_ADMITTED: " + provider.reason());
        }
        long maxModelBytes = configuredModelSizeLimit(environment);
        ModelSnapshot snapshot = createModelSnapshot(
                Path.of(environment.get("TTS_MODEL_PATH")), provider.modelDigest(),
                provider.voiceSidecarDigest(), maxModelBytes);
        try {
            TtsConfig config = createAdmittedConfig(environment, provider, snapshot.modelPath());
            TtsProviderAdmission.Decision effectiveAdmission = provider.admission();
            if (!config.enableStreaming()
                    && effectiveAdmission.allows(TtsProviderAdmission.Capability.PCM_STREAMING)) {
                Set<TtsProviderAdmission.Capability> effectiveCapabilities =
                        new java.util.HashSet<>(effectiveAdmission.capabilities());
                effectiveCapabilities.remove(TtsProviderAdmission.Capability.PCM_STREAMING);
                effectiveAdmission = new TtsProviderAdmission.Decision(
                        effectiveCapabilities, effectiveAdmission.authorityReference(), effectiveAdmission.reason());
            }
            return new RuntimeConfiguration(config, effectiveAdmission, provider.language(), snapshot);
        } catch (RuntimeException | Error failure) {
            try {
                snapshot.close();
            } catch (RuntimeException cleanupFailure) {
                failure.addSuppressed(cleanupFailure);
            }
            throw failure;
        }
    }

    static boolean matchesAdmittedProfile(
            String admittedVoiceId, String admittedLanguage,
            String requestedVoiceId, java.util.Locale requestedLanguage) {
        if (admittedVoiceId == null || admittedVoiceId.isBlank()
                || admittedLanguage == null || admittedLanguage.isBlank()) return false;
        String selectedVoice = requestedVoiceId == null || requestedVoiceId.isBlank()
                ? admittedVoiceId : requestedVoiceId;
        if (!admittedVoiceId.equals(selectedVoice)) return false;
        String selectedLanguage = requestedLanguage == null
                ? admittedLanguage
                : requestedLanguage.toLanguageTag();
        return normalizeLanguage(admittedLanguage).equals(normalizeLanguage(selectedLanguage));
    }

    private static String normalizeLanguage(String language) {
        return java.util.Locale.forLanguageTag(language).toLanguageTag();
    }

    private static boolean isUsableLanguageTag(String language) {
        try {
            java.util.Locale locale = new java.util.Locale.Builder().setLanguageTag(language).build();
            return !locale.getLanguage().isBlank() && !"und".equalsIgnoreCase(locale.getLanguage());
        } catch (java.util.IllformedLocaleException malformed) {
            return false;
        }
    }

    @Override
    public void close() {
        ownedLibrary.close();
    }

    private static int parseBoundedInt(
            Map<String, String> environment,
            String key,
            int fallback,
            int minimum,
            int maximum) {
        long parsed = parseBoundedLong(environment, key, fallback, minimum, maximum);
        return Math.toIntExact(parsed);
    }

    private static long parseBoundedLong(
            Map<String, String> environment,
            String key,
            long fallback,
            long minimum,
            long maximum) {
        String raw = environment.get(key);
        long parsed;
        try {
            parsed = raw == null || raw.isBlank()
                    ? fallback
                    : Long.parseLong(raw.trim());
        } catch (NumberFormatException exception) {
            throw new IllegalArgumentException(key + " must be an integer", exception);
        }
        if (parsed < minimum || parsed > maximum) {
            throw new IllegalArgumentException(
                    key + " must be between " + minimum + " and " + maximum);
        }
        return parsed;
    }

    private static long configuredModelSizeLimit(Map<String, String> environment) {
        // Reuse the existing runtime memory budget as the conservative model and snapshot byte ceiling.
        return parseBoundedLong(
                environment,
                "TTS_MAX_MEMORY_BYTES",
                DEFAULT_TTS_MAX_MEMORY_BYTES,
                1L * 1024 * 1024,
                MAX_TTS_MODEL_BYTES);
    }

    private static boolean parseBoolean(
            Map<String, String> environment,
            String key,
            boolean fallback) {
        String raw = environment.get(key);
        if (raw == null || raw.isBlank()) return fallback;
        if (raw.equalsIgnoreCase("true")) return true;
        if (raw.equalsIgnoreCase("false")) return false;
        throw new IllegalArgumentException(key + " must be true or false");
    }

    private static boolean isProductionLike(String profile) {
        return MediaDeploymentProfiles.productionLike(profile);
    }

    private static String firstNonBlank(
            String first,
            String second,
            String fallback) {
        if (first != null && !first.isBlank()) return first.trim();
        if (second != null && !second.isBlank()) return second.trim();
        return fallback;
    }

    private static String requireText(String value, String key) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(key + " must not be blank");
        }
        return value.trim();
    }
}
