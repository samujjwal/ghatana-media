package com.ghatana.media.integration;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Map;
import java.util.UUID;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * DEV_ONLY exact-byte artifact content read through a real launcher with the durable PostgreSQL + S3 artifact store:
 * after a process restart the stored object is read in full and with Range requests, byte-for-byte equal to the
 * independently read S3 object, with the version pin, ceiling and header contract enforced.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevArtifactContentRangeRestartIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void readsFullAndRangedBytesFromS3AfterRestart() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-content-" + run;
        String principal = "media-dev-content-" + run;
        String bucket = "media-dev-content-" + run;
        String schema = "media_dev_content_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-content-services-");
        Path log = Files.createTempFile("media-dev-content-process-", ".log");
        Process launcher = null;
        try {
            try (S3Client s3 = s3(LOCALSTACK)) {
                s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = new java.util.HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.put("MEDIA_DEV_ARTIFACT_CONTENT_MAX_BYTES", "65536");
            String token = issueDevToken(tenant, principal);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            byte[] png = solidPng(0xff336699);
            byte[] blob = new byte[200_000];
            for (int i = 12; i < blob.length; i++) blob[i] = (byte) ((i * 31) ^ (i >>> 8));
            // Minimal GLB container header (magic, version 2, total length) so the intake signature check admits it.
            java.nio.ByteBuffer.wrap(blob).order(java.nio.ByteOrder.LITTLE_ENDIAN)
                    .put("glTF".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putInt(2).putInt(blob.length);
            String pngId = upload(port, tenant, principal, token, run + "-png", "pic.png", "image/png", png);
            String blobId = upload(port, tenant, principal, token, run + "-blob", "scene.glb",
                    "model/gltf-binary", blob);
            String pngVersion = "sha256:" + sha256(png);
            String blobVersion = "sha256:" + sha256(blob);

            stopLauncher(launcher);
            launcher = null;
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            token = issueDevToken(tenant, principal);

            // Small object: full read equals the bytes independently read from S3.
            byte[] s3Png = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, pngId));
            HttpResponse<byte[]> full = read(port, tenant, token, pngId, pngVersion, null);
            assertThat(full.statusCode()).isEqualTo(200);
            assertThat(full.body()).isEqualTo(png).isEqualTo(s3Png);
            assertThat(full.headers().firstValue("Content-Type")).contains("image/png");
            assertThat(full.headers().firstValue("Content-Disposition")).contains("inline");
            assertThat(full.headers().firstValue("X-Content-Type-Options")).contains("nosniff");
            assertThat(full.headers().firstValue("Cache-Control")).contains("private, no-store");
            assertThat(full.headers().firstValue("ETag")).contains("\"" + pngVersion + "\"");

            // Large object: full read refused above the configured ceiling, ranges succeed byte-exactly.
            byte[] s3Blob = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, blobId));
            assertThat(s3Blob).isEqualTo(blob);
            HttpResponse<byte[]> refused = read(port, tenant, token, blobId, blobVersion, null);
            assertThat(refused.statusCode()).isEqualTo(413);
            HttpResponse<byte[]> mid = read(port, tenant, token, blobId, blobVersion, "bytes=100000-100999");
            assertThat(mid.statusCode()).isEqualTo(206);
            assertThat(mid.body()).isEqualTo(Arrays.copyOfRange(blob, 100_000, 101_000));
            assertThat(mid.headers().firstValue("Content-Range")).contains("bytes 100000-100999/200000");
            assertThat(mid.headers().firstValue("Accept-Ranges")).contains("bytes");
            assertThat(mid.headers().firstValue("Content-Disposition").orElseThrow()).startsWith("attachment");
            HttpResponse<byte[]> tail = read(port, tenant, token, blobId, blobVersion, "bytes=150000-");
            assertThat(tail.statusCode()).as("tail 50000 bytes is within the ceiling").isEqualTo(206);
            assertThat(tail.body()).isEqualTo(Arrays.copyOfRange(blob, 150_000, 200_000));
            HttpResponse<byte[]> lastByte = read(port, tenant, token, blobId, blobVersion, "bytes=199999-199999");
            assertThat(lastByte.body()).containsExactly(blob[199_999]);
            assertThat(read(port, tenant, token, blobId, blobVersion, "bytes=200000-").statusCode()).isEqualTo(416);
            assertThat(read(port, tenant, token, blobId, blobVersion, "bytes=0-199999").statusCode()).isEqualTo(413);

            // Version pin and ownership.
            assertThat(read(port, tenant, token, blobId, "sha256:" + "0".repeat(64), "bytes=0-9").statusCode())
                    .isEqualTo(412);
            String other = issueDevToken(tenant, principal + "-other");
            assertThat(read(port, tenant, other, blobId, blobVersion, "bytes=0-9").statusCode()).isEqualTo(404);
        } finally {
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            Files.deleteIfExists(log);
            deleteTree(services);
        }
    }

    private static HttpResponse<byte[]> read(int port, String tenant, String token, String artifactId, String version,
                                             String range) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port
                        + "/dev/v1/artifacts/" + artifactId + "/content?version=" + version))
                .header("Authorization", "Bearer " + token).header("X-Tenant-Id", tenant);
        if (range != null) request.header("Range", range);
        return HttpClient.newHttpClient().send(request.GET().build(), HttpResponse.BodyHandlers.ofByteArray());
    }
}
