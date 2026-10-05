package com.ghatana.tts.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.config.TtsConfig;
import io.micrometer.core.instrument.MeterRegistry;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Production composition for {@link TtsGrpcService}.
 *
 * <p>The embedded engine is constructed and warmed before this service is returned to the server.
 * Synthetic fallback is explicit local/test behavior and is rejected in production-like profiles.
 * Production-like profiles also require a durable profile storage path because profile routes are
 * part of the exposed TTS contract.
 *
 * @doc.type class
 * @doc.purpose Fail-closed TTS gRPC composition and owned library lifecycle
 * @doc.layer product
 * @doc.pattern CompositionRoot
 */
public final class ProductionTtsGrpcService extends TtsGrpcService implements AutoCloseable {

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

    static TtsConfig createConfig(Map<String, String> environment) {
        Objects.requireNonNull(environment, "environment");
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

    private static AudioVideoLibrary createInitializedLibrary(
            Map<String, String> environment) {
        AudioVideoLibrary library = AudioVideoLibrary.builder()
                .withTtsConfig(createConfig(environment))
                .build();
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
