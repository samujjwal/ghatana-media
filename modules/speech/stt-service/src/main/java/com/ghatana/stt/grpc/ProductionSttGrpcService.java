package com.ghatana.stt.grpc;

import com.ghatana.governance.PolicyEngine;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.config.SttConfig;
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.media.runtime.MediaSourceRightsAdministration;
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
import io.opentelemetry.api.trace.Tracer;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Duration;
import java.util.HexFormat;
import java.util.Map;
import java.util.Objects;
import java.util.ServiceConfigurationError;
import java.util.ServiceLoader;

/**
 * Production composition and lifecycle owner for {@link SttGrpcService}.
 *
 * <p>Provider selection is explicit and validated before any model is constructed. The current
 * gRPC and local ONNX profiles are both NOT_ADMITTED, so startup fails closed until an owning
 * provider/license/quality admission is recorded in the provider manifest and implemented here.
 * Synthetic STT is rejected for production-like profiles. Model unload, adaptation, speaker
 * profiles, and correction learning remain explicitly unavailable until real providers are composed.
 *
 * @doc.type class
 * @doc.purpose Fail-closed STT gRPC composition with owned library lifecycle
 * @doc.layer product
 * @doc.pattern CompositionRoot
 */
public final class ProductionSttGrpcService extends SttGrpcService implements AutoCloseable {

    private final AudioVideoLibrary ownedLibrary;
    private final MediaProcessingRuntimePort mediaRuntimePort;
    private final AutoCloseable authorizationResource;

    enum ProviderMode {
        GRPC,
        LOCAL_ONNX,
        NOP
    }

    record ProviderProfile(
            ProviderMode mode,
            String providerId,
            String modelId,
            String modelVersion,
            String modelDigest,
            String license,
            String executionHardware,
            String region,
            String status,
            String reason) {}

    public ProductionSttGrpcService(MeterRegistry metrics) {
        this(metrics, null);
    }

    /** Runtime integration seam; current STT RPCs remain not admitted without versioned rights inputs. */
    public ProductionSttGrpcService(MeterRegistry metrics, MediaProcessingRuntimePort mediaRuntimePort) {
        this(composition(System.getenv(), metrics, mediaRuntimePort));
    }

    private ProductionSttGrpcService(Composition composition) {
        super(composition.library(), composition.metrics(), composition.tracer(),
                composition.authorization());
        this.ownedLibrary = composition.library();
        this.mediaRuntimePort = composition.mediaRuntimePort();
        this.authorizationResource = composition.authorizationResource();
    }

    private record Composition(
            AudioVideoLibrary library,
            MeterRegistry metrics,
            Tracer tracer,
            SttRequestAuthorization authorization,
            MediaProcessingRuntimePort mediaRuntimePort,
            AutoCloseable authorizationResource) { }

    private static Composition composition(
            Map<String, String> environment,
            MeterRegistry metrics,
            MediaProcessingRuntimePort mediaRuntimePort) {
        AudioVideoLibrary library = createInitializedLibrary(environment);
        try {
            AuthorizationComposition authorization = productionAuthorization(environment);
            return new Composition(library, metrics,
                    io.opentelemetry.api.GlobalOpenTelemetry.getTracer("ghatana-media-stt"),
                    authorization.authorization(), mediaRuntimePort, authorization.resource());
        } catch (RuntimeException failure) {
            library.close();
            throw failure;
        }
    }

    private record AuthorizationComposition(
            SttRequestAuthorization authorization, AutoCloseable resource) { }

