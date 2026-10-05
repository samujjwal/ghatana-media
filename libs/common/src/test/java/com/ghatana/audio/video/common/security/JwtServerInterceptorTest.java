package com.ghatana.audio.video.common.security;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.nimbusds.jwt.proc.ConfigurableJWTProcessor;
import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.Status;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Tests for {@link JwtServerInterceptor} — covering startup validation, token rejection,
 * and health-method exemption.
 *
 * @doc.type class
 * @doc.purpose JWT interceptor startup-fail and token validation tests (Day 6 / ADR-019) 
 * @doc.layer product
 * @doc.pattern ValidationTest
 */
@DisplayName("JWT Server Interceptor Tests")
class JwtServerInterceptorTest {

    private static final String HEALTH_METHOD = "/grpc.health.v1.Health/Check";
    private static final String SECURE_METHOD = "/com.ghatana.tts.grpc.TtsService/Synthesize";

    /**
    * Env variables cannot be set at runtime in Java, so we test startup
    * behavior by reading the actual env values (expected to be absent in CI). 
     */
    @Nested
    @DisplayName("Startup validation")
    class StartupValidation {

        @Test
        @DisplayName("Constructor throws when AV_JWT_SECRET is absent")
        void constructorThrowsWhenSecretAbsent() { 
            String secret = System.getenv("AV_JWT_SECRET");
            if (secret != null && !secret.isBlank()) { 
                return;
            }
            assertThatThrownBy(JwtServerInterceptor::new) 
                    .isInstanceOf(IllegalStateException.class) 
                    .hasMessageContaining("AV_JWT_SECRET")
                    .hasMessageContaining("does not support permissive bypass mode");
        }
    }

    @Nested
    @DisplayName("Health method exemption")
    class HealthMethodExemption {

        @Test
        @DisplayName("Health Check method bypasses JWT validation")
        void healthCheckBypassesValidation() { 
            @SuppressWarnings("unchecked")
            ConfigurableJWTProcessor<SecurityContext> processor = mock(ConfigurableJWTProcessor.class); 
            JwtServerInterceptor interceptor = new JwtServerInterceptor(processor, disabledTokenValidator()); 

            ServerCall<Object, Object> call = mockCall(HEALTH_METHOD); 
            @SuppressWarnings("unchecked")
            ServerCallHandler<Object, Object> handler = mock(ServerCallHandler.class); 
            @SuppressWarnings("unchecked")
            ServerCall.Listener<Object> listener = mock(ServerCall.Listener.class); 
            when(handler.startCall(any(), any())).thenReturn(listener); 

            interceptor.interceptCall(call, new Metadata(), handler); 

            // Health check must be passed through — no close() call 
            verify(call, never()).close(any(), any()); 
            verify(handler).startCall(eq(call), any()); 
        }
    }

    @Nested
    @DisplayName("Missing token rejection")
    class MissingTokenRejection {

        @Test
        @DisplayName("Strict mode rejects requests with no Authorization header")
        void strictModeRejectsMissingAuthorizationHeader() { 
            String secret = System.getenv("AV_JWT_SECRET");
            if (secret == null || secret.isBlank()) { 
                // Cannot run strict-mode test without a real secret
                return;
            }

            JwtServerInterceptor interceptor = new JwtServerInterceptor(); 
            ServerCall<Object, Object> call = mockCall(SECURE_METHOD); 
            @SuppressWarnings("unchecked")
            ServerCallHandler<Object, Object> handler = mock(ServerCallHandler.class); 

            interceptor.interceptCall(call, new Metadata(), handler); 

            ArgumentCaptor<Status> statusCaptor = ArgumentCaptor.forClass(Status.class); 
            verify(call).close(statusCaptor.capture(), any()); 
            assertThat(statusCaptor.getValue().getCode()).isEqualTo(Status.Code.UNAUTHENTICATED); 
            verify(handler, never()).startCall(any(), any()); 
        }
    }

    @Nested
    @DisplayName("Tenant context propagation")
    class TenantContextPropagation {

        @SuppressWarnings("unchecked")
        @Test
        @DisplayName("validated JWT exposes subject and tenant in gRPC context")
        void validatedJwtExposesSubjectAndTenantContext() throws Exception { 
            ConfigurableJWTProcessor<SecurityContext> processor = mock(ConfigurableJWTProcessor.class); 
            when(processor.process(any(SignedJWT.class), eq(null))).thenReturn(null); 

            JwtServerInterceptor interceptor = new JwtServerInterceptor( 
                    processor,
                    disabledTokenValidator() 
            );

            Metadata headers = new Metadata(); 
            headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER), 
                    "Bearer " + signedToken("user-1", "tenant-42")); 

