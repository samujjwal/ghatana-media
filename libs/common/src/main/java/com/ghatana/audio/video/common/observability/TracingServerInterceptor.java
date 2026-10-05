package com.ghatana.audio.video.common.observability;

import io.grpc.ForwardingServerCall;
import io.grpc.Metadata;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;
import io.grpc.Status;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;

import java.util.UUID;

/**
 * gRPC server interceptor providing structured logging and lightweight tracing.
 *
 * <p>For each inbound call this interceptor:
 * <ol>
 *   <li>Generates or propagates a {@code trace-id} from the {@code x-trace-id} header.</li>
 *   <li>Injects {@code traceId}, {@code method}, and {@code service} into the SLF4J MDC
 *       so that all log statements within the call carry these fields automatically.</li>
 *   <li>Records call duration and final gRPC status at INFO level.</li>
 *   <li>Cleans up MDC on completion to prevent cross-request leakage.</li>
 * </ol>
 *
 * <p>This implementation is intentionally zero-dependency on the OpenTelemetry SDK so that
 * it can be used before the OTel agent is available. When the OTel Java agent is attached
 * it will automatically instrument gRPC calls via the {@code opentelemetry-grpc} auto-instrumentation,
 * and this interceptor's structured logs will be correlated via the MDC {@code traceId} field.
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

    @Override
    public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
            ServerCall<ReqT, RespT> call,
            Metadata headers,
            ServerCallHandler<ReqT, RespT> next) {

        String traceId = headers.get(TRACE_ID_KEY);
        if (traceId == null || traceId.isBlank()) {
            traceId = UUID.randomUUID().toString().replace("-", "");
        }
        String spanId = UUID.randomUUID().toString().replace("-", "").substring(0, 16);

        String fullMethod = call.getMethodDescriptor().getFullMethodName();
        String[] parts = fullMethod.split("/");
        String service = parts.length > 0 ? parts[0] : fullMethod;
        String method  = parts.length > 1 ? parts[1] : fullMethod;

        MDC.put("traceId", traceId);
        MDC.put("spanId", spanId);
        MDC.put("grpcService", service);
        MDC.put("grpcMethod", method);

        long startNs = System.nanoTime();
        LOG.info("gRPC call started: {}", fullMethod);

        // Propagate trace ID in response headers for client correlation
        Metadata responseHeaders = new Metadata();
        responseHeaders.put(TRACE_ID_KEY, traceId);
        responseHeaders.put(SPAN_ID_KEY, spanId);

        ServerCall<ReqT, RespT> wrappedCall = new ForwardingServerCall.SimpleForwardingServerCall<>(call) {
            @Override
            public void sendHeaders(Metadata responseMetadata) {
                responseMetadata.merge(responseHeaders);
                super.sendHeaders(responseMetadata);
            }

            @Override
            public void close(Status status, Metadata trailers) {
                long durationMs = (System.nanoTime() - startNs) / 1_000_000;
                if (status.isOk()) {
                    LOG.info("gRPC call completed: {} status=OK durationMs={}", fullMethod, durationMs);
                } else {
                    LOG.warn("gRPC call failed: {} status={} durationMs={} description={}",
                            fullMethod, status.getCode(), durationMs, status.getDescription());
                }
                MDC.remove("traceId");
                MDC.remove("spanId");
                MDC.remove("grpcService");
                MDC.remove("grpcMethod");
                super.close(status, trailers);
            }
        };

        return next.startCall(wrappedCall, headers);
    }
}