    /**
     * Composes the canonical Shared policy + Media source-rights authorization when a ready
     * rights administration and an open Shared policy engine are installed on this runtime.
     * Any missing or unready authority keeps the fail-closed unavailable authorization; a
     * production-like profile additionally requires a production-eligible record store.
     */
    private static AuthorizationComposition productionAuthorization(Map<String, String> environment) {
        String profile = firstNonBlank(
                environment.get("MEDIA_RUNTIME_ENVIRONMENT"),
                environment.get("MEDIA_PROFILE"),
                "local");
        boolean productionLike = productionLike(profile);
        MediaSourceRightsAdministration administration = null;
        try {
            for (MediaSourceRightsAdministration candidate
                    : ServiceLoader.load(MediaSourceRightsAdministration.class)) {
                try {
                    if (candidate != null && candidate.ready()
                            && (!productionLike || candidate.productionEligible())) {
                        administration = candidate;
                        break;
                    }
                } catch (RuntimeException unavailable) { }
            }
        } catch (RuntimeException | ServiceConfigurationError unavailable) { }
        PolicyEngine engine = null;
        try {
            for (PolicyEngine candidate : ServiceLoader.load(PolicyEngine.class)) {
                try {
                    if (candidate != null && candidate.isOpen()) {
                        engine = candidate;
                        break;
                    }
                } catch (RuntimeException unavailable) { }
            }
        } catch (RuntimeException | ServiceConfigurationError unavailable) { }
        if (administration == null || engine == null) {
            safeClose(administration);
            return new AuthorizationComposition(SttRequestAuthorization.unavailable(), null);
        }
        return new AuthorizationComposition(
                new SharedPolicySttRequestAuthorization(
                        engine,
                        new MediaRuntimeSttRightsSourceResolver(administration, Clock.systemUTC()),
                        Duration.ofSeconds(10)),
                administration);
    }

    private static void safeClose(AutoCloseable closeable) {
        if (closeable == null) return;
        try {
            closeable.close();
        } catch (Exception ignored) { }
    }

    ProductionSttGrpcService(AudioVideoLibrary library, MeterRegistry metrics) {
        this(library, metrics, SttRequestAuthorization.unavailable());
    }

    ProductionSttGrpcService(AudioVideoLibrary library, MeterRegistry metrics,
            SttRequestAuthorization requestAuthorization) {
        this(library, metrics, io.opentelemetry.api.GlobalOpenTelemetry.getTracer("ghatana-media-stt"),
                requestAuthorization, null);
    }

    ProductionSttGrpcService(AudioVideoLibrary library, MeterRegistry metrics, Tracer tracer) {
        this(library, metrics, tracer, SttRequestAuthorization.unavailable(), null);
    }

    ProductionSttGrpcService(AudioVideoLibrary library, MeterRegistry metrics, Tracer tracer,
                             SttRequestAuthorization requestAuthorization,
                             MediaProcessingRuntimePort mediaRuntimePort) {
        super(library, metrics, tracer, requestAuthorization);
        this.ownedLibrary = Objects.requireNonNull(library, "library");
        this.mediaRuntimePort = mediaRuntimePort;
        this.authorizationResource = null;
    }

    MediaProcessingRuntimePort mediaRuntimePort() { return mediaRuntimePort; }

    @Override
    protected boolean isProviderReady() {
        // Engine health describes the local ONNX runtime only. It cannot establish
        // provider-profile admission, license, or quality qualification. Until the
        // trusted admission source is composed here, readiness must remain false.
        return false;
    }