            ServerCall<Object, Object> call = mockCall(SECURE_METHOD); 
            ServerCallHandler<Object, Object> handler = mock(ServerCallHandler.class); 
            AtomicReference<String> subjectRef = new AtomicReference<>(); 
            AtomicReference<String> tenantRef = new AtomicReference<>(); 

            when(handler.startCall(any(), any())).thenAnswer(invocation -> { 
                subjectRef.set(JwtServerInterceptor.CTX_SUBJECT.get()); 
                tenantRef.set(JwtServerInterceptor.CTX_TENANT.get()); 
                return mock(ServerCall.Listener.class); 
            });

            interceptor.interceptCall(call, headers, handler); 

            assertThat(subjectRef.get()).isEqualTo("user-1");
            assertThat(tenantRef.get()).isEqualTo("tenant-42");
            verify(call, never()).close(any(), any()); 
        }

        @SuppressWarnings("unchecked")
        @Test
        @DisplayName("validated JWT without tenant claim is rejected")
        void validatedJwtWithoutTenantClaimIsRejected() throws Exception { 
            ConfigurableJWTProcessor<SecurityContext> processor = mock(ConfigurableJWTProcessor.class); 
            when(processor.process(any(SignedJWT.class), eq(null))).thenReturn(null); 

            JwtServerInterceptor interceptor = new JwtServerInterceptor( 
                    processor,
                    disabledTokenValidator() 
            );

            Metadata headers = new Metadata(); 
            headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER), 
                    "Bearer " + signedToken("user-1", null)); 

            ServerCall<Object, Object> call = mockCall(SECURE_METHOD); 
            ServerCallHandler<Object, Object> handler = mock(ServerCallHandler.class); 

            interceptor.interceptCall(call, headers, handler); 

            ArgumentCaptor<Status> statusCaptor = ArgumentCaptor.forClass(Status.class); 
            verify(call).close(statusCaptor.capture(), any()); 
            assertThat(statusCaptor.getValue().getCode()).isEqualTo(Status.Code.UNAUTHENTICATED); 
            assertThat(statusCaptor.getValue().getDescription()).contains("Missing tenant claim");
            verify(handler, never()).startCall(any(), any()); 
        }
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    private static <ReqT, RespT> ServerCall<ReqT, RespT> mockCall(String fullMethod) { 
        ServerCall<ReqT, RespT> call = mock(ServerCall.class); 
        MethodDescriptor<ReqT, RespT> descriptor = MethodDescriptor.<ReqT, RespT>newBuilder() 
                .setType(MethodDescriptor.MethodType.UNARY) 
                .setFullMethodName(fullMethod) 
                .setRequestMarshaller(new PassThroughMarshaller<>()) 
                .setResponseMarshaller(new PassThroughMarshaller<>()) 
                .build(); 
        when(call.getMethodDescriptor()).thenReturn(descriptor); 
        return call;
    }

    private JwtServerInterceptor.TokenValidator disabledTokenValidator() { 
        return new JwtServerInterceptor.TokenValidator() { 
            @Override
            public boolean isEnabled() { 
                return false;
            }

            @Override
            public com.ghatana.audio.video.common.platform.AuthGatewayClient.ValidationResult validate(String token, String tenantId) {
                return new com.ghatana.audio.video.common.platform.AuthGatewayClient.ValidationResult(false, null, null, null);
            }
        };
    }

    private String signedToken(String subject, String tenantId) throws JOSEException { 
        JWTClaimsSet.Builder claims = new JWTClaimsSet.Builder() 
                .subject(subject) 
                .expirationTime(Date.from(Instant.now().plusSeconds(300))); 
        if (tenantId != null) { 
            claims.claim("tenantId", tenantId); 
        }

        SignedJWT jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), claims.build()); 
        jwt.sign(new MACSigner("01234567890123456789012345678901".getBytes(StandardCharsets.UTF_8))); 
        return jwt.serialize(); 
    }

    /** Trivial marshaller for test purposes. */
    private static class PassThroughMarshaller<T> implements MethodDescriptor.Marshaller<T> {
        @Override
        public InputStream stream(T value) { 
            return new ByteArrayInputStream(new byte[0]); 
        }

        @Override
        @SuppressWarnings("unchecked")
        public T parse(InputStream stream) { 
            return (T) new Object(); 
        }
    }
}
