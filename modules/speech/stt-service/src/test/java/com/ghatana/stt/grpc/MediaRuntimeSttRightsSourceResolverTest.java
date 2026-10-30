package com.ghatana.stt.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import com.ghatana.media.runtime.MediaSourceRightsAdministration;
import com.ghatana.stt.grpc.SharedPolicySttRequestAuthorization.MediaRightsSourceResolver.Request;
import com.ghatana.stt.grpc.SharedPolicySttRequestAuthorization.MediaRightsSourceResolver.Resolution;
import com.ghatana.stt.grpc.SharedPolicySttRequestAuthorization.MediaRightsSourceResolver.SourceFacts;
import com.ghatana.stt.grpc.SharedPolicySttRequestAuthorization.MediaRightsSourceResolver.Status;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/** In-memory source-rights records prove the production resolver's identity and scope binding. */
class MediaRuntimeSttRightsSourceResolverTest {
    private static final String TENANT = "tenant-a";
    private static final String PRINCIPAL = "11111111-2222-3333-4444-555555555555";
    private static final JwtServerInterceptor.VerifiedIdentity IDENTITY =
            new JwtServerInterceptor.VerifiedIdentity(PRINCIPAL, TENANT);
    private static final String ARTIFACT = "artifact-1";
    private static final Clock NOW =
            Clock.fixed(Instant.parse("2026-10-29T12:00:00Z"), ZoneOffset.UTC);

    private final FakeAdministration administration = new FakeAdministration();
    private final MediaRuntimeSttRightsSourceResolver resolver =
            new MediaRuntimeSttRightsSourceResolver(administration, NOW);

    @Test
    void admitsOnlyTheVerifiedSourcePrincipalInsideRegisteredScope() throws Exception {
        Instant expiresAt = NOW.instant().plusSeconds(600);
        administration.add(record(expiresAt, null));
        Resolution resolution = await(resolver.resolve(request(IDENTITY)));
        assertThat(resolution.status()).isEqualTo(Status.ADMITTED);
        SourceFacts facts = resolution.facts();
        assertThat(facts.canonicalArtifactId()).isEqualTo(ARTIFACT);
        assertThat(facts.immutableVersion()).isEqualTo(recordVersion());
        assertThat(facts.purpose()).isEqualTo("transcription");
        assertThat(facts.rightsReference()).isEqualTo("provenance://test/1");
        assertThat(facts.consentReference()).isEqualTo("not-applicable:no-human-consent-decision");
        assertThat(facts.consentExpiresAt()).isEqualTo(expiresAt);
        assertThat(facts.revocationScope()).isEqualTo("epoch:0");
    }

    @Test
    void wrongPrincipalIsDeniedBeforeAnyEffect() throws Exception {
        administration.add(record(NOW.instant().plusSeconds(600), null));
        var foreign = new JwtServerInterceptor.VerifiedIdentity(
                "99999999-8888-7777-6666-555555555555", TENANT);
        assertThat(await(resolver.resolve(request(foreign))).status())
                .isEqualTo(Status.DENIED);
    }

    @Test
    void wrongTenantFindsNoRecordAndIsDenied() throws Exception {
        administration.add(record(NOW.instant().plusSeconds(600), null));
        var otherTenant = new JwtServerInterceptor.VerifiedIdentity(PRINCIPAL, "tenant-b");
        assertThat(await(resolver.resolve(request(otherTenant))).status())
                .isEqualTo(Status.DENIED);
    }

    @Test
    void unregisteredArtifactIsDenied() throws Exception {
        assertThat(await(resolver.resolve(request(IDENTITY))).status())
                .isEqualTo(Status.DENIED);
    }

    @Test
    void revokedRecordIsReportedRevoked() throws Exception {
        administration.add(record(NOW.instant().plusSeconds(600), NOW.instant()));
        assertThat(await(resolver.resolve(request(IDENTITY))).status())
                .isEqualTo(Status.REVOKED);
    }

    @Test
    void expiredRecordIsReportedStale() throws Exception {
        administration.add(record(NOW.instant().minusSeconds(1), null));
        assertThat(await(resolver.resolve(request(IDENTITY))).status())
                .isEqualTo(Status.STALE);
    }

    @Test
    void operationOutsideRegisteredScopeIsDenied() throws Exception {
        administration.add(record(NOW.instant().plusSeconds(600), null));
        var speakerRead = new Request(
                IDENTITY, SttRequestAuthorization.Operation.READ_SPEAKER_IDENTITY, ARTIFACT);
        assertThat(await(resolver.resolve(speakerRead)).status())
                .isEqualTo(Status.DENIED);
    }

    @Test
    void multipleLiveVersionsFailClosedAsUnavailable() throws Exception {
        administration.add(record(NOW.instant().plusSeconds(600), null));
        administration.add(recordWithVersion(
                "sha256:" + "b".repeat(64), "b".repeat(64),
                NOW.instant().plusSeconds(600), null));
        assertThat(await(resolver.resolve(request(IDENTITY))).status())
                .isEqualTo(Status.UNAVAILABLE);
    }

    @Test
    void unreadyAuthorityIsUnavailable() throws Exception {
        administration.ready = false;
        administration.add(record(NOW.instant().plusSeconds(600), null));
        assertThat(await(resolver.resolve(request(IDENTITY))).status())
                .isEqualTo(Status.UNAVAILABLE);
    }

