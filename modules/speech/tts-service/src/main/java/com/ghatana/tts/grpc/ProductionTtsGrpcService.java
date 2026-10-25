package com.ghatana.tts.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.config.TtsConfig;
import io.micrometer.core.instrument.MeterRegistry;

import java.nio.file.Path;
import java.nio.file.Files;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
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
        Objects.requireNonNull(environment, "environment");
        ProviderProfile provider = resolveProviderProfile(environment);
        if (!"ADMITTED".equals(provider.status())) {
            throw new IllegalStateException("TTS_PROVIDER_NOT_ADMITTED: " + provider.reason());
        }
        String profile = firstNonBlank(
                environment.get("MEDIA_RUNTIME_ENVIRONMENT"),
                environment.get("MEDIA_PROFILE"),
                "local");
        boolean productionLike = isProductionLike(profile);
        boolean allowSyntheticFallback = parseBoolean(
                environment,
                "MEDIA_TTS_ALLOW_SYNTHETIC_FALLBACK",
                false);
        if (productionLike && allowSyntheticFallback) {
            throw new IllegalStateException(
                    "Synthetic TTS fallback is forbidden in production-like profile " + profile);
        }

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
        String mode = environment.getOrDefault("TTS_PROVIDER_MODE", "").trim();
        if (!mode.equals("LOCAL_ONNX")) {
            return notAdmitted("TTS_PROVIDER_MODE must explicitly select an admitted LOCAL_ONNX provider");
        }
        String modelId = required(environment, "TTS_MODEL_ID");
        String version = required(environment, "TTS_MODEL_VERSION");
        String digest = required(environment, "TTS_MODEL_SHA256").toLowerCase(java.util.Locale.ROOT);
        String license = required(environment, "TTS_MODEL_LICENSE");
        String language = required(environment, "TTS_MODEL_LANGUAGE");
        String region = required(environment, "TTS_MODEL_REGION");
        String retention = required(environment, "TTS_MODEL_RETENTION");
        String hardware = required(environment, "TTS_MODEL_HARDWARE");
        String rawPath = required(environment, "TTS_MODEL_PATH");
        if (!digest.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("TTS_MODEL_SHA256 must be a SHA-256 digest");
        Path path = Path.of(rawPath);
        if (!Files.isRegularFile(path) || !Files.isReadable(path) || Files.isSymbolicLink(path)) {
            return notAdmitted("Configured model file is unavailable or not a regular readable file");
        }
        if (!digest.equals(fileDigest(path))) throw new IllegalArgumentException("TTS model digest does not match TTS_MODEL_SHA256");
        return new ProviderProfile(modelId, version, digest, license, language, region, retention, hardware,
                "NOT_ADMITTED", "Local TTS model metadata is configured, but license, voice rights, hardware and quality are not source-admitted; readiness is false");
    }

    private static ProviderProfile notAdmitted(String reason) {
        return new ProviderProfile(null, null, null, null, null, null, null, null, "NOT_ADMITTED", reason);
    }

    private static String required(Map<String, String> environment, String name) {
        String value = environment.get(name);
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
        return value.trim();
    }

    private static String fileDigest(Path path) {
        try (InputStream input = Files.newInputStream(path)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[16_384];
            for (int count; (count = input.read(buffer)) >= 0;) if (count > 0) digest.update(buffer, 0, count);
            return HexFormat.of().formatHex(digest.digest());
        } catch (Exception exception) {
            throw new IllegalArgumentException("Unable to verify configured TTS model digest", exception);
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
        Objects.requireNonNull(environment, "environment");
        Objects.requireNonNull(libraryFactory, "libraryFactory");
        // Resolve provider admission before creating a library or model-backed engine.
        TtsConfig config = createConfig(environment);
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
