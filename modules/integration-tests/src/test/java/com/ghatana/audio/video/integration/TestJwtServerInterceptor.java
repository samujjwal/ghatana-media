package com.ghatana.audio.video.integration;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.jwk.source.ImmutableSecret;
import com.nimbusds.jose.proc.JWSVerificationKeySelector;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.nimbusds.jwt.proc.ConfigurableJWTProcessor;
import com.nimbusds.jwt.proc.DefaultJWTClaimsVerifier;
import com.nimbusds.jwt.proc.DefaultJWTProcessor;
import io.grpc.Context;
import io.grpc.Contexts;
import io.grpc.Metadata;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;
import io.grpc.Status;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Test-only JWT interceptor that uses a fixed secret for testing.
 * Bypasses AuthGatewayClient to ensure predictable test behavior.
 * Uses the same context keys as JwtServerInterceptor for compatibility.
 */
public class TestJwtServerInterceptor implements ServerInterceptor {
    private static final Logger LOG = LoggerFactory.getLogger(TestJwtServerInterceptor.class);
    private static final String TEST_SECRET = "test-secret-key-for-integration-tests";

    private static final Metadata.Key<String> AUTHORIZATION_KEY =
            Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER);

    private static final Set<String> EXEMPT_METHODS = new HashSet<>(Arrays.asList(
            "/grpc.health.v1.Health/Check",
            "/grpc.health.v1.Health/Watch"
    ));

    private final ConfigurableJWTProcessor<SecurityContext> jwtProcessor;

    public TestJwtServerInterceptor() {
        SecretKey key = new SecretKeySpec(TEST_SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256");
        ConfigurableJWTProcessor<SecurityContext> processor = new DefaultJWTProcessor<>();
        processor.setJWSKeySelector(
                new JWSVerificationKeySelector<>(
                        JWSAlgorithm.HS256,
                        new ImmutableSecret<>(key)));
        processor.setJWTClaimsSetVerifier(new DefaultJWTClaimsVerifier<>(
                new JWTClaimsSet.Builder().build(),
                new HashSet<>(Arrays.asList("sub", "exp"))));
        this.jwtProcessor = processor;
        LOG.info("Test JWT interceptor initialised with fixed secret");
    }

    @Override
    public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
            ServerCall<ReqT, RespT> call,
            Metadata headers,
            ServerCallHandler<ReqT, RespT> next) {

        String fullMethod = call.getMethodDescriptor().getFullMethodName();

        if (EXEMPT_METHODS.contains(fullMethod)) {
            return next.startCall(call, headers);
        }

        String authHeader = headers.get(AUTHORIZATION_KEY);
        if (authHeader == null || !authHeader.startsWith("Bearer ")) {
            LOG.warn("Missing or malformed Authorization header on {}", fullMethod);
            call.close(Status.UNAUTHENTICATED.withDescription("Missing Bearer token"), new Metadata());
            return new ServerCall.Listener<>() {};
        }

        String token = authHeader.substring(7);
        SignedJWT jwt;
        try {
            jwt = SignedJWT.parse(token);
        } catch (Exception e) {
            LOG.warn("JWT parsing failed on {}: {}", fullMethod, e.getMessage());
            call.close(Status.UNAUTHENTICATED.withDescription("Invalid token: " + e.getMessage()),
                    new Metadata());
            return new ServerCall.Listener<>() {};
        }

        try {
            jwtProcessor.process(jwt, null);

            String subject = jwt.getJWTClaimsSet().getSubject();
            String tenantId = extractTenantId(jwt);
            if (tenantId == null || tenantId.isBlank()) {
                LOG.warn("JWT missing tenantId claim on {}", fullMethod);
                call.close(Status.UNAUTHENTICATED.withDescription("Missing tenant claim"), new Metadata());
                return new ServerCall.Listener<>() {};
            }
            // Use the same context keys as JwtServerInterceptor for compatibility
            Context ctx = Context.current()
                    .withValue(JwtServerInterceptor.CTX_SUBJECT, subject != null ? subject : "unknown")
                    .withValue(JwtServerInterceptor.CTX_TENANT, tenantId);
            LOG.debug("Test JWT authenticated subject='{}' tenant='{}' on {}", subject, tenantId, fullMethod);
            return Contexts.interceptCall(ctx, call, headers, next);

        } catch (Exception e) {
            LOG.warn("Test JWT validation failed on {}: {}", fullMethod, e.getMessage());
            call.close(Status.UNAUTHENTICATED.withDescription("Invalid token: " + e.getMessage()),
                    new Metadata());
            return new ServerCall.Listener<>() {};
        }
    }

    private String extractTenantId(SignedJWT jwt) {
        try {
            return jwt.getJWTClaimsSet().getStringClaim("tenantId");
        } catch (Exception e) {
            return null;
        }
    }
}
