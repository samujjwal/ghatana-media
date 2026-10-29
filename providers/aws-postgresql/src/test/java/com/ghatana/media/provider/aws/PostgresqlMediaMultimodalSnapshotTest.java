package com.ghatana.media.provider.aws;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MultimodalOperationSnapshot;
import com.ghatana.media.runtime.MediaRuntimeContracts.MultimodalOperationSpec;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;

import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * PostgreSQL-backed durable multimodal operation snapshot coverage: the persisted
 * {@code mm_operation_snapshot} column is the reconstruction authority for restart
 * recovery, so a read-back spec must equal the submitted spec exactly and a reused
 * request identity with a different spec must conflict.
 */
@Testcontainers(disabledWithoutDocker = true)
class PostgresqlMediaMultimodalSnapshotTest {
    private static final String SHA_A = "a".repeat(64);
    private static final String SHA_B = "b".repeat(64);

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void persistedSnapshotReadsBackTheExactOperationSpec() throws Exception {
        try (AutoCloseable ignored = MediaAwsPostgresqlRuntimeState.installForTesting(
                     integrationEnvironment(bucket()));
             PostgresqlMediaJobStore store = new PostgresqlMediaJobStore()) {
            MultimodalOperationSpec spec = spec(1);
            ProcessingJob job = mmJob("request-mm-" + runId());
            store.create(job, job.requestFingerprint(), null, snapshot(spec));

            var readback = store.findMultimodalOperationSnapshot(job.tenantId(), job.jobId());
            assertThat(readback).isPresent();
            MultimodalOperationSnapshot retained = readback.orElseThrow();
            assertThat(retained.operationSpec()).isEqualTo(spec);
            assertThat(retained.rightsDecisionId()).isEqualTo("rights-1");
            assertThat(retained.policyDecisionId()).isEqualTo("policy-1");
            assertThat(retained.consentDecisionId()).isEqualTo("consent-1");
            assertThat(retained.sourceClockEvidenceRef()).isEqualTo("clock-evidence-1");
            assertThat(retained.revocationEpoch()).isEqualTo(0L);

            // Same request identity with the identical spec resolves to the same job.
            assertThat(store.create(job, job.requestFingerprint(), null, snapshot(spec)).jobId())
                    .isEqualTo(job.jobId());
            // A different tenant sees no snapshot.
            assertThat(store.findMultimodalOperationSnapshot("tenant-other", job.jobId()))
                    .isEmpty();
        }
    }

    @Test
    void replayedRequestIdentityWithADifferentSpecConflicts() throws Exception {
        try (AutoCloseable ignored = MediaAwsPostgresqlRuntimeState.installForTesting(
                     integrationEnvironment(bucket()));
             PostgresqlMediaJobStore store = new PostgresqlMediaJobStore()) {
            String requestId = "request-mm-" + runId();
            ProcessingJob job = mmJob(requestId);
            store.create(job, job.requestFingerprint(), null, snapshot(spec(1)));
            assertThatThrownBy(() -> store.create(
                    job, job.requestFingerprint(), null, snapshot(spec(2))))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("different multimodal operation spec");
        }
    }

    @Test
    void snapshotIsRequiredForMultimodalAndAbsentForOtherJobTypes() throws Exception {
        try (AutoCloseable ignored = MediaAwsPostgresqlRuntimeState.installForTesting(
                     integrationEnvironment(bucket()));
             PostgresqlMediaJobStore store = new PostgresqlMediaJobStore()) {
            ProcessingJob mm = mmJob("request-mm-" + runId());
            assertThatThrownBy(() -> store.create(mm, mm.requestFingerprint(), null, null))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("retained operation snapshot");

            ProcessingJob vision = new ProcessingJob(
                    "job-vis-" + runId(), "request-vis-" + runId(), "tenant-" + runId(),
                    "principal-a", "artifact-a", JobType.VISION, "provider-a",
                    JobStatus.ACCEPTED, Instant.now(), null, null, Map.of(), "", 1,
                    "", "c".repeat(64));
            store.create(vision);
            assertThat(store.findMultimodalOperationSnapshot(
                    vision.tenantId(), vision.jobId())).isEmpty();
            // A snapshot on a non-multimodal job is rejected at the fence.
            assertThatThrownBy(() -> store.create(
                    vision, vision.requestFingerprint(), null, snapshot(spec(1))))
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }

    private static String bucket() throws Exception {
        String bucket = "media-mm-" + UUID.randomUUID().toString().replace("-", "");
        try (S3Client client = S3Client.builder()
                .endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .build()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        return bucket;
    }

    private static Map<String, String> integrationEnvironment(String bucket) {
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "integration");
        environment.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        environment.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        environment.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_MM_DB_PASSWORD");
        environment.put("MEDIA_MM_DB_PASSWORD", POSTGRES.getPassword());
        environment.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        environment.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        environment.put("MEDIA_S3_BUCKET", bucket);
        environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_MM_ACCESS");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_MM_SECRET");
        environment.put("MEDIA_MM_ACCESS", LOCALSTACK.getAccessKey());
        environment.put("MEDIA_MM_SECRET", LOCALSTACK.getSecretKey());
        return environment;
    }

    private static ProcessingJob mmJob(String requestId) {
        String runId = runId();
        return new ProcessingJob(
                "job-mm-" + runId, requestId, "tenant-" + runId, "principal-a",
                "artifact-src", JobType.MULTIMODAL, "provider-mm", JobStatus.ACCEPTED,
                Instant.now(), null, null, Map.of(), "", 1,
                "", SHA_B.substring(0, 40) + runId.substring(0, 24));
    }

    private static MultimodalOperationSnapshot snapshot(MultimodalOperationSpec spec) {
        return new MultimodalOperationSnapshot(
                MultimodalOperationSnapshot.AUTHORIZED_VERSION, spec.toParametersValue(),
                "rights-1", "policy-1", "policy-v1", "consent-1", "clock-evidence-1", 0L);
    }

    private static MultimodalOperationSpec spec(int operationVersion) {
        return new MultimodalOperationSpec(
                MultimodalOperationSpec.SPEC_VERSION,
                "media.multimodal.observe.source-grounded",
                "media.operation.capability.media-multimodal-observe-source-grounded",
                operationVersion, "artifact-src", "sha256:" + SHA_A, SHA_A,
                List.of(
                        new MultimodalOperationSpec.ChildOperationSpec("stt",
                                JobType.SPEECH_TO_TEXT, "artifact-stt", "sha256:" + SHA_B,
                                SHA_B, "", Map.of()),
                        new MultimodalOperationSpec.ChildOperationSpec("vision",
                                JobType.VISION, "artifact-vis", "sha256:" + SHA_B,
                                SHA_B, "", Map.of())),
                new MultimodalOperationSpec.SourceClockBinding(
                        "clock-evidence-1", 48_000, 0, "src-clock", 96_000),
                Map.of("purpose", "mm-observe"));
    }

    private static String runId() {
        return UUID.randomUUID().toString().replace("-", "");
    }
}
