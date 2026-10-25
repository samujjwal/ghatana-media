package com.ghatana.audiovideo.observability;

import com.ghatana.observability.MetricsCollector;
import io.grpc.health.v1.HealthCheckRequest;
import io.grpc.health.v1.HealthCheckResponse;
import io.grpc.health.v1.HealthGrpc;
import io.grpc.stub.StreamObserver;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

/**
 * gRPC health check service implementation for Audio-Video services.
 *
 * <p>Implements the standard gRPC Health Checking Protocol (grpc.health.v1.Health).
 * Each Audio-Video gRPC server (STT, TTS, Vision, Multimodal) registers this
 * service to expose a standardised {@code /health} probe.
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
public class AudioVideoHealthService extends HealthGrpc.HealthImplBase {

    private static final Logger LOG = LoggerFactory.getLogger(AudioVideoHealthService.class);

    private final Map<String, Supplier<Boolean>> checks = new ConcurrentHashMap<>();
    private final Set<String> requiredChecks;
    private final AtomicReference<LifecycleState> lifecycle = new AtomicReference<>(LifecycleState.STARTING);
    private final MetricsCollector metricsCollector;
    private final String serviceName;

    public AudioVideoHealthService(String serviceName, MetricsCollector metricsCollector) {
        this(serviceName, metricsCollector, Set.of());
    }

    /**
     * Construct health readiness with an explicit set of checks that must be registered before
     * the service may be marked ready.
     */
    public AudioVideoHealthService(String serviceName, MetricsCollector metricsCollector,
                                   Set<String> requiredChecks) {
        this.serviceName = requireName(serviceName, "serviceName");
        this.metricsCollector = Objects.requireNonNull(metricsCollector, "metricsCollector");
        Objects.requireNonNull(requiredChecks, "requiredChecks");
        this.requiredChecks = requiredChecks.stream()
                .map(name -> requireName(name, "required check name"))
                .collect(java.util.stream.Collectors.toUnmodifiableSet());
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

    // ── gRPC Health Check Protocol ─────────────────────────────────────────

    @Override
    public void check(
            HealthCheckRequest request,
            StreamObserver<HealthCheckResponse> responseObserver) {

        boolean allHealthy = lifecycle.get() == LifecycleState.READY
                && !checks.isEmpty() && checks.keySet().containsAll(requiredChecks)
                && checks.entrySet().stream()
                .allMatch(e -> {
                    try {
                        boolean ok = e.getValue().get();
                        if (!ok) LOG.warn("Health check failing: service={} check={}", serviceName, e.getKey());
                        return ok;
                    } catch (Exception ex) {
                        LOG.error("Health check threw exception: service={} check={}: {}",
                                serviceName, e.getKey(), ex.getMessage());
                        return false;
                    }
                });

        HealthCheckResponse.ServingStatus status = allHealthy
                ? HealthCheckResponse.ServingStatus.SERVING
                : HealthCheckResponse.ServingStatus.NOT_SERVING;

        metricsCollector.incrementCounter("av.health.check",
                "service", serviceName, "status", status.name().toLowerCase());

        respond(responseObserver, status);
    }

    @Override
    public void watch(
            HealthCheckRequest request,
            StreamObserver<HealthCheckResponse> responseObserver) {
        // Emit current status and keep stream open — simplified (single-shot for now)
        check(request, new StreamObserver<>() {
            @Override
            public void onNext(HealthCheckResponse value) {
                responseObserver.onNext(value);
            }

            @Override
            public void onError(Throwable t) {
                responseObserver.onError(t);
            }

            @Override
            public void onCompleted() {
                // Do not complete the watch stream — clients expect it to stay open
            }
        });
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
        Map<String, Boolean> results = new ConcurrentHashMap<>();
        checks.forEach((name, check) -> {
            try {
                results.put(name, check.get());
            } catch (Exception e) {
                results.put(name, false);
            }
        });
        return results;
    }

    private static String requireName(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(field + " must not be blank");
        }
        return value.trim();
    }

    private enum LifecycleState { STARTING, READY, DRAINING }
}

