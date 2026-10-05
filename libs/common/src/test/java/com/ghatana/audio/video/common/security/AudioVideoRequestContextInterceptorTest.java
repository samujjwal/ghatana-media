package com.ghatana.audio.video.common.security;

import com.ghatana.audio.video.common.security.AuditEventSink.AuditRecord;
import com.ghatana.audio.video.common.security.AuditEventSink.AuditRecord.Outcome;
import io.grpc.Context;
import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.Status;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Unit tests for {@link AudioVideoRequestContextInterceptor}.
 *
 * <p>Uses a {@link LinkedBlockingQueue} to collect audit records so that tests
 * are not racy against the sink's background drain thread.
 *
 * @doc.type class
 * @doc.purpose Unit tests for the audio-video RBAC/audit gRPC interceptor
 * @doc.layer product
 * @doc.pattern TestCase
 */
@ExtendWith(MockitoExtension.class)
@DisplayName("AudioVideoRequestContextInterceptor")
class AudioVideoRequestContextInterceptorTest {

    private static final String TRANSCRIBE_METHOD = "stt.v1.STTService/Transcribe";
    private static final String HEALTH_METHOD = "/grpc.health.v1.Health/Check";

    private LinkedBlockingQueue<AuditRecord> emittedQueue;
    private AudioVideoRequestContextInterceptor interceptor;

    @BeforeEach
    void setUp() {
        emittedQueue = new LinkedBlockingQueue<>();
        AuditEventSink sink = AuditEventSink.withConsumer(emittedQueue::add);
        interceptor = new AudioVideoRequestContextInterceptor(sink);
    }

    /** Blocks up to 2 s for the next audit record from the background drain thread. */
    private AuditRecord awaitRecord() throws InterruptedException {
        AuditRecord record = emittedQueue.poll(2, TimeUnit.SECONDS);
        assertThat(record).as("Expected an audit record to be emitted within 2 s").isNotNull();
        return record;
    }

    // Ã¢â€â‚¬Ã¢â€â‚¬ Missing tenant Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

    @Nested
    @DisplayName("missing tenant")
    class MissingTenant {

        @Test
        @DisplayName("rejects with INVALID_ARGUMENT when both JWT and metadata tenant are absent")
        void rejectsWhenBothTenantsAbsent() throws InterruptedException {
            ServerCall<Object, Object> call = mockCall(TRANSCRIBE_METHOD);
            Metadata headers = rolesHeader("av:user");
            ServerCallHandler<Object, Object> handler = mockHandler();

            interceptor.interceptCall(call, headers, handler);

            ArgumentCaptor<Status> status = ArgumentCaptor.forClass(Status.class);
            verify(call).close(status.capture(), any());
            assertThat(status.getValue().getCode()).isEqualTo(Status.Code.INVALID_ARGUMENT);
            verify(handler, never()).startCall(any(), any());

            AuditRecord record = awaitRecord();
            assertThat(record.outcome()).isEqualTo(Outcome.DENIED_MISSING_TENANT);
        }
    }

    // Ã¢â€â‚¬Ã¢â€â‚¬ Cross-tenant mismatch Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

    @Nested
    @DisplayName("cross-tenant mismatch")
    class CrossTenantMismatch {

        @Test
        @DisplayName("rejects when JWT tenant differs from x-tenant-id metadata")
        void rejectsOnTenantMismatch() throws InterruptedException {
            ServerCall<Object, Object> call = mockCall(TRANSCRIBE_METHOD);
            Metadata headers = rolesHeader("av:user");
            ServerCallHandler<Object, Object> handler = mockHandler();

            // JWT context Ã¢â€ â€™ tenant-A; TenantGrpcInterceptor context Ã¢â€ â€™ tenant-B
            Context outerCtx = Context.current()
                .withValue(JwtServerInterceptor.CTX_SUBJECT, "user-1")
                .withValue(JwtServerInterceptor.CTX_TENANT, "tenant-A");

            outerCtx.run(() -> {
                Context innerCtx = Context.current()
                    .withValue(
                        com.ghatana.security.tenant.TenantGrpcInterceptor.TENANT_ID_CTX_KEY,
                        "tenant-B");
                innerCtx.run(() -> interceptor.interceptCall(call, headers, handler));
            });

            ArgumentCaptor<Status> status = ArgumentCaptor.forClass(Status.class);
            verify(call).close(status.capture(), any());
            assertThat(status.getValue().getCode()).isEqualTo(Status.Code.PERMISSION_DENIED);
            assertThat(status.getValue().getDescription()).contains("Cross-tenant");
            verify(handler, never()).startCall(any(), any());

            AuditRecord record = awaitRecord();
            assertThat(record.outcome()).isEqualTo(Outcome.DENIED_CROSS_TENANT);
        }
    }

