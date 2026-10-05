package com.ghatana.audio.video.common.resilience;

import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.Status;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

/**
 * @doc.type class
 * @doc.purpose Unit tests for per-tenant gRPC rate limiting (AV-P2-04) 
 * @doc.layer test
 * @doc.pattern Test
 */
@DisplayName("Tenant-Aware Rate Limiting Interceptor Tests (AV-P2-04)")
class TenantAwareRateLimitingInterceptorTest {

    @Test
    @DisplayName("Should allow call within per-tenant limit")
    void shouldAllowCallWithinTenantLimit() { 
        TenantAwareRateLimitingInterceptor interceptor =
                new TenantAwareRateLimitingInterceptor(50.0, Map.of("premium-tenant", 100.0)); 

        Metadata headers = withTenantId("premium-tenant");
        @SuppressWarnings("unchecked")
        ServerCall<String, String> call = createServerCall("av.STT/Transcribe");
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class); 
        when(next.startCall(any(), eq(headers))).thenReturn(new ServerCall.Listener<>() {}); 

        interceptor.interceptCall(call, headers, next); 

        verify(next).startCall(any(), eq(headers)); 
        verify(call, never()).close(any(), any()); 
    }

    @Test
    @DisplayName("Should reject call when rate exhausted for premium tenant with low override")
    void shouldRejectWhenTenantQuotaExhausted() { 
        // Set a very low per-tenant quota (1 TPS, burst 1) to exhaust immediately 
        TenantAwareRateLimitingInterceptor interceptor =
                new TenantAwareRateLimitingInterceptor(50.0, Map.of("low-quota-tenant", 0.001)); 

        Metadata headers = withTenantId("low-quota-tenant");
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class); 
        when(next.startCall(any(), any())).thenReturn(new ServerCall.Listener<>() {}); 

        // Exhaust the burst
        for (int i = 0; i < 20; i++) { 
            interceptor.interceptCall(createServerCall("av.STT/Transcribe"), headers, next);
        }

        // Next call should be rejected
        @SuppressWarnings("unchecked")
        ServerCall<String, String> rejectedCall = createServerCall("av.STT/Transcribe");
        interceptor.interceptCall(rejectedCall, headers, next); 

        ArgumentCaptor<Status> statusCaptor = ArgumentCaptor.forClass(Status.class); 
        verify(rejectedCall, atLeastOnce()).close(statusCaptor.capture(), any()); 

        boolean anyResourceExhausted = statusCaptor.getAllValues().stream() 
                .anyMatch(s -> s.getCode() == Status.Code.RESOURCE_EXHAUSTED); 
        assertThat(anyResourceExhausted).isTrue(); 
    }

    @Test
    @DisplayName("Tenant without explicit quota falls back to global default")
    void shouldUseDefaultLimitForUnknownTenant() { 
        TenantAwareRateLimitingInterceptor interceptor =
                new TenantAwareRateLimitingInterceptor(50.0, Map.of()); 

        Metadata headers = withTenantId("unknown-tenant");
        @SuppressWarnings("unchecked")
        ServerCall<String, String> call = createServerCall("av.STT/Transcribe");
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class); 
        when(next.startCall(any(), eq(headers))).thenReturn(new ServerCall.Listener<>() {}); 

        interceptor.interceptCall(call, headers, next); 

        // Should proceed without rejection
        verify(next).startCall(any(), eq(headers)); 
    }

    @Test
    @DisplayName("Null tenant ID uses global default limiter")
    void shouldHandleNullTenantId() { 
        TenantAwareRateLimitingInterceptor interceptor =
                new TenantAwareRateLimitingInterceptor(50.0, Map.of()); 

        Metadata headers = new Metadata(); // no tenant header 
        @SuppressWarnings("unchecked")
        ServerCall<String, String> call = createServerCall("av.Vision/Detect");
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class); 
        when(next.startCall(any(), eq(headers))).thenReturn(new ServerCall.Listener<>() {}); 

        interceptor.interceptCall(call, headers, next); 

        verify(next).startCall(any(), eq(headers)); 
    }

    @Test
    @DisplayName("updateTenantQuota replaces existing limit at runtime")
    void shouldUpdateTenantQuotaAtRuntime() { 
        TenantAwareRateLimitingInterceptor interceptor =
                new TenantAwareRateLimitingInterceptor(50.0, Map.of()); 

        // Apply a very high quota so calls proceed
        interceptor.updateTenantQuota("dynamic-tenant", 100.0); 

        Metadata headers = withTenantId("dynamic-tenant");
        @SuppressWarnings("unchecked")
        ServerCall<String, String> call = createServerCall("av.STT/Transcribe");
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class); 
        when(next.startCall(any(), eq(headers))).thenReturn(new ServerCall.Listener<>() {}); 

        interceptor.interceptCall(call, headers, next); 

        verify(next).startCall(any(), eq(headers)); 
    }

    // ── helpers ────────────────────────────────────────────────────────────

    private static Metadata withTenantId(String tenantId) { 
        Metadata headers = new Metadata(); 
        headers.put(TenantAwareRateLimitingInterceptor.TENANT_ID_KEY, tenantId); 
        return headers;
    }

    @SuppressWarnings("unchecked")
    private static <ReqT, RespT> ServerCall<ReqT, RespT> createServerCall(String fullMethodName) { 
        ServerCall<ReqT, RespT> call = mock(ServerCall.class); 
        MethodDescriptor<ReqT, RespT> descriptor = MethodDescriptor.<ReqT, RespT>newBuilder() 
                .setType(MethodDescriptor.MethodType.UNARY) 
                .setFullMethodName(fullMethodName) 
                .setRequestMarshaller(byteMarshaller()) 
                .setResponseMarshaller(byteMarshaller()) 
                .build(); 
        when(call.getMethodDescriptor()).thenReturn(descriptor); 
        return call;
    }

    @SuppressWarnings("unchecked")
    private static <T> MethodDescriptor.Marshaller<T> byteMarshaller() { 
        return (MethodDescriptor.Marshaller<T>) new MethodDescriptor.Marshaller<String>() { 
            @Override
            public InputStream stream(String value) { 
                return new ByteArrayInputStream(value.getBytes(StandardCharsets.UTF_8)); 
            }

            @Override
            public String parse(InputStream stream) { 
                return "parsed";
            }
        };
    }
}

