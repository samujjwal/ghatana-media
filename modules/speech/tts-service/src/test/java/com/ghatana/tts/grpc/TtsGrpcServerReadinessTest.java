package com.ghatana.tts.grpc;

import com.ghatana.audiovideo.observability.AudioVideoHealthService;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.tts.api.TtsEngine;
import io.grpc.health.v1.HealthCheckRequest;
import io.grpc.health.v1.HealthCheckResponse;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class TtsGrpcServerReadinessTest {

    @Test
    void absentProviderRemainsNotServingAndDoesNotStartProviderEffects() {
        AtomicInteger readinessChecks = new AtomicInteger();
        AudioVideoHealthService readiness = TtsGrpcServer.createReadinessLifecycle(
                new SimpleMeterRegistry(), () -> {
                    readinessChecks.incrementAndGet();
                    return false;
                });
        try {
            assertThat(readiness.markReady()).isTrue();
            assertThat(check(readiness)).isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);
            assertThat(readinessChecks).hasValue(1);
        } finally {
            readiness.close();
        }
    }

    @Test
    void standardGrpcReadinessTracksProviderFailureAndRecovery() {
        AtomicBoolean providerReady = new AtomicBoolean(true);
        AudioVideoHealthService readiness = TtsGrpcServer.createReadinessLifecycle(
                new SimpleMeterRegistry(), providerReady::get);
        try {
            assertThat(readiness.markReady()).isTrue();
            assertThat(check(readiness)).isEqualTo(HealthCheckResponse.ServingStatus.SERVING);

            providerReady.set(false);
            assertThat(check(readiness)).isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);

            providerReady.set(true);
            assertThat(check(readiness)).isEqualTo(HealthCheckResponse.ServingStatus.SERVING);

            readiness.setNotServing();
            assertThat(check(readiness)).isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);
        } finally {
            readiness.close();
        }
    }

    @Test
    void productionReadinessUsesEngineStatusWithoutClosingBorrowedEngine() {
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        TtsEngine engine = mock(TtsEngine.class);
        when(library.getTtsEngine()).thenReturn(engine);
        when(engine.getStatus()).thenReturn(
                new EngineStatus(EngineStatus.State.READY, "model", "v1", 1L, null),
                new EngineStatus(EngineStatus.State.ERROR, "model", "v1", 2L, "redacted"));
        ProductionTtsGrpcService service = new ProductionTtsGrpcService(
                library, new SimpleMeterRegistry(), localFixtureAdmissionDecision(),
                "fixture-voice", "en-US", readyFixtureAuthorization());
        try {
            assertThat(service.isProviderReady()).isTrue();
            assertThat(service.isProviderReady()).isFalse();
            verify(engine, never()).close();
        } finally {
            service.close();
        }
    }

    @Test
    void providerHealthCannotAdvertiseReadyWithoutVoiceAuthorizationResolver() {
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        ProductionTtsGrpcService service = new ProductionTtsGrpcService(
                library, new SimpleMeterRegistry(), localFixtureAdmissionDecision());
        try {
            assertThat(service.isProviderReady()).isFalse();
            verify(library, never()).getTtsEngine();
        } finally {
            service.close();
        }
    }

    @Test
    void configuredButUnreadyVoiceAuthorityKeepsProviderNotReady() {
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        TtsRequestAuthorization configuredButUnready = new TtsRequestAuthorization() {
            @Override
            public Decision authorize(Request request) {
                return Decision.ADMITTED;
            }

            @Override
            public boolean isConfigured() {
                return true;
            }
        };
        ProductionTtsGrpcService service = new ProductionTtsGrpcService(
                library, new SimpleMeterRegistry(), localFixtureAdmissionDecision(),
                "fixture-voice", "en-US", configuredButUnready);
        try {
            assertThat(service.isProviderReady()).isFalse();
            verify(library, never()).getTtsEngine();
        } finally {
            service.close();
        }
    }

    @Test
    void productionServerStillRejectsUnadmittedProviderBeforeBinding() {
        assertThatThrownBy(() -> new TtsGrpcServer(
                0, com.ghatana.audio.video.common.AudioVideoGrpcServerBase.TransportSecurity.plaintext()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("TTS_PROVIDER_NOT_ADMITTED");
    }

    private static HealthCheckResponse.ServingStatus check(AudioVideoHealthService readiness) {
        CapturingObserver observer = new CapturingObserver();
        readiness.check(HealthCheckRequest.getDefaultInstance(), observer);
        return observer.response.getStatus();
    }

    private static TtsProviderAdmission.Decision localFixtureAdmissionDecision() {
        TtsProviderAdmission localFixtureResolver = candidate -> new TtsProviderAdmission.Decision(
                java.util.Set.of(TtsProviderAdmission.Capability.SYNTHESIS),
                "local-fixture-resolver:test-only", "readiness fixture only");
        return localFixtureResolver.resolve(new TtsProviderAdmission.Candidate(
                "LOCAL_FIXTURE", "fixture", "fixture", "fixture", "fixture", "en-US",
                "test", "test", "test", "fixture-voice"));
    }

    private static TtsRequestAuthorization readyFixtureAuthorization() {
        return new TtsRequestAuthorization() {
            @Override
            public Decision authorize(Request request) {
                return Decision.ADMITTED;
            }

            @Override
            public boolean isReady() {
                return true;
            }
        };
    }

    private static final class CapturingObserver implements StreamObserver<HealthCheckResponse> {
        private HealthCheckResponse response;

        @Override
        public void onNext(HealthCheckResponse value) {
            response = value;
        }

        @Override
        public void onError(Throwable failure) {
            throw new AssertionError(failure);
        }

        @Override
        public void onCompleted() { }
    }
}
