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
import java.util.HashMap;
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
    // Active-only tenant counts cap state even when verified tenant IDs are not configured.
    // Entries disappear when their last call closes/cancels, so caller-controlled churn cannot
    // accumulate historical tenant state.
    private final Map<String, Integer> activeTenantCalls = new HashMap<>();
    private final RateLimiter defaultLimiter;
    private final Semaphore concurrencySemaphore;
    private final int maxConcurrentPerTenant;

    /** Uses the same environment settings as the former global limiter. */
    public TenantAwareRateLimitingInterceptor() {
        this(parseEnvDouble("AV_RATE_LIMIT_TPS", 50.0), Map.of(),
                parseEnvLong("AV_RATE_LIMIT_BURST", 100L),
                Math.toIntExact(parseEnvLong("AV_RATE_LIMIT_MAX_CONCURRENT", 20L)),
                Math.toIntExact(parseEnvLong("AV_RATE_LIMIT_MAX_CONCURRENT_PER_TENANT", 5L)));
    }

    /**
     * @param defaultTps         global default token rate (requests/second)
     * @param tenantTpsOverrides per-tenant overrides; absent tenants use {@code defaultTps}
     */
    public TenantAwareRateLimitingInterceptor(double defaultTps,
                                               Map<String, Double> tenantTpsOverrides) {
        this(defaultTps, tenantTpsOverrides, (long) Math.max(1, (int) defaultTps * 2), 20, 5);
    }

    /**
     * Configure global and per-tenant concurrency bounds while using the default burst.
     */
    public TenantAwareRateLimitingInterceptor(double defaultTps,
                                               Map<String, Double> tenantTpsOverrides,
                                               int maxConcurrent,
                                               int maxConcurrentPerTenant) {
        this(defaultTps, tenantTpsOverrides, Math.max(1, (int) defaultTps * 2),
                maxConcurrent, maxConcurrentPerTenant);
    }

    TenantAwareRateLimitingInterceptor(double defaultTps,
                                        Map<String, Double> tenantTpsOverrides,
                                        long defaultBurst,
                                        int maxConcurrent) {
        this(defaultTps, tenantTpsOverrides, defaultBurst, maxConcurrent, 5);
    }

    /**
     * Configure global and per-tenant in-flight bounds. The default per-tenant
     * development policy is five concurrent calls; it is deliberately configurable because
     * product sources define isolation but no numeric tenant concurrency quota.
     */
    public TenantAwareRateLimitingInterceptor(double defaultTps,
                                               Map<String, Double> tenantTpsOverrides,
                                               long defaultBurst,
                                               int maxConcurrent,
                                               int maxConcurrentPerTenant) {
        this.defaultTps = requireTps(defaultTps, "defaultTps");
        if (defaultBurst < 1 || defaultBurst > Integer.MAX_VALUE) {
            throw new IllegalArgumentException("defaultBurst must be within the supported range");
        }
        if (maxConcurrent < 1) {
            throw new IllegalArgumentException("maxConcurrent must be positive");
        }
        if (maxConcurrentPerTenant < 1) {
            throw new IllegalArgumentException("maxConcurrentPerTenant must be positive");
        }
        this.maxConcurrentPerTenant = maxConcurrentPerTenant;
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
        boolean tenantPermitAcquired = tenantId != null && tryAcquireTenant(tenantId);
        if (tenantId != null && !tenantPermitAcquired) {
            concurrencySemaphore.release();
            call.close(Status.RESOURCE_EXHAUSTED.withDescription(
                    "Tenant is at its concurrent call limit. Try again later."), new Metadata());
            return new ServerCall.Listener<>() {};
        }

        RateLimiter limiter = tenantId == null ? defaultLimiter : resolveLimiter(tenantId);

        if (!limiter.tryAcquire(method).allowed()) {
            if (tenantPermitAcquired) releaseTenant(tenantId);
            concurrencySemaphore.release();
            LOG.warn("Rate limit exceeded: method={}", method);
            call.close(
                    Status.RESOURCE_EXHAUSTED.withDescription(
                            "Rate limit exceeded for tenant. Retry after back-off."),
                    new Metadata());
            return new ServerCall.Listener<>() {};
        }

        AtomicBoolean permitReleased = new AtomicBoolean();
        io.grpc.Context requestContext = io.grpc.Context.current();
        java.util.concurrent.atomic.AtomicReference<io.grpc.Context.CancellationListener> contextListener =
                new java.util.concurrent.atomic.AtomicReference<>();
        Runnable releasePermit = () -> {
            if (permitReleased.compareAndSet(false, true)) {
                io.grpc.Context.CancellationListener listener = contextListener.get();
                if (listener != null) requestContext.removeListener(listener);
                if (tenantPermitAcquired) releaseTenant(tenantId);
                concurrencySemaphore.release();
            }
        };
        io.grpc.Context.CancellationListener cancellationListener = ignored -> releasePermit.run();
        contextListener.set(cancellationListener);
        // A server-owned deadline closes the outer transport call directly; that close does
        // not necessarily pass through this inner wrappedCall. Release permits from the RPC
        // context terminal signal as well as from call close and client onCancel.
        requestContext.addListener(cancellationListener, Runnable::run);
        ServerCall<ReqT, RespT> wrappedCall = new io.grpc.ForwardingServerCall.SimpleForwardingServerCall<>(call) {
            @Override
            public void close(Status status, Metadata trailers) {
                releasePermit.run();
                super.close(status, trailers);
            }
        };
        try {
            ServerCall.Listener<ReqT> listener = next.startCall(wrappedCall, headers);
            return new io.grpc.ForwardingServerCallListener.SimpleForwardingServerCallListener<>(listener) {
                @Override
                public void onCancel() {
                    try {
                        super.onCancel();
                    } finally {
                        releasePermit.run();
                    }
                }
            };
        } catch (RuntimeException | Error failure) {
            releasePermit.run();
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

    private synchronized boolean tryAcquireTenant(String tenantId) {
        Integer activeCalls = activeTenantCalls.get(tenantId);
        if (activeCalls == null) {
            if (activeTenantCalls.size() >= MAX_TENANT_LIMITERS) return false;
            activeTenantCalls.put(tenantId, 1);
            return true;
        }
        if (activeCalls >= maxConcurrentPerTenant) return false;
        activeTenantCalls.put(tenantId, activeCalls + 1);
        return true;
    }

    private synchronized void releaseTenant(String tenantId) {
        Integer activeCalls = activeTenantCalls.get(tenantId);
        if (activeCalls == null) return;
        if (activeCalls == 1) activeTenantCalls.remove(tenantId);
        else activeTenantCalls.put(tenantId, activeCalls - 1);
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

