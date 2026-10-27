package com.ghatana.audio.video.common.security;

import com.ghatana.audio.video.common.observability.TracingServerInterceptor;
import com.ghatana.audio.video.common.security.AuditEventSink.AuditRecord;
import com.ghatana.security.tenant.TenantGrpcInterceptor;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.nimbusds.jwt.proc.ConfigurableJWTProcessor;
import io.grpc.Context;
import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.Status;
import org.apache.logging.log4j.Level;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.LoggerContext;
import org.apache.logging.log4j.core.appender.AbstractAppender;
import org.apache.logging.log4j.core.config.Property;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class AudioVideoSecurityLogRedactionTest {
    private static final String METHOD = "stt.v1.STTService/Transcribe";

    @Test
    void jwtApplicationLogsOmitSubjectAndTenantWhileRequestContextStillPropagates() throws Exception {
        String subject = "subject-secret-marker";
        String tenant = "tenant-secret-marker";
        ConfigurableJWTProcessor<SecurityContext> processor = mock(ConfigurableJWTProcessor.class);
        when(processor.process(any(SignedJWT.class), eq(null))).thenReturn(null);
        JwtServerInterceptor interceptor = new JwtServerInterceptor(processor, new JwtServerInterceptor.TokenValidator() {
            @Override public boolean isEnabled() { return false; }
            @Override public com.ghatana.audio.video.common.platform.AuthGatewayClient.ValidationResult
                    validate(String token, String tenantId) {
                throw new AssertionError("disabled token validator must not be called");
            }
        });
        ServerCall<Object, Object> call = mockCall(METHOD);
        @SuppressWarnings("unchecked")
        ServerCallHandler<Object, Object> handler = mock(ServerCallHandler.class);
        when(handler.startCall(any(), any())).thenReturn(mock(ServerCall.Listener.class));
        Metadata headers = new Metadata();
        headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER),
                "Bearer " + signedToken(subject, tenant));

        try (LogCapture logs = capture(JwtServerInterceptor.class)) {
            interceptor.interceptCall(call, headers, handler);

            String output = logs.output();
            assertThat(output).contains("Authenticated request").doesNotContain(subject, tenant);
        }
    }

    @Test
    void rbacApplicationLogsOmitIdentityAndRoleWhileSecurityAuditRetainsThem() throws Exception {
        String principal = "principal-secret-marker";
        String jwtTenant = "jwt-tenant-secret-marker";
        String metadataTenant = "header-tenant-secret-marker";
        String roles = "role-secret-marker";
        ArrayBlockingQueue<AuditRecord> auditRecords = new ArrayBlockingQueue<>(1);
        AudioVideoRequestContextInterceptor interceptor = new AudioVideoRequestContextInterceptor(
                AuditEventSink.withConsumer(auditRecords::offer));
        ServerCall<Object, Object> call = mockCall(METHOD);
        @SuppressWarnings("unchecked")
        ServerCallHandler<Object, Object> handler = mock(ServerCallHandler.class);
        Metadata headers = new Metadata();
        headers.put(Metadata.Key.of("x-roles", Metadata.ASCII_STRING_MARSHALLER), roles);
        Context context = Context.current()
                .withValue(JwtServerInterceptor.CTX_SUBJECT, principal)
                .withValue(JwtServerInterceptor.CTX_TENANT, jwtTenant)
                .withValue(TenantGrpcInterceptor.TENANT_ID_CTX_KEY, metadataTenant);

        try (LogCapture logs = capture(AudioVideoRequestContextInterceptor.class)) {
            context.run(() -> interceptor.interceptCall(call, headers, handler));

            String output = logs.output();
            assertThat(output).contains("Rejected cross-tenant request").doesNotContain(
                    principal, jwtTenant, metadataTenant, roles);
            AuditRecord record = auditRecords.poll(2, TimeUnit.SECONDS);
            assertThat(record).isNotNull();
            assertThat(record.tenantId()).isEqualTo(jwtTenant);
            assertThat(record.principal()).isEqualTo(principal);
            assertThat(record.roles()).isEqualTo(roles);
        }
    }

    @Test
    void tracingApplicationLogOmitsRawStatusDescriptionButKeepsCodeAndCategory() {
        String marker = "tenant-model-token-secret-marker";
        TracingServerInterceptor interceptor = new TracingServerInterceptor();
        ServerCall<Object, Object> originalCall = mockCall(METHOD);
        @SuppressWarnings("unchecked")
        ServerCallHandler<Object, Object> handler = mock(ServerCallHandler.class);
        AtomicReference<ServerCall<Object, Object>> wrappedCall = new AtomicReference<>();
        when(handler.startCall(any(), any())).thenAnswer(invocation -> {
            wrappedCall.set(invocation.getArgument(0));
            return mock(ServerCall.Listener.class);
        });

        try (LogCapture logs = capture(TracingServerInterceptor.class)) {
            interceptor.interceptCall(originalCall, new Metadata(), handler);
            wrappedCall.get().close(Status.INTERNAL.withDescription(marker), new Metadata());

            String output = logs.output();
            assertThat(output).contains("status=INTERNAL", "errorCategory=none").doesNotContain(marker);
        }
    }

    @Test
    void tracingApplicationLogUsesCauseTypeAsCategoryWithoutLoggingCauseMessage() {
        String description = "tenant-model-token-description-marker";
        String causeMessage = "private-cause-message-marker";
        TracingServerInterceptor interceptor = new TracingServerInterceptor();
        ServerCall<Object, Object> originalCall = mockCall(METHOD);
        @SuppressWarnings("unchecked")
        ServerCallHandler<Object, Object> handler = mock(ServerCallHandler.class);
        AtomicReference<ServerCall<Object, Object>> wrappedCall = new AtomicReference<>();
        when(handler.startCall(any(), any())).thenAnswer(invocation -> {
            wrappedCall.set(invocation.getArgument(0));
            return mock(ServerCall.Listener.class);
        });

        try (LogCapture logs = capture(TracingServerInterceptor.class)) {
            interceptor.interceptCall(originalCall, new Metadata(), handler);
            wrappedCall.get().close(Status.INTERNAL.withDescription(description)
                    .withCause(new IllegalArgumentException(causeMessage)), new Metadata());

            String output = logs.output();
            assertThat(output).contains("status=INTERNAL", "errorCategory=IllegalArgumentException")
                    .doesNotContain(description, causeMessage);
        }
    }

    private static String signedToken(String subject, String tenant) throws Exception {
        JWTClaimsSet claims = new JWTClaimsSet.Builder()
                .subject(subject)
                .claim("tenantId", tenant)
                .expirationTime(Date.from(Instant.now().plusSeconds(60)))
                .build();
        SignedJWT token = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), claims);
        token.sign(new MACSigner("unit-test-signing-key-not-for-production-1234"));
        return token.serialize();
    }

    @SuppressWarnings("unchecked")
    private static ServerCall<Object, Object> mockCall(String fullMethod) {
        ServerCall<Object, Object> call = mock(ServerCall.class);
        MethodDescriptor<Object, Object> descriptor = mock(MethodDescriptor.class);
        when(descriptor.getFullMethodName()).thenReturn(fullMethod);
        when(call.getMethodDescriptor()).thenReturn(descriptor);
        return call;
    }

    private static LogCapture capture(Class<?> loggerClass) {
        LoggerContext context = (LoggerContext) org.apache.logging.log4j.LogManager.getContext(false);
        org.apache.logging.log4j.core.Logger logger = context.getLogger(loggerClass.getName());
        LogCapture appender = new LogCapture(
                "redaction-test-" + loggerClass.getSimpleName(), logger, logger.getLevel());
        appender.start();
        logger.addAppender(appender);
        logger.setLevel(Level.DEBUG);
        return appender;
    }

    private static final class LogCapture extends AbstractAppender implements AutoCloseable {
        private final List<String> messages = new ArrayList<>();
        private final org.apache.logging.log4j.core.Logger logger;
        private final Level previousLevel;

        LogCapture(String name, org.apache.logging.log4j.core.Logger logger, Level previousLevel) {
            super(name, null, null, true, Property.EMPTY_ARRAY);
            this.logger = logger;
            this.previousLevel = previousLevel;
        }

        @Override public void append(LogEvent event) {
            messages.add(event.getMessage().getFormattedMessage());
        }

        String output() {
            return String.join("\n", messages);
        }

        @Override public void close() {
            logger.removeAppender(this);
            logger.setLevel(previousLevel);
            stop();
        }
    }
}