    @Test
    void blankIdentityPartsAreUnavailable() throws Exception {
        var blankSubject = new JwtServerInterceptor.VerifiedIdentity(" ", TENANT);
        assertThat(await(resolver.resolve(request(blankSubject))).status())
                .isEqualTo(Status.UNAVAILABLE);
        var blankTenant = new JwtServerInterceptor.VerifiedIdentity(PRINCIPAL, "");
        assertThat(await(resolver.resolve(request(blankTenant))).status())
                .isEqualTo(Status.UNAVAILABLE);
        var noResource = new Request(
                IDENTITY, SttRequestAuthorization.Operation.TRANSCRIBE, null);
        assertThat(await(resolver.resolve(noResource)).status())
                .isEqualTo(Status.UNAVAILABLE);
    }

    @Test
    void revalidationReflectsRevocationBetweenResolveAndAdmit() throws Exception {
        var record = record(NOW.instant().plusSeconds(600), null);
        administration.add(record);
        Resolution admitted = await(resolver.resolve(request(IDENTITY)));
        assertThat(admitted.status()).isEqualTo(Status.ADMITTED);

        administration.replace(record(NOW.instant().plusSeconds(600), NOW.instant()));
        Resolution revalidated = await(resolver
                .revalidate(request(IDENTITY), admitted.facts()));
        assertThat(revalidated.status()).isEqualTo(Status.REVOKED);
        assertThat(revalidated.facts()).isNull();
    }

    @Test
    void revalidationReflectsEpochAdvanceOnReRegistration() throws Exception {
        administration.add(record(NOW.instant().plusSeconds(600), null));
        Resolution admitted = await(resolver.resolve(request(IDENTITY)));
        assertThat(admitted.facts().revocationScope()).isEqualTo("epoch:0");

        administration.replace(recordWithEpoch(1));
        Resolution revalidated = await(resolver
                .revalidate(request(IDENTITY), admitted.facts()));
        assertThat(revalidated.status()).isEqualTo(Status.ADMITTED);
        assertThat(revalidated.facts().revocationScope()).isEqualTo("epoch:1");
        assertThat(revalidated.facts()).isNotEqualTo(admitted.facts());
    }

    private static Resolution await(CompletionStage<Resolution> stage) throws Exception {
        return stage.toCompletableFuture().get(5, TimeUnit.SECONDS);
    }

    private static Request request(JwtServerInterceptor.VerifiedIdentity identity) {
        return new Request(identity, SttRequestAuthorization.Operation.TRANSCRIBE, ARTIFACT);
    }

    private static String recordVersion() {
        return "sha256:" + "a".repeat(64);
    }

    private static MediaSourceRightsAdministration.SourceRecord record(
            Instant expiresAt, Instant revokedAt) {
        return recordWithVersion(recordVersion(), "a".repeat(64), expiresAt, revokedAt);
    }

    private static MediaSourceRightsAdministration.SourceRecord recordWithEpoch(long epoch) {
        return new MediaSourceRightsAdministration.SourceRecord(
                TENANT, ARTIFACT, recordVersion(), "a".repeat(64), PRINCIPAL, PRINCIPAL,
                MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                "", Set.of("speech_to_text"), Set.of("transcription"), Set.of("local"),
                Set.of(ProviderDataRetention.NONE), "clock-evidence", "provenance://test/1",
                PRINCIPAL, Instant.now(), NOW.instant().plusSeconds(600), epoch, null);
    }

    private static MediaSourceRightsAdministration.SourceRecord recordWithVersion(
            String version, String sha256, Instant expiresAt, Instant revokedAt) {
        return new MediaSourceRightsAdministration.SourceRecord(
                TENANT, ARTIFACT, version, sha256, PRINCIPAL, PRINCIPAL,
                MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                "", Set.of("speech_to_text"), Set.of("transcription"), Set.of("local"),
                Set.of(ProviderDataRetention.NONE), "clock-evidence", "provenance://test/1",
                PRINCIPAL, Instant.now(), expiresAt, 0, revokedAt);
    }

    /** Minimal in-memory administration: every record read is fresh so revocation is visible. */
    private static final class FakeAdministration implements MediaSourceRightsAdministration {
        private final List<SourceRecord> records = new ArrayList<>();
        private boolean ready = true;

        void add(SourceRecord record) { records.add(record); }

        void replace(SourceRecord record) {
            records.removeIf(existing -> existing.sourceVersion().equals(record.sourceVersion()));
            records.add(record);
        }

        @Override public String administrationId() { return "fake-test-administration"; }
        @Override public boolean ready() { return ready; }
        @Override public boolean productionEligible() { return false; }

        @Override
        public SourceRecord register(
                RegisterRequest request,
                MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated) {
            throw new UnsupportedOperationException();
        }

        @Override
        public Optional<SourceRecord> record(String tenantId, String artifactId, String sourceVersion) {
            return records.stream()
                    .filter(row -> row.tenantId().equals(tenantId)
                            && row.artifactId().equals(artifactId)
                            && row.sourceVersion().equals(sourceVersion))
                    .findFirst();
        }

        @Override
        public List<SourceRecord> currentRecords(String tenantId, String artifactId) {
            return records.stream()
                    .filter(row -> row.tenantId().equals(tenantId) && row.artifactId().equals(artifactId))
                    .toList();
        }

        @Override
        public Optional<SourceRecord> revoke(
                String tenantId, String artifactId, String sourceVersion,
                MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated,
                String correlationId) {
            throw new UnsupportedOperationException();
        }
    }
}