    static SttConfig createConfig(Map<String, String> environment) {
        Objects.requireNonNull(environment, "environment");
        ProviderProfile providerProfile = resolveProviderProfile(environment);
        if (!"ADMITTED".equals(providerProfile.status())) {
            throw new IllegalStateException(
                    "STT_PROVIDER_NOT_ADMITTED: " + providerProfile.reason());
        }
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

    /** Resolve a strict, explicit backend selection without promoting metadata to admission. */
    static ProviderProfile resolveProviderProfile(Map<String, String> environment) {
        Objects.requireNonNull(environment, "environment");
        String configuredMode = environment.get("STT_PROVIDER_MODE");
        if (configuredMode == null || configuredMode.isBlank()) {
            throw new IllegalArgumentException(
                    "STT_PROVIDER_MODE must explicitly select GRPC, LOCAL_ONNX, or NOP");
        }

        ProviderMode mode;
        try {
            mode = ProviderMode.valueOf(configuredMode.trim().toUpperCase(java.util.Locale.ROOT));
        } catch (IllegalArgumentException failure) {
            throw new IllegalArgumentException(
                    "Unsupported STT_PROVIDER_MODE; expected GRPC, LOCAL_ONNX, or NOP");
        }

        return switch (mode) {
            case GRPC -> resolveGrpcProfile(environment);
            case LOCAL_ONNX -> resolveLocalProfile(environment);
            case NOP -> {
                rejectModeMismatch(environment, "NOP");
                yield new ProviderProfile(
                        mode, "stt-disabled", "", "", "", "", "", "",
                        "NOT_ADMITTED", "NOP intentionally disables transcription");
            }
        };
    }

    private static ProviderProfile resolveGrpcProfile(Map<String, String> environment) {
        rejectLocalSettings(environment);
        required(environment, "STT_GRPC_HOST");
        integer(environment, "STT_GRPC_PORT", 50051, 1, 65_535);
        String transport = firstNonBlank(environment.get("STT_GRPC_TRANSPORT_MODE"), null, "tls");
        if (!transport.equalsIgnoreCase("tls") && !transport.equalsIgnoreCase("mtls")) {
            throw new IllegalArgumentException(
                    "STT_GRPC_TRANSPORT_MODE must be tls or mtls for the GRPC provider");
        }
        String modelId = required(environment, "STT_GRPC_MODEL_ID");
        String version = required(environment, "STT_GRPC_MODEL_VERSION");
        String digest = requiredDigest(environment, "STT_GRPC_MODEL_SHA256");
        String license = required(environment, "STT_GRPC_MODEL_LICENSE");
        String hardware = required(environment, "STT_GRPC_EXECUTION_HARDWARE");
        String region = required(environment, "STT_GRPC_MODEL_REGION");
        return new ProviderProfile(
                ProviderMode.GRPC,
                "stt-upstream-grpc",
                modelId,
                version,
                digest,
                license,
                hardware,
                region,
                "NOT_ADMITTED",
                "No upstream gRPC provider adapter is composed in the STT server runtime");
    }

    private static ProviderProfile resolveLocalProfile(Map<String, String> environment) {
        rejectGrpcSettings(environment);
        String modelId = required(environment, "STT_MODEL_ID");
        String version = required(environment, "STT_MODEL_VERSION");
        String expectedDigest = requiredDigest(environment, "STT_MODEL_SHA256");
        String license = required(environment, "STT_MODEL_LICENSE");
        String hardware = required(environment, "STT_EXECUTION_HARDWARE");
        String region = required(environment, "STT_MODEL_REGION");
        Path modelPath = Path.of(required(environment, "STT_MODEL_PATH")).toAbsolutePath().normalize();
        if (Files.isSymbolicLink(modelPath)
                || !Files.isRegularFile(modelPath)
                || !Files.isReadable(modelPath)) {
            throw new IllegalArgumentException(
                    "STT_MODEL_PATH must be a readable regular non-symlink file");
        }
        String actualDigest = sha256(modelPath);
        if (!actualDigest.equalsIgnoreCase(expectedDigest)) {
            throw new IllegalArgumentException("STT_MODEL_SHA256 does not match the configured model file");
        }
        return new ProviderProfile(
                ProviderMode.LOCAL_ONNX,
                "stt-local-onnx",
                modelId,
                version,
                actualDigest,
                license,
                hardware,
                region,
                "NOT_ADMITTED",
                "No source-authorized local STT model license and quality qualification is admitted");
    }

    private static void rejectModeMismatch(Map<String, String> environment, String mode) {
        // STT_GRPC_PORT is also the service's local listener port from its image
        // defaults; it cannot establish or distinguish an upstream provider.
        if (mode.equals("NOP")
                && (hasAny(environment, "STT_MODEL_PATH", "STT_MODEL_ID", "STT_MODEL_VERSION",
                        "STT_MODEL_SHA256", "STT_MODEL_LICENSE", "STT_EXECUTION_HARDWARE",
                        "STT_MODEL_REGION", "STT_GRPC_HOST"))) {
            throw new IllegalArgumentException("STT provider settings do not match NOP mode");
        }
    }

    private static void rejectLocalSettings(Map<String, String> environment) {
        if (hasAny(environment, "STT_MODEL_PATH", "STT_MODEL_ID", "STT_MODEL_VERSION",
                "STT_MODEL_SHA256", "STT_MODEL_LICENSE", "STT_EXECUTION_HARDWARE", "STT_MODEL_REGION")) {
            throw new IllegalArgumentException("Local model settings do not match GRPC provider mode");
        }
    }

    private static void rejectGrpcSettings(Map<String, String> environment) {
        if (hasAny(environment, "STT_GRPC_HOST", "STT_GRPC_TRANSPORT_MODE",
                "STT_GRPC_MODEL_ID", "STT_GRPC_MODEL_VERSION", "STT_GRPC_MODEL_SHA256",
                "STT_GRPC_MODEL_LICENSE", "STT_GRPC_EXECUTION_HARDWARE", "STT_GRPC_MODEL_REGION")) {
            throw new IllegalArgumentException("gRPC provider settings do not match LOCAL_ONNX provider mode");
        }
    }

    private static boolean hasAny(Map<String, String> environment, String... keys) {
        for (String key : keys) {
            String value = environment.get(key);
            if (value != null && !value.isBlank()) return true;
        }
        return false;
    }

    private static String required(Map<String, String> environment, String key) {
        String value = environment.get(key);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(key + " is required for the selected STT provider");
        }
        return value.trim();
    }

