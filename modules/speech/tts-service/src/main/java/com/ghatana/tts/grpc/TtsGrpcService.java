package com.ghatana.tts.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.common.ValidationError;
import com.ghatana.media.tts.api.SynthesisOptions;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.media.tts.api.VoiceInfo;
import com.ghatana.tts.core.grpc.proto.AudioChunk;
import com.ghatana.tts.core.grpc.proto.CloneVoiceRequest;
import com.ghatana.tts.core.grpc.proto.CloneVoiceResponse;
import com.ghatana.tts.core.grpc.proto.CreateProfileRequest;
import com.ghatana.tts.core.grpc.proto.FeedbackRequest;
import com.ghatana.tts.core.grpc.proto.FeedbackResponse;
import com.ghatana.tts.core.grpc.proto.GetProfileRequest;
import com.ghatana.tts.core.grpc.proto.GetVoicesRequest;
import com.ghatana.tts.core.grpc.proto.GetVoicesResponse;
import com.ghatana.tts.core.grpc.proto.LoadVoiceRequest;
import com.ghatana.tts.core.grpc.proto.LoadVoiceResponse;
import com.ghatana.tts.core.grpc.proto.MetricsRequest;
import com.ghatana.tts.core.grpc.proto.MetricsResponse;
import com.ghatana.tts.core.grpc.proto.ProfileResponse;
import com.ghatana.tts.core.grpc.proto.ProfileStats;
import com.ghatana.tts.core.grpc.proto.StatusRequest;
import com.ghatana.tts.core.grpc.proto.StatusResponse;
import com.ghatana.tts.core.grpc.proto.SynthesizeRequest;
import com.ghatana.tts.core.grpc.proto.SynthesizeResponse;
import com.ghatana.tts.core.grpc.proto.TTSServiceGrpc;
import com.ghatana.tts.core.grpc.proto.UpdateProfileRequest;
import com.ghatana.tts.engine.TtsSynthesisEngine;
import com.ghatana.tts.engine.PcmAudioValidator;
import io.grpc.Status;
import io.grpc.stub.ServerCallStreamObserver;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * TTS gRPC façade over an injected, lifecycle-owned {@link AudioVideoLibrary}.
 *
 * <p>This class has no environment-based constructor and does not own provider composition.
 * Production construction belongs to {@link ProductionTtsGrpcService}; persistent/test adapters
 * inject an existing library. Borrowed engine views are not closed by request handlers because the
 * library owns the underlying engine lifecycle.
 *
 * @doc.type class
 * @doc.purpose Provider-neutral gRPC façade for a pre-composed TtsEngine
 * @doc.layer product
 * @doc.pattern Service
 */
public class TtsGrpcService extends TTSServiceGrpc.TTSServiceImplBase {

    private static final Logger LOG = LoggerFactory.getLogger(TtsGrpcService.class);
    private static final int MAX_TEXT_LENGTH = 5_000;

    private final AudioVideoLibrary library;
    private final Timer synthesizeTimer;
    private final Timer streamingTimer;

    /** Package-private injection constructor for production wrappers, persistence, and tests. */
    TtsGrpcService(AudioVideoLibrary library, MeterRegistry metrics) {
        this.library = Objects.requireNonNull(library, "library");
        Objects.requireNonNull(metrics, "metrics");
        this.synthesizeTimer = Timer.builder("tts.synthesize")
                .description("Synthesis latency")
                .publishPercentiles(0.50, 0.95, 0.99)
                .publishPercentileHistogram()
                .register(metrics);
        this.streamingTimer = Timer.builder("tts.synthesize.streaming")
                .description("Streaming synthesis latency")
                .publishPercentiles(0.50, 0.95, 0.99)
                .publishPercentileHistogram()
                .register(metrics);
    }

    @Override
    public void synthesize(
            SynthesizeRequest request,
            StreamObserver<SynthesizeResponse> responseObserver) {
        String correlationId = correlationId();
        long startedAt = System.currentTimeMillis();
        synthesizeTimer.record(() -> {
            try {
                String text = validateText(request.getText());
                SynthesisControlPolicy.rejectUnqualifiedSsml(text);
                requireAuthorizedVoiceSelection(request);
                SynthesisOptions options = options(request);
                AudioData audio = library.getTtsEngine().synthesize(text, options);
                PcmAudioValidator.PcmFacts facts = validatePcm16Output(
                        audio, options.outputFormat(), options.sampleRate());

                long elapsed = System.currentTimeMillis() - startedAt;
                long durationMs = facts.duration().toMillis();
                LOG.info("[{}] synthesize completed in {}ms", correlationId, elapsed);
                responseObserver.onNext(SynthesizeResponse.newBuilder()
                        .setAudioData(com.google.protobuf.ByteString.copyFrom(audio.data()))
                        .setSampleRate(audio.sampleRate())
                        .setDurationMs(Math.toIntExact(durationMs))
                        .setProcessingTimeMs((int) elapsed)
                        .setVoiceUsed(options.voiceId() == null ? "" : options.voiceId())
                        .build());
                responseObserver.onCompleted();
            } catch (RuntimeException exception) {
                fail(responseObserver, "Synthesis", correlationId, exception);
            }
        });
    }

