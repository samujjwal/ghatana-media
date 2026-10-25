package com.ghatana.stt.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.config.SttConfig;
import com.ghatana.media.stt.api.SttEngine;
import com.ghatana.media.stt.api.TranscriptionOptions;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.media.stt.api.UserProfile;
import com.ghatana.stt.service.SttAudioInputDecoder;
import com.ghatana.stt.core.grpc.proto.*;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.file.Paths;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * STT gRPC Service — bridges the proto STTService API to the platform SttEngine.
 *
 * @doc.type class
 * @doc.purpose gRPC facade for platform SttEngine
 * @doc.layer product
 * @doc.pattern Service
 */
public class SttGrpcService extends STTServiceGrpc.STTServiceImplBase {

    private static final Logger LOG = LoggerFactory.getLogger(SttGrpcService.class);

    private final AudioVideoLibrary library;
    private final Timer transcribeTimer;

    // AV-P1-004: Supported languages and sample-rate bounds (mirrors PersistentSttService constants).
    static final Set<String> SUPPORTED_LANGUAGES = Set.of(
        "en", "es", "fr", "de", "it", "pt", "nl", "pl", "ru", "zh", "ja", "ko", "ar", "hi", "tr");

    /**
     * Package-private constructor for unit testing — supply a pre-configured library.
     * Avoids native-library / file-system dependencies during tests.
     */
    SttGrpcService(AudioVideoLibrary library, MeterRegistry metrics) {
        this.library = library;
        this.transcribeTimer = Timer.builder("stt.transcribe")
            .description("Transcription latency")
            .publishPercentiles(0.50, 0.95, 0.99)
            .publishPercentileHistogram()
            .register(metrics);
    }

    /**
     * Public test hook for constructing the service with an injected library.
     */
    public static SttGrpcService forTesting(AudioVideoLibrary library, MeterRegistry metrics) {
        return new SttGrpcService(library, metrics);
    }

    public SttGrpcService(MeterRegistry metrics) {
        SttConfig config = SttConfig.builder()
            .modelPath(Paths.get(System.getenv().getOrDefault("STT_MODEL_PATH", "/models/whisper-base.onnx")))
            .modelId(System.getenv().getOrDefault("STT_MODEL_ID", "whisper-base"))
            .useGpu(Boolean.parseBoolean(System.getenv().getOrDefault("STT_USE_GPU", "true")))
            .maxConcurrentRequests(Integer.parseInt(System.getenv().getOrDefault("STT_MAX_CONCURRENT", "10")))
            .build();

        this.library = AudioVideoLibrary.builder().withSttConfig(config).build();
        this.transcribeTimer = Timer.builder("stt.transcribe")
            .description("Transcription latency")
            .publishPercentiles(0.50, 0.95, 0.99)
            .publishPercentileHistogram()
            .register(metrics);

        LOG.info("STT Service initialized with model: {}", config.modelId());
    }