    // Ã¢â€â‚¬Ã¢â€â‚¬ Missing principal (unauthenticated) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

    @Nested
    @DisplayName("missing principal")
    class MissingPrincipal {

        @Test
        @DisplayName("rejects with UNAUTHENTICATED when subject is absent from context")
        void rejectsWhenSubjectAbsent() throws InterruptedException {
            ServerCall<Object, Object> call = mockCall(TRANSCRIBE_METHOD);
            Metadata headers = rolesHeader("av:user");

            Context ctx = Context.current()
                .withValue(JwtServerInterceptor.CTX_TENANT, "tenant-X");

            ServerCallHandler<Object, Object> handler = mockHandler();
            ctx.run(() -> interceptor.interceptCall(call, headers, handler));

            ArgumentCaptor<Status> status = ArgumentCaptor.forClass(Status.class);
            verify(call).close(status.capture(), any());
            assertThat(status.getValue().getCode()).isEqualTo(Status.Code.UNAUTHENTICATED);
            verify(handler, never()).startCall(any(), any());

            AuditRecord record = awaitRecord();
            assertThat(record.outcome()).isEqualTo(Outcome.DENIED_UNAUTHENTICATED);
        }
    }

    // Ã¢â€â‚¬Ã¢â€â‚¬ Insufficient role Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

    @Nested
    @DisplayName("insufficient role")
    class InsufficientRole {

        @Test
        @DisplayName("rejects PERMISSION_DENIED when caller has no matching role")
        void rejectsWhenRoleInsufficient() throws InterruptedException {
            ServerCall<Object, Object> call = mockCall(TRANSCRIBE_METHOD);
            Metadata headers = rolesHeader("av:readonly");

            Context ctx = Context.current()
                .withValue(JwtServerInterceptor.CTX_SUBJECT, "user-2")
                .withValue(JwtServerInterceptor.CTX_TENANT, "tenant-Y");

            ServerCallHandler<Object, Object> handler = mockHandler();
            ctx.run(() -> interceptor.interceptCall(call, headers, handler));

            ArgumentCaptor<Status> status = ArgumentCaptor.forClass(Status.class);
            verify(call).close(status.capture(), any());
            assertThat(status.getValue().getCode()).isEqualTo(Status.Code.PERMISSION_DENIED);
            assertThat(status.getValue().getDescription()).contains("Insufficient role");
            verify(handler, never()).startCall(any(), any());

            AuditRecord record = awaitRecord();
            assertThat(record.outcome()).isEqualTo(Outcome.DENIED_INSUFFICIENT_ROLE);
        }

        @Test
        @DisplayName("rejects loadModel for av:user role (requires av:admin)")
        void rejectsLoadModelForUserRole() throws InterruptedException {
            ServerCall<Object, Object> call = mockCall("stt.v1.STTService/LoadModel");
            Metadata headers = rolesHeader("av:user");

            Context ctx = Context.current()
                .withValue(JwtServerInterceptor.CTX_SUBJECT, "user-3")
                .withValue(JwtServerInterceptor.CTX_TENANT, "tenant-Z");

            ServerCallHandler<Object, Object> handler = mockHandler();
            ctx.run(() -> interceptor.interceptCall(call, headers, handler));

            ArgumentCaptor<Status> status = ArgumentCaptor.forClass(Status.class);
            verify(call).close(status.capture(), any());
            assertThat(status.getValue().getCode()).isEqualTo(Status.Code.PERMISSION_DENIED);

            AuditRecord record = awaitRecord();
            assertThat(record.outcome()).isEqualTo(Outcome.DENIED_INSUFFICIENT_ROLE);
        }
    }

    // Ã¢â€â‚¬Ã¢â€â‚¬ Allowed Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

    @Nested
    @DisplayName("allowed calls")
    class AllowedCalls {

        @Test
        @DisplayName("proceeds to handler when tenant, principal, and role are valid")
        @SuppressWarnings("unchecked")
        void proceedsWhenValid() throws InterruptedException {
            ServerCall<Object, Object> call = mockCall(TRANSCRIBE_METHOD);
            Metadata headers = rolesHeader("av:user");
            ServerCallHandler<Object, Object> handler = mockHandler();
            when(handler.startCall(any(), any())).thenReturn(mock(ServerCall.Listener.class));

            Context ctx = Context.current()
                .withValue(JwtServerInterceptor.CTX_SUBJECT, "user-good")
                .withValue(JwtServerInterceptor.CTX_TENANT, "tenant-good");

            ctx.run(() -> interceptor.interceptCall(call, headers, handler));

            verify(call, never()).close(any(), any());
            verify(handler).startCall(any(), any());

            AuditRecord record = awaitRecord();
            assertThat(record.outcome()).isEqualTo(Outcome.ALLOWED);
            assertThat(record.tenantId()).isEqualTo("tenant-good");
            assertThat(record.principal()).isEqualTo("user-good");
        }

