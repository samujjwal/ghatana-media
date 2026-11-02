package com.ghatana.audio.video.common;

import com.ghatana.audio.video.common.observability.MetricsServerInterceptor;
import com.ghatana.audio.video.common.observability.TracingServerInterceptor;
import com.ghatana.audio.video.common.resilience.CircuitBreakerServerInterceptor;
import com.ghatana.audio.video.common.resilience.RateLimitingServerInterceptor;
import com.ghatana.audio.video.common.resilience.TenantAwareRateLimitingInterceptor;
import com.ghatana.audio.video.common.resilience.RpcDeadlineServerInterceptor;
import com.ghatana.audio.video.common.security.AudioVideoRequestContextInterceptor;
import com.ghatana.audio.video.common.security.InputValidationServerInterceptor;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.Status;
import io.grpc.ServerInterceptor;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The interceptor chain has a documented security ordering invariant: the list
 * is innermost-first, so JWT (index 3) must execute before tenant quota
 * (index 2) and RBAC (index 1), and
 * input validation (index 0) is the last wall before the service. A reordered
 * chain would let authorization run before authentication or let oversized
 * payloads reach validators.
 */
@DisplayName("gRPC Interceptor Chain Ordering Tests")
class GrpcInterceptorChainTest {

    private static final String TEST_JWT_SECRET = "chain-order-test-secret-0123456789abcdef";

    private static List<ServerInterceptor> buildChain() {
        // JwtServerInterceptor fails closed without a signing secret; the
        // documented System-property fallback is the test seam.
        String previous = System.getProperty("AV_JWT_SECRET");
        System.setProperty("AV_JWT_SECRET", TEST_JWT_SECRET);
        try {
            return GrpcInterceptorChain.build();
        } finally {
            if (previous == null) {
                System.clearProperty("AV_JWT_SECRET");
            } else {
                System.setProperty("AV_JWT_SECRET", previous);
            }
        }
    }

    @Test
    @DisplayName("Chain order is exactly the documented innermost-first sequence")
    void chainPreservesDocumentedOrder() {
        List<ServerInterceptor> chain = buildChain();

        assertThat(chain).hasSize(8);
        assertThat(chain.get(0)).isInstanceOf(InputValidationServerInterceptor.class);
        assertThat(chain.get(1)).isInstanceOf(AudioVideoRequestContextInterceptor.class);
        assertThat(chain.get(2)).isInstanceOf(TenantAwareRateLimitingInterceptor.class);
        assertThat(chain.get(3)).isInstanceOf(JwtServerInterceptor.class);
        assertThat(chain.get(4)).isInstanceOf(CircuitBreakerServerInterceptor.class);
        assertThat(chain.get(5)).isInstanceOf(RpcDeadlineServerInterceptor.class);
        assertThat(chain.get(6)).isInstanceOf(MetricsServerInterceptor.class);
        assertThat(chain.get(7)).isInstanceOf(TracingServerInterceptor.class);
        assertThat(chain).filteredOn(RateLimitingServerInterceptor.class::isInstance).isEmpty();
        assertThat(chain).filteredOn(TenantAwareRateLimitingInterceptor.class::isInstance).hasSize(1);
    }

    @Test
    @DisplayName("JWT runs before tenant quota and RBAC in actual incoming execution order")
    void authenticationPrecedesTenantQuotaAndRbac() {
        List<ServerInterceptor> chain = buildChain();
        int rbac = indexOf(chain, AudioVideoRequestContextInterceptor.class);
        int tenantQuota = indexOf(chain, TenantAwareRateLimitingInterceptor.class);
        int jwt = indexOf(chain, JwtServerInterceptor.class);
        int validation = indexOf(chain, InputValidationServerInterceptor.class);

        // The chain list is innermost-first, so incoming execution runs in reverse.
        assertThat(jwt).isGreaterThan(tenantQuota);
        assertThat(tenantQuota).isGreaterThan(rbac);
        assertThat(rbac).isLessThan(jwt);
        assertThat(validation).isLessThan(rbac);
    }

    @Test
    @DisplayName("Health Check traverses the full chain without JWT identity; app methods remain authenticated")
    void healthMethodsKeepJwtExemptionWithoutOpeningApplicationMethods() {
        List<ServerInterceptor> chain = buildChain();
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> terminal = mock(ServerCallHandler.class);
        when(terminal.startCall(any(), any())).thenReturn(new ServerCall.Listener<>() {});

        ServerCallHandler<String, String> composed = terminal;
        for (ServerInterceptor interceptor : chain) {
            ServerCallHandler<String, String> downstream = composed;
            composed = (call, headers) -> interceptor.interceptCall(call, headers, downstream);
        }

        Metadata unauthenticatedHeaders = new Metadata();
        ServerCall<String, String> healthCall = createCall("grpc.health.v1.Health/Check");
        composed.startCall(healthCall, unauthenticatedHeaders);
        verify(terminal).startCall(any(), eq(unauthenticatedHeaders));

        ServerCall<String, String> appCall = createCall("av.STT/Transcribe");
        composed.startCall(appCall, new Metadata());
        verify(appCall).close(argThat(status -> status.getCode() == Status.Code.UNAUTHENTICATED), any());
        verifyNoMoreInteractions(terminal);
    }

    @SuppressWarnings("unchecked")
    private static ServerCall<String, String> createCall(String fullMethodName) {
        ServerCall<String, String> call = mock(ServerCall.class);
        MethodDescriptor<String, String> descriptor = MethodDescriptor.<String, String>newBuilder()
                .setType(MethodDescriptor.MethodType.UNARY)
                .setFullMethodName(fullMethodName)
                .setRequestMarshaller(byteMarshaller())
                .setResponseMarshaller(byteMarshaller())
                .build();
        when(call.getMethodDescriptor()).thenReturn(descriptor);
        return call;
    }

    @SuppressWarnings("unchecked")
    private static MethodDescriptor.Marshaller<String> byteMarshaller() {
        return (MethodDescriptor.Marshaller<String>) new MethodDescriptor.Marshaller<String>() {
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

    private static int indexOf(
            List<ServerInterceptor> chain, Class<? extends ServerInterceptor> type) {
        for (int i = 0; i < chain.size(); i++) {
            if (type.isInstance(chain.get(i))) {
                return i;
            }
        }
        return -1;
    }
}
