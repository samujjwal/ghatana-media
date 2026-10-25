package com.ghatana.tts.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.common.ValidationError;
import com.ghatana.media.tts.api.SynthesisOptions;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.media.tts.api.TtsStreamSink;
import com.ghatana.media.tts.api.TtsStreamingSession;
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
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

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
                validatePcm16Output(audio, options.outputFormat());

                long elapsed = System.currentTimeMillis() - startedAt;
                double durationMs = (audio.data().length / 2.0 / audio.sampleRate()) * 1_000;
                LOG.info("[{}] synthesize completed in {}ms", correlationId, elapsed);
                responseObserver.onNext(SynthesizeResponse.newBuilder()
                        .setAudioData(com.google.protobuf.ByteString.copyFrom(audio.data()))
                        .setSampleRate(audio.sampleRate())
                        .setDurationMs((int) durationMs)
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
        AtomicBoolean terminal = new AtomicBoolean();
        AtomicReference<TtsStreamingSession> sessionRef = new AtomicReference<>();
        Object readinessMonitor = new Object();
        ServerCallStreamObserver<AudioChunk> serverObserver = serverObserver(responseObserver);

        if (serverObserver != null) {
            serverObserver.setOnReadyHandler(() -> {
                synchronized (readinessMonitor) {
                    readinessMonitor.notifyAll();
                }
            });
            serverObserver.setOnCancelHandler(() -> {
                cancelled.set(true);
                TtsStreamingSession session = sessionRef.get();
                if (session != null) session.cancel();
                synchronized (readinessMonitor) {
                    readinessMonitor.notifyAll();
                }
            });
        }

        try {
            String text = validateText(request.getText());
            SynthesisControlPolicy.rejectUnqualifiedSsml(text);
            requireAuthorizedVoiceSelection(request);
            SynthesisOptions options = options(request);
            TtsEngine engine = library.getTtsEngine();
            int sampleRate = engine.getActiveVoice().sampleRate();
            TtsStreamSink sink = new TtsStreamSink() {
                @Override
                public boolean isReady() {
                    return serverObserver == null || serverObserver.isReady();
                }

                @Override
                public boolean isCancelled() {
                    return cancelled.get()
                            || (serverObserver != null && serverObserver.isCancelled());
                }

                @Override
                public void awaitReady() throws InterruptedException {
                    synchronized (readinessMonitor) {
                        while (!isReady() && !isCancelled()) {
                            readinessMonitor.wait();
                        }
                    }
                }

                @Override
                public void onChunk(com.ghatana.media.common.AudioChunk chunk) {
                    if (isCancelled()) throw new CancellationException("gRPC TTS stream cancelled");
                    if (chunk.data().length % 2 != 0) {
                        throw new IllegalStateException(
                                "TTS provider returned a partial PCM S16LE sample");
                    }
                    responseObserver.onNext(AudioChunk.newBuilder()
                            .setAudioData(com.google.protobuf.ByteString.copyFrom(chunk.data()))
                            .setSampleRate(sampleRate)
                            .setIsFinal(chunk.isLast())
                            .build());
                }
            };

            TtsStreamingSession session = engine.startStreaming(text, options, sink);
            sessionRef.set(session);
            if (cancelled.get()) session.cancel();
            session.completion().whenComplete((ignored, failure) -> {
                streamingTimer.record(System.nanoTime() - startedNanos, TimeUnit.NANOSECONDS);
                if (!terminal.compareAndSet(false, true) || cancelled.get()) return;
                if (failure == null) {
                    LOG.info("[{}] stream synthesis completed", correlationId);
                    responseObserver.onCompleted();
                    return;
                }
                Throwable cause = unwrap(failure);
                if (cause instanceof CancellationException) return;
                RuntimeException runtime = cause instanceof RuntimeException value
                        ? value
                        : new IllegalStateException("Streaming synthesis failed", cause);
                fail(responseObserver, "Streaming synthesis", correlationId, runtime);
            });
        } catch (RuntimeException exception) {
            streamingTimer.record(System.nanoTime() - startedNanos, TimeUnit.NANOSECONDS);
            if (terminal.compareAndSet(false, true) && !cancelled.get()) {
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

    private static void validatePcm16Output(AudioData audio, AudioFormat requestedFormat) {
        if (requestedFormat != AudioFormat.PCM
                || audio.format() != AudioFormat.PCM
                || audio.bitsPerSample() != 16) {
            throw new IllegalStateException(
                    "TTS provider output does not match the admitted PCM S16LE response format");
        }
        if (audio.data().length % 2 != 0) {
            throw new IllegalStateException("TTS provider returned a partial PCM S16LE sample");
        }
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

    private static Throwable unwrap(Throwable failure) {
        Throwable current = failure;
        while (current instanceof CompletionException && current.getCause() != null) {
            current = current.getCause();
        }
        return current;
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
