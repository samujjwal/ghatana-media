package com.ghatana.audiovideo.observability;

import com.ghatana.audio.video.common.health.ServerReadinessLifecycle;
import com.ghatana.observability.MetricsCollector;
import io.grpc.health.v1.HealthCheckRequest;
import io.grpc.health.v1.HealthCheckResponse;
import io.grpc.health.v1.HealthGrpc;
import io.grpc.Status;
import io.grpc.stub.ServerCallStreamObserver;
import io.grpc.stub.StreamObserver;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.Collections;
import java.time.Duration;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

/**
 * gRPC health check service implementation for Audio-Video services.
 *
 * <p>Implements the standard gRPC Health Checking Protocol (grpc.health.v1.Health).
 * Each Audio-Video gRPC server (STT, TTS, Vision, Multimodal) registers this
 * service to expose a standardised {@code /health} probe.
 * {@code Watch} sends its initial status and bounded readiness changes while a
 * subscriber is connected, then sends {@code NOT_SERVING} before shutdown completion.
 *
 * <p>Service readiness is determined by named health checks. A service is healthy
 * when all registered checks pass. Any failing check sets the overall status to
 * {@link HealthCheckResponse.ServingStatus#NOT_SERVING}.
 *
 * <p>The {@code Check} RPC emits a {@code av.health.check} counter metric with a
 * {@code status} tag so failures are observable in Prometheus.
 *
 * @doc.type class
 * @doc.purpose gRPC health check service for Audio-Video microservices (AV-P1-06)
 * @doc.layer product
 * @doc.pattern Service
 */
public class AudioVideoHealthService extends HealthGrpc.HealthImplBase implements ServerReadinessLifecycle {

    private static final Logger LOG = LoggerFactory.getLogger(AudioVideoHealthService.class);
    private static final Duration DEFAULT_CHECK_TIMEOUT = Duration.ofMillis(250);
    private static final Duration MAX_CHECK_TIMEOUT = Duration.ofSeconds(5);
    private static final int MAX_WATCH_SUBSCRIBERS = 128;
    private static final long WATCH_REFRESH_MILLIS = 1_000L;

    private final Map<String, Supplier<Boolean>> checks = new ConcurrentHashMap<>();
    private final Set<String> requiredChecks;
    private final AtomicReference<LifecycleState> lifecycle = new AtomicReference<>(LifecycleState.STARTING);
    private final ExecutorService checkExecutor;
    private final long checkTimeoutNanos;
    private final MetricsCollector metricsCollector;
    private final String serviceName;
    private final Set<WatchSubscription> watchSubscribers =
            Collections.newSetFromMap(new ConcurrentHashMap<>());
    private final Object watchLock = new Object();
    private final ScheduledExecutorService watchPublisher;
    private ScheduledFuture<?> watchPollTask;
    private volatile boolean closed;

    public AudioVideoHealthService(String serviceName, MetricsCollector metricsCollector) {
        this(serviceName, metricsCollector, Set.of(), DEFAULT_CHECK_TIMEOUT);
    }

    /**
     * Construct health readiness with an explicit set of checks that must be registered before
     * the service may be marked ready.
     */
    public AudioVideoHealthService(String serviceName, MetricsCollector metricsCollector,
                                   Set<String> requiredChecks) {
        this(serviceName, metricsCollector, requiredChecks, DEFAULT_CHECK_TIMEOUT);
    }

