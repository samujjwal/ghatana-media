package com.ghatana.media.integration;

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
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.DriverManager;
import java.time.Instant;
import java.util.Base64;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import static com.ghatana.media.integration.MediaLauncherProcessFixtures.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** Synthetic-only authenticated upload durability across actual MediaLauncher process restarts. */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaLauncherArtifactIntakeRestartIT {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String JWT_SECRET = "media-launcher-upload-restart-secret-0123456789";
    private static final String DEV_JWT_SECRET = "media-launcher-dev-only-secret-0123456789";
    private static final Set<String> UPLOAD_PERMISSIONS = Set.of(
            "media:artifact:create", "media:artifact:write", "media:artifact:read",
            "media:job:create", "media:job:read");

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void authenticatedUploadResumesAcknowledgedPrefixAfterLauncherProcessRestart() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-upload-restart-" + run;
        Process launcher = null;
        Path services = null;
        Path log = null;
        String objectReference = "";
        try {
            try (S3Client s3 = s3()) {
                s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            }
            int port;
            try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
            Map<String, String> environment = environment(bucket, port);
            services = Files.createTempDirectory("media-launcher-upload-services-");
            installChildServiceDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            log = Files.createTempFile("media-launcher-upload-process-", ".log");
            String token = authenticatedJwt(PRINCIPAL, TENANT, JWT_SECRET);

            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            byte[] completeBytes = syntheticWav();
            byte[] first = java.util.Arrays.copyOfRange(completeBytes, 0, 128);
            byte[] second = java.util.Arrays.copyOfRange(completeBytes, 128, 256);
            byte[] finalChunk = java.util.Arrays.copyOfRange(completeBytes, 256, completeBytes.length);
            String expectedDigest = sha256(completeBytes);
            String request = """
                    {"tenantId":"%s","principalId":"%s","fileName":"synthetic.wav",
                     "contentType":"audio/wav","expectedSizeBytes":%d,
                     "expectedSha256":"%s","classification":"CONFIDENTIAL",
                     "retention":"P30D","metadata":{"sourceClockId":"fixture-clock",
                       "sourceClockMappingEvidenceRef":"fixture-clock-evidence",
                       "sourceClockTicksPerSecond":16000,"sourceDurationTicks":16000}}
                    """.formatted(TENANT, PRINCIPAL, completeBytes.length, expectedDigest);
            HttpResponse<String> begun = send(port, TENANT, token, "POST", "/api/v1/artifacts/uploads",
                    request, "application/json", "artifact-intake-restart-" + run);
            assertThat(begun.statusCode()).as(begun.body()).isEqualTo(201);
            JsonNode begunSession = JSON.readTree(begun.body());
            assertThat(begunSession.path("retention").asText()).isEqualTo("PT720H");
            String uploadId = JSON.readTree(begun.body()).path("uploadId").asString();
            assertThat(uploadId).isNotBlank();

            JsonNode firstAck = JSON.readTree(sendBytes(port, TENANT, token, "PUT",
                    "/api/v1/artifacts/uploads/" + uploadId + "/chunks/0", first).body());
            assertThat(firstAck.path("bytesReceived").asLong()).isEqualTo(first.length);
            JsonNode secondAck = JSON.readTree(sendBytes(port, TENANT, token, "PUT",
                    "/api/v1/artifacts/uploads/" + uploadId + "/chunks/1", second).body());
            assertThat(secondAck.path("bytesReceived").asLong()).isEqualTo(first.length + second.length);
            assertThat(secondAck.path("nextChunkIndex").asInt()).isEqualTo(2);

            stopLauncher(launcher);
            launcher = null;
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            HttpResponse<String> resumed = send(port, TENANT, token, "GET",
                    "/api/v1/artifacts/uploads/" + uploadId, "", "application/json", null);
            assertThat(resumed.statusCode()).as(resumed.body()).isEqualTo(200);
            JsonNode progress = JSON.readTree(resumed.body());
            assertThat(progress.path("uploadId").asString()).isEqualTo(uploadId);
            assertThat(progress.path("retention").asText()).isEqualTo("PT720H");
            assertThat(progress.path("bytesReceived").asLong()).isEqualTo(first.length + second.length);
            assertThat(progress.path("nextChunkIndex").asInt()).isEqualTo(2);

            // A process restart must preserve progress without preserving write
            // authority in a caller's current credential. The same principal can
            // inspect its upload with read permission, but a read-only token cannot
            // append the next contiguous chunk or change the acknowledged prefix.
            String readOnlyToken = authenticatedJwt(PRINCIPAL, TENANT, JWT_SECRET,
                    Set.of("media:artifact:read"));
            HttpResponse<String> deniedAppend = sendBytes(port, TENANT, readOnlyToken, "PUT",
                    "/api/v1/artifacts/uploads/" + uploadId + "/chunks/2", finalChunk);
            assertThat(deniedAppend.statusCode()).as(deniedAppend.body()).isEqualTo(403);
            HttpResponse<String> afterDeniedAppend = send(port, TENANT, readOnlyToken, "GET",
                    "/api/v1/artifacts/uploads/" + uploadId, "", "application/json", null);
            assertThat(afterDeniedAppend.statusCode()).as(afterDeniedAppend.body()).isEqualTo(200);
            JsonNode unchangedAfterDeniedAppend = JSON.readTree(afterDeniedAppend.body());
            assertThat(unchangedAfterDeniedAppend.path("bytesReceived").asLong())
                    .isEqualTo(first.length + second.length);
            assertThat(unchangedAfterDeniedAppend.path("nextChunkIndex").asInt()).isEqualTo(2);

            // J-02 upload identity is scoped by the authenticated tenant/principal pair.
            // Reusing the same client key from another principal must not disclose or
            // resume the original session after the launcher has recreated its runtime.
            String otherPrincipal = "media-upload-other-principal";
            String otherToken = authenticatedJwt(otherPrincipal, TENANT, JWT_SECRET);
            HttpResponse<String> foreignReadback = send(port, TENANT, otherToken, "GET",
                    "/api/v1/artifacts/uploads/" + uploadId, "", "application/json", null);
            assertThat(foreignReadback.statusCode()).as(foreignReadback.body()).isEqualTo(404);
            String otherRequest = request.replace(PRINCIPAL, otherPrincipal);
            HttpResponse<String> otherBegin = send(port, TENANT, otherToken, "POST", "/api/v1/artifacts/uploads",
                    otherRequest, "application/json", "artifact-intake-restart-" + run);
            assertThat(otherBegin.statusCode()).as(otherBegin.body()).isEqualTo(201);
            String otherUploadId = JSON.readTree(otherBegin.body()).path("uploadId").asString();
            assertThat(otherUploadId).isNotBlank().isNotEqualTo(uploadId);
            HttpResponse<String> otherReadback = send(port, TENANT, otherToken, "GET",
                    "/api/v1/artifacts/uploads/" + otherUploadId, "", "application/json", null);
            assertThat(otherReadback.statusCode()).as(otherReadback.body()).isEqualTo(200);
            assertThat(JSON.readTree(otherReadback.body()).path("principalId").asString())
                    .isEqualTo(otherPrincipal);

            String otherTenant = "tenant-upload-other-scope";
            String otherTenantToken = authenticatedJwt(PRINCIPAL, otherTenant, JWT_SECRET);
            HttpResponse<String> foreignTenantReadback = send(port, otherTenant, otherTenantToken, "GET",
                    "/api/v1/artifacts/uploads/" + uploadId, "", "application/json", null);
            assertThat(foreignTenantReadback.statusCode()).as(foreignTenantReadback.body()).isEqualTo(404);
            String otherTenantRequest = request.replace(TENANT, otherTenant);
            HttpResponse<String> otherTenantBegin = send(port, otherTenant, otherTenantToken, "POST",
                    "/api/v1/artifacts/uploads", otherTenantRequest, "application/json",
                    "artifact-intake-restart-" + run);
            assertThat(otherTenantBegin.statusCode()).as(otherTenantBegin.body()).isEqualTo(201);
            String otherTenantUploadId = JSON.readTree(otherTenantBegin.body()).path("uploadId").asString();
            assertThat(otherTenantUploadId).isNotBlank().isNotEqualTo(uploadId);

            // The source contract allows replay only for the matching persisted chunk
            // receipt. Exercise two simultaneous retries through the authenticated HTTP
            // boundary after process recovery, where a lost chunk acknowledgement can
            // naturally cause parallel client retries.
            ExecutorService replayWorkers = Executors.newFixedThreadPool(2);
            CountDownLatch replayReady = new CountDownLatch(2);
            CountDownLatch replayStart = new CountDownLatch(1);
            try {
                Future<HttpResponse<String>> replayA = replayWorkers.submit(() -> {
                    replayReady.countDown();
                    replayStart.await();
                    return sendBytes(port, TENANT, token, "PUT",
                            "/api/v1/artifacts/uploads/" + uploadId + "/chunks/0", first);
                });
                Future<HttpResponse<String>> replayB = replayWorkers.submit(() -> {
                    replayReady.countDown();
                    replayStart.await();
                    return sendBytes(port, TENANT, token, "PUT",
                            "/api/v1/artifacts/uploads/" + uploadId + "/chunks/0", first);
                });
                assertThat(replayReady.await(10, TimeUnit.SECONDS)).isTrue();
                replayStart.countDown();
                HttpResponse<String> exactReplayA = replayA.get(15, TimeUnit.SECONDS);
                HttpResponse<String> exactReplayB = replayB.get(15, TimeUnit.SECONDS);
                assertThat(exactReplayA.statusCode()).as(exactReplayA.body()).isEqualTo(200);
                assertThat(exactReplayB.statusCode()).as(exactReplayB.body()).isEqualTo(200);
                for (HttpResponse<String> replay : List.of(exactReplayA, exactReplayB)) {
                    JsonNode receipt = JSON.readTree(replay.body());
                    assertThat(receipt.path("uploadId").asString()).isEqualTo(uploadId);
                    assertThat(receipt.path("bytesReceived").asLong()).isEqualTo(first.length + second.length);
                    assertThat(receipt.path("nextChunkIndex").asInt()).isEqualTo(2);
                }
            } finally {
                replayStart.countDown();
                replayWorkers.shutdownNow();
            }
            HttpResponse<String> conflictingReplay = sendBytes(port, TENANT, token, "PUT",
                    "/api/v1/artifacts/uploads/" + uploadId + "/chunks/0",
                    "conflicting-prefix".getBytes(StandardCharsets.UTF_8));
            assertThat(conflictingReplay.statusCode()).as(conflictingReplay.body()).isEqualTo(409);
            JsonNode unchanged = JSON.readTree(send(port, TENANT, token, "GET",
                    "/api/v1/artifacts/uploads/" + uploadId, "", "application/json", null).body());
            assertThat(unchanged.path("bytesReceived").asLong()).isEqualTo(first.length + second.length);
            assertThat(unchanged.path("nextChunkIndex").asInt()).isEqualTo(2);

            HttpResponse<String> finalAck = sendBytes(port, TENANT, token, "PUT",
                    "/api/v1/artifacts/uploads/" + uploadId + "/chunks/2", finalChunk);
            assertThat(finalAck.statusCode()).as(finalAck.body()).isEqualTo(200);
            HttpResponse<String> completed = send(port, TENANT, token, "POST",
                    "/api/v1/artifacts/uploads/" + uploadId + "/complete", "", "application/json", null);
            assertThat(completed.statusCode()).as(completed.body()).isEqualTo(201);
            JsonNode artifact = JSON.readTree(completed.body());
            String artifactId = artifact.path("artifactId").asString();
            objectReference = artifact.path("objectReference").asString();
            assertThat(artifactId).isNotBlank();
            assertThat(artifact.path("sha256").asString()).isEqualTo(expectedDigest);
            assertThat(artifact.path("sizeBytes").asLong()).isEqualTo(completeBytes.length);

            HttpResponse<String> artifactReadback = send(port, TENANT, token, "GET",
                    "/api/v1/artifacts/" + artifactId, "", "application/json", null);
            assertThat(artifactReadback.statusCode()).as(artifactReadback.body()).isEqualTo(200);
            JsonNode durableArtifact = JSON.readTree(artifactReadback.body());
            assertThat(durableArtifact.path("sha256").asString()).isEqualTo(expectedDigest);
            assertThat(durableArtifact.path("sizeBytes").asLong()).isEqualTo(completeBytes.length);
            objectReference = durableArtifact.path("objectReference").asString();

            // This exercises the explicitly local diagnostic provider only. Its result
            // records artifact identity and deliberately does not read or transform media.
            String jobRequestId = "artifact-intake-diagnostic-" + run;
            String jobRequest = """
                    {"requestId":"%s","tenantId":"%s","principalId":"%s",
                     "correlationId":"artifact-intake-diagnostic-correlation-%s",
                     "artifactId":"%s","expectedArtifactVersion":"sha256:%s",
                     "jobType":"TRANSCODE","providerHint":"local-diagnostic","parameters":{}}
                    """.formatted(jobRequestId, TENANT, PRINCIPAL, run, artifactId, expectedDigest);
            HttpResponse<String> submittedJob = send(port, TENANT, token, "POST", "/api/v1/jobs",
                    jobRequest, "application/json", null);
            assertThat(submittedJob.statusCode()).as(submittedJob.body()).isEqualTo(202);
            JsonNode acceptedJob = JSON.readTree(submittedJob.body());
            String jobId = acceptedJob.path("jobId").asString();
            assertThat(jobId).isNotBlank();

            JsonNode diagnosticOutcome = null;
            long jobDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
            while (System.nanoTime() < jobDeadline) {
                HttpResponse<String> jobReadback = send(port, TENANT, token, "GET",
                        "/api/v1/jobs/" + jobId + "?requestId=" + jobRequestId,
                        "", "application/json", null);
                assertThat(jobReadback.statusCode()).as(jobReadback.body()).isEqualTo(200);
                JsonNode observed = JSON.readTree(jobReadback.body());
                if ("COMPLETED".equals(observed.path("status").asString())) {
                    diagnosticOutcome = observed;
                    break;
                }
                assertThat(observed.path("status").asString())
                        .as("diagnostic job must remain in a recognized nonterminal state while polling")
                        .isIn("ACCEPTED", "RUNNING");
                Thread.sleep(100);
            }
            assertThat(diagnosticOutcome).as("durable diagnostic job outcome").isNotNull();
            assertThat(diagnosticOutcome.path("providerId").asString()).isEqualTo("local-diagnostic");
            assertThat(diagnosticOutcome.path("result").path("diagnostic").asBoolean()).isTrue();
            assertThat(diagnosticOutcome.path("result").path("rawMediaRead").asBoolean()).isFalse();

            long artifactsBeforeCorruptUpload = countRows(
                    "SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=?", TENANT);
            long jobsBeforeCorruptUpload = countRows(
                    "SELECT COUNT(*) FROM media_processing_jobs WHERE tenant_id=?", TENANT);

            // This upload uses deterministic synthetic bytes only; it is not source-rights acceptance evidence.
            String objectKey = URI.create(objectReference).getPath().substring(1);
            try (S3Client s3 = s3()) {
                byte[] stored = s3.getObjectAsBytes(GetObjectRequest.builder()
                        .bucket(bucket).key(objectKey).build()).asByteArray();
                assertThat(stored).containsExactly(completeBytes);
                assertThat(sha256(stored)).isEqualTo(expectedDigest);
            }

            // Completion has no caller request key. Recovery is bound to this same upload ID
            // and must return its original artifact identity after a process restart.
            stopLauncher(launcher);
            launcher = null;
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            HttpResponse<String> completionReplay = send(port, TENANT, token, "POST",
                    "/api/v1/artifacts/uploads/" + uploadId + "/complete", "", "application/json", null);
            assertThat(completionReplay.statusCode()).as(completionReplay.body()).isEqualTo(201);
            JsonNode replayedArtifact = JSON.readTree(completionReplay.body());
            assertThat(replayedArtifact.path("artifactId").asString()).isEqualTo(artifactId);
            assertThat(replayedArtifact.path("objectReference").asString()).isEqualTo(objectReference);
            assertThat(replayedArtifact.path("sha256").asString()).isEqualTo(expectedDigest);

            HttpResponse<String> replayReadback = send(port, TENANT, token, "GET",
                    "/api/v1/artifacts/" + artifactId, "", "application/json", null);
            assertThat(replayReadback.statusCode()).as(replayReadback.body()).isEqualTo(200);
            assertThat(JSON.readTree(replayReadback.body()).path("artifactId").asString()).isEqualTo(artifactId);

            HttpResponse<String> jobReplay = send(port, TENANT, token, "GET",
                    "/api/v1/jobs/" + jobId + "?requestId=" + jobRequestId,
                    "", "application/json", null);
            assertThat(jobReplay.statusCode()).as(jobReplay.body()).isEqualTo(200);
            JsonNode recoveredJob = JSON.readTree(jobReplay.body());
            assertThat(recoveredJob.path("jobId").asString()).isEqualTo(jobId);
            assertThat(recoveredJob.path("requestId").asString()).isEqualTo(jobRequestId);
            assertThat(recoveredJob.path("status").asString()).isEqualTo("COMPLETED");
            assertThat(recoveredJob.path("providerId").asString()).isEqualTo("local-diagnostic");
            assertThat(recoveredJob.path("result")).isEqualTo(diagnosticOutcome.path("result"));
            assertThat(recoveredJob.path("result").path("diagnostic").asBoolean()).isTrue();
            assertThat(recoveredJob.path("result").path("rawMediaRead").asBoolean()).isFalse();

            // A syntactically valid WAV with a deliberately false expected digest must never
            // produce an artifact receipt. The upload ID remains the reconciliation identity;
            // this test does not retry completion under a new identity after the terminal reject.
            byte[] corruptBytes = syntheticWav();
            corruptBytes[corruptBytes.length - 1] ^= 0x01;
            String rejectedRequest = """
                    {"tenantId":"%s","principalId":"%s","fileName":"corrupt.wav",
                     "contentType":"audio/wav","expectedSizeBytes":%d,
                     "expectedSha256":"%s","classification":"CONFIDENTIAL",
                     "retention":"P30D","metadata":{}}
                    """.formatted(TENANT, PRINCIPAL, corruptBytes.length, sha256(syntheticWav()));
            HttpResponse<String> rejectedBegin = send(port, TENANT, token, "POST", "/api/v1/artifacts/uploads",
                    rejectedRequest, "application/json", "artifact-intake-corrupt-" + run);
            assertThat(rejectedBegin.statusCode()).as(rejectedBegin.body()).isEqualTo(201);
            String rejectedUploadId = JSON.readTree(rejectedBegin.body()).path("uploadId").asString();
            HttpResponse<String> corruptChunk = sendBytes(port, TENANT, token, "PUT",
                    "/api/v1/artifacts/uploads/" + rejectedUploadId + "/chunks/0", corruptBytes);
            assertThat(corruptChunk.statusCode()).as(corruptChunk.body()).isEqualTo(200);
            HttpResponse<String> rejectedCompletion = send(port, TENANT, token, "POST",
                    "/api/v1/artifacts/uploads/" + rejectedUploadId + "/complete", "", "application/json", null);
            assertThat(rejectedCompletion.statusCode()).as(rejectedCompletion.body()).isEqualTo(409);
            assertThat(rejectedCompletion.body()).contains("MEDIA_STATE_CONFLICT");
            assertThat(countRows("SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=?", TENANT))
                    .as("checksum-rejected upload must not create an artifact row")
                    .isEqualTo(artifactsBeforeCorruptUpload);
            assertThat(countRows("SELECT COUNT(*) FROM media_processing_jobs WHERE tenant_id=?", TENANT))
                    .as("checksum-rejected upload must not create a processing job")
                    .isEqualTo(jobsBeforeCorruptUpload);

            // A checksum-rejected upload remains terminal across process recreation:
            // the same identity cannot accept more parts or be finalized into a receipt.
            stopLauncher(launcher);
            launcher = null;
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            HttpResponse<String> rejectedAppend = sendBytes(port, TENANT, token, "PUT",
                    "/api/v1/artifacts/uploads/" + rejectedUploadId + "/chunks/1",
                    new byte[] { 1, 2, 3 });
            assertThat(rejectedAppend.statusCode()).as(rejectedAppend.body()).isEqualTo(409);
            HttpResponse<String> rejectedCompletionReplay = send(port, TENANT, token, "POST",
                    "/api/v1/artifacts/uploads/" + rejectedUploadId + "/complete", "", "application/json", null);
            assertThat(rejectedCompletionReplay.statusCode()).as(rejectedCompletionReplay.body()).isEqualTo(409);
            assertThat(rejectedCompletionReplay.body()).contains("MEDIA_STATE_CONFLICT");
            assertThat(countRows("SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=?", TENANT))
                    .as("terminal corrupt-upload replay must remain artifact-free after process restart")
                    .isEqualTo(artifactsBeforeCorruptUpload);
            assertThat(countRows("SELECT COUNT(*) FROM media_processing_jobs WHERE tenant_id=?", TENANT))
                    .as("terminal corrupt-upload replay must remain job-free after process restart")
                    .isEqualTo(jobsBeforeCorruptUpload);

            String absentArtifactId = UUID.randomUUID().toString();
            HttpResponse<String> absentArtifact = send(port, TENANT, token, "GET",
                    "/api/v1/artifacts/" + absentArtifactId, "", "application/json", null);
            assertThat(absentArtifact.statusCode()).as(absentArtifact.body()).isEqualTo(404);
        } finally {
            try {
                if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            } finally {
                try {
                    if (log != null) Files.deleteIfExists(log);
                } finally {
                    try {
                        deleteBucket(bucket);
                    } finally {
                        if (services != null && Files.exists(services)) {
                            try (var paths = Files.walk(services)) {
                                paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                                    try { Files.deleteIfExists(path); } catch (Exception ignored) { }
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    @Test
    void devOnlyIdentityPersistsUploadArtifactAndDiagnosticJobAcrossRestart() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-dev-finalize-diagnostic-" + run;
        Process launcher = null;
        Path services = null;
        Path log = null;
        try {
            try (S3Client s3 = s3()) {
                s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            }
            int port;
            try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
            Map<String, String> env = devEnvironment(bucket, port);
            services = Files.createTempDirectory("media-launcher-dev-finalize-services-");
            installChildServiceDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            log = Files.createTempFile("media-launcher-dev-finalize-process-", ".log");
            Set<String> permissions = Set.of(
                    "media:artifact:create", "media:artifact:write", "media:artifact:read",
                    "media:job:create", "media:job:read", "media:provider:read");
            String devPrincipal = "media-dev-owner-" + run;
            String token = devOnlyJwt(devPrincipal, TENANT, DEV_JWT_SECRET, permissions);
            launcher = startLauncher(classpath, env, log);
            awaitReady(launcher, port);

            String context = "MEDIA_PROFILE=dev, MEDIA_RUNTIME_ENVIRONMENT=dev, bucket=" + bucket;
            HttpResponse<String> providers = send(port, TENANT, token, "GET",
                    "/api/v1/providers", "", "application/json", null);
            assertThat(providers.statusCode()).as(providers.body()).isEqualTo(200);
            JsonNode providerSnapshot = JSON.readTree(providers.body());
            String artifactStore = providerSnapshot.path("artifactStoreId").asString();
            String jobStore = providerSnapshot.path("jobStoreId").asString();
            assertThat(artifactStore).as(context).isEqualTo("s3-postgresql");
            assertThat(jobStore).as(context).isEqualTo("postgresql");
            context += ", artifactStore=" + artifactStore + ", jobStore=" + jobStore;

            byte[] completeBytes = syntheticWav();
            byte[] first = java.util.Arrays.copyOfRange(completeBytes, 0, 128);
            byte[] second = java.util.Arrays.copyOfRange(completeBytes, 128, 256);
            byte[] finalChunk = java.util.Arrays.copyOfRange(completeBytes, 256, completeBytes.length);
            List<byte[]> chunks = List.of(first, second, finalChunk);
            String expectedDigest = sha256(completeBytes);
            String uploadRequest = """
                    {"tenantId":"%s","principalId":"%s","fileName":"synthetic.wav",
                     "contentType":"audio/wav","expectedSizeBytes":%d,
                     "expectedSha256":"%s","classification":"CONFIDENTIAL",
                     "retention":"P30D","metadata":{"sourceClockId":"fixture-clock",
                       "sourceClockMappingEvidenceRef":"fixture-clock-evidence",
                       "sourceClockTicksPerSecond":16000,"sourceDurationTicks":16000}}
                    """.formatted(TENANT, devPrincipal, completeBytes.length, expectedDigest);
            HttpResponse<String> begun = send(port, TENANT, token, "POST", "/api/v1/artifacts/uploads",
                    uploadRequest, "application/json", "dev-finalize-" + run);
            assertThat(begun.statusCode()).as(begun.body()).isEqualTo(201);
            String uploadId = JSON.readTree(begun.body()).path("uploadId").asString();

            long acknowledgedBytes = 0L;
            for (int index = 0; index < chunks.size(); index++) {
                byte[] chunk = chunks.get(index);
                HttpResponse<String> ack = sendBytes(port, TENANT, token, "PUT",
                        "/api/v1/artifacts/uploads/" + uploadId + "/chunks/" + index, chunk);
                assertThat(ack.statusCode()).as(context + ", chunkIndex=" + index + ": " + ack.body())
                        .isEqualTo(200);
                acknowledgedBytes += chunk.length;
                JsonNode receipt = JSON.readTree(ack.body());
                assertThat(receipt.path("bytesReceived").asLong()).as(context).isEqualTo(acknowledgedBytes);
                assertThat(receipt.path("nextChunkIndex").asInt()).as(context).isEqualTo(index + 1);
            }

            HttpResponse<String> persistedUpload = send(port, TENANT, token, "GET",
                    "/api/v1/artifacts/uploads/" + uploadId, "", "application/json", null);
            assertThat(persistedUpload.statusCode()).as(context + ", uploadId=" + uploadId)
                    .isEqualTo(200);
            JsonNode session = JSON.readTree(persistedUpload.body());
            assertThat(session.path("status").asString()).as(context).isEqualTo("OPEN");
            assertThat(session.path("retention").asText()).as(context).isEqualTo("PT720H");
            assertThat(session.path("principalId").asString()).as(context).isEqualTo(devPrincipal);
            assertThat(session.path("expectedSizeBytes").asLong()).as(context)
                    .isEqualTo(completeBytes.length);
            assertThat(session.path("expectedSha256").asString()).as(context).isEqualTo(expectedDigest);
            assertThat(session.path("bytesReceived").asLong()).as(context).isEqualTo(completeBytes.length);
            assertThat(session.path("nextChunkIndex").asInt()).as(context).isEqualTo(chunks.size());
            assertStoredChunkManifest(uploadId, chunks, context);

            HttpResponse<String> completed = send(port, TENANT, token, "POST",
                    "/api/v1/artifacts/uploads/" + uploadId + "/complete", "", "application/json", null);
            assertThat(completed.statusCode()).as(context + ", uploadId=" + uploadId
                    + ", persistedSession=" + persistedUpload.body()).isEqualTo(201);
            JsonNode artifact = JSON.readTree(completed.body());
            String artifactId = artifact.path("artifactId").asString();
            assertThat(artifact.path("sha256").asString()).isEqualTo(expectedDigest);

            String jobRequestId = "dev-diagnostic-job-" + run;
            String jobRequest = """
                    {"requestId":"%s","tenantId":"%s","principalId":"%s",
                     "correlationId":"dev-diagnostic-correlation-%s",
                     "artifactId":"%s","expectedArtifactVersion":"sha256:%s",
                     "jobType":"TRANSCODE","providerHint":"local-diagnostic","parameters":{}}
                    """.formatted(jobRequestId, TENANT, devPrincipal, run, artifactId, expectedDigest);
            HttpResponse<String> submitted = send(port, TENANT, token, "POST", "/api/v1/jobs",
                    jobRequest, "application/json", null);
            assertThat(submitted.statusCode()).as(submitted.body()).isEqualTo(202);
            String jobId = JSON.readTree(submitted.body()).path("jobId").asString();
            assertThat(jobId).isNotBlank();
            JsonNode diagnosticOutcome = awaitDiagnosticJob(port, TENANT, token, jobId, jobRequestId);

            stopLauncher(launcher);
            launcher = null;
            launcher = startLauncher(classpath, env, log);
            awaitReady(launcher, port);

            HttpResponse<String> artifactReadback = send(port, TENANT, token, "GET",
                    "/api/v1/artifacts/" + artifactId, "", "application/json", null);
            assertThat(artifactReadback.statusCode()).as(artifactReadback.body()).isEqualTo(200);
            assertThat(JSON.readTree(artifactReadback.body()).path("sha256").asString())
                    .isEqualTo(expectedDigest);
            JsonNode recoveredJob = awaitDiagnosticJob(port, TENANT, token, jobId, jobRequestId);
            assertThat(recoveredJob.path("status").asString()).isEqualTo("COMPLETED");
            assertThat(recoveredJob.path("result")).isEqualTo(diagnosticOutcome.path("result"));
        } finally {
            try {
                if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            } finally {
                try {
                    if (log != null) Files.deleteIfExists(log);
                } finally {
                    try {
                        deleteBucket(bucket);
                    } finally {
                        if (services != null && Files.exists(services)) {
                            try (var paths = Files.walk(services)) {
                                paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                                    try { Files.deleteIfExists(path); } catch (Exception ignored) { }
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    private static Map<String, String> environment(String bucket, int port) {
        Map<String, String> env = new HashMap<>();
        env.put("MEDIA_RUNTIME_ENABLED", "true");
        env.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        env.put("MEDIA_PROFILE", "local");
        env.put("MEDIA_HTTP_PORT", Integer.toString(port));
        env.put("MEDIA_LOCAL_PROVIDER_ENABLED", "true");
        env.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        env.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_LAUNCHER_DB_PASSWORD");
        env.put("MEDIA_LAUNCHER_DB_PASSWORD", POSTGRES.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        env.put("MEDIA_S3_BUCKET", bucket);
        env.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        env.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_LAUNCHER_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_LAUNCHER_SECRET");
        env.put("MEDIA_LAUNCHER_ACCESS", LOCALSTACK.getAccessKey());
        env.put("MEDIA_LAUNCHER_SECRET", LOCALSTACK.getSecretKey());
        env.put("MEDIA_JWT_HMAC_SECRET_REFERENCE", "secret:env:MEDIA_LAUNCHER_TEST_JWT_SECRET");
        env.put("MEDIA_JWT_ISSUER", "https://issuer.example");
        env.put("MEDIA_JWT_AUDIENCE", "ghatana-runtime");
        env.put("MEDIA_LAUNCHER_TEST_JWT_SECRET", JWT_SECRET);
        return env;
    }

    private static Map<String, String> devEnvironment(String bucket, int port) {
        Map<String, String> env = environment(bucket, port);
        env.put("MEDIA_RUNTIME_ENVIRONMENT", "dev");
        env.put("MEDIA_PROFILE", "dev");
        env.put("MEDIA_DEV_IDENTITY_ENABLED", "true");
        env.put("MEDIA_DEV_JWT_HMAC_SECRET", DEV_JWT_SECRET);
        return env;
    }

    private static JsonNode awaitDiagnosticJob(
            int port, String tenant, String token, String jobId, String requestId) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (System.nanoTime() < deadline) {
            HttpResponse<String> readback = send(port, tenant, token, "GET",
                    "/api/v1/jobs/" + jobId + "?requestId=" + requestId,
                    "", "application/json", null);
            assertThat(readback.statusCode()).as(readback.body()).isEqualTo(200);
            JsonNode observed = JSON.readTree(readback.body());
            if ("COMPLETED".equals(observed.path("status").asString())) {
                assertThat(observed.path("providerId").asString()).isEqualTo("local-diagnostic");
                assertThat(observed.path("result").path("diagnostic").asBoolean()).isTrue();
                assertThat(observed.path("result").path("rawMediaRead").asBoolean()).isFalse();
                return observed;
            }
            assertThat(observed.path("status").asString())
                    .as("diagnostic job must remain in a recognized nonterminal state while polling")
                    .isIn("ACCEPTED", "RUNNING");
            Thread.sleep(100);
        }
        throw new AssertionError("Timed out waiting for the local diagnostic job result");
    }

    private static void installChildServiceDescriptors(Path root) throws Exception {
        Path services = root.resolve("META-INF/services");
        Files.createDirectories(services);
        Files.writeString(services.resolve("com.ghatana.governance.PolicyEngine"),
                MediaLauncherProcessFixtures.Policy.class.getName() + "\n");
        Files.writeString(services.resolve(
                "com.ghatana.media.runtime.MediaRuntimeContracts$MediaProcessingProvider"),
                MediaLauncherProcessFixtures.Stt.class.getName() + "\n");
    }

    private static Process startLauncher(String classpath, Map<String, String> env, Path log) throws Exception {
        String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        ProcessBuilder builder = new ProcessBuilder(java, "-cp", classpath,
                "com.ghatana.media.launcher.MediaLauncher");
        builder.environment().putAll(env);
        builder.redirectErrorStream(true);
        builder.redirectOutput(log.toFile());
        return builder.start();
    }

    private static void awaitReady(Process process, int port) throws Exception {
        long deadline = System.nanoTime() + java.time.Duration.ofMinutes(2).toNanos();
        while (System.nanoTime() < deadline) {
            if (!process.isAlive()) throw new AssertionError("MediaLauncher exited: " + process.exitValue());
            try {
                HttpResponse<String> response = HttpClient.newHttpClient().send(
                        HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/health/ready"))
                                .GET().build(), HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() == 200) return;
            } catch (java.io.IOException ignored) { }
            Thread.sleep(200);
        }
        throw new AssertionError("MediaLauncher did not become ready");
    }

    private static HttpResponse<String> send(int port, String tenant, String token, String method,
            String path, String body, String contentType, String idempotencyKey) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .header("X-Tenant-Id", tenant).header("Authorization", "Bearer " + token);
        if (contentType != null) request.header("Content-Type", contentType);
        if (idempotencyKey != null) request.header("Idempotency-Key", idempotencyKey);
        if ("POST".equals(method)) request.POST(HttpRequest.BodyPublishers.ofString(body));
        else if ("GET".equals(method)) request.GET();
        else throw new IllegalArgumentException("Unsupported bodyless method: " + method);
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private static HttpResponse<String> sendBytes(int port, String tenant, String token, String method,
            String path, byte[] bytes) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .header("X-Tenant-Id", tenant).header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/octet-stream")
                .method(method, HttpRequest.BodyPublishers.ofByteArray(bytes)).build();
        return HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private static String authenticatedJwt(String subject, String tenant, String secret) throws Exception {
        return authenticatedJwt(subject, tenant, secret, UPLOAD_PERMISSIONS);
    }

    private static String authenticatedJwt(String subject, String tenant, String secret,
            Set<String> grantedPermissions) throws Exception {
        String header = base64Url("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        String permissions = grantedPermissions.stream().sorted()
                .map(permission -> "\"" + permission + "\"")
                .collect(java.util.stream.Collectors.joining(","));
        String payload = base64Url("{\"sub\":\"" + subject + "\",\"tenant_id\":\"" + tenant
                + "\",\"iss\":\"https://issuer.example\",\"aud\":\"ghatana-runtime\",\"exp\":"
                + Instant.now().plusSeconds(300).getEpochSecond() + ",\"permissions\":[" + permissions + "]}");
        String signingInput = header + "." + payload;
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return signingInput + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.US_ASCII)));
    }

    private static String base64Url(String value) {
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private static void stopLauncher(Process process) throws Exception {
        process.destroy();
        if (!process.waitFor(15, TimeUnit.SECONDS)) {
            process.destroyForcibly();
            assertThat(process.waitFor(10, TimeUnit.SECONDS)).isTrue();
        }
        assertThat(process.isAlive()).isFalse();
    }

    private static S3Client s3() {
        return S3Client.builder().endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build();
    }

    private static void deleteBucket(String bucket) {
        try (S3Client s3 = s3()) {
            var objects = s3.listObjectsV2Paginator(
                    software.amazon.awssdk.services.s3.model.ListObjectsV2Request.builder()
                            .bucket(bucket).build());
            for (var page : objects) {
                if (!page.contents().isEmpty()) {
                    s3.deleteObjects(software.amazon.awssdk.services.s3.model.DeleteObjectsRequest.builder()
                            .bucket(bucket).delete(software.amazon.awssdk.services.s3.model.Delete.builder()
                                    .objects(page.contents().stream().map(object ->
                                            software.amazon.awssdk.services.s3.model.ObjectIdentifier.builder()
                                                    .key(object.key()).build()).toList()).build()).build());
                }
            }
            s3.deleteBucket(software.amazon.awssdk.services.s3.model.DeleteBucketRequest.builder()
                    .bucket(bucket).build());
        } catch (RuntimeException cleanupFailure) {
            // Bucket is unique to this Testcontainers run; container teardown remains the final cleanup.
        }
    }

    private static byte[] syntheticWav() {
        int samples = 16_000;
        byte[] wav = new byte[44 + samples * 2];
        java.nio.ByteBuffer buffer = java.nio.ByteBuffer.wrap(wav).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        buffer.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(wav.length - 8)
                .put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1)
                .putShort((short) 1).putInt(16_000).putInt(32_000).putShort((short) 2).putShort((short) 16)
                .put("data".getBytes(StandardCharsets.US_ASCII)).putInt(samples * 2);
        return wav;
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static long countRows(String sql, String tenant) throws Exception {
        try (var connection = DriverManager.getConnection(
                        POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                var statement = connection.prepareStatement(sql)) {
            statement.setString(1, tenant);
            try (var result = statement.executeQuery()) {
                if (!result.next()) throw new AssertionError("Count query returned no row");
                return result.getLong(1);
            }
        }
    }

    private static void assertStoredChunkManifest(String uploadId, List<byte[]> chunks, String context)
            throws Exception {
        try (var connection = DriverManager.getConnection(
                        POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                var statement = connection.prepareStatement(
                        "SELECT chunk_index,size_bytes,sha256 FROM media_upload_chunks "
                                + "WHERE tenant_id=? AND upload_id=? ORDER BY chunk_index")) {
            statement.setString(1, TENANT);
            statement.setString(2, uploadId);
            try (var result = statement.executeQuery()) {
                for (int expectedIndex = 0; expectedIndex < chunks.size(); expectedIndex++) {
                    assertThat(result.next()).as(context + ", missing persisted chunk " + expectedIndex).isTrue();
                    byte[] chunk = chunks.get(expectedIndex);
                    assertThat(result.getInt("chunk_index")).as(context).isEqualTo(expectedIndex);
                    assertThat(result.getLong("size_bytes")).as(context).isEqualTo(chunk.length);
                    assertThat(result.getString("sha256")).as(context).isEqualTo(sha256(chunk));
                }
                assertThat(result.next()).as(context + ", unexpected extra persisted chunk").isFalse();
            }
        }
    }

    private static String devOnlyJwt(String subject, String tenant, String secret,
            Set<String> grantedPermissions) throws Exception {
        String header = base64Url("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        String permissions = grantedPermissions.stream().sorted()
                .map(permission -> "\"" + permission + "\"")
                .collect(java.util.stream.Collectors.joining(","));
        String payload = base64Url("{\"sub\":\"" + subject + "\",\"tenant_id\":\"" + tenant
                + "\",\"iss\":\"urn:ghatana:media:dev-only\",\"aud\":\"ghatana-media-dev\",\"exp\":"
                + Instant.now().plusSeconds(300).getEpochSecond()
                + ",\"dev_only\":true,\"permissions\":[" + permissions + "]}");
        String signingInput = header + "." + payload;
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return signingInput + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.US_ASCII)));
    }
}
