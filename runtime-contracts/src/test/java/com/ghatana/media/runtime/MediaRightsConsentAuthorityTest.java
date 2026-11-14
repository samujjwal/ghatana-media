package com.ghatana.media.runtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.runtime.MediaRightsConsentAuthority.AttestRequest;
import com.ghatana.media.runtime.MediaRightsConsentAuthority.Code;
import com.ghatana.media.runtime.MediaRightsConsentAuthority.RightsConsentException;
import com.ghatana.media.runtime.MediaRightsConsentContracts.AttestationRecord;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Reason;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.ghatana.media.runtime.MediaRightsConsentContracts.StatementKind;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Status;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Verdict;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** Unit tests use clearly synthetic TEST principals; they prove logic, not any real person's rights. */
class MediaRightsConsentAuthorityTest {
    private static final String TENANT = "tenant-test";
    private static final String UPLOADER = "test-principal-uploader";
    private static final String REVIEWER = "test-principal-reviewer";
    private static final String ARTIFACT = "artifact-test-1";
    private static final String DIGEST = "a".repeat(64);
    private static final String VERSION = "sha256:" + DIGEST;
    private static final String OTHER_DIGEST = "b".repeat(64);
    private static final Instant T0 = Instant.parse("2026-11-14T10:00:00Z");

    private final MutableClock clock = new MutableClock(T0);
    private final InMemoryMediaRightsAttestationStore store = new InMemoryMediaRightsAttestationStore();
    private final MediaRightsConsentAuthority authority = new MediaRightsConsentAuthority(store, clock);

    private static AuthenticatedPrincipal who(String principal) {
        return new AuthenticatedPrincipal(TENANT, principal, T0);
    }

    private AttestRequest request(StatementKind kind, Set<Scope> scopes, Instant expires, String confirmer) {
        return new AttestRequest(ARTIFACT, VERSION, DIGEST, kind, scopes, "TEST basis: synthetic fixture statement",
                null, confirmer, expires);
    }

    private ResolutionRequest ask(Scope scope) { return new ResolutionRequest(TENANT, ARTIFACT, VERSION, DIGEST, scope); }

    private static void assertCode(Throwable failure, Code code) {
        assertThat(failure).isInstanceOfSatisfying(RightsConsentException.class, e -> assertThat(e.code()).isEqualTo(code));
    }

    @Test
    void noRecordsIsDeniedAndAnUnconfiguredResolverIsUnavailable() {
        assertThat(authority.resolve(ask(Scope.PROCESSING)).verdict()).isEqualTo(Verdict.DENIED);
        assertThat(authority.resolve(ask(Scope.PROCESSING)).reasons()).containsExactly(Reason.NO_ATTESTATION);
        Resolution unavailable = RightsConsentResolver.unavailable().resolve(ask(Scope.EXTERNAL_DELIVERY));
        assertThat(unavailable.verdict()).isEqualTo(Verdict.UNAVAILABLE);
        assertThat(unavailable.admitted()).isFalse();
    }

    @Test
    void processingScopeNeedsNoSecondPerson() {
        authority.attest(who(UPLOADER), request(StatementKind.MEDIA_RIGHTS, Set.of(Scope.PROCESSING), null, null));
        Resolution resolution = authority.resolve(ask(Scope.PROCESSING));
        assertThat(resolution.verdict()).isEqualTo(Verdict.ADMITTED);
        assertThat(resolution.attestationIds()).hasSize(1);
    }

    @Test
    void externalDeliveryIsDeniedUntilADifferentPrincipalConfirms() {
        AttestationRecord attested = authority.attest(who(UPLOADER),
                request(StatementKind.MEDIA_RIGHTS, Set.of(Scope.PROCESSING, Scope.EXTERNAL_DELIVERY), null, null));
        String id = attested.attestation().attestationId();
        assertThat(attested.statusAt(T0)).isEqualTo(Status.PENDING_CONFIRMATION);
        Resolution before = authority.resolve(ask(Scope.EXTERNAL_DELIVERY));
        assertThat(before.verdict()).isEqualTo(Verdict.DENIED);
        assertThat(before.reasons()).containsExactly(Reason.NOT_CONFIRMED);

        assertThatThrownBy(() -> authority.confirm(who(UPLOADER), id, "self"))
                .satisfies(e -> assertCode(e, Code.SELF_CONFIRMATION_REFUSED));
        assertThat(authority.resolve(ask(Scope.EXTERNAL_DELIVERY)).verdict()).isEqualTo(Verdict.DENIED);

        AttestationRecord confirmed = authority.confirm(who(REVIEWER), id, "TEST reviewer checked the statement");
        assertThat(confirmed.confirmation().confirmingPrincipalId()).isEqualTo(REVIEWER);
        assertThat(confirmed.statusAt(T0)).isEqualTo(Status.CONFIRMED);
        assertThat(authority.resolve(ask(Scope.EXTERNAL_DELIVERY)).verdict()).isEqualTo(Verdict.ADMITTED);

        assertThatThrownBy(() -> authority.confirm(who("test-principal-third"), id, null))
                .satisfies(e -> assertCode(e, Code.ALREADY_CONFIRMED));
    }

