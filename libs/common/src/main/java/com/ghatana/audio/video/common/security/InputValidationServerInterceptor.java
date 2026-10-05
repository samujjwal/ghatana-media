package com.ghatana.audio.video.common.security;

import io.grpc.ForwardingServerCallListener;
import io.grpc.Metadata;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;
import io.grpc.Status;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.google.protobuf.MessageLite;

/**
 * gRPC server interceptor that enforces request size limits.
 *
 * <p>Protobuf messages with audio/video payloads can be very large. This interceptor
 * rejects calls whose serialized request size exceeds a configurable ceiling, preventing
 * OOM attacks and accidental over-large uploads.
 *
 * <p>Configuration via environment variables:
 * <ul>
 *   <li>{@code AV_MAX_REQUEST_BYTES} — maximum allowed serialized request size in bytes
 *       (default 104857600 = 100 MiB)</li>
 * </ul>
 *
 * <p>The check is performed on the first message received (streaming calls are not
 * gated per-chunk; callers should use {@code maxInboundMessageSize} on the ServerBuilder
 * for hard byte limits at the transport layer).
  * @doc.type class
 * @doc.purpose Provides input validation server interceptor functionality.
 * @doc.layer product
 * @doc.pattern Filter
*/
public class InputValidationServerInterceptor implements ServerInterceptor {

    private static final Logger LOG = LoggerFactory.getLogger(InputValidationServerInterceptor.class);

    private static final long DEFAULT_MAX_BYTES = 100L * 1024 * 1024; // 100 MiB

    private final long maxRequestBytes;

    public InputValidationServerInterceptor() {
        this.maxRequestBytes = parseEnvLong("AV_MAX_REQUEST_BYTES", DEFAULT_MAX_BYTES);
        LOG.info("Input validation interceptor initialised: maxRequestBytes={}", maxRequestBytes);
    }

    @Override
    public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
            ServerCall<ReqT, RespT> call,
            Metadata headers,
            ServerCallHandler<ReqT, RespT> next) {

        ServerCall.Listener<ReqT> delegate = next.startCall(call, headers);

        return new ForwardingServerCallListener.SimpleForwardingServerCallListener<>(delegate) {
            @Override
            public void onMessage(ReqT message) {
                if (message instanceof MessageLite msg) {
                    int serializedSize = msg.getSerializedSize();
                    if (serializedSize > maxRequestBytes) {
                        LOG.warn("Request too large: {} bytes > {} limit on {}",
                                serializedSize, maxRequestBytes,
                                call.getMethodDescriptor().getFullMethodName());
                        call.close(
                                Status.INVALID_ARGUMENT.withDescription(
                                        "Request payload too large: " + serializedSize
                                                + " bytes (max " + maxRequestBytes + ")"),
                                new Metadata());
                        return;
                    }
                }
                super.onMessage(message);
            }
        };
    }

    private static long parseEnvLong(String name, long def) {
        String val = System.getenv(name);
        if (val == null) return def;
        try { return Long.parseLong(val); } catch (NumberFormatException e) { return def; }
    }
}
