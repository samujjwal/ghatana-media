package com.ghatana.audio.video.common.observability;

import io.grpc.ForwardingServerCall;
import io.grpc.ForwardingServerCallListener;
import io.grpc.Metadata;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;
import io.grpc.Status;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import io.opentelemetry.context.propagation.TextMapGetter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;

/**
 * gRPC server interceptor providing structured logging and OpenTelemetry server spans.
 *
 * <p>For each inbound call this interceptor:
 * <ol>
 *   <li>Generates or propagates a {@code trace-id} from the {@code x-trace-id} header.</li>
 *   <li>Injects only the gRPC method and service into the SLF4J MDC. Trace and span identifiers
 *       are propagated in gRPC headers but are not copied into ordinary log fields.</li>
 *   <li>Records call duration and final gRPC status on the server span.</li>
 *   <li>Cleans up MDC on completion to prevent cross-request leakage.</li>
 * </ol>
 *
 * <p>Uses the OpenTelemetry API and global propagator so the service can run with an SDK, the
 * OpenTelemetry Java agent, or the API's no-op implementation. Spans include only static RPC
 * identity, status, and duration attributes; request metadata, baggage, and payloads are never
 * exported.
  * @doc.type class
 * @doc.purpose Provides tracing server interceptor functionality.
 * @doc.layer product
 * @doc.pattern Filter
*/
public class TracingServerInterceptor implements ServerInterceptor {

    private static final Logger LOG = LoggerFactory.getLogger(TracingServerInterceptor.class);

    private static final Metadata.Key<String> TRACE_ID_KEY =
            Metadata.Key.of("x-trace-id", Metadata.ASCII_STRING_MARSHALLER);
    private static final Metadata.Key<String> SPAN_ID_KEY =
            Metadata.Key.of("x-span-id", Metadata.ASCII_STRING_MARSHALLER);

    private static final TextMapGetter<Metadata> METADATA_GETTER = new TextMapGetter<>() {
        @Override
        public Iterable<String> keys(Metadata carrier) {
            if (carrier == null) {
                return List.of();
            }
            return carrier.keys().stream()
                    .filter(key -> key.equals("traceparent") || key.equals("tracestate"))
                    .toList();
        }

        @Override
        public String get(Metadata carrier, String key) {
            if (carrier == null || key == null
                    || !(key.equals("traceparent") || key.equals("tracestate"))) {
                return null;
            }
            try {
                return carrier.get(Metadata.Key.of(key, Metadata.ASCII_STRING_MARSHALLER));
            } catch (IllegalArgumentException malformedKey) {
                return null;
            }
        }
    };

    private final Tracer tracer;
    private final io.opentelemetry.context.propagation.TextMapPropagator propagator;

    public TracingServerInterceptor() {
        this(GlobalOpenTelemetry.get());
    }

    TracingServerInterceptor(OpenTelemetry openTelemetry) {
        OpenTelemetry telemetry = java.util.Objects.requireNonNull(openTelemetry, "openTelemetry");
        this.tracer = telemetry.getTracer("com.ghatana.media.grpc");
        this.propagator = telemetry.getPropagators().getTextMapPropagator();
    }

