package com.ghatana.media.integration;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Assumptions;
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

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.StandardOpenOption;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.DriverManager;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaLauncherProcessFixtures.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** Source-free HTTP journey using the local DEV_ONLY issuer and isolated PostgreSQL/S3. */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevIssuerHeadlessRestartIT {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String DEV_SECRET = "media-dev-issuer-headless-restart-secret";
    private static final String SDK_HTTP_TRACE_WRAPPER = """
            const originalFetch = globalThis.fetch;
            globalThis.fetch = async (input, init = {}) => {
              const response = await originalFetch(input, init);
              const url = new URL(typeof input === "string" ? input : input.url);
              let responseCode = null;
              if (!response.ok) {
                const body = await response.clone().json().catch(() => null);
                responseCode = body?.error?.code ?? body?.code ?? null;
              }
              process.stdout.write(JSON.stringify({
                method: init.method ?? "GET", path: url.pathname, status: response.status, responseCode,
              }) + "\\n");
              return response;
            };
            const { runHeadlessApiExample } = await import("./examples/media-headless-api/index.mjs");
            try {
              await runHeadlessApiExample();
            } catch (error) {
              process.stderr.write(JSON.stringify({ sdkError: {
                code: error?.detail?.code ?? null,
                category: error?.detail?.category ?? null,
                statusCode: error?.statusCode ?? null,
                message: error instanceof Error ? error.message : "unknown error",
              } }) + "\\n");
              process.exitCode = 1;
            }
            """;

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void ownerIssuedDevIdentityCompletesAndReadsBackUploadAndDiagnosticJobAcrossRestart() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-headless-" + run;
        String principal = "media-dev-owner-" + run;
        String bucket = "media-dev-headless-" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-headless-services-");
        Path log = Files.createTempFile("media-dev-headless-process-", ".log");
        Path sdkInput = Files.createTempFile("media-dev-headless-sdk-input-", ".wav");
        Path cliInput = Files.createTempFile("media-dev-headless-cli-input-", ".wav");
        Process launcher = null;
        try {
            try (S3Client s3 = s3()) {
                s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = environment(bucket, port);
            String devTimelineSchema = "media_dev_headless_" + run;
            environment.put("MEDIA_PROJECT_TIMELINE_DEV_ENABLED", "true");
            environment.put("MEDIA_PROJECT_TIMELINE_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
            environment.put("MEDIA_PROJECT_TIMELINE_SCHEMA", devTimelineSchema);
            environment.put("MEDIA_PROJECT_TIMELINE_POSTGRES_USER", POSTGRES.getUsername());
            environment.put("MEDIA_PROJECT_TIMELINE_POSTGRES_PASSWORD_REFERENCE",
                    "secret:env:MEDIA_PROJECT_TIMELINE_DB_PASSWORD");
            environment.put("MEDIA_PROJECT_TIMELINE_DB_PASSWORD", POSTGRES.getPassword());
            String token = issueDevToken(tenant, principal);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            byte[] bytes = syntheticWav();
            List<byte[]> chunks = List.of(Arrays.copyOfRange(bytes, 0, 128),
                    Arrays.copyOfRange(bytes, 128, 256), Arrays.copyOfRange(bytes, 256, bytes.length));
            String digest = sha256(bytes);
            String uploadRequest = """
                    {"tenantId":"%s","principalId":"%s","fileName":"synthetic.wav",
                     "contentType":"audio/wav","expectedSizeBytes":%d,"expectedSha256":"%s",
                     "classification":"CONFIDENTIAL","retention":"P30D",
                     "metadata":{"sourceClockId":"fixture-clock",
                     "sourceClockMappingEvidenceRef":"fixture-clock-evidence",
                     "sourceClockTicksPerSecond":16000,"sourceDurationTicks":16000}}
                    """.formatted(tenant, principal, bytes.length, digest);
            HttpResponse<String> begin = send(port, tenant, token, "POST", "/api/v1/artifacts/uploads",
                    uploadRequest, "application/json", "dev-headless-" + run);
            assertThat(begin.statusCode()).as(begin.body()).isEqualTo(201);
            String uploadId = JSON.readTree(begin.body()).path("uploadId").asString();
            assertThat(uploadId).isNotBlank();
            int sent = 0;
            for (int index = 0; index < 2; index++) {
                sent += chunks.get(index).length;
                HttpResponse<String> ack = sendBytes(port, tenant, token, "PUT",
                        "/api/v1/artifacts/uploads/" + uploadId + "/chunks/" + index, chunks.get(index));
                assertThat(ack.statusCode()).as(ack.body()).isEqualTo(200);
                assertThat(JSON.readTree(ack.body()).path("bytesReceived").asLong()).isEqualTo(sent);
            }

            stopLauncher(launcher);
            launcher = null;
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            HttpResponse<String> resumed = send(port, tenant, token, "GET",
                    "/api/v1/artifacts/uploads/" + uploadId, "", "application/json", null);
            assertThat(resumed.statusCode()).as(resumed.body()).isEqualTo(200);
            JsonNode resumedSession = JSON.readTree(resumed.body());
            assertThat(resumedSession.path("tenantId").asString()).isEqualTo(tenant);
            assertThat(resumedSession.path("principalId").asString()).isEqualTo(principal);
            assertThat(resumedSession.path("bytesReceived").asLong()).isEqualTo(sent);
            assertThat(resumedSession.path("nextChunkIndex").asInt()).isEqualTo(2);

            HttpResponse<String> lastAck = sendBytes(port, tenant, token, "PUT",
                    "/api/v1/artifacts/uploads/" + uploadId + "/chunks/2", chunks.get(2));
            assertThat(lastAck.statusCode()).as(lastAck.body()).isEqualTo(200);
            HttpResponse<String> complete = send(port, tenant, token, "POST",
                    "/api/v1/artifacts/uploads/" + uploadId + "/complete", "", "application/json", null);
            assertThat(complete.statusCode()).as(complete.body()).isEqualTo(201);
            JsonNode artifact = JSON.readTree(complete.body());
            String artifactId = artifact.path("artifactId").asString();
            assertThat(artifact.path("sha256").asString()).isEqualTo(digest);
            assertThat(artifact.path("sizeBytes").asLong()).isEqualTo(bytes.length);

            HttpResponse<String> inspected = send(port, tenant, token, "GET",
                    "/api/v1/artifacts/" + artifactId, "", "application/json", null);
            assertThat(inspected.statusCode()).as(inspected.body()).isEqualTo(200);
            assertThat(JSON.readTree(inspected.body()).path("sha256").asString()).isEqualTo(digest);
            String objectReference = JSON.readTree(inspected.body()).path("objectReference").asString();
            String objectKey = URI.create(objectReference).getPath().substring(1);
            try (S3Client s3 = s3()) {
                assertThat(s3.getObjectAsBytes(GetObjectRequest.builder().bucket(bucket).key(objectKey).build())
                        .asByteArray()).containsExactly(bytes);
            }
            assertThat(countRows("SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=? AND artifact_id=?",
                    tenant, artifactId)).isEqualTo(1L);

            String requestId = "dev-headless-diagnostic-" + run;
            String jobRequest = """
                    {"requestId":"%s","tenantId":"%s","principalId":"%s",
                     "correlationId":"dev-headless-correlation-%s","artifactId":"%s",
                     "expectedArtifactVersion":"sha256:%s","jobType":"TRANSCODE",
                     "providerHint":"local-diagnostic","parameters":{}}
                    """.formatted(requestId, tenant, principal, run, artifactId, digest);
            HttpResponse<String> submitted = send(port, tenant, token, "POST", "/api/v1/jobs",
                    jobRequest, "application/json", null);
            assertThat(submitted.statusCode()).as(submitted.body()).isEqualTo(202);
            String jobId = JSON.readTree(submitted.body()).path("jobId").asString();
            JsonNode beforeRestart = awaitDiagnosticJob(port, tenant, token, jobId, requestId);
            assertObservedDiagnosticJob(beforeRestart, tenant, principal, artifactId, jobId, requestId);
            String jobReadToken = issueJobReadOnlyDevToken(tenant, principal);
            assertJobReadOnlyToken(jobReadToken, tenant, principal);
            assertRealHostCliJobGet(tenant, principal, jobId, requestId, port, jobReadToken, beforeRestart);

            stopLauncher(launcher);
            launcher = null;
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            HttpResponse<String> recoveredArtifact = send(port, tenant, token, "GET",
                    "/api/v1/artifacts/" + artifactId, "", "application/json", null);
            assertThat(recoveredArtifact.statusCode()).as(recoveredArtifact.body()).isEqualTo(200);
            JsonNode recoveredJob = awaitDiagnosticJob(port, tenant, token, jobId, requestId);
            assertObservedDiagnosticJob(recoveredJob, tenant, principal, artifactId, jobId, requestId);
            assertThat(recoveredJob.path("status").asString()).isEqualTo("COMPLETED");
            assertThat(recoveredJob.path("version")).isEqualTo(beforeRestart.path("version"));
            assertThat(recoveredJob.path("result")).isEqualTo(beforeRestart.path("result"));
            assertThat(recoveredJob.path("result").path("diagnostic").asBoolean()).isTrue();
            assertThat(recoveredJob.path("result").path("rawMediaRead").asBoolean()).isFalse();
            assertRealHostCliJobGet(tenant, principal, jobId, requestId, port, jobReadToken, recoveredJob);

            // Run the public package consumer against the same authenticated host and
            // identity as the raw HTTP journey above. Its mock contract test is not
            // used here: this child executes the built SDK against Testcontainers.
            // Use different bytes from the raw HTTP scenario. The store correctly
            // rejects identical bytes when immutable artifact metadata differs.
            byte[] sdkBytes = syntheticWav(1);
            Files.write(sdkInput, sdkBytes, StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING);
            JsonNode sdkCheckpoint = runHeadlessSdkExample(
                    tenant, principal, token, port, sdkInput, "audio/wav", null, 128, 1);
            assertThat(sdkCheckpoint.path("interrupted").asBoolean()).isTrue();
            String sdkUploadId = sdkCheckpoint.path("upload").path("uploadId").asString();
            assertThat(sdkUploadId).isNotBlank();
            assertThat(sdkCheckpoint.path("upload").path("bytesReceived").asLong()).isEqualTo(128);
            List<byte[]> sdkChunks = List.of(
                    Arrays.copyOfRange(sdkBytes, 0, 128),
                    Arrays.copyOfRange(sdkBytes, 128, 256),
                    Arrays.copyOfRange(sdkBytes, 256, sdkBytes.length));
            assertUploadSessionAndChunks(tenant, sdkUploadId, "OPEN", 128L, 1,
                    sha256(sdkBytes), sdkChunks.subList(0, 1));

            // The public SDK is deliberately stopped after one confirmed chunk. The
            // Media process is recreated before the same source-free consumer resumes
            // the exact upload ID from durable session readback.
            stopLauncher(launcher);
            launcher = null;
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            String readOnlyArtifactToken = issueArtifactReadOnlyDevToken(tenant, principal);
            assertReadOnlyBrowserToken(readOnlyArtifactToken, tenant, principal, List.of("media:artifact:read"));
            HttpResponse<String> readOnlySession = send(port, tenant, readOnlyArtifactToken, "GET",
                    "/api/v1/artifacts/uploads/" + sdkUploadId, "", "application/json", null);
            assertThat(readOnlySession.statusCode()).as(readOnlySession.body()).isEqualTo(200);
            assertThat(JSON.readTree(readOnlySession.body()).path("uploadId").asString()).isEqualTo(sdkUploadId);
            assertThat(JSON.readTree(readOnlySession.body()).path("bytesReceived").asLong()).isEqualTo(128L);
            String deniedSdkOutput = runHeadlessSdkExampleExpectingFailure(
                    tenant, principal, readOnlyArtifactToken, port, sdkInput, "audio/wav", sdkUploadId, 128);
            assertThat(deniedSdkOutput)
                    .contains("\"method\":\"GET\",\"path\":\"/api/v1/artifacts/uploads/" + sdkUploadId
                            + "\",\"status\":200")
                    .contains("\"method\":\"PUT\",\"path\":\"/api/v1/artifacts/uploads/" + sdkUploadId
                            + "/chunks/1\",\"status\":403")
                    .contains("\"status\":403,\"responseCode\":\"FORBIDDEN\"")
                    .contains("\"code\":\"HTTP_403\"")
                    .contains("\"category\":\"AUTHORIZATION\"")
                    .contains("\"statusCode\":403")
                    .doesNotContain(readOnlyArtifactToken);

            HttpResponse<String> unchangedUpload = send(port, tenant, token, "GET",
                    "/api/v1/artifacts/uploads/" + sdkUploadId, "", "application/json", null);
            assertThat(unchangedUpload.statusCode()).as(unchangedUpload.body()).isEqualTo(200);
            JsonNode unchangedSession = JSON.readTree(unchangedUpload.body());
            assertThat(unchangedSession.path("status").asString()).isEqualTo("OPEN");
            assertThat(unchangedSession.path("bytesReceived").asLong()).isEqualTo(128L);
            assertThat(unchangedSession.path("nextChunkIndex").asInt()).isEqualTo(1);
            assertUploadSessionAndChunks(tenant, sdkUploadId, "OPEN", 128L, 1,
                    sha256(sdkBytes), sdkChunks.subList(0, 1));

            JsonNode sdkRun = runHeadlessSdkExample(
                    tenant, principal, token, port, sdkInput, "audio/wav", sdkUploadId, 128, null);
            JsonNode sdkArtifactSummary = sdkRun.path("artifact");
            String sdkArtifactId = sdkArtifactSummary.path("artifactId").asString();
            String sdkRequestId = sdkRun.path("job").path("requestId").asString();
            String sdkJobId = sdkRun.path("job").path("jobId").asString();
            assertThat(sdkArtifactId).isNotBlank();
            assertThat(sdkRequestId).isNotBlank();
            assertThat(sdkJobId).isNotBlank();
            assertThat(sdkArtifactSummary.path("sha256").asString()).isEqualTo(sha256(sdkBytes));
            assertThat(sdkArtifactSummary.path("sizeBytes").asLong()).isEqualTo(sdkBytes.length);
            assertUploadSessionAndChunks(tenant, sdkUploadId, "COMPLETED", sdkBytes.length,
                    sdkChunks.size(), sha256(sdkBytes), sdkChunks);
            assertS3ArtifactBytes(bucket, sdkArtifactSummary.path("artifactId").asString(), sdkBytes,
                    port, tenant, principal, token);
            JsonNode sdkJobBeforeRestart = awaitDiagnosticJob(port, tenant, token, sdkJobId, sdkRequestId);
            assertThat(sdkJobBeforeRestart.path("result").path("diagnostic").asBoolean()).isTrue();
            assertThat(sdkJobBeforeRestart.path("result").path("rawMediaRead").asBoolean()).isFalse();

            stopLauncher(launcher);
            launcher = null;
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            HttpResponse<String> sdkArtifactAfterRestart = send(port, tenant, token, "GET",
                    "/api/v1/artifacts/" + sdkArtifactId, "", "application/json", null);
            assertThat(sdkArtifactAfterRestart.statusCode()).as(sdkArtifactAfterRestart.body()).isEqualTo(200);
            JsonNode sdkArtifactReadback = JSON.readTree(sdkArtifactAfterRestart.body());
            assertThat(sdkArtifactReadback.path("tenantId").asString()).isEqualTo(tenant);
            assertThat(sdkArtifactReadback.path("principalId").asString()).isEqualTo(principal);
            assertThat(sdkArtifactReadback.path("sizeBytes").asLong()).isEqualTo(sdkBytes.length);
            assertThat(sdkArtifactReadback.path("sha256").asString()).isEqualTo(sha256(sdkBytes));
            assertS3ArtifactBytes(bucket, sdkArtifactId, sdkBytes, port, tenant, principal, token);
            JsonNode sdkJobAfterRestart = awaitDiagnosticJob(port, tenant, token, sdkJobId, sdkRequestId);
            assertThat(sdkJobAfterRestart.path("tenantId").asString()).isEqualTo(tenant);
            assertThat(sdkJobAfterRestart.path("principalId").asString()).isEqualTo(principal);
            assertThat(sdkJobAfterRestart.path("artifactId").asString()).isEqualTo(sdkArtifactId);
            assertThat(sdkJobAfterRestart.path("requestId").asString()).isEqualTo(sdkRequestId);
            assertThat(sdkJobAfterRestart.path("status").asString()).isEqualTo("COMPLETED");
            assertThat(sdkJobAfterRestart.path("result")).isEqualTo(sdkJobBeforeRestart.path("result"));
            assertThat(sdkJobAfterRestart.path("result").path("diagnostic").asBoolean()).isTrue();
            assertThat(sdkJobAfterRestart.path("result").path("rawMediaRead").asBoolean()).isFalse();

            // Exercise the installed DEV_ONLY CLI binary itself against the real
            // signed local host. This complements, rather than replaces, the SDK
            // upload/restart path above and uses a distinct synthetic source.
            byte[] cliBytes = syntheticWav(2);
            Files.write(cliInput, cliBytes, StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING);
            String cliUploadToken = issueDevToken(tenant, principal);
            JsonNode cliUpload = runRealHostDevCli(tenant, principal, port, cliUploadToken,
                    List.of("artifact", "upload",
                            "--file", cliInput.toString(),
                            "--content-type", "audio/wav",
                            "--classification", "INTERNAL",
                            "--retention", "P30D",
                            "--idempotency-key", "cli-upload-" + run),
                    "media.cli.local-development.artifact.upload", "artifact");
            JsonNode cliArtifact = cliUpload.path("artifact");
            String cliArtifactId = cliArtifact.path("artifactId").asString();
            String cliDigest = sha256(cliBytes);
            assertThat(cliArtifactId).isNotBlank();
            assertThat(cliArtifact.path("tenantId").asString()).isEqualTo(tenant);
            assertThat(cliArtifact.path("principalId").asString()).isEqualTo(principal);
            assertThat(cliArtifact.path("sha256").asString()).isEqualTo(cliDigest);
            assertThat(cliArtifact.path("sizeBytes").asLong()).isEqualTo(cliBytes.length);

            String artifactReadOnlyToken = issueArtifactReadOnlyDevToken(tenant, principal);
            assertReadOnlyBrowserToken(artifactReadOnlyToken, tenant, principal,
                    List.of("media:artifact:read"));
            JsonNode cliInspect = runRealHostDevCli(tenant, principal, port, artifactReadOnlyToken,
                    List.of("artifact", "inspect", "--artifact", cliArtifactId),
                    "media.cli.local-development.artifact.inspect", "artifact");
            JsonNode inspectedCliArtifact = cliInspect.path("artifact");
            assertThat(inspectedCliArtifact.path("artifactId").asString()).isEqualTo(cliArtifactId);
            assertThat(inspectedCliArtifact.path("tenantId").asString()).isEqualTo(tenant);
            assertThat(inspectedCliArtifact.path("principalId").asString()).isEqualTo(principal);
            assertThat(inspectedCliArtifact.path("sha256").asString()).isEqualTo(cliDigest);
            assertThat(inspectedCliArtifact.path("sizeBytes").asLong()).isEqualTo(cliBytes.length);

            HttpResponse<String> cliArtifactAfterRead = send(port, tenant, artifactReadOnlyToken, "GET",
                    "/api/v1/artifacts/" + cliArtifactId, "", "application/json", null);
            assertThat(cliArtifactAfterRead.statusCode()).as(cliArtifactAfterRead.body()).isEqualTo(200);
            JsonNode cliDurableReadback = JSON.readTree(cliArtifactAfterRead.body());
            assertThat(cliDurableReadback.path("artifactId").asString()).isEqualTo(cliArtifactId);
            assertThat(cliDurableReadback.path("tenantId").asString()).isEqualTo(tenant);
            assertThat(cliDurableReadback.path("principalId").asString()).isEqualTo(principal);
            assertThat(cliDurableReadback.path("sha256").asString()).isEqualTo(cliDigest);
            assertThat(cliDurableReadback.path("sizeBytes").asLong()).isEqualTo(cliBytes.length);
            assertThat(countRows("SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=? AND artifact_id=?",
                    tenant, cliArtifactId)).isEqualTo(1L);
            assertS3ArtifactBytes(bucket, cliArtifactId, cliBytes, port, tenant, principal,
                    artifactReadOnlyToken);
            runJobRecoveryBrowser(tenant, principal, port, sdkJobAfterRestart);
        } finally {
            try {
                if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            } finally {
                try { Files.deleteIfExists(log); }
                finally {
                    try { Files.deleteIfExists(sdkInput); }
                    finally {
                        try { Files.deleteIfExists(cliInput); }
                        finally {
                            try { deleteBucket(bucket); }
                            finally {
                                if (Files.exists(services)) try (var paths = Files.walk(services)) {
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
    }

    @Test
    void devOnlyCliResumesPartialOpenUploadFromSameIdempotencyKeyAfterLauncherRestart() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-cli-resume-" + run;
        String principal = "media-dev-owner-" + run;
        String bucket = "media-cli-resume-" + run;
        String uploadKey = "cli-resume-" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-cli-resume-services-");
        Path log = Files.createTempFile("media-cli-resume-process-", ".log");
        Path source = Files.createTempFile("media-cli-resume-source-", ".wav");
        Path trace = Files.createTempFile("media-cli-resume-trace-", ".jsonl");
        Path preload = Files.createTempFile("media-cli-resume-fetch-trace-", ".mjs");
        Process launcher = null;
        try {
            try (S3Client s3 = s3()) {
                s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = environment(bucket, port);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            byte[] bytes = syntheticWav(3);
            Files.write(source, bytes, StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING);
            String fileName = source.getFileName().toString();
            String digest = sha256(bytes);
            String token = issueDevToken(tenant, principal);
            String beginRequest = """
                    {"tenantId":"%s","principalId":"%s","fileName":"%s",
                     "contentType":"audio/wav","expectedSizeBytes":%d,"expectedSha256":"%s",
                     "classification":"INTERNAL","retention":"P30D","metadata":{}}
                    """.formatted(tenant, principal, fileName, bytes.length, digest);
            HttpResponse<String> begin = send(port, tenant, token, "POST", "/api/v1/artifacts/uploads",
                    beginRequest, "application/json", uploadKey);
            assertThat(begin.statusCode()).as(begin.body()).isEqualTo(201);
            JsonNode begun = JSON.readTree(begin.body());
            String uploadId = begun.path("uploadId").asString();
            assertThat(uploadId).isNotBlank();

            int prefixBytes = 128;
            List<byte[]> prefixChunks = List.of(
                    Arrays.copyOfRange(bytes, 0, 64), Arrays.copyOfRange(bytes, 64, prefixBytes));
            int received = 0;
            for (int index = 0; index < prefixChunks.size(); index++) {
                byte[] chunk = prefixChunks.get(index);
                HttpResponse<String> ack = sendBytes(port, tenant, token, "PUT",
                        "/api/v1/artifacts/uploads/" + uploadId + "/chunks/" + index, chunk);
                assertThat(ack.statusCode()).as(ack.body()).isEqualTo(200);
                received += chunk.length;
                assertThat(JSON.readTree(ack.body()).path("bytesReceived").asLong()).isEqualTo(received);
            }
            assertThat(received).isEqualTo(prefixBytes);

            stopLauncher(launcher);
            launcher = null;
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            HttpResponse<String> recoveredOpenSession = send(port, tenant, token, "GET",
                    "/api/v1/artifacts/uploads/" + uploadId, "", "application/json", null);
            assertThat(recoveredOpenSession.statusCode()).as(recoveredOpenSession.body()).isEqualTo(200);
            JsonNode recoveredOpen = JSON.readTree(recoveredOpenSession.body());
            assertThat(recoveredOpen.path("uploadId").asString()).isEqualTo(uploadId);
            assertThat(recoveredOpen.path("status").asString()).isEqualTo("OPEN");
            assertThat(recoveredOpen.path("bytesReceived").asLong()).isEqualTo(prefixBytes);
            assertThat(recoveredOpen.path("nextChunkIndex").asInt()).isEqualTo(2);

            Files.writeString(preload, """
                    import { appendFileSync } from 'node:fs';
                    const originalFetch = globalThis.fetch;
                    globalThis.fetch = async (input, init = {}) => {
                      const response = await originalFetch(input, init);
                      const url = new URL(typeof input === 'string' ? input : input.url);
                      const headers = new Headers(init.headers);
                      appendFileSync(process.env.MEDIA_CLI_UPLOAD_TRACE, JSON.stringify({
                        method: init.method ?? 'GET', path: url.pathname,
                        idempotencyKey: headers.get('idempotency-key'), status: response.status,
                      }) + '\\n');
                      return response;
                    };
                    """);
            JsonNode output = runRealHostDevCliWithTrace(tenant, principal, port, token,
                    List.of("artifact", "upload", "--file", source.toString(),
                            "--content-type", "audio/wav", "--classification", "INTERNAL",
                            "--retention", "P30D", "--idempotency-key", uploadKey),
                    preload, trace);
            JsonNode artifact = output.path("artifact");
            String artifactId = artifact.path("artifactId").asString();
            assertThat(artifactId).isNotBlank();
            assertThat(artifact.path("tenantId").asString()).isEqualTo(tenant);
            assertThat(artifact.path("principalId").asString()).isEqualTo(principal);
            assertThat(artifact.path("sizeBytes").asLong()).isEqualTo(bytes.length);
            assertThat(artifact.path("sha256").asString()).isEqualTo(digest);

            List<JsonNode> traceEntries = Files.readAllLines(trace, StandardCharsets.UTF_8).stream()
                    .map(line -> {
                        try { return JSON.readTree(line); }
                        catch (Exception error) { throw new AssertionError("Invalid CLI HTTP trace", error); }
                    }).toList();
            assertThat(traceEntries.stream().map(entry -> entry.path("method").asString() + " "
                    + entry.path("path").asString()).toList()).containsExactly(
                    "GET /dev/v1/artifact-upload-policy",
                    "POST /api/v1/artifacts/uploads",
                    "PUT /api/v1/artifacts/uploads/" + uploadId + "/chunks/2",
                    "GET /api/v1/artifacts/uploads/" + uploadId,
                    "POST /api/v1/artifacts/uploads/" + uploadId + "/complete");
            assertThat(traceEntries.get(1).path("idempotencyKey").asString()).isEqualTo(uploadKey);
            assertThat(traceEntries.stream().filter(entry -> entry.path("path").asString().endsWith("/complete")))
                    .hasSize(1);

            HttpResponse<String> completedSessionRead = send(port, tenant, token, "GET",
                    "/api/v1/artifacts/uploads/" + uploadId, "", "application/json", null);
            assertThat(completedSessionRead.statusCode()).as(completedSessionRead.body()).isEqualTo(200);
            JsonNode completedSession = JSON.readTree(completedSessionRead.body());
            assertThat(completedSession.path("status").asString()).isEqualTo("COMPLETED");
            assertThat(completedSession.path("bytesReceived").asLong()).isEqualTo(bytes.length);
            assertThat(completedSession.path("nextChunkIndex").asInt()).isEqualTo(3);
            assertThat(countRows("SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=? AND artifact_id=?",
                    tenant, artifactId)).isEqualTo(1L);
            assertS3ArtifactBytes(bucket, artifactId, bytes, port, tenant, principal, token);
        } finally {
            try {
                if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            } finally {
                Files.deleteIfExists(log);
                Files.deleteIfExists(source);
                Files.deleteIfExists(trace);
                Files.deleteIfExists(preload);
                deleteBucket(bucket);
                deleteTree(services);
            }
        }
    }

    @Test
    void pinnedRecorderMuxPreviewUploadsThroughPublicSdkAndSurvivesHostRestart() throws Exception {
        String ffmpegValue = System.getenv("GHATANA_MEDIA_FFMPEG");
        String ffprobeValue = System.getenv("GHATANA_MEDIA_FFPROBE");
        Assumptions.assumeTrue(ffmpegValue != null && !ffmpegValue.isBlank()
                        && ffprobeValue != null && !ffprobeValue.isBlank(),
                "Provision the source-pinned FFmpeg 8.1.2 test pair and set GHATANA_MEDIA_FFMPEG/FFPROBE");

        Path repoRoot = mediaRepoRoot();
        Path ffmpeg = Path.of(ffmpegValue).toRealPath();
        Path ffprobe = Path.of(ffprobeValue).toRealPath();
        assertThat(ffmpeg.getParent()).as("FFmpeg and FFprobe must come from one verified release").isEqualTo(ffprobe.getParent());
        JsonNode codecProvision = JSON.readTree(Files.readString(ffmpeg.getParent().resolve("PROVISION.json")));
        assertThat(codecProvision.path("schemaVersion").asString()).isEqualTo("ghatana.media.test-codecs.v1");
        assertThat(codecProvision.path("release").asString()).isEqualTo("v8.1.2-27");
        assertThat(codecProvision.path("disposition").asString())
                .isEqualTo("DEVELOPMENT_TEST_ONLY_NOT_RUNTIME_OR_RELEASE");
        assertThat(codecProvision.path("archiveSha256").asString()).isEqualTo(expectedCodecArchiveDigest());
        assertThat(codecProvision.path("binarySha256").path("ffmpeg").asString()).isEqualTo(sha256(Files.readAllBytes(ffmpeg)));
        assertThat(codecProvision.path("binarySha256").path("ffprobe").asString()).isEqualTo(sha256(Files.readAllBytes(ffprobe)));

        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-recorder-" + run;
        String principal = "media-dev-owner-" + run;
        String bucket = "media-dev-recorder-" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-recorder-services-");
        Path recorderOutput = Files.createTempDirectory("media-dev-recorder-output-");
        Path log = Files.createTempFile("media-dev-recorder-process-", ".log");
        Process launcher = null;
        try {
            RecorderPreview preview = createRecorderPreview(repoRoot, recorderOutput, ffmpeg, ffprobe);
            byte[] previewBytes = Files.readAllBytes(preview.video());
            assertThat(sha256(previewBytes)).isEqualTo(preview.manifest().path("output").path("sha256").asString());
            assertThat(preview.manifest().path("kind").asString()).isEqualTo("LOCAL_PREVIEW_ONLY");
            assertThat(preview.manifest().path("source").path("kind").asString()).isEqualTo("SYNTHETIC_FIXTURE");
            assertThat(preview.manifest().path("output").path("contentType").asString()).isEqualTo("video/mp4");
            assertThat(preview.manifest().path("output").path("ffprobe").path("independentlyDecoded").asBoolean()).isTrue();
            assertThat(preview.manifest().path("output").path("ffprobe").path("videoFrames").asInt()).isEqualTo(30);
            assertThat(preview.manifest().path("output").path("ffprobe").path("subtitleTrackCount").asInt()).isEqualTo(1);

            try (S3Client s3 = s3()) {
                s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = environment(bucket, port);
            String token = issueDevToken(tenant, principal);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            // The same public Node SDK consumer used by the runnable example uploads
            // the actual muxed MP4; its mock contract test is not used here.
            JsonNode sdkRun = runHeadlessSdkExample(
                    tenant, principal, token, port, preview.video(), "video/mp4", null, null, null);
            JsonNode artifactSummary = sdkRun.path("artifact");
            String artifactId = artifactSummary.path("artifactId").asString();
            String requestId = sdkRun.path("job").path("requestId").asString();
            String jobId = sdkRun.path("job").path("jobId").asString();
            assertThat(artifactId).isNotBlank();
            assertThat(requestId).isNotBlank();
            assertThat(jobId).isNotBlank();
            assertThat(artifactSummary.path("contentType").asString()).isEqualTo("video/mp4");
            assertThat(artifactSummary.path("sizeBytes").asLong()).isEqualTo(previewBytes.length);
            assertThat(artifactSummary.path("sha256").asString()).isEqualTo(sha256(previewBytes));
            assertS3ArtifactBytes(bucket, artifactId, previewBytes, port, tenant, principal, token);

            JsonNode jobBeforeRestart = awaitDiagnosticJob(port, tenant, token, jobId, requestId);
            assertThat(jobBeforeRestart.path("artifactId").asString()).isEqualTo(artifactId);
            assertThat(jobBeforeRestart.path("requestId").asString()).isEqualTo(requestId);
            assertThat(jobBeforeRestart.path("result").path("diagnostic").asBoolean()).isTrue();
            assertThat(jobBeforeRestart.path("result").path("rawMediaRead").asBoolean()).isFalse();

            stopLauncher(launcher);
            launcher = null;
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            HttpResponse<String> artifactAfterRestart = send(port, tenant, token, "GET",
                    "/api/v1/artifacts/" + artifactId, "", "application/json", null);
            assertThat(artifactAfterRestart.statusCode()).as(artifactAfterRestart.body()).isEqualTo(200);
            JsonNode artifactReadback = JSON.readTree(artifactAfterRestart.body());
            assertThat(artifactReadback.path("tenantId").asString()).isEqualTo(tenant);
            assertThat(artifactReadback.path("principalId").asString()).isEqualTo(principal);
            assertThat(artifactReadback.path("sizeBytes").asLong()).isEqualTo(previewBytes.length);
            assertThat(artifactReadback.path("sha256").asString()).isEqualTo(sha256(previewBytes));
            assertS3ArtifactBytes(bucket, artifactId, previewBytes, port, tenant, principal, token);

            JsonNode jobAfterRestart = awaitDiagnosticJob(port, tenant, token, jobId, requestId);
            assertThat(jobAfterRestart.path("tenantId").asString()).isEqualTo(tenant);
            assertThat(jobAfterRestart.path("principalId").asString()).isEqualTo(principal);
            assertThat(jobAfterRestart.path("artifactId").asString()).isEqualTo(artifactId);
            assertThat(jobAfterRestart.path("requestId").asString()).isEqualTo(requestId);
            assertThat(jobAfterRestart.path("status").asString()).isEqualTo("COMPLETED");
            assertThat(jobAfterRestart.path("result")).isEqualTo(jobBeforeRestart.path("result"));
            assertThat(jobAfterRestart.path("result").path("rawMediaRead").asBoolean()).isFalse();
        } finally {
            try {
                if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            } finally {
                try { Files.deleteIfExists(log); }
                finally {
                    try { deleteBucket(bucket); }
                    finally {
                        deleteTree(services);
                        deleteTree(recorderOutput);
                    }
                }
            }
        }
    }

    private static String issueDevToken(String tenant, String principal) throws Exception {
        Path repoRoot = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (!Files.isRegularFile(repoRoot.resolve("scripts/media-dev-identity-token.mjs"))) {
            repoRoot = repoRoot.getParent();
            if (repoRoot == null) throw new AssertionError("Could not locate the Media DEV_ONLY token issuer");
        }
        List<String> permissions = new ArrayList<>(List.of(
                "media:artifact:create", "media:artifact:write", "media:artifact:read",
                "media:job:create", "media:job:read", "media:project:dev:read"));
        return mintDevToken(repoRoot, tenant, principal, permissions, 120);
    }

    private static String issueReadOnlyDevToken(String tenant, String principal, boolean jobRead) throws Exception {
        Path repoRoot = mediaRepoRoot();
        List<String> permissions = jobRead
                ? List.of("media:project:dev:read", "media:job:read")
                : List.of("media:project:dev:read");
        return mintDevToken(repoRoot, tenant, principal, permissions, 300);
    }

    private static String issueArtifactReadOnlyDevToken(String tenant, String principal) throws Exception {
        return mintDevToken(mediaRepoRoot(), tenant, principal, List.of("media:artifact:read"), 300);
    }

    private static String issueJobReadOnlyDevToken(String tenant, String principal) throws Exception {
        return mintDevToken(mediaRepoRoot(), tenant, principal, List.of("media:job:read"), 300);
    }

    private static void assertJobReadOnlyToken(String token, String tenant, String principal) throws Exception {
        String[] jwtParts = token.split("\\.");
        assertThat(jwtParts).hasSize(3);
        JsonNode claims = JSON.readTree(java.util.Base64.getUrlDecoder().decode(jwtParts[1]));
        assertThat(claims.path("tenant_id").asString()).isEqualTo(tenant);
        assertThat(claims.path("sub").asString()).isEqualTo(principal);
        assertThat(claims.path("permissions").valueStream().map(JsonNode::asString).toList())
                .containsExactly("media:job:read");
        assertThat(claims.path("exp").asLong() - claims.path("iat").asLong()).isEqualTo(300L);
    }

    private static void assertObservedDiagnosticJob(JsonNode job, String tenant, String principal,
            String artifactId, String jobId, String requestId) {
        assertThat(job.path("jobId").asString()).isEqualTo(jobId);
        assertThat(job.path("requestId").asString()).isEqualTo(requestId);
        assertThat(job.path("tenantId").asString()).isEqualTo(tenant);
        assertThat(job.path("principalId").asString()).isEqualTo(principal);
        assertThat(job.path("artifactId").asString()).isEqualTo(artifactId);
        assertThat(job.path("jobType").asString()).isEqualTo("TRANSCODE");
        assertThat(job.path("providerId").asString()).isEqualTo("local-diagnostic");
        assertThat(job.path("status").asString()).isEqualTo("COMPLETED");
        assertThat(job.path("version").isNumber()).isTrue();
        assertThat(job.path("version").asLong()).isPositive();
        assertThat(job.path("result").path("diagnostic").asBoolean()).isTrue();
        assertThat(job.path("result").path("rawMediaRead").asBoolean()).isFalse();
    }

    private static void assertRealHostCliJobGet(String tenant, String principal, String jobId,
            String requestId, int port, String token, JsonNode rawObservation) throws Exception {
        Path repoRoot = mediaRepoRoot();
        Path packageJson = repoRoot.resolve("libs/audio-video-client/package.json");
        JsonNode packageMetadata = JSON.readTree(Files.readString(packageJson));
        String entrypoint = packageMetadata.path("bin").path("ghatanamedia-api-dev").asString();
        assertThat(entrypoint).isEqualTo("./dist/cli-dev.js");
        Path cli = packageJson.getParent().resolve(entrypoint).normalize();
        assertThat(Files.isRegularFile(cli)).as("build @audio-video/client before running the DEV_ONLY integration test")
                .isTrue();

        Path stdoutCapture = Files.createTempFile("media-dev-job-get-stdout-", ".capture");
        Path stderrCapture = Files.createTempFile("media-dev-job-get-stderr-", ".capture");
        try {
            ProcessBuilder builder = new ProcessBuilder("node", cli.toString(), "job", "get",
                    "--endpoint", "http://127.0.0.1:" + port,
                    "--tenant", tenant,
                    "--principal", principal,
                    "--job", jobId,
                    "--request-id", requestId);
            builder.directory(repoRoot.toFile());
            builder.redirectOutput(stdoutCapture.toFile());
            builder.redirectError(stderrCapture.toFile());
            builder.environment().put("MEDIA_PROFILE", "dev");
            builder.environment().put("MEDIA_RUNTIME_ENVIRONMENT", "dev");
            builder.environment().put("GHATANA_MEDIA_REQUEST_TIMEOUT_MS", "10000");
            builder.environment().put("GHATANA_MEDIA_BEARER_TOKEN", token);
            Process cliProcess = builder.start();
            if (!cliProcess.waitFor(30, TimeUnit.SECONDS)) {
                cliProcess.destroyForcibly();
                assertThat(cliProcess.waitFor(10, TimeUnit.SECONDS)).isTrue();
                throw new AssertionError("Real-host DEV_ONLY CLI job get exceeded 30 seconds");
            }
            String stdout = Files.readString(stdoutCapture, StandardCharsets.UTF_8);
            String stderr = Files.readString(stderrCapture, StandardCharsets.UTF_8);
            if (stdout.contains(token) || stderr.contains(token)) {
                throw new AssertionError("Real-host DEV_ONLY CLI emitted credential material");
            }
            assertThat(cliProcess.exitValue()).as("CLI stdout: " + stdout.replace(token, "[REDACTED]")
                    + " stderr: " + stderr.replace(token, "[REDACTED]")).isZero();
            assertThat(stderr).isEmpty();
            String[] outputLines = stdout.strip().split("\\R");
            assertThat(outputLines).hasSize(1);
            JsonNode output = JSON.readTree(outputLines[0]);
            assertThat(output.isObject()).isTrue();
            assertThat(output.size()).isEqualTo(3);
            assertThat(output.path("schemaVersion").asString()).isEqualTo("media.cli-result.v1");
            assertThat(output.path("commandId").asString()).isEqualTo("media.cli.local-development.job.get");
            JsonNode job = output.path("job");
            assertThat(job.path("jobId").asString()).isEqualTo(jobId);
            assertThat(job.path("requestId").asString()).isEqualTo(requestId);
            assertThat(job.path("tenantId").asString()).isEqualTo(tenant);
            assertThat(job.path("principalId").asString()).isEqualTo(principal);
            assertThat(job.path("artifactId").asString()).isEqualTo(rawObservation.path("artifactId").asString());
            assertThat(job.path("jobType").asString()).isEqualTo("TRANSCODE");
            assertThat(job.path("providerId").asString()).isEqualTo("local-diagnostic");
            assertThat(job.path("status").asString()).isEqualTo("COMPLETED");
            assertThat(job.path("version").isNumber()).isTrue();
            assertThat(job.path("version")).isEqualTo(rawObservation.path("version"));
            assertThat(job.path("result")).isEqualTo(rawObservation.path("result"));
            assertThat(job.path("result").path("diagnostic").asBoolean()).isTrue();
            assertThat(job.path("result").path("rawMediaRead").asBoolean()).isFalse();
        } finally {
            Files.deleteIfExists(stdoutCapture);
            Files.deleteIfExists(stderrCapture);
        }
    }

    private static JsonNode runRealHostDevCliWithTrace(String tenant, String principal, int port, String token,
            List<String> commandArguments, Path preload, Path trace) throws Exception {
        Path repoRoot = mediaRepoRoot();
        Path packageJson = repoRoot.resolve("libs/audio-video-client/package.json");
        JsonNode packageMetadata = JSON.readTree(Files.readString(packageJson));
        String entrypoint = packageMetadata.path("bin").path("ghatanamedia-api-dev").asString();
        assertThat(entrypoint).isEqualTo("./dist/cli-dev.js");
        Path cli = packageJson.getParent().resolve(entrypoint).normalize();
        assertThat(Files.isRegularFile(cli)).as("build @audio-video/client before running the DEV_ONLY integration test")
                .isTrue();

        List<String> command = new ArrayList<>(List.of("node", "--import", preload.toString(), cli.toString(),
                commandArguments.get(0), commandArguments.get(1),
                "--endpoint", "http://127.0.0.1:" + port,
                "--tenant", tenant,
                "--principal", principal));
        command.addAll(commandArguments.subList(2, commandArguments.size()));
        Path stdoutCapture = Files.createTempFile("media-cli-resume-stdout-", ".capture");
        Path stderrCapture = Files.createTempFile("media-cli-resume-stderr-", ".capture");
        try {
            ProcessBuilder builder = new ProcessBuilder(command);
            builder.directory(repoRoot.toFile());
            builder.redirectOutput(stdoutCapture.toFile());
            builder.redirectError(stderrCapture.toFile());
            builder.environment().put("MEDIA_PROFILE", "dev");
            builder.environment().put("MEDIA_RUNTIME_ENVIRONMENT", "dev");
            builder.environment().put("GHATANA_MEDIA_REQUEST_TIMEOUT_MS", "10000");
            builder.environment().put("GHATANA_MEDIA_BEARER_TOKEN", token);
            builder.environment().put("MEDIA_CLI_UPLOAD_TRACE", trace.toString());
            Process cliProcess = builder.start();
            if (!cliProcess.waitFor(45, TimeUnit.SECONDS)) {
                cliProcess.destroyForcibly();
                assertThat(cliProcess.waitFor(10, TimeUnit.SECONDS)).isTrue();
                throw new AssertionError("Real-host DEV_ONLY CLI artifact upload exceeded 45 seconds");
            }
            String stdout = Files.readString(stdoutCapture, StandardCharsets.UTF_8);
            String stderr = Files.readString(stderrCapture, StandardCharsets.UTF_8);
            if (stdout.contains(token) || stderr.contains(token)) {
                throw new AssertionError("Real-host DEV_ONLY CLI emitted credential material");
            }
            assertThat(cliProcess.exitValue()).as("CLI stdout: " + stdout + " stderr: " + stderr).isZero();
            assertThat(stderr).isEmpty();
            String[] outputLines = stdout.strip().split("\\R");
            assertThat(outputLines).hasSize(1);
            JsonNode output = JSON.readTree(outputLines[0]);
            assertThat(output.path("schemaVersion").asString()).isEqualTo("media.cli-result.v1");
            assertThat(output.path("commandId").asString()).isEqualTo("media.cli.local-development.artifact.upload");
            assertThat(output.has("artifact")).isTrue();
            return output;
        } finally {
            Files.deleteIfExists(stdoutCapture);
            Files.deleteIfExists(stderrCapture);
        }
    }

    private static JsonNode runRealHostDevCli(String tenant, String principal, int port, String token,
            List<String> commandArguments, String expectedCommandId, String resultField) throws Exception {
        Path repoRoot = mediaRepoRoot();
        Path packageJson = repoRoot.resolve("libs/audio-video-client/package.json");
        JsonNode packageMetadata = JSON.readTree(Files.readString(packageJson));
        String entrypoint = packageMetadata.path("bin").path("ghatanamedia-api-dev").asString();
        assertThat(entrypoint).isEqualTo("./dist/cli-dev.js");
        Path cli = packageJson.getParent().resolve(entrypoint).normalize();
        assertThat(Files.isRegularFile(cli)).as("build @audio-video/client before running the DEV_ONLY integration test")
                .isTrue();

        List<String> command = new ArrayList<>(List.of("node", cli.toString(),
                commandArguments.get(0), commandArguments.get(1),
                "--endpoint", "http://127.0.0.1:" + port,
                "--tenant", tenant,
                "--principal", principal));
        command.addAll(commandArguments.subList(2, commandArguments.size()));
        Path stdoutCapture = Files.createTempFile("media-dev-cli-stdout-", ".capture");
        Path stderrCapture = Files.createTempFile("media-dev-cli-stderr-", ".capture");
        try {
            ProcessBuilder builder = new ProcessBuilder(command);
            builder.directory(repoRoot.toFile());
            builder.redirectOutput(stdoutCapture.toFile());
            builder.redirectError(stderrCapture.toFile());
            builder.environment().put("MEDIA_PROFILE", "dev");
            builder.environment().put("MEDIA_RUNTIME_ENVIRONMENT", "dev");
            builder.environment().put("GHATANA_MEDIA_REQUEST_TIMEOUT_MS", "10000");
            builder.environment().put("GHATANA_MEDIA_BEARER_TOKEN", token);
            Process cliProcess = builder.start();
            if (!cliProcess.waitFor(45, TimeUnit.SECONDS)) {
                cliProcess.destroyForcibly();
                assertThat(cliProcess.waitFor(10, TimeUnit.SECONDS)).isTrue();
                throw new AssertionError("Real-host DEV_ONLY CLI " + String.join(" ", commandArguments)
                        + " exceeded 45 seconds");
            }
            String stdout = Files.readString(stdoutCapture, StandardCharsets.UTF_8);
            String stderr = Files.readString(stderrCapture, StandardCharsets.UTF_8);
            if (stdout.contains(token) || stderr.contains(token)) {
                throw new AssertionError("Real-host DEV_ONLY CLI emitted credential material");
            }
            assertThat(cliProcess.exitValue()).as("CLI stdout: " + stdout
                    + " stderr: " + stderr).isZero();
            assertThat(stderr).isEmpty();
            String[] outputLines = stdout.strip().split("\\R");
            assertThat(outputLines).hasSize(1);
            JsonNode output = JSON.readTree(outputLines[0]);
            assertThat(output.isObject()).isTrue();
            assertThat(output.path("schemaVersion").asString()).isEqualTo("media.cli-result.v1");
            assertThat(output.path("commandId").asString()).isEqualTo(expectedCommandId);
            assertThat(output.has(resultField)).isTrue();
            return output;
        } finally {
            Files.deleteIfExists(stdoutCapture);
            Files.deleteIfExists(stderrCapture);
        }
    }

    private static String mintDevToken(Path repoRoot, String tenant, String principal,
            List<String> permissions, int expiresInSeconds) throws Exception {
        List<String> command = new ArrayList<>(List.of("node", "scripts/media-dev-identity-token.mjs",
                "--tenant", tenant, "--subject", principal,
                "--expires-in", Integer.toString(expiresInSeconds)));
        for (String permission : permissions) {
            command.add("--permission");
            command.add(permission);
        }
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.directory(repoRoot.toFile());
        builder.redirectErrorStream(true);
        builder.environment().put("MEDIA_PROFILE", "dev");
        builder.environment().put("MEDIA_RUNTIME_ENVIRONMENT", "dev");
        builder.environment().put("MEDIA_DEV_IDENTITY_ENABLED", "true");
        builder.environment().put("MEDIA_DEV_JWT_HMAC_SECRET", DEV_SECRET);
        Process issuer = builder.start();
        byte[] token = issuer.getInputStream().readAllBytes();
        if (!issuer.waitFor(10, TimeUnit.SECONDS)) {
            issuer.destroyForcibly();
            throw new AssertionError("DEV_ONLY issuer did not exit");
        }
        String output = new String(token, StandardCharsets.US_ASCII).trim();
        assertThat(issuer.exitValue()).as("DEV_ONLY issuer output: " + output).isZero();
        return output;
    }

    private static void runJobRecoveryBrowser(String tenant, String principal,
            int hostPort, JsonNode observedJob) throws Exception {
        Path repoRoot = mediaRepoRoot();
        String deniedToken = issueReadOnlyDevToken(tenant, principal, false);
        String otherOwner = "media-dev-other-owner-" + UUID.randomUUID().toString().replace("-", "");
        String otherOwnerToken = issueReadOnlyDevToken(tenant, otherOwner, true);
        String jobId = observedJob.path("jobId").asString();
        String status = observedJob.path("status").asString();
        String version = observedJob.path("version").asString();
        assertThat(jobId).isNotBlank();
        assertThat(status).isEqualTo("COMPLETED");
        assertThat(version).isNotBlank();
        String ownerToken = issueReadOnlyDevToken(tenant, principal, true);
        assertReadOnlyBrowserToken(ownerToken, tenant, principal, List.of("media:project:dev:read", "media:job:read"));
        assertReadOnlyBrowserToken(deniedToken, tenant, principal, List.of("media:project:dev:read"));
        assertReadOnlyBrowserToken(otherOwnerToken, tenant, otherOwner,
                List.of("media:project:dev:read", "media:job:read"));
        ProcessBuilder builder = new ProcessBuilder("node",
                "apps/media-experience-explorer/test/dev-job-recovery-live-browser.mjs");
        builder.directory(repoRoot.toFile());
        builder.redirectErrorStream(true);
        Map<String, String> environment = builder.environment();
        environment.put("MEDIA_DEV_JOB_RECOVERY_BROWSER_TOKEN", ownerToken);
        environment.put("MEDIA_DEV_JOB_RECOVERY_BROWSER_DENIED_TOKEN", deniedToken);
        environment.put("MEDIA_DEV_JOB_RECOVERY_BROWSER_OTHER_OWNER_TOKEN", otherOwnerToken);
        environment.put("MEDIA_DEV_JOB_RECOVERY_BROWSER_TENANT", tenant);
        environment.put("MEDIA_DEV_JOB_RECOVERY_BROWSER_PRINCIPAL", principal);
        environment.put("MEDIA_DEV_JOB_RECOVERY_BROWSER_JOB_ID", jobId);
        environment.put("MEDIA_DEV_JOB_RECOVERY_BROWSER_STATUS", status);
        environment.put("MEDIA_DEV_JOB_RECOVERY_BROWSER_VERSION", version);
        environment.put("MEDIA_DEV_JOB_RECOVERY_BROWSER_HOST_PORT", Integer.toString(hostPort));
        Process browser = builder.start();
        if (!browser.waitFor(120, TimeUnit.SECONDS)) {
            browser.destroyForcibly();
            assertThat(browser.waitFor(10, TimeUnit.SECONDS)).isTrue();
            throw new AssertionError("DEV_ONLY Job Recovery browser verification exceeded 120 seconds");
        }
        String output = new String(browser.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        assertThat(browser.exitValue()).as("Job Recovery browser output: " + output).isZero();
        assertThat(output).contains("\"result\":\"PASS\"")
                .contains("\"denied\":true")
                .contains("\"unknown\":true")
                .contains("\"mutationRequests\":0");
    }

    private static void assertReadOnlyBrowserToken(String token, String tenant, String principal,
            List<String> permissions) throws Exception {
        String[] jwtParts = token.split("\\.");
        assertThat(jwtParts).hasSize(3);
        JsonNode claims = JSON.readTree(java.util.Base64.getUrlDecoder().decode(jwtParts[1]));
        assertThat(claims.path("tenant_id").asString()).isEqualTo(tenant);
        assertThat(claims.path("sub").asString()).isEqualTo(principal);
        assertThat(claims.path("permissions").valueStream().map(JsonNode::asString).toList())
                .containsExactlyInAnyOrderElementsOf(permissions);
        assertThat(claims.path("exp").asLong() - claims.path("iat").asLong()).isEqualTo(300L);
    }

    private static JsonNode runHeadlessSdkExample(
            String tenant, String principal, String token, int port, Path input, String contentType,
            String uploadId, Integer chunkBytes, Integer maxChunksThisRun) throws Exception {
        SdkConsumerResult result = executeHeadlessSdkExample(
                tenant, principal, token, port, input, contentType, uploadId, chunkBytes, maxChunksThisRun, false);
        String reconciliation = result.exitCode() == 0 ? ""
                : reconcileUploadFromFailure(tenant, result.output());
        assertThat(result.exitCode()).as("Headless SDK consumer output: " + result.output() + reconciliation).isZero();
        return JSON.readTree(result.output());
    }

    private static String runHeadlessSdkExampleExpectingFailure(
            String tenant, String principal, String token, int port, Path input, String contentType,
            String uploadId, Integer chunkBytes) throws Exception {
        SdkConsumerResult result = executeHeadlessSdkExample(
                tenant, principal, token, port, input, contentType, uploadId, chunkBytes, null, true);
        assertThat(result.exitCode()).as("Headless SDK consumer output: " + result.output()).isNotZero();
        return result.output();
    }

    private record SdkConsumerResult(int exitCode, String output) { }

    private static SdkConsumerResult executeHeadlessSdkExample(
            String tenant, String principal, String token, int port, Path input, String contentType,
            String uploadId, Integer chunkBytes, Integer maxChunksThisRun, boolean traceHttp) throws Exception {
        Path repoRoot = mediaRepoRoot();
        Path packageLink = repoRoot.resolve("examples/media-headless-api/node_modules/@audio-video/client");
        assertThat(Files.exists(packageLink))
                .as("run pnpm install so the example resolves the workspace @audio-video/client package")
                .isTrue();
        assertThat(Files.isRegularFile(repoRoot.resolve("libs/audio-video-client/dist/operations.js")))
                .as("build @audio-video/client before running the DEV_ONLY integration test")
                .isTrue();

        ProcessBuilder builder = traceHttp
                ? new ProcessBuilder("node", "--input-type=module", "-e", SDK_HTTP_TRACE_WRAPPER)
                : new ProcessBuilder("node", "examples/media-headless-api/index.mjs");
        builder.directory(repoRoot.toFile());
        builder.redirectErrorStream(true);
        builder.environment().put("GHATANA_MEDIA_BASE_URL", "http://127.0.0.1:" + port);
        builder.environment().put("GHATANA_MEDIA_TENANT_ID", tenant);
        builder.environment().put("GHATANA_MEDIA_PRINCIPAL_ID", principal);
        builder.environment().put("GHATANA_MEDIA_BEARER_TOKEN", token);
        builder.environment().put("GHATANA_MEDIA_INPUT_FILE", input.toString());
        builder.environment().put("GHATANA_MEDIA_CONTENT_TYPE", contentType);
        if (uploadId != null) builder.environment().put("GHATANA_MEDIA_UPLOAD_ID", uploadId);
        if (chunkBytes != null) builder.environment().put("GHATANA_MEDIA_CHUNK_BYTES", chunkBytes.toString());
        if (maxChunksThisRun != null) builder.environment().put("GHATANA_MEDIA_MAX_CHUNKS_THIS_RUN", maxChunksThisRun.toString());
        Process child = builder.start();
        if (!child.waitFor(45, TimeUnit.SECONDS)) {
            child.destroyForcibly();
            assertThat(child.waitFor(10, TimeUnit.SECONDS)).isTrue();
            throw new AssertionError("Headless SDK consumer did not finish within 45 seconds");
        }
        String output = new String(child.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        return new SdkConsumerResult(child.exitValue(), output);
    }

    private static void assertUploadSessionAndChunks(String tenant, String uploadId, String expectedStatus,
            long expectedBytesReceived, int expectedNextChunkIndex, String expectedSha256,
            List<byte[]> expectedChunks) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                        POSTGRES.getPassword());
                var statement = connection.prepareStatement(
                        "SELECT status,bytes_received,next_chunk_index,expected_sha256,artifact_id "
                                + "FROM media_upload_sessions "
                                + "WHERE tenant_id=? AND upload_id=?")) {
            statement.setString(1, tenant);
            statement.setString(2, uploadId);
            try (var result = statement.executeQuery()) {
                assertThat(result.next()).as("durable upload session exists").isTrue();
                assertThat(result.getString("status")).isEqualTo(expectedStatus);
                assertThat(result.getLong("bytes_received")).isEqualTo(expectedBytesReceived);
                assertThat(result.getInt("next_chunk_index")).isEqualTo(expectedNextChunkIndex);
                assertThat(result.getString("expected_sha256")).isEqualTo(expectedSha256);
                if ("OPEN".equals(expectedStatus)) assertThat(result.getString("artifact_id")).isNull();
                assertThat(result.next()).isFalse();
            }
        }
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                        POSTGRES.getPassword());
                var statement = connection.prepareStatement(
                        "SELECT chunk_index,size_bytes,sha256 FROM media_upload_chunks "
                                + "WHERE tenant_id=? AND upload_id=? ORDER BY chunk_index")) {
            statement.setString(1, tenant);
            statement.setString(2, uploadId);
            try (var result = statement.executeQuery()) {
                for (int expectedIndex = 0; expectedIndex < expectedChunks.size(); expectedIndex++) {
                    assertThat(result.next()).as("persisted upload chunk %s exists", expectedIndex).isTrue();
                    byte[] expectedChunk = expectedChunks.get(expectedIndex);
                    assertThat(result.getInt("chunk_index")).isEqualTo(expectedIndex);
                    assertThat(result.getLong("size_bytes")).isEqualTo(expectedChunk.length);
                    assertThat(result.getString("sha256")).isEqualTo(sha256(expectedChunk));
                }
                assertThat(result.next()).as("no unacknowledged upload chunk is persisted").isFalse();
            }
        }
        if ("OPEN".equals(expectedStatus)) {
            try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                            POSTGRES.getPassword());
                    var statement = connection.prepareStatement(
                            "SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=? AND sha256=?")) {
                statement.setString(1, tenant);
                statement.setString(2, expectedSha256);
                try (var result = statement.executeQuery()) {
                    assertThat(result.next()).isTrue();
                    assertThat(result.getLong(1)).as("open upload has not produced an artifact").isZero();
                }
            }
        }
    }

    private static RecorderPreview createRecorderPreview(
            Path repoRoot, Path output, Path ffmpeg, Path ffprobe) throws Exception {
        ProcessBuilder builder = new ProcessBuilder("node", "examples/recorder-mux-preview/preview.mjs", output.toString());
        builder.directory(repoRoot.toFile());
        builder.redirectErrorStream(true);
        builder.environment().put("GHATANA_MEDIA_FFMPEG", ffmpeg.toString());
        builder.environment().put("GHATANA_MEDIA_FFPROBE", ffprobe.toString());
        Process child = builder.start();
        if (!child.waitFor(60, TimeUnit.SECONDS)) {
            child.destroyForcibly();
            assertThat(child.waitFor(10, TimeUnit.SECONDS)).isTrue();
            throw new AssertionError("Recorder mux preview did not finish within 60 seconds");
        }
        String outputText = new String(child.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        assertThat(child.exitValue()).as("Recorder mux preview output: " + outputText).isZero();
        Path manifestPath = output.resolve("preview-manifest.json");
        JsonNode manifest = JSON.readTree(Files.readString(manifestPath));
        Path video = output.resolve(manifest.path("output").path("file").asString());
        assertThat(Files.isRegularFile(video)).isTrue();
        return new RecorderPreview(video, manifest);
    }

    private static String expectedCodecArchiveDigest() {
        String os = System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT);
        String arch = System.getProperty("os.arch", "").toLowerCase(java.util.Locale.ROOT);
        if (os.contains("mac") && (arch.equals("aarch64") || arch.equals("arm64"))) {
            return "ac0babf65798bf681da1dc81c4fe4ae049d0d26e161410174b0e120e3e783332";
        }
        if (os.contains("linux") && (arch.equals("aarch64") || arch.equals("arm64"))) {
            return "ead92446d2d51015500843fa70a3ead35391898fe9850b7471c042f11d533586";
        }
        if (os.contains("linux") && (arch.equals("x86_64") || arch.equals("amd64"))) {
            return "233ba61cec5c7056698c963b67b2a4a04f1bfe67783948eb9f68b2ec9b0e2199";
        }
        throw new AssertionError("No source-pinned recorder codec profile for " + os + "/" + arch);
    }

    private static Path mediaRepoRoot() {
        Path repoRoot = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (!Files.isRegularFile(repoRoot.resolve("scripts/media-dev-identity-token.mjs"))) {
            repoRoot = repoRoot.getParent();
            if (repoRoot == null) throw new AssertionError("Could not locate the Media repository root");
        }
        return repoRoot;
    }

    private static void deleteTree(Path root) throws Exception {
        if (root != null && Files.exists(root)) try (var paths = Files.walk(root)) {
            paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                try { Files.deleteIfExists(path); } catch (Exception ignored) { }
            });
        }
    }

    private record RecorderPreview(Path video, JsonNode manifest) { }

    private static String reconcileUploadFromFailure(String tenant, String output) throws Exception {
        String marker = "/api/v1/artifacts/uploads/";
        int start = output.indexOf(marker);
        if (start < 0) return "";
        start += marker.length();
        int end = output.indexOf('/', start);
        if (end <= start || !output.startsWith("/complete", end)) return "";
        String uploadId = output.substring(start, end);
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword());
                var statement = connection.prepareStatement(
                        "SELECT status,bytes_received,expected_size_bytes,scan_status "
                                + "FROM media_upload_sessions WHERE tenant_id=? AND upload_id=?")) {
            statement.setString(1, tenant);
            statement.setString(2, uploadId);
            try (var result = statement.executeQuery()) {
                if (!result.next()) return "; upload reconciliation: no matching durable session";
                return "; upload reconciliation: status=" + result.getString("status")
                        + ", bytesReceived=" + result.getLong("bytes_received")
                        + ", expectedSizeBytes=" + result.getLong("expected_size_bytes")
                        + ", scanStatus=" + result.getString("scan_status");
            }
        }
    }

    private static void assertS3ArtifactBytes(
            String bucket, String artifactId, byte[] expected, int port,
            String tenant, String principal, String token) throws Exception {
        HttpResponse<String> observation = send(port, tenant, token, "GET",
                "/api/v1/artifacts/" + artifactId, "", "application/json", null);
        assertThat(observation.statusCode()).as(observation.body()).isEqualTo(200);
        JsonNode artifact = JSON.readTree(observation.body());
        assertThat(artifact.path("tenantId").asString()).isEqualTo(tenant);
        assertThat(artifact.path("principalId").asString()).isEqualTo(principal);
        assertThat(artifact.path("sizeBytes").asLong()).isEqualTo(expected.length);
        assertThat(artifact.path("sha256").asString()).isEqualTo(sha256(expected));
        String objectReference = artifact.path("objectReference").asString();
        String objectKey = URI.create(objectReference).getPath().substring(1);
        try (S3Client s3 = s3()) {
            byte[] storedBytes = s3.getObjectAsBytes(
                    GetObjectRequest.builder().bucket(bucket).key(objectKey).build()).asByteArray();
            assertThat(storedBytes).containsExactly(expected);
            assertThat(sha256(storedBytes)).isEqualTo(sha256(expected));
        }
    }

    private static Map<String, String> environment(String bucket, int port) {
        Map<String, String> env = new HashMap<>();
        env.put("MEDIA_RUNTIME_ENABLED", "true");
        env.put("MEDIA_RUNTIME_ENVIRONMENT", "dev");
        env.put("MEDIA_PROFILE", "dev");
        env.put("MEDIA_DEV_IDENTITY_ENABLED", "true");
        env.put("MEDIA_DEV_JWT_HMAC_SECRET", DEV_SECRET);
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
        return env;
    }

    private static void installDescriptors(Path root) throws Exception {
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
        else throw new IllegalArgumentException("Unsupported HTTP method " + method);
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static HttpResponse<String> sendBytes(int port, String tenant, String token, String method,
            String path, byte[] bytes) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .header("X-Tenant-Id", tenant).header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/octet-stream")
                .method(method, HttpRequest.BodyPublishers.ofByteArray(bytes)).build();
        return HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());
    }

    private static JsonNode awaitDiagnosticJob(int port, String tenant, String token,
            String jobId, String requestId) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (System.nanoTime() < deadline) {
            HttpResponse<String> response = send(port, tenant, token, "GET",
                    "/api/v1/jobs/" + jobId + "?requestId=" + requestId, "", "application/json", null);
            assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
            JsonNode job = JSON.readTree(response.body());
            if ("COMPLETED".equals(job.path("status").asString())) return job;
            assertThat(job.path("status").asString()).isIn("ACCEPTED", "RUNNING");
            Thread.sleep(100);
        }
        throw new AssertionError("Timed out waiting for diagnostic job readback");
    }

    private static S3Client s3() {
        return S3Client.builder().endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(
                        AwsBasicCredentials.create(LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build();
    }

    private static void stopLauncher(Process process) throws Exception {
        process.destroy();
        if (!process.waitFor(15, TimeUnit.SECONDS)) {
            process.destroyForcibly();
            assertThat(process.waitFor(10, TimeUnit.SECONDS)).isTrue();
        }
    }

    private static void deleteBucket(String bucket) {
        try (S3Client s3 = s3()) {
            var objects = s3.listObjectsV2(builder -> builder.bucket(bucket));
            objects.contents().forEach(object -> s3.deleteObject(builder -> builder.bucket(bucket).key(object.key())));
            s3.deleteBucket(builder -> builder.bucket(bucket));
        } catch (Exception ignored) { }
    }

    private static long countRows(String sql, String tenant, String artifactId) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                        POSTGRES.getPassword());
                var statement = connection.prepareStatement(sql)) {
            statement.setString(1, tenant);
            statement.setString(2, artifactId);
            try (var result = statement.executeQuery()) { result.next(); return result.getLong(1); }
        }
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static byte[] syntheticWav() {
        return syntheticWav(0);
    }

    private static byte[] syntheticWav(int sampleSeed) {
        byte[] bytes = new byte[320];
        putAscii(bytes, 0, "RIFF"); putInt(bytes, 4, bytes.length - 8); putAscii(bytes, 8, "WAVE");
        putAscii(bytes, 12, "fmt "); putInt(bytes, 16, 16); putShort(bytes, 20, 1);
        putShort(bytes, 22, 1); putInt(bytes, 24, 16000); putInt(bytes, 28, 32000);
        putShort(bytes, 32, 2); putShort(bytes, 34, 16); putAscii(bytes, 36, "data");
        putInt(bytes, 40, bytes.length - 44);
        for (int offset = 44; offset < bytes.length; offset += 2) putShort(bytes, offset, offset + sampleSeed);
        return bytes;
    }

    private static void putAscii(byte[] bytes, int offset, String value) {
        System.arraycopy(value.getBytes(StandardCharsets.US_ASCII), 0, bytes, offset, value.length());
    }
    private static void putInt(byte[] bytes, int offset, int value) {
        for (int index = 0; index < 4; index++) bytes[offset + index] = (byte) (value >>> (8 * index));
    }
    private static void putShort(byte[] bytes, int offset, int value) {
        bytes[offset] = (byte) value; bytes[offset + 1] = (byte) (value >>> 8);
    }
}
