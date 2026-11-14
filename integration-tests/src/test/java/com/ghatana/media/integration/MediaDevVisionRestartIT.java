package com.ghatana.media.integration;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import tools.jackson.databind.JsonNode;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import com.ghatana.media.integration.MediaDevLiveFixtures.StoredArtifact;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * DEV_ONLY local vision lane through a real launcher process with the durable PostgreSQL + S3 artifact store
 * (Testcontainers) and the real Florence-2 / Qwen2.5-VL models behind the real loopback sidecar: analyze and ask over
 * an exact uploaded image version, independent readback of the stored row and S3 bytes, restart, reopen with lineage,
 * and idempotent replay after the restart. Skipped with an explicit reason only when the model runtime is absent.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevVisionRestartIT {
    private static final String ANALYSES = "/dev/v1/vision/analyses";
    private static final String QUESTIONS = "/dev/v1/vision/questions";

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void analyzeAndAskRegisterDurablyBoundToTheExactVersionAndReopenAfterRestart() throws Exception {
        Path home = Path.of(System.getProperty("user.home"));
        Path models = Path.of(System.getenv().getOrDefault("MEDIA_LOCAL_VISION_MODELS_ROOT",
                home.resolve(".local/share/ghatana-media/models").toString()));
        Path python = Path.of(System.getenv().getOrDefault("MEDIA_LOCAL_VISION_PYTHON",
                home.resolve(".local/share/ghatana-media/runtimes/vision-venv/bin/python").toString()));
        Path script = locate("tools/model-runtimes/vision/vision_sidecar.py");
        Assumptions.assumeTrue(script != null && Files.isExecutable(python)
                        && Files.isRegularFile(models.resolve("florence-2-large/ghatana-model-manifest.json"))
                        && Files.isRegularFile(models.resolve("qwen2.5-vl-7b-instruct/ghatana-model-manifest.json")),
                "SKIPPED: local vision runtime or model manifests absent");

        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-vision-" + run;
        String principal = "media-dev-vision-" + run;
        String bucket = "media-dev-vision-" + run;
        String schema = "media_dev_vision_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        int sidecarPort;
        try (var socket = new java.net.ServerSocket(0)) { sidecarPort = socket.getLocalPort(); }
        byte[] tokenBytes = new byte[24];
        new SecureRandom().nextBytes(tokenBytes);
        String sidecarToken = HexFormat.of().formatHex(tokenBytes);
        Path services = Files.createTempDirectory("media-dev-vision-services-");
        Path log = Files.createTempFile("media-dev-vision-process-", ".log");
        Process sidecar = null;
        Process launcher = null;
        try {
            try (var s3 = s3(LOCALSTACK)) {
                s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            }
            ProcessBuilder sidecarBuilder = new ProcessBuilder(python.toString(), "-I", script.toString(), "--port",
                    Integer.toString(sidecarPort), "--models-root", models.toString());
            sidecarBuilder.redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD);
            sidecarBuilder.environment().clear();
            sidecarBuilder.environment().putAll(Map.of("GHATANA_VISION_SIDECAR_TOKEN", sidecarToken,
                    "HOME", home.toString(), "PATH", "/usr/bin:/bin"));
            sidecar = sidecarBuilder.start();
            awaitSidecar(sidecar, sidecarPort, sidecarToken);

            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = environment(POSTGRES, LOCALSTACK, bucket, port, schema);
            environment.put("MEDIA_LOCAL_VISION_MODELS_ROOT", models.toString());
            environment.put("MEDIA_LOCAL_VISION_SIDECAR_URL", "http://127.0.0.1:" + sidecarPort);
            environment.put("MEDIA_LOCAL_VISION_SIDECAR_TOKEN", sidecarToken);
            environment.put("MEDIA_LOCAL_VISION_TIMEOUT_SECONDS", "480");
            environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
            String token = issueDevToken(tenant, principal);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            byte[] png = scenePng();
            String sourceId = upload(port, tenant, principal, token, run + "-scene", "scene.png", "image/png", png);
            String version = "sha256:" + sha256(png);

            JsonNode status = get(port, tenant, token, "/dev/v1/vision/status", 200);
            assertThat(status.path("florence").path("state").asString()).isEqualTo("QUALIFIED");
            assertThat(status.path("qwen").path("state").asString()).isEqualTo("QUALIFIED");
            assertThat(status.path("rightsAuthority").path("ready").asBoolean()).isTrue();
            assertThat(status.path("rightsAuthority").path("productionReady").asBoolean()).isFalse();

            // ---- rights: without a real attestation for the exact version nothing is read or inferred ----
            Map<String, Object> analyzeBody = Map.of("requestId", "analysis-" + run, "artifactId", sourceId,
                    "artifactVersionId", version, "tasks", List.of("caption", "detect", "ocr"));
            HttpResponse<String> notYet = send(port, tenant, token, "POST", ANALYSES,
                    JSON.writeValueAsString(analyzeBody));
            assertThat(notYet.statusCode()).as(notYet.body()).isEqualTo(403);
            assertThat(notYet.body()).contains("RIGHTS_DENIED");
            // The uploader states PROCESSING rights for the exact version (a real attestation through the DEV rights
            // routes, given by this clearly synthetic TEST principal about a synthetic generated image).
            HttpResponse<String> attested = send(port, tenant, token, "POST", "/dev/v1/rights/attestations",
                    JSON.writeValueAsString(Map.of("artifactId", sourceId, "artifactVersionId", version,
                            "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                            "basis", "TEST: synthetic image generated by the integration test")));
            assertThat(attested.statusCode()).as(attested.body()).isEqualTo(201);
            String attestationId = JSON.readTree(attested.body()).path("attestationId").asString();

            // ---- analyze (Florence-2) ----
            JsonNode analysis = post(port, tenant, token, ANALYSES, analyzeBody, 201);
            assertThat(analysis.path("lineage").path("rightsDecision").path("attestationIds").get(0).asString())
                    .isEqualTo(attestationId);
            String analysisId = analysis.path("outputId").asString();
            assertThat(analysisId).isNotEqualTo(sourceId);
            assertThat(analysis.path("lineage").path("source").path("sha256").asString()).isEqualTo(sha256(png));
            StoredArtifact analysisRow = storedArtifact(POSTGRES, tenant, principal, analysisId);
            assertThat(analysisRow.contentType()).isEqualTo("application/json");
            assertThat(analysisRow.sha256()).isEqualTo(analysis.path("artifact").path("sha256").asString());
            byte[] analysisBytes = s3Bytes(LOCALSTACK, bucket, analysisRow);
            assertThat(sha256(analysisBytes)).isEqualTo(analysisRow.sha256());
            JsonNode analysisDocument = JSON.readTree(new String(analysisBytes, StandardCharsets.UTF_8));
            System.out.println("REAL-STORE-VISION-ANALYSIS " + new String(analysisBytes, StandardCharsets.UTF_8));
            assertThat(analysisDocument.path("inference").path("results").path("sceneText").path("fullText")
                    .asString().toUpperCase()).contains("GHATANA");
            assertThat(analysisDocument.path("inference").path("model").path("id").asString())
                    .isEqualTo("florence-community/Florence-2-large");
            // The source artifact is untouched.
            assertThat(s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, sourceId))).isEqualTo(png);

            // ---- ask (Qwen2.5-VL) ----
            Map<String, Object> askBody = Map.of("requestId", "question-" + run, "artifactId", sourceId,
                    "artifactVersionId", version, "question", "What color is the square on the left of the image?");
            JsonNode asked = post(port, tenant, token, QUESTIONS, askBody, 201);
            String askedId = asked.path("outputId").asString();
            StoredArtifact askedRow = storedArtifact(POSTGRES, tenant, principal, askedId);
            byte[] askedBytes = s3Bytes(LOCALSTACK, bucket, askedRow);
            System.out.println("REAL-STORE-VISION-QUESTION " + new String(askedBytes, StandardCharsets.UTF_8));
            assertThat(JSON.readTree(new String(askedBytes, StandardCharsets.UTF_8)).path("inference").path("answer")
                    .asString().toLowerCase()).contains("red");

            // ---- foreign principal cannot see or analyze the source ----
            String otherToken = issueDevToken(tenant, "someone-else-" + run);
            HttpResponse<String> foreign = send(port, tenant, otherToken, "POST", ANALYSES,
                    JSON.writeValueAsString(Map.of("requestId", "foreign-" + run, "artifactId", sourceId,
                            "artifactVersionId", version, "tasks", List.of("caption"))));
            assertThat(foreign.statusCode()).isEqualTo(404);
            assertThat(send(port, tenant, otherToken, "GET", "/dev/v1/vision/outputs/" + analysisId, null).statusCode())
                    .isEqualTo(404);

            // ---- revocation ends admission ----
            HttpResponse<String> revoked = send(port, tenant, token, "POST",
                    "/dev/v1/rights/attestations/" + attestationId + "/revoke",
                    JSON.writeValueAsString(Map.of("reason", "TEST: revoked to prove fail-closed")));
            assertThat(revoked.statusCode()).as(revoked.body()).isEqualTo(200);
            HttpResponse<String> afterRevoke = send(port, tenant, token, "POST", QUESTIONS, JSON.writeValueAsString(
                    Map.of("requestId", "after-revoke-" + run, "artifactId", sourceId, "artifactVersionId", version,
                            "question", "What is shown?")));
            assertThat(afterRevoke.statusCode()).as(afterRevoke.body()).isEqualTo(403);
            assertThat(afterRevoke.body()).contains("RIGHTS_REVOKED");
            // Re-attest (a new statement) so the replay below is admitted again after the restart.
            HttpResponse<String> reattested = send(port, tenant, token, "POST", "/dev/v1/rights/attestations",
                    JSON.writeValueAsString(Map.of("artifactId", sourceId, "artifactVersionId", version,
                            "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                            "basis", "TEST: synthetic image generated by the integration test (second statement)")));
            assertThat(reattested.statusCode()).as(reattested.body()).isEqualTo(201);

            // ---- restart the launcher; the sidecar and stores persist ----
            stopLauncher(launcher);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            token = issueDevToken(tenant, principal);

            JsonNode reopened = get(port, tenant, token, "/dev/v1/vision/outputs/" + analysisId, 200);
            assertThat(reopened.path("artifact").path("sha256").asString()).isEqualTo(analysisRow.sha256());
            assertThat(reopened.path("lineage").path("source").path("artifactVersionId").asString()).isEqualTo(version);
            assertThat(reopened.path("lineage").path("models").get(0).path("spdxLicense").asString()).isEqualTo("MIT");
            JsonNode reopenedQuestion = get(port, tenant, token, "/dev/v1/vision/outputs/" + askedId, 200);
            assertThat(reopenedQuestion.path("lineage").path("models").get(0).path("spdxLicense").asString())
                    .isEqualTo("Apache-2.0");

            // Replay after restart re-derives identical bytes: same artifact, replayed.
            JsonNode replay = post(port, tenant, token, ANALYSES, analyzeBody, 200);
            assertThat(replay.path("outputId").asString()).isEqualTo(analysisId);
            assertThat(replay.path("replayed").asBoolean()).isTrue();
        } finally {
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            if (sidecar != null) {
                sidecar.destroyForcibly();
                sidecar.waitFor(10, TimeUnit.SECONDS);
            }
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            deleteTree(services);
            Files.deleteIfExists(log);
        }
    }

    private static Path locate(String relative) {
        for (Path dir = Path.of("").toAbsolutePath(); dir != null; dir = dir.getParent()) {
            Path candidate = dir.resolve(relative);
            if (Files.isRegularFile(candidate)) return candidate;
        }
        return null;
    }

    private static void awaitSidecar(Process process, int port, String token) throws Exception {
        long deadline = System.nanoTime() + java.time.Duration.ofSeconds(120).toNanos();
        while (System.nanoTime() < deadline) {
            if (!process.isAlive()) throw new AssertionError("vision sidecar exited: " + process.exitValue());
            try {
                HttpResponse<String> response = HttpClient.newHttpClient().send(
                        HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/v1/health"))
                                .header("Authorization", "Bearer " + token).GET().build(),
                        HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() == 200) return;
            } catch (java.io.IOException ignored) { }
            Thread.sleep(250);
        }
        throw new AssertionError("vision sidecar did not become healthy");
    }

    /** Text and two shapes rendered with Java2D, so OCR and visual questions have something real to read. */
    private static byte[] scenePng() throws Exception {
        var image = new java.awt.image.BufferedImage(640, 480, java.awt.image.BufferedImage.TYPE_INT_RGB);
        var g = image.createGraphics();
        try {
            g.setColor(java.awt.Color.WHITE);
            g.fillRect(0, 0, 640, 480);
            g.setColor(new java.awt.Color(220, 30, 30));
            g.fillRect(40, 160, 240, 240);
            g.setColor(new java.awt.Color(30, 60, 220));
            g.fillOval(340, 180, 240, 240);
            g.setColor(java.awt.Color.BLACK);
            g.setFont(new java.awt.Font(java.awt.Font.SANS_SERIF, java.awt.Font.BOLD, 56));
            g.drawString("HELLO GHATANA", 60, 95);
        } finally {
            g.dispose();
        }
        var out = new java.io.ByteArrayOutputStream();
        javax.imageio.ImageIO.write(image, "png", out);
        return out.toByteArray();
    }
}
