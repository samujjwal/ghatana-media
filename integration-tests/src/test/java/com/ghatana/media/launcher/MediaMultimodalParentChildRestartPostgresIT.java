package com.ghatana.media.launcher;

import com.ghatana.media.provider.aws.PostgresqlMediaJobStore;
import com.ghatana.media.provider.aws.TestAwsStateInstall;
import com.ghatana.media.runtime.MediaRuntimeContracts.AutomationRisk;
import com.ghatana.media.runtime.MediaRuntimeContracts.BiometricSensitivity;
import com.ghatana.media.runtime.MediaRuntimeContracts.ConsentDecision;
import com.ghatana.media.runtime.MediaRuntimeContracts.DataClassification;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaConsentAuthority;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.MultimodalOperationSpec;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.Tag;
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

import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * W2-R03: real PostgreSQL multimodal parent + canonical child fencing, mixed finality,
 * runtime reconstruction with an empty in-memory registry, and idempotent replay.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaMultimodalParentChildRestartPostgresIT {

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void lostGrpcAcknowledgementRetriesSameParentKeyAndReadsBackCommittedOutcome() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-mm-lost-ack-" + runId;
        try (S3Client s3 = s3()) {
            s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        var installed = TestAwsStateInstall.install(environment(bucket));
        var lifecycleKeeper = new PostgresqlMediaJobStore();
        String previousJwtSecret = System.getProperty("AV_JWT_SECRET");
        try {
            var effects = new AtomicInteger();
            String jwtSecret = "media-mm-lost-ack-test-secret-" + runId;
            System.setProperty("AV_JWT_SECRET", jwtSecret);
            String tenant = "tenant-" + runId;
            String principal = UUID.randomUUID().toString();
            String requestId = "request-lost-ack-" + runId;
            byte[] image = validPng(0xff00ff00);
            var root = Files.createTempDirectory("media-mm-lost-ack-");
            ProcessingJob committed;
            String committedParentReceipt;
            MediaArtifact source;
            com.ghatana.audio.video.multimodal.grpc.proto.MultimodalRequest request;
            var headers = new io.grpc.Metadata();
            headers.put(io.grpc.Metadata.Key.of(
                    "authorization", io.grpc.Metadata.ASCII_STRING_MARSHALLER),
                    "Bearer " + signedJwt(jwtSecret, tenant, principal));
            try (MediaRuntime runtime = runtimeWithS3Artifacts(root, List.of(
                    new com.ghatana.audio.video.multimodal.engine.DelegatingMultimodalProvider(),
                    visionProvider(effects)))) {
                String imageSha = HexFormat.of().formatHex(
                        MessageDigest.getInstance("SHA-256").digest(image));
                var sourceUpload = runtime.beginUpload(new UploadRequest(
                        tenant, principal, "vision-source", "image/png", image.length, imageSha,
                        "CONFIDENTIAL", Duration.ofDays(2),
                        Map.of("purpose", "multimodal-operation-ingest")), "source-" + runId);
                runtime.appendChunk(tenant, principal, sourceUpload.uploadId(), 0, image);
                source = runtime.completeUpload(tenant, principal, sourceUpload.uploadId());
                var binding = com.ghatana.audio.video.multimodal.grpc.proto.CanonicalOperationBinding.newBuilder()
                        .setOperationVersion(1)
                        .setCapabilityRef("media.multimodal.observe.source-grounded")
                        .setOperationRef("media.operation.capability.media-multimodal-observe-source-grounded")
                        .setRequestId(requestId)
                        .setSourceArtifactId(source.artifactId())
                        .setSourceVersionId(source.version().value())
                        .setPurpose("observe")
                        .build();
                request = com.ghatana.audio.video.multimodal.grpc.proto.MultimodalRequest.newBuilder()
                        .setImageData(com.google.protobuf.ByteString.copyFrom(image))
                        .setOperationBinding(binding)
                        .build();

                try (var server = new com.ghatana.audio.video.multimodal.grpc.MultimodalGrpcServer(
                        0, com.ghatana.audio.video.common.AudioVideoGrpcServerBase.TransportSecurity.plaintext(), runtime)) {
                    server.start();
                    var channel = io.grpc.ManagedChannelBuilder.forAddress("127.0.0.1", server.getPort())
                            .usePlaintext().build();
                    try {
                        var droppedResponses = new AtomicInteger();
                        io.grpc.Channel lossyChannel = io.grpc.ClientInterceptors.intercept(channel,
                                io.grpc.stub.MetadataUtils.newAttachHeadersInterceptor(headers),
                                dropFirstGrpcResponse(droppedResponses));

                        io.grpc.StatusRuntimeException firstFailure;
                        try {
                            com.ghatana.audio.video.multimodal.grpc.proto.MultimodalServiceGrpc
                                    .newBlockingStub(lossyChannel).processMultimodal(request);
                            throw new AssertionError("lossy client unexpectedly received the first response");
                        } catch (io.grpc.StatusRuntimeException failure) {
                            firstFailure = failure;
                        }
                        assertThat(firstFailure.getStatus().getCode())
                                .as("first call failure: %s", firstFailure.getStatus().getDescription())
                                .isEqualTo(io.grpc.Status.Code.UNAVAILABLE);
                        assertThat(droppedResponses).hasValue(1);
                    } finally {
                        channel.shutdownNow();
                    }
                }
            }

            // The original server/runtime are closed before replay. Read the committed
            // parent and child from PostgreSQL, then reconstruct both over the same
            // durable state and artifact root before making the exact same-key call.
            try (PostgresqlMediaJobStore readback = new PostgresqlMediaJobStore()) {
                committed = readback.findByRequest(tenant, requestId).orElseThrow();
                assertThat(committed.status()).isEqualTo(JobStatus.COMPLETED);
                var committedAttempt = readback.findProcessingAttempt(tenant, committed.jobId(), 1)
                        .orElseThrow();
                assertThat(committedAttempt.finality())
                        .isEqualTo(com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality.SUCCEEDED);
                committedParentReceipt = committedAttempt.providerReceiptId();
                assertThat(committedParentReceipt).isNotBlank();
                assertThat(readback.findByRequest(tenant, requestId + ":vision")
                        .orElseThrow().status()).isEqualTo(JobStatus.COMPLETED);
            }
            assertThat(effects).hasValue(1);

            try (MediaRuntime restarted = runtimeWithS3Artifacts(root, List.of(
                    new com.ghatana.audio.video.multimodal.engine.DelegatingMultimodalProvider(),
                    visionProvider(effects)));
                 var server = new com.ghatana.audio.video.multimodal.grpc.MultimodalGrpcServer(
                         0, com.ghatana.audio.video.common.AudioVideoGrpcServerBase.TransportSecurity.plaintext(),
                         restarted)) {
                server.start();
                var retryChannel = io.grpc.ManagedChannelBuilder.forAddress("127.0.0.1", server.getPort())
                        .usePlaintext().build();
                try {
                    var retryChannelWithHeaders = io.grpc.ClientInterceptors.intercept(retryChannel,
                            io.grpc.stub.MetadataUtils.newAttachHeadersInterceptor(headers));
                    var replay = com.ghatana.audio.video.multimodal.grpc.proto.MultimodalServiceGrpc
                            .newBlockingStub(retryChannelWithHeaders).processMultimodal(request);
                    assertThat(replay.hasVisualAnalysis()).isTrue();
                    assertThat(effects).hasValue(1);
                    try (PostgresqlMediaJobStore readback = new PostgresqlMediaJobStore()) {
                        ProcessingJob recovered = readback.findByRequest(tenant, requestId).orElseThrow();
                        assertThat(recovered.jobId()).isEqualTo(committed.jobId());
                        assertThat(recovered.status()).isEqualTo(JobStatus.COMPLETED);
                        assertThat(recovered.result()).isEqualTo(committed.result());
                        assertThat(readback.findProcessingAttempt(tenant, committed.jobId(), 1)
                                .orElseThrow().providerReceiptId()).isEqualTo(committedParentReceipt);
                        assertThat(readback.findProcessingAttempt(tenant, committed.jobId(), 2)).isEmpty();
                    }
                } finally {
                    retryChannel.shutdownNow();
                }
            }
        } finally {
            lifecycleKeeper.close();
            if (previousJwtSecret == null) System.clearProperty("AV_JWT_SECRET");
            else System.setProperty("AV_JWT_SECRET", previousJwtSecret);
            installed.close();
        }
    }

    @Test
    void unknownParentAndDurableChildrenSurviveRuntimeReconstructionWithoutRedispatch() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-mm-restart-" + runId;
        try (S3Client s3 = s3()) {
            s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        var installed = TestAwsStateInstall.install(environment(bucket));
        AtomicInteger sttEffects = new AtomicInteger();
        AtomicInteger visionEffects = new AtomicInteger();
        var root = Files.createTempDirectory("media-mm-restart-");
        try (PostgresqlMediaJobStore stateKeeper = new PostgresqlMediaJobStore()) {
            String tenant = "tenant-" + runId;
            String principal = "principal-" + runId;
            ProcessingJob accepted;
            MediaArtifact source;
            MediaArtifact sttChild;
            MediaArtifact visionChild;
            Map<String, Object> unknownResult;
            try (MediaRuntime firstRuntime = runtime(root, sttEffects, visionEffects)) {
                source = upload(firstRuntime, tenant, principal, "mm-parent-" + runId);
                sttChild = upload(firstRuntime, tenant, principal, "stt-child-" + runId);
                visionChild = upload(firstRuntime, tenant, principal, "vision-child-" + runId);
                var spec = spec(source, List.of(
                        child("stt", JobType.SPEECH_TO_TEXT, sttChild, sttParameters()),
                        child("vision", JobType.VISION, visionChild, Map.of())));
                accepted = firstRuntime.submit(mmRequest("request-" + runId, tenant, principal, source, spec));
                ProcessingJob terminal = awaitTerminal(
                        firstRuntime, tenant, principal, accepted.jobId());
                assertThat(terminal.status())
                        .as("parent terminal state; failureCode=%s result=%s jobs=%s attempts=%s",
                                terminal.failureCode(), terminal.result(), dumpJobs(tenant),
                                dumpAttempts(tenant))
                        .isEqualTo(JobStatus.OUTCOME_UNKNOWN);
                assertThat(terminal.failureCode()).isEqualTo("PROCESSING_OUTCOME_UNKNOWN");
                assertThat(terminal.result()).containsEntry("providerOutcome", "UNKNOWN");
                unknownResult = terminal.result();
                // The deterministic STT fixture omits the canonical transcript-version
                // projection required for atomic transcript finalization. Preserve its
                // successful attempt receipt without claiming a completed STT job.
                assertThat(jobState(tenant, "request-" + runId + ":stt")).isEqualTo("OUTCOME_UNKNOWN");
                assertThat(jobState(tenant, "request-" + runId + ":vision")).isEqualTo("COMPLETED");
                assertThat(sttEffects).hasValue(1);
                assertThat(visionEffects).hasValue(1);
                // The durable operation snapshot is reconstructible from the store alone.
                assertThat(snapshotOperationRef(tenant, accepted.jobId())).isPresent();
            }

            try (MediaRuntime restarted = runtime(root, sttEffects, visionEffects)) {
                ProcessingJob recovered = restarted.job(
                        tenant, principal, accepted.jobId()).orElseThrow();
                assertThat(recovered.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
                assertThat(recovered.result())
                        .as("durable unknown parent result must survive runtime reconstruction unchanged")
                        .isEqualTo(unknownResult);
                assertThat(jobState(tenant, "request-" + runId + ":stt")).isEqualTo("OUTCOME_UNKNOWN");
                assertThat(jobState(tenant, "request-" + runId + ":vision")).isEqualTo("COMPLETED");
                // Restart must not redispatch any child or parent effect.
                assertThat(sttEffects).hasValue(1);
                assertThat(visionEffects).hasValue(1);
                // Idempotent replay of the same parent request — same request id and the
                // same durable spec fingerprint — resolves to the same job, not a new one.
                var replay = restarted.submit(mmRequest("request-" + runId, tenant, principal,
                        source, spec(source, List.of(
                                child("stt", JobType.SPEECH_TO_TEXT, sttChild, sttParameters()),
                                child("vision", JobType.VISION, visionChild, Map.of())))));
                assertThat(replay.jobId()).isEqualTo(accepted.jobId());
                assertThat(sttEffects).hasValue(1);
                assertThat(visionEffects).hasValue(1);
            }
        } finally {
            installed.close();
        }
    }

    @Test
    void pendingChildAtShutdownKeepsParentHonestAcrossRestartWithoutRedispatch() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-mm-unknown-" + runId;
        try (S3Client s3 = s3()) {
            s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        var installed = TestAwsStateInstall.install(environment(bucket));
        AtomicInteger sttEffects = new AtomicInteger();
        AtomicInteger visionEffects = new AtomicInteger();
        var root = Files.createTempDirectory("media-mm-unknown-");
        try (PostgresqlMediaJobStore stateKeeper = new PostgresqlMediaJobStore()) {
            String tenant = "tenant-" + runId;
            String principal = "principal-" + runId;
            MediaArtifact source;
            try (MediaRuntime firstRuntime = runtimePendingStt(root, sttEffects, visionEffects)) {
                source = upload(firstRuntime, tenant, principal, "mm-parent-" + runId);
                var sttChild = upload(firstRuntime, tenant, principal, "stt-pending-" + runId);
                var visionChild = upload(firstRuntime, tenant, principal, "vision-done-" + runId);
                var spec = spec(source, List.of(
                        child("stt", JobType.SPEECH_TO_TEXT, sttChild, sttParameters()),
                        child("vision", JobType.VISION, visionChild, Map.of())));
                var accepted = firstRuntime.submit(
                        mmRequest("request-" + runId, tenant, principal, source, spec));
                // Wait until the vision sibling completes; STT stays in flight, then the
                // runtime is torn down — losing the in-memory completion registry.
                awaitJobState(tenant, "request-" + runId + ":vision", "COMPLETED");
                assertThat(visionEffects).hasValue(1);
            }

            try (MediaRuntime restarted = runtimePendingStt(root, sttEffects, visionEffects)) {
                // The new runtime owns an empty in-memory registry and must reconcile the
                // parent only from durable child state — no redispatch, no fabricated success.
                awaitParentTerminal(tenant, readJobId(tenant, "request-" + runId));
                String parentState = jobState(tenant, "request-" + runId);
                assertThat(parentState).isIn("OUTCOME_UNKNOWN", "FAILED", "CANCELLED");
                assertThat(parentState).isNotEqualTo("COMPLETED");
                assertThat(jobState(tenant, "request-" + runId + ":vision")).isEqualTo("COMPLETED");
                // Exactly one durable child of each kind — no duplicate fanout.
                assertThat(countJobs(tenant, "request-" + runId + ":stt")).isEqualTo(1);
                assertThat(countJobs(tenant, "request-" + runId + ":vision")).isEqualTo(1);
                assertThat(visionEffects).hasValue(1);
            }
        } finally {
            installed.close();
        }
    }

    @Test
    void failedAndCancelledChildrenKeepParentUnknownAcrossPostgresRestartWithoutRedispatch() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-mm-cancelled-child-" + runId;
        try (S3Client s3 = s3()) {
            s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        var installed = TestAwsStateInstall.install(environment(bucket));
        AtomicInteger sttEffects = new AtomicInteger();
        AtomicInteger visionEffects = new AtomicInteger();
        var root = Files.createTempDirectory("media-mm-cancelled-child-");
        try (PostgresqlMediaJobStore stateKeeper = new PostgresqlMediaJobStore()) {
            String tenant = "tenant-" + runId;
            String principal = "principal-" + runId;
            String requestId = "request-" + runId;
            ProcessingJob parent;
            MediaArtifact source;
            MediaArtifact sttChild;
            MediaArtifact visionChild;
            MultimodalOperationSpec operationSpec;
            try (MediaRuntime firstRuntime = runtimeWithProviders(root, List.of(
                    new com.ghatana.audio.video.multimodal.engine.DelegatingMultimodalProvider(),
                    failedSttProvider(sttEffects), pendingVisionProvider(visionEffects)))) {
                source = upload(firstRuntime, tenant, principal, "mm-parent-" + runId);
                sttChild = upload(firstRuntime, tenant, principal, "stt-child-" + runId);
                visionChild = upload(firstRuntime, tenant, principal, "vision-child-" + runId);
                operationSpec = spec(source, List.of(
                        child("stt", JobType.SPEECH_TO_TEXT, sttChild, sttParameters()),
                        child("vision", JobType.VISION, visionChild, Map.of())));
                parent = firstRuntime.submit(mmRequest(requestId, tenant, principal, source, operationSpec),
                        authenticated(tenant, principal));

                awaitJobState(tenant, requestId + ":stt", "FAILED");
                awaitJobState(tenant, requestId + ":vision", "RUNNING");
                var vision = firstRuntime.job(tenant, principal,
                        readJobId(tenant, requestId + ":vision")).orElseThrow();
                assertThat(firstRuntime.cancel(tenant, principal, vision.jobId()).status())
                        .isEqualTo(JobStatus.CANCELLED);
                assertThat(sttEffects).hasValue(1);
                assertThat(visionEffects).hasValue(1);
            }

            // Reconstruct from PostgreSQL after the failed sibling and confirmed child
            // cancellation. The cancelled effect is not proof that the parent had no
            // effect, even though its sibling has a definitive failure receipt.
            try (MediaRuntime restarted = runtimeWithProviders(root, List.of(
                    new com.ghatana.audio.video.multimodal.engine.DelegatingMultimodalProvider(),
                    failedSttProvider(sttEffects), pendingVisionProvider(visionEffects)))) {
                awaitParentTerminal(tenant, parent.jobId());
                ProcessingJob recovered = restarted.job(tenant, principal, parent.jobId()).orElseThrow();
                assertThat(recovered.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
                assertThat(recovered.result()).containsEntry("providerOutcome", "UNKNOWN");
                assertThat(jobState(tenant, requestId + ":stt")).isEqualTo("FAILED");
                assertThat(jobState(tenant, requestId + ":vision")).isEqualTo("CANCELLED");
                assertThat(sttEffects).hasValue(1);
                assertThat(visionEffects).hasValue(1);

                var replay = restarted.submit(mmRequest(requestId, tenant, principal, source, operationSpec),
                        authenticated(tenant, principal));
                assertThat(replay.jobId()).isEqualTo(parent.jobId());
                assertThat(replay.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
                assertThat(sttEffects).hasValue(1);
                assertThat(visionEffects).hasValue(1);
            }
        } finally {
            installed.close();
        }
    }

    // ── Wiring ──────────────────────────────────────────────────────────────

    private static Map<String, String> environment(String bucket) {
        return Map.ofEntries(
                Map.entry("MEDIA_RUNTIME_ENVIRONMENT", "test"),
                Map.entry("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl()),
                Map.entry("MEDIA_POSTGRES_USER", POSTGRES.getUsername()),
                Map.entry("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_MM_DB_PASSWORD"),
                Map.entry("MEDIA_MM_DB_PASSWORD", POSTGRES.getPassword()),
                Map.entry("MEDIA_POSTGRES_POOL_SIZE", "8"),
                Map.entry("MEDIA_S3_BUCKET", bucket),
                Map.entry("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString()),
                Map.entry("MEDIA_S3_REGION", LOCALSTACK.getRegion()),
                Map.entry("MEDIA_S3_PATH_STYLE", "true"),
                Map.entry("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED"),
                Map.entry("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_MM_S3_ACCESS"),
                Map.entry("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_MM_S3_SECRET"),
                Map.entry("MEDIA_MM_S3_ACCESS", LOCALSTACK.getAccessKey()),
                Map.entry("MEDIA_MM_S3_SECRET", LOCALSTACK.getSecretKey()));
    }

    private static MediaRuntime runtime(
            java.nio.file.Path root, AtomicInteger sttEffects, AtomicInteger visionEffects) {
        return runtimeWithProviders(root, List.of(
                new com.ghatana.audio.video.multimodal.engine.DelegatingMultimodalProvider(),
                sttProvider(sttEffects), visionProvider(visionEffects)));
    }

    private static MediaRuntime runtimePendingStt(
            java.nio.file.Path root, AtomicInteger sttEffects, AtomicInteger visionEffects) {
        return runtimeWithProviders(root, List.of(
                new com.ghatana.audio.video.multimodal.engine.DelegatingMultimodalProvider(),
                pendingSttProvider(sttEffects), visionProvider(visionEffects)));
    }

    private static MediaRuntime runtimeWithProviders(
            java.nio.file.Path root, List<MediaProcessingProvider> providers) {
        return runtimeWithProviders(root, providers, new LocalMediaRuntimeSupport.FileArtifactStore(root));
    }

    private static MediaRuntime runtimeWithS3Artifacts(
            java.nio.file.Path root, List<MediaProcessingProvider> providers) {
        return runtimeWithProviders(root, providers,
                new com.ghatana.media.provider.aws.S3PostgresqlMediaArtifactStore());
    }

    private static MediaRuntime runtimeWithProviders(
            java.nio.file.Path root,
            List<MediaProcessingProvider> providers,
            com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifactStore artifactStore) {
        var config = new MediaRuntimeConfig(true, "test", 8_093, 1_024, 1_024, 1_048_576,
                Duration.ofSeconds(10), 8, "", "", false, false, root);
        return new MediaRuntime(config, artifactStore,
                new PostgresqlMediaJobStore(), new LocalMediaRuntimeSupport.StreamStore(), null,
                MediaSemanticRedactionRuntime.disabled(config.jobTimeout()),
                MediaLifecyclePublisher.disabled(), providers,
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()), List.of(),
                allowAllAuthority(), transcriptStore(), Clock.systemUTC());
    }

    private static byte[] validPng(int argb) throws Exception {
        var image = new BufferedImage(1, 1, BufferedImage.TYPE_INT_ARGB);
        image.setRGB(0, 0, argb);
        try (var output = new ByteArrayOutputStream()) {
            if (!ImageIO.write(image, "png", output)) {
                throw new IllegalStateException("No PNG writer is available for the local test fixture");
            }
            return output.toByteArray();
        }
    }

    // ── Providers / fixtures ────────────────────────────────────────────────

    private static MediaProcessingProvider sttProvider(AtomicInteger effects) {
        return sttLikeProvider("stt-done", effects, true);
    }

    private static MediaProcessingProvider pendingSttProvider(AtomicInteger effects) {
        return sttLikeProvider("stt-pending", effects, false);
    }

    private static MediaProcessingProvider failedSttProvider(AtomicInteger effects) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "stt-failed"; }
            @Override public String providerVersion() { return "v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.SPEECH_TO_TEXT); }
            @Override public java.util.Optional<com.ghatana.media.runtime
                    .MediaSpeechToTextAdmission.Profile> speechToTextProfile() {
                return java.util.Optional.of(new com.ghatana.media.runtime
                        .MediaSpeechToTextAdmission.Profile(
                        providerId(), "v1", "profile-a", "v1", "sha256:" + "a".repeat(64),
                        com.ghatana.media.runtime.MediaSpeechToTextAdmission
                                .ProfileQualification.QUALIFIED,
                        Set.of("en-US"), false,
                        com.ghatana.media.runtime.MediaSpeechToTextAdmission
                                .TimingDisposition.SOURCE_CLOCK_BOUND,
                        "fixture-qualification-evidence"));
            }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public String processingRegion() { return "local"; }
            @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.NONE; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                return CompletableFuture.failedFuture(
                        new AssertionError("durable dispatch must use the typed attempt path"));
            }
            @Override public CompletableFuture<com.ghatana.media.runtime.MediaRuntimeContracts
                    .ProviderSubmission> processAttempt(
                    ProcessingContext context,
                    com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext attempt) {
                effects.incrementAndGet();
                return CompletableFuture.completedFuture(
                        new com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission(
                                com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality.FAILED,
                                "op-stt-failed", "receipt-stt-failed", Map.of(),
                                "b".repeat(64), Instant.now()));
            }
        };
    }

    private static MediaProcessingProvider sttLikeProvider(
            String id, AtomicInteger effects, boolean completes) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return id; }
            @Override public String providerVersion() { return "v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.SPEECH_TO_TEXT); }
            @Override public java.util.Optional<com.ghatana.media.runtime
                    .MediaSpeechToTextAdmission.Profile> speechToTextProfile() {
                return java.util.Optional.of(new com.ghatana.media.runtime
                        .MediaSpeechToTextAdmission.Profile(
                        id, "v1", "profile-a", "v1",
                        "sha256:" + "a".repeat(64),
                        com.ghatana.media.runtime.MediaSpeechToTextAdmission
                                .ProfileQualification.QUALIFIED,
                        Set.of("en-US"), false,
                        com.ghatana.media.runtime.MediaSpeechToTextAdmission
                                .TimingDisposition.SOURCE_CLOCK_BOUND,
                        "fixture-qualification-evidence"));
            }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public String processingRegion() { return "local"; }
            @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.NONE; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                return CompletableFuture.failedFuture(
                        new AssertionError("durable dispatch must use the typed attempt path"));
            }
            @Override public CompletableFuture<com.ghatana.media.runtime.MediaRuntimeContracts
                    .ProviderSubmission> processAttempt(
                    ProcessingContext context,
                    com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext attempt) {
                effects.incrementAndGet();
                if (!completes) return new CompletableFuture<>();
                return CompletableFuture.completedFuture(
                        new com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission(
                                com.ghatana.media.runtime.MediaRuntimeContracts
                                        .AttemptFinality.SUCCEEDED,
                                "op-" + id, "receipt-" + id,
                                Map.of("text", "grounded transcript"),
                                "a".repeat(64), Instant.now()));
            }
            @Override public com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome cancel(
                    String tenantId, String principalId, String correlationId, String jobId) {
                return com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome.CONFIRMED;
            }
        };
    }

    private static MediaProcessingProvider visionProvider(AtomicInteger effects) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "vision-done"; }
            @Override public String providerVersion() { return "v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public String processingRegion() { return "local"; }
            @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.NONE; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                return CompletableFuture.failedFuture(
                        new AssertionError("durable dispatch must use the typed attempt path"));
            }
            @Override public CompletableFuture<com.ghatana.media.runtime.MediaRuntimeContracts
                    .ProviderSubmission> processAttempt(
                    ProcessingContext context,
                    com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext attempt) {
                effects.incrementAndGet();
                return CompletableFuture.completedFuture(
                        new com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission(
                                com.ghatana.media.runtime.MediaRuntimeContracts
                                        .AttemptFinality.SUCCEEDED,
                                "op-vision-done", "receipt-vision-done",
                                Map.of("detections", List.of()),
                                "a".repeat(64), Instant.now()));
            }
        };
    }

    private static MediaProcessingProvider pendingVisionProvider(AtomicInteger effects) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "vision-pending"; }
            @Override public String providerVersion() { return "v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public String processingRegion() { return "local"; }
            @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.NONE; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                return CompletableFuture.failedFuture(
                        new AssertionError("durable dispatch must use the typed attempt path"));
            }
            @Override public CompletableFuture<com.ghatana.media.runtime.MediaRuntimeContracts
                    .ProviderSubmission> processAttempt(
                    ProcessingContext context,
                    com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext attempt) {
                effects.incrementAndGet();
                return new CompletableFuture<>();
            }
            @Override public com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome cancel(
                    String tenantId, String principalId, String correlationId, String jobId) {
                return com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome.CONFIRMED;
            }
        };
    }

    private static com.ghatana.media.runtime.MediaTranscriptContracts.MediaTranscriptStore
            transcriptStore() {
        return new com.ghatana.media.runtime.MediaTranscriptContracts.MediaTranscriptStore() {
            @Override public com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevision
                    append(com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptDraft draft) {
                throw new UnsupportedOperationException("test store does not write transcripts");
            }
            @Override public List<com.ghatana.media.runtime.MediaTranscriptContracts
                    .TranscriptRevision> revisions(String tenantId, String transcriptId) {
                return List.of();
            }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return true; }
            @Override public void close() { }
        };
    }

    private static MediaSourceAuthorizationContracts.Authority allowAllAuthority() {
        return new MediaSourceAuthorizationContracts.Authority() {
            @Override public String authorityId() { return "fixture-authority"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public MediaSourceAuthorizationContracts.Decision resolve(
                    MediaSourceAuthorizationContracts.Request request,
                    MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated) {
                if (!authenticated.tenantId().equals(request.tenantId())
                        || !authenticated.principalId().equals(request.principalId())) {
                    return new MediaSourceAuthorizationContracts.Decision(
                            MediaSourceAuthorizationContracts.Status.DENIED, null);
                }
                Instant now = Instant.now();
                var evidence = new MediaSourceAuthorizationContracts.Evidence(
                        authorityId(), "decision-" + request.artifactId(),
                        request.tenantId(), request.principalId(), "fixture-owner",
                        request.artifactId(), request.sourceVersion(), request.sourceSha256(),
                        request.operation(), request.purpose(), request.providerId(),
                        request.providerVersion(), request.processingBoundary(),
                        request.processingRegion(), request.providerRetention(),
                        Set.of(request.operation().toLowerCase(java.util.Locale.ROOT)),
                        Set.of(request.processingRegion()), Set.of(request.providerRetention()),
                        "rights-1", "policy-1", "policy-v1",
                        MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                        MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                        "", "fixture-clock", 0, now.minusSeconds(1), now.plusSeconds(300));
                return new MediaSourceAuthorizationContracts.Decision(
                        MediaSourceAuthorizationContracts.Status.ALLOWED, evidence);
            }
            @Override public MediaSourceAuthorizationContracts.Decision revalidate(
                    MediaSourceAuthorizationContracts.Request request,
                    MediaSourceAuthorizationContracts.Evidence expectedEvidence,
                    MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated) {
                return new MediaSourceAuthorizationContracts.Decision(
                        MediaSourceAuthorizationContracts.Status.ALLOWED, expectedEvidence);
            }
        };
    }

    private static MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated(
            String tenantId, String principalId) {
        return new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(
                tenantId, principalId, Instant.now());
    }

    private static Map<String, Object> sttParameters() {
        return Map.of(
                "profileId", "profile-a",
                "profileVersion", "v1",
                "profileConfigurationDigest", "sha256:" + "a".repeat(64),
                "languageIntent", Map.of("mode", "EXPLICIT", "languageTag", "en-US"));
    }

    private static MultimodalOperationSpec.ChildOperationSpec child(
            String key, JobType jobType, MediaArtifact artifact, Map<String, Object> parameters) {
        return new MultimodalOperationSpec.ChildOperationSpec(key, jobType,
                artifact.artifactId(), artifact.version().value(), artifact.sha256(), "", parameters);
    }

    private static MultimodalOperationSpec spec(
            MediaArtifact source, List<MultimodalOperationSpec.ChildOperationSpec> children) {
        return new MultimodalOperationSpec(
                MultimodalOperationSpec.SPEC_VERSION,
                "media.multimodal.observe.source-grounded",
                "media.operation.capability.media-multimodal-observe-source-grounded",
                1, source.artifactId(), source.version().value(), source.sha256(),
                children, null, Map.of());
    }

    private static ProcessingJobRequest mmRequest(
            String requestId, String tenant, String principal,
            MediaArtifact source, MultimodalOperationSpec spec) {
        return new ProcessingJobRequest(requestId, tenant, principal, "correlation-" + requestId,
                source.artifactId(), source.version().value(), JobType.MULTIMODAL, "",
                Map.of(MultimodalOperationSpec.PARAMETERS_KEY, spec.toParametersValue()),
                new MediaGovernanceContext("consent-mm", "mm-observe", DataClassification.CONFIDENTIAL,
                        "us", Set.of("us"), true, "short-lived-media", false, false, "",
                        BiometricSensitivity.NONE, AutomationRisk.ASSISTIVE));
    }

    private static MediaArtifact upload(
            MediaRuntime runtime, String tenant, String principal, String name) throws Exception {
        byte[] bytes = name.getBytes(StandardCharsets.UTF_8);
        return uploadBytes(runtime, tenant, principal, name, bytes, "application/octet-stream");
    }

    private static MediaArtifact uploadBytes(
            MediaRuntime runtime, String tenant, String principal, String name,
            byte[] bytes, String contentType) throws Exception {
        String sha = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        var session = runtime.beginUpload(new UploadRequest(tenant, principal, name + ".bin",
                contentType, bytes.length, sha, "CONFIDENTIAL",
                Duration.ofHours(1), sourceClockMetadata()), "upload-" + name);
        runtime.appendChunk(tenant, principal, session.uploadId(), 0, bytes);
        return runtime.completeUpload(tenant, principal, session.uploadId());
    }

    private static io.grpc.ClientInterceptor dropFirstGrpcResponse(AtomicInteger droppedResponses) {
        return new io.grpc.ClientInterceptor() {
            @Override
            public <ReqT, RespT> io.grpc.ClientCall<ReqT, RespT> interceptCall(
                    io.grpc.MethodDescriptor<ReqT, RespT> method,
                    io.grpc.CallOptions callOptions,
                    io.grpc.Channel next) {
                return new io.grpc.ForwardingClientCall.SimpleForwardingClientCall<>(
                        next.newCall(method, callOptions)) {
                    @Override
                    public void start(io.grpc.ClientCall.Listener<RespT> responseListener,
                                      io.grpc.Metadata headers) {
                        var droppedForCall = new java.util.concurrent.atomic.AtomicBoolean();
                        super.start(new io.grpc.ForwardingClientCallListener
                                .SimpleForwardingClientCallListener<>(responseListener) {
                            @Override
                            public void onMessage(RespT message) {
                                if (droppedResponses.compareAndSet(0, 1)) {
                                    droppedForCall.set(true);
                                    return;
                                }
                                super.onMessage(message);
                            }

                            @Override
                            public void onClose(io.grpc.Status status, io.grpc.Metadata trailers) {
                                if (droppedForCall.get()) {
                                    super.onClose(io.grpc.Status.UNAVAILABLE
                                            .withDescription("test client lost the committed response"), trailers);
                                    return;
                                }
                                super.onClose(status, trailers);
                            }
                        }, headers);
                    }
                };
            }
        };
    }

    private static String signedJwt(String secret, String tenant, String subject) throws Exception {
        String header = base64Url("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        String payload = base64Url("{\"sub\":\"" + subject + "\",\"tenantId\":\"" + tenant
                + "\",\"roles\":[\"av:user\"],\"exp\":"
                + (System.currentTimeMillis() / 1000 + 600) + "}");
        String content = header + "." + payload;
        var hmac = javax.crypto.Mac.getInstance("HmacSHA256");
        hmac.init(new javax.crypto.spec.SecretKeySpec(
                secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return content + "." + java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString(hmac.doFinal(content.getBytes(StandardCharsets.UTF_8)));
    }

    private static String base64Url(String value) {
        return java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private static Map<String, Object> sourceClockMetadata() {
        return Map.of("sourceClockId", "fixture-clock",
                "sourceClockMappingEvidenceRef", "fixture-clock-evidence",
                "sourceClockTicksPerSecond", 1,
                "sourceDurationTicks", 1);
    }

    // ── Durable readback / waiting ──────────────────────────────────────────

    private static ProcessingJob awaitTerminal(
            MediaRuntime runtime, String tenant, String principal, String jobId) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        ProcessingJob current;
        do {
            current = runtime.job(tenant, principal, jobId).orElseThrow();
            if (current.status() == JobStatus.OUTCOME_UNKNOWN || current.status() == JobStatus.FAILED
                    || current.status() == JobStatus.COMPLETED || current.status() == JobStatus.CANCELLED) {
                return current;
            }
            Thread.sleep(25);
        } while (System.nanoTime() < deadline);
        throw new AssertionError("Job did not reach a terminal status: " + current.status());
    }

    private static void awaitJobState(String tenant, String requestId, String expected) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        String last = "MISSING";
        while (System.nanoTime() < deadline) {
            last = jobState(tenant, requestId);
            if (expected.equals(last)) return;
            Thread.sleep(50);
        }
        throw new AssertionError("job " + requestId + " did not reach " + expected
                + "; last state=" + last + " allJobs=" + dumpJobs(tenant)
                + " attempts=" + dumpAttempts(tenant));
    }

    private static String dumpAttempts(String tenant) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT job_id, state, observation_json, result_json FROM media_processing_attempts "
                             + "WHERE tenant_id=?")) {
            statement.setString(1, tenant);
            try (var rows = statement.executeQuery()) {
                var dump = new StringBuilder();
                while (rows.next()) {
                    String observation = String.valueOf(rows.getString(3));
                    String result = String.valueOf(rows.getString(4));
                    dump.append('[').append(rows.getString(1)).append(',')
                            .append(rows.getString(2)).append(",obs=")
                            .append(observation, 0, Math.min(observation.length(), 300))
                            .append(",res=")
                            .append(result, 0, Math.min(result.length(), 500))
                            .append(']');
                }
                return dump.toString();
            }
        }
    }

    private static String dumpJobs(String tenant) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT request_id, job_type, status, failure_code FROM media_processing_jobs "
                             + "WHERE tenant_id=? ORDER BY created_at")) {
            statement.setString(1, tenant);
            try (var rows = statement.executeQuery()) {
                var dump = new StringBuilder();
                while (rows.next()) {
                    dump.append('[').append(rows.getString(1)).append(',')
                            .append(rows.getString(2)).append(',')
                            .append(rows.getString(3)).append(',')
                            .append(rows.getString(4)).append(']');
                }
                return dump.toString();
            }
        }
    }

    private static void awaitParentTerminal(String tenant, String jobId) throws Exception {
        // The abandoned worker lease (jobTimeout + 30s) must expire before reconcileExpired
        // can CAS the row; allow two lease windows plus a reconcile scheduler pass.
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(120);
        while (System.nanoTime() < deadline) {
            String state = jobStateById(tenant, jobId);
            if (Set.of("COMPLETED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN").contains(state)) return;
            Thread.sleep(100);
        }
        throw new AssertionError("parent " + jobId + " did not reach a terminal state");
    }

    private static String readJobId(String tenant, String requestId) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT job_id FROM media_processing_jobs WHERE tenant_id=? AND request_id=?")) {
            statement.setString(1, tenant);
            statement.setString(2, requestId);
            try (var rows = statement.executeQuery()) {
                assertThat(rows.next()).isTrue();
                return rows.getString(1);
            }
        }
    }

    private static String jobState(String tenant, String requestId) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT status FROM media_processing_jobs WHERE tenant_id=? AND request_id=?")) {
            statement.setString(1, tenant);
            statement.setString(2, requestId);
            try (var rows = statement.executeQuery()) {
                return rows.next() ? rows.getString(1) : "MISSING";
            }
        }
    }

    private static String jobStateById(String tenant, String jobId) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT status FROM media_processing_jobs WHERE tenant_id=? AND job_id=?")) {
            statement.setString(1, tenant);
            statement.setString(2, jobId);
            try (var rows = statement.executeQuery()) {
                return rows.next() ? rows.getString(1) : "MISSING";
            }
        }
    }

    private static int countJobs(String tenant, String requestId) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT COUNT(*) FROM media_processing_jobs WHERE tenant_id=? AND request_id=?")) {
            statement.setString(1, tenant);
            statement.setString(2, requestId);
            try (var rows = statement.executeQuery()) {
                assertThat(rows.next()).isTrue();
                return rows.getInt(1);
            }
        }
    }

    private static java.util.Optional<String> snapshotOperationRef(String tenant, String jobId)
            throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT mm_operation_snapshot FROM media_processing_jobs "
                             + "WHERE tenant_id=? AND job_id=?")) {
            statement.setString(1, tenant);
            statement.setString(2, jobId);
            try (var rows = statement.executeQuery()) {
                return rows.next() ? java.util.Optional.ofNullable(rows.getString(1))
                        : java.util.Optional.empty();
            }
        }
    }

    private static S3Client s3() {
        return S3Client.builder().endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .build();
    }
}
