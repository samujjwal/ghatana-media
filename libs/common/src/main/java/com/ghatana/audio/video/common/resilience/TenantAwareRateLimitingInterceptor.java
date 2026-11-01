package com.ghatana.audio.video.common.resilience;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
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
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Tenant-aware gRPC rate limiter.
 *
 * <p>Applies per-tenant token-bucket quotas using the identity established by
 * {@link JwtServerInterceptor}. The {@code x-tenant-id} gRPC metadata header is
 * only a cross-check and cannot select a tenant bucket. Install this interceptor
 * after JWT authentication. When a tenant exceeds its configured requests-per-
 * second quota the call is rejected immediately with {@link Status#RESOURCE_EXHAUSTED}.
 * Unconfigured tenants share the global default bucket so caller-controlled IDs
 * cannot allocate unbounded limiter state.
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

    private static final int MAX_TENANT_LIMITERS = 4_096;
    private static final int MAX_TENANT_ID_LENGTH = 256;
    private static final String HEALTH_CHECK = "grpc.health.v1.Health/Check";
    private static final String HEALTH_WATCH = "grpc.health.v1.Health/Watch";
    // RateLimiterConfig stores its request budget in an int after TPS is scaled by 1,000.
    private static final double MAX_TPS = Integer.MAX_VALUE / 1_000.0;

    private final double defaultTps;
    private final Map<String, Double> tenantTpsOverrides;
    private final Map<String, RateLimiter> tenantLimiters = new ConcurrentHashMap<>();
    private final RateLimiter defaultLimiter;
    private final Semaphore concurrencySemaphore;

    /** Uses the same environment settings as the former global limiter. */
    public TenantAwareRateLimitingInterceptor() {
        this(parseEnvDouble("AV_RATE_LIMIT_TPS", 50.0), Map.of(),
                parseEnvLong("AV_RATE_LIMIT_BURST", 100L),
                Math.toIntExact(parseEnvLong("AV_RATE_LIMIT_MAX_CONCURRENT", 20L)));
    }

    /**
     * @param defaultTps         global default token rate (requests/second)
     * @param tenantTpsOverrides per-tenant overrides; absent tenants use {@code defaultTps}
     */
    public TenantAwareRateLimitingInterceptor(double defaultTps,
                                               Map<String, Double> tenantTpsOverrides) {
        this(defaultTps, tenantTpsOverrides, Math.max(1, (int) defaultTps * 2), 20);
    }

    TenantAwareRateLimitingInterceptor(double defaultTps,
                                        Map<String, Double> tenantTpsOverrides,
                                        long defaultBurst,
                                        int maxConcurrent) {
        this.defaultTps = requireTps(defaultTps, "defaultTps");
        if (defaultBurst < 1 || defaultBurst > Integer.MAX_VALUE) {
            throw new IllegalArgumentException("defaultBurst must be within the supported range");
        }
        if (maxConcurrent < 1) {
            throw new IllegalArgumentException("maxConcurrent must be positive");
        }
        this.concurrencySemaphore = new Semaphore(maxConcurrent, true);
        if (tenantTpsOverrides == null) {
            throw new NullPointerException("tenantTpsOverrides must not be null");
        }
        if (tenantTpsOverrides.size() > MAX_TENANT_LIMITERS) {
            throw new IllegalArgumentException("tenantTpsOverrides exceeds supported tenant limit");
        }
        this.tenantTpsOverrides = new ConcurrentHashMap<>();
        tenantTpsOverrides.forEach((tenantId, tps) ->
                this.tenantTpsOverrides.put(requireTenantId(tenantId), requireTps(tps, "tenant TPS")));
        this.tenantTpsOverrides.forEach((tenantId, tps) ->
                tenantLimiters.put(tenantId, DefaultRateLimiter.create(buildConfig(tps, burstFor(tps)))));
        this.defaultLimiter = DefaultRateLimiter.create(buildConfig(this.defaultTps, (int) defaultBurst));

        LOG.info("TenantAwareRateLimitingInterceptor initialised: defaultTps={} overrides={}",
                this.defaultTps, this.tenantTpsOverrides.size());
    }

    @Override
    public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
            ServerCall<ReqT, RespT> call,
            Metadata headers,
            ServerCallHandler<ReqT, RespT> next) {

        String method = call.getMethodDescriptor().getFullMethodName();
        boolean healthCheck = isJwtExemptHealthMethod(method);

        // Caller-controlled metadata may only cross-check the JWT tenant. It must never select
        // a privileged tenant bucket or create arbitrary limiter state.
        JwtServerInterceptor.VerifiedIdentity identity = JwtServerInterceptor.verifiedIdentity();
        if ((identity == null || !isUsableTenant(identity.tenantId())) && !healthCheck) {
            call.close(Status.UNAUTHENTICATED.withDescription("Authenticated tenant required"), new Metadata());
            return new ServerCall.Listener<>() {};
        }
        String tenantId = identity == null ? null : identity.tenantId();
        String metadataTenant = headers.get(TENANT_ID_KEY);
        if (tenantId != null && metadataTenant != null && !tenantId.equals(metadataTenant)) {
            call.close(Status.PERMISSION_DENIED.withDescription("Cross-tenant access denied"), new Metadata());
            return new ServerCall.Listener<>() {};
        }

        if (!concurrencySemaphore.tryAcquire()) {
            call.close(Status.RESOURCE_EXHAUSTED.withDescription(
                    "Server is overloaded. Try again later."), new Metadata());
            return new ServerCall.Listener<>() {};
        }

        RateLimiter limiter = tenantId == null ? defaultLimiter : resolveLimiter(tenantId);

        if (!limiter.tryAcquire(method).allowed()) {
            concurrencySemaphore.release();
            LOG.warn("Rate limit exceeded: method={}", method);
            call.close(
                    Status.RESOURCE_EXHAUSTED.withDescription(
                            "Rate limit exceeded for tenant. Retry after back-off."),
                    new Metadata());
            return new ServerCall.Listener<>() {};
        }

        AtomicBoolean permitReleased = new AtomicBoolean();
        ServerCall<ReqT, RespT> wrappedCall = new io.grpc.ForwardingServerCall.SimpleForwardingServerCall<>(call) {
            @Override
            public void close(Status status, Metadata trailers) {
                if (permitReleased.compareAndSet(false, true)) {
                    concurrencySemaphore.release();
                }
                super.close(status, trailers);
            }
        };
        try {
            return next.startCall(wrappedCall, headers);
        } catch (RuntimeException | Error failure) {
            if (permitReleased.compareAndSet(false, true)) {
                concurrencySemaphore.release();
            }
            throw failure;
        }
    }

    /**
     * Update the rate quota for a specific tenant at runtime.
     *
     * @param tenantId new or existing tenant ID
     * @param tps      new tokens-per-second limit
     */
    public synchronized void updateTenantQuota(String tenantId, double tps) {
        String normalizedTenantId = requireTenantId(tenantId);
        double validatedTps = requireTps(tps, "tenant TPS");
        if (!tenantTpsOverrides.containsKey(normalizedTenantId)
                && tenantTpsOverrides.size() >= MAX_TENANT_LIMITERS) {
            throw new IllegalStateException("tenant quota limit reached");
        }
        tenantTpsOverrides.put(normalizedTenantId, validatedTps);
        tenantLimiters.put(normalizedTenantId, DefaultRateLimiter.create(buildConfig(validatedTps, burstFor(validatedTps))));
        LOG.info("Updated tenant quota: tps={}", validatedTps);
    }

    // ── helpers ────────────────────────────────────────────────────────────

    private RateLimiter resolveLimiter(String tenantId) {
        return tenantLimiters.getOrDefault(tenantId, defaultLimiter);
    }

    private int burstFor(double tps) {
        return Math.max(1, Math.min(Integer.MAX_VALUE, (int) Math.ceil(tps * 2.0d)));
    }

    private static RateLimiterConfig buildConfig(double tps, int burst) {
        int window = Math.max(1, (int) Math.round(tps * 1_000));
        return RateLimiterConfig.builder()
                .maxRequestsPerMinute(window)
                .burstSize(burst)
                .windowDuration(Duration.ofSeconds(1_000))
                .build();
    }

    private static double requireTps(Double value, String field) {
        if (value == null || !Double.isFinite(value) || value <= 0 || value > MAX_TPS) {
            throw new IllegalArgumentException(field + " must be finite, positive, and within the supported range");
        }
        return value;
    }

    private static String requireTenantId(String value) {
        if (!isUsableTenant(value)) {
            throw new IllegalArgumentException("tenantId must be non-blank and at most 256 characters");
        }
        return value;
    }

    private static boolean isUsableTenant(String value) {
        return value != null && !value.isBlank() && value.length() <= MAX_TENANT_ID_LENGTH;
    }

    private static boolean isJwtExemptHealthMethod(String method) {
        if (method == null) return false;
        String path = method.startsWith("/") ? method : "/" + method;
        return path.equals("/" + HEALTH_CHECK) || path.equals("/" + HEALTH_WATCH);
    }

    private static double parseEnvDouble(String name, double def) {
        String value = System.getenv(name);
        if (value == null) return def;
        try { return Double.parseDouble(value); } catch (NumberFormatException ignored) { return def; }
    }

    private static long parseEnvLong(String name, long def) {
        String value = System.getenv(name);
        if (value == null) return def;
        try { return Long.parseLong(value); } catch (NumberFormatException ignored) { return def; }
    }
}

