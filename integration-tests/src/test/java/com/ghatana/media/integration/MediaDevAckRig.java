package com.ghatana.media.integration;

import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import tools.jackson.databind.JsonNode;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.DriverManager;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.UUID;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * J-22 test rig: a real launcher process (PostgreSQL ledger, LocalStack S3 artifact storage) wired to one independent
 * {@link LocalAckReceiver}. Test principals are synthetic. The "confirmer" is a different principal than the owner, as
 * the rights authority requires; it is a test identity, never a real approval.
 */
final class MediaDevAckRig implements AutoCloseable {
    static final String RECEIVER_IDENTITY = "j22-local-ack-receiver";
    static final String DEST = "dev-http-receiver";
    static final int PART = 1024 * 1024;

    final PostgreSQLContainer<?> postgres;
    final LocalStackContainer localstack;
    final String run = UUID.randomUUID().toString().replace("-", "").substring(0, 16);
    final String tenant = "tenant-dev-j22-" + run;
    final String otherTenant = "tenant-dev-j22-other-" + run;
    final String owner = "test-principal-owner-" + run;
    final String confirmer = "test-principal-confirmer-" + run;
    final String bucket = "media-dev-j22-" + run;
    final String schema = "media_dev_j22_" + run;
    final int port;
    final LocalAckReceiver receiver;
    final Path services;
    final Path log;
    final String classpath;
    final Map<String, String> environment;
    Process launcher;

    record Artifact(String artifactId, String versionId, byte[] bytes) { }

