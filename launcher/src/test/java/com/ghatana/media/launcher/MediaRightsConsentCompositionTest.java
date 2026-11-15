package com.ghatana.media.launcher;

import com.ghatana.media.runtime.InMemoryMediaRightsAttestationStore;
import com.ghatana.media.runtime.MediaRightsConsentAuthority;
import com.ghatana.media.runtime.MediaRightsConsentAuthority.AttestRequest;
import com.ghatana.media.runtime.MediaRightsConsentAuthority.Code;
import com.ghatana.media.runtime.MediaRightsConsentAuthority.RightsConsentException;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.ghatana.media.runtime.MediaRightsConsentContracts.StatementKind;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import com.ghatana.media.runtime.MediaVerifiedIdentityContracts.AssuranceSource;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.util.Locale;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Selection, fail-closed behaviour, scope mapping and identity assurance of the canonical rights composition. */
class MediaRightsConsentCompositionTest {
    private static final String DIGEST = "b".repeat(64);
    private static final String VERSION = "sha256:" + DIGEST;

    @Test
    void noSourceAuthorityMeansNothingToGate() {
        assertThat(MediaRightsConsentComposition.compose(null, Map.of(), true, Clock.systemUTC()).authority()).isNull();
    }

    @Test
    void unsetSelectorKeepsNonProductionBehaviourButFailsClosedInProductionLikeProfiles() {
        var delegate = policyDouble(new int[1]);
        assertThat(MediaRightsConsentComposition.compose(delegate, Map.of(), false, Clock.systemUTC()).authority())
                .isSameAs(delegate);

        var composed = MediaRightsConsentComposition.compose(delegate, Map.of(), true, Clock.systemUTC());
        assertThat(composed.authority()).isNotSameAs(delegate);
        assertThat(composed.authority().ready()).isFalse();
        assertThat(composed.authority().productionEligible()).isFalse();
        assertThat(composed.administration()).isEmpty();
        // Even a delegate that ALLOWs is never allowed through without a resolver.
        assertThat(composed.authority().resolve(request("VISION"), principal()).status())
                .isEqualTo(MediaSourceAuthorizationContracts.Status.UNAVAILABLE);
    }

