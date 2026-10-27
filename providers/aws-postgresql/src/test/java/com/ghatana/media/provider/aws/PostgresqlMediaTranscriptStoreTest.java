package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptDraft;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptPrincipalConflictException;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevisionConflictException;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptDerivedCapability;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptCapabilityDisposition;
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
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@Testcontainers(disabledWithoutDocker = true)
class PostgresqlMediaTranscriptStoreTest {

    @Test
    void unsupportedDerivedOperationsAreTypedNoEffectAndPersistNoCaptionVersion() throws Exception {
        try (Fixture fixture = openFixture()) {
            var store = fixture.store();
            for (TranscriptDerivedCapability capability : TranscriptDerivedCapability.values()) {
                var result = store.capability(capability);
                assertThat(result.disposition()).isEqualTo(TranscriptCapabilityDisposition.UNMET_CAPABILITY);
                assertThat(result.effectOccurred()).isFalse();
                assertThat(result.blockers()).isNotEmpty();
            }
            assertThat(store.revisions("tenant-capability", "principal-a", "transcript-capability")).isEmpty();
        }
    }
    @Container static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices("s3");

    @Test
    void persistsImmutableCandidateRevisionsAndRejectsUnboundOrRevokedInputs() throws Exception {
        try (Fixture fixture = openFixture()) {
            PostgresqlMediaTranscriptStore store = fixture.store();
            MediaAwsPostgresqlRuntimeState testState = fixture.state();
            String digest = "a".repeat(64);
            seed(testState, "tenant-a", "principal-a", "source-a", "job-a", "consent-a", digest, false);
            TranscriptDraft first = draft("tenant-a", "principal-a", "transcript-a", "source-a", "job-a", "consent-a", digest, "hello");
            var revision1 = store.append(first);
            assertThat(revision1.revision()).isEqualTo(1);
            assertThat(revision1.admissionStatus()).isEqualTo("CANDIDATE");
            assertThat(store.append(first)).isEqualTo(revision1); // retry is idempotent

            var revision2 = store.append(draft("tenant-a", "principal-a", "transcript-a", "source-a", "job-a", "consent-a", digest, "hello again"), 1);
            assertThat(revision2.revision()).isEqualTo(2);
            assertThat(store.revisions("tenant-a", "principal-a", "transcript-a")).extracting(r -> r.draft().text())
                    .containsExactly("hello", "hello again");

            TranscriptDraft stalePin = draft("tenant-a", "principal-a", "transcript-stale", "source-a", "job-a", "consent-a", "b".repeat(64), "not stored");
            assertThatThrownBy(() -> store.append(stalePin)).isInstanceOf(IllegalStateException.class);
            assertThat(store.revisions("tenant-a", "principal-a", "transcript-stale")).isEmpty();
            assertThat(store.revisions("tenant-b", "principal-a", "transcript-a")).isEmpty();

            String revokedDigest = "c".repeat(64);
            seed(testState, "tenant-a", "principal-a", "source-revoked", "job-revoked", "consent-revoked", revokedDigest, true);
            TranscriptDraft revoked = draft("tenant-a", "principal-a", "transcript-revoked", "source-revoked", "job-revoked", "consent-revoked", revokedDigest, "denied");
            assertThatThrownBy(() -> store.append(revoked)).isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("revoked");
            assertThat(store.revisions("tenant-a", "principal-a", "transcript-revoked")).isEmpty();

            TranscriptDraft foreign = draft("tenant-b", "principal-b", "transcript-foreign", "source-a", "job-a", "consent-a", digest, "denied");
            assertThatThrownBy(() -> store.append(foreign)).isInstanceOf(IllegalStateException.class);
            assertThat(store.revisions("tenant-b", "principal-b", "transcript-foreign")).isEmpty();
        }
    }

