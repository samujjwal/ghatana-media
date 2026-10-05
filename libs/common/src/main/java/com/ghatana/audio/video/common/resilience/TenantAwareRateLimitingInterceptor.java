package com.ghatana.audio.video.common.resilience;

import com.ghatana.security.ratelimit.DefaultRateLimiter;
import com.ghatana.security.ratelimit.RateLimiter;
import com.ghatana.security.ratelimit.RateLimiterConfig;
import io.grpc.Metadata;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;
import io.grpc.Status;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Tenant-aware gRPC rate limiter.
 *
 * <p>Applies per-tenant token-bucket quotas extracted from the
 * {@code x-tenant-id} gRPC metadata header. When a tenant exceeds its
 * configured requests-per-second quota the call is rejected immediately with
 * {@link Status#RESOURCE_EXHAUSTED}. Tenants with no explicit quota fall back
 * to the global default limit.
 *
 * <p>Per-tenant limits are supplied as a {@code Map<tenantId, tps>} at
 * construction time and can be updated at runtime via {@link #updateTenantQuota}.
 *
 * @doc.type class
 * @doc.purpose Per-tenant gRPC rate limiter for Audio-Video services (AV-P2-04)
 * @doc.layer product
 * @doc.pattern Interceptor
 */
public class TenantAwareRateLimitingInterceptor implements ServerInterceptor {

    private static final Logger LOG = LoggerFactory.getLogger(TenantAwareRateLimitingInterceptor.class);

    /** gRPC metadata key for tenant ID. */
    static final Metadata.Key<String> TENANT_ID_KEY =
            Metadata.Key.of("x-tenant-id", Metadata.ASCII_STRING_MARSHALLER);

    private final double defaultTps;
    private final Map<String, Double> tenantTpsOverrides;
    private final Map<String, RateLimiter> tenantLimiters = new ConcurrentHashMap<>();
    private final RateLimiter defaultLimiter;

    /**
     * @param defaultTps         global default token rate (requests/second)
     * @param tenantTpsOverrides per-tenant overrides; absent tenants use {@code defaultTps}
     */
    public TenantAwareRateLimitingInterceptor(double defaultTps,
                                               Map<String, Double> tenantTpsOverrides) {
        this.defaultTps = defaultTps;
        this.tenantTpsOverrides = new ConcurrentHashMap<>(tenantTpsOverrides);
        this.defaultLimiter = DefaultRateLimiter.create(buildConfig(defaultTps));

        LOG.info("TenantAwareRateLimitingInterceptor initialised: defaultTps={} overrides={}",
                defaultTps, tenantTpsOverrides.size());
    }

    @Override
    public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
            ServerCall<ReqT, RespT> call,
            Metadata headers,
            ServerCallHandler<ReqT, RespT> next) {

        String tenantId = headers.get(TENANT_ID_KEY);
        String method = call.getMethodDescriptor().getFullMethodName();

        RateLimiter limiter = resolveLimiter(tenantId);

        if (!limiter.tryAcquire(method).allowed()) {
            LOG.warn("Rate limit exceeded: tenant={} method={}", tenantId, method);
            call.close(
                    Status.RESOURCE_EXHAUSTED.withDescription(
                            "Rate limit exceeded for tenant. Retry after back-off."),
                    new Metadata());
            return new ServerCall.Listener<>() {};
        }

        return next.startCall(call, headers);
    }

    /**
     * Update the rate quota for a specific tenant at runtime.
     *
     * @param tenantId new or existing tenant ID
     * @param tps      new tokens-per-second limit
     */
    public void updateTenantQuota(String tenantId, double tps) {
        tenantTpsOverrides.put(tenantId, tps);
        tenantLimiters.put(tenantId, DefaultRateLimiter.create(buildConfig(tps)));
        LOG.info("Updated tenant quota: tenant={} tps={}", tenantId, tps);
    }

    // ── helpers ────────────────────────────────────────────────────────────

    private RateLimiter resolveLimiter(String tenantId) {
        if (tenantId == null) return defaultLimiter;
        return tenantLimiters.computeIfAbsent(tenantId, id -> {
            double tps = tenantTpsOverrides.getOrDefault(id, defaultTps);
            return DefaultRateLimiter.create(buildConfig(tps));
        });
    }

    private static RateLimiterConfig buildConfig(double tps) {
        int window = Math.max(1, (int) Math.round(tps * 1_000));
        return RateLimiterConfig.builder()
                .maxRequestsPerMinute(window)
                .burstSize(Math.max(1, (int) tps * 2))
                .windowDuration(Duration.ofSeconds(1_000))
                .build();
    }
}

