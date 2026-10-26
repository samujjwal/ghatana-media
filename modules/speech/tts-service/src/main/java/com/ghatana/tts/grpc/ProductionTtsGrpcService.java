package com.ghatana.tts.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.config.TtsConfig;
import io.micrometer.core.instrument.MeterRegistry;

import java.nio.file.Path;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.StandardOpenOption;
import java.nio.channels.FileChannel;
import java.nio.ByteBuffer;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
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

    record ProviderProfile(
            String modelId, String modelVersion, String modelDigest, String license,
            String language, String region, String retention, String hardware,
            String status, String reason, TtsProviderAdmission.Decision admission) {}

    private record RuntimeConfiguration(
            TtsConfig config, TtsProviderAdmission.Decision admission, String language) {}
    private record InitializedRuntime(
            AudioVideoLibrary library, TtsProviderAdmission.Decision admission,
            String voiceId, String language) {}

    private final AudioVideoLibrary ownedLibrary;
    private final TtsProviderAdmission.Decision admission;
    private final String admittedVoiceId;
    private final String admittedLanguage;
    private final TtsRequestAuthorization requestAuthorization;

    public ProductionTtsGrpcService(MeterRegistry metrics) {
        this(createInitializedRuntime(System.getenv(), TtsProviderAdmission.unavailable()), metrics);
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
        this(runtime.library(), metrics, runtime.admission(), runtime.voiceId(), runtime.language(), requestAuthorization);
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
        super(library, metrics,
                () -> admission.allows(TtsProviderAdmission.Capability.SYNTHESIS),
                () -> admission.allows(TtsProviderAdmission.Capability.PCM_STREAMING),
                null,
                bindConfiguredDefaultVoice(requestAuthorization, admittedVoiceId),
                (requestedVoice, requestedLanguage) -> matchesAdmittedProfile(
                        admittedVoiceId, admittedLanguage, requestedVoice, requestedLanguage));
        this.ownedLibrary = Objects.requireNonNull(library, "library");
        this.admission = Objects.requireNonNull(admission, "admission");
        this.admittedVoiceId = admittedVoiceId;
        this.admittedLanguage = admittedLanguage;
        this.requestAuthorization = Objects.requireNonNull(requestAuthorization, "requestAuthorization");
    }

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
            return ownedLibrary.getTtsEngine().getStatus().isHealthy();
        } catch (RuntimeException unavailable) {
            return false;
        }
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
            ProviderProfile provider) {
        String profile = firstNonBlank(
                environment.get("MEDIA_RUNTIME_ENVIRONMENT"),
                environment.get("MEDIA_PROFILE"),
                "local");
        boolean productionLike = isProductionLike(profile);

        Path modelPath = Path.of(environment.getOrDefault(
                "TTS_MODEL_PATH",
                "/models/piper-en.onnx"));
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
        long maxMemoryBytes = parseBoundedLong(
                environment,
                "TTS_MAX_MEMORY_BYTES",
                256L * 1024 * 1024,
                1L * 1024 * 1024,
                4L * 1024 * 1024 * 1024);
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
        Path path = Path.of(rawPath);
        if (containsSymbolicLink(path) || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)
                || !Files.isReadable(path)) {
            return notAdmitted("Configured model file is unavailable or not a regular readable file");
        }
        if (!digest.equals(fileDigest(path, beforeModelHash))) {
            throw new IllegalArgumentException("TTS model digest does not match TTS_MODEL_SHA256");
        }
        String defaultVoice = requireText(
                environment.getOrDefault("TTS_DEFAULT_VOICE", "piper-en"), "TTS_DEFAULT_VOICE");
        TtsProviderAdmission.Candidate candidate = new TtsProviderAdmission.Candidate(
                mode, modelId, version, digest, license, language, region, retention, hardware, defaultVoice);
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
            return new ProviderProfile(modelId, version, digest, license, language, region, retention, hardware,
                    "NOT_ADMITTED", reason, decision);
        }
        return new ProviderProfile(modelId, version, digest, license, language, region, retention, hardware,
                "ADMITTED", decision.reason(), decision);
    }

    private static ProviderProfile notAdmitted(String reason) {
        return new ProviderProfile(null, null, null, null, null, null, null, null, "NOT_ADMITTED", reason,
                new TtsProviderAdmission.Decision(Set.of(), null, reason));
    }

    private static String fileDigest(Path path, Consumer<FileChannel> beforeHash) {
        Path absolute = path.toAbsolutePath().normalize();
        try {
            if (containsSymbolicLink(absolute)) {
                throw new IllegalArgumentException("Configured model path contains a symbolic link");
            }
            BasicFileAttributes before = readModelAttributes(absolute);
            if (!before.isRegularFile() || before.fileKey() == null) {
                throw new IllegalArgumentException("Configured model file identity is unavailable");
            }
            try (FileChannel channel = FileChannel.open(
                    absolute, Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS))) {
                BasicFileAttributes opened = readModelAttributes(absolute);
                requireStableModelFile(before, opened, channel.size());
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
            if (Files.isSymbolicLink(current) && !isCanonicalMacOsTmpAlias(current)) return true;
        }
        return false;
    }

    private static boolean isCanonicalMacOsTmpAlias(Path path) {
        if (!path.equals(Path.of("/tmp"))) return false;
        try {
            return Files.isSymbolicLink(path) && path.toRealPath().equals(Path.of("/private/tmp"));
        } catch (java.io.IOException unavailable) {
            return false;
        }
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
        AudioVideoLibrary library = Objects.requireNonNull(
                libraryFactory.apply(runtime.config()), "libraryFactory returned null");
        try {
            library.getTtsEngine().warmup();
            return new InitializedRuntime(library, runtime.admission(), runtime.config().defaultVoiceId(),
                    runtime.language());
        } catch (RuntimeException exception) {
            library.close();
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
        TtsConfig config = createAdmittedConfig(environment, provider);
        TtsProviderAdmission.Decision effectiveAdmission = provider.admission();
        if (!config.enableStreaming()
                && effectiveAdmission.allows(TtsProviderAdmission.Capability.PCM_STREAMING)) {
            Set<TtsProviderAdmission.Capability> effectiveCapabilities =
                    new java.util.HashSet<>(effectiveAdmission.capabilities());
            effectiveCapabilities.remove(TtsProviderAdmission.Capability.PCM_STREAMING);
            effectiveAdmission = new TtsProviderAdmission.Decision(
                    effectiveCapabilities, effectiveAdmission.authorityReference(), effectiveAdmission.reason());
        }
        return new RuntimeConfiguration(config, effectiveAdmission, provider.language());
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
        return profile.equalsIgnoreCase("production")
                || profile.equalsIgnoreCase("staging")
                || profile.equalsIgnoreCase("sovereign");
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
