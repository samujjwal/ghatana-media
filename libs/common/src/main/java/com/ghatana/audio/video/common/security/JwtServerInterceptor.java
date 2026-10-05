package com.ghatana.audio.video.common.security;

import com.ghatana.audio.video.common.platform.AuthGatewayClient;
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
import java.util.Objects;
import java.util.Set;

/**
 * gRPC server interceptor that validates Bearer JWT tokens on every inbound call.
 *
 * <p>The JWT secret is read from the environment variable {@code AV_JWT_SECRET}.
 * If the variable is absent the interceptor throws {@link IllegalStateException}
 * at construction time to prevent silent permissive-mode startup in production.
 *
 * <p>Validated subject is stored in {@link #CTX_SUBJECT} so downstream handlers can
 * retrieve the authenticated principal:
 * <pre>{@code
 *   String user = JwtServerInterceptor.CTX_SUBJECT.get();
 *   String tenant = JwtServerInterceptor.CTX_TENANT.get();
 * }</pre>
  * @doc.type interface
 * @doc.purpose Provides jwt server interceptor functionality.
 * @doc.layer product
 * @doc.pattern Filter
*/
public class JwtServerInterceptor implements ServerInterceptor {

    private static final Logger LOG = LoggerFactory.getLogger(JwtServerInterceptor.class);

    /** gRPC {@link Context} key carrying the validated JWT subject. */
    public static final Context.Key<String> CTX_SUBJECT = Context.key("av.jwt.subject");
    /** gRPC {@link Context} key carrying the validated tenant ID. */
    public static final Context.Key<String> CTX_TENANT = Context.key("av.jwt.tenant");

    private static final Metadata.Key<String> AUTHORIZATION_KEY =
            Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER);

    /** Methods exempted from auth (e.g. health-checks). */
    private static final Set<String> EXEMPT_METHODS = new HashSet<>(Arrays.asList(
            "/grpc.health.v1.Health/Check",
            "/grpc.health.v1.Health/Watch"
    ));

    private final ConfigurableJWTProcessor<SecurityContext> jwtProcessor;
    private final TokenValidator tokenValidator;

    public JwtServerInterceptor() {
        this.tokenValidator = fromAuthGatewayClient(AuthGatewayClient.getInstance());
        String secret = System.getenv("AV_JWT_SECRET");
        // Fallback to System.getProperty for testing purposes
        if (secret == null || secret.isBlank()) {
            secret = System.getProperty("AV_JWT_SECRET");
        }
        if (secret == null || secret.isBlank()) {
            throw new IllegalStateException(
                    "AV_JWT_SECRET is not set. The Audio-Video JWT interceptor requires a " +
                    "signing secret and does not support permissive bypass mode.");
        } else {
            SecretKey key = new SecretKeySpec(
                    secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256");
            ConfigurableJWTProcessor<SecurityContext> processor = new DefaultJWTProcessor<>();
            processor.setJWSKeySelector(
                    new JWSVerificationKeySelector<>(
                            JWSAlgorithm.HS256,
                            new ImmutableSecret<>(key)));
            processor.setJWTClaimsSetVerifier(new DefaultJWTClaimsVerifier<>(
                    new JWTClaimsSet.Builder().build(),
                    new HashSet<>(Arrays.asList("sub", "exp"))));
            this.jwtProcessor = processor;
            LOG.info("JWT interceptor initialised (HMAC-SHA256, strict mode)");
        }
    }

    JwtServerInterceptor(
            ConfigurableJWTProcessor<SecurityContext> jwtProcessor,
            TokenValidator tokenValidator
    ) {
        this.jwtProcessor = jwtProcessor;
        this.tokenValidator = Objects.requireNonNull(tokenValidator, "tokenValidator must not be null");
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
            // Validate signature and standard claims
            jwtProcessor.process(jwt, null);

            String subject = jwt.getJWTClaimsSet().getSubject();
            String tenantId = extractTenantId(jwt);
            if (tenantId == null || tenantId.isBlank()) {
                LOG.warn("JWT missing tenantId claim on {}", fullMethod);
                call.close(Status.UNAUTHENTICATED.withDescription("Missing tenant claim"), new Metadata());
                return new ServerCall.Listener<>() {};
            }
            Context ctx = Context.current()
                    .withValue(CTX_SUBJECT, subject != null ? subject : "unknown")
                    .withValue(CTX_TENANT, tenantId);
            LOG.debug("Authenticated subject='{}' tenant='{}' on {}", subject, tenantId, fullMethod);
            return Contexts.interceptCall(ctx, call, headers, next);

        } catch (Exception e) {
            // Local JWT validation failed — attempt platform auth-gateway fallback
            // for cross-service tokens issued by the central auth-service.
            if (tokenValidator.isEnabled()) {
                String tenantId = extractTenantId(jwt);
                if (tenantId == null || tenantId.isBlank()) {
                    LOG.warn("Auth-gateway validation cannot proceed because tenantId claim is missing on {}", fullMethod);
                    call.close(Status.UNAUTHENTICATED.withDescription("Missing tenant claim"), new Metadata());
                    return new ServerCall.Listener<>() {};
                }
                AuthGatewayClient.ValidationResult gwResult = tokenValidator.validate(token, tenantId);
                if (gwResult.valid()) {
                    if (!tenantId.equals(gwResult.tenantId())) {
                        LOG.warn("Auth-gateway returned a tenant mismatch on {}", fullMethod);
                        call.close(Status.UNAUTHENTICATED.withDescription("Tenant mismatch"), new Metadata());
                        return new ServerCall.Listener<>() {};
                    }
                    if (gwResult.tenantId() == null || gwResult.tenantId().isBlank()) {
                        LOG.warn("Auth-gateway accepted token but returned no tenantId on {}", fullMethod);
                        call.close(Status.UNAUTHENTICATED.withDescription("Missing tenant claim"), new Metadata());
                        return new ServerCall.Listener<>() {};
                    }
                    String subject = gwResult.userId() != null ? gwResult.userId() : "platform";
                    LOG.debug("Platform auth-gateway accepted token, subject='{}', tenant='{}'", subject, tenantId);
                    Context ctx = Context.current()
                            .withValue(CTX_SUBJECT, subject)
                            .withValue(CTX_TENANT, tenantId);
                    return Contexts.interceptCall(ctx, call, headers, next);
                }
            }

            LOG.warn("JWT validation failed on {}: {}", fullMethod, e.getMessage());
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

    private static TokenValidator fromAuthGatewayClient(AuthGatewayClient client) {
        return new TokenValidator() {
            @Override
            public boolean isEnabled() {
                return client.isEnabled();
            }

            @Override
            public AuthGatewayClient.ValidationResult validate(String token, String tenantId) {
                return client.validate(token, tenantId);
            }
        };
    }

    interface TokenValidator {
        boolean isEnabled();

        AuthGatewayClient.ValidationResult validate(String token, String tenantId);
    }
}
