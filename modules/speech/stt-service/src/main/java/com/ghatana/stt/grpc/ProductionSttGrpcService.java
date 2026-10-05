package com.ghatana.stt.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.config.SttConfig;
import com.ghatana.stt.core.grpc.proto.AdaptRequest;
import com.ghatana.stt.core.grpc.proto.AdaptResponse;
import com.ghatana.stt.core.grpc.proto.CorrectionRequest;
import com.ghatana.stt.core.grpc.proto.CorrectionResponse;
import com.ghatana.stt.core.grpc.proto.CreateProfileRequest;
import com.ghatana.stt.core.grpc.proto.GetProfileRequest;
import com.ghatana.stt.core.grpc.proto.ProfileResponse;
import com.ghatana.stt.core.grpc.proto.UnloadModelRequest;
import com.ghatana.stt.core.grpc.proto.UnloadModelResponse;
import com.ghatana.stt.core.grpc.proto.UpdateProfileRequest;
import io.grpc.Status;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.MeterRegistry;

import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.Objects;

/**
 * Production composition and lifecycle owner for {@link SttGrpcService}.
 *
 * <p>The model is constructed and warmed before the server binds. Synthetic STT is explicit
 * local/test behavior and is rejected for staging, production, and sovereign profiles. Model
 * unload, adaptation, speaker profiles, and correction learning are explicitly unavailable until
 * real providers for those capabilities are composed.
 *
 * @doc.type class
 * @doc.purpose Fail-closed STT gRPC composition with owned library lifecycle
 * @doc.layer product
 * @doc.pattern CompositionRoot
 */
public final class ProductionSttGrpcService extends SttGrpcService implements AutoCloseable {

    private final AudioVideoLibrary ownedLibrary;

    public ProductionSttGrpcService(MeterRegistry metrics) {
        this(createInitializedLibrary(System.getenv()), metrics);
    }

    ProductionSttGrpcService(AudioVideoLibrary library, MeterRegistry metrics) {
        super(library, metrics);
        this.ownedLibrary = Objects.requireNonNull(library, "library");
    }

    static SttConfig createConfig(Map<String, String> environment) {
        Objects.requireNonNull(environment, "environment");
        String profile = firstNonBlank(
                environment.get("MEDIA_RUNTIME_ENVIRONMENT"),
                environment.get("MEDIA_PROFILE"),
                "local");
        boolean productionLike = productionLike(profile);
        boolean allowSynthetic = bool(
                environment,
                "MEDIA_STT_ALLOW_SYNTHETIC_FALLBACK",
                false);
        if (productionLike && allowSynthetic) {
            throw new IllegalStateException(
                    "Synthetic STT fallback is forbidden in production-like profile " + profile);
        }

        return SttConfig.builder()
                .modelPath(Path.of(environment.getOrDefault(
                        "STT_MODEL_PATH",
                        "/models/whisper-base.onnx")))
                .modelId(requireText(
                        environment.getOrDefault("STT_MODEL_ID", "whisper-base"),
                        "STT_MODEL_ID"))
                .useGpu(bool(environment, "STT_USE_GPU", false))
                .maxConcurrentRequests(integer(
                        environment,
                        "STT_MAX_CONCURRENT",
                        10,
                        1,
                        1_000))
                .timeout(Duration.ofMillis(integer(
                        environment,
                        "STT_TIMEOUT_MS",
                        30_000,
                        1,
                        600_000)))
                .beamSize(integer(environment, "STT_BEAM_SIZE", 5, 1, 100))
                .enableAdaptation(false)
                .enablePunctuation(bool(environment, "STT_ENABLE_PUNCTUATION", true))
                .enableTimestamps(bool(environment, "STT_ENABLE_TIMESTAMPS", false))
                .maxAudioLengthSeconds(integer(
                        environment,
                        "STT_MAX_AUDIO_LENGTH_SECONDS",
                        300,
                        1,
                        86_400))
                .allowSyntheticFallback(allowSynthetic)
                .maxMemoryBytes(longValue(
                        environment,
                        "STT_MAX_MEMORY_BYTES",
                        512L * 1024 * 1024,
                        1L * 1024 * 1024,
                        8L * 1024 * 1024 * 1024))
                .build();
    }

    @Override
    public void unloadModel(
            UnloadModelRequest request,
            StreamObserver<UnloadModelResponse> responseObserver) {
        unimplemented(responseObserver, "Model unload is not supported by the single-model STT provider");
    }

    @Override
    public void adaptModel(
            AdaptRequest request,
            StreamObserver<AdaptResponse> responseObserver) {
        unimplemented(responseObserver, "STT adaptation requires a real adaptation provider");
    }

    @Override
    public void createProfile(
            CreateProfileRequest request,
            StreamObserver<ProfileResponse> responseObserver) {
        unimplemented(responseObserver, "STT speaker profiles require embedding and persistence providers");
    }

    @Override
    public void getProfile(
            GetProfileRequest request,
            StreamObserver<ProfileResponse> responseObserver) {
        unimplemented(responseObserver, "STT speaker profiles require embedding and persistence providers");
    }

    @Override
    public void updateProfile(
            UpdateProfileRequest request,
            StreamObserver<ProfileResponse> responseObserver) {
        unimplemented(responseObserver, "STT speaker profiles require embedding and persistence providers");
    }

    @Override
    public void submitCorrection(
            CorrectionRequest request,
            StreamObserver<CorrectionResponse> responseObserver) {
        unimplemented(responseObserver, "STT correction learning requires an adaptation provider");
    }

    private static AudioVideoLibrary createInitializedLibrary(Map<String, String> environment) {
        AudioVideoLibrary library = AudioVideoLibrary.builder()
                .withSttConfig(createConfig(environment))
                .build();
        try {
            library.getSttEngine().warmup();
            return library;
        } catch (RuntimeException failure) {
            library.close();
            throw failure;
        }
    }

    @Override
    public void close() {
        ownedLibrary.close();
    }

    private static <T> void unimplemented(StreamObserver<T> observer, String message) {
        observer.onError(Status.UNIMPLEMENTED.withDescription(message).asRuntimeException());
    }

    private static int integer(
            Map<String, String> environment,
            String key,
            int fallback,
            int minimum,
            int maximum) {
        return Math.toIntExact(longValue(environment, key, fallback, minimum, maximum));
    }

    private static long longValue(
            Map<String, String> environment,
            String key,
            long fallback,
            long minimum,
            long maximum) {
        String raw = environment.get(key);
        long value;
        try {
            value = raw == null || raw.isBlank() ? fallback : Long.parseLong(raw.trim());
        } catch (NumberFormatException failure) {
            throw new IllegalArgumentException(key + " must be an integer", failure);
        }
        if (value < minimum || value > maximum) {
            throw new IllegalArgumentException(
                    key + " must be between " + minimum + " and " + maximum);
        }
        return value;
    }

    private static boolean bool(
            Map<String, String> environment,
            String key,
            boolean fallback) {
        String raw = environment.get(key);
        if (raw == null || raw.isBlank()) return fallback;
        if (raw.equalsIgnoreCase("true")) return true;
        if (raw.equalsIgnoreCase("false")) return false;
        throw new IllegalArgumentException(key + " must be true or false");
    }

    private static boolean productionLike(String profile) {
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