    @Test
    void voiceOrLikenessNeedsAConfirmedPersonConsentStatementNotOwnership() {
        AttestationRecord rights = authority.attest(who(UPLOADER),
                request(StatementKind.MEDIA_RIGHTS, Set.of(Scope.VOICE_OR_LIKENESS_USE), null, null));
        authority.confirm(who(REVIEWER), rights.attestation().attestationId(), null);
        assertThat(authority.resolve(ask(Scope.VOICE_OR_LIKENESS_USE)).verdict()).isEqualTo(Verdict.DENIED);
        assertThat(authority.resolve(ask(Scope.VOICE_OR_LIKENESS_USE)).reasons()).containsExactly(Reason.SCOPE_NOT_COVERED);

        AttestationRecord person = authority.attest(who(UPLOADER),
                request(StatementKind.IDENTIFIABLE_PERSON_CONSENT, Set.of(Scope.VOICE_OR_LIKENESS_USE), null, null));
        assertThat(authority.resolve(ask(Scope.VOICE_OR_LIKENESS_USE)).verdict()).isEqualTo(Verdict.DENIED);
        authority.confirm(who(REVIEWER), person.attestation().attestationId(), null);
        assertThat(authority.resolve(ask(Scope.VOICE_OR_LIKENESS_USE)).verdict()).isEqualTo(Verdict.ADMITTED);
    }

    @Test
    void requestedConfirmerRestrictsWhoMayConfirm() {
        AttestationRecord attested = authority.attest(who(UPLOADER),
                request(StatementKind.MEDIA_RIGHTS, Set.of(Scope.EXTERNAL_DELIVERY), null, REVIEWER));
        String id = attested.attestation().attestationId();
        assertThatThrownBy(() -> authority.confirm(who("test-principal-other"), id, null))
                .satisfies(e -> assertCode(e, Code.NOT_DESIGNATED_CONFIRMER));
        authority.confirm(who(REVIEWER), id, null);
        assertThat(authority.resolve(ask(Scope.EXTERNAL_DELIVERY)).admitted()).isTrue();
        assertThatThrownBy(() -> authority.attest(who(UPLOADER),
                request(StatementKind.MEDIA_RIGHTS, Set.of(Scope.EXTERNAL_DELIVERY), null, UPLOADER)))
                .satisfies(e -> assertCode(e, Code.INVALID));
    }

    @Test
    void revocationEndsAdmissionAndOnlyAPartyMayRevoke() {
        AttestationRecord attested = authority.attest(who(UPLOADER),
                request(StatementKind.MEDIA_RIGHTS, Set.of(Scope.EXTERNAL_DELIVERY), null, null));
        String id = attested.attestation().attestationId();
        authority.confirm(who(REVIEWER), id, null);
        assertThatThrownBy(() -> authority.revoke(who("test-principal-stranger"), id, "no"))
                .satisfies(e -> assertCode(e, Code.NOT_PERMITTED_TO_REVOKE));
        assertThatThrownBy(() -> authority.revoke(who(UPLOADER), id, " ")).satisfies(e -> assertCode(e, Code.INVALID));
        AttestationRecord revoked = authority.revoke(who(REVIEWER), id, "TEST: confirmer withdrew");
        assertThat(revoked.revocation().revokedByPrincipalId()).isEqualTo(REVIEWER);
        assertThat(revoked.revocation().reason()).isEqualTo("TEST: confirmer withdrew");
        assertThat(authority.resolve(ask(Scope.EXTERNAL_DELIVERY)).verdict()).isEqualTo(Verdict.REVOKED);
        assertThatThrownBy(() -> authority.revoke(who(UPLOADER), id, "again"))
                .satisfies(e -> assertCode(e, Code.ALREADY_REVOKED));
        assertThatThrownBy(() -> authority.confirm(who("test-principal-third"), id, null))
                .satisfies(e -> assertCode(e, Code.REVOKED));
    }

