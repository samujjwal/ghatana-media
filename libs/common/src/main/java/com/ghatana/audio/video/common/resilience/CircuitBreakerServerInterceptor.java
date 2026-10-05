package com.ghatana.audio.video.common.resilience;

import io.grpc.ForwardingServerCall;
import io.grpc.Metadata;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;
import io.grpc.Status;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Per-method circuit breaker implemented as a gRPC server interceptor.
 *
 * <p>State machine: CLOSED → OPEN → HALF_OPEN → CLOSED
 * <ul>
 *   <li>CLOSED  — normal operation; failures are counted.</li>
 *   <li>OPEN    — calls rejected immediately with UNAVAILABLE after failure threshold reached.</li>
 *   <li>HALF_OPEN — one probe call allowed after reset timeout; success → CLOSED, failure → OPEN.</li>
 * </ul>
 *
 * <p>Configuration via environment variables (all optional):
 * <ul>
 *   <li>{@code AV_CB_FAILURE_THRESHOLD} — consecutive failures before opening (default 5)</li>
 *   <li>{@code AV_CB_RESET_TIMEOUT_MS} — ms to wait before probing in HALF_OPEN (default 30000)</li>
 * </ul>
  * @doc.type enum
 * @doc.purpose Provides circuit breaker server interceptor functionality.
 * @doc.layer product
 * @doc.pattern Filter
*/
public class CircuitBreakerServerInterceptor implements ServerInterceptor {

    private static final Logger LOG = LoggerFactory.getLogger(CircuitBreakerServerInterceptor.class);

    private enum State { CLOSED, OPEN, HALF_OPEN }

    private static class Breaker {
        final AtomicReference<State> state = new AtomicReference<>(State.CLOSED);
        final AtomicInteger failures = new AtomicInteger(0);
        final AtomicLong openedAtMs = new AtomicLong(0);
        final AtomicInteger halfOpenProbes = new AtomicInteger(0);
    }

    private final int failureThreshold;
    private final long resetTimeoutMs;
    private final ConcurrentHashMap<String, Breaker> breakers = new ConcurrentHashMap<>();

    public CircuitBreakerServerInterceptor() {
        this(
            (int) parseEnvLong(5L, "AV_CB_FAILURE_THRESHOLD", "CIRCUIT_BREAKER_FAILURE_THRESHOLD"),
            parseEnvLong(30_000L, "AV_CB_RESET_TIMEOUT_MS", "CIRCUIT_BREAKER_RESET_TIMEOUT_MS")
        );
        }

        CircuitBreakerServerInterceptor(int failureThreshold, long resetTimeoutMs) {
        this.failureThreshold = Math.max(1, failureThreshold);
        this.resetTimeoutMs = Math.max(0L, resetTimeoutMs);
        LOG.info("Circuit breaker initialised: failureThreshold={} resetTimeoutMs={}",
            this.failureThreshold, this.resetTimeoutMs);
    }

    @Override
    public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
            ServerCall<ReqT, RespT> call,
            Metadata headers,
            ServerCallHandler<ReqT, RespT> next) {

        String method = call.getMethodDescriptor().getFullMethodName();
        Breaker breaker = breakers.computeIfAbsent(method, k -> new Breaker());

        State current = breaker.state.get();

        if (current == State.OPEN) {
            long elapsed = System.currentTimeMillis() - breaker.openedAtMs.get();
            if (elapsed >= resetTimeoutMs) {
                if (breaker.state.compareAndSet(State.OPEN, State.HALF_OPEN)) {
                    LOG.info("Circuit breaker HALF_OPEN for {}", method);
                }
            } else {
                call.close(Status.UNAVAILABLE
                        .withDescription("Circuit breaker OPEN for " + method
                                + ". Retry after " + (resetTimeoutMs - elapsed) + "ms"),
                        new Metadata());
                return new ServerCall.Listener<>() {};
            }
        }

        if (breaker.state.get() == State.HALF_OPEN) {
            // Allow only one probe at a time
            if (breaker.halfOpenProbes.getAndIncrement() > 0) {
                breaker.halfOpenProbes.decrementAndGet();
                call.close(Status.UNAVAILABLE
                        .withDescription("Circuit breaker probing " + method), new Metadata());
                return new ServerCall.Listener<>() {};
            }
        }

        ServerCall<ReqT, RespT> wrappedCall =
                new ForwardingServerCall.SimpleForwardingServerCall<>(call) {
                    @Override
                    public void close(Status status, Metadata trailers) {
                        if (status.isOk() || status.getCode() == Status.Code.NOT_FOUND
                                || status.getCode() == Status.Code.INVALID_ARGUMENT
                                || status.getCode() == Status.Code.UNAUTHENTICATED
                                || status.getCode() == Status.Code.PERMISSION_DENIED) {
                            // Business errors don't trip the breaker
                            onSuccess(method, breaker);
                        } else {
                            onFailure(method, breaker);
                        }
                        super.close(status, trailers);
                    }
                };

        return next.startCall(wrappedCall, headers);
    }

    private void onSuccess(String method, Breaker breaker) {
        State was = breaker.state.get();
        if (was == State.HALF_OPEN) {
            breaker.state.set(State.CLOSED);
            breaker.failures.set(0);
            breaker.halfOpenProbes.set(0);
            LOG.info("Circuit breaker CLOSED (recovered) for {}", method);
        } else {
            breaker.failures.set(0);
        }
    }

    private void onFailure(String method, Breaker breaker) {
        int count = breaker.failures.incrementAndGet();
        State was = breaker.state.get();
        if (was == State.HALF_OPEN) {
            breaker.state.set(State.OPEN);
            breaker.openedAtMs.set(System.currentTimeMillis());
            breaker.halfOpenProbes.set(0);
            LOG.warn("Circuit breaker OPEN again (probe failed) for {}", method);
        } else if (count >= failureThreshold && was == State.CLOSED) {
            if (breaker.state.compareAndSet(State.CLOSED, State.OPEN)) {
                breaker.openedAtMs.set(System.currentTimeMillis());
                LOG.warn("Circuit breaker OPEN (threshold={}) for {}", failureThreshold, method);
            }
        }
    }

    private static long parseEnvLong(long def, String... names) {
        for (String name : names) {
            String val = System.getenv(name);
            if (val == null) {
                continue;
            }
            try {
                return Long.parseLong(val);
            } catch (NumberFormatException ignored) {
                // Keep looking so a malformed legacy variable does not mask a valid canonical one.
            }
        }
        return def;
    }
}
