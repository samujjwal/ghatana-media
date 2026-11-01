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
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

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

    @Test
    @DisplayName("Client cancellation releases the concurrency permit")
    @SuppressWarnings({"unchecked", "rawtypes"})
    void shouldReleasePermitWhenClientCancels() {
        TenantAwareRateLimitingInterceptor interceptor =
                new TenantAwareRateLimitingInterceptor(50.0, Map.of());
        Metadata headers = new Metadata();
        List<ServerCall.Listener<String>> listeners = new ArrayList<>();
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class);
        when(next.startCall(any(), any())).thenReturn(new ServerCall.Listener<>() {});

        for (int i = 0; i < 20; i++) {
            listeners.add(interceptAs(interceptor, createServerCall("av.STT/Transcribe"), headers, next,
                    "tenant-" + i));
        }

        ServerCall<String, String> saturated = createServerCall("av.STT/Transcribe");
        interceptAs(interceptor, saturated, headers, next, "saturated-tenant");
        verify(saturated).close(argThat(status -> status.getCode() == Status.Code.RESOURCE_EXHAUSTED), any());

        listeners.get(0).onCancel();

        ServerCall<String, String> afterCancel = createServerCall("av.STT/Transcribe");
        interceptAs(interceptor, afterCancel, headers, next, "after-cancel-tenant");
        verify(next, times(21)).startCall(any(), eq(headers));
    }

    @Test
    @DisplayName("Configured tenant concurrency is isolated while the global cap still applies")
    @SuppressWarnings({"unchecked", "rawtypes"})
    void shouldIsolateConfiguredTenantConcurrencyAndRetainGlobalCap() {
        TenantAwareRateLimitingInterceptor interceptor =
                new TenantAwareRateLimitingInterceptor(50.0,
                        Map.of("tenant-a", 50.0, "tenant-b", 50.0), 2, 1);
        Metadata headers = new Metadata();
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class);
        when(next.startCall(any(), any())).thenReturn(new ServerCall.Listener<>() {});
        ArgumentCaptor<ServerCall<String, String>> wrapped = ArgumentCaptor.forClass(ServerCall.class);

        interceptAs(interceptor, createServerCall("av.STT/Transcribe"), headers, next, "tenant-a");
        ServerCall<String, String> tenantASaturated = createServerCall("av.STT/Transcribe");
        interceptAs(interceptor, tenantASaturated, headers, next, "tenant-a");
        verify(tenantASaturated).close(argThat(s -> s.getCode() == Status.Code.RESOURCE_EXHAUSTED), any());

        interceptAs(interceptor, createServerCall("av.STT/Transcribe"), headers, next, "tenant-b");
        TenantAwareRateLimitingInterceptor globalOnly =
                new TenantAwareRateLimitingInterceptor(50.0, Map.of(), 2, 2);
        ServerCallHandler<String, String> globalNext = mock(ServerCallHandler.class);
        when(globalNext.startCall(any(), any())).thenReturn(new ServerCall.Listener<>() {});
        interceptAs(globalOnly, createServerCall("av.STT/Transcribe"), headers, globalNext, "tenant-c");
        interceptAs(globalOnly, createServerCall("av.STT/Transcribe"), headers, globalNext, "tenant-d");
        ServerCall<String, String> globallySaturated = createServerCall("av.STT/Transcribe");
        interceptAs(globalOnly, globallySaturated, headers, globalNext, "tenant-e");
        verify(globallySaturated).close(argThat(s -> s.getCode() == Status.Code.RESOURCE_EXHAUSTED), any());
        verify(next, times(2)).startCall(wrapped.capture(), eq(headers));
        verify(globalNext, times(2)).startCall(any(), eq(headers));
        wrapped.getAllValues().forEach(c -> c.close(Status.OK, new Metadata()));
    }

    @Test
    @DisplayName("Saturated tenant calls are rejected immediately without queueing")
    @SuppressWarnings({"unchecked", "rawtypes"})
    void shouldRejectSaturatedTenantCallsWithoutQueueing() {
        TenantAwareRateLimitingInterceptor interceptor =
                new TenantAwareRateLimitingInterceptor(50.0, Map.of(), 4, 1);
        Metadata headers = new Metadata();
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class);
        when(next.startCall(any(), any())).thenReturn(new ServerCall.Listener<>() {});
        ArgumentCaptor<ServerCall<String, String>> admitted = ArgumentCaptor.forClass(ServerCall.class);

        interceptAs(interceptor, createServerCall("av.STT/Transcribe"), headers, next, "tenant-a");
        for (int i = 0; i < 100; i++) {
            ServerCall<String, String> rejected = createServerCall("av.STT/Transcribe");
            interceptAs(interceptor, rejected, headers, next, "tenant-a");
            verify(rejected).close(argThat(status -> status.getCode() == Status.Code.RESOURCE_EXHAUSTED), any());
        }

        // Every request was rejected synchronously; only the first reached the service handler.
        verify(next, times(1)).startCall(admitted.capture(), eq(headers));
        admitted.getValue().close(Status.OK, new Metadata());

        interceptAs(interceptor, createServerCall("av.STT/Transcribe"), headers, next, "tenant-a");
        verify(next, times(2)).startCall(any(), eq(headers));
    }

    @Test
    @DisplayName("Default and unconfigured tenants receive isolated bounds without retained ID state")
    void shouldNotAllocateOrApplyPerTenantStateToUnconfiguredIds() {
        TenantAwareRateLimitingInterceptor interceptor =
                new TenantAwareRateLimitingInterceptor(50.0, Map.of("configured", 50.0), 4, 1);
        Metadata headers = new Metadata();
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class);
        when(next.startCall(any(), any())).thenReturn(new ServerCall.Listener<>() {});

        interceptAs(interceptor, createServerCall("av.STT/Transcribe"), headers, next, "unknown-1");
        ServerCall<String, String> sameTenantSaturated = createServerCall("av.STT/Transcribe");
        interceptAs(interceptor, sameTenantSaturated, headers, next, "unknown-1");
        verify(sameTenantSaturated).close(
                argThat(s -> s.getCode() == Status.Code.RESOURCE_EXHAUSTED), any());
        interceptAs(interceptor, createServerCall("av.STT/Transcribe"), headers, next, "unknown-2");
        interceptAs(interceptor, createServerCall("av.STT/Transcribe"), headers, next, "configured");

        verify(next, times(3)).startCall(any(), eq(headers));
    }

    @Test
    @DisplayName("Unknown tenant state is removed after call termination")
    void shouldRemoveUnknownTenantStateAfterCallsFinish() {
        TenantAwareRateLimitingInterceptor interceptor =
                new TenantAwareRateLimitingInterceptor(1_000.0, Map.of(), 10_000L, 4, 1);
        Metadata headers = new Metadata();
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class);
        AtomicReference<ServerCall<String, String>> wrapped = new AtomicReference<>();
        when(next.startCall(any(), any())).thenAnswer(invocation -> {
            wrapped.set(invocation.getArgument(0));
            return new ServerCall.Listener<>() {};
        });

        for (int i = 0; i < 4_100; i++) {
            interceptAs(interceptor, createServerCall("av.STT/Transcribe"), headers, next, "ephemeral-" + i);
            // The call returned by startCall is wrapped and releases its active registry entry on close.
            wrapped.get().close(Status.OK, new Metadata());
        }

        verify(next, times(4_100)).startCall(any(), eq(headers));
    }

    @Test
    @DisplayName("Tenant permit is released when startCall throws")
    void shouldReleaseTenantPermitWhenStartCallFails() {
        TenantAwareRateLimitingInterceptor interceptor =
                new TenantAwareRateLimitingInterceptor(50.0, Map.of("tenant", 50.0), 2, 1);
        Metadata headers = new Metadata();
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class);
        when(next.startCall(any(), any())).thenThrow(new IllegalStateException("start failed"));

        org.assertj.core.api.Assertions.assertThatThrownBy(() -> interceptAs(interceptor,
                createServerCall("av.STT/Transcribe"), headers, next, "tenant"))
                .isInstanceOf(IllegalStateException.class);
        doReturn(new ServerCall.Listener<>() {}).when(next).startCall(any(), any());

        interceptAs(interceptor, createServerCall("av.STT/Transcribe"), headers, next, "tenant");
        verify(next, times(2)).startCall(any(), eq(headers));
    }

    // ── helpers ────────────────────────────────────────────────────────────

    private static Metadata withTenantId(String tenantId) {
        Metadata headers = new Metadata();
        headers.put(TENANT_ID_KEY, tenantId);
        return headers;
    }

    private static <ReqT, RespT> ServerCall.Listener<ReqT> interceptAs(
            TenantAwareRateLimitingInterceptor interceptor,
            ServerCall<ReqT, RespT> call,
            Metadata headers,
            ServerCallHandler<ReqT, RespT> next,
            String tenantId) {
        AtomicReference<ServerCall.Listener<ReqT>> listener = new AtomicReference<>();
        Context.current().withValue(JwtServerInterceptor.VERIFIED_IDENTITY,
                new JwtServerInterceptor.VerifiedIdentity("user", tenantId)).run(
                        () -> listener.set(interceptor.interceptCall(call, headers, next)));
        return listener.get();
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