    @Test
    void expiryMakesAnAttestationStale() {
        authority.attest(who(UPLOADER), request(StatementKind.MEDIA_RIGHTS, Set.of(Scope.PROCESSING),
                T0.plus(Duration.ofHours(1)), null));
        assertThat(authority.resolve(ask(Scope.PROCESSING)).admitted()).isTrue();
        clock.set(T0.plus(Duration.ofHours(2)));
        Resolution expired = authority.resolve(ask(Scope.PROCESSING));
        assertThat(expired.verdict()).isEqualTo(Verdict.STALE);
        assertThat(expired.reasons()).containsExactly(Reason.EXPIRED);
        assertThatThrownBy(() -> authority.attest(who(UPLOADER), request(StatementKind.MEDIA_RIGHTS,
                Set.of(Scope.PROCESSING), T0, null))).satisfies(e -> assertCode(e, Code.INVALID));
    }

    @Test
    void aNewVersionNeverInheritsAndADigestMismatchIsReported() {
        authority.attest(who(UPLOADER), request(StatementKind.MEDIA_RIGHTS, Set.of(Scope.PROCESSING), null, null));
        Resolution newer = authority.resolve(new ResolutionRequest(TENANT, ARTIFACT, "sha256:" + OTHER_DIGEST,
                OTHER_DIGEST, Scope.PROCESSING));
        assertThat(newer.verdict()).isEqualTo(Verdict.STALE);
        assertThat(newer.reasons()).containsExactly(Reason.OTHER_VERSION_ONLY);
        Resolution mismatch = authority.resolve(new ResolutionRequest(TENANT, ARTIFACT, VERSION, OTHER_DIGEST,
                Scope.PROCESSING));
        assertThat(mismatch.verdict()).isEqualTo(Verdict.MISMATCH);
        assertThat(authority.listForVersion(TENANT, ARTIFACT, "sha256:" + OTHER_DIGEST)).isEmpty();
        assertThat(authority.listForVersion(TENANT, ARTIFACT, VERSION)).hasSize(1);
        assertThatThrownBy(() -> authority.attest(who(UPLOADER), new AttestRequest(ARTIFACT, VERSION, OTHER_DIGEST,
                StatementKind.MEDIA_RIGHTS, Set.of(Scope.PROCESSING), "TEST basis", null, null, null)))
                .satisfies(e -> assertCode(e, Code.INVALID));
    }

