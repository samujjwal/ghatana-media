package com.ghatana.audio.video.common.security;

import com.ghatana.audio.video.common.resilience.TenantAwareRateLimitingInterceptor;
import io.grpc.Context;
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
import java.util.HashMap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
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
    private static final Metadata.Key<String> TENANT_ID_KEY =
            Metadata.Key.of("x-tenant-id", Metadata.ASCII_STRING_MARSHALLER);

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

        interceptAs(interceptor, call, headers, next, "premium-tenant");

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
            interceptAs(interceptor, createServerCall("av.STT/Transcribe"), headers, next, "low-quota-tenant");
        }

        // Next call should be rejected
        @SuppressWarnings("unchecked")
        ServerCall<String, String> rejectedCall = createServerCall("av.STT/Transcribe");
        interceptAs(interceptor, rejectedCall, headers, next, "low-quota-tenant");

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

        interceptAs(interceptor, call, headers, next, "unknown-tenant");

        // Should proceed without rejection
        verify(next).startCall(any(), eq(headers));
    }

    @Test
    @DisplayName("Missing metadata tenant uses authenticated tenant and global default limiter")
    void shouldHandleMissingMetadataTenant() {
        TenantAwareRateLimitingInterceptor interceptor =
                new TenantAwareRateLimitingInterceptor(50.0, Map.of());

        Metadata headers = new Metadata(); // no tenant header
        @SuppressWarnings("unchecked")
        ServerCall<String, String> call = createServerCall("av.Vision/Detect");
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class);
        when(next.startCall(any(), eq(headers))).thenReturn(new ServerCall.Listener<>() {});

        interceptAs(interceptor, call, headers, next, "authenticated-tenant");

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

        interceptAs(interceptor, call, headers, next, "dynamic-tenant");

        verify(next).startCall(any(), eq(headers));
    }

    @Test
    @DisplayName("Missing verified identity is rejected before backend dispatch")
    void shouldRejectMissingVerifiedIdentity() {
        TenantAwareRateLimitingInterceptor interceptor =
                new TenantAwareRateLimitingInterceptor(50.0, Map.of());
        Metadata headers = withTenantId("forged-tenant");
        ServerCall<String, String> call = createServerCall("av.STT/Transcribe");
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class);

        interceptor.interceptCall(call, headers, next);

        verify(call).close(argThat(status -> status.getCode() == Status.Code.UNAUTHENTICATED), any());
        verifyNoInteractions(next);
    }

    @Test
    @DisplayName("Forged metadata tenant is rejected before backend dispatch")
    void shouldRejectMetadataTenantMismatch() {
        TenantAwareRateLimitingInterceptor interceptor =
                new TenantAwareRateLimitingInterceptor(50.0, Map.of());
        Metadata headers = withTenantId("premium-tenant");
        ServerCall<String, String> call = createServerCall("av.STT/Transcribe");
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class);

        interceptAs(interceptor, call, headers, next, "victim-tenant");

        verify(call).close(argThat(status -> status.getCode() == Status.Code.PERMISSION_DENIED), any());
        verifyNoInteractions(next);
    }

    @Test
    @DisplayName("Unconfigured authenticated tenants share the bounded default bucket")
    void shouldNotCreateUnboundedBucketsForUnknownTenants() {
        TenantAwareRateLimitingInterceptor interceptor =
                new TenantAwareRateLimitingInterceptor(1.0, Map.of());
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class);
        when(next.startCall(any(), any())).thenReturn(new ServerCall.Listener<>() {});

        for (String tenant : new String[] {"unknown-a", "unknown-b", "unknown-c", "unknown-d"}) {
            ServerCall<String, String> call = createServerCall("av.STT/Transcribe");
            interceptAs(interceptor, call, new Metadata(), next, tenant);
        }

        verify(next, times(2)).startCall(any(), any());
        // The shared fallback bucket rejects after its configured burst has been consumed.
        verifyNoMoreInteractions(next);
    }

    @Test
    @DisplayName("Invalid or overflowing rates are rejected at configuration time")
    void shouldRejectInvalidRates() {
        assertThatThrownBy(() -> new TenantAwareRateLimitingInterceptor(Double.NaN, Map.of()))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new TenantAwareRateLimitingInterceptor(Double.POSITIVE_INFINITY, Map.of()))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new TenantAwareRateLimitingInterceptor(1.0, Map.of("tenant", -1.0)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new TenantAwareRateLimitingInterceptor(1.0, Map.of("tenant", Double.MAX_VALUE)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("Configured tenant limiter state is capped")
    void shouldRejectQuotaUpdatesBeyondTenantStateCap() {
        Map<String, Double> configured = new HashMap<>();
        for (int i = 0; i < 4_096; i++) {
            configured.put("tenant-" + i, 1.0);
        }
        TenantAwareRateLimitingInterceptor interceptor =
                new TenantAwareRateLimitingInterceptor(50.0, configured);

        assertThatThrownBy(() -> interceptor.updateTenantQuota("tenant-over-cap", 1.0))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    @DisplayName("Global concurrent-call bound is retained and permits release on close")
    @SuppressWarnings({"unchecked", "rawtypes"})
    void shouldBoundConcurrentCallsAndReleasePermitOnClose() {
        TenantAwareRateLimitingInterceptor interceptor =
                new TenantAwareRateLimitingInterceptor(50.0, Map.of());
        Metadata headers = new Metadata();
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class);
        when(next.startCall(any(), any())).thenReturn(new ServerCall.Listener<>() {});
        ArgumentCaptor<ServerCall<String, String>> wrappedCalls = ArgumentCaptor.forClass(ServerCall.class);

        for (int i = 0; i < 20; i++) {
            interceptAs(interceptor, createServerCall("av.STT/Transcribe"), headers, next, "tenant-" + i);
        }

        ServerCall<String, String> overloaded = createServerCall("av.STT/Transcribe");
        interceptAs(interceptor, overloaded, headers, next, "another-tenant");
        verify(next, times(20)).startCall(wrappedCalls.capture(), eq(headers));
        verify(overloaded).close(argThat(status -> status.getCode() == Status.Code.RESOURCE_EXHAUSTED), any());

        for (ServerCall<String, String> wrapped : wrappedCalls.getAllValues()) {
            wrapped.close(Status.OK, new Metadata());
        }

        ServerCall<String, String> afterRelease = createServerCall("av.STT/Transcribe");
        interceptAs(interceptor, afterRelease, headers, next, "tenant-after-release");
        verify(next, times(21)).startCall(any(), eq(headers));
    }

    // ── helpers ────────────────────────────────────────────────────────────

    private static Metadata withTenantId(String tenantId) {
        Metadata headers = new Metadata();
        headers.put(TENANT_ID_KEY, tenantId);
        return headers;
    }

    private static <ReqT, RespT> void interceptAs(
            TenantAwareRateLimitingInterceptor interceptor,
            ServerCall<ReqT, RespT> call,
            Metadata headers,
            ServerCallHandler<ReqT, RespT> next,
            String tenantId) {
        Context.current().withValue(JwtServerInterceptor.VERIFIED_IDENTITY,
                new JwtServerInterceptor.VerifiedIdentity("user", tenantId)).run(
                        () -> interceptor.interceptCall(call, headers, next));
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
