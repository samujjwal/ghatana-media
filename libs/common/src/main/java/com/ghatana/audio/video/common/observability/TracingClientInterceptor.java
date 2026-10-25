package com.ghatana.audio.video.common.observability;

import io.grpc.CallOptions;
import io.grpc.Channel;
import io.grpc.ClientCall;
import io.grpc.ClientInterceptor;
import io.grpc.ForwardingClientCall;
import io.grpc.ForwardingClientCallListener;
import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import io.grpc.Status;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import io.opentelemetry.context.propagation.TextMapSetter;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/** Adds bounded client spans and W3C trace-context propagation to outbound Media gRPC calls. */
public final class TracingClientInterceptor implements ClientInterceptor {
    private static final Metadata.Key<String> TRACEPARENT =
            Metadata.Key.of("traceparent", Metadata.ASCII_STRING_MARSHALLER);
    private static final Metadata.Key<String> TRACESTATE =
            Metadata.Key.of("tracestate", Metadata.ASCII_STRING_MARSHALLER);
    private static final Metadata.Key<String> BAGGAGE =
            Metadata.Key.of("baggage", Metadata.ASCII_STRING_MARSHALLER);
    private static final Map<String, Set<String>> REGISTERED_METHODS = Map.of(
            "com.ghatana.audio.video.stt.grpc.STTService", Set.of(
                    "Transcribe", "StreamTranscribe", "LoadModel", "UnloadModel", "ListModels", "AdaptModel",
                    "GetStatus", "HealthCheck", "CreateProfile", "GetProfile", "UpdateProfile", "SubmitCorrection"),
            "com.ghatana.audio.video.tts.grpc.TTSService", Set.of(
                    "Synthesize", "StreamSynthesize", "GetStatus", "GetMetrics", "GetVoices", "LoadVoice",
                    "CreateProfile", "GetProfile", "UpdateProfile", "CloneVoice", "SubmitFeedback"),
            "com.ghatana.audio.video.vision.grpc.VisionService", Set.of(
                    "DetectObjects", "AnalyzeImage", "ClassifyImage", "AnalyzeVideoFile", "ProcessVideo",
                    "LoadModel", "UnloadModel", "ListModels", "GetStatus", "HealthCheck"),
            "com.ghatana.audio.video.multimodal.grpc.MultimodalService", Set.of(
                    "ProcessMultimodal", "AnalyzeVideoWithAudio", "GenerateDescription", "AnalyzeCrossModal",
                    "GetInsights", "LoadModel", "UnloadModel", "ListModels", "GetStatus", "HealthCheck"));

    private static final TextMapSetter<Metadata> SETTER = (carrier, key, value) -> {
        if (carrier == null || value == null) return;
        Metadata.Key<String> metadataKey = switch (key) {
            case "traceparent" -> TRACEPARENT;
            case "tracestate" -> TRACESTATE;
            default -> null;
        };
        if (metadataKey != null) {
            carrier.discardAll(metadataKey);
            carrier.put(metadataKey, value);
        }
    };

    private final Tracer tracer;

    public TracingClientInterceptor() {
        this(GlobalOpenTelemetry.get());
    }

    TracingClientInterceptor(OpenTelemetry telemetry) {
        this.tracer = java.util.Objects.requireNonNull(telemetry, "telemetry")
                .getTracer("com.ghatana.media.grpc");
    }

