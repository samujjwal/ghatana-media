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
 *   <li><b>Privacy</b> — identity, role, tenant, and correlation metadata are excluded from
 *       ordinary application log fields; the dedicated security audit record remains complete.</li>
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

        // ── 2. Tenant extraction ───────────────────────────────────────────
        // Prefer the JWT-validated tenant from JwtServerInterceptor.CTX_TENANT,
        // then fall back to the TenantGrpcInterceptor context key.
        String jwtTenant = JwtServerInterceptor.CTX_TENANT.get();
        String metaTenant = TenantGrpcInterceptor.TENANT_ID_CTX_KEY.get();

        String effectiveTenant = selectTenant(jwtTenant, metaTenant);
        if (effectiveTenant == null || effectiveTenant.isBlank()) {
            LOG.warn("Rejected request without tenant on {}", fullMethod);
            auditSink.emit(new AuditRecord(
                "unknown", principal(), roles(headers), fullMethod,
                Outcome.DENIED_MISSING_TENANT, "missing tenant ID"));
            call.close(Status.INVALID_ARGUMENT.withDescription("Tenant ID is required"), new Metadata());
            return new ServerCall.Listener<>() {};
        }

        // ── 3. Cross-tenant guard ──────────────────────────────────────────
        // If both JWT tenant and metadata tenant are present they must agree.
        if (jwtTenant != null && !jwtTenant.isBlank()
                && metaTenant != null && !metaTenant.isBlank()
                && !jwtTenant.equals(metaTenant)) {
            LOG.warn("Rejected cross-tenant request on {}", fullMethod);
            auditSink.emit(new AuditRecord(
                effectiveTenant, principal(), roles(headers), fullMethod,
                Outcome.DENIED_CROSS_TENANT,
                "JWT tenant '" + jwtTenant + "' does not match header tenant '" + metaTenant + "'"));
            call.close(Status.PERMISSION_DENIED.withDescription("Cross-tenant access denied"), new Metadata());
            return new ServerCall.Listener<>() {};
        }

        // ── 4. Principal ───────────────────────────────────────────────────
        String principal = principal();
        if (principal == null || principal.isBlank() || "unknown".equals(principal)) {
            LOG.warn("Rejected request without principal on {}", fullMethod);
            auditSink.emit(new AuditRecord(
                effectiveTenant, "unknown", roles(headers), fullMethod,
                Outcome.DENIED_UNAUTHENTICATED, "missing authenticated principal"));
            call.close(Status.UNAUTHENTICATED.withDescription("Authenticated principal required"), new Metadata());
            return new ServerCall.Listener<>() {};
        }

        // ── 5. RBAC ────────────────────────────────────────────────────────
        Set<String> callerRoles = parseRoles(headers);
        if (!AudioVideoMethodRbacRegistry.isAllowedAny(fullMethod, callerRoles)) {
            LOG.warn("RBAC denied request for method={}", fullMethod);
            auditSink.emit(new AuditRecord(
                effectiveTenant, principal, String.join(",", callerRoles), fullMethod,
                Outcome.DENIED_INSUFFICIENT_ROLE,
                "roles " + callerRoles + " insufficient for " + fullMethod));
            call.close(Status.PERMISSION_DENIED.withDescription("Insufficient role for operation"), new Metadata());
            return new ServerCall.Listener<>() {};
        }

        // ── 6. Allowed — emit audit and continue ───────────────────────────
        auditSink.emit(new AuditRecord(
            effectiveTenant, principal, String.join(",", callerRoles),
            fullMethod, Outcome.ALLOWED, ""));
        LOG.debug("Allowed request for method={}", fullMethod);

        return next.startCall(call, headers);
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

}
