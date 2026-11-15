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

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.DriverManager;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-10 {@code media.dev.outcome-reference-continuity} against REAL processes: the real launcher with the durable
 * PostgreSQL + S3 artifact store and request ledger (Testcontainers). No FFmpeg and no model are involved: the positive
 * path is the authored template composed by the verified animation renderer; the MODEL path is a typed unavailability.
 *
 * <p>Stored PNG bytes are read back from S3 and measured independently of the launcher: the placed rectangle carries
 * the reference's own colours (untinted hero) or the requested recolour direction (tinted logo gradient), the decoded
 * pixel digest equals the manifest's, and the stored PNG minus its request tag equals the canonical PNG. Fault suite:
 * missing and revoked rights (new run, replay and regeneration), reference outside the set, invalid parameters with the
 * JSON path, wrong tenant, continuity threshold failure with nothing registered, request-id reuse, MODEL mode with
 * zero artifacts, and a launcher kill -9 with replay, regeneration and determinism across the restart.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevReferenceSceneIT {
    private static final String SETS = "/dev/v1/reference-scenes/reference-sets";
    private static final String RUNS = "/dev/v1/reference-scenes/runs";

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void realLauncherComposesRightsCheckedReferenceScenesMeasuresContinuityAndSurvivesTheFaultSuite() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-refscene-" + run;
        String otherTenant = "tenant-dev-refscene-other-" + run;
        String principal = "media-dev-refscene-" + run;
        String otherPrincipal = "media-dev-refscene-other-" + run;
        String bucket = "media-dev-refscene-" + run.substring(0, 12);
        String schema = "media_dev_refscene_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-refscene-services-");
        Path log = Files.createTempFile("media-dev-refscene-process-", ".log");
        Process launcher = null;
        boolean passed = false;
        try {
            try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            String token = issueDevToken(tenant, principal);
            String otherToken = issueDevToken(otherTenant, otherPrincipal);

            JsonNode status = get(port, tenant, token, "/dev/v1/reference-scenes/status", 200);
            assertThat(status.path("ready").asBoolean()).isTrue();
            assertThat(status.path("model").path("available").asBoolean()).isFalse();
            assertThat(status.path("model").path("fallback").asString()).isEqualTo("NONE");
            assertThat(status.path("templates")).hasSize(2);

            // ---- inputs: hero (two flat colours), logo (gradient) and a stranger; hero and logo are attested later ----
            byte[] heroBytes = twoColourPng(48, 64, 0xFFFFD000, 0xFF2060FF);
            byte[] logoBytes = gradientPng(64, 64);
            byte[] strangerBytes = twoColourPng(40, 40, 0xFF00FF00, 0xFF000000);
            String heroId = upload(port, tenant, principal, token, run + "-hero", "hero.png", "image/png", heroBytes);
            String logoId = upload(port, tenant, principal, token, run + "-logo", "logo.png", "image/png", logoBytes);
            String strangerId = upload(port, tenant, principal, token, run + "-stranger", "stranger.png", "image/png", strangerBytes);
            String heroVersion = "sha256:" + sha256(heroBytes);
            String logoVersion = "sha256:" + sha256(logoBytes);
            String strangerVersion = "sha256:" + sha256(strangerBytes);

            // ---- MODEL mode: typed unavailability, zero artifacts, no template fallback ----
            Map<String, Object> modelBody = new LinkedHashMap<>();
            modelBody.put("requestId", "model-" + run);
            modelBody.put("mode", "MODEL");
            modelBody.put("seed", 7);
            modelBody.put("prompt", "a hero walks through a neon city");
            HttpResponse<String> model = send(port, tenant, token, "POST", RUNS, JSON.writeValueAsString(modelBody));
            assertThat(model.statusCode()).as(model.body()).isEqualTo(503);
            JsonNode modelError = JSON.readTree(model.body()).path("error");
            assertThat(modelError.path("code").asString()).isEqualTo("MODEL_UNAVAILABLE");
            assertThat(modelError.path("details").path("artifactsCreated").asInt()).isZero();
            assertThat(modelError.path("details").path("fallback").asString()).isEqualTo("NONE");
            assertThat(outputs(tenant, principal)).as("MODEL mode registered nothing").isZero();

            // ---- rights: no statement is a typed 403 and nothing is registered ----
            Map<String, Object> setBody = setBody("set-" + run, List.of(
                    Map.of("referenceId", "hero", "artifactId", heroId, "artifactVersionId", heroVersion),
                    Map.of("referenceId", "logo", "artifactId", logoId, "artifactVersionId", logoVersion)));
            HttpResponse<String> noRights = send(port, tenant, token, "POST", SETS, JSON.writeValueAsString(setBody));
            assertThat(noRights.statusCode()).as(noRights.body()).isEqualTo(403);
            JsonNode noRightsError = JSON.readTree(noRights.body()).path("error");
            assertThat(noRightsError.path("code").asString()).isEqualTo("RIGHTS_NOT_ADMITTED");
            assertThat(noRightsError.path("details").path("verdict").asString()).isEqualTo("DENIED");
            assertThat(noRightsError.path("details").path("path").asString()).isEqualTo("$.references[0]");
            assertThat(outputs(tenant, principal)).isZero();

            String heroAttestation = attest(port, tenant, token, heroId, heroVersion, "hero");
            String logoAttestation = attest(port, tenant, token, logoId, logoVersion, "logo");
            // The stranger has no statement: a set that includes it is refused as a whole.
            Map<String, Object> mixed = setBody("set-mixed-" + run, List.of(
                    Map.of("referenceId", "hero", "artifactId", heroId, "artifactVersionId", heroVersion),
                    Map.of("referenceId", "stranger", "artifactId", strangerId, "artifactVersionId", strangerVersion)));
            HttpResponse<String> mixedResponse = send(port, tenant, token, "POST", SETS, JSON.writeValueAsString(mixed));
            assertThat(mixedResponse.statusCode()).isEqualTo(403);
            assertThat(JSON.readTree(mixedResponse.body()).path("error").path("details").path("path").asString())
                    .isEqualTo("$.references[1]");
            assertThat(outputs(tenant, principal)).isZero();
            // Another tenant cannot see the artifact at all.
            assertThat(send(port, otherTenant, otherToken, "POST", SETS, JSON.writeValueAsString(setBody("set-foreign-" + run,
                    List.of(Map.of("referenceId", "hero", "artifactId", heroId, "artifactVersionId", heroVersion))))).statusCode())
                    .isEqualTo(404);

            JsonNode set = post(port, tenant, token, SETS, setBody, 201);
            String setId = set.path("referenceSetId").asString();
            assertThat(set.path("document").path("references")).hasSize(2);
            assertThat(set.path("document").path("references").path(0).path("rights").path("attestationIds").path(0).asString())
                    .isEqualTo(heroAttestation);
            assertThat(outputs(tenant, principal)).as("one stored set").isEqualTo(1);
            assertThat(post(port, tenant, token, SETS, setBody, 200).path("referenceSetId").asString()).isEqualTo(setId);
            assertThat(send(port, tenant, token, "POST", SETS, JSON.writeValueAsString(setBody("set-" + run, List.of(
                    Map.of("referenceId", "hero", "artifactId", heroId, "artifactVersionId", heroVersion))))).statusCode()).isEqualTo(409);
            get(port, tenant, token, SETS + "/" + setId, 200);
            get(port, otherTenant, otherToken, SETS + "/" + setId, 404);

            // ---- faults before any render: nothing is registered ----
            int base = outputs(tenant, principal);
            Map<String, String> invalid = new LinkedHashMap<>();
            invalid.put("$.parameters.palette[0]", stage("bad-1-" + run, setId, 20260101, 3, 0.1, p -> palette(p).set(0, "red"), r -> { }));
            invalid.put("$.parameters.slots[0].height", stage("bad-2-" + run, setId, 20260101, 3, 0.1, p -> slot(p, 0).put("height", 1.5), r -> { }));
            invalid.put("$.sceneCount", stage("bad-3-" + run, setId, 20260101, 3, 0.1, p -> { }, r -> r.put("sceneCount", 0)));
            invalid.put("$.template.id", stage("bad-4-" + run, setId, 20260101, 3, 0.1, p -> { }, r -> ((Map<String, Object>) r.get("template")).put("id", "movie")));
            invalid.put("$.parameters.slots[1].x", stage("bad-5-" + run, setId, 20260101, 3, 0.1, p -> slot(p, 1).put("x", 0.35), r -> { }));
            for (Map.Entry<String, String> entry : invalid.entrySet()) {
                HttpResponse<String> response = send(port, tenant, token, "POST", RUNS, entry.getValue());
                assertThat(response.statusCode()).as(entry.getKey() + " " + response.body()).isEqualTo(422);
                JsonNode error = JSON.readTree(response.body()).path("error");
                assertThat(error.path("code").asString()).isEqualTo("REFERENCE_SCENE_SPEC_INVALID");
                assertThat(error.path("details").path("path").asString()).isEqualTo(entry.getKey());
            }
            HttpResponse<String> outsider = send(port, tenant, token, "POST", RUNS,
                    stage("out-" + run, setId, 20260101, 3, 0.1, p -> slot(p, 1).put("referenceId", "stranger"), r -> { }));
            assertThat(outsider.statusCode()).isEqualTo(422);
            JsonNode outsiderError = JSON.readTree(outsider.body()).path("error");
            assertThat(outsiderError.path("code").asString()).isEqualTo("REFERENCE_NOT_IN_SET");
            assertThat(outsiderError.path("details").path("path").asString()).isEqualTo("$.parameters.slots[1].referenceId");
            assertThat(send(port, otherTenant, otherToken, "POST", RUNS, stage("alien-" + run, setId, 20260101, 3, 0.1, p -> { }, r -> { }))
                    .statusCode()).as("wrong tenant cannot use the set").isEqualTo(404);
            assertThat(outputs(tenant, principal)).isEqualTo(base);

            // ---- the run ----
            long started = System.nanoTime();
            JsonNode created = postNode(port, tenant, token, RUNS, JSON.readTree(
                    stage("run-" + run, setId, 20260101, 3, 0.1, p -> { }, r -> { })), 201);
            long millis = (System.nanoTime() - started) / 1_000_000;
            assertThat(created.path("outcome").asString()).isEqualTo("CONTINUITY_PASSED");
            assertThat(created.path("replayed").asBoolean()).isFalse();
            String runId = created.path("runId").asString();
            JsonNode manifest = created.path("manifest");
            assertThat(manifest.path("generator").path("generativeModelUsed").asBoolean()).isFalse();
            assertThat(manifest.path("generator").path("kind").asString()).isEqualTo("AUTHORED_TEMPLATE");
            assertThat(manifest.path("generator").path("seed").asLong()).isEqualTo(20260101L);
            assertThat(manifest.path("references")).hasSize(2);
            assertThat(manifest.path("references").path(0).path("rights").path("verdict").asString()).isEqualTo("ADMITTED");
            assertThat(created.path("scenes")).hasSize(3);
            assertThat(outputs(tenant, principal)).as("set + 3 scenes + manifest").isEqualTo(base + 4);

            List<String> canonical = new ArrayList<>();
            List<String> pixels = new ArrayList<>();
            double[] meanBlueShift = new double[3];
            for (int i = 0; i < 3; i++) {
                JsonNode artifact = created.path("scenes").path(i);
                JsonNode scene = manifest.path("scenes").path(i);
                // Independent verification of the STORED bytes from S3.
                byte[] png = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, artifact.path("artifactId").asString()));
                assertThat(sha256(png)).isEqualTo(artifact.path("sha256").asString());
                BufferedImage image = ImageIO.read(new ByteArrayInputStream(png));
                assertThat(image.getWidth()).isEqualTo(320);
                assertThat(image.getHeight()).isEqualTo(180);
                assertThat(pixelDigest(image)).as("decoded pixels equal the manifest's digest").isEqualTo(scene.path("pixelSha256").asString());
                assertThat(sha256(untag(png))).as("stored PNG minus its request tag is the canonical PNG")
                        .isEqualTo(scene.path("canonicalPngSha256").asString());
                canonical.add(scene.path("canonicalPngSha256").asString());
                pixels.add(scene.path("pixelSha256").asString());

                // The hero's placed rectangle carries the reference's own two colours and nothing else.
                JsonNode heroRect = scene.path("metrics").path("slots").path(0).path("rect");
                int hx = heroRect.path("x").asInt();
                int hy = heroRect.path("y").asInt();
                int hw = heroRect.path("width").asInt();
                int hh = heroRect.path("height").asInt();
                assertThat((double) hw / hh).as("aspect ratio of the reference is preserved").isCloseTo(48.0 / 64.0, org.assertj.core.data.Offset.offset(0.03));
                int yellow = 0;
                int blue = 0;
                for (int y = hy; y < hy + hh; y++) {
                    for (int x = hx; x < hx + hw; x++) {
                        int rgb = image.getRGB(x, y) & 0xFFFFFF;
                        if (rgb == 0xFFD000) yellow++;
                        else if (rgb == 0x2060FF) blue++;
                    }
                }
                assertThat(yellow + blue).as("every pixel of the hero rectangle is one of the reference's colours, except at most one area-averaged seam column")
                        .isGreaterThanOrEqualTo(hw * hh - hh);
                assertThat((double) yellow / (hw * hh)).isBetween(0.45, 0.55);
                assertThat(scene.path("metrics").path("slots").path(0).path("histogramDistance").asDouble()).isZero();
                assertThat(scene.path("metrics").path("slots").path(0).path("ssim").asDouble()).isEqualTo(1.0);

                // The logo's rectangle is the gradient shifted toward the requested recolour (#38BDF8): blue rises.
                JsonNode logoRect = scene.path("metrics").path("slots").path(1).path("rect");
                double blueSum = 0;
                int count = 0;
                for (int y = logoRect.path("y").asInt(); y < logoRect.path("y").asInt() + logoRect.path("height").asInt(); y++) {
                    for (int x = logoRect.path("x").asInt(); x < logoRect.path("x").asInt() + logoRect.path("width").asInt(); x++) {
                        blueSum += image.getRGB(x, y) & 0xFF;
                        count++;
                    }
                }
                meanBlueShift[i] = blueSum / count - 0x80; // the reference's blue channel is a constant 0x80
                assertThat(meanBlueShift[i]).as("scene " + i + " logo recoloured toward #38BDF8").isGreaterThan(5.0);
                assertThat(scene.path("metrics").path("slots").path(1).path("histogramDistance").asDouble()).isBetween(0.0001, 0.35);
                assertThat(scene.path("metrics").path("paletteAdherence").asDouble()).isEqualTo(1.0);
            }
            assertThat(canonical).doesNotHaveDuplicates();
            assertThat(manifest.path("scenes").path(1).path("metrics").path("slots").path(0).path("crossScene")
                    .path("histogramDistance").asDouble()).isLessThanOrEqualTo(0.30);

            // ---- reproduction: regeneration is byte-identical and registers nothing ----
            JsonNode proof = post(port, tenant, token, RUNS + "/" + runId + "/regenerations", Map.of(), 200);
            assertThat(proof.path("byteIdentical").asBoolean()).isTrue();
            assertThat(proof.path("artifactsCreated").asInt()).isZero();
            for (JsonNode comparison : proof.path("scenes")) {
                assertThat(comparison.path("storedBytesMatch").asBoolean()).isTrue();
                assertThat(comparison.path("metricsMatch").asBoolean()).isTrue();
            }
            assertThat(outputs(tenant, principal)).isEqualTo(base + 4);
            // The same request under a new id has identical canonical bytes; a new seed has different ones.
            JsonNode twin = postNode(port, tenant, token, RUNS, JSON.readTree(
                    stage("twin-" + run, setId, 20260101, 3, 0.1, p -> { }, r -> { })), 201);
            for (int i = 0; i < 3; i++) {
                assertThat(twin.path("manifest").path("scenes").path(i).path("canonicalPngSha256").asString()).isEqualTo(canonical.get(i));
                assertThat(twin.path("manifest").path("scenes").path(i).path("pixelSha256").asString()).isEqualTo(pixels.get(i));
            }
            JsonNode reseeded = postNode(port, tenant, token, RUNS, JSON.readTree(
                    stage("seed-" + run, setId, 7, 3, 0.1, p -> { }, r -> { })), 201);
            assertThat(reseeded.path("manifest").path("scenes").path(1).path("canonicalPngSha256").asString()).isNotEqualTo(canonical.get(1));

            // ---- ledger: replay, changed body under the same id, wrong tenant ----
            JsonNode replay = postNode(port, tenant, token, RUNS, JSON.readTree(
                    stage("run-" + run, setId, 20260101, 3, 0.1, p -> { }, r -> { })), 200);
            assertThat(replay.path("replayed").asBoolean()).isTrue();
            assertThat(replay.path("runId").asString()).isEqualTo(runId);
            HttpResponse<String> reused = send(port, tenant, token, "POST", RUNS,
                    stage("run-" + run, setId, 20260102, 3, 0.1, p -> { }, r -> { }));
            assertThat(reused.statusCode()).isEqualTo(409);
            assertThat(JSON.readTree(reused.body()).path("error").path("code").asString()).isEqualTo("REFERENCE_SCENE_REQUEST_ID_REUSED");
            get(port, tenant, token, RUNS + "/" + runId, 200);
            get(port, otherTenant, otherToken, RUNS + "/" + runId, 404);
            assertThat(send(port, otherTenant, otherToken, "POST", RUNS + "/" + runId + "/regenerations", "{}").statusCode()).isEqualTo(404);

            // ---- continuity threshold failure: typed, with the failing metrics, nothing registered ----
            int beforeStrict = outputs(tenant, principal);
            HttpResponse<String> strict = send(port, tenant, token, "POST", RUNS,
                    stage("strict-" + run, setId, 20260101, 3, 0.1, p -> { }, r -> r.put("continuity", Map.of("maxHistogramDistance", 0.0001))));
            assertThat(strict.statusCode()).as(strict.body()).isEqualTo(422);
            JsonNode strictError = JSON.readTree(strict.body()).path("error");
            assertThat(strictError.path("code").asString()).isEqualTo("CONTINUITY_THRESHOLD_FAILED");
            assertThat(strictError.path("details").path("artifactsCreated").asInt()).isZero();
            assertThat(strictError.path("details").path("violations").path(0).path("metric").asString()).isEqualTo("histogramDistance");
            HttpResponse<String> recoloured = send(port, tenant, token, "POST", RUNS,
                    stage("recolour-" + run, setId, 20260101, 3, 1.0, p -> slot(p, 1).put("tint", Map.of("color", "#00FF00", "strength", 1.0)), r -> { }));
            assertThat(JSON.readTree(recoloured.body()).path("error").path("code").asString()).isEqualTo("CONTINUITY_THRESHOLD_FAILED");
            assertThat(outputs(tenant, principal)).as("a continuity failure registers nothing").isEqualTo(beforeStrict);

            // ---- launcher kill -9 and restart: replay, regeneration and determinism across processes ----
            launcher.destroyForcibly();
            assertThat(launcher.waitFor(30, TimeUnit.SECONDS)).isTrue();
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            token = issueDevToken(tenant, principal);
            otherToken = issueDevToken(otherTenant, otherPrincipal);
            JsonNode afterRestart = postNode(port, tenant, token, RUNS, JSON.readTree(
                    stage("run-" + run, setId, 20260101, 3, 0.1, p -> { }, r -> { })), 200);
            assertThat(afterRestart.path("runId").asString()).isEqualTo(runId);
            assertThat(post(port, tenant, token, RUNS + "/" + runId + "/regenerations", Map.of(), 200).path("byteIdentical").asBoolean()).isTrue();
            JsonNode crossProcess = postNode(port, tenant, token, RUNS, JSON.readTree(
                    stage("post-restart-" + run, setId, 20260101, 3, 0.1, p -> { }, r -> { })), 201);
            for (int i = 0; i < 3; i++) {
                assertThat(crossProcess.path("manifest").path("scenes").path(i).path("canonicalPngSha256").asString()).isEqualTo(canonical.get(i));
            }

            // ---- revoked rights: a NEW run, a REPLAY and a regeneration are refused; nothing is registered ----
            int beforeRevoke = outputs(tenant, principal);
            post(port, tenant, token, "/dev/v1/rights/attestations/" + logoAttestation + "/revoke",
                    Map.of("reason", "TEST: revoked to prove fail-closed"), 200);
            HttpResponse<String> revokedNew = send(port, tenant, token, "POST", RUNS,
                    stage("after-revoke-" + run, setId, 20260101, 3, 0.1, p -> { }, r -> { }));
            assertThat(revokedNew.statusCode()).as(revokedNew.body()).isEqualTo(403);
            JsonNode revokedError = JSON.readTree(revokedNew.body()).path("error");
            assertThat(revokedError.path("code").asString()).isEqualTo("RIGHTS_NOT_ADMITTED");
            assertThat(revokedError.path("details").path("verdict").asString()).isEqualTo("REVOKED");
            assertThat(revokedError.path("details").path("artifactId").asString()).isEqualTo(logoId);
            assertThat(send(port, tenant, token, "POST", RUNS, stage("run-" + run, setId, 20260101, 3, 0.1, p -> { }, r -> { }))
                    .statusCode()).as("replay re-checks rights").isEqualTo(403);
            assertThat(send(port, tenant, token, "POST", RUNS + "/" + runId + "/regenerations", "{}").statusCode()).isEqualTo(403);
            assertThat(outputs(tenant, principal)).isEqualTo(beforeRevoke);
            // The stored run stays readable (it is the audit record); a run that never uses the logo still works.
            get(port, tenant, token, RUNS + "/" + runId, 200);
            JsonNode spotlight = postNode(port, tenant, token, RUNS, JSON.readTree(spotlight("spot-" + run, setId)), 201);
            assertThat(spotlight.path("scenes")).hasSize(2);
            assertThat(spotlight.path("manifest").path("references")).hasSize(1);
            System.out.println("J-10 reference scene IT: first 3-scene run in " + millis + " ms; canonical=" + canonical
                    + " blueShift=" + java.util.Arrays.toString(meanBlueShift));
            passed = true;
        } finally {
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("J-10 reference scene IT failure log retained at " + log);
            deleteTree(services);
        }
    }

    // ---- request builders ----

    private static Map<String, Object> setBody(String requestId, List<Map<String, Object>> references) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("name", "J-10 IT set");
        body.put("references", references);
        return body;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> palette(Map<String, Object> parameters) { return (List<Object>) parameters.get("palette"); }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> slot(Map<String, Object> parameters, int index) {
        return (Map<String, Object>) ((List<Object>) parameters.get("slots")).get(index);
    }

    private static String stage(String requestId, String setId, long seed, int scenes, double logoTint,
                                java.util.function.Consumer<Map<String, Object>> parameterChange,
                                java.util.function.Consumer<Map<String, Object>> requestChange) throws Exception {
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("requestId", requestId);
        request.put("mode", "TEMPLATE");
        request.put("referenceSetId", setId);
        request.put("template", new LinkedHashMap<>(Map.of("id", "reference-stage", "version", 1)));
        request.put("seed", seed);
        request.put("sceneCount", scenes);
        Map<String, Object> parameters = new LinkedHashMap<>();
        parameters.put("palette", new ArrayList<>(List.of("#101828", "#1E293B", "#38BDF8")));
        parameters.put("slots", new ArrayList<>(List.of(
                new LinkedHashMap<>(Map.of("referenceId", "hero", "x", 0.3, "height", 0.55)),
                new LinkedHashMap<>(Map.of("referenceId", "logo", "x", 0.75, "height", 0.3,
                        "tint", new LinkedHashMap<>(Map.of("color", "#38BDF8", "strength", logoTint)))))));
        parameters.put("drift", 4);
        parameters.put("push", new LinkedHashMap<>(Map.of("start", 0.9, "end", 1.2)));
        parameters.put("sparkles", 20);
        request.put("parameters", parameters);
        parameterChange.accept(parameters);
        requestChange.accept(request);
        return JSON.writeValueAsString(request);
    }

    private static String spotlight(String requestId, String setId) throws Exception {
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("requestId", requestId);
        request.put("mode", "TEMPLATE");
        request.put("referenceSetId", setId);
        request.put("template", new LinkedHashMap<>(Map.of("id", "product-spotlight", "version", 1)));
        request.put("seed", 11);
        request.put("sceneCount", 2);
        request.put("parameters", new LinkedHashMap<>(Map.of("palette", List.of("#101828", "#334155", "#FACC15"),
                "subject", new LinkedHashMap<>(Map.of("referenceId", "hero", "height", 0.5)), "sparkles", 12)));
        return JSON.writeValueAsString(request);
    }

    private static JsonNode postNode(int port, String tenant, String token, String path, JsonNode body, int status) throws Exception {
        HttpResponse<String> response = send(port, tenant, token, "POST", path, JSON.writeValueAsString(body));
        assertThat(response.statusCode()).as(path + " -> " + response.body()).isEqualTo(status);
        return JSON.readTree(response.body());
    }

    private static String attest(int port, String tenant, String token, String artifactId, String version, String label) throws Exception {
        JsonNode attested = post(port, tenant, token, "/dev/v1/rights/attestations", Map.of("artifactId", artifactId,
                "artifactVersionId", version, "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                "basis", "TEST: " + label + " is a synthetic image generated inside an automated test; a statement by a "
                        + "synthetic test principal, not a legal determination"), 201);
        return attested.path("attestationId").asString();
    }

    // ---- images and measurement ----

    private static byte[] twoColourPng(int width, int height, int left, int right) throws Exception {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) image.setRGB(x, y, x < width / 2 ? left : right);
        }
        return encode(image);
    }

    private static byte[] gradientPng(int width, int height) throws Exception {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                image.setRGB(x, y, 0xFF000000 | ((x * 255 / (width - 1)) << 16) | ((y * 255 / (height - 1)) << 8) | 0x80);
            }
        }
        return encode(image);
    }

    private static byte[] encode(BufferedImage image) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(image, "png", out);
        return out.toByteArray();
    }

    private static String pixelDigest(BufferedImage image) throws Exception {
        int[] argb = image.getRGB(0, 0, image.getWidth(), image.getHeight(), null, 0, image.getWidth());
        ByteBuffer buffer = ByteBuffer.allocate(argb.length * 4);
        for (int value : argb) buffer.putInt(value);
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(buffer.array()));
    }

    /** Removes the tEXt chunk(s) with the media.reference-scene keyword, by an independent chunk walk. */
    private static byte[] untag(byte[] png) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(png, 0, 8);
        int offset = 8;
        while (offset + 12 <= png.length) {
            int length = ByteBuffer.wrap(png, offset, 4).getInt();
            String type = new String(png, offset + 4, 4, StandardCharsets.ISO_8859_1);
            String data = "tEXt".equals(type) ? new String(png, offset + 8, Math.min(length, 22), StandardCharsets.ISO_8859_1) : "";
            if (!(type.equals("tEXt") && data.startsWith("media.reference-scene\0"))) out.write(png, offset, 12 + length);
            offset += 12 + length;
        }
        return out.toByteArray();
    }

    /** Durable output rows (set, scene and manifest artifacts) of the principal, by lineage kind in the metadata. */
    private static int outputs(String tenant, String principal) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement("SELECT count(*) FROM media_artifacts WHERE tenant_id=? AND principal_id=? "
                     + "AND (metadata_json LIKE '%REFERENCE_SET%' OR metadata_json LIKE '%REFERENCE_SCENE_PNG%' "
                     + "OR metadata_json LIKE '%REFERENCE_SCENE_MANIFEST%')")) {
            statement.setString(1, tenant);
            statement.setString(2, principal);
            try (var row = statement.executeQuery()) {
                row.next();
                return row.getInt(1);
            }
        }
    }
}
