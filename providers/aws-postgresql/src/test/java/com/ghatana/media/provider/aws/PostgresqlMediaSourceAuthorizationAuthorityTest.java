package com.ghatana.media.provider.aws;

import com.ghatana.governance.PolicyDecisionOutcome;
import com.ghatana.governance.PolicyDecisionRecord;
import com.ghatana.governance.PolicyEngine;
import com.ghatana.governance.PolicyEngineLifecycle;
import com.ghatana.governance.PolicyEvaluationContext;
import com.ghatana.governance.PolicyEvaluationRequest;
import com.ghatana.governance.PolicyReasonCode;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import com.ghatana.media.runtime.MediaSourceRightsAdministration;
import com.ghatana.media.runtime.MediaSourceRightsAdministration.RegisterRequest;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@Testcontainers(disabledWithoutDocker = true)
class PostgresqlMediaSourceAuthorizationAuthorityTest {
    @Container static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices("s3");

    private static final String DIGEST = "a".repeat(64);

    @Test
    void registeredNonhumanSourceResolvesToAllowedEvidenceAndSurvivesRevalidation() throws Exception {
        try (Fixture fixture = openFixture()) {
            fixture.administration().register(register("tenant-reg", "principal-a", "artifact-a"),
                    authenticated("tenant-reg", "principal-a"));
            var decision = fixture.authority().resolve(request("tenant-reg", "principal-a", "artifact-a"),
                    authenticated("tenant-reg", "principal-a"));
            assertThat(decision.status()).isEqualTo(MediaSourceAuthorizationContracts.Status.ALLOWED);
            var evidence = decision.evidence();
            assertThat(evidence.authorityId()).isEqualTo("postgresql-media-source-authorization");
            assertThat(evidence.sourceKind())
                    .isEqualTo(MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN);
            assertThat(evidence.humanConsentDisposition()).isEqualTo(
                    MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT);
            assertThat(evidence.revocationEpoch()).isZero();
            assertThat(evidence.policyDecisionId()).isEqualTo("policy-decision-fixture");
            assertThat(evidence.policyVersion()).isEqualTo("policy-v1");
            var revalidated = fixture.authority().revalidate(
                    request("tenant-reg", "principal-a", "artifact-a"), evidence,
                    authenticated("tenant-reg", "principal-a"));
            assertThat(revalidated.status()).isEqualTo(MediaSourceAuthorizationContracts.Status.ALLOWED);
            assertThat(revalidated.evidence().decisionId()).isEqualTo(evidence.decisionId());
        }
    }

    @Test
    void unregisteredOrOutOfScopeSourcesFailClosedWithoutDecisions() throws Exception {
        try (Fixture fixture = openFixture()) {
            fixture.administration().register(register("tenant-scope", "principal-a", "artifact-a"),
                    authenticated("tenant-scope", "principal-a"));
            assertThat(fixture.authority().resolve(
                    request("tenant-scope", "principal-a", "missing-artifact"),
                    authenticated("tenant-scope", "principal-a")).status())
                    .isEqualTo(MediaSourceAuthorizationContracts.Status.DENIED);
            // A different authenticated principal hits the registered record's scope and is denied.
            assertThat(fixture.authority().resolve(
                    request("tenant-scope", "another-principal", "artifact-a"),
                    authenticated("tenant-scope", "another-principal")).status())
                    .isEqualTo(MediaSourceAuthorizationContracts.Status.DENIED);
            assertThat(fixture.authority().resolve(
                    request("tenant-scope", "principal-a", "artifact-a", "UNKNOWN_PURPOSE",
                            "denied-region", ProviderDataRetention.NONE),
                    authenticated("tenant-scope", "principal-a")).status())
                    .isEqualTo(MediaSourceAuthorizationContracts.Status.DENIED);
            assertThat(fixture.authority().resolve(
                    new MediaSourceAuthorizationContracts.Request(
                            "tenant-scope", "principal-a", "artifact-a",
                            new ArtifactVersion("sha256:" + "b".repeat(64)), "b".repeat(64),
                            "SPEECH_TO_TEXT", "transcription", "provider-a", "v1",
                            ProcessingBoundary.LOCAL, "local", ProviderDataRetention.NONE),
                    authenticated("tenant-scope", "principal-a")).status())
                    .isEqualTo(MediaSourceAuthorizationContracts.Status.DENIED);
            assertThat(decisionCount(fixture.state(), "tenant-scope")).isZero();
        }
    }

