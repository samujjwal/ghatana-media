package com.ghatana.audiovideo.observability;

import com.ghatana.observability.MetricsCollector;
import io.grpc.health.v1.HealthCheckRequest;
import io.grpc.health.v1.HealthCheckResponse;
import io.grpc.stub.StreamObserver;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.verify;

/**
 * @doc.type class
 * @doc.purpose Unit tests for AudioVideoHealthService gRPC health checking (AV-P1-06) 
 * @doc.layer test
 * @doc.pattern Test
 */
@ExtendWith(MockitoExtension.class) 
@DisplayName("AudioVideoHealthService Tests (AV-P1-06)")
class AudioVideoHealthServiceTest {

    @Mock
    private MetricsCollector metricsCollector;

    private AudioVideoHealthService healthService;

    @BeforeEach
    void setUp() { 
        healthService = new AudioVideoHealthService("stt-service", metricsCollector); 
        lenient().doNothing().when(metricsCollector).incrementCounter(anyString(), any(String[].class)); 
    }

    @AfterEach
    void closeHealthService() {
        healthService.close();
    }

    @Test
    @DisplayName("Returns NOT_SERVING when no checks are registered")
    void shouldReturnNotServingWithNoChecks() {
        CapturingObserver observer = new CapturingObserver(); 

        healthService.check(HealthCheckRequest.newBuilder().build(), observer); 

        assertThat(observer.responses).hasSize(1); 
        assertThat(observer.responses.get(0).getStatus()) 
                .isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);
    }

    @Test
    @DisplayName("Returns SERVING when all checks pass")
    void shouldReturnServingWhenAllChecksPass() { 
        healthService.registerCheck("channel", () -> true); 
        healthService.registerCheck("model-loaded", () -> true); 
        assertThat(healthService.markReady()).isTrue();

        CapturingObserver observer = new CapturingObserver(); 
        healthService.check(HealthCheckRequest.newBuilder().build(), observer); 

        assertThat(observer.responses.get(0).getStatus()) 
                .isEqualTo(HealthCheckResponse.ServingStatus.SERVING); 
    }

    @Test
    @DisplayName("Returns NOT_SERVING when any check fails")
    void shouldReturnNotServingWhenAnyCheckFails() { 
        healthService.registerCheck("channel", () -> true); 
        healthService.registerCheck("model-loaded", () -> false); // failing 
        assertThat(healthService.markReady()).isTrue();

        CapturingObserver observer = new CapturingObserver(); 
        healthService.check(HealthCheckRequest.newBuilder().build(), observer); 

        assertThat(observer.responses.get(0).getStatus()) 
                .isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING); 
    }

    @Test
    @DisplayName("Returns NOT_SERVING when check throws exception")
    void shouldReturnNotServingWhenCheckThrows() { 
        healthService.registerCheck("crashing-check", () -> { 
            throw new RuntimeException("dependency unavailable");
        });
        assertThat(healthService.markReady()).isTrue();

        CapturingObserver observer = new CapturingObserver(); 
        healthService.check(HealthCheckRequest.newBuilder().build(), observer); 

        assertThat(observer.responses.get(0).getStatus()) 
                .isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING); 
    }

    @Test
    @DisplayName("Returns NOT_SERVING after setNotServing() is called")
    void shouldReturnNotServingAfterShutdown() { 
        healthService.registerCheck("all-good", () -> true); 
        assertThat(healthService.markReady()).isTrue();

        healthService.setNotServing(); 
        assertThat(healthService.markReady()).isFalse();

        CapturingObserver observer = new CapturingObserver(); 
        healthService.check(HealthCheckRequest.newBuilder().build(), observer); 

        assertThat(observer.responses.get(0).getStatus()) 
                .isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING); 
    }

    @Test
    @DisplayName("Emits metric counter on every Check call")
    void shouldEmitMetricOnEveryCheck() { 
        healthService.registerCheck("ready", () -> true);
        assertThat(healthService.markReady()).isTrue();
        CapturingObserver observer = new CapturingObserver(); 
        healthService.check(HealthCheckRequest.newBuilder().build(), observer); 

        verify(metricsCollector).incrementCounter( 
                "av.health.check", "service", "stt", "status", "serving");
    }

    @Test
    @DisplayName("Emits NOT_SERVING metric when no checks are registered")
    void shouldEmitNotServingMetricWithNoChecks() {
        CapturingObserver observer = new CapturingObserver();

        healthService.check(HealthCheckRequest.newBuilder().build(), observer);

        assertThat(observer.responses).hasSize(1);
        assertThat(observer.responses.get(0).getStatus())
                .isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);
        verify(metricsCollector).incrementCounter(
                "av.health.check", "service", "stt", "status", "not_serving");
    }

    @Test
    @DisplayName("Collapses unrecognized service configuration before emitting metric labels")
    void healthMetricsUseBoundedServiceVocabulary() {
        AudioVideoHealthService healthWithSensitiveServiceName = new AudioVideoHealthService(
                "tenant-secret-model-path-42", metricsCollector);
        try {
            CapturingObserver observer = new CapturingObserver();
            healthWithSensitiveServiceName.check(HealthCheckRequest.getDefaultInstance(), observer);

            verify(metricsCollector).incrementCounter(
                    "av.health.check", "service", "unknown", "status", "not_serving");
        } finally {
            healthWithSensitiveServiceName.close();
        }
    }

    @Test
    @DisplayName("getCheckResults returns correct status map")
    void shouldReturnCorrectCheckResults() { 
        healthService.registerCheck("ok-check", () -> true); 
        healthService.registerCheck("fail-check", () -> false); 

        Map<String, Boolean> results = healthService.getCheckResults(); 

        assertThat(results).containsEntry("ok-check", true); 
        assertThat(results).containsEntry("fail-check", false); 
    }

    @Test
    @DisplayName("Stays NOT_SERVING after checks register until readiness is explicitly marked")
    void startupRequiresExplicitReadyTransition() {
        healthService.registerCheck("provider", () -> true);

        assertThat(healthService.isServing()).isFalse();

        CapturingObserver beforeReady = new CapturingObserver();
        healthService.check(HealthCheckRequest.getDefaultInstance(), beforeReady);
        assertThat(beforeReady.responses.get(0).getStatus())
                .isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);

        assertThat(healthService.markReady()).isTrue();
        assertThat(healthService.isServing()).isTrue();
        CapturingObserver afterReady = new CapturingObserver();
        healthService.check(HealthCheckRequest.getDefaultInstance(), afterReady);
        assertThat(afterReady.responses.get(0).getStatus())
                .isEqualTo(HealthCheckResponse.ServingStatus.SERVING);
    }

    @Test
    @DisplayName("Required checks must be registered before readiness")
    void requiredChecksMustBeRegisteredBeforeReady() {
        AudioVideoHealthService requiredHealth = new AudioVideoHealthService(
                "stt-service", metricsCollector, java.util.Set.of("provider", "model"));
        requiredHealth.registerCheck("provider", () -> true);

        assertThat(requiredHealth.markReady()).isFalse();
        assertThat(requiredHealth.isServing()).isFalse();
        CapturingObserver observer = new CapturingObserver();
        requiredHealth.check(HealthCheckRequest.getDefaultInstance(), observer);
        assertThat(observer.responses.get(0).getStatus())
                .isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);

        requiredHealth.registerCheck("model", () -> true);
        assertThat(requiredHealth.markReady()).isTrue();
        assertThat(requiredHealth.isServing()).isTrue();
        requiredHealth.close();
    }

    @Test
    @DisplayName("Provider failure and drain immediately make readiness false")
    void providerFailureAndDrainMakeReadinessFalse() {
        java.util.concurrent.atomic.AtomicBoolean providerReady = new java.util.concurrent.atomic.AtomicBoolean(true);
        AudioVideoHealthService readiness = new AudioVideoHealthService(
                "stt-service", metricsCollector, java.util.Set.of("provider"));
        readiness.registerCheck("provider", providerReady::get);

        assertThat(readiness.markReady()).isTrue();
        assertThat(readiness.isServing()).isTrue();
        providerReady.set(false);
        assertThat(readiness.isServing()).isFalse();

        providerReady.set(true);
        readiness.setNotServing();
        assertThat(readiness.isServing()).isFalse();
        assertThat(readiness.markReady()).isFalse();
        readiness.close();
    }

    @Test
    @DisplayName("Rejects blank names and null provider checks")
    void rejectsInvalidCheckRegistration() {
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> healthService.registerCheck("  ", () -> true))
                .isInstanceOf(IllegalArgumentException.class);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> healthService.registerCheck("provider", null))
                .isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("Changing checks after readiness returns service to NOT_SERVING")
    void changingCheckAfterReadyRequiresReadyTransitionAgain() {
        healthService.registerCheck("provider", () -> true);
        assertThat(healthService.markReady()).isTrue();
        healthService.registerCheck("model", () -> true);

        CapturingObserver observer = new CapturingObserver();
        healthService.check(HealthCheckRequest.getDefaultInstance(), observer);
        assertThat(observer.responses.get(0).getStatus())
                .isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);
        assertThat(healthService.markReady()).isTrue();
    }

    @Test
    @DisplayName("A slow provider check returns NOT_SERVING within the configured probe deadline")
    void slowProviderCheckTimesOutWithinBound() throws InterruptedException {
        AudioVideoHealthService bounded = new AudioVideoHealthService(
                "stt-service", metricsCollector, java.util.Set.of("provider"), Duration.ofMillis(50));
        CountDownLatch checkStarted = new CountDownLatch(1);
        CountDownLatch releaseCheck = new CountDownLatch(1);
        bounded.registerCheck("provider", () -> {
            checkStarted.countDown();
            try {
                releaseCheck.await();
                return true;
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return false;
            }
        });
        assertThat(bounded.markReady()).isTrue();

        long startedAt = System.nanoTime();
        CapturingObserver observer = new CapturingObserver();
        bounded.check(HealthCheckRequest.getDefaultInstance(), observer);
        long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt);

        assertThat(checkStarted.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(observer.responses.get(0).getStatus())
                .isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);
        assertThat(elapsedMs).isLessThan(500L);
        releaseCheck.countDown();
        bounded.close();
    }

    @Test
    @DisplayName("Health response contains no check names or exception detail")
    void healthResponseDoesNotExposeSensitiveCheckMarkers() {
        String marker = "tenant-secret-model-token-marker";
        healthService.registerCheck(marker, () -> {
            throw new IllegalStateException(marker);
        });
        assertThat(healthService.markReady()).isTrue();

        CapturingObserver observer = new CapturingObserver();
        healthService.check(HealthCheckRequest.getDefaultInstance(), observer);

        assertThat(observer.responses.get(0).getStatus())
                .isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);
        assertThat(observer.responses.get(0).toString()).doesNotContain(marker);
    }

    // ── helpers ────────────────────────────────────────────────────────────

    private static class CapturingObserver implements StreamObserver<HealthCheckResponse> {
        final List<HealthCheckResponse> responses = new ArrayList<>(); 
        Throwable error;
        boolean completed;

        @Override
        public void onNext(HealthCheckResponse value) { 
            responses.add(value); 
        }

        @Override
        public void onError(Throwable t) { 
            error = t;
        }

        @Override
        public void onCompleted() { 
            completed = true;
        }
    }
}

