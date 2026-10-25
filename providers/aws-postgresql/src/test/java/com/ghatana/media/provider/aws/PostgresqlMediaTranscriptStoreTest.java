package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptDraft;
import org.junit.jupiter.api.Test;
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
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@Testcontainers(disabledWithoutDocker = true)
class PostgresqlMediaTranscriptStoreTest {
    @Container static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices("s3");

    @Test
    void persistsImmutableCandidateRevisionsAndRejectsUnboundOrRevokedInputs() throws Exception {
        String bucket = "media-transcript-test";
        try (S3Client client = S3Client.builder().endpointOverride(LOCALSTACK.getEndpoint())
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }

        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment(bucket));
             PostgresqlMediaTranscriptStore store = new PostgresqlMediaTranscriptStore()) {
            MediaAwsPostgresqlRuntimeState testState = MediaAwsPostgresqlRuntimeState.acquire();
            try {
            String digest = "a".repeat(64);
            seed(testState, "tenant-a", "principal-a", "source-a", "job-a", "consent-a", digest, false);
            TranscriptDraft first = draft("tenant-a", "principal-a", "transcript-a", "source-a", "job-a", "consent-a", digest, "hello");
            var revision1 = store.append(first);
            assertThat(revision1.revision()).isEqualTo(1);
            assertThat(revision1.admissionStatus()).isEqualTo("CANDIDATE");
            assertThat(store.append(first)).isEqualTo(revision1); // retry is idempotent

            var revision2 = store.append(draft("tenant-a", "principal-a", "transcript-a", "source-a", "job-a", "consent-a", digest, "hello again"));
            assertThat(revision2.revision()).isEqualTo(2);
            assertThat(store.revisions("tenant-a", "transcript-a")).extracting(r -> r.draft().text())
                    .containsExactly("hello", "hello again");

            TranscriptDraft stalePin = draft("tenant-a", "principal-a", "transcript-stale", "source-a", "job-a", "consent-a", "b".repeat(64), "not stored");
            assertThatThrownBy(() -> store.append(stalePin)).isInstanceOf(IllegalStateException.class);
            assertThat(store.revisions("tenant-a", "transcript-stale")).isEmpty();
            assertThat(store.revisions("tenant-b", "transcript-a")).isEmpty();

            String revokedDigest = "c".repeat(64);
            seed(testState, "tenant-a", "principal-a", "source-revoked", "job-revoked", "consent-revoked", revokedDigest, true);
            TranscriptDraft revoked = draft("tenant-a", "principal-a", "transcript-revoked", "source-revoked", "job-revoked", "consent-revoked", revokedDigest, "denied");
            assertThatThrownBy(() -> store.append(revoked)).isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("revoked");
            assertThat(store.revisions("tenant-a", "transcript-revoked")).isEmpty();

            TranscriptDraft foreign = draft("tenant-b", "principal-b", "transcript-foreign", "source-a", "job-a", "consent-a", digest, "denied");
            assertThatThrownBy(() -> store.append(foreign)).isInstanceOf(IllegalStateException.class);
            assertThat(store.revisions("tenant-b", "transcript-foreign")).isEmpty();
            } finally {
                testState.release();
            }
        }
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
                if (revoked) s.setLong(9,System.currentTimeMillis()); else s.setObject(9,null);
                s.setLong(10,1); s.executeUpdate();
            }
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
        env.put("MEDIA_POSTGRES_JDBC_URL","jdbc:h2:mem:transcript-"+UUID.randomUUID()+";MODE=PostgreSQL;DB_CLOSE_DELAY=-1;DB_CLOSE_ON_EXIT=false");
        env.put("MEDIA_POSTGRES_USER","sa"); env.put("MEDIA_POSTGRES_DRIVER","org.h2.Driver");
        env.put("MEDIA_S3_BUCKET",bucket); env.put("MEDIA_S3_REGION",LOCALSTACK.getRegion());
        env.put("MEDIA_S3_ENDPOINT",LOCALSTACK.getEndpoint().toString()); env.put("MEDIA_S3_PATH_STYLE","true");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE","secret:env:MEDIA_ACCESS"); env.put("MEDIA_S3_SECRET_KEY_REFERENCE","secret:env:MEDIA_SECRET");
        env.put("MEDIA_ACCESS",LOCALSTACK.getAccessKey()); env.put("MEDIA_SECRET",LOCALSTACK.getSecretKey());
        return env;
    }
}
