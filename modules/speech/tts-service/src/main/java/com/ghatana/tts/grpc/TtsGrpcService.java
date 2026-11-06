package com.ghatana.tts.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.common.resilience.ContextAwareBoundedExecutor;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.common.CanonicalAudioFormat;
import com.ghatana.media.common.ValidationError;
import com.ghatana.audiovideo.observability.MediaWorkflowMetrics;
import com.ghatana.audiovideo.observability.instrumentation.AudioVideoGrpcInstrumentation;
import com.ghatana.audiovideo.observability.tracing.AudioVideoTracingService;
import com.ghatana.media.tts.api.SynthesisOptions;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.media.tts.api.TtsStreamingSession;
import com.ghatana.media.tts.api.TtsStreamSink;
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
import io.grpc.StatusRuntimeException;
import io.grpc.stub.ServerCallStreamObserver;
import io.grpc.stub.StreamObserver;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;
import java.util.ArrayList;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import java.util.function.BiPredicate;

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
public class TtsGrpcService extends TTSServiceGrpc.TTSServiceImplBase
        implements com.ghatana.audio.video.common.observability.MetricsScrapeSource {

    private static final Logger LOG = LoggerFactory.getLogger(TtsGrpcService.class);
    private static final int MAX_TEXT_LENGTH = 5_000;
    private static final int MAX_STREAM_CHUNK_BYTES = 64 * 1024;
    private static final long MAX_STREAM_OUTPUT_BYTES = PcmAudioValidator.MAX_AUDIO_BYTES;
    private static final String SYNTHESIS_WORKERS_PROPERTY = "media.tts.synthesis.workers";
    private static final String SYNTHESIS_QUEUE_PROPERTY = "media.tts.synthesis.queueCapacity";
    private static final int DEFAULT_SYNTHESIS_WORKERS = Math.max(1,
            Math.min(4, Runtime.getRuntime().availableProcessors() / 2));
    private static final int DEFAULT_SYNTHESIS_QUEUE_CAPACITY = 64;

    private final AudioVideoLibrary library;
    private final Timer synthesizeTimer;
    private final Timer streamingTimer;
    private final AudioVideoGrpcInstrumentation instrumentation;
    private final MediaWorkflowMetrics workflowMetrics;
    private final AudioVideoTracingService tracingService;
    private final BooleanSupplier synthesisAdmitted;
    private final BiPredicate<String, Locale> admittedVoiceLanguage;
    private final BooleanSupplier streamingAdmitted;
    private final Duration streamingTimeoutOverride;
    private final TtsRequestAuthorization requestAuthorization;
    private final ExecutorService ownedSynthesisWorkers;
    private final ContextAwareBoundedExecutor synthesisDispatcher;
    private final ContextAwareBoundedExecutor streamStartDispatcher;
    private final Object synthesisLifecycleLock = new Object();
    private final Set<ContextAwareBoundedExecutor.Submission<?>> outstandingSynthesis =
            ConcurrentHashMap.newKeySet();
    private final Set<TtsStreamingSession> activeStreamingSessions = ConcurrentHashMap.newKeySet();
    private boolean synthesisClosing;

    /** Package-private injection constructor for production wrappers, persistence, and tests. */
    TtsGrpcService(AudioVideoLibrary library, MeterRegistry metrics) {
        this(library, metrics, () -> false, () -> false);
    }

    /** Package-private admission seam for isolated provider-boundary tests; production defaults fail closed. */
    TtsGrpcService(AudioVideoLibrary library, MeterRegistry metrics, BooleanSupplier synthesisAdmitted) {
        this(library, metrics, synthesisAdmitted, () -> false);
    }

    /** Explicit streaming qualification seam; production composition keeps this false until PCM framing is verified. */
    TtsGrpcService(
            AudioVideoLibrary library,
            MeterRegistry metrics,
            BooleanSupplier synthesisAdmitted,
            BooleanSupplier streamingAdmitted) {
        this(library, metrics, synthesisAdmitted, streamingAdmitted, null);
    }

    /** Optional bounded deadline override is a package-private seam for deterministic timeout tests. */
    TtsGrpcService(
            AudioVideoLibrary library,
            MeterRegistry metrics,
            BooleanSupplier synthesisAdmitted,
            BooleanSupplier streamingAdmitted,
            Duration streamingTimeoutOverride) {
        this(library, metrics, synthesisAdmitted, streamingAdmitted, streamingTimeoutOverride,
                new AudioVideoTracingService(GlobalOpenTelemetry.getTracer("ghatana-media-tts")));
    }

    /** Package-private tracing seam for bounded in-process observability tests. */
    TtsGrpcService(
            AudioVideoLibrary library,
            MeterRegistry metrics,
            BooleanSupplier synthesisAdmitted,
            BooleanSupplier streamingAdmitted,
            Duration streamingTimeoutOverride,
            AudioVideoTracingService tracingService) {
        this(library, metrics, synthesisAdmitted, streamingAdmitted, streamingTimeoutOverride,
                tracingService, TtsRequestAuthorization.unavailable());
    }

    /** Package-private authorization seam; production composition retains the unavailable default. */
    TtsGrpcService(
            AudioVideoLibrary library,
            MeterRegistry metrics,
            BooleanSupplier synthesisAdmitted,
            BooleanSupplier streamingAdmitted,
            Duration streamingTimeoutOverride,
            TtsRequestAuthorization requestAuthorization,
            BiPredicate<String, Locale> admittedVoiceLanguage,
            ContextAwareBoundedExecutor synthesisDispatcher) {
        this(library, metrics, synthesisAdmitted, streamingAdmitted, streamingTimeoutOverride,
                new AudioVideoTracingService(GlobalOpenTelemetry.getTracer("ghatana-media-tts")),
                requestAuthorization, admittedVoiceLanguage, synthesisDispatcher);
    }

    TtsGrpcService(
            AudioVideoLibrary library,
            MeterRegistry metrics,
            BooleanSupplier synthesisAdmitted,
            BooleanSupplier streamingAdmitted,
            Duration streamingTimeoutOverride,
            AudioVideoTracingService tracingService,
            TtsRequestAuthorization requestAuthorization) {
        this(library, metrics, synthesisAdmitted, streamingAdmitted, streamingTimeoutOverride,
                tracingService, requestAuthorization, (voiceId, language) -> synthesisAdmitted.getAsBoolean());
    }

    /** Production composition binds the trusted decision to the exact admitted voice/language pair. */
    TtsGrpcService(
            AudioVideoLibrary library,
            MeterRegistry metrics,
            BooleanSupplier synthesisAdmitted,
            BooleanSupplier streamingAdmitted,
            Duration streamingTimeoutOverride,
            BiPredicate<String, Locale> admittedVoiceLanguage) {
        this(library, metrics, synthesisAdmitted, streamingAdmitted, streamingTimeoutOverride,
                new AudioVideoTracingService(GlobalOpenTelemetry.getTracer("ghatana-media-tts")),
                TtsRequestAuthorization.unavailable(), admittedVoiceLanguage);
    }

    /** Controlled composition seam for a trusted request authorizer and exact provider profile. */
    TtsGrpcService(
            AudioVideoLibrary library,
            MeterRegistry metrics,
            BooleanSupplier synthesisAdmitted,
            BooleanSupplier streamingAdmitted,
            Duration streamingTimeoutOverride,
            TtsRequestAuthorization requestAuthorization,
            BiPredicate<String, Locale> admittedVoiceLanguage) {
        this(library, metrics, synthesisAdmitted, streamingAdmitted, streamingTimeoutOverride,
                new AudioVideoTracingService(GlobalOpenTelemetry.getTracer("ghatana-media-tts")),
                requestAuthorization, admittedVoiceLanguage);
    }

    private TtsGrpcService(
            AudioVideoLibrary library,
            MeterRegistry metrics,
            BooleanSupplier synthesisAdmitted,
            BooleanSupplier streamingAdmitted,
            Duration streamingTimeoutOverride,
            AudioVideoTracingService tracingService,
            TtsRequestAuthorization requestAuthorization,
            BiPredicate<String, Locale> admittedVoiceLanguage) {
        this(library, metrics, synthesisAdmitted, streamingAdmitted, streamingTimeoutOverride,
                tracingService, requestAuthorization, admittedVoiceLanguage,
                configuredSynthesisWorkers(), null);
    }

    /** Test seam for deterministic bounded-dispatch tests; the caller retains executor ownership. */
    TtsGrpcService(
            AudioVideoLibrary library,
            MeterRegistry metrics,
            BooleanSupplier synthesisAdmitted,
            BooleanSupplier streamingAdmitted,
            Duration streamingTimeoutOverride,
            AudioVideoTracingService tracingService,
            TtsRequestAuthorization requestAuthorization,
            BiPredicate<String, Locale> admittedVoiceLanguage,
            ContextAwareBoundedExecutor synthesisDispatcher) {
        this(library, metrics, synthesisAdmitted, streamingAdmitted, streamingTimeoutOverride,
                tracingService, requestAuthorization, admittedVoiceLanguage, null,
                Objects.requireNonNull(synthesisDispatcher, "synthesisDispatcher"));
    }

    private TtsGrpcService(
            AudioVideoLibrary library,
            MeterRegistry metrics,
            BooleanSupplier synthesisAdmitted,
            BooleanSupplier streamingAdmitted,
            Duration streamingTimeoutOverride,
            AudioVideoTracingService tracingService,
            TtsRequestAuthorization requestAuthorization,
            BiPredicate<String, Locale> admittedVoiceLanguage,
            ExecutorService ownedSynthesisWorkers,
            ContextAwareBoundedExecutor suppliedDispatcher) {
        this.library = Objects.requireNonNull(library, "library");
        Objects.requireNonNull(metrics, "metrics");
        this.synthesisAdmitted = Objects.requireNonNull(synthesisAdmitted, "synthesisAdmitted");
        this.admittedVoiceLanguage = Objects.requireNonNull(admittedVoiceLanguage, "admittedVoiceLanguage");
        this.streamingAdmitted = Objects.requireNonNull(streamingAdmitted, "streamingAdmitted");
        if (streamingTimeoutOverride != null
                && (streamingTimeoutOverride.isZero() || streamingTimeoutOverride.isNegative())) {
            throw new IllegalArgumentException("streamingTimeoutOverride must be positive");
        }
        this.streamingTimeoutOverride = streamingTimeoutOverride;
        this.tracingService = Objects.requireNonNull(tracingService, "tracingService");
        this.requestAuthorization = Objects.requireNonNull(requestAuthorization, "requestAuthorization");
        this.ownedSynthesisWorkers = ownedSynthesisWorkers;
        this.synthesisDispatcher = suppliedDispatcher != null ? suppliedDispatcher
                : new ContextAwareBoundedExecutor(Objects.requireNonNull(ownedSynthesisWorkers, "synthesisWorkers"));
        this.streamStartDispatcher = new ContextAwareBoundedExecutor(ownedSynthesisWorkers != null
                ? ownedSynthesisWorkers : Runnable::run);
        this.workflowMetrics = new MediaWorkflowMetrics(metrics, "tts");
        this.instrumentation = new AudioVideoGrpcInstrumentation(null, workflowMetrics);
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
    public String scrapeMetrics() {
        return workflowMetrics.scrape();
    }

    @Override
    public void synthesize(
            SynthesizeRequest request,
            StreamObserver<SynthesizeResponse> responseObserver) {
        TracingObserver<SynthesizeResponse> trace = startSynthesisTrace(responseObserver);
        long startedNanos = System.nanoTime();
        AtomicBoolean terminal = new AtomicBoolean();
        final String text;
        final SynthesisOptions options;
        final JwtServerInterceptor.VerifiedIdentity callerIdentity;
        try {
            text = validateText(request.getText());
            SynthesisControlPolicy.rejectUnqualifiedSsml(text);
            options = options(request);
            callerIdentity = JwtServerInterceptor.verifiedIdentity();
            // Voice, tenant, consent, and rights authorization stays on the incoming gRPC
            // context and must pass before any bounded worker receives the request.
            requireAuthorizedVoiceSelection(request, TtsRequestAuthorization.Operation.SYNTHESIZE, callerIdentity);
            requireAdmittedVoiceLanguage(options.voiceId(), options.language());
        } catch (RuntimeException exception) {
            fail(trace.observer, "Synthesis", exception);
            synthesizeTimer.record(System.nanoTime() - startedNanos, TimeUnit.NANOSECONDS);
            return;
        }

        java.util.concurrent.Callable<PreparedSynthesis> synthesisWork = () -> {
            AtomicBoolean providerBoundaryRecorded = new AtomicBoolean();
            try (Scope ignored = trace.makeCurrent()) {
                try (AudioVideoGrpcInstrumentation.BoundaryMeasurement boundary =
                             instrumentation.beginBoundaryMeasurement(MediaWorkflowMetrics.Modality.TTS,
                                     MediaWorkflowMetrics.Boundary.PROVIDER)) {
                    if (isCancelled(responseObserver)) {
                        providerBoundaryRecorded.set(true);
                        boundary.complete(MediaWorkflowMetrics.Outcome.UNKNOWN);
                        throw Status.UNKNOWN.withDescription("UNKNOWN_OUTCOME: synthesis canceled before provider dispatch")
                                .asRuntimeException();
                    }
                    try {
                        // Queueing can outlive the initial consent/rights snapshot. Recheck
                        // against the captured caller immediately before provider dispatch.
                        requireAuthorizedVoiceSelection(
                                request, TtsRequestAuthorization.Operation.SYNTHESIZE, callerIdentity);
                        AudioData audio = library.getTtsEngine().synthesize(text, options);
                        PcmAudioValidator.PcmFacts facts = validatePcm16Output(audio, options.outputFormat(), options.sampleRate());
                        if (isCancelled(responseObserver)) {
                            providerBoundaryRecorded.set(true);
                            boundary.complete(MediaWorkflowMetrics.Outcome.UNKNOWN);
                            throw Status.UNKNOWN.withDescription("UNKNOWN_OUTCOME: synthesis may have completed after cancellation")
                                    .asRuntimeException();
                        }
                        providerBoundaryRecorded.set(true);
                        boundary.complete(MediaWorkflowMetrics.Outcome.SUCCESS);
                        return new PreparedSynthesis(audio, facts);
                    } catch (TtsRequestAuthorization.AuthorizationException denied) {
                        if (providerBoundaryRecorded.compareAndSet(false, true)) {
                            boundary.complete(MediaWorkflowMetrics.Outcome.FAILURE);
                        }
                        throw denied;
                    } catch (RuntimeException providerFailure) {
                        if (providerBoundaryRecorded.compareAndSet(false, true)) {
                            boundary.complete(MediaWorkflowMetrics.Outcome.UNKNOWN);
                        }
                        throw providerFailure;
                    }
                }
            }
        };
        final ContextAwareBoundedExecutor.Submission<PreparedSynthesis> submission;
        synchronized (synthesisLifecycleLock) {
            if (synthesisClosing) {
                if (terminal.compareAndSet(false, true)) {
                    synthesizeTimer.record(System.nanoTime() - startedNanos, TimeUnit.NANOSECONDS);
                    failWithStatus(trace.observer, Status.UNAVAILABLE
                            .withDescription("TTS service is closing and did not dispatch synthesis")
                            .asRuntimeException());
                }
                return;
            }
            submission = synthesisDispatcher.submit(synthesisWork, true);
            outstandingSynthesis.add(submission);
        }

        submission.result().whenComplete((prepared, failure) -> {
            synchronized (synthesisLifecycleLock) {
                outstandingSynthesis.remove(submission);
            }
            if (!terminal.compareAndSet(false, true)) return;
            synthesizeTimer.record(System.nanoTime() - startedNanos, TimeUnit.NANOSECONDS);
            if (failure != null) {
                Throwable cause = unwrapCompletion(failure);
                if (cause instanceof io.grpc.StatusRuntimeException statusFailure
                        && statusFailure.getStatus().getCode() == Status.Code.UNKNOWN) {
                    trace.finishUnknown();
                    recordSynthesisResponseUnknown();
                    notifyError(responseObserver, statusFailure);
                } else if (cause instanceof io.grpc.StatusRuntimeException statusFailure
                        && statusFailure.getStatus().getCode() == Status.Code.RESOURCE_EXHAUSTED) {
                    failWithStatus(trace.observer, statusFailure);
                } else if (cause instanceof io.grpc.StatusRuntimeException statusFailure
                        && statusFailure.getStatus().getCode() == Status.Code.DEADLINE_EXCEEDED) {
                    failWithStatus(trace.observer, statusFailure);
                } else if (cause instanceof io.grpc.StatusRuntimeException statusFailure
                        && statusFailure.getStatus().getCode() == Status.Code.CANCELLED) {
                    if (submission.started()) {
                        trace.finishUnknown();
                        recordSynthesisResponseUnknown();
                        notifyError(responseObserver, Status.UNKNOWN
                                .withDescription("UNKNOWN_OUTCOME: synthesis may have completed after provider dispatch")
                                .asRuntimeException());
                    } else {
                        failWithStatus(trace.observer, statusFailure);
                    }
                } else if (cause instanceof RuntimeException runtimeFailure) {
                    fail(trace.observer, "Synthesis", runtimeFailure);
                } else {
                    fail(trace.observer, "Synthesis", new IllegalStateException("TTS synthesis failed", cause));
                }
                return;
            }
            if (isCancelled(responseObserver)) {
                trace.finishUnknown();
                recordSynthesisResponseUnknown();
                notifyError(responseObserver, Status.UNKNOWN
                        .withDescription("UNKNOWN_OUTCOME: synthesis completed after caller cancellation")
                        .asRuntimeException());
                return;
            }
            try (Scope ignored = trace.makeCurrent();
                 AudioVideoGrpcInstrumentation.BoundaryMeasurement responseBoundary =
                         instrumentation.beginBoundaryMeasurement(MediaWorkflowMetrics.Modality.TTS,
                                 MediaWorkflowMetrics.Boundary.RESPONSE)) {
                SynthesizeResponse response = SynthesizeResponse.newBuilder()
                        .setAudioData(com.google.protobuf.ByteString.copyFrom(prepared.audio().data()))
                        .setSampleRate(prepared.audio().sampleRate())
                        .setDurationMs(Math.toIntExact(prepared.facts().duration().toMillis()))
                        .setProcessingTimeMs(Math.toIntExact(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos)))
                        .setVoiceUsed(options.voiceId() == null ? "" : options.voiceId())
                        .build();
                try {
                    trace.observer.onNext(response);
                    trace.observer.onCompleted();
                    responseBoundary.complete(MediaWorkflowMetrics.Outcome.SUCCESS);
                } catch (RuntimeException | Error ambiguousDelivery) {
                    responseBoundary.complete(MediaWorkflowMetrics.Outcome.UNKNOWN);
                    trace.finishUnknown();
                }
            } catch (RuntimeException mappingFailure) {
                fail(trace.observer, "Synthesis", mappingFailure);
            }
        });
    }

    private record PreparedSynthesis(AudioData audio, PcmAudioValidator.PcmFacts facts) { }

    private static Throwable unwrapCompletion(Throwable failure) {
        return failure instanceof CompletionException && failure.getCause() != null ? failure.getCause() : failure;
    }

    private static void notifyError(StreamObserver<?> observer, Throwable failure) {
        try { observer.onError(failure); } catch (RuntimeException ignored) { /* transport already terminal */ }
    }

    private void recordSynthesisResponseUnknown() {
        try (AudioVideoGrpcInstrumentation.BoundaryMeasurement boundary =
                     instrumentation.beginBoundaryMeasurement(
                             MediaWorkflowMetrics.Modality.TTS, MediaWorkflowMetrics.Boundary.RESPONSE)) {
            boundary.complete(MediaWorkflowMetrics.Outcome.UNKNOWN);
        }
    }

    private static <T> void failWithStatus(StreamObserver<T> observer, io.grpc.StatusRuntimeException failure) {
        notifyError(observer, failure);
    }

    private static ThreadPoolExecutor configuredSynthesisWorkers() {
        int workers = configuredPositiveInt(SYNTHESIS_WORKERS_PROPERTY, "MEDIA_TTS_SYNTHESIS_WORKERS",
                DEFAULT_SYNTHESIS_WORKERS, 64);
        int queueCapacity = configuredPositiveInt(SYNTHESIS_QUEUE_PROPERTY, "MEDIA_TTS_SYNTHESIS_QUEUE_CAPACITY",
                DEFAULT_SYNTHESIS_QUEUE_CAPACITY, 4096);
        AtomicInteger threadNumber = new AtomicInteger();
        return new ThreadPoolExecutor(workers, workers, 0L, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(queueCapacity), runnable -> {
                    Thread thread = new Thread(runnable, "tts-synthesis-worker-" + threadNumber.incrementAndGet());
                    thread.setDaemon(true);
                    return thread;
                }, new ThreadPoolExecutor.AbortPolicy());
    }

    private static int configuredPositiveInt(String property, String environment, int fallback, int max) {
        String raw = System.getProperty(property);
        if (raw == null || raw.isBlank()) raw = System.getenv(environment);
        if (raw == null || raw.isBlank()) return fallback;
        try {
            int value = Integer.parseInt(raw.trim());
            if (value < 1 || value > max) throw new IllegalArgumentException(property + " must be in [1," + max + "]");
            return value;
        } catch (NumberFormatException invalid) {
            throw new IllegalArgumentException(property + " must be an integer", invalid);
        }
    }

    /** Shuts down the service-owned synthesis worker pool after server termination. */
    public void close() {
        stopSynthesisWorkers();
    }

    /**
     * Stops new unary synthesis, completes every outstanding submission, then drains the
     * owned unary and stream-start workers and active sessions. A false result means a
     * non-cooperative worker or session may still use the library.
     */
    protected final boolean stopSynthesisWorkers() {
        List<ContextAwareBoundedExecutor.Submission<?>> pending;
        List<TtsStreamingSession> sessions;
        synchronized (synthesisLifecycleLock) {
            synthesisClosing = true;
            pending = new ArrayList<>(outstandingSynthesis);
            sessions = new ArrayList<>(activeStreamingSessions);
        }
        pending.forEach(ContextAwareBoundedExecutor.Submission::cancel);
        sessions.forEach(TtsGrpcService::cancelSessionSafely);

        if (ownedSynthesisWorkers == null) return true;
        ownedSynthesisWorkers.shutdown();
        boolean terminated = awaitWorkerTermination(ownedSynthesisWorkers, 5, TimeUnit.SECONDS);
        if (!terminated) {
            ownedSynthesisWorkers.shutdownNow();
            terminated = awaitWorkerTermination(ownedSynthesisWorkers, 1, TimeUnit.SECONDS);
        }
        if (!terminated) {
            LOG.error("TTS synthesis worker did not terminate after bounded drain; provider library must remain open");
        }
        boolean streamsTerminated = awaitStreamingSessions(1, TimeUnit.SECONDS);
        if (!streamsTerminated) {
            LOG.error("TTS streaming session remains active after cancellation; provider library must remain open");
        }
        return terminated && streamsTerminated;
    }

    private boolean awaitStreamingSessions(long timeout, TimeUnit unit) {
        long remainingNanos = unit.toNanos(timeout);
        long deadline = System.nanoTime() + remainingNanos;
        synchronized (synthesisLifecycleLock) {
            while (!activeStreamingSessions.isEmpty() && remainingNanos > 0) {
                try {
                    TimeUnit.NANOSECONDS.timedWait(synthesisLifecycleLock, remainingNanos);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return activeStreamingSessions.isEmpty();
                }
                remainingNanos = deadline - System.nanoTime();
            }
            return activeStreamingSessions.isEmpty();
        }
    }

    private static void cancelSessionSafely(TtsStreamingSession session) {
        try {
            session.cancel();
        } catch (RuntimeException cancellationFailure) {
            LOG.warn("TTS streaming session cancellation failed ({})", cancellationFailure.getClass().getSimpleName());
        }
    }

    private void trackStreamingSession(TtsStreamingSession session) {
        boolean cancelForShutdown;
        synchronized (synthesisLifecycleLock) {
            activeStreamingSessions.add(session);
            cancelForShutdown = synthesisClosing;
        }
        session.completion().whenComplete((ignored, failure) -> {
            synchronized (synthesisLifecycleLock) {
                activeStreamingSessions.remove(session);
                synthesisLifecycleLock.notifyAll();
            }
        });
        if (cancelForShutdown) cancelSessionSafely(session);
    }

    private static boolean awaitWorkerTermination(ExecutorService executor, long timeout, TimeUnit unit) {
        try {
            return executor.awaitTermination(timeout, unit);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return executor.isTerminated();
        }
    }

    @Override
    public void streamSynthesize(
            SynthesizeRequest request,
            StreamObserver<AudioChunk> responseObserver) {
        AudioVideoGrpcInstrumentation.BoundaryMeasurement responseBoundary =
                instrumentation.beginBoundaryMeasurement(
                        MediaWorkflowMetrics.Modality.TTS,
                        MediaWorkflowMetrics.Boundary.RESPONSE);
        AtomicBoolean responseRecorded = new AtomicBoolean();
        AtomicBoolean responseDeliveryUnknown = new AtomicBoolean();
        java.util.function.Consumer<MediaWorkflowMetrics.Outcome> recordResponse = outcome -> {
            if (responseRecorded.compareAndSet(false, true)) responseBoundary.complete(outcome);
        };
        StreamObserver<AudioChunk> measuredObserver = new StreamObserver<>() {
            @Override public void onNext(AudioChunk value) {
                try {
                    responseObserver.onNext(value);
                } catch (RuntimeException | Error ambiguousDelivery) {
                    responseDeliveryUnknown.set(true);
                    recordResponse.accept(MediaWorkflowMetrics.Outcome.UNKNOWN);
                    throw ambiguousDelivery;
                }
            }
            @Override public void onError(Throwable failure) {
                try {
                    responseObserver.onError(failure);
                    recordResponse.accept(MediaWorkflowMetrics.Outcome.FAILURE);
                } catch (RuntimeException | Error ambiguousDelivery) {
                    responseDeliveryUnknown.set(true);
                    recordResponse.accept(MediaWorkflowMetrics.Outcome.UNKNOWN);
                    throw ambiguousDelivery;
                }
            }
            @Override public void onCompleted() {
                try {
                    responseObserver.onCompleted();
                    recordResponse.accept(MediaWorkflowMetrics.Outcome.SUCCESS);
                } catch (RuntimeException | Error ambiguousDelivery) {
                    responseDeliveryUnknown.set(true);
                    recordResponse.accept(MediaWorkflowMetrics.Outcome.UNKNOWN);
                    throw ambiguousDelivery;
                }
            }
        };
        TracingObserver<AudioChunk> trace = startSynthesisTrace(measuredObserver);
        StreamObserver<AudioChunk> tracedObserver = trace.observer;
        Context operationContext = Context.current().with(trace.span);
        long startedNanos = System.nanoTime();
        AtomicBoolean cancelled = new AtomicBoolean();
        AtomicBoolean sessionCancelled = new AtomicBoolean();
        AtomicBoolean terminal = new AtomicBoolean();
        AtomicBoolean completionDeliveryStarted = new AtomicBoolean();
        AtomicBoolean sessionCancellationRequested = new AtomicBoolean();
        AtomicBoolean timerRecorded = new AtomicBoolean();
        Runnable recordDuration = () -> {
            if (timerRecorded.compareAndSet(false, true)) {
                streamingTimer.record(System.nanoTime() - startedNanos, TimeUnit.NANOSECONDS);
            }
        };
        AtomicReference<TtsStreamingSession> activeSession = new AtomicReference<>();
        AtomicReference<ContextAwareBoundedExecutor.Submission<TtsStreamingSession>> startSubmissionRef =
                new AtomicReference<>();
        Runnable requestSessionCancellation = () -> {
            sessionCancellationRequested.set(true);
            sessionCancelled.set(true);
            TtsStreamingSession running = activeSession.get();
            if (running != null) cancelSessionSafely(running);
            ContextAwareBoundedExecutor.Submission<TtsStreamingSession> starting = startSubmissionRef.get();
            if (starting != null) starting.cancel();
        };
        Object readinessLock = new Object();
        ServerCallStreamObserver<AudioChunk> serverObserver = serverObserver(responseObserver);
        io.grpc.Context.CancellableContext grpcOperationContext = io.grpc.Context.current().withCancellation();
        Runnable handleCancellation = operationContext.wrap(() -> {
            boolean beforeCompletionDelivery = !completionDeliveryStarted.get();
            boolean cancellationWon = beforeCompletionDelivery && terminal.compareAndSet(false, true);
            if (cancellationWon) {
                cancelled.set(true);
                sessionCancelled.set(true);
                recordResponse.accept(MediaWorkflowMetrics.Outcome.UNKNOWN);
                recordDuration.run();
                trace.finishUnknown();
                synchronized (readinessLock) { readinessLock.notifyAll(); }
            }
            // A timeout or provider failure can reserve the terminal result just before the
            // transport reports cancellation. The transport then loses the terminal CAS, but
            // the active provider session still must be stopped while completion is pending.
            if (cancellationWon || beforeCompletionDelivery && terminal.get()) {
                requestSessionCancellation.run();
            }
        });
        grpcOperationContext.addListener(ignored -> handleCancellation.run(), Runnable::run);

        if (serverObserver != null) {
            serverObserver.setOnCancelHandler(handleCancellation);
            // The call may already be cancelled before the handler is installed. Check
            // transport state as well so canceled work does not continue into parsing or
            // capability evaluation merely because the callback was not observed here.
            if (cancelled.get() || serverObserver.isCancelled()) {
                recordResponse.accept(MediaWorkflowMetrics.Outcome.UNKNOWN);
                recordDuration.run();
                trace.finishUnknown();
                return;
            }
        }

        try {
            String text = validateText(request.getText());
            SynthesisControlPolicy.rejectUnqualifiedSsml(text);
            SynthesisOptions synthesisOptions = options(request);
            if (cancelled.get() || serverObserver != null && serverObserver.isCancelled()) {
                recordResponse.accept(MediaWorkflowMetrics.Outcome.UNKNOWN);
                recordDuration.run();
                trace.finishUnknown();
                return;
            }
            // Capture interceptor-verified identity while still on the gRPC call context;
            // provider callbacks and completion run on unrelated executor threads.
            JwtServerInterceptor.VerifiedIdentity streamIdentity = JwtServerInterceptor.verifiedIdentity();
            requireAuthorizedVoiceSelection(
                    request, TtsRequestAuthorization.Operation.STREAM_SYNTHESIZE, streamIdentity);
            requireAdmittedVoiceLanguage(synthesisOptions.voiceId(), synthesisOptions.language());
            requireAdmittedStreamingProvider();
            if (cancelled.get() || serverObserver != null && serverObserver.isCancelled()) {
                recordResponse.accept(MediaWorkflowMetrics.Outcome.UNKNOWN);
                recordDuration.run();
                trace.finishUnknown();
                return;
            }
            AtomicInteger expectedSequence = new AtomicInteger();
            AtomicBoolean finalChunkSeen = new AtomicBoolean();
            AtomicLong outputBytes = new AtomicLong();
            AtomicLong lastTimestampMs = new AtomicLong(-1);
            AtomicReference<CanonicalAudioFormat> declaredStreamFormat = new AtomicReference<>();
            AtomicReference<com.ghatana.media.common.AudioChunk> pendingFinalChunk = new AtomicReference<>();
            Object chunkLock = new Object();
            if (serverObserver != null) {
                serverObserver.setOnReadyHandler(() -> {
                    synchronized (readinessLock) { readinessLock.notifyAll(); }
                });
            }
            TtsStreamSink sink = new TtsStreamSink() {
                @Override public boolean isReady() {
                    return cancelled.get() || serverObserver == null || serverObserver.isReady();
                }
                @Override public boolean isCancelled() {
                    return sessionCancelled.get() || cancelled.get()
                            || serverObserver != null && serverObserver.isCancelled();
                }
                @Override public void awaitReady() throws InterruptedException {
                    synchronized (readinessLock) {
                        while (!isReady() && !isCancelled()) readinessLock.wait();
                    }
                }
                @Override public void onAudioFormat(CanonicalAudioFormat format) {
                    try (Scope ignored = operationContext.makeCurrent()) {
                        try {
                            if (format == null) {
                                throw new IllegalStateException("TTS provider did not declare an audio format");
                            }
                            if (!declaredStreamFormat.compareAndSet(null, format)) {
                                throw new IllegalStateException("TTS provider declared the stream format more than once");
                            }
                            if (format.format() != AudioFormat.PCM
                                    || format.channels() != 1
                                    || format.bitsPerSample() != 16
                                    || format.sampleRate() != synthesisOptions.sampleRate()) {
                                throw new IllegalStateException(
                                        "TTS stream format does not match the mono PCM S16LE response contract");
                            }
                        } catch (RuntimeException streamFailure) {
                            if (!isCancelled() && terminal.compareAndSet(false, true)) {
                                requestSessionCancellation.run();
                                fail(tracedObserver, "Streaming synthesis", streamFailure);
                                recordDuration.run();
                            } else {
                                requestSessionCancellation.run();
                            }
                        }
                    }
                }
                @Override public void onChunk(com.ghatana.media.common.AudioChunk chunk) {
                    try (Scope ignored = operationContext.makeCurrent()) {
                    if (terminal.get()) return;
                    try {
                        synchronized (chunkLock) {
                            if (isCancelled() || terminal.get()) return;
                            CanonicalAudioFormat format = declaredStreamFormat.get();
                            if (format == null) {
                                throw new IllegalStateException("TTS provider emitted audio before declaring its format");
                            }
                            if (chunk == null || chunk.data() == null) {
                                throw new IllegalStateException("TTS provider emitted a null audio chunk");
                            }
                            byte[] providerData = chunk.data();
                            if (providerData.length == 0 || providerData.length > MAX_STREAM_CHUNK_BYTES) {
                                throw new IllegalStateException("TTS stream chunk exceeds the admitted non-empty 64 KiB bound");
                            }
                            long acceptedBytes = outputBytes.get();
                            if (acceptedBytes > MAX_STREAM_OUTPUT_BYTES
                                    || providerData.length > MAX_STREAM_OUTPUT_BYTES - acceptedBytes) {
                                throw new IllegalStateException("TTS stream output exceeds the 50 MiB bound");
                            }
                            // The shared chunk value carries a mutable byte array. Snapshot it at
                            // the callback boundary because the final chunk is retained until
                            // asynchronous session completion and providers may reuse buffers.
                            // Both the per-chunk and cumulative ceilings are enforced before
                            // copying provider-owned memory.
                            byte[] chunkData = providerData.clone();
                            com.ghatana.media.common.AudioChunk chunkSnapshot =
                                    new com.ghatana.media.common.AudioChunk(
                                            chunkData,
                                            chunk.sequenceNumber(),
                                            chunk.isLast(),
                                            chunk.timestampMs());
                            if (chunkData.length % (format.channels() * (format.bitsPerSample() / 8)) != 0) {
                                throw new IllegalStateException("TTS stream chunk ends inside an audio frame");
                            }
                            if (chunk.sequenceNumber() != expectedSequence.getAndIncrement()) {
                                throw new IllegalStateException("TTS provider returned a non-contiguous chunk sequence");
                            }
                            if (chunk.timestampMs() < 0 || chunk.timestampMs() < lastTimestampMs.get()) {
                                throw new IllegalStateException(
                                        "TTS provider returned a negative or non-monotonic chunk timestamp");
                            }
                            lastTimestampMs.set(chunk.timestampMs());
                            if (finalChunkSeen.get()) {
                                throw new IllegalStateException("TTS provider emitted audio after its final chunk");
                            }
                            outputBytes.addAndGet(chunkData.length);
                            if (chunk.isLast()) {
                                finalChunkSeen.set(true);
                                pendingFinalChunk.set(chunkSnapshot);
                                return;
                            }
                            try {
                                awaitSinkReady(this);
                            } catch (InterruptedException interrupted) {
                                Thread.currentThread().interrupt();
                                throw new IllegalStateException("TTS stream interrupted while waiting for downstream readiness", interrupted);
                            }
                            if (!isCancelled()) {
                                // A long-lived stream can outlive voice consent. Recheck at
                                // the actual disclosure boundary, after backpressure has
                                // cleared, so a revoked grant cannot leak another chunk.
                                requireAuthorizedVoiceSelection(
                                        request, TtsRequestAuthorization.Operation.STREAM_SYNTHESIZE,
                                        streamIdentity);
                                tracedObserver.onNext(toGrpcChunk(chunkSnapshot, synthesisOptions, false));
                            }
                        }
                    } catch (RuntimeException | Error streamFailure) {
                        if (responseDeliveryUnknown.get()) {
                            if (terminal.compareAndSet(false, true)) {
                                requestSessionCancellation.run();
                                recordDuration.run();
                            } else {
                                requestSessionCancellation.run();
                            }
                            if (streamFailure instanceof Error fatal) throw fatal;
                        } else if (streamFailure instanceof RuntimeException runtimeFailure
                                && !isCancelled() && terminal.compareAndSet(false, true)) {
                            requestSessionCancellation.run();
                            fail(tracedObserver, "Streaming synthesis", runtimeFailure);
                            recordDuration.run();
                        } else {
                            requestSessionCancellation.run();
                            recordResponse.accept(MediaWorkflowMetrics.Outcome.UNKNOWN);
                            recordDuration.run();
                            trace.finishUnknown();
                            if (streamFailure instanceof Error fatal) throw fatal;
                        }
                    }
                    }
                }
            };
            Duration deadline = streamingTimeoutOverride == null
                    ? synthesisOptions.timeout() : streamingTimeoutOverride;
            long timeoutMillis = Math.max(1, deadline.toMillis());
            CompletableFuture.delayedExecutor(timeoutMillis, TimeUnit.MILLISECONDS).execute(operationContext.wrap(() -> {
                if (!cancelled.get() && (serverObserver == null || !serverObserver.isCancelled())
                        && terminal.compareAndSet(false, true)) {
                    if (cancelled.get() || serverObserver != null && serverObserver.isCancelled()) {
                        cancelled.set(true);
                        sessionCancelled.set(true);
                        recordResponse.accept(MediaWorkflowMetrics.Outcome.UNKNOWN);
                        recordDuration.run();
                        synchronized (readinessLock) { readinessLock.notifyAll(); }
                        requestSessionCancellation.run();
                        trace.finishUnknown();
                        return;
                    }
                    sessionCancelled.set(true);
                    synchronized (readinessLock) { readinessLock.notifyAll(); }
                    requestSessionCancellation.run();
                    fail(tracedObserver, "Streaming synthesis", new TtsStreamTimeoutException());
                    recordDuration.run();
                }
            }));
            java.util.function.Consumer<TtsStreamingSession> attachSession = session -> {
                activeSession.set(session);
                // A provider session can arrive after timeout won while startStreaming was
                // blocked. Cancel late sessions before observing their completion.
                if (sessionCancellationRequested.get() || terminal.get() || sessionCancelled.get() || cancelled.get()
                        || serverObserver != null && serverObserver.isCancelled()) {
                    requestSessionCancellation.run();
                }
                session.completion().whenComplete((ignored, failure) -> {
                    Thread.startVirtualThread(operationContext.wrap(() -> {
                    if (terminal.get()) return;
                    if (cancelled.get() || serverObserver != null && serverObserver.isCancelled()) {
                        if (terminal.compareAndSet(false, true)) {
                            recordResponse.accept(MediaWorkflowMetrics.Outcome.UNKNOWN);
                            recordDuration.run();
                            trace.finishUnknown();
                        }
                        return;
                    }
                    if (failure != null) {
                        Throwable cause = failure instanceof CompletionException && failure.getCause() != null
                                ? failure.getCause() : failure;
                        if (terminal.compareAndSet(false, true)) {
                            // A provider final chunk is only provisional until the session
                            // completion succeeds. Drop it on every failed completion so an
                            // ambiguous provider outcome cannot become successful final output.
                            pendingFinalChunk.set(null);
                            if (cause instanceof StatusRuntimeException statusFailure
                                    && statusFailure.getStatus().getCode() == Status.Code.UNKNOWN) {
                                // A provider can lose its connection after producing a prefix. Keep
                                // that ambiguity visible at the stream boundary; mapping UNKNOWN
                                // through fail() would turn it into INTERNAL and imply a known
                                // failure outcome. In either case, the absent provider final chunk
                                // must never be synthesized by this adapter.
                                recordResponse.accept(MediaWorkflowMetrics.Outcome.UNKNOWN);
                                trace.finishUnknown();
                                notifyError(responseObserver, statusFailure);
                            } else {
                                fail(tracedObserver, "Streaming synthesis", cause instanceof RuntimeException runtime
                                        ? runtime : new IllegalStateException("TTS streaming provider failed", cause));
                            }
                            recordDuration.run();
                        }
                    } else if (!finalChunkSeen.get() || pendingFinalChunk.get() == null) {
                        if (terminal.compareAndSet(false, true)) {
                            fail(tracedObserver, "Streaming synthesis",
                                    new IllegalStateException("TTS stream completed without a provider final chunk"));
                            recordDuration.run();
                        }
                    } else {
                        try {
                            awaitSinkReady(sink);
                            if (sink.isCancelled()) {
                                if (terminal.compareAndSet(false, true)) {
                                    recordResponse.accept(MediaWorkflowMetrics.Outcome.UNKNOWN);
                                    recordDuration.run();
                                    trace.finishUnknown();
                                }
                                return;
                            }
                            // The provider's final marker may sit buffered while synthesis
                            // finishes or while downstream is backpressured. Revalidate
                            // immediately before exposing it as final.
                            requireAuthorizedVoiceSelection(
                                    request, TtsRequestAuthorization.Operation.STREAM_SYNTHESIZE,
                                    streamIdentity);
                            if (terminal.compareAndSet(false, true)) {
                                tracedObserver.onNext(toGrpcChunk(pendingFinalChunk.get(), synthesisOptions, true));
                                completionDeliveryStarted.set(true);
                                tracedObserver.onCompleted();
                            }
                        } catch (InterruptedException interrupted) {
                            Thread.currentThread().interrupt();
                            if (!sink.isCancelled() && terminal.compareAndSet(false, true)) {
                                fail(tracedObserver, "Streaming synthesis",
                                        new IllegalStateException("TTS stream interrupted before final delivery", interrupted));
                            } else {
                                recordResponse.accept(MediaWorkflowMetrics.Outcome.UNKNOWN);
                            }
                        } catch (RuntimeException finalDeliveryFailure) {
                            if (!sink.isCancelled() && terminal.compareAndSet(false, true)) {
                                requestSessionCancellation.run();
                                fail(tracedObserver, "Streaming synthesis", finalDeliveryFailure);
                            } else {
                                requestSessionCancellation.run();
                                recordResponse.accept(MediaWorkflowMetrics.Outcome.UNKNOWN);
                            }
                        }
                        recordDuration.run();
                    }
                    }));
                });
            };

            ContextAwareBoundedExecutor.Submission<TtsStreamingSession> startSubmission;
            synchronized (synthesisLifecycleLock) {
                if (synthesisClosing) {
                    throw Status.UNAVAILABLE.withDescription("TTS service is closing and did not start streaming")
                            .asRuntimeException();
                }
                startSubmission = streamStartDispatcher.submit(() -> {
                    TtsStreamingSession session;
                    try (Scope ignored = operationContext.makeCurrent()) {
                        requireAuthorizedVoiceSelection(
                                request, TtsRequestAuthorization.Operation.STREAM_SYNTHESIZE, streamIdentity);
                        TtsEngine engine = library.getTtsEngine();
                        session = engine.startStreaming(text, synthesisOptions, sink);
                    }
                    if (session == null) {
                        throw new IllegalStateException("TTS provider returned no streaming session");
                    }
                    trackStreamingSession(session);
                    if (sessionCancellationRequested.get() || terminal.get() || sessionCancelled.get() || cancelled.get()
                            || serverObserver != null && serverObserver.isCancelled()) {
                        cancelSessionSafely(session);
                    }
                    return session;
                }, true);
                outstandingSynthesis.add(startSubmission);
                startSubmissionRef.set(startSubmission);
            }
            if (terminal.get() || cancelled.get() || serverObserver != null && serverObserver.isCancelled()) {
                startSubmission.cancel();
            }
            startSubmission.result().whenComplete((session, failure) -> {
                synchronized (synthesisLifecycleLock) {
                    outstandingSynthesis.remove(startSubmission);
                }
                if (failure != null) {
                    if (!terminal.compareAndSet(false, true)) return;
                    Throwable cause = unwrapCompletion(failure);
                    if (cause instanceof io.grpc.StatusRuntimeException statusFailure
                            && statusFailure.getStatus().getCode() == Status.Code.UNKNOWN) {
                        recordResponse.accept(MediaWorkflowMetrics.Outcome.UNKNOWN);
                        trace.finishUnknown();
                        notifyError(responseObserver, statusFailure);
                    } else if (cause instanceof io.grpc.StatusRuntimeException statusFailure
                            && statusFailure.getStatus().getCode() == Status.Code.RESOURCE_EXHAUSTED) {
                        tracedObserver.onError(statusFailure);
                    } else if (cause instanceof io.grpc.StatusRuntimeException statusFailure
                            && statusFailure.getStatus().getCode() == Status.Code.DEADLINE_EXCEEDED) {
                        tracedObserver.onError(statusFailure);
                    } else if (cause instanceof RuntimeException runtimeFailure) {
                        fail(tracedObserver, "Streaming synthesis", runtimeFailure);
                    } else {
                        fail(tracedObserver, "Streaming synthesis",
                                new IllegalStateException("TTS streaming provider failed", cause));
                    }
                    recordDuration.run();
                    return;
                }
                if (terminal.get() || cancelled.get() || serverObserver != null && serverObserver.isCancelled()) {
                    requestSessionCancellation.run();
                    return;
                }
                attachSession.accept(session);
            });
            return;
        } catch (RuntimeException exception) {
            if (!cancelled.get() && (serverObserver == null || !serverObserver.isCancelled())
                    && terminal.compareAndSet(false, true)) {
                fail(tracedObserver, "Streaming synthesis", exception);
            } else {
                recordResponse.accept(MediaWorkflowMetrics.Outcome.UNKNOWN);
            }
            recordDuration.run();
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
            try (AudioVideoGrpcInstrumentation.BoundaryMeasurement responseBoundary =
                         instrumentation.beginBoundaryMeasurement(
                                 MediaWorkflowMetrics.Modality.TTS,
                                 MediaWorkflowMetrics.Boundary.RESPONSE)) {
                final GetVoicesResponse response;
                try {
                    GetVoicesResponse.Builder builder = GetVoicesResponse.newBuilder();
                    for (VoiceInfo voice : voices) {
                        builder.addVoices(com.ghatana.tts.core.grpc.proto.VoiceInfo.newBuilder()
                                .setVoiceId(voice.voiceId())
                                .setName(voice.name())
                                .setDescription(voice.description() == null ? "" : voice.description())
                                .addLanguages(voice.language().toLanguageTag())
                                .setGender(voice.gender() == null ? "" : voice.gender().name())
                                .setIsCloned(voice.isCloned())
                                .setSizeBytes(voice.modelSizeBytes())
                                .build());
                    }
                    response = builder.build();
                } catch (RuntimeException responseMappingFailure) {
                    responseBoundary.complete(MediaWorkflowMetrics.Outcome.FAILURE);
                    throw responseMappingFailure;
                }

                try {
                    responseObserver.onNext(response);
                    responseObserver.onCompleted();
                    responseBoundary.complete(MediaWorkflowMetrics.Outcome.SUCCESS);
                } catch (RuntimeException ambiguousDelivery) {
                    responseBoundary.complete(MediaWorkflowMetrics.Outcome.UNKNOWN);
                    throw ambiguousDelivery;
                }
            }
        } catch (RuntimeException exception) {
            fail(responseObserver, "Voice listing", exception);
        }
    }

    @Override
    public void getStatus(
            StatusRequest request,
            StreamObserver<StatusResponse> responseObserver) {
        responseObserver.onError(Status.UNIMPLEMENTED
                .withDescription("GetStatus is NOT_ADMITTED: required active_sessions has no source metric; raw provider diagnostics are not exposed")
                .asRuntimeException());
    }

    @Override
    public void getMetrics(
            MetricsRequest request,
            StreamObserver<MetricsResponse> responseObserver) {
        responseObserver.onError(Status.UNIMPLEMENTED
                .withDescription("GetMetrics is NOT_ADMITTED: required real_time_factor and active_sessions are unavailable, and requestCount is not a successful synthesis count")
                .asRuntimeException());
    }

    @Override
    public void loadVoice(
            LoadVoiceRequest request,
            StreamObserver<LoadVoiceResponse> responseObserver) {
        responseObserver.onError(Status.UNIMPLEMENTED
                .withDescription("Voice loading is NOT_ADMITTED without an authoritative model, license, owner-rights and consent profile")
                .asRuntimeException());
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

    private void requireAuthorizedVoiceSelection(
            SynthesizeRequest request, TtsRequestAuthorization.Operation operation) {
        requireAuthorizedVoiceSelection(request, operation, JwtServerInterceptor.verifiedIdentity());
    }

    private void requireAuthorizedVoiceSelection(
            SynthesizeRequest request,
            TtsRequestAuthorization.Operation operation,
            JwtServerInterceptor.VerifiedIdentity identity) {
        try (AudioVideoGrpcInstrumentation.BoundaryMeasurement admissionBoundary =
                     instrumentation.beginBoundaryMeasurement(
                             MediaWorkflowMetrics.Modality.TTS, MediaWorkflowMetrics.Boundary.ADMISSION)) {
            try {
                TtsRequestAuthorization.requireAdmission(requestAuthorization,
                        identity, operation,
                        request.getVoiceId(), request.getProfileId());
                admissionBoundary.complete(MediaWorkflowMetrics.Outcome.SUCCESS);
            } catch (TtsRequestAuthorization.AuthorizationException denied) {
                admissionBoundary.complete(MediaWorkflowMetrics.Outcome.FAILURE);
                throw denied;
            }
        }
    }

    /**
     * No source-admitted voice/language/rights qualification profile is currently wired.
     * Provider voice listings and configured defaults are informational only, so synthesis must
     * fail before engine lookup instead of allowing a provider to silently select a substitute.
     */
    private void requireAdmittedVoiceLanguage(String voiceId, Locale language) {
        try (AudioVideoGrpcInstrumentation.BoundaryMeasurement admissionBoundary =
                     instrumentation.beginBoundaryMeasurement(
                             MediaWorkflowMetrics.Modality.TTS, MediaWorkflowMetrics.Boundary.ADMISSION)) {
            if (synthesisAdmitted.getAsBoolean() && admittedVoiceLanguage.test(voiceId, language)) {
                admissionBoundary.complete(MediaWorkflowMetrics.Outcome.SUCCESS);
                return;
            }
            admissionBoundary.complete(MediaWorkflowMetrics.Outcome.FAILURE);
            String requestedVoice = voiceId == null || voiceId.isBlank() ? "default" : "explicit";
            String requestedLanguage = language == null ? "unspecified" : language.toLanguageTag();
            throw new LocalAdmissionException(
                    "TTS locale/voice NOT_ADMITTED: no exact admitted voice-language-rights profile "
                            + "for requested voice=" + requestedVoice + ", language=" + requestedLanguage);
        }
    }

    private void requireAdmittedStreamingProvider() {
        try (AudioVideoGrpcInstrumentation.BoundaryMeasurement admissionBoundary =
                     instrumentation.beginBoundaryMeasurement(
                             MediaWorkflowMetrics.Modality.TTS, MediaWorkflowMetrics.Boundary.ADMISSION)) {
            if (streamingAdmitted.getAsBoolean()) {
                admissionBoundary.complete(MediaWorkflowMetrics.Outcome.SUCCESS);
                return;
            }
            admissionBoundary.complete(MediaWorkflowMetrics.Outcome.FAILURE);
            throw new LocalAdmissionException(
                    "TTS streaming is NOT_ADMITTED: no provider has verified mono PCM S16LE framing, sample rate, cancellation and finality");
        }
    }

    private static void awaitSinkReady(TtsStreamSink sink) throws InterruptedException {
        while (!sink.isReady() && !sink.isCancelled()) sink.awaitReady();
    }

    private static AudioChunk toGrpcChunk(
            com.ghatana.media.common.AudioChunk chunk,
            SynthesisOptions options,
            boolean isFinal) {
        return AudioChunk.newBuilder()
                .setAudioData(com.google.protobuf.ByteString.copyFrom(chunk.data()))
                .setSampleRate(options.sampleRate())
                .setTimestampMs(chunk.timestampMs())
                .setIsFinal(isFinal)
                .build();
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

    private static boolean isCancelled(StreamObserver<?> observer) {
        return io.grpc.Context.current().isCancelled()
                || io.grpc.Context.current().getDeadline() != null
                        && io.grpc.Context.current().getDeadline().isExpired()
                || observer instanceof ServerCallStreamObserver<?> serverObserver
                        && serverObserver.isCancelled();
    }

    private <T> TracingObserver<T> startSynthesisTrace(StreamObserver<T> observer) {
        Span span = tracingService.startSynthesisSpan(null, null);
        return new TracingObserver<>(span, observer);
    }

    /** Ends the operation span only when the caller-visible stream reaches a terminal outcome. */
    private final class TracingObserver<T> {
        private final Span span;
        private final StreamObserver<T> delegate;
        private final long startedNanos = System.nanoTime();
        private final Object callbackLock = new Object();
        private boolean finished;
        private final StreamObserver<T> observer = new StreamObserver<>() {
            @Override
            public void onNext(T value) {
                synchronized (callbackLock) {
                    if (finished) return;
                    try (Scope ignored = makeCurrent()) {
                        try {
                            delegate.onNext(value);
                        } catch (RuntimeException | Error callbackFailure) {
                            finished = true;
                            finishUnknownWhileCurrent();
                            throw callbackFailure;
                        }
                    }
                }
            }

            @Override public void onError(Throwable failure) {
                synchronized (callbackLock) {
                    if (finished) return;
                    finished = true;
                    try (Scope ignored = makeCurrent()) {
                        try {
                            delegate.onError(failure);
                        } finally {
                            tracingService.recordError(span,
                                    failure instanceof Exception exception ? exception : new RuntimeException("TTS operation failed"),
                                    elapsedMillis());
                        }
                    }
                }
            }

            @Override public void onCompleted() {
                synchronized (callbackLock) {
                    if (finished) return;
                    finished = true;
                    try (Scope ignored = makeCurrent()) {
                        try {
                            delegate.onCompleted();
                        } catch (RuntimeException | Error callbackFailure) {
                            finishUnknownWhileCurrent();
                            throw callbackFailure;
                        }
                        finished = true;
                        tracingService.recordSuccess(span, elapsedMillis());
                    }
                }
            }
        };

        private TracingObserver(Span span, StreamObserver<T> delegate) {
            this.span = Objects.requireNonNull(span, "span");
            this.delegate = Objects.requireNonNull(delegate, "delegate");
        }

        private long elapsedMillis() {
            return Math.max(0L, TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos));
        }

        private Scope makeCurrent() {
            return tracingService.createScope(span);
        }

        /** A transport cancellation has no synthesis success/failure disposition. */
        private void finishUnknown() {
            synchronized (callbackLock) {
                if (finished) return;
                finished = true;
                try (Scope ignored = makeCurrent()) {
                    finishUnknownWhileCurrent();
                }
            }
        }

        private void finishUnknownWhileCurrent() {
            finished = true;
            span.setAttribute("media.outcome", "unknown");
            span.end();
        }
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
            RuntimeException exception) {
        Status status;
        if (exception instanceof TtsRequestAuthorization.AuthorizationException authorization) {
            status = authorization.status();
        } else if (exception instanceof TtsSynthesisEngine.SynthesisException synthesis
                && synthesis.reason() == TtsSynthesisEngine.FailureReason.NOT_ADMITTED) {
            status = Status.UNAVAILABLE;
        } else if (exception instanceof ValidationError || exception instanceof IllegalArgumentException) {
            status = Status.INVALID_ARGUMENT;
        } else if (exception instanceof UnsupportedOperationException) {
            status = Status.UNIMPLEMENTED;
        } else if (exception instanceof TtsStreamTimeoutException) {
            status = Status.DEADLINE_EXCEEDED;
        } else if (exception instanceof IllegalStateException) {
            status = Status.FAILED_PRECONDITION;
        } else {
            status = Status.INTERNAL;
        }
        LOG.error("TTS {} failed (type={})", operation, exception.getClass().getSimpleName());
        String description;
        if (exception instanceof TtsRequestAuthorization.AuthorizationException authorization) {
            description = authorization.getMessage();
        } else if (exception instanceof LocalAdmissionException localAdmission) {
            description = localAdmission.getMessage();
        } else if (exception instanceof SynthesisControlPolicy.UnsupportedControlException unsupportedControl) {
            description = "TTS_NOT_ADMITTED: control " + unsupportedControl.control()
                    + " has no qualified effect or mapping for the admitted provider";
        } else {
            description = switch (status.getCode()) {
            case UNAVAILABLE -> "TTS_NOT_ADMITTED: synthesis provider or capability is unavailable";
            case INVALID_ARGUMENT -> "Invalid TTS synthesis request";
            case UNIMPLEMENTED -> "TTS_NOT_ADMITTED: requested TTS capability is unsupported";
            case FAILED_PRECONDITION -> "TTS synthesis preconditions are not met";
            case DEADLINE_EXCEEDED -> "TTS streaming deadline exceeded";
            default -> "TTS synthesis failed";
            };
        }
        responseObserver.onError(status.withDescription(description).asRuntimeException());
    }

    /** Unforgeable service-side marker for locally authored admission explanations. */
    private static final class LocalAdmissionException extends TtsSynthesisEngine.SynthesisException {
        private LocalAdmissionException(String message) {
            super(message, TtsSynthesisEngine.FailureReason.NOT_ADMITTED);
        }
    }

    private static final class TtsStreamTimeoutException extends RuntimeException {
        private TtsStreamTimeoutException() {
            super("TTS stream deadline exceeded");
        }
    }
}