        @Test
        @DisplayName("allows av:admin to call loadModel")
        @SuppressWarnings("unchecked")
        void adminCanCallLoadModel() throws InterruptedException {
            ServerCall<Object, Object> call = mockCall("stt.v1.STTService/LoadModel");
            Metadata headers = rolesHeader("av:admin");
            ServerCallHandler<Object, Object> handler = mockHandler();
            when(handler.startCall(any(), any())).thenReturn(mock(ServerCall.Listener.class));

            Context ctx = Context.current()
                .withValue(JwtServerInterceptor.CTX_SUBJECT, "admin-1")
                .withValue(JwtServerInterceptor.CTX_TENANT, "tenant-admin");

            ctx.run(() -> interceptor.interceptCall(call, headers, handler));

            verify(call, never()).close(any(), any());
            verify(handler).startCall(any(), any());

            AuditRecord record = awaitRecord();
            assertThat(record.outcome()).isEqualTo(Outcome.ALLOWED);
        }
    }

    // Ã¢â€â‚¬Ã¢â€â‚¬ Health check exempt Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

    @Nested
    @DisplayName("health check exemption")
    class HealthCheckExemption {

        @Test
        @DisplayName("health check bypasses all RBAC and tenant checks")
        @SuppressWarnings("unchecked")
        void healthCheckIsExempt() throws InterruptedException {
            ServerCall<Object, Object> call = mockCall(HEALTH_METHOD);
            Metadata headers = new Metadata();
            ServerCallHandler<Object, Object> handler = mockHandler();
            when(handler.startCall(any(), any())).thenReturn(mock(ServerCall.Listener.class));

            interceptor.interceptCall(call, headers, handler);

            verify(call, never()).close(any(), any());
            verify(handler).startCall(any(), any());
            // No audit events emitted for exempt methods Ã¢â‚¬â€ wait briefly to confirm none arrive
            assertThat(emittedQueue.poll(300, TimeUnit.MILLISECONDS))
                .as("No audit record expected for health check").isNull();
        }
    }

    // Ã¢â€â‚¬Ã¢â€â‚¬ Audit record fields Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

    @Nested
    @DisplayName("audit record contents")
    class AuditRecordContents {

        @Test
        @DisplayName("allowed record carries correct tenant, principal, method, and roles")
        @SuppressWarnings("unchecked")
        void allowedRecordHasCorrectFields() throws InterruptedException {
            ServerCall<Object, Object> call = mockCall(TRANSCRIBE_METHOD);
            Metadata headers = rolesHeader("av:user");
            ServerCallHandler<Object, Object> handler = mockHandler();
            when(handler.startCall(any(), any())).thenReturn(mock(ServerCall.Listener.class));

            Context ctx = Context.current()
                .withValue(JwtServerInterceptor.CTX_SUBJECT, "alice")
                .withValue(JwtServerInterceptor.CTX_TENANT, "acme");

            ctx.run(() -> interceptor.interceptCall(call, headers, handler));

            AuditRecord record = awaitRecord();
            assertThat(record.tenantId()).isEqualTo("acme");
            assertThat(record.principal()).isEqualTo("alice");
            assertThat(record.roles()).contains("av:user");
            assertThat(record.grpcMethod()).isEqualTo(TRANSCRIBE_METHOD);
            assertThat(record.outcome()).isEqualTo(Outcome.ALLOWED);
            assertThat(record.reason()).isBlank();
        }
    }

    // Ã¢â€â‚¬Ã¢â€â‚¬ Helpers Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

    @SuppressWarnings("unchecked")
    private static <ReqT, RespT> ServerCall<ReqT, RespT> mockCall(String fullMethod) {
        ServerCall<ReqT, RespT> call = mock(ServerCall.class);
        MethodDescriptor<ReqT, RespT> descriptor = MethodDescriptor.<ReqT, RespT>newBuilder()
            .setType(MethodDescriptor.MethodType.UNARY)
            .setFullMethodName(fullMethod)
            .setRequestMarshaller(mock(MethodDescriptor.Marshaller.class))
            .setResponseMarshaller(mock(MethodDescriptor.Marshaller.class))
            .build();
        when(call.getMethodDescriptor()).thenReturn(descriptor);
        return call;
    }

    @SuppressWarnings("unchecked")
    private static <ReqT, RespT> ServerCallHandler<ReqT, RespT> mockHandler() {
        return mock(ServerCallHandler.class);
    }

    private static Metadata rolesHeader(String roles) {
        Metadata headers = new Metadata();
        headers.put(Metadata.Key.of("x-roles", Metadata.ASCII_STRING_MARSHALLER), roles);
        return headers;
    }
}