    @Test
    void requestIdentityMismatchedToAuthenticatedCredentialIsDeniedWithoutEffects() throws Exception {
        try (Fixture fixture = openFixture()) {
            fixture.administration().register(register("tenant-mix", "principal-a", "artifact-a"),
                    authenticated("tenant-mix", "principal-a"));
            // A caller authenticated as one principal cannot resolve rights under another
            // principal's request identity, even for a record it legitimately owns.
            assertThat(fixture.authority().resolve(
                    request("tenant-mix", "principal-a", "artifact-a"),
                    authenticated("tenant-mix", "impostor-principal")).status())
                    .isEqualTo(MediaSourceAuthorizationContracts.Status.DENIED);
            assertThat(fixture.authority().resolve(
                    request("tenant-mix", "principal-a", "artifact-a"),
                    authenticated("other-tenant", "principal-a")).status())
                    .isEqualTo(MediaSourceAuthorizationContracts.Status.DENIED);
            var allowed = fixture.authority().resolve(
                    request("tenant-mix", "principal-a", "artifact-a"),
                    authenticated("tenant-mix", "principal-a"));
            assertThat(allowed.status()).isEqualTo(MediaSourceAuthorizationContracts.Status.ALLOWED);
            // The same credential mismatch fails closed on revalidation of valid evidence.
            assertThat(fixture.authority().revalidate(
                    request("tenant-mix", "principal-a", "artifact-a"), allowed.evidence(),
                    authenticated("tenant-mix", "impostor-principal")).status())
                    .isEqualTo(MediaSourceAuthorizationContracts.Status.DENIED);
            // Only the single legitimately issued decision exists; denials wrote no durable row.
            assertThat(decisionCount(fixture.state(), "tenant-mix")).isEqualTo(1);
        }
    }

    @Test
    void registrationAndRevocationAreLockedToTheAuthenticatedSourceHolder() throws Exception {
        try (Fixture fixture = openFixture()) {
            assertThatThrownBy(() -> fixture.administration().register(
                    register("tenant-hold", "principal-a", "artifact-a"),
                    authenticated("tenant-hold", "impostor-principal")))
                    .isInstanceOf(SecurityException.class);
            assertThatThrownBy(() -> fixture.administration().register(
                    register("tenant-hold", "principal-a", "artifact-a"),
                    authenticated("other-tenant", "principal-a")))
                    .isInstanceOf(SecurityException.class);
            assertThatThrownBy(() -> fixture.administration().register(
                    register("tenant-hold", "principal-a", "artifact-a", DIGEST,
                            "not-the-authenticated-holder"),
                    authenticated("tenant-hold", "principal-a")))
                    .isInstanceOf(SecurityException.class);
            fixture.administration().register(register("tenant-hold", "principal-a", "artifact-a"),
                    authenticated("tenant-hold", "principal-a"));
            assertThatThrownBy(() -> fixture.administration().revoke(
                    "tenant-hold", "artifact-a", "sha256:" + DIGEST,
                    authenticated("tenant-hold", "impostor-principal"), "corr-x"))
                    .isInstanceOf(SecurityException.class);
            assertThatThrownBy(() -> fixture.administration().revoke(
                    "tenant-hold", "artifact-a", "sha256:" + DIGEST,
                    authenticated("other-tenant", "principal-a"), "corr-x"))
                    .isInstanceOf(SecurityException.class);
            assertThat(fixture.administration().record(
                    "tenant-hold", "artifact-a", "sha256:" + DIGEST))
                    .hasValueSatisfying(record -> assertThat(record.revoked()).isFalse());
        }
    }

