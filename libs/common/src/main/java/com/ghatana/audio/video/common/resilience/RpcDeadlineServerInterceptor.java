package com.ghatana.audio.video.common.resilience;

import io.grpc.Context;
import io.grpc.Contexts;
import io.grpc.Deadline;
import io.grpc.Metadata;
import io.grpc.ForwardingServerCall;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;
import io.grpc.Status;

import java.time.Duration;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Adds a server-owned maximum execution budget while preserving a shorter client deadline.
 *
 * <p>This bounds the RPC context and transport lifetime. It does not forcibly stop arbitrary
 * Java or native code already running in a service method. Blocking effects must use a bounded,
 * context-aware worker or a killable provider process and must retain their own outcome semantics.
 */
public final class RpcDeadlineServerInterceptor implements ServerInterceptor {
    public static final String DEFAULT_MAX_DEADLINE_MILLIS_PROPERTY = "media.grpc.maxRpcDeadlineMs";
    public static final String METHOD_MAX_DEADLINE_MILLIS_PROPERTY_PREFIX =
            DEFAULT_MAX_DEADLINE_MILLIS_PROPERTY + ".";
    private static final long DEFAULT_MAX_DEADLINE_MILLIS = 120_000;
    private static final long HARD_CONFIGURATION_CEILING_MILLIS = 600_000;
    private static final ScheduledExecutorService TIMER = Executors.newSingleThreadScheduledExecutor(runnable -> {
        Thread thread = new Thread(runnable, "media-grpc-deadline-timer");
        thread.setDaemon(true);
        return thread;
    });

    private final Duration defaultMaximum;
    private final Map<String, Duration> methodMaximums;

    public RpcDeadlineServerInterceptor() {
        this(configuredDefaultMaximum(), configuredMethodMaximums());
    }

    public RpcDeadlineServerInterceptor(Duration defaultMaximum, Map<String, Duration> methodMaximums) {
        this.defaultMaximum = requirePositive(defaultMaximum, "defaultMaximum");
        this.methodMaximums = Map.copyOf(Objects.requireNonNull(methodMaximums, "methodMaximums"));
        this.methodMaximums.forEach((method, duration) -> {
            if (method == null || method.isBlank()) throw new IllegalArgumentException("method name is blank");
            requirePositive(duration, "method maximum");
        });
    }

    @Override
    public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
            ServerCall<ReqT, RespT> call,
            Metadata headers,
            ServerCallHandler<ReqT, RespT> next) {
        Duration maximum = methodMaximums.getOrDefault(
                call.getMethodDescriptor().getFullMethodName(), defaultMaximum);
        Context parent = Context.current();
        Deadline parentDeadline = parent.getDeadline();
        if (parent.isCancelled() || (parentDeadline != null && parentDeadline.isExpired())) {
            call.close(Status.DEADLINE_EXCEEDED.withDescription("RPC deadline elapsed before dispatch"),
                    new Metadata());
            return new ServerCall.Listener<>() {};
        }
        Context bounded = parent.withDeadline(
                Deadline.after(maximum.toNanos(), TimeUnit.NANOSECONDS), TIMER);
        if (bounded.isCancelled() || (bounded.getDeadline() != null && bounded.getDeadline().isExpired())) {
            call.close(Status.DEADLINE_EXCEEDED.withDescription("RPC deadline elapsed before dispatch"),
                    new Metadata());
            return new ServerCall.Listener<>() {};
        }
        AtomicBoolean closed = new AtomicBoolean();
        ServerCall<ReqT, RespT> deadlineCall = new ForwardingServerCall.SimpleForwardingServerCall<>(call) {
            @Override
            public void close(Status status, Metadata trailers) {
                if (closed.compareAndSet(false, true)) super.close(status, trailers);
            }
        };
        bounded.addListener(cancelled -> {
            if (cancelled.getDeadline() != null && cancelled.getDeadline().isExpired()
                    && closed.compareAndSet(false, true)) {
                call.close(Status.UNKNOWN
                        .withDescription("UNKNOWN_OUTCOME: RPC deadline elapsed after dispatch; reconcile with the operation owner before replay"),
                        new Metadata());
            }
        }, Runnable::run);
        return Contexts.interceptCall(bounded, deadlineCall, headers, next);
    }

    private static Duration configuredDefaultMaximum() {
        String configured = System.getProperty(DEFAULT_MAX_DEADLINE_MILLIS_PROPERTY);
        if (configured == null || configured.isBlank()) {
            configured = System.getenv("MEDIA_GRPC_MAX_RPC_DEADLINE_MS");
        }
        if (configured == null || configured.isBlank()) return Duration.ofMillis(DEFAULT_MAX_DEADLINE_MILLIS);
        return parseConfiguredMaximum(configured, DEFAULT_MAX_DEADLINE_MILLIS_PROPERTY);
    }

    /**
     * Per-method overrides use an exact gRPC full method name as the property suffix, e.g.
     * {@code media.grpc.maxRpcDeadlineMs.media.STT/Transcribe=45000}. They inherit the global
     * maximum when absent and are subject to the same positive 10-minute ceiling.
     */
    private static Map<String, Duration> configuredMethodMaximums() {
        Map<String, Duration> configured = new java.util.HashMap<>();
        System.getProperties().stringPropertyNames().stream()
                .filter(property -> property.startsWith(METHOD_MAX_DEADLINE_MILLIS_PROPERTY_PREFIX))
                .forEach(property -> {
                    String method = property.substring(METHOD_MAX_DEADLINE_MILLIS_PROPERTY_PREFIX.length());
                    if (method.isBlank()) {
                        throw new IllegalArgumentException("gRPC per-method deadline property must include a full method name");
                    }
                    configured.put(method, parseConfiguredMaximum(
                            System.getProperty(property), property));
                });
        return Map.copyOf(configured);
    }

    private static Duration parseConfiguredMaximum(String configured, String property) {
        try {
            long millis = Long.parseLong(configured.trim());
            if (millis <= 0) {
                throw new IllegalArgumentException(property + " must be positive");
            }
            if (millis > HARD_CONFIGURATION_CEILING_MILLIS) {
                throw new IllegalArgumentException(property + " must not exceed 600000 milliseconds");
            }
            return Duration.ofMillis(millis);
        } catch (NumberFormatException invalid) {
            throw new IllegalArgumentException(property + " must be an integer number of milliseconds", invalid);
        }
    }

    private static Duration requirePositive(Duration duration, String name) {
        Objects.requireNonNull(duration, name);
        if (duration.isZero() || duration.isNegative() || duration.compareTo(Duration.ofMinutes(10)) > 0) {
            throw new IllegalArgumentException(name + " must be positive and no greater than 10 minutes");
        }
        return duration;
    }
}