    @Override
    public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
            ServerCall<ReqT, RespT> call,
            Metadata headers,
            ServerCallHandler<ReqT, RespT> next) {

        String fullMethod = call.getMethodDescriptor().getFullMethodName();
        String[] parts = fullMethod.split("/");
        String service = parts.length > 0 ? parts[0] : fullMethod;
        String method = parts.length > 1 ? parts[1] : fullMethod;

        Context parent = propagator.extract(Context.current(), headers, METADATA_GETTER);
        Span span = tracer.spanBuilder(fullMethod)
                .setSpanKind(SpanKind.SERVER)
                .setParent(parent)
                .startSpan();
        span.setAttribute("rpc.system", "grpc");
        span.setAttribute("rpc.service", service);
        span.setAttribute("rpc.method", method);
        Context callContext = parent.with(span);
        long startNs = System.nanoTime();
        String incomingTraceId = headers.get(TRACE_ID_KEY);
        String traceId = incomingTraceId == null || incomingTraceId.isBlank()
                ? span.getSpanContext().isValid()
                    ? span.getSpanContext().getTraceId()
                    : UUID.randomUUID().toString().replace("-", "")
                : incomingTraceId;
        String spanId = span.getSpanContext().isValid()
                ? span.getSpanContext().getSpanId()
                : UUID.randomUUID().toString().replace("-", "").substring(0, 16);

        LOG.info("gRPC call started: {}", fullMethod);

        // Propagate trace ID in response headers for client correlation
        Metadata responseHeaders = new Metadata();
        responseHeaders.put(TRACE_ID_KEY, traceId);
        responseHeaders.put(SPAN_ID_KEY, spanId);

        AtomicBoolean spanEnded = new AtomicBoolean();
        ServerCall<ReqT, RespT> wrappedCall = new ForwardingServerCall.SimpleForwardingServerCall<>(call) {
            @Override
            public void sendHeaders(Metadata responseMetadata) {
                withCallContext(callContext, service, method, () -> {
                    responseMetadata.merge(responseHeaders);
                    super.sendHeaders(responseMetadata);
                });
            }

            @Override
            public void close(Status status, Metadata trailers) {
                withCallContext(callContext, service, method, () -> {
                    finishSpan(span, spanEnded, status, startNs, fullMethod);
                    super.close(status, trailers);
                });
            }
        };

        try {
            ServerCall.Listener<ReqT> delegate = withCallContext(
                    callContext, service, method, () -> next.startCall(wrappedCall, headers));
            return new ForwardingServerCallListener.SimpleForwardingServerCallListener<>(delegate) {
                @Override
                public void onMessage(ReqT message) {
                    withCallContext(callContext, service, method, () -> super.onMessage(message));
                }

                @Override
                public void onHalfClose() {
                    withCallContext(callContext, service, method, super::onHalfClose);
                }

                @Override
                public void onCancel() {
                    withCallContext(callContext, service, method, () -> {
                        try {
                            super.onCancel();
                        } finally {
                            finishSpan(span, spanEnded, Status.CANCELLED, startNs, fullMethod);
                        }
                    });
                }

                @Override
                public void onComplete() {
                    withCallContext(callContext, service, method, super::onComplete);
                }

                @Override
                public void onReady() {
                    withCallContext(callContext, service, method, super::onReady);
                }
            };
        } catch (RuntimeException startupFailure) {
            if (spanEnded.compareAndSet(false, true)) {
                span.setAttribute("error.type", startupFailure.getClass().getSimpleName());
                span.setStatus(StatusCode.ERROR, "gRPC handler failed to start");
                span.end();
            }
            throw startupFailure;
        }
    }

    private static void withCallContext(Context context, String service, String method, Runnable action) {
        withCallContext(context, service, method, () -> {
            action.run();
            return null;
        });
    }

    private static <T> T withCallContext(Context context, String service, String method, Supplier<T> action) {
        String oldService = MDC.get("grpcService");
        String oldMethod = MDC.get("grpcMethod");
        try (Scope ignored = context.makeCurrent()) {
            MDC.put("grpcService", service);
            MDC.put("grpcMethod", method);
            return action.get();
        } finally {
            restoreMdc("grpcService", oldService);
            restoreMdc("grpcMethod", oldMethod);
        }
    }

    private static void restoreMdc(String key, String value) {
        if (value == null) {
            MDC.remove(key);
        } else {
            MDC.put(key, value);
        }
    }

    private static void finishSpan(
            Span span, AtomicBoolean spanEnded, Status status, long startNs, String fullMethod) {
        if (!spanEnded.compareAndSet(false, true)) {
            return;
        }
        span.setAttribute("rpc.grpc.status_code", status.getCode().name());
        span.setAttribute("duration.ms", (System.nanoTime() - startNs) / 1_000_000);
        if (status.isOk()) {
            span.setStatus(StatusCode.OK);
            LOG.info("gRPC call completed: {} status=OK", fullMethod);
        } else {
            span.setAttribute("error.type", status.getCode().name());
            span.setStatus(StatusCode.ERROR, "gRPC call failed");
            LOG.warn("gRPC call failed: {} status={}", fullMethod, status.getCode());
        }
        span.end();
    }
}
