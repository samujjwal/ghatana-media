/*
 * Copyright (c) 2026 Ghatana Inc. 
 * All rights reserved.
 */
package com.ghatana.platform.observability.tracing;

import io.grpc.CallOptions;
import io.grpc.Channel;
import io.grpc.ClientCall;
import io.grpc.ClientInterceptor;
import io.grpc.ManagedChannel;
import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.slf4j.MDC;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Unit tests for {@link GrpcCorrelationInterceptors} (CP-002.1). 
 */
@DisplayName("GrpcCorrelationInterceptors — CP-002.1")
class GrpcCorrelationInterceptorsTest {

    @BeforeEach
    void setUp() { 
        MDC.clear(); 
    }

    @AfterEach
    void tearDown() { 
        MDC.clear(); 
    }

    @Test
    @DisplayName("clientInterceptor() injects MDC correlation ID into outbound metadata")
    void clientInjectsCorrelationId() { 
        MDC.put(GrpcCorrelationInterceptors.MDC_KEY, "test-corr-id-123"); 

        ClientInterceptor interceptor = GrpcCorrelationInterceptors.clientInterceptor(); 
        Metadata capturedHeaders = new Metadata(); 

        // Build a minimal channel stub that captures the start call metadata
        Channel fakeChannel = new Channel() { 
            @Override
            public <Req, Resp> ClientCall<Req, Resp> newCall( 
                    MethodDescriptor<Req, Resp> method, CallOptions opts) {
                return new io.grpc.internal.NoopClientCall<>() { 
                    @Override
                    public void start(Listener<Resp> listener, Metadata headers) { 
                        capturedHeaders.merge(headers); 
                    }
                };
            }

            @Override
            public String authority() { return "localhost"; } 
        };

        @SuppressWarnings("unchecked")
        MethodDescriptor<Object, Object> method = (MethodDescriptor<Object, Object>) 
                mock(MethodDescriptor.class); 
        when(method.getFullMethodName()).thenReturn("TestService/TestMethod");

        ClientCall<Object, Object> call = interceptor.interceptCall(method, CallOptions.DEFAULT, fakeChannel); 
        call.start(mock(ClientCall.Listener.class), new Metadata()); 

        assertThat(capturedHeaders.get(GrpcCorrelationInterceptors.CORRELATION_ID_KEY)) 
                .isEqualTo("test-corr-id-123");
    }

    @Test
    @DisplayName("clientInterceptor() generates correlation ID when MDC is empty")
    void clientGeneratesCorrelationIdWhenMdcEmpty() { 
        ClientInterceptor interceptor = GrpcCorrelationInterceptors.clientInterceptor(); 
        Metadata capturedHeaders = new Metadata(); 

        Channel fakeChannel = new Channel() { 
            @Override
            public <Req, Resp> ClientCall<Req, Resp> newCall( 
                    MethodDescriptor<Req, Resp> method, CallOptions opts) {
                return new io.grpc.internal.NoopClientCall<>() { 
                    @Override
                    public void start(Listener<Resp> listener, Metadata headers) { 
                        capturedHeaders.merge(headers); 
                    }
                };
            }

            @Override
            public String authority() { return "localhost"; } 
        };

        @SuppressWarnings("unchecked")
        MethodDescriptor<Object, Object> method = (MethodDescriptor<Object, Object>) 
                mock(MethodDescriptor.class); 
        when(method.getFullMethodName()).thenReturn("Svc/Method");

        ClientCall<Object, Object> call = interceptor.interceptCall(method, CallOptions.DEFAULT, fakeChannel); 
        call.start(mock(ClientCall.Listener.class), new Metadata()); 

        String correlationId = capturedHeaders.get(GrpcCorrelationInterceptors.CORRELATION_ID_KEY); 
        assertThat(correlationId).isNotBlank(); 
        // Must be a valid UUID
        assertThat(correlationId).matches("[0-9a-fA-F-]{36}");
    }

    @Test
    @DisplayName("CORRELATION_ID_KEY constant is 'x-correlation-id'")
    void correlationIdKeyName() { 
        assertThat(GrpcCorrelationInterceptors.CORRELATION_ID_KEY.name()) 
                .isEqualTo("x-correlation-id");
    }

    @Test
    @DisplayName("MDC_KEY constant is 'correlationId'")
    void mdcKeyName() { 
        assertThat(GrpcCorrelationInterceptors.MDC_KEY).isEqualTo("correlationId");
    }

    @Test
    @DisplayName("serverInterceptor() returns a non-null ServerInterceptor")
    void serverInterceptorNonNull() { 
        assertThat(GrpcCorrelationInterceptors.serverInterceptor()).isNotNull(); 
    }

    @Test
    @DisplayName("clientInterceptor() returns a non-null ClientInterceptor")
    void clientInterceptorNonNull() { 
        assertThat(GrpcCorrelationInterceptors.clientInterceptor()).isNotNull(); 
    }
}