    @Override
    public <ReqT, RespT> ClientCall<ReqT, RespT> interceptCall(
            MethodDescriptor<ReqT, RespT> method, CallOptions callOptions, Channel next) {
        RpcIdentity rpc = identity(method.getFullMethodName());
        ClientCall<ReqT, RespT> delegate = next.newCall(method, callOptions);
        AtomicReference<CallTrace> traceRef = new AtomicReference<>();
        AtomicBoolean startInvoked = new AtomicBoolean();

        return new ForwardingClientCall.SimpleForwardingClientCall<>(delegate) {
            @Override
            public void start(Listener<RespT> listener, Metadata headers) {
                if (!startInvoked.compareAndSet(false, true)) {
                    throw new IllegalStateException("gRPC client call was already started");
                }
                Context parent = Context.current();
                Span span = tracer.spanBuilder(rpc.fullName())
                        .setSpanKind(SpanKind.CLIENT)
                        .setParent(parent)
                        .startSpan();
                span.setAttribute("rpc.system", "grpc");
                span.setAttribute("rpc.service", rpc.service());
                span.setAttribute("rpc.method", rpc.method());
                CallTrace trace = new CallTrace(span, parent.with(span), System.nanoTime());
                traceRef.set(trace);
                try {
                    // W3C trace context is the only context propagated by this interceptor. In
                    // particular, never forward ambient OpenTelemetry baggage.
                    if (headers == null) throw new IllegalArgumentException("gRPC headers must not be null");
                    headers.discardAll(BAGGAGE);
                    headers.discardAll(TRACEPARENT);
                    headers.discardAll(TRACESTATE);
                    W3CTraceContextPropagator.getInstance().inject(trace.context(), headers, SETTER);
                    runWithContext(trace, () -> super.start(
                            new ForwardingClientCallListener.SimpleForwardingClientCallListener<>(listener) {
                                @Override
                                public void onHeaders(Metadata responseHeaders) {
                                    runWithContext(trace, () -> super.onHeaders(responseHeaders));
                                }

                                @Override
                                public void onMessage(RespT message) {
                                    runWithContext(trace, () -> super.onMessage(message));
                                }

                                @Override
                                public void onClose(Status status, Metadata trailers) {
                                    runWithContext(trace, () -> super.onClose(status, trailers));
                                    finish(trace, status);
                                }

                                @Override
                                public void onReady() {
                                    runWithContext(trace, super::onReady);
                                }
                            }, headers));
                } catch (RuntimeException | Error failure) {
                    finish(trace, Status.INTERNAL);
                    throw failure;
                }
            }

            @Override
            public void request(int numMessages) {
                runWithTrace(() -> super.request(numMessages));
            }

            @Override
            public void cancel(String message, Throwable cause) {
                try {
                    runWithTrace(() -> super.cancel(message, cause));
                } finally {
                    CallTrace trace = traceRef.get();
                    if (trace != null) finish(trace, Status.CANCELLED);
                }
            }

            @Override
            public void halfClose() {
                runWithTrace(super::halfClose);
            }

            @Override
            public void sendMessage(ReqT message) {
                runWithTrace(() -> super.sendMessage(message));
            }

            private void runWithTrace(Runnable operation) {
                CallTrace trace = traceRef.get();
                if (trace == null) {
                    operation.run();
                    return;
                }
                runWithContext(trace, operation);
            }

            private void runWithContext(CallTrace trace, Runnable operation) {
                try {
                    withContext(trace.context(), operation);
                } catch (RuntimeException | Error failure) {
                    finish(trace, Status.INTERNAL);
                    throw failure;
                }
            }
        };
    }

    private static void withContext(Context context, Runnable operation) {
        try (Scope ignored = context.makeCurrent()) {
            operation.run();
        }
    }

    private static void finish(CallTrace trace, Status status) {
        if (!trace.ended().compareAndSet(false, true)) return;
        Span span = trace.span();
        span.setAttribute("rpc.grpc.status_code", status.getCode().name());
        long durationMs = (System.nanoTime() - trace.startedAtNanos()) / 1_000_000;
        if (durationMs >= 0) span.setAttribute("duration.ms", durationMs);
        if (!status.isOk()) {
            span.setAttribute("error.type", status.getCode().name());
            span.setStatus(StatusCode.ERROR, "gRPC client call failed");
        } else {
            span.setStatus(StatusCode.OK);
        }
        span.end();
    }

    private static RpcIdentity identity(String fullMethodName) {
        if (fullMethodName == null) return RpcIdentity.UNKNOWN;
        int slash = fullMethodName.indexOf('/');
        if (slash <= 0 || slash != fullMethodName.lastIndexOf('/') || slash == fullMethodName.length() - 1) {
            return RpcIdentity.UNKNOWN;
        }
        String service = fullMethodName.substring(0, slash);
        String method = fullMethodName.substring(slash + 1);
        return REGISTERED_METHODS.getOrDefault(service, Set.of()).contains(method)
                ? new RpcIdentity(service, method, fullMethodName)
                : RpcIdentity.UNKNOWN;
    }

    private record RpcIdentity(String service, String method, String fullName) {
        private static final RpcIdentity UNKNOWN = new RpcIdentity("grpc.unknown", "grpc.unknown", "grpc.unknown");
    }

    private record CallTrace(Span span, Context context, long startedAtNanos, AtomicBoolean ended) {
        private CallTrace(Span span, Context context, long startedAtNanos) {
            this(span, context, startedAtNanos, new AtomicBoolean());
        }
    }
}
