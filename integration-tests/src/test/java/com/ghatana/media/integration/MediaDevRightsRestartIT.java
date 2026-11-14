package com.ghatana.media.integration;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import tools.jackson.databind.JsonNode;

import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.UUID;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * Rights and consent authority through one real launcher process with PostgreSQL + S3 and a real destination
 * directory: attestations survive a restart, delivery is refused without a confirmation, admitted after a DIFFERENT
 * principal confirms, and refused again after revocation (also across a restart). The principals are clearly
 * synthetic TEST principals; the statements prove the code path, not any real person's rights.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevRightsRestartIT {
    private static final String DESTINATION = "dev-local-directory";

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void attestationsSurviveRestartAndGateDeliveryThroughConfirmationAndRevocation() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-rights-" + run;
        String uploader = "test-principal-uploader-" + run;
        String reviewer = "test-principal-reviewer-" + run;
        String bucket = "media-dev-rights-" + run;
        String schema = "media_dev_rights_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-rights-services-");
        Path destination = Files.createTempDirectory("media-dev-rights-destination-").toRealPath();
        Path log = Files.createTempFile("media-dev-rights-process-", ".log");
        Process launcher = null;
        try {
            try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
            environment.put("MEDIA_DELIVERY_DEV_ENABLED", "true");
            environment.put("MEDIA_DELIVERY_DEV_DESTINATION_DIR", destination.toString());
            String uploaderToken = issueDevToken(tenant, uploader, "media:delivery:dev:export", "media:delivery:dev:read");
            String reviewerToken = issueDevToken(tenant, reviewer);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            byte[] content = noisePng();
            String artifactId = upload(port, tenant, uploader, uploaderToken, run, "rights-" + run + ".png",
                    "image/png", content);
            String versionId = "sha256:" + sha256(content);

            // Delivery without any statement is refused and writes nothing.
            String refusedRequest = "rights-none-" + run;
            HttpResponse<String> none = send(port, tenant, uploaderToken, "POST", "/dev/v1/exports",
                    exportBody(refusedRequest, artifactId, versionId));
            assertThat(none.statusCode()).as(none.body()).isEqualTo(403);
            assertThat(none.body()).contains("EXPORT_RIGHTS_NOT_ADMITTED").contains("NO_ATTESTATION");
            try (var files = Files.list(destination)) { assertThat(files.toList()).isEmpty(); }

            // The uploader states rights for the exact version.
            JsonNode attested = post(port, tenant, uploaderToken, "/dev/v1/rights/attestations", Map.of(
                    "artifactId", artifactId, "artifactVersionId", versionId, "statementKind", "MEDIA_RIGHTS",
                    "scopes", List.of("PROCESSING", "EXTERNAL_DELIVERY"),
                    "basis", "TEST: synthetic noise image generated by the test, no real person or rights"), 201);
            String attestationId = attested.path("attestationId").asString();
            assertThat(attested.path("attestingPrincipalId").asString()).isEqualTo(uploader);
            assertThat(attested.path("status").asString()).isEqualTo("PENDING_CONFIRMATION");
            assertThat(attested.path("contentSha256").asString()).isEqualTo(sha256(content));
            assertThat(attested.path("establishesApproval").asBoolean()).isFalse();

            // Restart: the attestation is durable, still unconfirmed, and delivery is still refused.
            stopLauncher(launcher);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            uploaderToken = issueDevToken(tenant, uploader, "media:delivery:dev:export", "media:delivery:dev:read");
            reviewerToken = issueDevToken(tenant, reviewer);
            JsonNode reopened = get(port, tenant, uploaderToken, "/dev/v1/rights/attestations/" + attestationId, 200);
            assertThat(reopened.path("status").asString()).isEqualTo("PENDING_CONFIRMATION");
            assertThat(reopened.path("basis").asString()).startsWith("TEST:");
            HttpResponse<String> pending = send(port, tenant, uploaderToken, "POST", "/dev/v1/exports",
                    exportBody(refusedRequest, artifactId, versionId));
            assertThat(pending.statusCode()).as(pending.body()).isEqualTo(403);
            assertThat(pending.body()).contains("NOT_CONFIRMED");

            // Self-confirmation is refused; a different principal confirms.
            HttpResponse<String> self = send(port, tenant, uploaderToken, "POST",
                    "/dev/v1/rights/attestations/" + attestationId + "/confirm", "{}");
            assertThat(self.statusCode()).as(self.body()).isEqualTo(403);
            assertThat(self.body()).contains("SELF_CONFIRMATION_REFUSED");
            JsonNode confirmed = post(port, tenant, reviewerToken,
                    "/dev/v1/rights/attestations/" + attestationId + "/confirm",
                    Map.of("note", "TEST reviewer confirmation"), 200);
            assertThat(confirmed.path("status").asString()).isEqualTo("CONFIRMED");
            assertThat(confirmed.path("confirmation").path("confirmingPrincipalId").asString()).isEqualTo(reviewer);
            JsonNode listing = get(port, tenant, uploaderToken, "/dev/v1/rights/artifacts/" + artifactId
                    + "/versions/" + versionId + "/attestations", 200);
            assertThat(listing.path("attestations")).hasSize(1);
            assertThat(listing.path("admission").path("EXTERNAL_DELIVERY").path("verdict").asString()).isEqualTo("ADMITTED");
            assertThat(listing.path("admission").path("VOICE_OR_LIKENESS_USE").path("verdict").asString()).isEqualTo("DENIED");

            // Restart again: the confirmation is durable and delivery is admitted for these exact bytes.
            stopLauncher(launcher);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            uploaderToken = issueDevToken(tenant, uploader, "media:delivery:dev:export", "media:delivery:dev:read");
            reviewerToken = issueDevToken(tenant, reviewer);
            HttpResponse<String> admitted = send(port, tenant, uploaderToken, "POST", "/dev/v1/exports",
                    exportBody("rights-ok-" + run, artifactId, versionId));
            assertThat(admitted.statusCode()).as(admitted.body()).isEqualTo(201);
            assertThat(admitted.body()).contains("DESTINATION_CONFIRMED");
            try (var files = Files.list(destination)) {
                var written = files.toList();
                assertThat(written).hasSize(1);
                assertThat(Files.readAllBytes(written.get(0))).isEqualTo(content);
            }

            // Revocation by the attester ends admission; a new delivery is refused (also after a restart).
            JsonNode revoked = post(port, tenant, uploaderToken,
                    "/dev/v1/rights/attestations/" + attestationId + "/revoke",
                    Map.of("reason", "TEST: statement withdrawn"), 200);
            assertThat(revoked.path("status").asString()).isEqualTo("REVOKED");
            assertThat(revoked.path("revocation").path("revokedByPrincipalId").asString()).isEqualTo(uploader);
            HttpResponse<String> afterRevoke = send(port, tenant, uploaderToken, "POST", "/dev/v1/exports",
                    exportBody("rights-after-" + run, artifactId, versionId));
            assertThat(afterRevoke.statusCode()).as(afterRevoke.body()).isEqualTo(403);
            assertThat(afterRevoke.body()).contains("EXPORT_RIGHTS_NOT_ADMITTED").contains("REVOKED");
            stopLauncher(launcher);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            uploaderToken = issueDevToken(tenant, uploader, "media:delivery:dev:export", "media:delivery:dev:read");
            HttpResponse<String> afterRestart = send(port, tenant, uploaderToken, "POST", "/dev/v1/exports",
                    exportBody("rights-after-restart-" + run, artifactId, versionId));
            assertThat(afterRestart.statusCode()).as(afterRestart.body()).isEqualTo(403);
            assertThat(afterRestart.body()).contains("REVOKED");
            try (var files = Files.list(destination)) { assertThat(files.toList()).hasSize(1); }

            // Independent database readback: one attestation row, one confirmation, one revocation, all attributed.
            try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                    POSTGRES.getPassword());
                 var statement = connection.prepareStatement("""
                         SELECT a.attesting_principal_id, e.event_kind, e.principal_id
                           FROM media_rights_attestations a
                           JOIN media_rights_attestation_events e
                             ON e.tenant_id = a.tenant_id AND e.attestation_id = a.attestation_id
                          WHERE a.tenant_id = ? AND a.attestation_id = ? ORDER BY e.event_kind""")) {
                statement.setString(1, tenant);
                statement.setString(2, attestationId);
                try (var rows = statement.executeQuery()) {
                    assertThat(rows.next()).isTrue();
                    assertThat(rows.getString(1)).isEqualTo(uploader);
                    assertThat(rows.getString(2)).isEqualTo("CONFIRMED");
                    assertThat(rows.getString(3)).isEqualTo(reviewer);
                    assertThat(rows.next()).isTrue();
                    assertThat(rows.getString(2)).isEqualTo("REVOKED");
                    assertThat(rows.getString(3)).isEqualTo(uploader);
                    assertThat(rows.next()).isFalse();
                }
            }
        } finally {
            if (launcher != null) stopLauncher(launcher);
            deleteBucket(LOCALSTACK, bucket);
            dropSchema(POSTGRES, schema);
            deleteTree(services);
            deleteTree(destination);
        }
    }

    private static byte[] noisePng() throws Exception {
        var image = new java.awt.image.BufferedImage(200, 150, java.awt.image.BufferedImage.TYPE_INT_RGB);
        Random random = new Random(7);
        for (int y = 0; y < 150; y++) for (int x = 0; x < 200; x++) image.setRGB(x, y, random.nextInt(0x1000000));
        var out = new java.io.ByteArrayOutputStream();
        javax.imageio.ImageIO.write(image, "png", out);
        return out.toByteArray();
    }

    private static String exportBody(String requestId, String artifactId, String versionId) throws Exception {
        return JSON.writeValueAsString(Map.of("requestId", requestId, "artifactId", artifactId,
                "artifactVersionId", versionId, "destinationId", DESTINATION));
    }
}