    @Test
    void changedDraftRequiresCurrentExpectedRevisionAndLegacyAppendCannotBypassCas() throws Exception {
        try (Fixture fixture = openFixture()) {
            var store = fixture.store();
            var state = fixture.state();
            String digest = "d".repeat(64);
            seed(state, "tenant-cas", "principal-a", "source-cas", "job-cas", "consent-cas", digest, false);
            TranscriptDraft initial = draft("tenant-cas", "principal-a", "transcript-cas", "source-cas",
                    "job-cas", "consent-cas", digest, "initial");
            var first = store.append(initial, 0);
            assertThat(store.append(initial, 0)).isEqualTo(first); // exact retry is a no-op

            TranscriptDraft correction = draft("tenant-cas", "principal-a", "transcript-cas", "source-cas",
                    "job-cas", "consent-cas", digest, "corrected");
            assertThatThrownBy(() -> store.append(correction))
                    .isInstanceOf(TranscriptRevisionConflictException.class)
                    .satisfies(failure -> {
                        var conflict = (TranscriptRevisionConflictException) failure;
                        assertThat(conflict.expectedLatestRevision()).isZero();
                        assertThat(conflict.actualLatestRevision()).isEqualTo(1);
                    });
            var second = store.append(correction, 1);
            assertThat(second.revision()).isEqualTo(2);

            TranscriptDraft staleCorrection = draft("tenant-cas", "principal-a", "transcript-cas", "source-cas",
                    "job-cas", "consent-cas", digest, "stale correction");
            assertThatThrownBy(() -> store.append(staleCorrection, 1))
                    .isInstanceOf(TranscriptRevisionConflictException.class)
                    .satisfies(failure -> assertThat(
                            ((TranscriptRevisionConflictException) failure).actualLatestRevision()).isEqualTo(2));
            assertThat(store.revisions("tenant-cas", "principal-a", "transcript-cas"))
                    .extracting(value -> value.draft().text())
                    .containsExactly("initial", "corrected");
        }
    }