    MediaDevAckRig(PostgreSQLContainer<?> postgres, LocalStackContainer localstack, String dispatchLeaseMs) throws Exception {
        this.postgres = postgres;
        this.localstack = localstack;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        receiver = new LocalAckReceiver(RECEIVER_IDENTITY, "upload-credential-" + run, "ack-signing-key-" + run + "-0123456789");
        services = Files.createTempDirectory("media-dev-j22-services-");
        log = Files.createTempFile("media-dev-j22-process-", ".log");
        try (var s3 = s3(localstack)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
        installDescriptors(services);
        String child = System.getProperty("media.child.classpath", "");
        assertThat(child).as("Gradle-resolved child runtime classpath").isNotBlank();
        classpath = services + java.io.File.pathSeparator + child;
        environment = new HashMap<>(environment(postgres, localstack, bucket, port, schema));
        environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
        environment.put("MEDIA_DELIVERY_DEV_ENABLED", "true");
        environment.put("MEDIA_DELIVERY_DEV_DISPATCH_LEASE_MS", dispatchLeaseMs);
        environment.put("MEDIA_DELIVERY_DEV_RECEIVER_URL", receiver.url());
        environment.put("MEDIA_DELIVERY_DEV_RECEIVER_IDENTITY", RECEIVER_IDENTITY);
        environment.put("MEDIA_DELIVERY_DEV_RECEIVER_CREDENTIAL_REFERENCE", "secret:env:MEDIA_J22_RECEIVER_CREDENTIAL");
        environment.put("MEDIA_J22_RECEIVER_CREDENTIAL", receiver.credential());
        environment.put("MEDIA_DELIVERY_DEV_RECEIVER_ACK_KEY_REFERENCE", "secret:env:MEDIA_J22_RECEIVER_ACK_KEY");
        environment.put("MEDIA_J22_RECEIVER_ACK_KEY", receiver.ackKey());
        environment.put("MEDIA_DELIVERY_DEV_RECEIVER_TENANTS", tenant);
        environment.put("MEDIA_DELIVERY_DEV_RECEIVER_TIMEOUT_MS", "15000");
    }

    void start() throws Exception {
        launcher = startLauncher(classpath, environment, log);
        awaitReady(launcher, port);
    }

    /** Hard kill (no shutdown hooks), as a crash would. */
    void kill() throws Exception {
        launcher.destroyForcibly();
        assertThat(launcher.waitFor(15, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
    }

    void restart() throws Exception {
        if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
        start();
    }

    String ownerToken() throws Exception { return token(tenant, owner); }

    String token(String forTenant, String principal) throws Exception {
        return issueDevToken(forTenant, principal, "media:delivery:dev:export", "media:delivery:dev:read");
    }

    /** A token that can read artifacts and exports but holds no delivery export permission. */
    String readOnlyToken() throws Exception { return issueDevToken(tenant, owner, "media:delivery:dev:read"); }

    /** Noise PNG of roughly {@code width*height*3} bytes (incompressible), uploaded in 256 KiB chunks. */
    Artifact artifact(String label, int width, int height, boolean attested) throws Exception {
        var image = new java.awt.image.BufferedImage(width, height, java.awt.image.BufferedImage.TYPE_INT_RGB);
        Random random = new Random(label.hashCode() ^ 0x5eed);
        for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) image.setRGB(x, y, random.nextInt(0x1000000));
        var out = new java.io.ByteArrayOutputStream();
        javax.imageio.ImageIO.write(image, "png", out);
        byte[] bytes = out.toByteArray();
        String token = ownerToken();
        String artifactId = uploadChunked(token, label, bytes);
        String versionId = "sha256:" + sha256(bytes);
        if (attested) attest(artifactId, versionId);
        return new Artifact(artifactId, versionId, bytes);
    }

    String attest(String artifactId, String versionId) throws Exception {
        String attestationId = JSON.readTree(send(port, tenant, ownerToken(), "POST", "/dev/v1/rights/attestations",
                JSON.writeValueAsString(Map.of("artifactId", artifactId, "artifactVersionId", versionId,
                        "statementKind", "MEDIA_RIGHTS", "scopes", List.of("EXTERNAL_DELIVERY"),
                        "basis", "TEST: synthetic noise image generated by the test"))).body()).path("attestationId").asString();
        assertThat(attestationId).isNotBlank();
        HttpResponse<String> confirmed = send(port, tenant, token(tenant, confirmer),
                "POST", "/dev/v1/rights/attestations/" + attestationId + "/confirm", "{}");
        assertThat(confirmed.statusCode()).as(confirmed.body()).isEqualTo(200);
        return attestationId;
    }

    void revokeAttestation(String attestationId) throws Exception {
        post(port, tenant, ownerToken(), "/dev/v1/rights/attestations/" + attestationId + "/revoke",
                Map.of("reason", "TEST: statement withdrawn"), 200);
    }

    private String uploadChunked(String token, String label, byte[] bytes) throws Exception {
        int chunk = 256 * 1024;
        Map<String, Object> body = Map.of("tenantId", tenant, "principalId", owner, "fileName", label + ".png",
                "contentType", "image/png", "expectedSizeBytes", bytes.length, "expectedSha256", sha256(bytes),
                "classification", "INTERNAL", "retention", "P30D",
                "metadata", Map.of("scope", "DEV_ONLY", "fixture", "synthetic-j22-source"));
        HttpResponse<String> begun = HttpClient.newHttpClient().send(HttpRequest.newBuilder(
                        URI.create("http://127.0.0.1:" + port + "/api/v1/artifacts/uploads"))
                .header("Authorization", "Bearer " + token).header("X-Tenant-Id", tenant)
                .header("Idempotency-Key", "j22-source-" + run + "-" + label).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body), StandardCharsets.UTF_8)).build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(begun.statusCode()).as(begun.body()).isEqualTo(201);
        JsonNode begunBody = JSON.readTree(begun.body());
        String uploadId = begunBody.path("uploadId").asString();
        for (int index = 0, offset = 0; offset < bytes.length; index++, offset += chunk) {
            byte[] part = java.util.Arrays.copyOfRange(bytes, offset, Math.min(bytes.length, offset + chunk));
            HttpResponse<String> sent = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create(
                            "http://127.0.0.1:" + port + "/api/v1/artifacts/uploads/" + uploadId + "/chunks/" + index))
                    .header("Authorization", "Bearer " + token).header("X-Tenant-Id", tenant)
                    .header("Content-Type", "application/octet-stream")
                    .PUT(HttpRequest.BodyPublishers.ofByteArray(part)).build(), HttpResponse.BodyHandlers.ofString());
            assertThat(sent.statusCode()).as("chunk " + index + ": " + sent.body()).isEqualTo(200);
        }
        HttpResponse<String> completed = send(port, tenant, token, "POST",
                "/api/v1/artifacts/uploads/" + uploadId + "/complete", "");
        assertThat(completed.statusCode()).as(completed.body()).isEqualTo(201);
        return JSON.readTree(completed.body()).path("artifactId").asString();
    }

    String exportBody(String requestId, Artifact artifact, String destination) throws Exception {
        return JSON.writeValueAsString(Map.of("requestId", requestId, "artifactId", artifact.artifactId(),
                "artifactVersionId", artifact.versionId(), "destinationId", destination));
    }

    HttpResponse<String> export(String requestId, Artifact artifact) throws Exception {
        return send(port, tenant, ownerToken(), "POST", "/dev/v1/exports", exportBody(requestId, artifact, DEST));
    }

    HttpResponse<String> reconcile(String requestId, boolean resume) throws Exception {
        return send(port, tenant, ownerToken(), "POST", "/dev/v1/exports/" + requestId + "/reconcile",
                "{\"resume\":" + resume + "}");
    }

    JsonNode read(String requestId) throws Exception {
        return get(port, tenant, ownerToken(), "/dev/v1/exports/" + requestId, 200);
    }

    String objectKey(String requestId) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(
                    (tenant + "\u0000" + owner + "\u0000" + requestId).getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException failure) { throw new IllegalStateException(failure); }
    }

    String ledgerStatus(String requestId) throws Exception {
        try (var connection = DriverManager.getConnection(postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT status, acknowledged_bytes FROM media_delivery_operations WHERE tenant_id=? AND request_id=?")) {
            statement.setString(1, tenant); statement.setString(2, requestId);
            try (var rows = statement.executeQuery()) {
                assertThat(rows.next()).as("delivery ledger row for " + requestId).isTrue();
                return rows.getString(1) + ":" + rows.getInt(2);
            }
        }
    }

    long ledgerRows(String requestId) throws Exception {
        try (var connection = DriverManager.getConnection(postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
             var statement = connection.prepareStatement("SELECT count(*) FROM media_delivery_operations WHERE request_id=?")) {
            statement.setString(1, requestId);
            try (var rows = statement.executeQuery()) { rows.next(); return rows.getLong(1); }
        }
    }

    @Override public void close() {
        try { if (launcher != null && launcher.isAlive()) stopLauncher(launcher); } catch (Exception ignored) { }
        receiver.close();
        deleteBucket(localstack, bucket);
        dropSchema(postgres, schema);
        deleteTree(services);
    }
}