    /** Construct the health service with an explicit maximum duration for the full check set. */
    public AudioVideoHealthService(String serviceName, MetricsCollector metricsCollector,
                                   Set<String> requiredChecks, Duration checkTimeout) {
        this.serviceName = requireName(serviceName, "serviceName");
        this.metricsCollector = Objects.requireNonNull(metricsCollector, "metricsCollector");
        Objects.requireNonNull(requiredChecks, "requiredChecks");
        this.requiredChecks = requiredChecks.stream()
                .map(name -> requireName(name, "required check name"))
                .collect(java.util.stream.Collectors.toUnmodifiableSet());
        Objects.requireNonNull(checkTimeout, "checkTimeout");
        if (checkTimeout.isZero() || checkTimeout.isNegative() || checkTimeout.compareTo(MAX_CHECK_TIMEOUT) > 0) {
            throw new IllegalArgumentException("checkTimeout must be greater than zero and at most 5 seconds");
        }
        this.checkTimeoutNanos = checkTimeout.toNanos();
        ThreadFactory threadFactory = runnable -> {
            Thread thread = new Thread(runnable, "av-health-check-" + this.serviceName);
            thread.setDaemon(true);
            return thread;
        };
        this.checkExecutor = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
                new SynchronousQueue<>(), threadFactory, new ThreadPoolExecutor.AbortPolicy());
        ThreadFactory watchThreadFactory = runnable -> {
            Thread thread = new Thread(runnable, "av-health-watch-" + this.serviceName);
            thread.setDaemon(true);
            return thread;
        };
        this.watchPublisher = java.util.concurrent.Executors.newSingleThreadScheduledExecutor(watchThreadFactory);
    }

    /**
     * Register a named health check.
     *
     * @param name  descriptive name, e.g. "grpc-channel", "model-loaded"
     * @param check supplier returning {@code true} when the component is healthy
     */
    public void registerCheck(String name, Supplier<Boolean> check) {
        String validName = requireName(name, "check name");
        Supplier<Boolean> validCheck = Objects.requireNonNull(check, "check supplier");
        checks.put(validName, validCheck);
        if (lifecycle.compareAndSet(LifecycleState.READY, LifecycleState.STARTING)) {
            LOG.warn("Health check changed after readiness; service returned to NOT_SERVING: {}", serviceName);
        }
        LOG.info("Health check registered: service={} check={}", serviceName, validName);
    }

    /**
     * Mark startup complete after all required checks have been registered. Provider checks are
     * still evaluated on every {@code Check}; a failure or exception keeps readiness down.
     *
     * @return true when readiness was enabled, false when required checks are missing or shutdown began
     */
    public boolean markReady() {
        LifecycleState state = lifecycle.get();
        if (state == LifecycleState.DRAINING) return false;
        if (checks.isEmpty() || !checks.keySet().containsAll(requiredChecks)) return false;
        if (state == LifecycleState.READY) return true;
        if (!lifecycle.compareAndSet(LifecycleState.STARTING, LifecycleState.READY)) return false;
        LOG.info("Service marked ready: {}", serviceName);
        return true;
    }

    /**
     * Signal that the service is shutting down — subsequent Check calls return
     * {@link HealthCheckResponse.ServingStatus#NOT_SERVING}.
     */
    public void setNotServing() {
        lifecycle.set(LifecycleState.DRAINING);
        LOG.info("Service marked NOT_SERVING: {}", serviceName);
    }

    /**
     * Returns the same bounded, fail-closed readiness decision exposed by the gRPC Check RPC.
     *
     * <p>This is used by the HTTP readiness sidecar and server lifecycle owner. It is false until
     * startup is explicitly marked ready, when required checks are absent, when any check fails,
     * or after draining begins.
     */
    @Override
    public boolean isServing() {
        return lifecycle.get() == LifecycleState.READY
                && !checks.isEmpty() && checks.keySet().containsAll(requiredChecks)
                && evaluateWithinDeadline(this::allChecksHealthy, false);
    }

    // ── gRPC Health Check Protocol ─────────────────────────────────────────

    @Override
    public void check(
            HealthCheckRequest request,
            StreamObserver<HealthCheckResponse> responseObserver) {

        HealthCheckResponse.ServingStatus status = currentStatus();
        metricsCollector.incrementCounter("av.health.check",
                "service", serviceName, "status", status.name().toLowerCase());

        respond(responseObserver, status);
    }

    @Override
    public void watch(
            HealthCheckRequest request,
            StreamObserver<HealthCheckResponse> responseObserver) {
        Objects.requireNonNull(responseObserver, "responseObserver");
        WatchSubscription subscription = new WatchSubscription(responseObserver);
        synchronized (watchLock) {
            if (closed) {
                responseObserver.onError(Status.UNAVAILABLE
                        .withDescription("Health service is shutting down").asRuntimeException());
                return;
            }
            if (watchSubscribers.size() >= MAX_WATCH_SUBSCRIBERS) {
                responseObserver.onError(Status.RESOURCE_EXHAUSTED
                        .withDescription("Health watch capacity reached").asRuntimeException());
                return;
            }
            watchSubscribers.add(subscription);
            startWatchPollingLocked();
        }
        if (responseObserver instanceof ServerCallStreamObserver<?> serverObserver) {
            try {
                serverObserver.setOnCancelHandler(() -> removeWatchSubscriber(subscription));
                if (serverObserver.isCancelled()) {
                    removeWatchSubscriber(subscription);
                    return;
                }
            } catch (RuntimeException observerFailure) {
                removeWatchSubscriber(subscription);
                throw observerFailure;
            }
        }

        HealthCheckResponse.ServingStatus status = currentStatus();
        metricsCollector.incrementCounter("av.health.check",
                "service", serviceName, "status", status.name().toLowerCase());
        try {
            subscription.sendInitial(status);
        } catch (RuntimeException observerFailure) {
            removeWatchSubscriber(subscription);
            throw observerFailure;
        }
    }

    // ── helpers ────────────────────────────────────────────────────────────

    private static void respond(
            StreamObserver<HealthCheckResponse> observer,
            HealthCheckResponse.ServingStatus status) {
        observer.onNext(HealthCheckResponse.newBuilder().setStatus(status).build());
        observer.onCompleted();
    }

    /**
     * Returns a snapshot of all check results for diagnostic purposes.
     *
     * @return map of check name → healthy
     */
    public Map<String, Boolean> getCheckResults() {
        Map<String, Supplier<Boolean>> snapshot = Map.copyOf(checks);
        return evaluateWithinDeadline(() -> {
            Map<String, Boolean> results = new ConcurrentHashMap<>();
            snapshot.forEach((name, check) -> {
                try {
                    results.put(name, Boolean.TRUE.equals(check.get()));
                } catch (RuntimeException failure) {
                    results.put(name, false);
                }
            });
            return Map.copyOf(results);
        }, Map.of());
    }

    @Override
    public void close() {
        Set<WatchSubscription> subscribersToComplete;
        synchronized (watchLock) {
            closed = true;
            subscribersToComplete = Set.copyOf(watchSubscribers);
            watchSubscribers.clear();
            if (watchPollTask != null) {
                watchPollTask.cancel(false);
                watchPollTask = null;
            }
        }
        setNotServing();
        watchPublisher.shutdownNow();
        checkExecutor.shutdownNow();
        for (WatchSubscription subscriber : subscribersToComplete) {
            try {
                subscriber.complete(HealthCheckResponse.ServingStatus.NOT_SERVING);
            } catch (RuntimeException observerFailure) {
                LOG.debug("Unable to complete a health Watch during shutdown (type={})",
                        observerFailure.getClass().getSimpleName());
            }
        }
    }

    private HealthCheckResponse.ServingStatus currentStatus() {
        return isServing()
                ? HealthCheckResponse.ServingStatus.SERVING
                : HealthCheckResponse.ServingStatus.NOT_SERVING;
    }

    int activeWatchSubscriberCount() {
        return watchSubscribers.size();
    }

    private void startWatchPollingLocked() {
        if (watchPollTask == null || watchPollTask.isDone()) {
            watchPollTask = watchPublisher.scheduleAtFixedRate(this::refreshWatchSubscribers,
                    WATCH_REFRESH_MILLIS, WATCH_REFRESH_MILLIS, TimeUnit.MILLISECONDS);
        }
    }

    private void removeWatchSubscriber(WatchSubscription subscription) {
        subscription.cancel();
        synchronized (watchLock) {
            watchSubscribers.remove(subscription);
            if (watchSubscribers.isEmpty() && watchPollTask != null) {
                watchPollTask.cancel(false);
                watchPollTask = null;
            }
        }
    }

    private void refreshWatchSubscribers() {
        if (closed) return;
        HealthCheckResponse.ServingStatus status = currentStatus();
        Set<WatchSubscription> snapshot;
        synchronized (watchLock) {
            if (closed || watchSubscribers.isEmpty()) return;
            snapshot = Set.copyOf(watchSubscribers);
        }
        for (WatchSubscription subscriber : snapshot) {
            try {
                if (subscriber.sendIfChanged(status)) {
                    metricsCollector.incrementCounter("av.health.check",
                            "service", serviceName, "status", status.name().toLowerCase());
                }
            } catch (RuntimeException observerFailure) {
                removeWatchSubscriber(subscriber);
            }
        }
    }

    private boolean allChecksHealthy() {
        Map<String, Supplier<Boolean>> snapshot = Map.copyOf(checks);
        if (snapshot.isEmpty() || !snapshot.keySet().containsAll(requiredChecks)) return false;
        for (Supplier<Boolean> check : snapshot.values()) {
            try {
                if (!Boolean.TRUE.equals(check.get())) return false;
            } catch (RuntimeException failure) {
                LOG.warn("A health dependency check failed for service={} (type={})",
                        serviceName, failure.getClass().getSimpleName());
                return false;
            }
        }
        return true;
    }

    private <T> T evaluateWithinDeadline(Callable<T> task, T failureValue) {
        Future<T> future;
        try {
            future = checkExecutor.submit(task);
        } catch (RejectedExecutionException overloaded) {
            LOG.warn("Health check capacity unavailable for service={}", serviceName);
            return failureValue;
        }
        try {
            return future.get(checkTimeoutNanos, TimeUnit.NANOSECONDS);
        } catch (TimeoutException timeout) {
            future.cancel(true);
            LOG.warn("Health check timed out for service={}", serviceName);
        } catch (InterruptedException interrupted) {
            future.cancel(true);
            Thread.currentThread().interrupt();
        } catch (ExecutionException failure) {
            LOG.warn("Health check failed for service={} (type={})", serviceName,
                    failure.getCause() == null ? "unknown" : failure.getCause().getClass().getSimpleName());
        }
        return failureValue;
    }

    private <T> T evaluateWithinDeadline(Callable<T> task) {
        return evaluateWithinDeadline(task, null);
    }

    private static String requireName(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(field + " must not be blank");
        }
        return value.trim();
    }

    private enum LifecycleState { STARTING, READY, DRAINING }

    private static final class WatchSubscription {
        private final StreamObserver<HealthCheckResponse> observer;
        private HealthCheckResponse.ServingStatus lastStatus;
        private boolean initialized;
        private boolean ended;

        private WatchSubscription(StreamObserver<HealthCheckResponse> observer) {
            this.observer = observer;
        }

        synchronized void sendInitial(HealthCheckResponse.ServingStatus status) {
            if (ended) return;
            observer.onNext(response(status));
            lastStatus = status;
            initialized = true;
        }

        synchronized boolean sendIfChanged(HealthCheckResponse.ServingStatus status) {
            if (ended || !initialized || status == lastStatus) return false;
            observer.onNext(response(status));
            lastStatus = status;
            return true;
        }

        synchronized void complete(HealthCheckResponse.ServingStatus finalStatus) {
            if (ended) return;
            try {
                if (!initialized || finalStatus != lastStatus) observer.onNext(response(finalStatus));
            } finally {
                ended = true;
            }
            observer.onCompleted();
        }

        synchronized void cancel() {
            ended = true;
        }

        private static HealthCheckResponse response(HealthCheckResponse.ServingStatus status) {
            return HealthCheckResponse.newBuilder().setStatus(status).build();
        }
    }
}