    @Override
    public void transcribe(TranscribeRequest request, StreamObserver<TranscribeResponse> responseObserver) {
        String cid = cid();
        transcribeTimer.record(() -> {
            try {
                // Inspect the protobuf's declared byte count before creating another byte array.
                SttAudioInputDecoder.requireInputSize(request.getAudioData().size());
                byte[] audioBytes = request.getAudioData().toByteArray();

                    // AV-P1-004: Validate and resolve sample rate
                    int sampleRate = request.getSampleRate() > 0 ? request.getSampleRate() : 16_000;
                    SttAudioInputDecoder.requireSampleRate(sampleRate);

                    // AV-P1-004: Validate language if provided
                    String language = request.getLanguage();
                    if (language != null && !language.isBlank()) {
                        String langCode = language.toLowerCase(Locale.ROOT).split("-")[0];
                        if (!SUPPORTED_LANGUAGES.contains(langCode)) {
                            responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                                .withDescription("Unsupported language: " + language)
                                .asRuntimeException());
                            return;
                        }
                    }

                AudioData audio = SttAudioInputDecoder.decode(audioBytes, null, sampleRate);

                TranscriptionResult result;
                try (SttEngine stt = library.getSttEngine()) {
                    result = stt.transcribe(audio, transcriptionOptions(request));
                }

                TranscribeResponse.Builder mapped = SttTranscriptionResponseMapper.toProto(result, audio.duration());
                String elapsed = result.processingTime() == null
                        ? "unknown" : Long.toString(result.processingTime().toMillis());
                LOG.info("[{}] Transcribed: length={}, confidence={}, elapsed={}",
                    cid, mapped.getText().length(), result.confidence(), elapsed);

                responseObserver.onNext(mapped.build());
                responseObserver.onCompleted();
            } catch (SttTranscriptionResponseMapper.InvalidResultException e) {
                responseObserver.onError(io.grpc.Status.INTERNAL
                        .withDescription(e.getMessage()).asRuntimeException());
            } catch (SttAudioInputDecoder.InputException e) {
                io.grpc.Status status = switch (e.kind()) {
                    case INVALID_ARGUMENT -> io.grpc.Status.INVALID_ARGUMENT;
                    case RESOURCE_EXHAUSTED -> io.grpc.Status.RESOURCE_EXHAUSTED;
                    case NOT_ADMITTED -> io.grpc.Status.FAILED_PRECONDITION;
                };
                responseObserver.onError(status.withDescription(e.getMessage()).asRuntimeException());
            } catch (com.ghatana.media.common.ValidationError e) {
                responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT.withDescription(e.getMessage()).asRuntimeException());
            } catch (com.ghatana.media.common.InferenceError e) {
                io.grpc.Status status = e.isRetryable() ? io.grpc.Status.UNAVAILABLE : io.grpc.Status.INTERNAL;
                responseObserver.onError(status.withDescription(e.getMessage()).asRuntimeException());
            } catch (Exception e) {
                LOG.error("[{}] Unexpected error: {}", cid, e.getMessage(), e);
                responseObserver.onError(io.grpc.Status.INTERNAL.withDescription("Internal error").asRuntimeException());
            }
        });
    }

    @Override
    public StreamObserver<AudioChunk> streamTranscribe(StreamObserver<Transcription> responseObserver) {
        String tenantId = com.ghatana.audio.video.common.security.JwtServerInterceptor.CTX_TENANT.get();
        String principalId = com.ghatana.audio.video.common.security.JwtServerInterceptor.CTX_SUBJECT.get();
        if (tenantId == null || tenantId.isBlank() || principalId == null || principalId.isBlank()) {
            responseObserver.onError(io.grpc.Status.UNAUTHENTICATED
                    .withDescription("STT_STREAM_IDENTITY_REQUIRED: authenticated tenant and subject are required")
                    .asRuntimeException());
            return noOpAudioObserver();
        }
        try {
            UUID.fromString(principalId);
        } catch (IllegalArgumentException invalidPrincipal) {
            responseObserver.onError(io.grpc.Status.UNAUTHENTICATED
                    .withDescription("STT_STREAM_IDENTITY_INVALID: authenticated subject is not a supported principal identifier")
                    .asRuntimeException());
            return noOpAudioObserver();
        }

        // Stream-session state is owned by MediaRuntime and requires a trusted consent/purpose
        // decision. This service has neither runtime injection nor an admission authority, so it
        // must stop before creating a model session or dispatching audio.
        responseObserver.onError(io.grpc.Status.FAILED_PRECONDITION
                .withDescription("STT_STREAM_CONSENT_NOT_ADMITTED: trusted purpose and consent admission are unavailable")
                .asRuntimeException());
        return noOpAudioObserver();
    }

    private static StreamObserver<AudioChunk> noOpAudioObserver() {
        return new StreamObserver<>() {
            @Override public void onNext(AudioChunk value) { }
            @Override public void onError(Throwable error) { }
            @Override public void onCompleted() { }
        };
    }

    private static TranscriptionOptions transcriptionOptions(TranscribeRequest request) {
        TranscriptionOptions.Builder options = TranscriptionOptions.builder();
        if (request.hasOptions()) {
            var wireOptions = request.getOptions();
            if (wireOptions.getMaxAlternatives() > SttTranscriptionResponseMapper.MAX_ALTERNATIVES) {
                throw new SttAudioInputDecoder.InputException(
                        SttAudioInputDecoder.FailureKind.INVALID_ARGUMENT,
                        "STT_OPTIONS_ALTERNATIVE_LIMIT: max_alternatives exceeds the supported limit of "
                                + SttTranscriptionResponseMapper.MAX_ALTERNATIVES);
            }
            options.enablePunctuation(wireOptions.getEnablePunctuation())
                    .enableTimestamps(wireOptions.getEnableWordTimings())
                    .maxAlternatives(Math.max(1, wireOptions.getMaxAlternatives()));
        }
        if (request.getLanguage() != null && !request.getLanguage().isBlank()) {
            options.language(Locale.forLanguageTag(request.getLanguage()));
        }
        return options.build();
    }

    @Override
    public void getStatus(StatusRequest request, StreamObserver<StatusResponse> responseObserver) {
        try (SttEngine stt = library.getSttEngine()) {
            com.ghatana.media.common.EngineStatus status = stt.getStatus();
            responseObserver.onNext(StatusResponse.newBuilder()
                .setActiveModel(status.modelId() != null ? status.modelId() : "")
                .build());
            responseObserver.onCompleted();
        } catch (Exception e) {
            responseObserver.onError(io.grpc.Status.INTERNAL.withDescription("Status unavailable").asRuntimeException());
        }
    }

    @Override
    public void healthCheck(HealthCheckRequest request, StreamObserver<HealthCheckResponse> responseObserver) {
        // An engine status alone does not establish service readiness: the canonical
        // composition has not wired provider/model checks and shutdown state yet.
        responseObserver.onNext(HealthCheckResponse.newBuilder()
            .setStatus(HealthStatus.HEALTH_STATUS_UNHEALTHY)
            .setMessage("STT_READINESS_NOT_ADMITTED: provider and model readiness checks are not wired")
            .build());
        responseObserver.onCompleted();
    }

    // ── AV-001.1: loadModel ────────────────────────────────────────────────

    @Override
    public void loadModel(LoadModelRequest request, StreamObserver<LoadModelResponse> responseObserver) {
        String modelId = request.getModelId();
        if (modelId == null || modelId.isBlank()) {
            responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                .withDescription("modelId must not be blank")
                .asRuntimeException());
            return;
        }
        long start = System.currentTimeMillis();
        try (SttEngine stt = library.getSttEngine()) {
            stt.loadModel(modelId);
            long loadTimeMs = System.currentTimeMillis() - start;

            long memoryBytes = stt.getMetrics().memoryUsageBytes();

            LOG.info("STT model loaded: {} in {}ms", modelId, loadTimeMs);
            responseObserver.onNext(LoadModelResponse.newBuilder()
                .setSuccess(true)
                .setMessage("Model loaded successfully: " + modelId)
                .setModelId(modelId)
                .setLoadTimeMs(loadTimeMs)
                .setMemoryUsageBytes(memoryBytes)
                .build());
            responseObserver.onCompleted();
        } catch (com.ghatana.media.common.ModelLoadingError e) {
            LOG.warn("Failed to load STT model {}: {}", modelId, e.getMessage());
            responseObserver.onError(io.grpc.Status.NOT_FOUND
                .withDescription("Model not found or cannot be loaded: " + modelId)
                .asRuntimeException());
        } catch (Exception e) {
            LOG.error("Unexpected error loading STT model {}: {}", modelId, e.getMessage(), e);
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("Failed to load model: " + e.getMessage())
                .asRuntimeException());
        }
    }

    // ── AV-001.2: unloadModel ──────────────────────────────────────────────

    @Override
    public void unloadModel(UnloadModelRequest request, StreamObserver<UnloadModelResponse> responseObserver) {
        String modelId = request.getModelId();
        if (modelId == null || modelId.isBlank()) {
            responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                .withDescription("modelId must not be blank")
                .asRuntimeException());
            return;
        }
        try (SttEngine stt = library.getSttEngine()) {
            // Validate model exists before attempting to unload
            List<com.ghatana.media.stt.api.ModelInfo> models = stt.getAvailableModels();
            boolean found = models.stream().anyMatch(m -> modelId.equals(m.modelId()));
            if (!found) {
                responseObserver.onError(io.grpc.Status.NOT_FOUND
                    .withDescription("Model not found: " + modelId)
                    .asRuntimeException());
                return;
            }
            // SttEngine exposes no unload operation. Merely observing the model and its
            // memory counters cannot establish that it was unloaded, so fail explicitly.
            responseObserver.onError(io.grpc.Status.UNIMPLEMENTED
                .withDescription("Model unload is not supported by the active STT engine")
                .asRuntimeException());
        } catch (Exception e) {
            LOG.error("Error unloading STT model {}: {}", modelId, e.getMessage(), e);
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("Failed to unload model: " + e.getMessage())
                .asRuntimeException());
        }
    }

    // ── AV-001.3: listModels ───────────────────────────────────────────────

    @Override
    public void listModels(ListModelsRequest request, StreamObserver<ListModelsResponse> responseObserver) {
        try (SttEngine stt = library.getSttEngine()) {
            List<com.ghatana.media.stt.api.ModelInfo> models = stt.getAvailableModels();
            com.ghatana.media.stt.api.ModelInfo activeModel = stt.getActiveModel();

            ListModelsResponse.Builder builder = ListModelsResponse.newBuilder();
            int loadedCount = 0;

            for (com.ghatana.media.stt.api.ModelInfo m : models) {
                // Apply language filter if provided
                if (!request.getLanguageFilter().isBlank()) {
                    Locale filterLocale = Locale.forLanguageTag(request.getLanguageFilter());
                    boolean matchesLanguage = false;
                    for (Locale lang : m.supportedLanguages()) {
                        if (lang.getLanguage().equals(filterLocale.getLanguage())) {
                            matchesLanguage = true;
                            break;
                        }
                    }
                    if (!matchesLanguage) continue;
                }

                boolean isLoaded = activeModel != null && activeModel.modelId().equals(m.modelId());
                if (request.getIncludeLoadedOnly() && !isLoaded) continue;
                if (isLoaded) loadedCount++;

                List<String> langs = new ArrayList<>();
                for (Locale locale : m.supportedLanguages()) {
                    langs.add(locale.toLanguageTag());
                }

                builder.addModels(ModelInfo.newBuilder()
                    .setModelId(m.modelId())
                    .setName(m.name())
                    .setVersion(m.version())
                    .addAllLanguages(langs)
                    .setSizeBytes(m.sizeBytes())
                    .setIsLoaded(isLoaded)
                    .build());
            }

            builder.setTotalCount(builder.getModelsCount());
            builder.setLoadedCount(loadedCount);

            LOG.debug("Listed {} STT models (loaded={})", builder.getTotalCount(), loadedCount);
            responseObserver.onNext(builder.build());
            responseObserver.onCompleted();
        } catch (Exception e) {
            LOG.error("Failed to list STT models: {}", e.getMessage(), e);
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("Failed to list models: " + e.getMessage())
                .asRuntimeException());
        }
    }

    // ── AV-001.4: adaptModel ───────────────────────────────────────────────

    @Override
    public void adaptModel(AdaptRequest request, StreamObserver<AdaptResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipal(responseObserver)) return;
        responseObserver.onError(io.grpc.Status.FAILED_PRECONDITION
                .withDescription("STT_ADAPTATION_NOT_ADMITTED: versioned transcript correction, trusted rights admission and an admitted adaptation provider are unavailable")
                .asRuntimeException());
    }

    // ── AV-001.5: createProfile ────────────────────────────────────────────

    @Override
    public void createProfile(CreateProfileRequest request, StreamObserver<ProfileResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipal(responseObserver)) return;
        speakerProfileNotAdmitted(responseObserver);
    }

    // ── AV-001.6: getProfile ───────────────────────────────────────────────

    @Override
    public void getProfile(GetProfileRequest request, StreamObserver<ProfileResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipal(responseObserver)) return;
        speakerProfileNotAdmitted(responseObserver);
    }

    // ── AV-001.7: updateProfile ────────────────────────────────────────────

    @Override
    public void updateProfile(UpdateProfileRequest request, StreamObserver<ProfileResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipal(responseObserver)) return;
        speakerProfileNotAdmitted(responseObserver);
    }

    private static void speakerProfileNotAdmitted(StreamObserver<ProfileResponse> responseObserver) {
        responseObserver.onError(io.grpc.Status.FAILED_PRECONDITION
                .withDescription("STT_SPEAKER_PROFILE_NOT_ADMITTED: trusted rights, purpose, consent, embedding and tenant-scoped persistence admission are unavailable")
                .asRuntimeException());
    }

    @Override
    public void submitCorrection(CorrectionRequest request, StreamObserver<CorrectionResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipal(responseObserver)) return;
        responseObserver.onError(io.grpc.Status.FAILED_PRECONDITION
                .withDescription("STT_CORRECTION_NOT_ADMITTED: immutable transcript revision store and expected-version CAS are unavailable")
                .asRuntimeException());
    }

    protected static boolean requireAuthenticatedTenantPrincipal(StreamObserver<?> observer) {
        String tenantId = com.ghatana.audio.video.common.security.JwtServerInterceptor.CTX_TENANT.get();
        String principalId = com.ghatana.audio.video.common.security.JwtServerInterceptor.CTX_SUBJECT.get();
        if (tenantId == null || tenantId.isBlank() || principalId == null || principalId.isBlank()) {
            observer.onError(io.grpc.Status.UNAUTHENTICATED
                    .withDescription("STT_IDENTITY_REQUIRED: authenticated tenant and subject are required")
                    .asRuntimeException());
            return false;
        }
        try {
            UUID.fromString(principalId);
        } catch (IllegalArgumentException invalidPrincipal) {
            observer.onError(io.grpc.Status.UNAUTHENTICATED
                    .withDescription("STT_IDENTITY_INVALID: authenticated subject is not a supported principal identifier")
                    .asRuntimeException());
            return false;
        }
        return true;
    }

    private static String cid() {
        return UUID.randomUUID().toString().substring(0, 8);
    }
}
