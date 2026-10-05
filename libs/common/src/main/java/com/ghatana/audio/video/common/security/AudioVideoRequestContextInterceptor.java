package com.ghatana.audio.video.common.security;

import com.ghatana.audio.video.common.security.AuditEventSink.AuditRecord;
import com.ghatana.audio.video.common.security.AuditEventSink.AuditRecord.Outcome;
import com.ghatana.security.tenant.TenantGrpcInterceptor;
import io.grpc.Context;
import io.grpc.Metadata;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;
import io.grpc.Status;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Objects;
import java.util.Set;

/**
 * Production-grade gRPC server interceptor for audio-video services.
 *
 * <p>This interceptor is the single enforcement point for all requests to audio-video
 * gRPC services. It runs <em>after</em> {@link JwtServerInterceptor} (which validates
 * the token and populates {@link JwtServerInterceptor#CTX_SUBJECT} /
 * {@link JwtServerInterceptor#CTX_TENANT}) and after
 * {@link TenantGrpcInterceptor} (which populates the tenant context).
 *
 * <h3>What it enforces</h3>
 * <ol>
 *   <li><b>Tenant presence</b> — rejects calls without a tenant ID (INVALID_ARGUMENT).</li>
 *   <li><b>RBAC</b> — checks caller's roles against {@link AudioVideoMethodRbacRegistry};
 *       rejects insufficient role with PERMISSION_DENIED.</li>
 *   <li><b>Cross-tenant guard</b> — if the JWT tenant and metadata tenant differ the call
 *       is rejected with PERMISSION_DENIED.</li>
 *   <li><b>Audit</b> — every call decision is emitted to {@link AuditEventSink}.</li>
 *   <li><b>Correlation ID</b> — reads {@code x-correlation-id} from metadata and places it
 *       in the SLF4J MDC for the duration of the call.</li>
 * </ol>
 *
 * <h3>Placement in the chain</h3>
 * The interceptor must be placed <em>inside</em> (applied after) the JWT interceptor so
 * that the auth context keys are already populated when this interceptor runs.
 *
 * @doc.type class
 * @doc.purpose Unified RBAC, tenant, and audit enforcement for audio-video gRPC services
 * @doc.layer product
 * @doc.pattern Filter
 */
public final class AudioVideoRequestContextInterceptor implements ServerInterceptor {

    private static final Logger LOG = LoggerFactory.getLogger(AudioVideoRequestContextInterceptor.class);

    private static final Metadata.Key<String> CORRELATION_ID_KEY =
        Metadata.Key.of("x-correlation-id", Metadata.ASCII_STRING_MARSHALLER);
    private static final Metadata.Key<String> ROLES_KEY =
        Metadata.Key.of("x-roles", Metadata.ASCII_STRING_MARSHALLER);

    private final AuditEventSink auditSink;

    /**
     * Constructs the interceptor with an explicit {@link AuditEventSink}.
     *
     * @param auditSink non-null sink that receives one {@link AuditRecord} per call
     */
    public AudioVideoRequestContextInterceptor(AuditEventSink auditSink) {
        this.auditSink = Objects.requireNonNull(auditSink, "auditSink must not be null");
    }

    /**
     * Creates an interceptor that logs audit events to SLF4J (for development / testing).
     *
     * @return logging-only interceptor
     */
    public static AudioVideoRequestContextInterceptor loggingOnly() {
        return new AudioVideoRequestContextInterceptor(AuditEventSink.loggingOnly());
    }

