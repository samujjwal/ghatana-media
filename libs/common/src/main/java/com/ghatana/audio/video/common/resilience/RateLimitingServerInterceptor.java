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
import java.util.concurrent.Semaphore;

/**
 * Token-bucket rate limiter implemented as a gRPC server interceptor.
 *
 * <p>Limits are applied per-method. The bucket refills at a configurable rate
 * (tokens/second). When the bucket is empty the call is rejected with
 * {@link Status#RESOURCE_EXHAUSTED} so clients can back off and retry.
 *
 * <p>Configuration via environment variables (all optional):
 * <ul>
 *   <li>{@code AV_RATE_LIMIT_TPS} — global tokens per second (default 50)</li>
 *   <li>{@code AV_RATE_LIMIT_BURST} — maximum burst size (default 100)</li>
 *   <li>{@code AV_RATE_LIMIT_MAX_CONCURRENT} — maximum concurrent calls (default 20)</li>
 * </ul>
 *
 * @doc.type class
 * @doc.purpose gRPC server interceptor with concurrency guard and shared token-bucket throttling
 * @doc.layer product
 * @doc.pattern Interceptor
 */
public class RateLimitingServerInterceptor implements ServerInterceptor {

    private static final Logger LOG = LoggerFactory.getLogger(RateLimitingServerInterceptor.class);
    private static final int RATE_PRECISION_SECONDS = 1_000;

    private final double tokensPerSecond;
    private final long maxBurst;
    private final Semaphore concurrencySemaphore;
    private final RateLimiter rateLimiter;

    public RateLimitingServerInterceptor() {
        this(
                parseEnvDouble("AV_RATE_LIMIT_TPS", 50.0),
                parseEnvLong("AV_RATE_LIMIT_BURST", 100L),
                Math.toIntExact(parseEnvLong("AV_RATE_LIMIT_MAX_CONCURRENT", 20L))
        );
    }

    RateLimitingServerInterceptor(double tokensPerSecond, long maxBurst, int maxConcurrent) {
        this.tokensPerSecond = tokensPerSecond;
        this.maxBurst = maxBurst;
        this.concurrencySemaphore = new Semaphore(maxConcurrent, true);
        this.rateLimiter = DefaultRateLimiter.create(createLimiterConfig(tokensPerSecond, maxBurst));

        LOG.info("Rate limiter initialised: tps={} burst={} maxConcurrent={}",
                tokensPerSecond, maxBurst, maxConcurrent);
    }

    @Override
    public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
            ServerCall<ReqT, RespT> call,
            Metadata headers,
            ServerCallHandler<ReqT, RespT> next) {

        String method = call.getMethodDescriptor().getFullMethodName();

        // 1. Concurrency check
        if (!concurrencySemaphore.tryAcquire()) {
            LOG.warn("Concurrency limit exceeded for {}", method);
            call.close(Status.RESOURCE_EXHAUSTED
                    .withDescription("Server is overloaded. Try again later."), new Metadata());
            return new ServerCall.Listener<>() {};
        }

        // 2. Token bucket check
        if (!rateLimiter.tryAcquire(method).allowed()) {
            concurrencySemaphore.release();
            LOG.warn("Rate limit exceeded for {}", method);
            call.close(Status.RESOURCE_EXHAUSTED
                    .withDescription("Rate limit exceeded. Retry after back-off."), new Metadata());
            return new ServerCall.Listener<>() {};
        }

        // 3. Proceed, releasing the concurrency permit on close
        ServerCall<ReqT, RespT> wrappedCall =
                new io.grpc.ForwardingServerCall.SimpleForwardingServerCall<>(call) {
                    @Override
                    public void close(Status status, Metadata trailers) {
                        concurrencySemaphore.release();
                        super.close(status, trailers);
                    }
                };

        return next.startCall(wrappedCall, headers);
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private static RateLimiterConfig createLimiterConfig(double tokensPerSecond, long maxBurst) {
        int scaledWindowRequests = Math.max(1, (int) Math.round(tokensPerSecond * RATE_PRECISION_SECONDS));
        return RateLimiterConfig.builder()
                .maxRequestsPerMinute(scaledWindowRequests)
                .burstSize(Math.toIntExact(maxBurst))
                .windowDuration(Duration.ofSeconds(RATE_PRECISION_SECONDS))
                .build();
    }

    private static double parseEnvDouble(String name, double def) {
        String val = System.getenv(name);
        if (val == null) return def;
        try { return Double.parseDouble(val); } catch (NumberFormatException e) { return def; }
    }

    private static long parseEnvLong(String name, long def) {
        String val = System.getenv(name);
        if (val == null) return def;
        try { return Long.parseLong(val); } catch (NumberFormatException e) { return def; }
    }
}
