/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.platform.observability.tracing;

import io.grpc.CallOptions;
import io.grpc.Channel;
import io.grpc.ClientCall;
import io.grpc.ClientInterceptor;
import io.grpc.ForwardingClientCall;
import io.grpc.ForwardingClientCallListener;
import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;

import java.util.Objects;
import java.util.UUID;

/**
 * gRPC interceptors for end-to-end correlation ID propagation (CP-002.1).
 *
 * <p>Provides both a {@link ClientInterceptor} that reads the current correlation ID
 * from MDC and injects it into outgoing gRPC metadata, and a {@link ServerInterceptor}
 * that extracts the correlation ID from incoming metadata and populates MDC.
 *
 * <p>Use {@link #clientInterceptor()} on the gRPC client side and
 * {@link #serverInterceptor()} on the gRPC server side.
 *
 * <h3>Metadata key</h3>
 * <p>The correlation ID is transmitted in the {@code x-correlation-id} gRPC
 * metadata key, matching the HTTP convention used in the rest of the platform.
 *
 * @doc.type    class
 * @doc.purpose gRPC correlation ID propagation for distributed tracing
 * @doc.layer   platform
 * @doc.pattern Interceptor, Middleware
 */
public final class GrpcCorrelationInterceptors {

    private static final Logger LOG = LoggerFactory.getLogger(GrpcCorrelationInterceptors.class);

    public static final Metadata.Key<String> CORRELATION_ID_KEY =
            Metadata.Key.of("x-correlation-id", Metadata.ASCII_STRING_MARSHALLER);

    public static final String MDC_KEY = "correlationId";

    private GrpcCorrelationInterceptors() {}

    // ── Factory methods ────────────────────────────────────────────────────────

    /**
     * Returns a gRPC client interceptor that injects the current MDC correlation ID
     * into outgoing call metadata.  If no correlation ID is present in MDC a new
     * one is generated.
     *
     * @return client interceptor
     */
    public static ClientInterceptor clientInterceptor() {
        return new CorrelationClientInterceptor();
    }

    /**
     * Returns a gRPC server interceptor that extracts the correlation ID from
     * incoming call metadata and sets it in MDC for the duration of the call.
     *
     * @return server interceptor
     */
    public static ServerInterceptor serverInterceptor() {
        return new CorrelationServerInterceptor();
    }

    // ── Client-side ────────────────────────────────────────────────────────────

    private static final class CorrelationClientInterceptor implements ClientInterceptor {

        @Override
        public <Req, Resp> ClientCall<Req, Resp> interceptCall(
                MethodDescriptor<Req, Resp> method,
                CallOptions callOptions,
                Channel next) {

            return new ForwardingClientCall.SimpleForwardingClientCall<>(
                    next.newCall(method, callOptions)) {

                @Override
                public void start(Listener<Resp> responseListener, Metadata headers) {
                    String correlationId = MDC.get(MDC_KEY);
                    if (correlationId == null || correlationId.isBlank()) {
                        correlationId = UUID.randomUUID().toString();
                        LOG.debug("Generated new correlation ID for outbound gRPC call: {}", correlationId);
                    }
                    headers.put(CORRELATION_ID_KEY, correlationId);
                    LOG.trace("Injected x-correlation-id={} into gRPC call {}", correlationId, method.getFullMethodName());

                    final String finalCorrelationId = correlationId;
                    super.start(new ForwardingClientCallListener.SimpleForwardingClientCallListener<>(
                            responseListener) {
                        // correlation context is already on the calling thread; no override needed
                    }, headers);
                }
            };
        }
    }

    // ── Server-side ────────────────────────────────────────────────────────────

    private static final class CorrelationServerInterceptor implements ServerInterceptor {

        @Override
        public <Req, Resp> ServerCall.Listener<Req> interceptCall(
                ServerCall<Req, Resp> call,
                Metadata headers,
                ServerCallHandler<Req, Resp> next) {

            String correlationId = headers.get(CORRELATION_ID_KEY);
            if (correlationId == null || correlationId.isBlank()) {
                correlationId = UUID.randomUUID().toString();
                LOG.debug("No x-correlation-id in inbound gRPC call {} — generated: {}",
                        call.getMethodDescriptor().getFullMethodName(), correlationId);
            } else {
                LOG.trace("Received x-correlation-id={} for gRPC call {}",
                        correlationId, call.getMethodDescriptor().getFullMethodName());
            }

            MDC.put(MDC_KEY, correlationId);

            try {
                return new CorrelationClearingListener<>(next.startCall(call, headers));
            } catch (Exception e) {
                MDC.remove(MDC_KEY);
                throw e;
            }
        }

        /**
         * Listener that clears the MDC correlation ID after the call completes.
         */
        private static final class CorrelationClearingListener<Req>
                extends io.grpc.ForwardingServerCallListener.SimpleForwardingServerCallListener<Req> {

            CorrelationClearingListener(ServerCall.Listener<Req> delegate) {
                super(delegate);
            }

            @Override
            public void onComplete() {
                try { super.onComplete(); }
                finally { MDC.remove(MDC_KEY); }
            }

            @Override
            public void onCancel() {
                try { super.onCancel(); }
                finally { MDC.remove(MDC_KEY); }
            }
        }
    }
}

