package com.ghatana.audio.video.vision.recognition;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import io.grpc.Context;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class FacialRecognitionServiceAdmissionTest {
    private static final Instant NOW = Instant.parse("2026-10-25T12:00:00Z");
    private static final Clock CLOCK = Clock.fixed(NOW, ZoneOffset.UTC);
    private static final JwtServerInterceptor.VerifiedIdentity IDENTITY =
            new JwtServerInterceptor.VerifiedIdentity("principal-a", "tenant-a");
    private static final FacialRecognitionService.BiometricRequest REQUEST =
            new FacialRecognitionService.BiometricRequest(
                    FacialRecognitionService.BiometricOperation.FACE_DETECTION,
                    "artifact-1", "version-2", "safety-review", "region-a", "ephemeral");

    @Test
    void crossTenantDecisionIsRejectedBeforeCallingTheFaceProvider() {
        AtomicInteger providerCalls = new AtomicInteger();
        var service = service(providerCalls, (identity, request) -> admitted(
                "tenant-other", identity.subject(), request));

        assertThatThrownBy(() -> service.detect(new byte[] {1}, REQUEST))
                .isInstanceOf(FacialRecognitionService.NotAdmittedException.class);
        org.assertj.core.api.Assertions.assertThat(providerCalls).hasValue(0);
    }

    @Test
    void currentMatchingAdmissionReachesTheFaceProviderOnce() {
        AtomicInteger providerCalls = new AtomicInteger();
        var service = service(providerCalls, (identity, request) -> admitted(
                identity.tenantId(), identity.subject(), request));

        List<FaceDetection> detections = service.detect(new byte[] {1}, REQUEST);

        assertThat(detections).isEmpty();
        assertThat(providerCalls).hasValue(1);
    }

    @Test
    void revokedOrPurposeDeniedDecisionHasNoProviderEffect() {
        AtomicInteger providerCalls = new AtomicInteger();
        var service = service(providerCalls,
                (identity, request) -> FacialRecognitionService.BiometricAdmission.denied(
                        "CONSENT_REVOKED_OR_PURPOSE_NOT_ALLOWED"));

        assertThatThrownBy(() -> service.detect(new byte[] {1}, REQUEST))
                .isInstanceOf(FacialRecognitionService.NotAdmittedException.class);
        org.assertj.core.api.Assertions.assertThat(providerCalls).hasValue(0);
    }

    @Test
    void callerPolicyLabelsCannotAuthorizeWhenNoResolverIsConfigured() {
        AtomicInteger providerCalls = new AtomicInteger();
        var service = FacialRecognitionService.of(image -> {
            providerCalls.incrementAndGet();
            return List.of();
        });

        assertThatThrownBy(() -> service.detect(new byte[] {1}, REQUEST))
                .isInstanceOf(FacialRecognitionService.NotAdmittedException.class);
        org.assertj.core.api.Assertions.assertThat(providerCalls).hasValue(0);
    }

    @Test
    void forgedPublicTenantAndPrincipalContextCannotReachTheResolver() {
        AtomicInteger providerCalls = new AtomicInteger();
        AtomicInteger resolverCalls = new AtomicInteger();
        var service = FacialRecognitionService.of(image -> {
            providerCalls.incrementAndGet();
            return List.of();
        }, (identity, request) -> {
            resolverCalls.incrementAndGet();
            return admitted(identity.tenantId(), identity.subject(), request);
        });

        Context.ROOT
                .withValue(JwtServerInterceptor.CTX_SUBJECT, IDENTITY.subject())
                .withValue(JwtServerInterceptor.CTX_TENANT, IDENTITY.tenantId())
                .run(() -> assertThatThrownBy(() -> service.detect(new byte[] {1}, REQUEST))
                        .isInstanceOf(FacialRecognitionService.NotAdmittedException.class));

        org.assertj.core.api.Assertions.assertThat(resolverCalls).hasValue(0);
        org.assertj.core.api.Assertions.assertThat(providerCalls).hasValue(0);
    }

    @Test
    void staleDecisionIsRejectedBeforeCallingTheFaceProvider() {
        AtomicInteger providerCalls = new AtomicInteger();
        var service = service(providerCalls, (identity, request) -> {
            var current = admitted(identity.tenantId(), identity.subject(), request);
            return new FacialRecognitionService.BiometricAdmission(
                    current.allowed(), current.tenantId(), current.principalId(), current.operation(),
                    current.sourceArtifactId(), current.sourceVersion(), current.purpose(), current.region(),
                    current.retentionPolicy(), current.decisionRef(), NOW.minusSeconds(1), NOW,
                    current.denialReason());
        });

        assertThatThrownBy(() -> service.detect(new byte[] {1}, REQUEST))
                .isInstanceOf(FacialRecognitionService.NotAdmittedException.class);
        org.assertj.core.api.Assertions.assertThat(providerCalls).hasValue(0);
    }

    private static FacialRecognitionService service(
            AtomicInteger providerCalls,
            FacialRecognitionService.BiometricAdmissionResolver resolver) {
        return FacialRecognitionService.ofForTesting(image -> {
            providerCalls.incrementAndGet();
            return List.of();
        }, resolver, () -> IDENTITY, CLOCK);
    }

    private static FacialRecognitionService.BiometricAdmission admitted(
            String tenant,
            String principal,
            FacialRecognitionService.BiometricRequest request) {
        return new FacialRecognitionService.BiometricAdmission(true, tenant, principal,
                request.operation(), request.sourceArtifactId(), request.sourceVersion(), request.purpose(),
                request.region(), request.retentionPolicy(), "authority-decision-1", NOW,
                NOW.plusSeconds(30), "");
    }
}