    @Test
    void unknownSelectorIsAConfigurationError() {
        assertThatThrownBy(() -> MediaRightsConsentComposition.compose(
                policyDouble(new int[1]), Map.of("MEDIA_RIGHTS_AUTHORITY", "memory"), true, Clock.systemUTC()))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void postgresqlSelectionWithoutTheCanonicalDatasourceIsUnavailable() {
        // The real PostgreSQL factory is on the runtime classpath; the canonical datasource is not configured.
        var composed = MediaRightsConsentComposition.compose(policyDouble(new int[1]),
                Map.of("MEDIA_RIGHTS_AUTHORITY", "postgresql", "MEDIA_RUNTIME_ENVIRONMENT", "production"),
                true, Clock.systemUTC());
        try {
            assertThat(composed.authority().ready()).isFalse();
            assertThat(composed.authority().resolve(request("VISION"), principal()).status())
                    .isEqualTo(MediaSourceAuthorizationContracts.Status.UNAVAILABLE);
        } finally {
            composed.authority().close();
        }
    }

    @Test
    void gateAdmitsOnlyWithAnExactStatementAndReturnsTheDelegateEvidenceUnchanged() {
        int[] delegateCalls = new int[1];
        var composed = MediaRightsConsentComposition.composeWithStore(policyDouble(delegateCalls),
                new InMemoryMediaRightsAttestationStore(), "test", Clock.systemUTC());
        var request = request("VISION");
        assertThat(composed.authority().resolve(request, principal()).status())
                .isEqualTo(MediaSourceAuthorizationContracts.Status.DENIED);

        var admin = composed.administration().orElseThrow();
        var record = admin.attest(principal(), statement(Set.of(Scope.PROCESSING), StatementKind.MEDIA_RIGHTS));
        var decision = composed.authority().resolve(request, principal());
        assertThat(decision.status()).isEqualTo(MediaSourceAuthorizationContracts.Status.ALLOWED);
        assertThat(decision.evidence().policyDecisionId()).isEqualTo("policy-1");

        admin.revoke(principal(), record.attestation().attestationId(), "TEST revoke");
        assertThat(composed.authority().resolve(request, principal()).status())
                .isEqualTo(MediaSourceAuthorizationContracts.Status.REVOKED);
        composed.authority().close();
    }

    @Test
    void scopeMappingCoversProcessingVoiceOrLikenessAndDelivery() {
        for (String operation : new String[] {"SPEECH_TO_TEXT", "VISION", "MULTIMODAL", "TEXT_TO_SPEECH", "analysis.scene"}) {
            assertThat(MediaRightsConsentComposition.scopeFor(request(operation))).isEqualTo(Scope.PROCESSING);
        }
        for (String operation : new String[] {"media.deliver", "export-final", "publish.release"}) {
            assertThat(MediaRightsConsentComposition.scopeFor(request(operation))).isEqualTo(Scope.EXTERNAL_DELIVERY);
        }
        Scope voiced = MediaRightsConsentComposition.withJobParameters(
                Map.of("voiceReference", "voice-artifact@" + VERSION),
                () -> MediaRightsConsentComposition.scopeFor(request("TEXT_TO_SPEECH")));
        assertThat(voiced).isEqualTo(Scope.VOICE_OR_LIKENESS_USE);
        Scope likeness = MediaRightsConsentComposition.withJobParameters(
                Map.of("likenessReference", "face@" + VERSION),
                () -> MediaRightsConsentComposition.scopeFor(request("VISION")));
        assertThat(likeness).isEqualTo(Scope.VOICE_OR_LIKENESS_USE);
        // The hint never leaks outside the call, and a stock voice name is not a reference.
        assertThat(MediaRightsConsentComposition.scopeFor(request("TEXT_TO_SPEECH"))).isEqualTo(Scope.PROCESSING);
        assertThat(MediaRightsConsentComposition.referencesVoiceOrLikeness(Map.of("voice", "en-US-default"))).isFalse();
        assertThat(MediaRightsConsentComposition.referencesVoiceOrLikeness(Map.of("voiceReference", " "))).isFalse();
        assertThat(MediaRightsConsentComposition.referencesVoiceOrLikeness(Map.of(
                "synthesis", List.of(Map.of("voiceReferenceArtifactId", "voice-artifact"))))).isTrue();
        assertThat(MediaRightsConsentComposition.referencesVoiceOrLikeness(Map.of("context",
                new com.ghatana.media.runtime.MediaModalityContracts.ContextReference(
                        "urn:voice-profile:1", "voice-reference",
                        com.ghatana.media.runtime.MediaRuntimeContracts.DataClassification.CONFIDENTIAL,
                        Instant.now().plusSeconds(60))))).isTrue();
    }

    @Test
    void productionLikeProfilesAcceptOnlyOidcVerifiedStatementMakers() {
        var production = MediaRightsConsentComposition.administration(
                new InMemoryMediaRightsAttestationStore(), Clock.systemUTC(), "production");
        for (AssuranceSource weak : new AssuranceSource[] {AssuranceSource.DEV_ISSUED, AssuranceSource.UNSPECIFIED,
                AssuranceSource.SHARED_SECRET_JWT, AssuranceSource.BOOTSTRAP_SERVICE_KEY, AssuranceSource.LOCAL_UNVERIFIED}) {
            assertThatThrownBy(() -> production.attest(principal(weak), statement(
                    Set.of(Scope.PROCESSING), StatementKind.MEDIA_RIGHTS)))
                    .isInstanceOfSatisfying(RightsConsentException.class,
                            failure -> assertThat(failure.code()).isEqualTo(Code.IDENTITY_ASSURANCE_INSUFFICIENT));
        }
        var record = production.attest(principal(AssuranceSource.OIDC_VERIFIED), statement(
                Set.of(Scope.PROCESSING, Scope.EXTERNAL_DELIVERY), StatementKind.MEDIA_RIGHTS));
        String id = record.attestation().attestationId();
        assertThatThrownBy(() -> production.confirm(
                new AuthenticatedPrincipal("tenant-a", "reviewer", Instant.now(), AssuranceSource.DEV_ISSUED), id, "x"))
                .isInstanceOfSatisfying(RightsConsentException.class,
                        failure -> assertThat(failure.code()).isEqualTo(Code.IDENTITY_ASSURANCE_INSUFFICIENT));
        assertThatThrownBy(() -> production.revoke(principal(AssuranceSource.DEV_ISSUED), id, "x"))
                .isInstanceOfSatisfying(RightsConsentException.class,
                        failure -> assertThat(failure.code()).isEqualTo(Code.IDENTITY_ASSURANCE_INSUFFICIENT));
        production.confirm(new AuthenticatedPrincipal("tenant-a", "reviewer", Instant.now(),
                AssuranceSource.OIDC_VERIFIED), id, "TEST confirm");
    }

    @Test
    void devIssuedIdentitiesMayActOnlyInNonProductionProfiles() {
        for (String profile : new String[] {"dev", "local", "test"}) {
            var admin = MediaRightsConsentComposition.administration(
                    new InMemoryMediaRightsAttestationStore(), Clock.systemUTC(), profile);
            assertThat(admin.attest(principal(AssuranceSource.DEV_ISSUED),
                    statement(Set.of(Scope.PROCESSING), StatementKind.MEDIA_RIGHTS))).isNotNull();
        }
        for (String profile : new String[] {"prod", "production", "staging", "sovereign", "integration", "e2e"}) {
            var admin = MediaRightsConsentComposition.administration(
                    new InMemoryMediaRightsAttestationStore(), Clock.systemUTC(), profile);
            assertThatThrownBy(() -> admin.attest(principal(AssuranceSource.DEV_ISSUED),
                    statement(Set.of(Scope.PROCESSING), StatementKind.MEDIA_RIGHTS)))
                    .isInstanceOf(RightsConsentException.class);
        }
    }

    // -- fixtures -------------------------------------------------------------------------------------------

    private static AuthenticatedPrincipal principal() { return principal(AssuranceSource.UNSPECIFIED); }

    private static AuthenticatedPrincipal principal(AssuranceSource assurance) {
        return new AuthenticatedPrincipal("tenant-a", "principal-a", Instant.now(), assurance);
    }

    private static AttestRequest statement(Set<Scope> scopes, StatementKind kind) {
        return new AttestRequest("artifact-1", VERSION, DIGEST, kind, scopes,
                "TEST basis for a synthetic fixture", null, null, null);
    }

    private static MediaSourceAuthorizationContracts.Request request(String operation) {
        return new MediaSourceAuthorizationContracts.Request("tenant-a", "principal-a", "artifact-1",
                new ArtifactVersion(VERSION), DIGEST, operation, "analysis", "provider", "v1",
                ProcessingBoundary.LOCAL, "local", ProviderDataRetention.NONE);
    }

    /** TEST DOUBLE for the Shared-policy authority: always allows; the gate decides on attestations. */
    private static MediaSourceAuthorizationContracts.Authority policyDouble(int[] calls) {
        return new MediaSourceAuthorizationContracts.Authority() {
            @Override public String authorityId() { return "fixture-policy-double"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return true; }
            @Override public MediaSourceAuthorizationContracts.Decision resolve(
                    MediaSourceAuthorizationContracts.Request request, AuthenticatedPrincipal authenticated) {
                calls[0]++;
                Instant now = Instant.now();
                var evidence = new MediaSourceAuthorizationContracts.Evidence(
                        authorityId(), "decision-1", request.tenantId(), request.principalId(), "fixture-owner",
                        request.artifactId(), request.sourceVersion(), request.sourceSha256(), request.operation(),
                        request.purpose(), request.providerId(), request.providerVersion(),
                        request.processingBoundary(), request.processingRegion(), request.providerRetention(),
                        Set.of(request.operation().toLowerCase(Locale.ROOT)), Set.of(request.processingRegion()),
                        Set.of(request.providerRetention()), "rights-1", "policy-1", "policy-v1",
                        MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                        MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                        "", "fixture-clock", 0, now.minusSeconds(1), now.plusSeconds(300));
                return new MediaSourceAuthorizationContracts.Decision(
                        MediaSourceAuthorizationContracts.Status.ALLOWED, evidence);
            }
            @Override public MediaSourceAuthorizationContracts.Decision revalidate(
                    MediaSourceAuthorizationContracts.Request request,
                    MediaSourceAuthorizationContracts.Evidence expected, AuthenticatedPrincipal authenticated) {
                return new MediaSourceAuthorizationContracts.Decision(
                        MediaSourceAuthorizationContracts.Status.ALLOWED, expected);
            }
        };
    }
}
