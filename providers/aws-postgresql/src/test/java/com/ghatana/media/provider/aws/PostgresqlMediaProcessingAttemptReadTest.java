package com.ghatana.media.provider.aws;

import static org.assertj.core.api.Assertions.assertThat;
import com.ghatana.media.runtime.MediaLifecycleEvent;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptObservation;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.localstack.LocalStackContainer;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;

/** Exact tenant/job/attempt readback from the durable provider-attempt table. */
@Testcontainers(disabledWithoutDocker = true)
class PostgresqlMediaProcessingAttemptReadTest {
    private static final String FINGERPRINT = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    private static final String PROVENANCE = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices("s3");

    @Test
    void readsExactPersistedAttemptAfterStoreRestartAndScopesByFullIdentity() throws Exception {
        String suffix = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-attempt-read-" + suffix;
        try (S3Client client = s3Client()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        Map<String, String> environment = integrationEnvironment(bucket);
        try (AutoCloseable ignored = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             PostgresqlMediaJobStore initial = new PostgresqlMediaJobStore()) {
            String tenant = "tenant-" + suffix;
            String jobId = "job-" + suffix;
            ProcessingJob accepted = new ProcessingJob(jobId, "request-" + suffix, tenant, "principal-a",
                    "artifact-a", JobType.TRANSCODE, "provider-a", JobStatus.ACCEPTED, Instant.now(),
                    null, null, Map.of(), "", 1, "", FINGERPRINT);
            initial.create(accepted);
            var lease = initial.claim(accepted, "worker-a", Instant.now().plusSeconds(60));
            ProcessingJob running = new ProcessingJob(jobId, accepted.requestId(), tenant, "principal-a",
                    "artifact-a", JobType.TRANSCODE, "provider-a", JobStatus.RUNNING, accepted.createdAt(),
                    Instant.now(), null, Map.of(), "", accepted.version() + 1, "", FINGERPRINT);
            var started = initial.startAttempt(accepted, running, lease, 1, FINGERPRINT);
            var withReceipt = initial.recordProviderReceipt(
                    started.attempt(), lease, "operation-exact", "receipt-exact");
            Instant observedAt = Instant.ofEpochMilli(Instant.now().toEpochMilli());
            Map<String, Object> providerResult = Map.of("label", "cat");
            ProviderAttemptObservation observation = new ProviderAttemptObservation(
                    withReceipt.query(), AttemptFinality.SUCCEEDED, "receipt-exact", providerResult,
                    PROVENANCE, observedAt);
            ProcessingJob completed = new ProcessingJob(jobId, accepted.requestId(), tenant, "principal-a",
                    "artifact-a", JobType.TRANSCODE, "provider-a", JobStatus.COMPLETED, accepted.createdAt(),
                    started.running().startedAt(), observedAt, providerResult, "", started.running().version() + 1,
                    "", FINGERPRINT);
            initial.commitFinalOutcome(started.running(), withReceipt, completed, observation,
                    event(completed, "MEDIA_JOB_COMPLETED"));

            try (PostgresqlMediaJobStore restarted = new PostgresqlMediaJobStore()) {
                initial.close();
                var attempt = restarted.findProcessingAttempt(tenant, jobId, 1).orElseThrow();
                assertThat(attempt.tenantId()).isEqualTo(tenant);
                assertThat(attempt.jobId()).isEqualTo(jobId);
                assertThat(attempt.requestId()).isEqualTo(accepted.requestId());
                assertThat(attempt.attemptNumber()).isEqualTo(1);
                assertThat(attempt.fencingToken()).isEqualTo(lease.fencingToken());
                assertThat(attempt.requestFingerprint()).isEqualTo(FINGERPRINT);
                assertThat(attempt.providerId()).isEqualTo("provider-a");
                assertThat(attempt.providerOperationId()).isEqualTo("operation-exact");
                assertThat(attempt.providerReceiptId()).isEqualTo("receipt-exact");
                assertThat(attempt.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
                assertThat(attempt.resultDigest()).isEqualTo(sha256("{\"label\":\"cat\"}"));
                assertThat(attempt.provenanceDigest()).isEqualTo(PROVENANCE);
                assertThat(attempt.observedAt()).isEqualTo(observedAt);

                assertThat(restarted.findProcessingAttempt("wrong-" + tenant, jobId, 1)).isEmpty();
                assertThat(restarted.findProcessingAttempt(tenant, "wrong-" + jobId, 1)).isEmpty();
                assertThat(restarted.findProcessingAttempt(tenant, jobId, 2)).isEmpty();
                assertThat(restarted.findProcessingAttempt(tenant, "absent-job", 1)).isEmpty();
            }
        }
    }

    @Test
    void mapsDispatchUnknownFailedAndNoEffectFinalityFromPersistedState() throws Exception {
        String suffix = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-attempt-states-" + suffix;
        try (S3Client client = s3Client()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        try (AutoCloseable ignored = MediaAwsPostgresqlRuntimeState.installForTesting(integrationEnvironment(bucket));
             PostgresqlMediaJobStore store = new PostgresqlMediaJobStore()) {
            var dispatch = startAttempt(store, "tenant-" + suffix, "dispatch-" + suffix);
            var dispatchRead = store.findProcessingAttempt(dispatch.tenantId(), dispatch.running().jobId(), 1)
                    .orElseThrow();
            assertIdentity(dispatchRead, dispatch);
            assertThat(dispatchRead.finality()).isEqualTo(AttemptFinality.UNKNOWN);
            assertThat(dispatchRead.providerOperationId()).isBlank();
            assertThat(dispatchRead.providerReceiptId()).isBlank();
            assertThat(dispatchRead.resultDigest()).isBlank();
            assertThat(dispatchRead.provenanceDigest()).isBlank();
            assertThat(dispatchRead.observedAt()).isNull();

            var unknown = startAttempt(store, "tenant-" + suffix, "unknown-" + suffix);
            ProcessingJob unknownJob = terminal(unknown.running(), JobStatus.OUTCOME_UNKNOWN, Map.of());
            store.markOutcomeUnknown(unknown.running(), unknown.attempt(), unknownJob, Map.of(),
                    event(unknownJob, "MEDIA_JOB_OUTCOME_UNKNOWN"));
            var unknownRead = store.findProcessingAttempt(unknown.tenantId(), unknown.running().jobId(), 1)
                    .orElseThrow();
            assertIdentity(unknownRead, unknown);
            assertThat(unknownRead.finality()).isEqualTo(AttemptFinality.UNKNOWN);
            assertThat(unknownRead.providerOperationId()).isBlank();
            assertThat(unknownRead.providerReceiptId()).isBlank();
            assertThat(unknownRead.resultDigest()).isBlank();
            assertThat(unknownRead.provenanceDigest()).isBlank();
            assertThat(unknownRead.observedAt()).isNotNull();

            var failed = startAttempt(store, "tenant-" + suffix, "failed-" + suffix);
            var failedWithReceipt = store.recordProviderReceipt(
                    failed.attempt(), failed.lease(), "failed-operation", "failed-receipt");
            Instant failedObservedAt = Instant.ofEpochMilli(Instant.now().toEpochMilli());
            ProviderAttemptObservation failedObservation = new ProviderAttemptObservation(
                    failedWithReceipt.query(), AttemptFinality.FAILED, "failed-receipt", Map.of(),
                    PROVENANCE, failedObservedAt);
            ProcessingJob failedJob = terminal(failed.running(), JobStatus.FAILED, Map.of());
            store.commitFinalOutcome(failed.running(), failedWithReceipt, failedJob, failedObservation,
                    event(failedJob, "MEDIA_JOB_FAILED"));
            var failedRead = store.findProcessingAttempt(failed.tenantId(), failed.running().jobId(), 1)
                    .orElseThrow();
            assertIdentity(failedRead, failed);
            assertThat(failedRead.finality()).isEqualTo(AttemptFinality.FAILED);
            assertThat(failedRead.providerOperationId()).isEqualTo("failed-operation");
            assertThat(failedRead.providerReceiptId()).isEqualTo("failed-receipt");
            assertThat(failedRead.resultDigest()).isBlank();
            assertThat(failedRead.provenanceDigest()).isEqualTo(PROVENANCE);
            assertThat(failedRead.observedAt()).isEqualTo(failedObservedAt);

            var noEffect = startAttempt(store, "tenant-" + suffix, "no-effect-" + suffix);
            ProcessingJob refused = terminal(noEffect.running(), JobStatus.FAILED, Map.of());
            store.markPreDispatchNoEffect(noEffect.running(), noEffect.attempt(), refused,
                    event(refused, "MEDIA_JOB_FAILED"));
            var noEffectRead = store.findProcessingAttempt(noEffect.tenantId(), noEffect.running().jobId(), 1)
                    .orElseThrow();
            assertIdentity(noEffectRead, noEffect);
            assertThat(noEffectRead.finality()).isEqualTo(AttemptFinality.NO_EFFECT_PROVEN);
            assertThat(noEffectRead.providerOperationId()).isBlank();
            assertThat(noEffectRead.providerReceiptId()).isBlank();
            assertThat(noEffectRead.resultDigest()).isBlank();
            assertThat(noEffectRead.provenanceDigest()).isBlank();
            assertThat(noEffectRead.observedAt()).isNotNull();

            assertThat(store.findProcessingAttempt("wrong-tenant", dispatch.running().jobId(), 1)).isEmpty();
            assertThat(store.findProcessingAttempt(dispatch.tenantId(), "wrong-job", 1)).isEmpty();
            assertThat(store.findProcessingAttempt(dispatch.tenantId(), dispatch.running().jobId(), 2)).isEmpty();
        }
    }

    private static AttemptFixture startAttempt(PostgresqlMediaJobStore store, String tenant, String jobId) {
        ProcessingJob accepted = new ProcessingJob(jobId, "request-" + jobId, tenant, "principal-a",
                "artifact-a", JobType.TRANSCODE, "provider-a", JobStatus.ACCEPTED, Instant.now(),
                null, null, Map.of(), "", 1, "", FINGERPRINT);
        store.create(accepted);
        var lease = store.claim(accepted, "worker-a", Instant.now().plusSeconds(60));
        ProcessingJob running = new ProcessingJob(jobId, accepted.requestId(), tenant, "principal-a",
                "artifact-a", JobType.TRANSCODE, "provider-a", JobStatus.RUNNING, accepted.createdAt(),
                Instant.now(), null, Map.of(), "", accepted.version() + 1, "", FINGERPRINT);
        var started = store.startAttempt(accepted, running, lease, 1, FINGERPRINT);
        return new AttemptFixture(tenant, started.running(), started.attempt(), lease);
    }

    private static ProcessingJob terminal(ProcessingJob running, JobStatus status, Map<String, Object> result) {
        return new ProcessingJob(running.jobId(), running.requestId(), running.tenantId(), running.principalId(),
                running.artifactId(), running.jobType(), running.providerId(), status, running.createdAt(),
                running.startedAt(), Instant.now(), result, "", running.version() + 1,
                running.expectedArtifactVersion(), running.requestFingerprint());
    }

    private static void assertIdentity(
            com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingAttempt actual,
            AttemptFixture expected) {
        assertThat(actual.tenantId()).isEqualTo(expected.tenantId());
        assertThat(actual.jobId()).isEqualTo(expected.running().jobId());
        assertThat(actual.attemptNumber()).isEqualTo(expected.attempt().attemptNumber());
    }

    private static MediaLifecycleEvent event(ProcessingJob job, String eventType) {
        return new MediaLifecycleEvent("media:attempt-read:" + eventType + ":" + job.jobId(), eventType,
                job.tenantId(), job.principalId(), job.requestId(), job.requestId(),
                "job", job.jobId(), job.version(), "INTERNAL", job.completedAt(), Map.of());
    }

    private record AttemptFixture(String tenantId, ProcessingJob running,
                                  com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingAttempt attempt,
                                  com.ghatana.media.runtime.MediaRuntimeContracts.JobLease lease) { }

    private static S3Client s3Client() {
        return S3Client.builder()
                .endpointOverride(LOCALSTACK.getEndpoint())
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .build();
    }

    private static Map<String, String> integrationEnvironment(String bucket) {
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        environment.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        environment.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        environment.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_ATTEMPT_READ_DB_PASSWORD");
        environment.put("MEDIA_ATTEMPT_READ_DB_PASSWORD", POSTGRES.getPassword());
        environment.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        environment.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        environment.put("MEDIA_S3_BUCKET", bucket);
        environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpoint().toString());
        environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_ATTEMPT_READ_ACCESS");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_ATTEMPT_READ_SECRET");
        environment.put("MEDIA_ATTEMPT_READ_ACCESS", LOCALSTACK.getAccessKey());
        environment.put("MEDIA_ATTEMPT_READ_SECRET", LOCALSTACK.getSecretKey());
        return environment;
    }

    private static String sha256(String value) throws Exception {
        return java.util.HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
    }
}