    @Test
    void revokedSourceFailsResolveAndRevalidateClosed() throws Exception {
        try (Fixture fixture = openFixture()) {
            fixture.administration().register(register("tenant-rev", "principal-a", "artifact-a"),
                    authenticated("tenant-rev", "principal-a"));
            var allowed = fixture.authority().resolve(request("tenant-rev", "principal-a", "artifact-a"),
                    authenticated("tenant-rev", "principal-a"));
            assertThat(allowed.status()).isEqualTo(MediaSourceAuthorizationContracts.Status.ALLOWED);
            var revoked = fixture.administration().revoke(
                    "tenant-rev", "artifact-a", "sha256:" + DIGEST,
                    authenticated("tenant-rev", "principal-a"), "corr-1");
            assertThat(revoked).isPresent();
            assertThat(revoked.get().revocationEpoch()).isEqualTo(1);
            assertThat(fixture.authority().resolve(
                    request("tenant-rev", "principal-a", "artifact-a"),
                    authenticated("tenant-rev", "principal-a")).status())
                    .isEqualTo(MediaSourceAuthorizationContracts.Status.REVOKED);
            assertThat(fixture.authority().revalidate(
                    request("tenant-rev", "principal-a", "artifact-a"), allowed.evidence(),
                    authenticated("tenant-rev", "principal-a")).status())
                    .isEqualTo(MediaSourceAuthorizationContracts.Status.REVOKED);
        }
    }

    @Test
    void expiredAndPolicyDeniedSourcesNeverProduceEvidence() throws Exception {
        try (Fixture fixture = openFixture()) {
            fixture.administration().register(register("tenant-exp", "principal-a", "artifact-a"),
                    authenticated("tenant-exp", "principal-a"));
            fixture.engine().outcome.set(PolicyDecisionOutcome.DENY);
            assertThat(fixture.authority().resolve(
                    request("tenant-exp", "principal-a", "artifact-a"),
                    authenticated("tenant-exp", "principal-a")).status())
                    .isEqualTo(MediaSourceAuthorizationContracts.Status.DENIED);
            fixture.engine().outcome.set(null);
            fixture.engine().throwOnEvaluate.set(true);
            assertThat(fixture.authority().resolve(
                    request("tenant-exp", "principal-a", "artifact-a"),
                    authenticated("tenant-exp", "principal-a")).status())
                    .isEqualTo(MediaSourceAuthorizationContracts.Status.UNAVAILABLE);
            expireRecord(fixture.state(), "tenant-exp", "artifact-a");
            fixture.engine().throwOnEvaluate.set(false);
            assertThat(fixture.authority().resolve(
                    request("tenant-exp", "principal-a", "artifact-a"),
                    authenticated("tenant-exp", "principal-a")).status())
                    .isEqualTo(MediaSourceAuthorizationContracts.Status.STALE);
            assertThat(decisionCount(fixture.state(), "tenant-exp")).isZero();
        }
    }

    @Test
    void revalidationDetectsMismatchedOrExpiredDecisions() throws Exception {
        try (Fixture fixture = openFixture()) {
            fixture.administration().register(register("tenant-mis", "principal-a", "artifact-a"),
                    authenticated("tenant-mis", "principal-a"));
            fixture.administration().register(register("tenant-mis", "principal-a", "artifact-b",
                    "b".repeat(64)), authenticated("tenant-mis", "principal-a"));
            var allowed = fixture.authority().resolve(request("tenant-mis", "principal-a", "artifact-a"),
                    authenticated("tenant-mis", "principal-a"));
            assertThat(allowed.status()).isEqualTo(MediaSourceAuthorizationContracts.Status.ALLOWED);
            assertThat(fixture.authority().revalidate(
                    request("tenant-mis", "principal-a", "artifact-b", "b".repeat(64)),
                    allowed.evidence(), authenticated("tenant-mis", "principal-a")).status())
                    .isEqualTo(MediaSourceAuthorizationContracts.Status.DENIED);
        }
    }