    @Test
    void concurrentInitialWritersCommitOneRevisionAndReportTypedConflicts() throws Exception {
        try (Fixture fixture = openFixture()) {
            var store = fixture.store();
            var state = fixture.state();
            String digest = "e".repeat(64);
            seed(state, "tenant-race", "principal-a", "source-race", "job-race-0", "consent-race", digest, false);
            int writers = 4;
            for (int i = 1; i < writers; i++) {
                seedCompletedJob(state, "tenant-race", "principal-a", "source-race",
                        "job-race-" + i, digest);
            }

            ExecutorService executor = Executors.newFixedThreadPool(writers);
            CountDownLatch ready = new CountDownLatch(writers);
            CountDownLatch start = new CountDownLatch(1);
            List<Future<TranscriptRevisionOutcome>> futures = new ArrayList<>();
            try {
                for (int i = 0; i < writers; i++) {
                    final int writer = i;
                    futures.add(executor.submit(() -> {
                        TranscriptDraft draft = draft("tenant-race", "principal-a", "transcript-race",
                                "source-race", "job-race-" + writer, "consent-race", digest, "candidate-" + writer);
                        ready.countDown();
                        if (!start.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("writers did not start");
                        try {
                            return TranscriptRevisionOutcome.committed(store.append(draft, 0));
                        } catch (TranscriptRevisionConflictException conflict) {
                            return TranscriptRevisionOutcome.conflict(conflict);
                        }
                    }));
                }
                assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
                start.countDown();
                List<TranscriptRevisionOutcome> outcomes = new ArrayList<>();
                for (Future<TranscriptRevisionOutcome> future : futures) outcomes.add(future.get(20, TimeUnit.SECONDS));
                assertThat(outcomes).filteredOn(TranscriptRevisionOutcome::committed).hasSize(1);
                assertThat(outcomes).filteredOn(outcome -> !outcome.committed()).hasSize(writers - 1);
                assertThat(outcomes.stream().filter(outcome -> !outcome.committed())
                        .map(TranscriptRevisionOutcome::conflict)
                        .map(TranscriptRevisionConflictException::actualLatestRevision))
                        .containsOnly(1);
                assertThat(store.revisions("tenant-race", "principal-a", "transcript-race"))
                        .hasSize(1).allSatisfy(revision -> assertThat(revision.revision()).isEqualTo(1));
            } finally {
                start.countDown();
                executor.shutdownNow();
            }
        }
    }

    @Test
    void transcriptIdentifierCannotBeReadOrReboundAcrossPrincipals() throws Exception {
        try (Fixture fixture = openFixture()) {
            var store = fixture.store();
            var state = fixture.state();
            String digestA = "f".repeat(64);
            String digestB = "1".repeat(64);
            seed(state, "tenant-scope", "principal-a", "source-a", "job-a", "consent-a", digestA, false);
            seed(state, "tenant-scope", "principal-b", "source-b", "job-b", "consent-b", digestB, false);
            TranscriptDraft owner = draft("tenant-scope", "principal-a", "shared-transcript-id", "source-a",
                    "job-a", "consent-a", digestA, "owner content");
            store.append(owner, 0);

            TranscriptDraft foreign = draft("tenant-scope", "principal-b", "shared-transcript-id", "source-b",
                    "job-b", "consent-b", digestB, "foreign content");
            assertThatThrownBy(() -> store.append(foreign, 1))
                    .isInstanceOf(TranscriptPrincipalConflictException.class);
            assertThat(store.revisions("tenant-scope", "principal-a", "shared-transcript-id"))
                    .extracting(value -> value.draft().text()).containsExactly("owner content");
            assertThat(store.revisions("tenant-scope", "principal-b", "shared-transcript-id")).isEmpty();
            assertThatThrownBy(() -> store.revisions("tenant-scope", "shared-transcript-id"))
                    .isInstanceOf(UnsupportedOperationException.class);
        }
    }

    private static Fixture openFixture() throws Exception {
        String bucket = "media-transcript-" + UUID.randomUUID().toString().replace("-", "");
        try (S3Client client = S3Client.builder().endpointOverride(LOCALSTACK.getEndpoint())
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }

        AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment(bucket));
        PostgresqlMediaTranscriptStore store = null;
        MediaAwsPostgresqlRuntimeState state = null;
        try {
            store = new PostgresqlMediaTranscriptStore();
            state = MediaAwsPostgresqlRuntimeState.acquire();
            return new Fixture(installed, store, state);
        } catch (RuntimeException failure) {
            if (state != null) state.release();
            if (store != null) store.close();
            installed.close();
            throw failure;
        }
    }

    private record Fixture(AutoCloseable installed, PostgresqlMediaTranscriptStore store,
                           MediaAwsPostgresqlRuntimeState state) implements AutoCloseable {
        @Override public void close() throws Exception {
            try {
                state.release();
            } finally {
                try {
                    store.close();
                } finally {
                    installed.close();
                }
            }
        }
    }

    private record TranscriptRevisionOutcome(
            com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevision revision,
            TranscriptRevisionConflictException conflict) {
        static TranscriptRevisionOutcome committed(
                com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevision revision) {
            return new TranscriptRevisionOutcome(revision, null);
        }
        static TranscriptRevisionOutcome conflict(TranscriptRevisionConflictException conflict) {
            return new TranscriptRevisionOutcome(null, conflict);
        }
        boolean committed() { return revision != null; }
    }

