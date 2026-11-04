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

import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Production-grade gRPC server interceptor for audio-video services.
 *
 * <p>This interceptor is the single enforcement point for all requests to audio-video
 * gRPC services. It runs <em>after</em> {@link JwtServerInterceptor} (which validates
 * the token and populates its verified identity. Optional
 * {@link TenantGrpcInterceptor} context is used only as a tenant mismatch
 * cross-check; it is not installed by the standard Media interceptor chain.
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
        // Use the authenticated tenant. TenantGrpcInterceptor context is only
        // a cross-check and cannot establish identity by itself.
        JwtServerInterceptor.VerifiedIdentity verifiedIdentity = JwtServerInterceptor.verifiedIdentity();
        String jwtTenant = verifiedIdentity == null ? null : verifiedIdentity.tenantId();
        String metaTenant = TenantGrpcInterceptor.TENANT_ID_CTX_KEY.get();
        // The standard Media chain does not install Shared's TenantGrpcInterceptor,
        // so inspect the raw tenant scope header as an untrusted cross-check too.
        // It can never establish the effective tenant; only the verified identity can.
        String requestedTenant = headers.get(TenantGrpcInterceptor.TENANT_ID_KEY);

        // The tenant interceptor context is a cross-check only. It cannot
        // substitute for the identity established by the JWT validator.
        String effectiveTenant = jwtTenant;
        if (effectiveTenant == null || effectiveTenant.isBlank()) {
            LOG.warn("Rejected request without tenant on {}", fullMethod);
            auditSink.emit(new AuditRecord(
                "unknown", principal(verifiedIdentity), "", fullMethod,
                Outcome.DENIED_MISSING_TENANT, "missing tenant ID"));
            call.close(Status.INVALID_ARGUMENT.withDescription("Tenant ID is required"), new Metadata());
            return new ServerCall.Listener<>() {};
        }

        // ── 3. Cross-tenant guard ──────────────────────────────────────────
        // Any supplied tenant scope must agree with the verified JWT tenant.
        if (jwtTenant != null && !jwtTenant.isBlank()
                && ((metaTenant != null && !metaTenant.isBlank() && !jwtTenant.equals(metaTenant))
                || (requestedTenant != null && !requestedTenant.isBlank()
                && !jwtTenant.equals(requestedTenant)))) {
            LOG.warn("Rejected cross-tenant request on {}", fullMethod);
            auditSink.emit(new AuditRecord(
                effectiveTenant, principal(verifiedIdentity), verifiedRoles(verifiedIdentity), fullMethod,
                Outcome.DENIED_CROSS_TENANT,
                "JWT tenant does not match supplied tenant scope"));
            call.close(Status.PERMISSION_DENIED.withDescription("Cross-tenant access denied"), new Metadata());
            return new ServerCall.Listener<>() {};
        }

        // ── 4. Principal ───────────────────────────────────────────────────
        String principal = principal(verifiedIdentity);
        if (principal == null || principal.isBlank() || "unknown".equals(principal)) {
            LOG.warn("Rejected request without principal on {}", fullMethod);
            auditSink.emit(new AuditRecord(
                effectiveTenant, "unknown", "", fullMethod,
                Outcome.DENIED_UNAUTHENTICATED, "missing authenticated principal"));
            call.close(Status.UNAUTHENTICATED.withDescription("Authenticated principal required"), new Metadata());
            return new ServerCall.Listener<>() {};
        }

        // ── 5. RBAC ────────────────────────────────────────────────────────
        // Role values come only from the signed-token snapshot. x-roles
        // metadata is caller-controlled and is deliberately ignored.
        Set<String> callerRoles = verifiedIdentity == null ? Set.of() : verifiedIdentity.roles();
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

    private static String principal(JwtServerInterceptor.VerifiedIdentity identity) {
        return identity == null || identity.subject() == null ? "" : identity.subject();
    }

    private static String verifiedRoles(JwtServerInterceptor.VerifiedIdentity identity) {
        return identity == null ? "" : identity.roles().stream().sorted().collect(Collectors.joining(","));
    }

}
