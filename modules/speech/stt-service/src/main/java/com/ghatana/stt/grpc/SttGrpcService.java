package com.ghatana.stt.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.config.SttConfig;
import com.ghatana.media.stt.api.SttEngine;
import com.ghatana.media.stt.api.TranscriptionOptions;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.media.stt.api.UserProfile;
import com.ghatana.stt.service.SttAudioInputDecoder;
import com.ghatana.stt.service.SttLanguageSupport;
import com.ghatana.stt.core.grpc.proto.*;
import com.ghatana.audiovideo.observability.MediaWorkflowMetrics;
import com.ghatana.audiovideo.observability.instrumentation.AudioVideoGrpcInstrumentation;
import com.ghatana.audiovideo.observability.tracing.AudioVideoTracingService;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.common.resilience.ContextAwareBoundedExecutor;
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
import java.util.UUID;
import java.util.function.BooleanSupplier;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * STT gRPC Service — bridges the proto STTService API to the platform SttEngine.
 *
 * @doc.type class
 * @doc.purpose gRPC facade for platform SttEngine
 * @doc.layer product
 * @doc.pattern Service
 */
public class SttGrpcService extends STTServiceGrpc.STTServiceImplBase
        implements AutoCloseable, com.ghatana.audio.video.common.observability.MetricsScrapeSource {

    private static final Logger LOG = LoggerFactory.getLogger(SttGrpcService.class);

    private final AudioVideoLibrary library;
    private final Timer transcribeTimer;
    private final AudioVideoGrpcInstrumentation boundaryInstrumentation;
    private final MediaWorkflowMetrics workflowMetrics;
    private final AudioVideoTracingService tracingService;
    private final int maxAudioLengthSeconds;
    private final SttRequestAuthorization requestAuthorization;
    private final ContextAwareBoundedExecutor dispatchExecutor;
    private final ExecutorService ownedDispatchExecutor;
    private final Object dispatchLifecycleLock = new Object();
    private final java.util.Set<DispatchHandle> outstandingTranscriptions =
            java.util.concurrent.ConcurrentHashMap.newKeySet();
    private boolean dispatchClosing;
    private volatile BooleanSupplier readinessProbe = this::isProviderReady;

    private record DispatchHandle(
            ContextAwareBoundedExecutor.Submission<Void> submission,
            java.util.concurrent.atomic.AtomicBoolean cancelled) { }

    /**
     * Package-private constructor for unit testing — supply a pre-configured library.
     * Avoids native-library / file-system dependencies during tests.
     */
    SttGrpcService(AudioVideoLibrary library, MeterRegistry metrics) {
        this(library, metrics, SttAudioInputDecoder.DEFAULT_MAX_AUDIO_LENGTH_SECONDS,
                GlobalOpenTelemetry.getTracer("ghatana-media-stt"), SttRequestAuthorization.unavailable(),
                Runnable::run, null);
    }

    SttGrpcService(AudioVideoLibrary library, MeterRegistry metrics, Tracer tracer) {
        this(library, metrics, SttAudioInputDecoder.DEFAULT_MAX_AUDIO_LENGTH_SECONDS, tracer,
                SttRequestAuthorization.unavailable(), Runnable::run, null);
    }

    SttGrpcService(AudioVideoLibrary library, MeterRegistry metrics,
            SttRequestAuthorization requestAuthorization) {
        this(library, metrics, SttAudioInputDecoder.DEFAULT_MAX_AUDIO_LENGTH_SECONDS,
                GlobalOpenTelemetry.getTracer("ghatana-media-stt"), requestAuthorization, Runnable::run, null);
    }

    SttGrpcService(AudioVideoLibrary library, MeterRegistry metrics, Tracer tracer,
            SttRequestAuthorization requestAuthorization) {
        this(library, metrics, SttAudioInputDecoder.DEFAULT_MAX_AUDIO_LENGTH_SECONDS, tracer,
                requestAuthorization, Runnable::run, null);
    }

    SttGrpcService(AudioVideoLibrary library, MeterRegistry metrics, Tracer tracer,
            SttRequestAuthorization requestAuthorization, Executor dispatchExecutor) {
        this(library, metrics, SttAudioInputDecoder.DEFAULT_MAX_AUDIO_LENGTH_SECONDS, tracer,
                requestAuthorization, dispatchExecutor,
                dispatchExecutor instanceof ExecutorService service ? service : null);
    }

    private SttGrpcService(AudioVideoLibrary library, MeterRegistry metrics, int maxAudioLengthSeconds,
            Tracer tracer, SttRequestAuthorization requestAuthorization, Executor dispatchExecutor) {
        this(library, metrics, maxAudioLengthSeconds, tracer, requestAuthorization, dispatchExecutor,
                dispatchExecutor instanceof ExecutorService service ? service : null);
    }

    private SttGrpcService(
            AudioVideoLibrary library, MeterRegistry metrics, int maxAudioLengthSeconds, Tracer tracer,
            SttRequestAuthorization requestAuthorization, Executor dispatchExecutor,
            ExecutorService ownedDispatchExecutor) {
        this.library = library;
        this.maxAudioLengthSeconds = maxAudioLengthSeconds;
        this.requestAuthorization = Objects.requireNonNull(requestAuthorization, "requestAuthorization");
        this.dispatchExecutor = new ContextAwareBoundedExecutor(
                Objects.requireNonNull(dispatchExecutor, "dispatchExecutor"));
        this.ownedDispatchExecutor = ownedDispatchExecutor;
        this.tracingService = new AudioVideoTracingService(Objects.requireNonNull(tracer, "tracer"));
        this.workflowMetrics = new MediaWorkflowMetrics(metrics, "stt");
        this.boundaryInstrumentation = new AudioVideoGrpcInstrumentation(null, workflowMetrics);
        this.transcribeTimer = Timer.builder("stt.transcribe")
            .description("Transcription latency")
            .publishPercentiles(0.50, 0.95, 0.99)
            .publishPercentileHistogram()
            .register(metrics);
    }

    @Override
    public String scrapeMetrics() {
        return workflowMetrics.scrape();
    }

    public SttGrpcService(MeterRegistry metrics) {
        this(metrics, defaultConfig(System.getenv()), configuredDispatchExecutor(System.getenv()));
    }

    private SttGrpcService(MeterRegistry metrics, SttConfig config, ThreadPoolExecutor executor) {
        this(AudioVideoLibrary.builder().withSttConfig(config).build(), metrics,
                config.maxAudioLengthSeconds(), GlobalOpenTelemetry.getTracer("ghatana-media-stt"),
                SttRequestAuthorization.unavailable(), executor);
        LOG.info("STT service initialized");
    }

    private static SttConfig defaultConfig(Map<String, String> environment) {
        return SttConfig.builder()
            .modelPath(Paths.get(environment.getOrDefault("STT_MODEL_PATH", "/models/whisper-base.onnx")))
            .modelId(environment.getOrDefault("STT_MODEL_ID", "whisper-base"))
            .useGpu(Boolean.parseBoolean(environment.getOrDefault("STT_USE_GPU", "true")))
            .maxConcurrentRequests(parseBoundedInt(environment, "STT_MAX_CONCURRENT", 10, 1, 1_000))
            .build();
    }

    static ThreadPoolExecutor configuredDispatchExecutor(Map<String, String> environment) {
        int workers = parseBoundedInt(environment, "STT_MAX_CONCURRENT", 10, 1, 1_000);
        int queueCapacity = parseBoundedInt(environment, "STT_QUEUE_CAPACITY", workers, 1, 1_000);
        AtomicInteger threadId = new AtomicInteger();
        ThreadFactory threads = runnable -> {
            Thread thread = new Thread(runnable, "media-stt-worker-" + threadId.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        };
        return new ThreadPoolExecutor(workers, workers, 0L, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(queueCapacity), threads, new ThreadPoolExecutor.AbortPolicy());
    }

    private static int parseBoundedInt(Map<String, String> environment, String key,
            int fallback, int minimum, int maximum) {
        String raw = environment.get(key);
        if (raw == null || raw.isBlank()) return fallback;
        try {
            int value = Integer.parseInt(raw.trim());
            if (value < minimum || value > maximum) throw new NumberFormatException("outside bounds");
            return value;
        } catch (NumberFormatException invalid) {
            throw new IllegalArgumentException(key + " must be an integer from " + minimum + " to " + maximum,
                    invalid);
        }
    }

    @Override
    public void close() {
        stopTranscriptionWorkers();
    }

    /** Stops admission and completes every outstanding transcribe call before draining workers. */
    protected final boolean stopTranscriptionWorkers() {
        java.util.List<DispatchHandle> pending;
        synchronized (dispatchLifecycleLock) {
            dispatchClosing = true;
            pending = new java.util.ArrayList<>(outstandingTranscriptions);
        }
        pending.forEach(handle -> {
            handle.cancelled().set(true);
            handle.submission().cancel();
        });

        if (ownedDispatchExecutor == null) return true;
        ownedDispatchExecutor.shutdown();
        boolean terminated = awaitWorkerTermination(ownedDispatchExecutor, 5, TimeUnit.SECONDS);
        if (!terminated) {
            ownedDispatchExecutor.shutdownNow();
            terminated = awaitWorkerTermination(ownedDispatchExecutor, 1, TimeUnit.SECONDS);
        }
        if (!terminated) {
            LOG.error("STT transcription worker did not terminate after bounded drain; provider library must remain open");
        }
        return terminated;
    }

    private static boolean awaitWorkerTermination(ExecutorService executor, long timeout, TimeUnit unit) {
        try {
            return executor.awaitTermination(timeout, unit);
        } catch (InterruptedException interrupted) {
            executor.shutdownNow();
            boolean terminated = executor.isTerminated();
            if (!terminated) {
                // Complete the bounded final wait even when close itself is interrupted.
                Thread.interrupted();
                try {
                    terminated = executor.awaitTermination(1, TimeUnit.SECONDS);
                } catch (InterruptedException interruptedAgain) {
                    terminated = executor.isTerminated();
                }
            }
            Thread.currentThread().interrupt();
            return terminated;
        }
    }

    @Override
    public void transcribe(TranscribeRequest request, StreamObserver<TranscribeResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipalWithMetrics(responseObserver)) return;
        JwtServerInterceptor.VerifiedIdentity verifiedIdentity = JwtServerInterceptor.verifiedIdentity();
        if (verifiedIdentity == null) {
            responseObserver.onError(io.grpc.Status.UNAUTHENTICATED
                    .withDescription("STT_IDENTITY_REQUIRED: verified server identity is required")
                    .asRuntimeException());
            return;
        }
        final String sourceSha256;
        try {
            // Bound the protobuf payload before hashing it. Hash the exact inbound
            // representation; do not infer equivalence to decoded or transcoded audio.
            requireHashableInputSize(request.getAudioData().size());
            sourceSha256 = sha256(request.getAudioData());
        } catch (SttAudioInputDecoder.InputException rejectedInput) {
            responseObserver.onError(inputSizeStatus(rejectedInput).asRuntimeException());
            return;
        } catch (RuntimeException hashingFailure) {
            responseObserver.onError(io.grpc.Status.UNAVAILABLE
                    .withDescription("STT_SOURCE_BINDING_UNAVAILABLE: unable to bind input bytes to source authority")
                    .asRuntimeException());
            return;
        }
        if (!authorizeCapturedRequest(responseObserver, verifiedIdentity,
                SttRequestAuthorization.Operation.TRANSCRIBE, request.getArtifactId(), sourceSha256)) return;
        Span span = tracingService.startTranscriptionSpan(null, null, request.getLanguage());
        TracingObserver<TranscribeResponse> tracedObserver = new TracingObserver<>(
                responseObserver, tracingService, span);
        java.util.concurrent.atomic.AtomicBoolean observerCancelled = new java.util.concurrent.atomic.AtomicBoolean();
        java.util.concurrent.atomic.AtomicReference<ContextAwareBoundedExecutor.Submission<Void>> pending =
                new java.util.concurrent.atomic.AtomicReference<>();
        if (responseObserver instanceof io.grpc.stub.ServerCallStreamObserver<?> serverObserver) {
            serverObserver.setOnCancelHandler(() -> {
                observerCancelled.set(true);
                ContextAwareBoundedExecutor.Submission<Void> submission = pending.get();
                if (submission != null) submission.cancel();
            });
        }
        if (observerCancelled.get() || isCancelled(responseObserver)) {
            tracedObserver.finishUnknown();
            return;
        }

        final ContextAwareBoundedExecutor.Submission<Void> submission;
        final DispatchHandle handle;
        synchronized (dispatchLifecycleLock) {
            if (dispatchClosing) {
                tracedObserver.onError(io.grpc.Status.UNAVAILABLE
                        .withDescription("STT service is closing; transcription was not dispatched")
                        .asRuntimeException());
                return;
            }
            submission = dispatchExecutor.submit(() -> {
            if (observerCancelled.get() || io.grpc.Context.current().isCancelled()) return null;
            try (Scope ignored = tracingService.createScope(span)) {
                transcribeTimer.record(() -> {
                    try {
                        SttAudioInputDecoder.requireInputSize(request.getAudioData().size());
                        // Materialize provider input only after exact source-byte authorization.
                        byte[] audioBytes = request.getAudioData().toByteArray();
                        int sampleRate = request.getSampleRate();
                        SttAudioInputDecoder.requireSampleRate(sampleRate);

                        String language = request.getLanguage();
                        if (language != null && !language.isBlank()
                                && !SttLanguageSupport.isSupported(language)) {
                            tracedObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                                    .withDescription("Unsupported language").asRuntimeException());
                            return;
                        }

                        AudioData audio = decodeAudio(audioBytes, sampleRate);
                        TranscriptionResult result;
                        if (!authorizeCapturedRequest(tracedObserver, verifiedIdentity,
                                SttRequestAuthorization.Operation.TRANSCRIBE,
                                request.getArtifactId(), sourceSha256)) return;
                        try (SttEngine stt = library.getSttEngine()) {
                            try (AudioVideoGrpcInstrumentation.BoundaryMeasurement measurement =
                                         boundaryInstrumentation.beginBoundaryMeasurement(
                                                 MediaWorkflowMetrics.Modality.STT,
                                                 MediaWorkflowMetrics.Boundary.PROVIDER)) {
                                if (observerCancelled.get() || io.grpc.Context.current().isCancelled()) return;
                                result = stt.transcribe(audio, transcriptionOptions(request));
                                if (result != null && !observerCancelled.get()
                                        && !isCancelled(responseObserver)) {
                                    measurement.complete(MediaWorkflowMetrics.Outcome.SUCCESS);
                                }
                            }
                        }

                        try (AudioVideoGrpcInstrumentation.BoundaryMeasurement responseBoundary =
                                     boundaryInstrumentation.beginBoundaryMeasurement(
                                             MediaWorkflowMetrics.Modality.STT,
                                             MediaWorkflowMetrics.Boundary.RESPONSE)) {
                            if (observerCancelled.get() || isCancelled(responseObserver)) return;
                            final TranscribeResponse response;
                            try {
                                response = SttTranscriptionResponseMapper.toProto(result, audio).build();
                            } catch (SttTranscriptionResponseMapper.InvalidResultException invalidResult) {
                                responseBoundary.complete(MediaWorkflowMetrics.Outcome.FAILURE);
                                throw invalidResult;
                            }
                            if (!tracedObserver.sendNext(response) || observerCancelled.get()
                                    || isCancelled(responseObserver) || !tracedObserver.sendCompleted()) {
                                responseBoundary.complete(MediaWorkflowMetrics.Outcome.UNKNOWN);
                                return;
                            }
                            responseBoundary.complete(MediaWorkflowMetrics.Outcome.SUCCESS);
                        }
                    } catch (SttTranscriptionResponseMapper.InvalidResultException e) {
                        if (observerCancelled.get() || isCancelled(responseObserver)) return;
                        tracedObserver.onError(io.grpc.Status.INTERNAL
                                .withDescription("Invalid transcription result").asRuntimeException());
                    } catch (SttAudioInputDecoder.InputException e) {
                        if (observerCancelled.get() || isCancelled(responseObserver)) return;
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
                        if (observerCancelled.get() || isCancelled(responseObserver)) return;
                        tracedObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                                .withDescription("Invalid transcription request").asRuntimeException());
                    } catch (com.ghatana.media.common.InferenceError e) {
                        if (observerCancelled.get() || isCancelled(responseObserver)) return;
                        io.grpc.Status status = e.isRetryable()
                                ? io.grpc.Status.UNAVAILABLE : io.grpc.Status.INTERNAL;
                        String description = e.isRetryable()
                                ? "Transcription provider temporarily unavailable" : "Transcription failed";
                        tracedObserver.onError(status.withDescription(description).asRuntimeException());
                    } catch (java.util.concurrent.CancellationException e) {
                        if (observerCancelled.get() || isCancelled(responseObserver)) return;
                        tracedObserver.onError(io.grpc.Status.CANCELLED
                                .withDescription("Transcription was cancelled").asRuntimeException());
                    } catch (Exception e) {
                        if (observerCancelled.get() || isCancelled(responseObserver)) return;
                        if (hasCause(e, java.util.concurrent.TimeoutException.class)) {
                            tracedObserver.onError(io.grpc.Status.DEADLINE_EXCEEDED
                                    .withDescription("Transcription timed out").asRuntimeException());
                            return;
                        }
                        LOG.error("STT transcription failed failureType={}", failureType(e));
                        tracedObserver.onError(io.grpc.Status.INTERNAL
                                .withDescription("Internal error").asRuntimeException());
                    }
                });
            }
            return null;
            }, true);
            pending.set(submission);
            handle = new DispatchHandle(submission, observerCancelled);
            outstandingTranscriptions.add(handle);
        }
        if (observerCancelled.get() || isCancelled(responseObserver)) submission.cancel();
        submission.result().whenComplete((ignored, failure) -> {
            outstandingTranscriptions.remove(handle);
            if (failure == null) {
                tracedObserver.finishUnknown();
                return;
            }
            Throwable statusFailure = failure instanceof java.util.concurrent.CompletionException
                    && failure.getCause() != null ? failure.getCause() : failure;
            if (statusFailure instanceof io.grpc.StatusRuntimeException) {
                io.grpc.Status status = io.grpc.Status.fromThrowable(statusFailure);
                if (status.getCode() == io.grpc.Status.Code.UNKNOWN
                        && status.getDescription() != null
                        && status.getDescription().contains("UNKNOWN_OUTCOME")) {
                    tracedObserver.onUnknownError(statusFailure);
                } else {
                    tracedObserver.onError(statusFailure);
                }
            } else {
                LOG.error("STT transcription worker failed failureType={}", failureType(statusFailure));
                tracedObserver.onError(io.grpc.Status.INTERNAL
                        .withDescription("Internal error").asRuntimeException());
            }
        });
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

        @Override public void onNext(T value) { sendNext(value); }

        private synchronized boolean sendNext(T value) {
            if (terminal.get()) return false;
            delegate.onNext(value);
            return true;
        }

        @Override
        public synchronized void onError(Throwable failure) {
            if (terminal.compareAndSet(false, true)) {
                Exception safeFailure = failure instanceof Exception exception
                        ? exception : new IllegalStateException("gRPC call failed");
                tracingService.recordError(span, safeFailure, elapsedMillis());
                delegate.onError(failure);
            }
        }

        private synchronized void onUnknownError(Throwable failure) {
            if (terminal.compareAndSet(false, true)) {
                span.setAttribute("media.outcome", "unknown");
                span.end();
                delegate.onError(failure);
            }
        }

        @Override
        public void onCompleted() { sendCompleted(); }

        private synchronized boolean sendCompleted() {
            if (!terminal.compareAndSet(false, true)) return false;
            tracingService.recordSuccess(span, elapsedMillis());
            delegate.onCompleted();
            return true;
        }

        private synchronized void finishUnknown() {
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
        return io.grpc.Context.current().isCancelled()
                || observer instanceof io.grpc.stub.ServerCallStreamObserver<?> serverObserver
                        && serverObserver.isCancelled();
    }

    static String sha256(com.google.protobuf.ByteString bytes) {
        try {
            java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
            try (java.io.InputStream input = bytes.newInput()) {
                byte[] buffer = new byte[16 * 1024];
                int count;
                while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
            }
            return java.util.HexFormat.of().formatHex(digest.digest());
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        } catch (java.io.IOException readFailure) {
            throw new IllegalStateException("Unable to read bounded STT request bytes", readFailure);
        }
    }

    static void requireHashableInputSize(long size) {
        if (size > SttAudioInputDecoder.MAX_INPUT_BYTES) {
            throw new SttAudioInputDecoder.InputException(
                    SttAudioInputDecoder.FailureKind.RESOURCE_EXHAUSTED,
                    "STT_AUDIO_TOO_LARGE: audio data exceeds the 4 MiB input limit");
        }
    }

    private static io.grpc.Status inputSizeStatus(SttAudioInputDecoder.InputException failure) {
        return switch (failure.kind()) {
            case INVALID_ARGUMENT -> io.grpc.Status.INVALID_ARGUMENT.withDescription("Invalid audio input");
            case RESOURCE_EXHAUSTED -> io.grpc.Status.RESOURCE_EXHAUSTED
                    .withDescription("Audio input exceeds the supported limit");
            case NOT_ADMITTED -> io.grpc.Status.FAILED_PRECONDITION
                    .withDescription("Audio input format is not admitted");
        };
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
        return authorizeRequest(observer, operation, resourceId, null);
    }

    protected final boolean authorizeRequest(StreamObserver<?> observer, SttRequestAuthorization.Operation operation,
            String resourceId, String sourceSha256) {
        return authorizeCapturedRequest(observer, JwtServerInterceptor.verifiedIdentity(),
                operation, resourceId, sourceSha256);
    }

    private boolean authorizeCapturedRequest(StreamObserver<?> observer,
            JwtServerInterceptor.VerifiedIdentity identity, SttRequestAuthorization.Operation operation,
            String resourceId, String sourceSha256) {
        try (AudioVideoGrpcInstrumentation.BoundaryMeasurement admissionBoundary =
                     boundaryInstrumentation.beginBoundaryMeasurement(
                             MediaWorkflowMetrics.Modality.STT, MediaWorkflowMetrics.Boundary.ADMISSION)) {
            boolean admitted = authorizeRequestDecision(observer, operation, resourceId, sourceSha256, identity);
            admissionBoundary.complete(admitted
                    ? MediaWorkflowMetrics.Outcome.SUCCESS : MediaWorkflowMetrics.Outcome.FAILURE);
            return admitted;
        }
    }

    private boolean authorizeRequestDecision(StreamObserver<?> observer,
            SttRequestAuthorization.Operation operation, String resourceId, String sourceSha256) {
        return authorizeRequestDecision(observer, operation, resourceId, sourceSha256,
                JwtServerInterceptor.verifiedIdentity());
    }

    private boolean authorizeRequestDecision(StreamObserver<?> observer,
            SttRequestAuthorization.Operation operation, String resourceId, String sourceSha256,
            JwtServerInterceptor.VerifiedIdentity identity) {
        if (identity == null) {
            observer.onError(io.grpc.Status.UNAUTHENTICATED
                    .withDescription("STT_IDENTITY_REQUIRED: verified server identity is required")
                    .asRuntimeException());
            return false;
        }
        SttRequestAuthorization.Decision decision;
        try {
            decision = requestAuthorization.authorize(new SttRequestAuthorization.Request(
                    identity, operation, resourceId, sourceSha256));
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
        java.util.Set<Throwable> visited = java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());
        visited.add(cause);
        while (true) {
            Throwable next = cause.getCause();
            if (next == null || !visited.add(next)) break;
            cause = next;
        }
        return cause.getClass().getSimpleName();
    }

    private static boolean hasCause(Throwable error, Class<? extends Throwable> expectedType) {
        java.util.Set<Throwable> visited = java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());
        for (Throwable cause = error; cause != null && visited.add(cause); cause = cause.getCause()) {
            if (expectedType.isInstance(cause)) return true;
        }
        return false;
    }
}