    @Override
    public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
            ServerCall<ReqT, RespT> call,
            Metadata headers,
            ServerCallHandler<ReqT, RespT> next) {

        String fullMethod = call.getMethodDescriptor().getFullMethodName();

        // Health endpoints bypass all checks.
        if (AudioVideoMethodRbacRegistry.isExempt(fullMethod)) {
            return next.startCall(call, headers);
        }

        // ── 1. Correlation ID ─────────────────────────────────────────────
        String correlationId = headers.get(CORRELATION_ID_KEY);
        if (correlationId == null || correlationId.isBlank()) {
            correlationId = java.util.UUID.randomUUID().toString();
        }
        MDC.put("correlationId", correlationId);
        final String finalCorrelationId = correlationId;

        // ── 2. Tenant extraction ───────────────────────────────────────────
        // Prefer the JWT-validated tenant from JwtServerInterceptor.CTX_TENANT,
        // then fall back to the TenantGrpcInterceptor context key.
        String jwtTenant = JwtServerInterceptor.CTX_TENANT.get();
        String metaTenant = TenantGrpcInterceptor.TENANT_ID_CTX_KEY.get();

        String effectiveTenant = selectTenant(jwtTenant, metaTenant);
        if (effectiveTenant == null || effectiveTenant.isBlank()) {
            LOG.warn("[{}] Rejected: missing tenant on {}", finalCorrelationId, fullMethod);
            auditSink.emit(new AuditRecord(
                "unknown", principal(), roles(headers), fullMethod,
                Outcome.DENIED_MISSING_TENANT, "missing tenant ID"));
            MDC.remove("correlationId");
            call.close(Status.INVALID_ARGUMENT.withDescription("Tenant ID is required"), new Metadata());
            return new ServerCall.Listener<>() {};
        }

        // ── 3. Cross-tenant guard ──────────────────────────────────────────
        // If both JWT tenant and metadata tenant are present they must agree.
        if (jwtTenant != null && !jwtTenant.isBlank()
                && metaTenant != null && !metaTenant.isBlank()
                && !jwtTenant.equals(metaTenant)) {
            LOG.warn("[{}] Cross-tenant mismatch: jwtTenant={} metaTenant={} on {}",
                finalCorrelationId, jwtTenant, metaTenant, fullMethod);
            auditSink.emit(new AuditRecord(
                effectiveTenant, principal(), roles(headers), fullMethod,
                Outcome.DENIED_CROSS_TENANT,
                "JWT tenant '" + jwtTenant + "' does not match header tenant '" + metaTenant + "'"));
            MDC.remove("correlationId");
            call.close(Status.PERMISSION_DENIED.withDescription("Cross-tenant access denied"), new Metadata());
            return new ServerCall.Listener<>() {};
        }

        // ── 4. Principal ───────────────────────────────────────────────────
        String principal = principal();
        if (principal == null || principal.isBlank() || "unknown".equals(principal)) {
            LOG.warn("[{}] Rejected: missing principal on {}", finalCorrelationId, fullMethod);
            auditSink.emit(new AuditRecord(
                effectiveTenant, "unknown", roles(headers), fullMethod,
                Outcome.DENIED_UNAUTHENTICATED, "missing authenticated principal"));
            MDC.remove("correlationId");
            call.close(Status.UNAUTHENTICATED.withDescription("Authenticated principal required"), new Metadata());
            return new ServerCall.Listener<>() {};
        }

        // ── 5. RBAC ────────────────────────────────────────────────────────
        Set<String> callerRoles = parseRoles(headers);
        if (!AudioVideoMethodRbacRegistry.isAllowedAny(fullMethod, callerRoles)) {
            LOG.warn("[{}] RBAC denied: principal={} roles={} method={}",
                finalCorrelationId, principal, callerRoles, fullMethod);
            auditSink.emit(new AuditRecord(
                effectiveTenant, principal, String.join(",", callerRoles), fullMethod,
                Outcome.DENIED_INSUFFICIENT_ROLE,
                "roles " + callerRoles + " insufficient for " + fullMethod));
            MDC.remove("correlationId");
            call.close(Status.PERMISSION_DENIED.withDescription("Insufficient role for operation"), new Metadata());
            return new ServerCall.Listener<>() {};
        }

        // ── 6. Allowed — emit audit and continue ───────────────────────────
        auditSink.emit(new AuditRecord(
            effectiveTenant, principal, String.join(",", callerRoles),
            fullMethod, Outcome.ALLOWED, ""));
        LOG.debug("[{}] Allowed: principal={} tenant={} roles={} method={}",
            finalCorrelationId, principal, effectiveTenant, callerRoles, fullMethod);

        return new CleanupListener<>(next.startCall(call, headers), finalCorrelationId);
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private static String selectTenant(String jwtTenant, String metaTenant) {
        if (jwtTenant != null && !jwtTenant.isBlank()) {
            return jwtTenant;
        }
        return metaTenant;
    }

    private static String principal() {
        String sub = JwtServerInterceptor.CTX_SUBJECT.get();
        return sub != null ? sub : "";
    }

    private static Set<String> parseRoles(Metadata headers) {
        String rolesHeader = headers.get(ROLES_KEY);
        if (rolesHeader == null || rolesHeader.isBlank()) {
            return Set.of();
        }
        Set<String> roles = new HashSet<>();
        Arrays.stream(rolesHeader.split(","))
            .map(String::trim)
            .filter(r -> !r.isBlank())
            .forEach(roles::add);
        return roles;
    }

    private static String roles(Metadata headers) {
        String h = headers.get(ROLES_KEY);
        return h != null ? h : "";
    }

    /** Forwards all call events to the delegate and cleans up MDC on cancel/complete. */
    private static final class CleanupListener<ReqT> extends ServerCall.Listener<ReqT> {

        private final ServerCall.Listener<ReqT> delegate;
        private final String correlationId;

        CleanupListener(ServerCall.Listener<ReqT> delegate, String correlationId) {
            this.delegate = delegate;
            this.correlationId = correlationId;
        }

        @Override public void onMessage(ReqT message) { delegate.onMessage(message); }
        @Override public void onHalfClose() { delegate.onHalfClose(); }
        @Override public void onCancel() {
            try { delegate.onCancel(); } finally { MDC.remove("correlationId"); }
        }
        @Override public void onComplete() {
            try { delegate.onComplete(); } finally { MDC.remove("correlationId"); }
        }
        @Override public void onReady() { delegate.onReady(); }
    }
}
