package com.ghatana.audio.video.common;

import com.ghatana.audio.video.common.observability.MetricsServerInterceptor;
import com.ghatana.audio.video.common.observability.TracingServerInterceptor;
import com.ghatana.audio.video.common.resilience.CircuitBreakerServerInterceptor;
import com.ghatana.audio.video.common.resilience.TenantAwareRateLimitingInterceptor;
import com.ghatana.audio.video.common.security.AudioVideoRequestContextInterceptor;
import com.ghatana.audio.video.common.security.InputValidationServerInterceptor;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import io.grpc.ServerInterceptor;

import java.util.List;

/**
 * Factory that assembles the standard interceptor chain for audio-video gRPC servers.
 *
 * <p>Interceptors are applied in the order returned by {@link #build()}.
 * gRPC applies interceptors in reverse-list order (last = outermost), so the chain
 * as seen by an incoming request is:
 * <pre>
 *   Tracing → Metrics → CircuitBreaker → JWT → TenantRateLimiter → RBAC/audit
 *       → InputValidation → Service
 * </pre>
 *
 * <p>Usage in a gRPC server setup:
 * <pre>{@code
 *   ServerBuilder.forPort(port)
 *       .addService(myService)
 *       .intercept(GrpcInterceptorChain.build())  // single varargs call
 *       .build();
 * }</pre>
  * @doc.type class
 * @doc.purpose Provides grpc interceptor chain functionality.
 * @doc.layer product
 * @doc.pattern Filter
*/
public final class GrpcInterceptorChain {

    private GrpcInterceptorChain() {}

    /**
     * Build the full interceptor chain.
     *
     * <p>The list is ordered <em>innermost first</em>: {@code AudioVideoGrpcServerBase}
     * calls {@code ServerBuilder.intercept()} for each element in list order. gRPC's
     * {@code intercept()} contract is "last added = first to run (outermost)", so the
     * execution order for an incoming request is <b>exactly reversed</b> from this list.
     *
     * <p>Actual execution order (outermost → innermost → service):
     * <pre>
 *   Tracing → Metrics → CircuitBreaker → JWT
 *       → TenantRateLimiter → RbacAudit → InputValidation
     *       → Service
     * </pre>
     *
     * <p><b>Ordering invariant</b>: JWT must be outer to the tenant limiter, and the
     * tenant limiter must be outer to {@link AudioVideoRequestContextInterceptor} (RBAC).
     * Since the returned list is innermost-first, JWT has the higher index and runs first;
     * it establishes the verified identity before the limiter reads it, and RBAC runs
     * after quota.
     *
     * @return list of interceptors in application order (innermost first for gRPC)
     */
    public static List<ServerInterceptor> build() {
        return List.of(
                new InputValidationServerInterceptor(),               // index 0 — innermost
                AudioVideoRequestContextInterceptor.loggingOnly(),    // index 1 — RBAC (after JWT)
                new TenantAwareRateLimitingInterceptor(),             // index 2 — verified tenant, after JWT
                new JwtServerInterceptor(),                           // index 3 — validates before tenant limiter
                new CircuitBreakerServerInterceptor(),                // index 4
                MetricsServerInterceptor.getInstance(),               // index 5
                new TracingServerInterceptor()                        // index 6 — outermost
        );
    }
}