    @Override
    public void streamSynthesize(
            SynthesizeRequest request,
            StreamObserver<AudioChunk> responseObserver) {
        String correlationId = correlationId();
        long startedNanos = System.nanoTime();
        AtomicBoolean cancelled = new AtomicBoolean();
        ServerCallStreamObserver<AudioChunk> serverObserver = serverObserver(responseObserver);

        if (serverObserver != null) {
            serverObserver.setOnCancelHandler(() -> cancelled.set(true));
        }

        try {
            String text = validateText(request.getText());
            SynthesisControlPolicy.rejectUnqualifiedSsml(text);
            requireAuthorizedVoiceSelection(request);
            options(request);
            // No streaming provider has been admitted. Fail before engine lookup/session creation,
            // so a compatibility or synthetic engine cannot emit partial or final audio.
            throw new TtsSynthesisEngine.SynthesisException(
                    "TTS streaming is NOT_ADMITTED: no real streaming provider is configured",
                    TtsSynthesisEngine.FailureReason.NOT_ADMITTED);
        } catch (RuntimeException exception) {
            streamingTimer.record(System.nanoTime() - startedNanos, TimeUnit.NANOSECONDS);
            if (!cancelled.get()) {
                fail(responseObserver, "Streaming synthesis", correlationId, exception);
            }
        }
    }

    @Override
    public void getVoices(
            GetVoicesRequest request,
            StreamObserver<GetVoicesResponse> responseObserver) {
        try {
            TtsEngine engine = library.getTtsEngine();
            List<VoiceInfo> voices = request.getLanguage().isBlank()
                    ? engine.getAvailableVoices()
                    : engine.getAvailableVoices(Locale.forLanguageTag(request.getLanguage()));
            GetVoicesResponse.Builder builder = GetVoicesResponse.newBuilder();
            for (VoiceInfo voice : voices) {
                builder.addVoices(com.ghatana.tts.core.grpc.proto.VoiceInfo.newBuilder()
                        .setVoiceId(voice.voiceId())
                        .setName(voice.name())
                        .addLanguages(voice.language().toLanguageTag())
                        .setIsCloned(voice.isCloned())
                        .setSizeBytes(voice.modelSizeBytes())
                        .build());
            }
            responseObserver.onNext(builder.build());
            responseObserver.onCompleted();
        } catch (RuntimeException exception) {
            fail(responseObserver, "Voice listing", correlationId(), exception);
        }
    }

    @Override
    public void getStatus(
            StatusRequest request,
            StreamObserver<StatusResponse> responseObserver) {
        try {
            com.ghatana.media.common.EngineStatus status = library.getTtsEngine().getStatus();
            responseObserver.onNext(StatusResponse.newBuilder()
                    .setActiveVoice(status.modelId() == null ? "" : status.modelId())
                    .build());
            responseObserver.onCompleted();
        } catch (RuntimeException exception) {
            fail(responseObserver, "Status", correlationId(), exception);
        }
    }

    @Override
    public void getMetrics(
            MetricsRequest request,
            StreamObserver<MetricsResponse> responseObserver) {
        try {
            com.ghatana.media.common.EngineMetrics metrics = library.getTtsEngine().getMetrics();
            responseObserver.onNext(MetricsResponse.newBuilder()
                    .setTotalSyntheses(Math.toIntExact(Math.min(Integer.MAX_VALUE, metrics.requestCount())))
                    .setAverageLatencyMs((float) metrics.avgLatencyMs())
                    .setMemoryUsageBytes(metrics.memoryUsageBytes())
                    .build());
            responseObserver.onCompleted();
        } catch (RuntimeException exception) {
            fail(responseObserver, "Metrics", correlationId(), exception);
        }
    }

    @Override
    public void loadVoice(
            LoadVoiceRequest request,
            StreamObserver<LoadVoiceResponse> responseObserver) {
        try {
            String voiceId = requireText(request.getVoiceId(), "voiceId");
            VoiceInfo voice = library.getTtsEngine().loadVoice(voiceId);
            responseObserver.onNext(LoadVoiceResponse.newBuilder()
                    .setSuccess(true)
                    .setMessage("Voice loaded: " + voice.voiceId())
                    .build());
            responseObserver.onCompleted();
        } catch (RuntimeException exception) {
            fail(responseObserver, "Voice loading", correlationId(), exception);
        }
    }

    @Override
    public void createProfile(
            CreateProfileRequest request,
            StreamObserver<ProfileResponse> responseObserver) {
        profileAccessNotAdmitted(responseObserver);
    }

    @Override
    public void getProfile(
            GetProfileRequest request,
            StreamObserver<ProfileResponse> responseObserver) {
        profileAccessNotAdmitted(responseObserver);
    }

