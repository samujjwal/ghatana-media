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
 * <p>Provider admission is checked before an embedded engine is constructed or warmed. The current
 * provider resolver remains {@code NOT_ADMITTED}, so production composition fails closed at that
 * check. Synthetic fallback is not a production synthesis path. Production-like profiles also
 * require a durable profile storage path because profile routes are part of the exposed contract.
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
            String status, String reason) {}

    private final AudioVideoLibrary ownedLibrary;

    public ProductionTtsGrpcService(MeterRegistry metrics) {
        this(createInitializedLibrary(System.getenv()), metrics);
    }

    ProductionTtsGrpcService(
            AudioVideoLibrary library,
            MeterRegistry metrics) {
        super(library, metrics);
        this.ownedLibrary = Objects.requireNonNull(library, "library");
    }

    /** Readiness derived from the initialized provider state, without exposing model diagnostics. */
    boolean isProviderReady() {
        try {
            return ownedLibrary.getTtsEngine().getStatus().isHealthy();
        } catch (RuntimeException unavailable) {
            return false;
        }
    }

    static TtsConfig createConfig(Map<String, String> environment) {
        return createConfig(environment, ignored -> {});
    }

    private static TtsConfig createConfig(
            Map<String, String> environment,
            Consumer<FileChannel> beforeModelHash) {
        Objects.requireNonNull(environment, "environment");
        boolean allowSyntheticFallback = parseBoolean(
                environment,
                "MEDIA_TTS_ALLOW_SYNTHETIC_FALLBACK",
                false);
        if (allowSyntheticFallback) {
            throw new IllegalStateException(
                    "Synthetic TTS fallback is forbidden by the provider profile");
        }
        ProviderProfile provider = resolveProviderProfile(environment, beforeModelHash);
        if (!"ADMITTED".equals(provider.status())) {
            throw new IllegalStateException("TTS_PROVIDER_NOT_ADMITTED: " + provider.reason());
        }
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
                true);
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
                .allowSyntheticFallback(allowSyntheticFallback);
        if (!profilePath.isBlank()) {
            builder.profileStoragePath(Path.of(profilePath));
        }
        return builder.build();
    }

    static ProviderProfile resolveProviderProfile(Map<String, String> environment) {
        return resolveProviderProfile(environment, ignored -> {});
    }

    private static ProviderProfile resolveProviderProfile(
            Map<String, String> environment,
            Consumer<FileChannel> beforeModelHash) {
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
        return new ProviderProfile(modelId, version, digest, license, language, region, retention, hardware,
                "NOT_ADMITTED", "Local TTS model metadata is configured, but license, voice rights, hardware and quality are not source-admitted; readiness is false");
    }

    private static ProviderProfile notAdmitted(String reason) {
        return new ProviderProfile(null, null, null, null, null, null, null, null, "NOT_ADMITTED", reason);
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
        Objects.requireNonNull(environment, "environment");
        Objects.requireNonNull(libraryFactory, "libraryFactory");
        TtsConfig config = createConfig(environment, beforeModelHash);
        AudioVideoLibrary library = Objects.requireNonNull(
                libraryFactory.apply(config), "libraryFactory returned null");
        try {
            library.getTtsEngine().warmup();
            return library;
        } catch (RuntimeException exception) {
            library.close();
            throw exception;
        }
    }

    private static AudioVideoLibrary createInitializedLibrary(
            Map<String, String> environment) {
        return createInitializedLibrary(environment,
                config -> AudioVideoLibrary.builder().withTtsConfig(config).build());
    }

    static AudioVideoLibrary createInitializedLibrary(
            Map<String, String> environment,
            Function<TtsConfig, AudioVideoLibrary> libraryFactory) {
        return createInitializedLibrary(environment, libraryFactory, ignored -> {});
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
