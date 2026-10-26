package com.ghatana.tts.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import io.grpc.Status;
import org.junit.jupiter.api.Test;

import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class TtsRequestAuthorizationTest {
    private static final JwtServerInterceptor.VerifiedIdentity IDENTITY =
            new JwtServerInterceptor.VerifiedIdentity("subject-1", "tenant-1");

    @Test
    void absentResolverIsUnavailableForSelectedVoiceAndIgnoresCallerConsentClaims() {
        assertThatThrownBy(() -> TtsRequestAuthorization.requireAdmission(
                TtsRequestAuthorization.unavailable(), IDENTITY,
                TtsRequestAuthorization.Operation.SYNTHESIZE, "voice-1", null))
                .isInstanceOf(TtsRequestAuthorization.AuthorizationException.class)
                .satisfies(failure -> {
                    var authorization = (TtsRequestAuthorization.AuthorizationException) failure;
                    assertThat(authorization.status().getCode()).isEqualTo(Status.Code.UNAVAILABLE);
                    assertThat(authorization.getMessage()).contains("consent", "revocation", "NOT_ADMITTED");
                });
    }

    @Test
    void resolverReceivesOnlyVerifiedIdentityAndSelectedResourceForEachRequest() {
        AtomicReference<TtsRequestAuthorization.Request> observed = new AtomicReference<>();
        TtsRequestAuthorization resolver = request -> {
            observed.set(request);
            return TtsRequestAuthorization.Decision.DENIED;
        };

        assertThatThrownBy(() -> TtsRequestAuthorization.requireAdmission(
                resolver, IDENTITY, TtsRequestAuthorization.Operation.STREAM_SYNTHESIZE,
                "voice-1", "profile-1"))
                .isInstanceOf(TtsRequestAuthorization.AuthorizationException.class)
                .satisfies(failure -> assertThat(
                        ((TtsRequestAuthorization.AuthorizationException) failure).status().getCode())
                        .isEqualTo(Status.Code.PERMISSION_DENIED));

        assertThat(observed.get()).isEqualTo(new TtsRequestAuthorization.Request(
                IDENTITY, TtsRequestAuthorization.Operation.STREAM_SYNTHESIZE, "voice-1", "profile-1"));
    }

    @Test
    void deniedAndRevokedDecisionsFailClosedAndResolverExceptionsBecomeUnavailable() {
        for (TtsRequestAuthorization.Decision decision : new TtsRequestAuthorization.Decision[] {
                TtsRequestAuthorization.Decision.DENIED,
                TtsRequestAuthorization.Decision.REVOKED
        }) {
            assertThatThrownBy(() -> TtsRequestAuthorization.requireAdmission(
                    request -> decision, IDENTITY, TtsRequestAuthorization.Operation.SYNTHESIZE,
                    "voice-1", null))
                    .isInstanceOf(TtsRequestAuthorization.AuthorizationException.class)
                    .satisfies(failure -> assertThat(
                            ((TtsRequestAuthorization.AuthorizationException) failure).status().getCode())
                            .isEqualTo(Status.Code.PERMISSION_DENIED));
        }

        assertThatThrownBy(() -> TtsRequestAuthorization.requireAdmission(
                request -> { throw new IllegalStateException("private resolver failure"); },
                IDENTITY, TtsRequestAuthorization.Operation.SYNTHESIZE, "voice-1", null))
                .isInstanceOf(TtsRequestAuthorization.AuthorizationException.class)
                .satisfies(failure -> {
                    var authorization = (TtsRequestAuthorization.AuthorizationException) failure;
                    assertThat(authorization.status().getCode()).isEqualTo(Status.Code.UNAVAILABLE);
                    assertThat(authorization.getMessage()).doesNotContain("private resolver failure", "voice-1");
                });
    }

    @Test
    void missingVerifiedIdentityCannotBeReplacedByCallerMetadata() {
        assertThatThrownBy(() -> TtsRequestAuthorization.requireAdmission(
                request -> TtsRequestAuthorization.Decision.ADMITTED, null,
                TtsRequestAuthorization.Operation.SYNTHESIZE, "voice-1", null))
                .isInstanceOf(TtsRequestAuthorization.AuthorizationException.class)
                .satisfies(failure -> assertThat(
                        ((TtsRequestAuthorization.AuthorizationException) failure).status().getCode())
                        .isEqualTo(Status.Code.UNAUTHENTICATED));
    }

    @Test
    void missingVoiceAndProfileWithoutConfiguredDefaultFailsNotAdmitted() {
        AtomicReference<TtsRequestAuthorization.Request> observed = new AtomicReference<>();
        TtsRequestAuthorization resolver = request -> {
            observed.set(request);
            return TtsRequestAuthorization.Decision.ADMITTED;
        };

        assertThatThrownBy(() -> TtsRequestAuthorization.requireAdmission(resolver, IDENTITY,
                TtsRequestAuthorization.Operation.SYNTHESIZE, null, "  "))
                .isInstanceOf(TtsRequestAuthorization.AuthorizationException.class)
                .satisfies(failure -> {
                    var authorization = (TtsRequestAuthorization.AuthorizationException) failure;
                    assertThat(authorization.status().getCode()).isEqualTo(Status.Code.UNAVAILABLE);
                    assertThat(authorization.getMessage()).contains("VOICE_SELECTION_NOT_ADMITTED");
                });
        assertThat(observed).hasValue(null);
    }

    @Test
    void explicitProfileIsAnAuthorizedSelectionAndStillRequiresResolverDecision() {
        AtomicReference<TtsRequestAuthorization.Request> observed = new AtomicReference<>();
        TtsRequestAuthorization resolver = request -> {
            observed.set(request);
            return TtsRequestAuthorization.Decision.ADMITTED;
        };

        TtsRequestAuthorization.requireAdmission(resolver, IDENTITY,
                TtsRequestAuthorization.Operation.SYNTHESIZE, null, "profile-1");
        assertThat(observed.get()).isEqualTo(new TtsRequestAuthorization.Request(
                IDENTITY, TtsRequestAuthorization.Operation.SYNTHESIZE, null, "profile-1"));
    }

    @Test
    void resolverReceivesExactConfiguredDefaultVoiceAndControlsAdmission() {
        AtomicReference<TtsRequestAuthorization.Request> observed = new AtomicReference<>();
        TtsRequestAuthorization resolver = new TtsRequestAuthorization() {
            @Override public Decision authorize(Request request) {
                observed.set(request);
                return Decision.DENIED;
            }
            @Override public String configuredDefaultVoiceId() { return "configured-test-voice"; }
        };

        assertThatThrownBy(() -> TtsRequestAuthorization.requireAdmission(resolver, IDENTITY,
                TtsRequestAuthorization.Operation.SYNTHESIZE, null, null))
                .isInstanceOf(TtsRequestAuthorization.AuthorizationException.class)
                .satisfies(failure -> assertThat(
                        ((TtsRequestAuthorization.AuthorizationException) failure).status().getCode())
                        .isEqualTo(Status.Code.PERMISSION_DENIED));

        assertThat(observed.get()).isEqualTo(new TtsRequestAuthorization.Request(
                IDENTITY, TtsRequestAuthorization.Operation.SYNTHESIZE,
                "configured-test-voice", null));
    }

    @Test
    void selectedConfiguredDefaultVoiceRequiresIdentityAndAuthorization() {
        TtsRequestAuthorization defaultVoice = ProductionTtsGrpcService.bindConfiguredDefaultVoice(
                TtsRequestAuthorization.unavailable(), "piper-en");
        assertThatThrownBy(() -> TtsRequestAuthorization.requireAdmission(
                defaultVoice, IDENTITY,
                TtsRequestAuthorization.Operation.SYNTHESIZE, "piper-en", null))
                .isInstanceOf(TtsRequestAuthorization.AuthorizationException.class)
                .satisfies(failure -> assertThat(
                        ((TtsRequestAuthorization.AuthorizationException) failure).status().getCode())
                        .isEqualTo(Status.Code.UNAVAILABLE));

        assertThatThrownBy(() -> TtsRequestAuthorization.requireAdmission(
                ProductionTtsGrpcService.bindConfiguredDefaultVoice(
                        request -> TtsRequestAuthorization.Decision.ADMITTED, "piper-en"), null,
                TtsRequestAuthorization.Operation.SYNTHESIZE, null, null))
                .isInstanceOf(TtsRequestAuthorization.AuthorizationException.class)
                .satisfies(failure -> assertThat(
                        ((TtsRequestAuthorization.AuthorizationException) failure).status().getCode())
                        .isEqualTo(Status.Code.UNAUTHENTICATED));

        AtomicReference<TtsRequestAuthorization.Request> observed = new AtomicReference<>();
        TtsRequestAuthorization admittedDefault = ProductionTtsGrpcService.bindConfiguredDefaultVoice(
                request -> {
                    observed.set(request);
                    return TtsRequestAuthorization.Decision.ADMITTED;
                }, "piper-en");
        TtsRequestAuthorization.requireAdmission(admittedDefault, IDENTITY,
                TtsRequestAuthorization.Operation.SYNTHESIZE, null, null);
        assertThat(observed.get().voiceId()).isEqualTo("piper-en");
    }
}