    @Override
    public void updateProfile(
            UpdateProfileRequest request,
            StreamObserver<ProfileResponse> responseObserver) {
        profileAccessNotAdmitted(responseObserver);
    }

    @Override
    public void cloneVoice(
            CloneVoiceRequest request,
            StreamObserver<CloneVoiceResponse> responseObserver) {
        responseObserver.onError(Status.UNIMPLEMENTED
                .withDescription(
                        "Voice cloning is NOT_ADMITTED until owner consent, biometric purpose, and retention are verified")
                .asRuntimeException());
    }

    private static void profileAccessNotAdmitted(StreamObserver<ProfileResponse> responseObserver) {
        responseObserver.onError(Status.UNIMPLEMENTED
                .withDescription("TTS profile access is NOT_ADMITTED until tenant/principal ownership, consent, purpose and retention are backed by an authoritative scoped store")
                .asRuntimeException());
    }

    @Override
    public void submitFeedback(
            FeedbackRequest request,
            StreamObserver<FeedbackResponse> responseObserver) {
        responseObserver.onError(Status.UNIMPLEMENTED
                .withDescription(
                        "TTS feedback requires an explicit persistence and learning provider")
                .asRuntimeException());
    }

    private static SynthesisOptions options(SynthesizeRequest request) {
        AudioFormat outputFormat = switch (request.getOptions().getOutputFormat()) {
            case AUDIO_FORMAT_UNSPECIFIED, AUDIO_FORMAT_PCM_S16LE -> AudioFormat.PCM;
            case AUDIO_FORMAT_PCM_F32LE -> throw new UnsupportedOperationException(
                    "PCM F32LE output is NOT_ADMITTED until the provider can verify this encoding");
            case AUDIO_FORMAT_WAV -> throw new UnsupportedOperationException(
                    "WAV output is NOT_ADMITTED until the provider can verify its container header");
            case AUDIO_FORMAT_MP3 -> throw new UnsupportedOperationException(
                    "MP3 output is NOT_ADMITTED until an MP3 encoder is admitted");
            case UNRECOGNIZED -> throw new IllegalArgumentException("Unknown TTS output format");
        };
        return SynthesisControlPolicy.resolve(request, outputFormat);
    }

    private static void requireAuthorizedVoiceSelection(SynthesizeRequest request) {
        if (!request.getVoiceId().isBlank() || !request.getProfileId().isBlank()) {
            throw new UnsupportedOperationException(
                    "Voice/profile selection is NOT_ADMITTED without an authoritative owner, rights and consent decision");
        }
    }

    private static PcmAudioValidator.PcmFacts validatePcm16Output(
            AudioData audio, AudioFormat requestedFormat, int requestedSampleRate) {
        if (requestedFormat != AudioFormat.PCM) {
            throw new IllegalStateException(
                    "TTS provider output does not match the admitted PCM S16LE response format");
        }
        // Current response has no channel field: only mono S16LE is decodable without ambiguity.
        return PcmAudioValidator.validate(audio, requestedSampleRate, 1);
    }

    private static String validateText(String text) {
        String normalized = requireText(text, "text");
        if (normalized.length() > MAX_TEXT_LENGTH) {
            throw new IllegalArgumentException(
                    "text exceeds " + MAX_TEXT_LENGTH + " characters");
        }
        return normalized;
    }

    @SuppressWarnings("unchecked")
    private static ServerCallStreamObserver<AudioChunk> serverObserver(
            StreamObserver<AudioChunk> observer) {
        if (!(observer instanceof ServerCallStreamObserver<?> raw)) return null;
        return (ServerCallStreamObserver<AudioChunk>) raw;
    }

    private static String requireText(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(field + " must not be blank");
        }
        return value.trim();
    }

    private static <T> void fail(
            StreamObserver<T> responseObserver,
            String operation,
            String correlationId,
            RuntimeException exception) {
        Status status;
        if (exception instanceof TtsSynthesisEngine.SynthesisException synthesis
                && synthesis.reason() == TtsSynthesisEngine.FailureReason.NOT_ADMITTED) {
            status = Status.UNAVAILABLE;
        } else if (exception instanceof ValidationError || exception instanceof IllegalArgumentException) {
            status = Status.INVALID_ARGUMENT;
        } else if (exception instanceof UnsupportedOperationException) {
            status = Status.UNIMPLEMENTED;
        } else if (exception instanceof IllegalStateException) {
            status = Status.FAILED_PRECONDITION;
        } else {
            status = Status.INTERNAL;
        }
        LOG.error(
                "[{}] {} failed: {}",
                correlationId,
                operation,
                exception.getMessage(),
                exception);
        responseObserver.onError(status
                .withDescription(operation + " failed: " + safeMessage(exception))
                .asRuntimeException());
    }

    private static String safeMessage(RuntimeException exception) {
        String message = exception.getMessage();
        return message == null || message.isBlank()
                ? exception.getClass().getSimpleName()
                : message;
    }

    private static String correlationId() {
        return UUID.randomUUID().toString().substring(0, 8);
    }
}