    @Test
    void currentRecordsReturnsEveryArtifactVersionIncludingRevokedForStatusMapping() throws Exception {
        try (Fixture fixture = openFixture()) {
            fixture.administration().register(register("tenant-list", "principal-a", "artifact-a"),
                    authenticated("tenant-list", "principal-a"));
            fixture.administration().register(register("tenant-list", "principal-a", "artifact-a",
                    "c".repeat(64)), authenticated("tenant-list", "principal-a"));
            fixture.administration().register(register("tenant-list", "principal-a", "artifact-b",
                    "d".repeat(64)), authenticated("tenant-list", "principal-a"));

            var listed = fixture.administration().currentRecords("tenant-list", "artifact-a");
            assertThat(listed).hasSize(2);
            assertThat(listed.get(0).registeredAt())
                    .isAfterOrEqualTo(listed.get(1).registeredAt());
            assertThat(listed.stream().map(MediaSourceRightsAdministration.SourceRecord::sourceVersion))
                    .containsExactlyInAnyOrder("sha256:" + DIGEST, "sha256:" + "c".repeat(64));

            // Revoked rows stay visible so a resolver can distinguish REVOKED from DENIED.
            fixture.administration().revoke("tenant-list", "artifact-a",
                    "sha256:" + "c".repeat(64), authenticated("tenant-list", "principal-a"), "corr-l1");
            var afterRevoke = fixture.administration().currentRecords("tenant-list", "artifact-a");
            assertThat(afterRevoke).hasSize(2);
            assertThat(afterRevoke.stream()
                    .filter(r -> r.sourceVersion().equals("sha256:" + "c".repeat(64)))
                    .findFirst().orElseThrow().revoked()).isTrue();
            assertThat(afterRevoke.stream()
                    .filter(r -> r.sourceVersion().equals("sha256:" + DIGEST))
                    .findFirst().orElseThrow().revoked()).isFalse();

            assertThat(fixture.administration().currentRecords("tenant-list", "missing")).isEmpty();
            assertThat(fixture.administration().currentRecords("other-tenant", "artifact-a")).isEmpty();
        }
    }

    private static MediaSourceAuthorizationContracts.Request request(
            String tenant, String principal, String artifact) {
        return request(tenant, principal, artifact, "transcription", "local", ProviderDataRetention.NONE);
    }

    private static MediaSourceAuthorizationContracts.Request request(
            String tenant, String principal, String artifact,
            String purpose, String region, ProviderDataRetention retention) {
        return new MediaSourceAuthorizationContracts.Request(
                tenant, principal, artifact, new ArtifactVersion("sha256:" + DIGEST), DIGEST,
                "SPEECH_TO_TEXT", purpose, "provider-a", "v1",
                ProcessingBoundary.LOCAL, region, retention);
    }

    private static MediaSourceAuthorizationContracts.Request request(
            String tenant, String principal, String artifact, String digest) {
        return new MediaSourceAuthorizationContracts.Request(
                tenant, principal, artifact, new ArtifactVersion("sha256:" + digest), digest,
                "SPEECH_TO_TEXT", "transcription", "provider-a", "v1",
                ProcessingBoundary.LOCAL, "local", ProviderDataRetention.NONE);
    }

    private static MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated(
            String tenant, String principal) {
        return new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(
                tenant, principal, Instant.now());
    }

    private static RegisterRequest register(String tenant, String principal, String artifact) {
        return register(tenant, principal, artifact, DIGEST);
    }

    private static RegisterRequest register(String tenant, String principal, String artifact, String digest) {
        return register(tenant, principal, artifact, digest, principal);
    }

    private static RegisterRequest register(
            String tenant, String principal, String artifact, String digest, String sourceOwnerId) {
        return new RegisterRequest(
                tenant, principal, artifact, "sha256:" + digest, digest, sourceOwnerId,
                MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                "", Set.of("speech_to_text"), Set.of("transcription"), Set.of("local"),
                Set.of(ProviderDataRetention.NONE), "source-clock-ref-1", "provenance://record/1",
                Instant.now().plus(Duration.ofHours(1)), "corr-register");
    }

    private static long decisionCount(MediaAwsPostgresqlRuntimeState state, String tenant)
            throws Exception {
        try (Connection c = state.connection(); PreparedStatement s = c.prepareStatement(
                "SELECT COUNT(*) FROM media_source_rights_decisions WHERE tenant_id=?")) {
            s.setString(1, tenant);
            try (var row = s.executeQuery()) {
                row.next();
                return row.getLong(1);
            }
        }
    }

    private static void expireRecord(MediaAwsPostgresqlRuntimeState state, String tenant, String artifact)
            throws Exception {
        try (Connection c = state.connection(); PreparedStatement s = c.prepareStatement(
                "UPDATE media_source_records SET expires_at=? WHERE tenant_id=? AND artifact_id=?")) {
            s.setLong(1, System.currentTimeMillis() - 1000);
            s.setString(2, tenant);
            s.setString(3, artifact);
            assertThat(s.executeUpdate()).isEqualTo(1);
        }
    }

    private static final class Fixture implements AutoCloseable {
        private final AutoCloseable installed;
        private final MediaAwsPostgresqlRuntimeState state;
        private final FakePolicyEngine engine;
        private final PostgresqlMediaSourceRightsAdministration administration;
        private final PostgresqlMediaSourceAuthorizationAuthority authority;