    @Test
    void tenantsAreIsolatedAndRecordsAreAppendOnly() {
        AttestationRecord attested = authority.attest(who(UPLOADER),
                request(StatementKind.MEDIA_RIGHTS, Set.of(Scope.PROCESSING), null, null));
        assertThat(authority.resolve(new ResolutionRequest("tenant-other", ARTIFACT, VERSION, DIGEST, Scope.PROCESSING))
                .verdict()).isEqualTo(Verdict.DENIED);
        assertThat(authority.find("tenant-other", attested.attestation().attestationId())).isEmpty();
        assertThatThrownBy(() -> store.append(attested.attestation())).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void validationRefusesBlankBasisEmptyScopesAndOversizedText() {
        assertThatThrownBy(() -> authority.attest(who(UPLOADER), new AttestRequest(ARTIFACT, VERSION, DIGEST,
                StatementKind.MEDIA_RIGHTS, Set.of(), "TEST basis", null, null, null)))
                .satisfies(e -> assertCode(e, Code.INVALID));
        assertThatThrownBy(() -> authority.attest(who(UPLOADER), new AttestRequest(ARTIFACT, VERSION, DIGEST,
                StatementKind.MEDIA_RIGHTS, Set.of(Scope.PROCESSING), "  ", null, null, null)))
                .satisfies(e -> assertCode(e, Code.INVALID));
        assertThatThrownBy(() -> authority.attest(who(UPLOADER), new AttestRequest(ARTIFACT, VERSION, DIGEST,
                StatementKind.MEDIA_RIGHTS, Set.of(Scope.PROCESSING), "x".repeat(2001), null, null, null)))
                .satisfies(e -> assertCode(e, Code.INVALID));
    }

    @Test
    void sourceAuthorizationGateRequiresBothThePolicyDelegateAndAdmittedAttestation() {
        MediaSourceAuthorizationContracts.Request request = new MediaSourceAuthorizationContracts.Request(
                TENANT, UPLOADER, ARTIFACT, new MediaRuntimeContracts.ArtifactVersion(VERSION), DIGEST,
                "export", "delivery", "provider-test", "1", MediaRuntimeContracts.ProcessingBoundary.LOCAL, "local",
                MediaRuntimeContracts.ProviderDataRetention.NONE);
        assertThat(MediaRightsConsentAuthority.defaultScopeFor(request)).isEqualTo(Scope.EXTERNAL_DELIVERY);
        MediaSourceAuthorizationContracts.Authority denyingDelegate = delegate(
                new MediaSourceAuthorizationContracts.Decision(MediaSourceAuthorizationContracts.Status.DENIED, null));
        assertThat(MediaRightsConsentAuthority.gate(denyingDelegate, authority).resolve(request, who(UPLOADER)).status())
                .isEqualTo(MediaSourceAuthorizationContracts.Status.DENIED);
        MediaSourceAuthorizationContracts.Decision allowed = new MediaSourceAuthorizationContracts.Decision(
                MediaSourceAuthorizationContracts.Status.ALLOWED, evidence(request));
        MediaSourceAuthorizationContracts.Authority gated = MediaRightsConsentAuthority.gate(delegate(allowed), authority);
        assertThat(gated.resolve(request, who(UPLOADER)).status()).isEqualTo(MediaSourceAuthorizationContracts.Status.DENIED);
        AttestationRecord attested = authority.attest(who(UPLOADER),
                request(StatementKind.MEDIA_RIGHTS, Set.of(Scope.EXTERNAL_DELIVERY), null, null));
        assertThat(gated.resolve(request, who(UPLOADER)).status()).isEqualTo(MediaSourceAuthorizationContracts.Status.DENIED);
        authority.confirm(who(REVIEWER), attested.attestation().attestationId(), null);
        assertThat(gated.resolve(request, who(UPLOADER)).status()).isEqualTo(MediaSourceAuthorizationContracts.Status.ALLOWED);
        authority.revoke(who(UPLOADER), attested.attestation().attestationId(), "TEST revoke");
        assertThat(gated.revalidate(request, allowed.evidence(), who(UPLOADER)).status())
                .isEqualTo(MediaSourceAuthorizationContracts.Status.REVOKED);
        assertThat(MediaRightsConsentAuthority.gate(delegate(allowed), RightsConsentResolver.unavailable())
                .resolve(request, who(UPLOADER)).status()).isEqualTo(MediaSourceAuthorizationContracts.Status.UNAVAILABLE);
    }

    private static MediaSourceAuthorizationContracts.Evidence evidence(MediaSourceAuthorizationContracts.Request request) {
        return new MediaSourceAuthorizationContracts.Evidence("test-authority", "decision-1", TENANT, UPLOADER,
                UPLOADER, ARTIFACT, request.sourceVersion(), DIGEST, request.operation(), request.purpose(),
                request.providerId(), request.providerVersion(), request.processingBoundary(), request.processingRegion(),
                request.providerRetention(), Set.of("export"), Set.of("*"),
                Set.of(MediaRuntimeContracts.ProviderDataRetention.NONE), "rights-1", "policy-1", "policy-v1",
                MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT, "",
                "clock-ref", 0, T0, T0.plus(Duration.ofMinutes(5)));
    }

    private static MediaSourceAuthorizationContracts.Authority delegate(MediaSourceAuthorizationContracts.Decision decision) {
        return new MediaSourceAuthorizationContracts.Authority() {
            @Override public String authorityId() { return "test-delegate"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public MediaSourceAuthorizationContracts.Decision resolve(
                    MediaSourceAuthorizationContracts.Request r, AuthenticatedPrincipal p) { return decision; }
            @Override public MediaSourceAuthorizationContracts.Decision revalidate(
                    MediaSourceAuthorizationContracts.Request r, MediaSourceAuthorizationContracts.Evidence e,
                    AuthenticatedPrincipal p) { return decision; }
        };
    }

    private static final class MutableClock extends Clock {
        private Instant now;
        MutableClock(Instant now) { this.now = now; }
        void set(Instant value) { now = value; }
        @Override public java.time.ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
    }
}