    private static String requiredDigest(Map<String, String> environment, String key) {
        String digest = required(environment, key);
        if (!digest.matches("(?i)[0-9a-f]{64}")) {
            throw new IllegalArgumentException(key + " must be a 64-character SHA-256 digest");
        }
        return digest.toLowerCase(java.util.Locale.ROOT);
    }

    private static String sha256(Path path) {
        try (var input = Files.newInputStream(path)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[16 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                digest.update(buffer, 0, count);
            }
            return HexFormat.of().formatHex(digest.digest());
        } catch (IOException failure) {
            throw new IllegalArgumentException("Unable to read configured STT model file", failure);
        } catch (NoSuchAlgorithmException failure) {
            throw new IllegalStateException("SHA-256 is unavailable", failure);
        }
    }

    @Override
    public void unloadModel(
            UnloadModelRequest request,
            StreamObserver<UnloadModelResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipalWithMetrics(responseObserver)) return;
        unimplemented(responseObserver, "Model unload is not supported by the single-model STT provider");
    }

    @Override
    public void adaptModel(
            AdaptRequest request,
            StreamObserver<AdaptResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipalWithMetrics(responseObserver)) return;
        responseObserver.onError(Status.FAILED_PRECONDITION
                .withDescription("STT_ADAPTATION_NOT_ADMITTED: versioned transcript correction, trusted rights admission and an admitted adaptation provider are unavailable")
                .asRuntimeException());
    }

    @Override
    public void createProfile(
            CreateProfileRequest request,
            StreamObserver<ProfileResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipalWithMetrics(responseObserver)) return;
        if (!authorizeRequest(responseObserver,
                SttRequestAuthorization.Operation.CREATE_SPEAKER_IDENTITY, null)) return;
        speakerProfileNotAdmitted(responseObserver);
    }

    @Override
    public void getProfile(
            GetProfileRequest request,
            StreamObserver<ProfileResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipalWithMetrics(responseObserver)) return;
        if (!authorizeRequest(responseObserver,
                SttRequestAuthorization.Operation.READ_SPEAKER_IDENTITY, request.getProfileId())) return;
        speakerProfileNotAdmitted(responseObserver);
    }

    @Override
    public void updateProfile(
            UpdateProfileRequest request,
            StreamObserver<ProfileResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipalWithMetrics(responseObserver)) return;
        if (!authorizeRequest(responseObserver,
                SttRequestAuthorization.Operation.UPDATE_SPEAKER_IDENTITY, request.getProfileId())) return;
        speakerProfileNotAdmitted(responseObserver);
    }

    @Override
    public void submitCorrection(
            CorrectionRequest request,
            StreamObserver<CorrectionResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipalWithMetrics(responseObserver)) return;
        responseObserver.onError(Status.FAILED_PRECONDITION
                .withDescription("STT_CORRECTION_NOT_ADMITTED: immutable transcript revision store and expected-version CAS are unavailable")
                .asRuntimeException());
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
        try {
            safeClose(authorizationResource);
        } finally {
            ownedLibrary.close();
        }
    }

    private static <T> void unimplemented(StreamObserver<T> observer, String message) {
        observer.onError(Status.UNIMPLEMENTED.withDescription(message).asRuntimeException());
    }

    private static void speakerProfileNotAdmitted(StreamObserver<ProfileResponse> observer) {
        observer.onError(Status.FAILED_PRECONDITION
                .withDescription("STT_SPEAKER_PROFILE_NOT_ADMITTED: trusted rights, purpose, consent, embedding and tenant-scoped persistence admission are unavailable")
                .asRuntimeException());
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