    private static void seed(MediaAwsPostgresqlRuntimeState state, String tenant, String principal,
                             String artifact, String job, String consent, String digest, boolean revoked) throws Exception {
        try (Connection c = state.connection()) {
            String artifactSql = "INSERT INTO media_artifacts (tenant_id,artifact_id,principal_id,file_name,content_type,size_bytes,sha256,object_reference,classification,created_at,expires_at,metadata_json,scan_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)";
            try (PreparedStatement s = c.prepareStatement(artifactSql)) {
                s.setString(1,tenant); s.setString(2,artifact); s.setString(3,principal); s.setString(4,"source.wav");
                s.setString(5,"audio/wav"); s.setLong(6,10); s.setString(7,digest); s.setString(8,"fixture");
                s.setString(9,"CONFIDENTIAL"); s.setLong(10,System.currentTimeMillis()); s.setLong(11,System.currentTimeMillis()+60000);
                s.setString(12,"{}"); s.setString(13,"CLEAN"); s.executeUpdate();
            }
            String jobSql = "INSERT INTO media_processing_jobs (tenant_id,job_id,request_id,principal_id,artifact_id,job_type,provider_id,status,created_at,result_json,failure_code,version,expected_artifact_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)";
            try (PreparedStatement s = c.prepareStatement(jobSql)) {
                s.setString(1,tenant); s.setString(2,job); s.setString(3,"request-"+job); s.setString(4,principal);
                s.setString(5,artifact); s.setString(6,"STT"); s.setString(7,"provider-a"); s.setString(8,"COMPLETED");
                s.setLong(9,System.currentTimeMillis()); s.setString(10,"{}"); s.setString(11,""); s.setLong(12,3);
                s.setString(13,"sha256:"+digest); s.executeUpdate();
            }
            try (PreparedStatement s = c.prepareStatement("INSERT INTO media_consents (tenant_id,consent_id,principal_id,purposes_csv,allowed_regions_csv,external_processing_allowed,biometric_processing_allowed,granted_at,revoked_at,version) VALUES (?,?,?,?,?,?,?,?,?,?)")) {
                s.setString(1,tenant); s.setString(2,consent); s.setString(3,principal); s.setString(4,"transcription");
                s.setString(5,"local"); s.setBoolean(6,false); s.setBoolean(7,false); s.setLong(8,System.currentTimeMillis());
                if (revoked) s.setLong(9,System.currentTimeMillis()); else s.setNull(9, java.sql.Types.BIGINT);
                s.setLong(10,1); s.executeUpdate();
            }
        }
    }

    private static void seedCompletedJob(MediaAwsPostgresqlRuntimeState state, String tenant, String principal,
                                         String artifact, String job, String digest) throws Exception {
        try (Connection c = state.connection(); PreparedStatement s = c.prepareStatement(
                "INSERT INTO media_processing_jobs (tenant_id,job_id,request_id,principal_id,artifact_id,job_type,provider_id,status,created_at,result_json,failure_code,version,expected_artifact_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")) {
            s.setString(1, tenant); s.setString(2, job); s.setString(3, "request-" + job);
            s.setString(4, principal); s.setString(5, artifact); s.setString(6, "STT");
            s.setString(7, "provider-a"); s.setString(8, "COMPLETED"); s.setLong(9, System.currentTimeMillis());
            s.setString(10, "{}"); s.setString(11, ""); s.setLong(12, 3); s.setString(13, "sha256:" + digest);
            s.executeUpdate();
        }
    }

    private static TranscriptDraft draft(String tenant, String principal, String transcript, String artifact,
                                         String job, String consent, String digest, String text) {
        return new TranscriptDraft(tenant,principal,transcript,artifact,"sha256:"+digest,digest,job,
                "profile-candidate","provider-a","model-a","en-US","milliseconds",text,
                consent,"rights-candidate","policy-candidate");
    }

    private static Map<String,String> environment(String bucket) {
        Map<String,String> env = new HashMap<>();
        env.put("MEDIA_RUNTIME_ENVIRONMENT","integration");
        env.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        env.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_TRANSCRIPT_DB_PASSWORD");
        env.put("MEDIA_TRANSCRIPT_DB_PASSWORD", POSTGRES.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_S3_BUCKET",bucket); env.put("MEDIA_S3_REGION",LOCALSTACK.getRegion());
        env.put("MEDIA_S3_ENDPOINT",LOCALSTACK.getEndpoint().toString()); env.put("MEDIA_S3_PATH_STYLE","true");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE","secret:env:MEDIA_ACCESS"); env.put("MEDIA_S3_SECRET_KEY_REFERENCE","secret:env:MEDIA_SECRET");
        env.put("MEDIA_ACCESS",LOCALSTACK.getAccessKey()); env.put("MEDIA_SECRET",LOCALSTACK.getSecretKey());
        return env;
    }
}
