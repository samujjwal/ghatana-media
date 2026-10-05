package com.ghatana.tts.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.ValidationError;
import com.ghatana.media.tts.api.CloneOptions;
import com.ghatana.media.tts.api.ProfileSettings;
import com.ghatana.media.tts.api.SynthesisOptions;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.media.tts.api.TtsProfile;
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
import io.grpc.Status;
import io.grpc.stub.ServerCallStreamObserver;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;
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
                SynthesisOptions options = options(request);
                AudioData audio = library.getTtsEngine().synthesize(text, options);

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
        try {
            String displayName = requireText(request.getDisplayName(), "displayName");
            ProfileSettings settings = ProfileSettings.builder()
                    .defaultSpeed(positiveOrDefault(
                            request.getSettings().getDefaultOptions().getSpeed(),
                            1.0))
                    .defaultPitch(positiveOrDefault(
                            request.getSettings().getDefaultOptions().getPitch(),
                            1.0))
                    .defaultVolume(positiveOrDefault(
                            request.getSettings().getDefaultOptions().getEnergy(),
                            1.0))
                    .build();
            String profileId = UUID.randomUUID().toString();
            TtsProfile profile = library.getTtsEngine()
                    .createProfile(profileId, displayName, settings);
            responseObserver.onNext(ProfileResponse.newBuilder()
                    .setProfileId(profile.profileId())
                    .setDisplayName(profile.displayName())
                    .setSettings(request.getSettings())
                    .setStats(ProfileStats.newBuilder()
                            .setCreatedAtMs(System.currentTimeMillis())
                            .setLastUsedAtMs(System.currentTimeMillis())
                            .build())
                    .build());
            responseObserver.onCompleted();
        } catch (RuntimeException exception) {
            fail(responseObserver, "Profile creation", correlationId(), exception);
        }
    }

    @Override
    public void getProfile(
            GetProfileRequest request,
            StreamObserver<ProfileResponse> responseObserver) {
        try {
            String profileId = requireText(request.getProfileId(), "profileId");
            Optional<TtsProfile> profile = library.getTtsEngine().loadProfile(profileId);
            if (profile.isEmpty()) {
                responseObserver.onError(Status.NOT_FOUND
                        .withDescription("Profile not found: " + profileId)
                        .asRuntimeException());
                return;
            }
            TtsProfile value = profile.orElseThrow();
            responseObserver.onNext(ProfileResponse.newBuilder()
                    .setProfileId(value.profileId())
                    .setDisplayName(value.displayName())
                    .setStats(ProfileStats.newBuilder()
                            .setTotalCharactersSynthesized(value.recentSyntheses().stream()
                                    .mapToInt(String::length)
                                    .sum())
                            .build())
                    .build());
            responseObserver.onCompleted();
        } catch (RuntimeException exception) {
            fail(responseObserver, "Profile retrieval", correlationId(), exception);
        }
    }

    @Override
    public void updateProfile(
            UpdateProfileRequest request,
            StreamObserver<ProfileResponse> responseObserver) {
        try {
            String profileId = requireText(request.getProfileId(), "profileId");
            TtsEngine engine = library.getTtsEngine();
            Optional<TtsProfile> profile = engine.loadProfile(profileId);
            if (profile.isEmpty()) {
                responseObserver.onError(Status.NOT_FOUND
                        .withDescription("Profile not found: " + profileId)
                        .asRuntimeException());
                return;
            }
            TtsProfile existing = profile.orElseThrow();
            String preferredVoice = request.getSettings().getDefaultVoiceId().isBlank()
                    ? existing.preferredVoiceId()
                    : request.getSettings().getDefaultVoiceId();
            ProfileSettings settings = ProfileSettings.builder()
                    .defaultSpeed(positiveOrDefault(
                            request.getSettings().getDefaultOptions().getSpeed(),
                            existing.settings().defaultSpeed()))
                    .defaultPitch(positiveOrDefault(
                            request.getSettings().getDefaultOptions().getPitch(),
                            existing.settings().defaultPitch()))
                    .defaultVolume(positiveOrDefault(
                            request.getSettings().getDefaultOptions().getEnergy(),
                            existing.settings().defaultVolume()))
                    .build();
            TtsProfile updated = new TtsProfile(
                    existing.profileId(),
                    existing.displayName(),
                    preferredVoice,
                    settings,
                    existing.recentSyntheses());
            engine.saveProfile(updated);
            responseObserver.onNext(ProfileResponse.newBuilder()
                    .setProfileId(updated.profileId())
                    .setDisplayName(updated.displayName())
                    .setSettings(request.getSettings())
                    .setStats(ProfileStats.newBuilder()
                            .setLastUsedAtMs(System.currentTimeMillis())
                            .build())
                    .build());
            responseObserver.onCompleted();
        } catch (RuntimeException exception) {
            fail(responseObserver, "Profile update", correlationId(), exception);
        }
    }

    @Override
    public void cloneVoice(
            CloneVoiceRequest request,
            StreamObserver<CloneVoiceResponse> responseObserver) {
        try {
            String voiceName = requireText(request.getVoiceName(), "voiceName");
            if (request.getAudioSamplesList().isEmpty()) {
                throw new IllegalArgumentException(
                        "At least one audio sample is required for voice cloning");
            }
            List<AudioData> samples = new ArrayList<>();
            for (com.google.protobuf.ByteString sample : request.getAudioSamplesList()) {
                if (!sample.isEmpty()) {
                    samples.add(new AudioData(sample.toByteArray(), 22_050, 1, 16));
                }
            }
            if (samples.isEmpty()) {
                throw new IllegalArgumentException(
                        "At least one non-empty audio sample is required for voice cloning");
            }
            CloneOptions options = new CloneOptions(
                    request.getOptions().getFineTuneEpochs() > 0
                            ? request.getOptions().getFineTuneEpochs()
                            : 100,
                    request.getOptions().getLearningRate() > 0
                            ? request.getOptions().getLearningRate()
                            : 0.001f,
                    3,
                    Duration.ofSeconds(5));
            VoiceInfo cloned = library.getTtsEngine().cloneVoice(voiceName, samples, options);
            responseObserver.onNext(CloneVoiceResponse.newBuilder()
                    .setSuccess(true)
                    .setMessage("Voice cloned successfully: " + voiceName)
                    .setVoiceId(cloned.voiceId())
                    .setSimilarityScore(cloned.similarityScore())
                    .setVoice(com.ghatana.tts.core.grpc.proto.VoiceInfo.newBuilder()
                            .setVoiceId(cloned.voiceId())
                            .setName(cloned.name())
                            .setIsCloned(cloned.isCloned())
                            .setSizeBytes(cloned.modelSizeBytes())
                            .build())
                    .build());
            responseObserver.onCompleted();
        } catch (RuntimeException exception) {
            fail(responseObserver, "Voice cloning", correlationId(), exception);
        }
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
        return SynthesisOptions.builder()
                .voiceId(request.getVoiceId().isBlank() ? null : request.getVoiceId())
                .speed(request.getOptions().getSpeed())
                .pitch(request.getOptions().getPitch())
                .volume(request.getOptions().getEnergy())
                .language(request.getOptions().getLanguage().isBlank()
                        ? null
                        : Locale.forLanguageTag(request.getOptions().getLanguage()))
                .build();
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

    private static double positiveOrDefault(double configured, double fallback) {
        return configured > 0 ? configured : fallback;
    }

    private static <T> void fail(
            StreamObserver<T> responseObserver,
            String operation,
            String correlationId,
            RuntimeException exception) {
        Status status;
        if (exception instanceof ValidationError || exception instanceof IllegalArgumentException) {
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