        Fixture(AutoCloseable installed, MediaAwsPostgresqlRuntimeState state, FakePolicyEngine engine,
                PostgresqlMediaSourceRightsAdministration administration,
                PostgresqlMediaSourceAuthorizationAuthority authority) {
            this.installed = installed;
            this.state = state;
            this.engine = engine;
            this.administration = administration;
            this.authority = authority;
        }

        MediaAwsPostgresqlRuntimeState state() { return state; }
        FakePolicyEngine engine() { return engine; }
        PostgresqlMediaSourceRightsAdministration administration() { return administration; }
        PostgresqlMediaSourceAuthorizationAuthority authority() { return authority; }

        @Override public void close() throws Exception {
            authority.close();
            administration.close();
            state.release();
            installed.close();
        }
    }

    private static Fixture openFixture() throws Exception {
        String bucket = "media-source-rights-" + UUID.randomUUID().toString().replace("-", "");
        try (S3Client client = S3Client.builder().endpointOverride(LOCALSTACK.getEndpoint())
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment(bucket));
        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        FakePolicyEngine engine = new FakePolicyEngine();
        return new Fixture(installed, state, engine,
                new PostgresqlMediaSourceRightsAdministration(state),
                new PostgresqlMediaSourceAuthorizationAuthority(state, engine));
    }

    private static Map<String, String> environment(String bucket) {
        Map<String, String> env = new HashMap<>();
        env.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        env.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        env.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_SOURCE_DB_PASSWORD");
        env.put("MEDIA_SOURCE_DB_PASSWORD", POSTGRES.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_S3_BUCKET", bucket);
        env.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        env.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpoint().toString());
        env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_SECRET");
        env.put("MEDIA_ACCESS", LOCALSTACK.getAccessKey());
        env.put("MEDIA_SECRET", LOCALSTACK.getSecretKey());
        return env;
    }

    private static final class FakePolicyEngine implements PolicyEngine {
        private final AtomicReference<PolicyDecisionOutcome> outcome = new AtomicReference<>(PolicyDecisionOutcome.ALLOW);
        private final AtomicReference<Boolean> throwOnEvaluate = new AtomicReference<>(false);

        @Override public CompletionStage<PolicyDecisionRecord> evaluate(PolicyEvaluationRequest request) {
            if (throwOnEvaluate.get()) throw new IllegalStateException("policy engine unavailable");
            PolicyEvaluationContext context = new PolicyEvaluationContext(
                    request.principalId(), request.tenantId(), request.actionClass(), request.targetType(),
                    request.targetId(), request.toolId(), request.criticality(), request.reversibility(),
                    request.attributes(), Instant.now(), request.correlationId(), request.verifiedContext());
            PolicyDecisionOutcome actual = outcome.get();
            PolicyDecisionRecord decision = new PolicyDecisionRecord(
                    "policy-decision-fixture", actual,
                    List.of("policy-v1:rule-allow-media"), List.of("rule-allow-media"),
                    List.of("fixture policy evaluation"), context, Instant.now(), null, "policy-v1",
                    List.of(actual == PolicyDecisionOutcome.ALLOW
                            ? PolicyReasonCode.POLICY_ALLOWED : PolicyReasonCode.POLICY_DENIED));
            return CompletableFuture.completedFuture(decision);
        }

        @Override public CompletionStage<Boolean> policyExists(String policyId) {
            return CompletableFuture.completedFuture("policy-v1".equals(policyId));
        }

        @Override public CompletionStage<Boolean> policyExists(String policyId, String policyVersion) {
            return policyExists(policyId);
        }

        @Override public boolean isOpen() { return true; }

        @Override public void close() { }

        @Override public PolicyEngineLifecycle.State lifecycleState() {
            return PolicyEngineLifecycle.State.OPEN;
        }

        @Override public long inFlightEvaluations() { return 0; }

        @Override public PolicyEngineLifecycle.Result drain(Duration timeout) {
            return new PolicyEngineLifecycle.Result(PolicyEngineLifecycle.State.DRAINED, 0);
        }

        @Override public PolicyEngineLifecycle.Result close(Duration timeout) {
            return new PolicyEngineLifecycle.Result(PolicyEngineLifecycle.State.CLOSED, 0);
        }
    }
}
