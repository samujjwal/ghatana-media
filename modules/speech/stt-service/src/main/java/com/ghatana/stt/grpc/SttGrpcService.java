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
import com.ghatana.audiovideo.observability.MediaWorkflowMetrics;
import com.ghatana.audiovideo.observability.instrumentation.AudioVideoGrpcInstrumentation;
import com.ghatana.audiovideo.observability.tracing.AudioVideoTracingService;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Scope;
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
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.BooleanSupplier;

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
    private final AudioVideoGrpcInstrumentation boundaryInstrumentation;
    private final AudioVideoTracingService tracingService;
    private final int maxAudioLengthSeconds;
    private final SttRequestAuthorization requestAuthorization;
    private volatile BooleanSupplier readinessProbe = this::isProviderReady;

    // AV-P1-004: Supported languages and sample-rate bounds (mirrors PersistentSttService constants).
    static final Set<String> SUPPORTED_LANGUAGES = Set.of(
        "en", "es", "fr", "de", "it", "pt", "nl", "pl", "ru", "zh", "ja", "ko", "ar", "hi", "tr");

    /**
     * Package-private constructor for unit testing — supply a pre-configured library.
     * Avoids native-library / file-system dependencies during tests.
     */
    SttGrpcService(AudioVideoLibrary library, MeterRegistry metrics) {
        this(library, metrics, SttAudioInputDecoder.DEFAULT_MAX_AUDIO_LENGTH_SECONDS,
                GlobalOpenTelemetry.getTracer("ghatana-media-stt"), SttRequestAuthorization.unavailable());
    }

    SttGrpcService(AudioVideoLibrary library, MeterRegistry metrics, Tracer tracer) {
        this(library, metrics, SttAudioInputDecoder.DEFAULT_MAX_AUDIO_LENGTH_SECONDS, tracer,
                SttRequestAuthorization.unavailable());
    }

    SttGrpcService(AudioVideoLibrary library, MeterRegistry metrics,
            SttRequestAuthorization requestAuthorization) {
        this(library, metrics, SttAudioInputDecoder.DEFAULT_MAX_AUDIO_LENGTH_SECONDS,
                GlobalOpenTelemetry.getTracer("ghatana-media-stt"), requestAuthorization);
    }

    SttGrpcService(AudioVideoLibrary library, MeterRegistry metrics, Tracer tracer,
            SttRequestAuthorization requestAuthorization) {
        this(library, metrics, SttAudioInputDecoder.DEFAULT_MAX_AUDIO_LENGTH_SECONDS, tracer,
                requestAuthorization);
    }

    private SttGrpcService(
            AudioVideoLibrary library, MeterRegistry metrics, int maxAudioLengthSeconds, Tracer tracer,
            SttRequestAuthorization requestAuthorization) {
        this.library = library;
        this.maxAudioLengthSeconds = maxAudioLengthSeconds;
        this.requestAuthorization = Objects.requireNonNull(requestAuthorization, "requestAuthorization");
        this.tracingService = new AudioVideoTracingService(Objects.requireNonNull(tracer, "tracer"));
        this.boundaryInstrumentation = new AudioVideoGrpcInstrumentation(
                null, new MediaWorkflowMetrics(metrics, "stt"));
        this.transcribeTimer = Timer.builder("stt.transcribe")
            .description("Transcription latency")
            .publishPercentiles(0.50, 0.95, 0.99)
            .publishPercentileHistogram()
            .register(metrics);
    }

    public SttGrpcService(MeterRegistry metrics) {
        SttConfig config = SttConfig.builder()
            .modelPath(Paths.get(System.getenv().getOrDefault("STT_MODEL_PATH", "/models/whisper-base.onnx")))
            .modelId(System.getenv().getOrDefault("STT_MODEL_ID", "whisper-base"))
            .useGpu(Boolean.parseBoolean(System.getenv().getOrDefault("STT_USE_GPU", "true")))
            .maxConcurrentRequests(Integer.parseInt(System.getenv().getOrDefault("STT_MAX_CONCURRENT", "10")))
            .build();

        this.library = AudioVideoLibrary.builder().withSttConfig(config).build();
        this.maxAudioLengthSeconds = config.maxAudioLengthSeconds();
        this.requestAuthorization = SttRequestAuthorization.unavailable();
        this.tracingService = new AudioVideoTracingService(GlobalOpenTelemetry.getTracer("ghatana-media-stt"));
        this.boundaryInstrumentation = new AudioVideoGrpcInstrumentation(
                null, new MediaWorkflowMetrics(metrics, "stt"));
        this.transcribeTimer = Timer.builder("stt.transcribe")
            .description("Transcription latency")
            .publishPercentiles(0.50, 0.95, 0.99)
            .publishPercentileHistogram()
            .register(metrics);

        LOG.info("STT service initialized");
    }

    @Override
    public void transcribe(TranscribeRequest request, StreamObserver<TranscribeResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipalWithMetrics(responseObserver)) return;
        if (!authorizeRequest(responseObserver, SttRequestAuthorization.Operation.TRANSCRIBE, request.getArtifactId())) return;
        Span span = tracingService.startTranscriptionSpan(null, null, request.getLanguage());
        TracingObserver<TranscribeResponse> tracedObserver = new TracingObserver<>(
                responseObserver, tracingService, span);
        try (Scope ignored = tracingService.createScope(span)) {
        transcribeTimer.record(() -> {
            try {
                // Inspect the protobuf's declared byte count before creating another byte array.
                SttAudioInputDecoder.requireInputSize(request.getAudioData().size());
                byte[] audioBytes = request.getAudioData().toByteArray();

                    // AV-P1-004: Validate and resolve sample rate
                    int sampleRate = request.getSampleRate() == 0 ? 16_000 : request.getSampleRate();
                    SttAudioInputDecoder.requireSampleRate(sampleRate);

                    // AV-P1-004: Validate language if provided
                    String language = request.getLanguage();
                    if (language != null && !language.isBlank()) {
                        String langCode = language.toLowerCase(Locale.ROOT).split("-")[0];
                        if (!SUPPORTED_LANGUAGES.contains(langCode)) {
                            tracedObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                                .withDescription("Unsupported language")
                                .asRuntimeException());
                            return;
                        }
                    }

                AudioData audio = decodeAudio(audioBytes, sampleRate);

                TranscriptionResult result;
                try (SttEngine stt = library.getSttEngine()) {
                    try (AudioVideoGrpcInstrumentation.BoundaryMeasurement measurement =
                                 boundaryInstrumentation.beginBoundaryMeasurement(
                                         MediaWorkflowMetrics.Modality.STT,
                                         MediaWorkflowMetrics.Boundary.PROVIDER)) {
                        result = stt.transcribe(audio, transcriptionOptions(request));
                        if (result != null && !isCancelled(responseObserver)) {
                            measurement.complete(MediaWorkflowMetrics.Outcome.SUCCESS);
                        }
                    }
                }

                try (AudioVideoGrpcInstrumentation.BoundaryMeasurement responseBoundary =
                             boundaryInstrumentation.beginBoundaryMeasurement(
                                     MediaWorkflowMetrics.Modality.STT,
                                     MediaWorkflowMetrics.Boundary.RESPONSE)) {
                    if (isCancelled(responseObserver)) {
                        tracedObserver.finishUnknown();
                        return;
                    }

                    final TranscribeResponse response;
                    try {
                        response = SttTranscriptionResponseMapper.toProto(result, audio).build();
                    } catch (SttTranscriptionResponseMapper.InvalidResultException invalidResult) {
                        responseBoundary.complete(MediaWorkflowMetrics.Outcome.FAILURE);
                        throw invalidResult;
                    }

                    try {
                        tracedObserver.onNext(response);
                        tracedObserver.onCompleted();
                        responseBoundary.complete(MediaWorkflowMetrics.Outcome.SUCCESS);
                    } catch (RuntimeException ambiguousDelivery) {
                        responseBoundary.complete(MediaWorkflowMetrics.Outcome.UNKNOWN);
                        throw ambiguousDelivery;
                    }
                }
            } catch (SttTranscriptionResponseMapper.InvalidResultException e) {
                tracedObserver.onError(io.grpc.Status.INTERNAL
                        .withDescription("Invalid transcription result").asRuntimeException());
            } catch (SttAudioInputDecoder.InputException e) {
                io.grpc.Status status = switch (e.kind()) {
                    case INVALID_ARGUMENT -> io.grpc.Status.INVALID_ARGUMENT;
                    case RESOURCE_EXHAUSTED -> io.grpc.Status.RESOURCE_EXHAUSTED;
                    case NOT_ADMITTED -> io.grpc.Status.FAILED_PRECONDITION;
                };
                String description = switch (e.kind()) {
                    case INVALID_ARGUMENT -> "Invalid audio input";
                    case RESOURCE_EXHAUSTED -> "Audio input exceeds the supported limit";
                    case NOT_ADMITTED -> "Audio input format is not admitted";
                };
                tracedObserver.onError(status.withDescription(description).asRuntimeException());
            } catch (com.ghatana.media.common.ValidationError e) {
                tracedObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                        .withDescription("Invalid transcription request").asRuntimeException());
            } catch (com.ghatana.media.common.InferenceError e) {
                io.grpc.Status status = e.isRetryable() ? io.grpc.Status.UNAVAILABLE : io.grpc.Status.INTERNAL;
                String description = e.isRetryable()
                        ? "Transcription provider temporarily unavailable"
                        : "Transcription failed";
                tracedObserver.onError(status.withDescription(description).asRuntimeException());
            } catch (Exception e) {
                LOG.error("STT transcription failed failureType={}", failureType(e));
                tracedObserver.onError(io.grpc.Status.INTERNAL.withDescription("Internal error").asRuntimeException());
            }
        });
        } finally {
            tracedObserver.finishUnknown();
        }
    }

    private static final class TracingObserver<T> implements StreamObserver<T> {
        private final StreamObserver<T> delegate;
        private final AudioVideoTracingService tracingService;
        private final Span span;
        private final long startedNanos = System.nanoTime();
        private final java.util.concurrent.atomic.AtomicBoolean terminal = new java.util.concurrent.atomic.AtomicBoolean();

        private TracingObserver(StreamObserver<T> delegate, AudioVideoTracingService tracingService, Span span) {
            this.delegate = delegate;
            this.tracingService = tracingService;
            this.span = span;
        }

        @Override public void onNext(T value) { delegate.onNext(value); }

        @Override
        public void onError(Throwable failure) {
            if (terminal.compareAndSet(false, true)) {
                Exception safeFailure = failure instanceof Exception exception
                        ? exception : new IllegalStateException("gRPC call failed");
                tracingService.recordError(span, safeFailure, elapsedMillis());
            }
            delegate.onError(failure);
        }

        @Override
        public void onCompleted() {
            if (terminal.compareAndSet(false, true)) tracingService.recordSuccess(span, elapsedMillis());
            delegate.onCompleted();
        }

        private void finishUnknown() {
            if (terminal.compareAndSet(false, true)) {
                span.setAttribute("media.outcome", "unknown");
                span.end();
            }
        }

        private long elapsedMillis() {
            return java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos);
        }
    }

    private static boolean isCancelled(StreamObserver<?> observer) {
        return observer instanceof io.grpc.stub.ServerCallStreamObserver<?> serverObserver
                && serverObserver.isCancelled();
    }

    private AudioData decodeAudio(byte[] input, int sampleRate) {
        return measureDecode(() -> SttAudioInputDecoder.decode(
                input, null, sampleRate, maxAudioLengthSeconds));
    }

    AudioData measureDecode(java.util.function.Supplier<AudioData> decoder) {
        Objects.requireNonNull(decoder, "decoder");
        try (AudioVideoGrpcInstrumentation.BoundaryMeasurement measurement =
                     boundaryInstrumentation.beginBoundaryMeasurement(
                             MediaWorkflowMetrics.Modality.STT,
                             MediaWorkflowMetrics.Boundary.DECODE)) {
            try {
                AudioData result = decoder.get();
                measurement.complete(MediaWorkflowMetrics.Outcome.SUCCESS);
                return result;
            } catch (IllegalArgumentException rejectedInput) {
                measurement.complete(MediaWorkflowMetrics.Outcome.FAILURE);
                throw rejectedInput;
            } catch (RuntimeException uncertainDecoderFailure) {
                measurement.complete(MediaWorkflowMetrics.Outcome.UNKNOWN);
                throw uncertainDecoderFailure;
            }
        }
    }

    @Override
    public StreamObserver<AudioChunk> streamTranscribe(StreamObserver<Transcription> responseObserver) {
        if (!requireAuthenticatedTenantPrincipalWithMetrics(responseObserver)) return noOpAudioObserver();
        String tenantId = JwtServerInterceptor.verifiedIdentity().tenantId();

        Span span = tracingService.startGrpcStreamingSpan("StreamTranscribe", tenantId);
        long startedNanos = System.nanoTime();

        if (!authorizeRequest(responseObserver, SttRequestAuthorization.Operation.STREAM_TRANSCRIBE, null)) {
            tracingService.recordError(span, new IllegalStateException("stream authorization denied"),
                    java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos));
            return noOpAudioObserver();
        }

        // No durable session store/provider session is wired to this service. Do not accept chunks
        // or imply ACK, reconnect, resume, or cancellation finality without that authority.
        try (AudioVideoGrpcInstrumentation.BoundaryMeasurement responseBoundary =
                     boundaryInstrumentation.beginBoundaryMeasurement(
                             MediaWorkflowMetrics.Modality.STT, MediaWorkflowMetrics.Boundary.RESPONSE)) {
            if (isCancelled(responseObserver)) {
                responseBoundary.complete(MediaWorkflowMetrics.Outcome.UNKNOWN);
                return noOpAudioObserver();
            }
            responseObserver.onError(io.grpc.Status.FAILED_PRECONDITION
                    .withDescription("STT_STREAM_SESSION_NOT_ADMITTED: durable session store, ACK/resume epoch, and provider session are unavailable")
                    .asRuntimeException());
            // The stream has no success response path until a durable session is admitted.
            responseBoundary.complete(MediaWorkflowMetrics.Outcome.FAILURE);
        } catch (IllegalStateException cancelledCall) {
            if (!isCancelled(responseObserver)) throw cancelledCall;
        } finally {
            if (isCancelled(responseObserver)) {
                span.setAttribute("media.outcome", "unknown");
                span.end();
            } else {
                tracingService.recordError(span, new IllegalStateException("durable stream session unavailable"),
                        java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos));
            }
        }
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
        if (!requireAuthenticatedTenantPrincipalWithMetrics(responseObserver)) return;
        if (!authorizeRequest(responseObserver, SttRequestAuthorization.Operation.READ_STATUS, null)) return;
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
        if (!requireAuthenticatedTenantPrincipalWithMetrics(responseObserver)) return;
        boolean ready = Boolean.TRUE.equals(readinessProbe.getAsBoolean());
        responseObserver.onNext(HealthCheckResponse.newBuilder()
            .setStatus(ready ? HealthStatus.HEALTH_STATUS_HEALTHY : HealthStatus.HEALTH_STATUS_UNHEALTHY)
            .setMessage(ready ? "STT_READY" : "STT_NOT_SERVING: provider readiness unavailable")
            .build());
        responseObserver.onCompleted();
    }

    /** Provider readiness is false unless a production composition supplies an admitted, healthy engine. */
    protected boolean isProviderReady() {
        return false;
    }

    final void setReadinessProbe(BooleanSupplier readinessProbe) {
        this.readinessProbe = Objects.requireNonNull(readinessProbe, "readinessProbe");
    }

    // ── AV-001.1: loadModel ────────────────────────────────────────────────

    @Override
    public void loadModel(LoadModelRequest request, StreamObserver<LoadModelResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipalWithMetrics(responseObserver)) return;
        if (!authorizeRequest(responseObserver, SttRequestAuthorization.Operation.LOAD_MODEL, request.getModelId())) return;
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

            LOG.info("STT model loaded in {}ms", loadTimeMs);
            responseObserver.onNext(LoadModelResponse.newBuilder()
                .setSuccess(true)
                .setMessage("Model loaded successfully: " + modelId)
                .setModelId(modelId)
                .setLoadTimeMs(loadTimeMs)
                .setMemoryUsageBytes(memoryBytes)
                .build());
            responseObserver.onCompleted();
        } catch (com.ghatana.media.common.ModelLoadingError e) {
            LOG.warn("STT model load failed failureType={}", failureType(e));
            responseObserver.onError(io.grpc.Status.NOT_FOUND
                .withDescription("Model not found or cannot be loaded")
                .asRuntimeException());
        } catch (Exception e) {
            LOG.error("STT model load failed failureType={}", failureType(e));
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("Failed to load model")
                .asRuntimeException());
        }
    }

    // ── AV-001.2: unloadModel ──────────────────────────────────────────────

    @Override
    public void unloadModel(UnloadModelRequest request, StreamObserver<UnloadModelResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipalWithMetrics(responseObserver)) return;
        if (!authorizeRequest(responseObserver, SttRequestAuthorization.Operation.UNLOAD_MODEL, request.getModelId())) return;
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
                    .withDescription("Model not found")
                    .asRuntimeException());
                return;
            }
            // SttEngine exposes no unload operation. Merely observing the model and its
            // memory counters cannot establish that it was unloaded, so fail explicitly.
            responseObserver.onError(io.grpc.Status.UNIMPLEMENTED
                .withDescription("Model unload is not supported by the active STT engine")
                .asRuntimeException());
        } catch (Exception e) {
            LOG.error("STT model unload failed failureType={}", failureType(e));
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("Failed to unload model")
                .asRuntimeException());
        }
    }

    // ── AV-001.3: listModels ───────────────────────────────────────────────

    @Override
    public void listModels(ListModelsRequest request, StreamObserver<ListModelsResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipalWithMetrics(responseObserver)) return;
        if (!authorizeRequest(responseObserver, SttRequestAuthorization.Operation.LIST_MODELS, null)) return;
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
            LOG.error("STT model listing failed failureType={}", failureType(e));
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("Failed to list models")
                .asRuntimeException());
        }
    }

    // ── AV-001.4: adaptModel ───────────────────────────────────────────────

    @Override
    public void adaptModel(AdaptRequest request, StreamObserver<AdaptResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipalWithMetrics(responseObserver)) return;
        if (!authorizeRequest(responseObserver,
                SttRequestAuthorization.Operation.ADAPT_MODEL, request.getProfileId())) return;
        responseObserver.onError(io.grpc.Status.FAILED_PRECONDITION
                .withDescription("STT_ADAPTATION_NOT_ADMITTED: versioned transcript correction, trusted rights admission and an admitted adaptation provider are unavailable")
                .asRuntimeException());
    }

    // ── AV-001.5: createProfile ────────────────────────────────────────────

    @Override
    public void createProfile(CreateProfileRequest request, StreamObserver<ProfileResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipalWithMetrics(responseObserver)) return;
        if (!authorizeRequest(responseObserver,
                SttRequestAuthorization.Operation.CREATE_SPEAKER_IDENTITY, null)) return;
        speakerProfileNotAdmitted(responseObserver);
    }

    // ── AV-001.6: getProfile ───────────────────────────────────────────────

    @Override
    public void getProfile(GetProfileRequest request, StreamObserver<ProfileResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipalWithMetrics(responseObserver)) return;
        if (!authorizeRequest(responseObserver,
                SttRequestAuthorization.Operation.READ_SPEAKER_IDENTITY, request.getProfileId())) return;
        speakerProfileNotAdmitted(responseObserver);
    }

    // ── AV-001.7: updateProfile ────────────────────────────────────────────

    @Override
    public void updateProfile(UpdateProfileRequest request, StreamObserver<ProfileResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipalWithMetrics(responseObserver)) return;
        if (!authorizeRequest(responseObserver,
                SttRequestAuthorization.Operation.UPDATE_SPEAKER_IDENTITY, request.getProfileId())) return;
        speakerProfileNotAdmitted(responseObserver);
    }

    private static void speakerProfileNotAdmitted(StreamObserver<ProfileResponse> responseObserver) {
        responseObserver.onError(io.grpc.Status.FAILED_PRECONDITION
                .withDescription("STT_SPEAKER_PROFILE_NOT_ADMITTED: trusted rights, purpose, consent, embedding and tenant-scoped persistence admission are unavailable")
                .asRuntimeException());
    }

    @Override
    public void submitCorrection(CorrectionRequest request, StreamObserver<CorrectionResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipalWithMetrics(responseObserver)) return;
        if (!authorizeRequest(responseObserver,
                SttRequestAuthorization.Operation.SUBMIT_CORRECTION, request.getProfileId())) return;
        responseObserver.onError(io.grpc.Status.FAILED_PRECONDITION
                .withDescription("STT_CORRECTION_NOT_ADMITTED: immutable transcript revision store and expected-version CAS are unavailable")
                .asRuntimeException());
    }

    /** Measures the trusted identity precheck separately from the rights/purpose authorization decision. */
    protected final boolean requireAuthenticatedTenantPrincipalWithMetrics(StreamObserver<?> observer) {
        try (AudioVideoGrpcInstrumentation.BoundaryMeasurement admissionBoundary =
                     boundaryInstrumentation.beginBoundaryMeasurement(
                             MediaWorkflowMetrics.Modality.STT, MediaWorkflowMetrics.Boundary.ADMISSION)) {
            boolean authenticated = requireAuthenticatedTenantPrincipal(observer);
            admissionBoundary.complete(authenticated
                    ? MediaWorkflowMetrics.Outcome.SUCCESS : MediaWorkflowMetrics.Outcome.FAILURE);
            return authenticated;
        }
    }

    /** Compatibility identity check retained for existing subclass callers. */
    protected static boolean requireAuthenticatedTenantPrincipal(StreamObserver<?> observer) {
        JwtServerInterceptor.VerifiedIdentity identity = JwtServerInterceptor.verifiedIdentity();
        String tenantId = identity == null ? null : identity.tenantId();
        String principalId = identity == null ? null : identity.subject();
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

    protected final boolean authorizeRequest(StreamObserver<?> observer, SttRequestAuthorization.Operation operation,
            String resourceId) {
        try (AudioVideoGrpcInstrumentation.BoundaryMeasurement admissionBoundary =
                     boundaryInstrumentation.beginBoundaryMeasurement(
                             MediaWorkflowMetrics.Modality.STT, MediaWorkflowMetrics.Boundary.ADMISSION)) {
            boolean admitted = authorizeRequestDecision(observer, operation, resourceId);
            admissionBoundary.complete(admitted
                    ? MediaWorkflowMetrics.Outcome.SUCCESS : MediaWorkflowMetrics.Outcome.FAILURE);
            return admitted;
        }
    }

    private boolean authorizeRequestDecision(StreamObserver<?> observer,
            SttRequestAuthorization.Operation operation, String resourceId) {
        JwtServerInterceptor.VerifiedIdentity identity = JwtServerInterceptor.verifiedIdentity();
        if (identity == null) {
            observer.onError(io.grpc.Status.UNAUTHENTICATED
                    .withDescription("STT_IDENTITY_REQUIRED: verified server identity is required")
                    .asRuntimeException());
            return false;
        }
        SttRequestAuthorization.Decision decision;
        try {
            decision = requestAuthorization.authorize(new SttRequestAuthorization.Request(
                    identity, operation, resourceId));
        } catch (RuntimeException failure) {
            decision = SttRequestAuthorization.Decision.UNAVAILABLE;
        }
        if (decision == null) decision = SttRequestAuthorization.Decision.UNAVAILABLE;
        if (decision == SttRequestAuthorization.Decision.ADMITTED) return true;
        String code = switch (decision) {
            case REVOKED -> "STT_RIGHTS_REVOKED";
            case DENIED -> "STT_RIGHTS_DENIED";
            case UNAVAILABLE -> "STT_RIGHTS_NOT_ADMITTED";
            case ADMITTED -> throw new IllegalStateException("admitted decision handled above");
        };
        io.grpc.Status status = decision == SttRequestAuthorization.Decision.UNAVAILABLE
                ? io.grpc.Status.FAILED_PRECONDITION : io.grpc.Status.PERMISSION_DENIED;
        observer.onError(status
                .withDescription(code + (decision == SttRequestAuthorization.Decision.UNAVAILABLE
                        ? ": trusted rights and ownership authority is unavailable"
                        : ": trusted rights and ownership policy denied the request"))
                .asRuntimeException());
        return false;
    }

    private static String failureType(Throwable error) {
        Throwable cause = error;
        while (cause.getCause() != null && cause.getCause() != cause) cause = cause.getCause();
        return cause.getClass().getSimpleName();
    }
}
