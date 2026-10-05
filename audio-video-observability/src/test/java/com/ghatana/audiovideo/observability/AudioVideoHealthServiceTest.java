package com.ghatana.audiovideo.observability;

import com.ghatana.observability.MetricsCollector;
import io.grpc.health.v1.HealthCheckRequest;
import io.grpc.health.v1.HealthCheckResponse;
import io.grpc.stub.StreamObserver;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

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

    @Test
    @DisplayName("Returns SERVING when no checks registered")
    void shouldReturnServingWithNoChecks() { 
        CapturingObserver observer = new CapturingObserver(); 

        healthService.check(HealthCheckRequest.newBuilder().build(), observer); 

        assertThat(observer.responses).hasSize(1); 
        assertThat(observer.responses.get(0).getStatus()) 
                .isEqualTo(HealthCheckResponse.ServingStatus.SERVING); 
    }

    @Test
    @DisplayName("Returns SERVING when all checks pass")
    void shouldReturnServingWhenAllChecksPass() { 
        healthService.registerCheck("channel", () -> true); 
        healthService.registerCheck("model-loaded", () -> true); 

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

        CapturingObserver observer = new CapturingObserver(); 
        healthService.check(HealthCheckRequest.newBuilder().build(), observer); 

        assertThat(observer.responses.get(0).getStatus()) 
                .isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING); 
    }

    @Test
    @DisplayName("Returns NOT_SERVING after setNotServing() is called")
    void shouldReturnNotServingAfterShutdown() { 
        healthService.registerCheck("all-good", () -> true); 

        healthService.setNotServing(); 

        CapturingObserver observer = new CapturingObserver(); 
        healthService.check(HealthCheckRequest.newBuilder().build(), observer); 

        assertThat(observer.responses.get(0).getStatus()) 
                .isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING); 
    }

    @Test
    @DisplayName("Emits metric counter on every Check call")
    void shouldEmitMetricOnEveryCheck() { 
        CapturingObserver observer = new CapturingObserver(); 
        healthService.check(HealthCheckRequest.newBuilder().build(), observer); 

        verify(metricsCollector).incrementCounter( 
                "av.health.check", "service", "stt-service", "status", "serving");
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

