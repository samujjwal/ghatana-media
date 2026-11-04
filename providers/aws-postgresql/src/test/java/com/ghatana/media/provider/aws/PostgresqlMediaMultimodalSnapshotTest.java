package com.ghatana.media.provider.aws;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.runtime.MediaLifecycleEvent;
import com.ghatana.media.runtime.MediaJobRequestFingerprint;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MultimodalOperationSnapshot;
import com.ghatana.media.runtime.MediaRuntimeContracts.MultimodalOperationSpec;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingAttempt;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptObservation;
import com.ghatana.media.runtime.MediaRuntimeContracts.SttSubmissionSnapshot;
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
    void parentAndChildAttemptBindingsSurviveStoreRecreationAndExactChildReplay() throws Exception {
        try (AutoCloseable ignored = MediaAwsPostgresqlRuntimeState.installForTesting(
                integrationEnvironment(bucket()))) {
            MultimodalOperationSpec spec = spec(1);
            String requestId = "request-mm-" + runId();
            ProcessingJob parent = mmJob(requestId);
            MultimodalOperationSnapshot retained = snapshot(spec);
            String childRequestId = MultimodalOperationSpec.childRequestId(requestId, "vision");
            ProcessingJob child = childJob(parent, childRequestId);

            try (PostgresqlMediaJobStore store = new PostgresqlMediaJobStore()) {
                store.create(parent, parent.requestFingerprint(), null, retained);
                // Starting the parent requires its accepted row to be durable first.
                var startedParent = store.startAttempt(
                        parent, running(parent),
                        store.claim(parent, "mm-worker", Instant.now().plusSeconds(60)),
                        1, parent.requestFingerprint());
                store.create(child, child.requestFingerprint(), null, null);
                var startedChild = store.startAttempt(
                        child, running(child),
                        store.claim(child, "vision-worker", Instant.now().plusSeconds(60)),
                        1, child.requestFingerprint());

                assertThat(startedParent.running().status()).isEqualTo(JobStatus.RUNNING);
                assertThat(startedChild.running().status()).isEqualTo(JobStatus.RUNNING);

                // Keep the shared Testcontainers state alive while replacing the store
                // handle. No in-memory child registry is available to resolve either job.
                PostgresqlMediaJobStore restarted = new PostgresqlMediaJobStore();
                store.close();
                try (restarted) {
                    ProcessingJob parentRead = restarted.findByRequest(parent.tenantId(), requestId)
                            .orElseThrow();
                    ProcessingJob childRead = restarted.findByRequest(parent.tenantId(), childRequestId)
                            .orElseThrow();
                    assertThat(parentRead.jobId()).isEqualTo(parent.jobId());
                    assertThat(parentRead.status()).isEqualTo(JobStatus.RUNNING);
                    assertThat(childRead.jobId()).isEqualTo(child.jobId());
                    assertThat(childRead.status()).isEqualTo(JobStatus.RUNNING);
                    var snapshotRead = restarted.findMultimodalOperationSnapshot(
                            parent.tenantId(), parent.jobId()).orElseThrow();
                    assertThat(snapshotRead.operationSpec()).isEqualTo(spec);
                    assertThat(snapshotRead.rightsDecisionId()).isEqualTo(retained.rightsDecisionId());
                    assertThat(snapshotRead.policyDecisionId()).isEqualTo(retained.policyDecisionId());
                    assertThat(snapshotRead.consentDecisionId()).isEqualTo(retained.consentDecisionId());
                    assertThat(restarted.findProcessingAttempt(parent.tenantId(), parent.jobId(), 1))
                            .isPresent();
                    assertThat(restarted.findProcessingAttempt(parent.tenantId(), child.jobId(), 1))
                            .isPresent();
                    assertThat(restarted.findProcessingAttempt(parent.tenantId(), child.jobId(), 2))
                            .isEmpty();

                    // Exact deterministic child submission is idempotent after restart; it
                    // resolves the persisted child row and does not create another attempt.
                    assertThat(restarted.create(child, child.requestFingerprint(), null, null).jobId())
                            .isEqualTo(child.jobId());
                    assertThat(restarted.findByRequest(parent.tenantId(), childRequestId))
                            .contains(childRead);
                    assertThat(restarted.findProcessingAttempt(parent.tenantId(), child.jobId(), 2))
                            .isEmpty();
                }
            }
        }
    }

    @Test
    void successfulFusedResultIsCommittedOnceAndReadsBackExactlyAfterStoreRestart() throws Exception {
        String bucket = bucket();
        String requestId = "request-mm-result-" + runId();
        MultimodalOperationSpec spec = spec(1);
        ProcessingJob parent = mmJob(requestId);
        Map<String, Object> fusedResult;
        ProcessingAttempt receiptAttempt;
        List<String> childJobIds = new java.util.ArrayList<>();
        List<String> childRequestIds = new java.util.ArrayList<>();
        List<Map<String, Object>> childResults = new java.util.ArrayList<>();
        var observedAt = Instant.ofEpochMilli(Instant.now().toEpochMilli());

        try (AutoCloseable ignored = MediaAwsPostgresqlRuntimeState.installForTesting(
                integrationEnvironment(bucket))) {
            try (PostgresqlMediaJobStore store = new PostgresqlMediaJobStore()) {
                store.create(parent, parent.requestFingerprint(), null, snapshot(spec));
                var parentLease = store.claim(parent, "mm-worker", Instant.now().plusSeconds(60));
                var parentStart = store.startAttempt(
                        parent, running(parent), parentLease, 1, parent.requestFingerprint());

                List<ProcessingJob> children = new java.util.ArrayList<>();
                for (MultimodalOperationSpec.ChildOperationSpec childSpec : spec.children()) {
                    String childRequestId = MultimodalOperationSpec.childRequestId(requestId, childSpec.childKey());
                    String childJobId = "job-mm-" + childSpec.childKey() + "-" + runId();
                    String providerId = childSpec.providerHint().isBlank()
                            ? "provider-" + childSpec.jobType().name().toLowerCase(java.util.Locale.ROOT)
                            : childSpec.providerHint();
                    ProcessingJob acceptedChild = new ProcessingJob(
                            childJobId, childRequestId, parent.tenantId(), parent.principalId(),
                            childSpec.artifactId(), childSpec.jobType(), providerId, JobStatus.ACCEPTED,
                            Instant.now(), null, null, Map.of(), "", 1, childSpec.artifactVersion(),
                            "d".repeat(64));
                    ProcessingJobRequest childRequest = new ProcessingJobRequest(
                            childRequestId, parent.tenantId(), parent.principalId(), requestId,
                            childSpec.artifactId(), childSpec.artifactVersion(), childSpec.jobType(),
                            providerId, childSpec.parameters());
                    SttSubmissionSnapshot sttSnapshot = SttSubmissionSnapshot.from(childRequest);
                    store.create(acceptedChild, acceptedChild.requestFingerprint(), sttSnapshot, null);
                    var childLease = store.claim(acceptedChild, "child-worker-" + childSpec.childKey(),
                            Instant.now().plusSeconds(60));
                    var childStart = store.startAttempt(acceptedChild, running(acceptedChild), childLease,
                            1, acceptedChild.requestFingerprint());
                    Map<String, Object> childResult = Map.of("text", "fixture:" + childSpec.childKey());
                    var childWithReceipt = store.recordProviderReceipt(childStart.attempt(), childLease,
                            "child-operation-" + acceptedChild.jobId(), "child-receipt-" + acceptedChild.jobId());
                    ProviderAttemptObservation childObservation = new ProviderAttemptObservation(
                            childWithReceipt.query(), AttemptFinality.SUCCEEDED,
                            childWithReceipt.providerReceiptId(), childResult, "e".repeat(64), observedAt);
                    ProcessingJob completedChild = new ProcessingJob(
                            acceptedChild.jobId(), acceptedChild.requestId(), acceptedChild.tenantId(),
                            acceptedChild.principalId(), acceptedChild.artifactId(), acceptedChild.jobType(),
                            acceptedChild.providerId(), JobStatus.COMPLETED, acceptedChild.createdAt(),
                            childStart.running().startedAt(), observedAt, childResult, "",
                            childStart.running().version() + 1, acceptedChild.expectedArtifactVersion(),
                            acceptedChild.requestFingerprint());
                    MediaLifecycleEvent childEvent = new MediaLifecycleEvent(
                            "media:mm-child-result:" + acceptedChild.jobId(), "media.job.completed",
                            acceptedChild.tenantId(), acceptedChild.principalId(), acceptedChild.requestId(),
                            acceptedChild.requestId(), "job", acceptedChild.jobId(), completedChild.version(),
                            "INTERNAL", observedAt, Map.of("jobId", acceptedChild.jobId(), "status", "COMPLETED"));
                    store.commitFinalOutcome(childStart.running(), childWithReceipt, completedChild,
                            childObservation, childEvent);
                    children.add(completedChild);
                    childJobIds.add(completedChild.jobId());
                    childRequestIds.add(completedChild.requestId());
                    childResults.add(childResult);
                }
                fusedResult = MultimodalOperationSpec.fusedResult(spec, children);
                receiptAttempt = store.recordProviderReceipt(
                        parentStart.attempt(), parentLease, "mm-operation-" + parent.jobId(),
                        "mm-receipt-" + parent.jobId());
                ProviderAttemptObservation observation = new ProviderAttemptObservation(
                        receiptAttempt.query(), AttemptFinality.SUCCEEDED, receiptAttempt.providerReceiptId(),
                        fusedResult, "f".repeat(64), observedAt);
                ProcessingJob completedParent = new ProcessingJob(
                        parent.jobId(), parent.requestId(), parent.tenantId(), parent.principalId(),
                        parent.artifactId(), parent.jobType(), parent.providerId(), JobStatus.COMPLETED,
                        parent.createdAt(), parentStart.running().startedAt(), observedAt, fusedResult, "",
                        parentStart.running().version() + 1, parent.expectedArtifactVersion(),
                        parent.requestFingerprint());
                MediaLifecycleEvent completedEvent = new MediaLifecycleEvent(
                        "media:mm-result:" + parent.jobId(), "media.job.completed", parent.tenantId(),
                        parent.principalId(), parent.requestId(), parent.requestId(), "job", parent.jobId(),
                        completedParent.version(), "INTERNAL", observedAt,
                        Map.of("jobId", parent.jobId(), "status", "COMPLETED"));
                store.commitFinalOutcome(parentStart.running(), receiptAttempt, completedParent,
                        observation, completedEvent);

                // Reusing the canonical request and spec resolves to the same parent identity.
                assertThat(store.create(parent, parent.requestFingerprint(), null, snapshot(spec)).jobId())
                        .isEqualTo(parent.jobId());
                // The original RUNNING version cannot be finalized a second time, even with
                // the identical fused result and receipt: finalization is compare-and-set.
                assertThatThrownBy(() -> store.commitFinalOutcome(parentStart.running(), receiptAttempt,
                        completedParent, observation, completedEvent))
                        .isInstanceOf(IllegalStateException.class)
                        .hasMessage("Media attempt finality fence changed");

                // Keep the shared Testcontainers runtime state alive while replacing the
                // store handle; closing its final reference tears down the test database.
                PostgresqlMediaJobStore restarted = new PostgresqlMediaJobStore();
                store.close();
                try (restarted) {
                    ProcessingJob readback = restarted.findByRequest(parent.tenantId(), requestId).orElseThrow();
                    assertThat(readback.status()).isEqualTo(JobStatus.COMPLETED);
                    assertThat(MediaJobRequestFingerprint.canonicalJson(readback.result()))
                            .isEqualTo(MediaJobRequestFingerprint.canonicalJson(fusedResult));
                    // Model a client retry after parent CAS commit and response loss.
                    // A fresh store handle must resolve the durable request key to the
                    // exact terminal parent without creating a new attempt.
                    ProcessingJob retryAfterLostAck = restarted.create(
                            parent, parent.requestFingerprint(), null, snapshot(spec));
                    assertThat(retryAfterLostAck.jobId()).isEqualTo(readback.jobId());
                    assertThat(retryAfterLostAck.status()).isEqualTo(JobStatus.COMPLETED);
                    assertThat(MediaJobRequestFingerprint.canonicalJson(retryAfterLostAck.result()))
                            .isEqualTo(MediaJobRequestFingerprint.canonicalJson(readback.result()));
                    assertThat(restarted.findMultimodalOperationSnapshot(parent.tenantId(), parent.jobId())
                            .orElseThrow().operationSpec()).isEqualTo(spec);
                    var attempt = restarted.findProcessingAttempt(parent.tenantId(), parent.jobId(), 1).orElseThrow();
                    assertThat(attempt.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
                    assertThat(attempt.providerOperationId()).isEqualTo("mm-operation-" + parent.jobId());
                    assertThat(attempt.providerReceiptId()).isEqualTo("mm-receipt-" + parent.jobId());
                    assertThat(attempt.resultDigest()).isEqualTo(sha256(fusedResult));
                    assertThat(attempt.observedAt()).isEqualTo(observedAt);
                    assertThat(restarted.findProcessingAttempt(parent.tenantId(), parent.jobId(), 2)).isEmpty();

                    for (int index = 0; index < childJobIds.size(); index++) {
                        ProcessingJob childReadback = restarted.findByRequest(
                                parent.tenantId(), childRequestIds.get(index)).orElseThrow();
                        assertThat(childReadback.jobId()).isEqualTo(childJobIds.get(index));
                        assertThat(childReadback.status()).isEqualTo(JobStatus.COMPLETED);
                        assertThat(MediaJobRequestFingerprint.canonicalJson(childReadback.result()))
                                .isEqualTo(MediaJobRequestFingerprint.canonicalJson(childResults.get(index)));
                        assertThat(childReadback.artifactId())
                                .isEqualTo(spec.children().get(index).artifactId());
                        assertThat(childReadback.expectedArtifactVersion())
                                .isEqualTo(spec.children().get(index).artifactVersion());
                        assertThat(childReadback.jobType()).isEqualTo(spec.children().get(index).jobType());
                        String retainedFusedJson = MediaJobRequestFingerprint.canonicalJson(readback.result());
                        assertThat(retainedFusedJson).contains(childReadback.jobId(), childReadback.requestId());
                        var childAttempt = restarted.findProcessingAttempt(
                                parent.tenantId(), childReadback.jobId(), 1).orElseThrow();
                        assertThat(childAttempt.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
                        assertThat(childAttempt.requestId()).isEqualTo(childReadback.requestId());
                        assertThat(childAttempt.requestFingerprint()).isEqualTo(childReadback.requestFingerprint());
                        assertThat(childAttempt.providerOperationId())
                                .isEqualTo("child-operation-" + childReadback.jobId());
                        assertThat(childAttempt.providerReceiptId())
                                .isEqualTo("child-receipt-" + childReadback.jobId());
                        assertThat(restarted.findProcessingAttempt(
                                parent.tenantId(), childReadback.jobId(), 2)).isEmpty();
                    }
                }
            }
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
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
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

    private static ProcessingJob childJob(ProcessingJob parent, String requestId) {
        String childRunId = runId();
        return new ProcessingJob(
                "job-vis-" + childRunId, requestId, parent.tenantId(), parent.principalId(),
                "artifact-vis", JobType.VISION, "provider-vis", JobStatus.ACCEPTED,
                Instant.now(), null, null, Map.of(), "", 1,
                "sha256:" + SHA_B, SHA_A.substring(0, 40) + childRunId.substring(0, 24));
    }

    private static ProcessingJob running(ProcessingJob accepted) {
        return new ProcessingJob(
                accepted.jobId(), accepted.requestId(), accepted.tenantId(), accepted.principalId(),
                accepted.artifactId(), accepted.jobType(), accepted.providerId(), JobStatus.RUNNING,
                accepted.createdAt(), Instant.now(), null, Map.of(), "", accepted.version() + 1,
                accepted.expectedArtifactVersion(), accepted.requestFingerprint());
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

    private static String sha256(Object value) throws Exception {
        byte[] digest = java.security.MessageDigest.getInstance("SHA-256")
                .digest(tools.jackson.databind.json.JsonMapper.builder()
                        .addModules(tools.jackson.databind.cfg.MapperBuilder.findModules())
                        .build().writeValueAsBytes(value));
        return java.util.HexFormat.of().formatHex(digest);
    }
}
