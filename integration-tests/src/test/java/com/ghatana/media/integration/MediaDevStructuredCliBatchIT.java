package com.ghatana.media.integration;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
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
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
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
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;

import static com.ghatana.media.integration.MediaLauncherProcessFixtures.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-24 {@code media.dev.outcome-structured-command-batch}: the BUILT DEV_ONLY CLI binary
 * ({@code libs/audio-video-client/dist/cli-dev.js}, run as a separate node process, no sources, no ts-node)
 * executes JSON command batches against a real launcher process (PostgreSQL + S3 + a real destination
 * directory) with a DEV identity token. Covers: a genuine terminal result (upload, job to COMPLETED, export
 * to destination-confirmed), a schema error that has no effect, forbidden operations (token scope), an
 * unanswered request (CLI timeout) that is UNKNOWN with a resumable handle, a launcher killed mid-batch, and
 * a re-run of the same batch that converges without duplicate effects. The only test-owned component in the
 * path is a loopback TCP-level HTTP forwarder that stalls or cuts a real response; it never answers for the
 * launcher.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevStructuredCliBatchIT {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String DEV_SECRET = "media-dev-structured-cli-batch-secret";
    private static final List<String> FULL = List.of("media:job:create", "media:job:read", "media:artifact:create",
            "media:artifact:write", "media:artifact:read", "media:delivery:dev:export", "media:delivery:dev:read",
            "media:project:dev:read", "media:project:dev:write");

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void builtCliBatchHasTrueFinalityTypedFailuresAndConvergesAcrossLauncherKill() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "").substring(0, 16);
        String tenant = "tenant-dev-cli-batch-" + run;
        String principal = "media-dev-cli-owner-" + run;
        String bucket = "media-dev-cli-batch-" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path work = Files.createTempDirectory("media-dev-cli-batch-");
        Path services = work.resolve("services");
        Path destination = Files.createDirectory(work.resolve("destination")).toRealPath();
        Path log = work.resolve("launcher.log");
        Path source = work.resolve("source.png");
        byte[] content = noisePng();
        Files.write(source, content);
        String digest = sha256(content);
        Process[] launcher = new Process[1];
        Forwarder forwarder = null;
        try {
            try (S3Client s3 = s3()) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = environment(bucket, port, destination);
            launcher[0] = startLauncher(classpath, environment, log);
            awaitReady(launcher[0], port);
            forwarder = new Forwarder(port);
            int cliPort = forwarder.port();

            // ---- 1. Schema error: exits 2 with a JSON path before any request or effect. ----
            Path invalid = batchFile(work, "invalid", List.of(
                    upload("u1", source, "up-" + run),
                    Map.of("id", "bad", "command", "artifact inspect",
                            "options", Map.of("artifact", "x", "unexpected", "y"))));
            Cli schemaError = cli(work, cliPort, tenant, principal, token(tenant, principal, FULL), invalid, false, 20_000);
            assertThat(schemaError.exit).as(schemaError.toString()).isEqualTo(2);
            assertThat(schemaError.stdout).isEmpty();
            assertThat(schemaError.stderrJson().path("code").asString()).isEqualTo("BATCH_SCHEMA_INVALID");
            assertThat(schemaError.stderrJson().path("jsonPath").asString()).isEqualTo("items[1].options");
            assertThat(forwarder.requests()).as("a rejected batch sends nothing").isEmpty();
            assertThat(count("SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=?", tenant)).isZero();

            // ---- 2. Forbidden for the token's scopes: typed, no effect after the denied item. ----
            Path pipeline = batchFile(work, "pipeline", pipeline(source, run, destination));
            List<String> noDelivery = FULL.stream().filter(p -> !p.startsWith("media:delivery:")).toList();
            Cli denied = cli(work, cliPort, tenant, principal, token(tenant, principal, noDelivery), pipeline, false, 20_000);
            assertThat(denied.exit).as(denied.toString()).isEqualTo(3);
            JsonNode deniedItems = denied.stdoutJson().path("items");
            assertThat(statuses(deniedItems)).containsExactly("SUCCESS", "SUCCESS", "SUCCESS", "SUCCESS", "ERROR", "NOT_RUN");
            assertThat(deniedItems.get(4).path("error").path("code").asString()).isEqualTo("LOCAL_DEV_IDENTITY_REJECTED");
            assertThat(deniedItems.get(4).path("finality").asString()).isEqualTo("FAILED");
            assertThat(denied.stdoutJson().path("summary").path("success").asBoolean()).isFalse();
            String artifactId = deniedItems.get(0).path("result").path("artifact").path("artifactId").asString();
            String jobId = deniedItems.get(1).path("result").path("job").path("jobId").asString();
            assertThat(artifactId).isNotBlank();
            assertThat(deniedItems.get(1).path("finality").asString()).isEqualTo("COMPLETED");
            assertThat(deniedItems.get(1).path("result").path("job").path("status").asString()).isEqualTo("COMPLETED");
            assertThat(count("SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=?", tenant)).isEqualTo(1);
            assertThat(count("SELECT COUNT(*) FROM media_processing_jobs WHERE tenant_id=?", tenant)).isEqualTo(1);

            // A server-side refusal (not just the CLI preflight): another principal of the same tenant submits a job
            // for the owner's artifact and the owner's token cannot be replayed under another principal.
            String intruder = principal + "-intruder";
            Path intrusion = batchFile(work, "intrusion", List.of(Map.of("id", "j", "command", "job submit",
                    "options", Map.of("artifact", artifactId, "request-id", "intruder-" + run,
                            "provider-hint", "local-diagnostic", "await-finality-ms", 3000))));
            Cli intruded = cli(work, cliPort, tenant, intruder, token(tenant, intruder, FULL), intrusion, false, 20_000);
            JsonNode intrudedItem = intruded.stdoutJson().path("items").get(0);
            assertThat(intrudedItem.path("status").asString()).as(intruded.toString()).isEqualTo("ERROR");
            assertThat(intrudedItem.path("finality").asString()).isEqualTo("FAILED");
            assertThat(intrudedItem.path("error").path("statusCode").asInt()).as(intruded.toString()).isIn(403, 404);
            assertThat(intrudedItem.path("result").isMissingNode()).isTrue();
            assertThat(count("SELECT COUNT(*) FROM media_processing_jobs WHERE tenant_id=?", tenant)).isEqualTo(1);

            // ---- 3. Export without rights is a typed refusal; after a (test-principal) attestation the SAME batch
            //         converges: upload/job replay without new effects, the export now reaches the destination. ----
            Cli noRights = cli(work, cliPort, tenant, principal, token(tenant, principal, FULL), pipeline, false, 20_000);
            JsonNode noRightsItems = noRights.stdoutJson().path("items");
            assertThat(noRights.exit).as(noRights.toString()).isNotZero();
            assertThat(statuses(noRightsItems).subList(0, 4)).containsOnly("SUCCESS");
            assertThat(noRightsItems.get(4).path("status").asString()).isEqualTo("ERROR");
            assertThat(noRightsItems.get(4).path("finality").asString()).isEqualTo("FAILED");
            assertThat(noRightsItems.get(4).path("error").path("code").asString()).isNotBlank();
            assertThat(noRightsItems.get(0).path("result").path("artifact").path("artifactId").asString()).isEqualTo(artifactId);
            assertThat(noRightsItems.get(1).path("result").path("job").path("jobId").asString()).isEqualTo(jobId);
            assertThat(count("SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=?", tenant)).isEqualTo(1);
            assertThat(count("SELECT COUNT(*) FROM media_processing_jobs WHERE tenant_id=?", tenant)).isEqualTo(1);
            assertThat(destinationFiles(destination)).isEmpty();

            String versionId = "sha256:" + digest;
            // Rights: the uploader states EXTERNAL_DELIVERY for the exact version; a clearly synthetic TEST principal
            // confirms it. This is test scaffolding, not a real rights approval.
            String attestationId = JSON.readTree(http(port, tenant, token(tenant, principal, FULL), "POST",
                    "/dev/v1/rights/attestations", JSON.writeValueAsString(Map.of("artifactId", artifactId,
                            "artifactVersionId", versionId, "statementKind", "MEDIA_RIGHTS",
                            "scopes", List.of("EXTERNAL_DELIVERY"),
                            "basis", "TEST: synthetic noise image generated by the test"))).body())
                    .path("attestationId").asString();
            assertThat(attestationId).isNotBlank();
            HttpResponse<String> confirmed = http(port, tenant, token(tenant, "test-principal-confirmer-" + run, FULL),
                    "POST", "/dev/v1/rights/attestations/" + attestationId + "/confirm", "{}");
            assertThat(confirmed.statusCode()).as(confirmed.body()).isEqualTo(200);

            Cli converged = cli(work, cliPort, tenant, principal, token(tenant, principal, FULL), pipeline, false, 20_000);
            assertThat(converged.exit).as(converged.toString()).isZero();
            JsonNode convergedOut = converged.stdoutJson();
            assertThat(convergedOut.path("summary").path("success").asBoolean()).isTrue();
            assertThat(convergedOut.path("summary").path("finality").path("completed").asInt()).isEqualTo(6);
            assertThat(statuses(convergedOut.path("items"))).as(converged.toString()).containsOnly("SUCCESS");
            JsonNode exported = convergedOut.path("items").get(4).path("result").path("export");
            assertThat(exported.path("status").asString()).isEqualTo("DESTINATION_CONFIRMED");
            assertThat(exported.path("destinationConfirmed").asBoolean()).isTrue();
            assertThat(convergedOut.path("items").get(5).path("result").path("export").path("destinationReceiptRef").asString())
                    .isEqualTo(exported.path("destinationReceiptRef").asString());
            assertThat(destinationFiles(destination)).hasSize(1);
            assertThat(Files.readAllBytes(destinationFiles(destination).get(0))).isEqualTo(content);
            assertThat(count("SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=?", tenant)).isEqualTo(1);
            assertThat(count("SELECT COUNT(*) FROM media_processing_jobs WHERE tenant_id=?", tenant)).isEqualTo(1);
            assertThat(converged.stdout).doesNotContain(token(tenant, principal, FULL).substring(0, 40));

            // ---- 4. Unanswered request: the launcher executes, the response never arrives, the CLI times out. ----
            String stalledRequest = "job-stalled-" + run;
            Path stalled = batchFile(work, "stalled", List.of(
                    submit("s1", artifactId, stalledRequest, 10_000),
                    Map.of("id", "after", "command", "artifact inspect", "options", Map.of("artifact", artifactId))));
            forwarder.stallResponseAfterForward(request -> request.startsWith("POST /api/v1/jobs"), Duration.ofSeconds(8));
            Cli timedOut = cli(work, cliPort, tenant, principal, token(tenant, principal, FULL), stalled, false, 1_500);
            forwarder.clearFault();
            assertThat(timedOut.exit).as(timedOut.toString()).isEqualTo(1);
            JsonNode timedOutItems = timedOut.stdoutJson().path("items");
            assertThat(statuses(timedOutItems)).containsExactly("OUTCOME_UNKNOWN", "NOT_RUN");
            assertThat(timedOutItems.get(0).path("finality").asString()).isEqualTo("UNKNOWN");
            assertThat(timedOutItems.get(0).path("error").path("code").asString()).isEqualTo("OUTCOME_UNKNOWN");
            assertThat(timedOutItems.get(0).path("error").path("requestId").asString()).isEqualTo(stalledRequest);
            assertThat(timedOutItems.get(0).path("resume").path("identity").path("value").asString()).isEqualTo(stalledRequest);
            assertThat(timedOut.stdoutJson().path("summary").path("success").asBoolean()).isFalse();
            // The effect really happened on the host even though the CLI never saw an answer.
            assertThat(awaitCount("SELECT COUNT(*) FROM media_processing_jobs WHERE tenant_id=? AND request_id='"
                    + stalledRequest + "'", tenant, 1)).isEqualTo(1);
            Cli resumed = cli(work, cliPort, tenant, principal, token(tenant, principal, FULL), stalled, false, 20_000);
            assertThat(resumed.exit).as(resumed.toString()).isZero();
            JsonNode resumedItems = resumed.stdoutJson().path("items");
            assertThat(statuses(resumedItems)).containsOnly("SUCCESS");
            assertThat(resumedItems.get(0).path("finality").asString()).isEqualTo("COMPLETED");
            assertThat(count("SELECT COUNT(*) FROM media_processing_jobs WHERE tenant_id=? AND request_id='"
                    + stalledRequest + "'", tenant)).isEqualTo(1);

            // ---- 5. Launcher killed in the middle of a batch; re-running the same file converges. ----
            String firstRequest = "job-kill-a-" + run;
            String secondRequest = "job-kill-b-" + run;
            Path killed = batchFile(work, "killed", List.of(
                    submit("k1", artifactId, firstRequest, 10_000),
                    submit("k2", artifactId, secondRequest, 10_000),
                    Map.of("id", "after", "command", "artifact inspect", "options", Map.of("artifact", artifactId))));
            final Forwarder live = forwarder;
            long submitsBefore = forwarder.requestsMatching("POST /api/v1/jobs");
            forwarder.killBeforeForward(request -> request.startsWith("POST /api/v1/jobs")
                    && live.requestsMatching("POST /api/v1/jobs") >= submitsBefore + 2, () -> {
                        launcher[0].destroyForcibly();
                        launcher[0].waitFor(15, TimeUnit.SECONDS);
                    });
            Cli cut = cli(work, cliPort, tenant, principal, token(tenant, principal, FULL), killed, false, 4_000);
            forwarder.clearFault();
            assertThat(launcher[0].isAlive()).isFalse();
            assertThat(cut.exit).as(cut.toString()).isNotZero();
            JsonNode cutItems = cut.stdoutJson().path("items");
            assertThat(statuses(cutItems)).containsExactly("SUCCESS", "OUTCOME_UNKNOWN", "NOT_RUN");
            assertThat(cutItems.get(0).path("finality").asString()).isEqualTo("COMPLETED");
            assertThat(cutItems.get(1).path("finality").asString()).isEqualTo("UNKNOWN");
            assertThat(cutItems.get(1).path("resume").path("identity").path("value").asString()).isEqualTo(secondRequest);
            assertThat(cut.stdoutJson().path("summary").path("success").asBoolean()).isFalse();

            launcher[0] = startLauncher(classpath, environment, log);
            awaitReady(launcher[0], port);
            Cli rerun = cli(work, cliPort, tenant, principal, token(tenant, principal, FULL), killed, false, 20_000);
            assertThat(rerun.exit).as(rerun.toString()).isZero();
            assertThat(statuses(rerun.stdoutJson().path("items"))).containsOnly("SUCCESS");
            assertThat(rerun.stdoutJson().path("items").get(0).path("result").path("job").path("jobId").asString())
                    .isEqualTo(cutItems.get(0).path("result").path("job").path("jobId").asString());
            for (String request : List.of(firstRequest, secondRequest)) {
                assertThat(count("SELECT COUNT(*) FROM media_processing_jobs WHERE tenant_id=? AND request_id='"
                        + request + "'", tenant)).isEqualTo(1);
            }
            // The whole earlier pipeline also converges after the restart: everything replays, no new artifact/export.
            Cli afterRestart = cli(work, cliPort, tenant, principal, token(tenant, principal, FULL), pipeline, false, 20_000);
            assertThat(afterRestart.exit).as(afterRestart.toString()).isZero();
            assertThat(afterRestart.stdoutJson().path("items").get(4).path("result").path("export").path("destinationReceiptRef").asString())
                    .isEqualTo(exported.path("destinationReceiptRef").asString());
            assertThat(count("SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=?", tenant)).isEqualTo(1);
            assertThat(destinationFiles(destination)).hasSize(1);

            // ---- 6. A typed refusal is never success; the declared policy decides whether the batch goes on. ----
            Path typed = batchFile(work, "typed", List.of(
                    Map.of("id", "t1", "command", "artifact inspect", "options", Map.of("artifact", "missing-" + run)),
                    Map.of("id", "t2", "command", "artifact inspect", "options", Map.of("artifact", artifactId))));
            Cli typedStop = cli(work, cliPort, tenant, principal, token(tenant, principal, FULL), typed, false, 20_000);
            assertThat(typedStop.exit).isEqualTo(1);
            assertThat(statuses(typedStop.stdoutJson().path("items"))).as(typedStop.toString()).containsExactly("ERROR", "NOT_RUN");
            assertThat(typedStop.stdoutJson().path("items").get(0).path("error").path("code").asString()).isEqualTo("ARTIFACT_NOT_FOUND");
            assertThat(typedStop.stdoutJson().path("items").get(0).path("finality").asString()).isEqualTo("FAILED");
            Cli typedContinue = cli(work, cliPort, tenant, principal, token(tenant, principal, FULL), typed, true, 20_000);
            assertThat(statuses(typedContinue.stdoutJson().path("items"))).containsExactly("ERROR", "SUCCESS");
            assertThat(typedContinue.stdoutJson().path("summary").path("success").asBoolean()).isFalse();
        } finally {
            if (forwarder != null) forwarder.close();
            if (launcher[0] != null && launcher[0].isAlive()) stopLauncher(launcher[0]);
            deleteBucket(bucket);
            deleteTree(work);
        }
    }

    // ------------------------------------------------------------------ batch documents

    private static List<Map<String, Object>> pipeline(Path source, String run, Path destination) {
        Map<String, Object> artifactRef = Map.of("$ref", Map.of("item", "u1", "path", "artifact.artifactId"));
        return List.of(
                upload("u1", source, "up-" + run),
                Map.of("id", "s1", "command", "job submit", "options", Map.of("artifact", artifactRef,
                        "request-id", "job-" + run, "provider-hint", "local-diagnostic", "await-finality-ms", 20_000)),
                Map.of("id", "g1", "command", "job get", "options", Map.of(
                        "job", Map.of("$ref", Map.of("item", "s1", "path", "job.jobId")),
                        "request-id", "job-" + run, "await-finality-ms", 5_000)),
                Map.of("id", "a1", "command", "artifact inspect", "options", Map.of("artifact", artifactRef)),
                Map.of("id", "e1", "command", "export create", "options", Map.of("request-id", "exp-" + run,
                        "artifact-id", artifactRef,
                        "artifact-version-id", Map.of("$ref", Map.of("item", "u1", "path", "artifact.sha256", "prefix", "sha256:")),
                        "destination-id", "dev-local-directory")),
                Map.of("id", "x1", "command", "export get", "options", Map.of("request-id", "exp-" + run)));
    }

    private static Map<String, Object> upload(String id, Path file, String key) {
        return Map.of("id", id, "command", "artifact upload", "options", Map.of("file", file.toString(),
                "content-type", "image/png", "classification", "INTERNAL", "retention", "P30D", "idempotency-key", key));
    }

    private static Map<String, Object> submit(String id, String artifactId, String requestId, int awaitMs) {
        return Map.of("id", id, "command", "job submit", "options", Map.of("artifact", artifactId,
                "request-id", requestId, "provider-hint", "local-diagnostic", "await-finality-ms", awaitMs));
    }

    private static Path batchFile(Path dir, String name, List<Map<String, Object>> items) throws Exception {
        Path file = dir.resolve(name + ".batch.json");
        Files.writeString(file, JSON.writeValueAsString(Map.of("schemaVersion", "media.dev.batch.v1", "items", items)));
        return file;
    }

    private static List<String> statuses(JsonNode items) {
        List<String> out = new ArrayList<>();
        items.forEach(item -> out.add(item.path("status").asString()));
        return out;
    }

    // ------------------------------------------------------------------ the built CLI, as its own process

    private record Cli(int exit, String stdout, String stderr) {
        JsonNode stdoutJson() throws Exception {
            String[] lines = stdout.strip().split("\\R");
            assertThat(lines).as("single-document stdout: " + this).hasSize(1);
            return JSON.readTree(lines[0]);
        }

        JsonNode stderrJson() throws Exception { return JSON.readTree(stderr.strip().split("\\R")[0]); }

        @Override public String toString() { return "exit=" + exit + " stdout=" + stdout + " stderr=" + stderr; }
    }

    private static Cli cli(Path work, int port, String tenant, String principal, String token, Path batch,
            boolean continueOnError, int requestTimeoutMs) throws Exception {
        Path repoRoot = repoRoot();
        Path packageJson = repoRoot.resolve("libs/audio-video-client/package.json");
        String entrypoint = JSON.readTree(Files.readString(packageJson)).path("bin").path("ghatanamedia-api-dev").asString();
        assertThat(entrypoint).isEqualTo("./dist/cli-dev.js");
        Path cli = packageJson.getParent().resolve(entrypoint).normalize();
        assertThat(Files.isRegularFile(cli)).as("build @audio-video/client before running this DEV_ONLY IT").isTrue();
        List<String> command = new ArrayList<>(List.of("node", cli.toString(), "batch", "run",
                "--endpoint", "http://127.0.0.1:" + port, "--tenant", tenant, "--principal", principal,
                "--file", batch.toString()));
        if (continueOnError) command.add("--continue-on-error");
        Path out = Files.createTempFile(work, "cli-out-", ".capture");
        Path err = Files.createTempFile(work, "cli-err-", ".capture");
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.directory(work.toFile()); // not the repository: the binary needs no sources
        builder.redirectOutput(out.toFile());
        builder.redirectError(err.toFile());
        builder.environment().put("GHATANA_MEDIA_REQUEST_TIMEOUT_MS", Integer.toString(requestTimeoutMs));
        builder.environment().put("GHATANA_MEDIA_BEARER_TOKEN", token);
        Process process = builder.start();
        if (!process.waitFor(120, TimeUnit.SECONDS)) {
            process.destroyForcibly();
            throw new AssertionError("CLI batch exceeded 120 seconds");
        }
        String stdout = Files.readString(out, StandardCharsets.UTF_8);
        String stderr = Files.readString(err, StandardCharsets.UTF_8);
        if (stdout.contains(token) || stderr.contains(token)) throw new AssertionError("CLI emitted credential material");
        return new Cli(process.exitValue(), stdout, stderr);
    }

    private static Path repoRoot() {
        Path root = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (!Files.isRegularFile(root.resolve("scripts/media-dev-identity-token.mjs"))) {
            root = root.getParent();
            if (root == null) throw new AssertionError("Could not locate the Media repository root");
        }
        return root;
    }

    private static String token(String tenant, String principal, List<String> permissions) throws Exception {
        List<String> command = new ArrayList<>(List.of("node", "scripts/media-dev-identity-token.mjs",
                "--tenant", tenant, "--subject", principal, "--expires-in", "300"));
        for (String permission : permissions) { command.add("--permission"); command.add(permission); }
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.directory(repoRoot().toFile());
        builder.redirectErrorStream(true);
        builder.environment().put("MEDIA_PROFILE", "dev");
        builder.environment().put("MEDIA_RUNTIME_ENVIRONMENT", "dev");
        builder.environment().put("MEDIA_DEV_IDENTITY_ENABLED", "true");
        builder.environment().put("MEDIA_DEV_JWT_HMAC_SECRET", DEV_SECRET);
        Process issuer = builder.start();
        byte[] output = issuer.getInputStream().readAllBytes();
        if (!issuer.waitFor(10, TimeUnit.SECONDS)) { issuer.destroyForcibly(); throw new AssertionError("issuer hung"); }
        String text = new String(output, StandardCharsets.US_ASCII).trim();
        assertThat(issuer.exitValue()).as("DEV_ONLY issuer output: " + text).isZero();
        return text;
    }

    // ------------------------------------------------------------------ loopback forwarder (fault boundary)

    /** Forwards each request to the real launcher; may stall a response or kill the launcher before forwarding. */
    private static final class Forwarder implements AutoCloseable {
        private final HttpServer server;
        private final HttpClient client = HttpClient.newHttpClient();
        private final List<String> seen = new CopyOnWriteArrayList<>();
        private volatile Predicate<String> stallWhen;
        private volatile Duration stallFor = Duration.ZERO;
        private volatile Predicate<String> killWhen;
        private volatile ThrowingRunnable killAction;
        private static final Set<String> RESTRICTED = Set.of("connection", "content-length", "expect", "host", "upgrade",
                "transfer-encoding", "keep-alive");

        Forwarder(int upstream) throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.setExecutor(Executors.newCachedThreadPool());
            server.createContext("/", exchange -> handle(exchange, upstream));
            server.start();
        }

        int port() { return server.getAddress().getPort(); }

        List<String> requests() { return List.copyOf(seen); }

        long requestsMatching(String prefix) { return seen.stream().filter(entry -> entry.startsWith(prefix)).count(); }

        void stallResponseAfterForward(Predicate<String> when, Duration duration) { stallWhen = when; stallFor = duration; }

        void killBeforeForward(Predicate<String> when, ThrowingRunnable action) { killWhen = when; killAction = action; }

        void clearFault() { stallWhen = null; killWhen = null; killAction = null; }

        private void handle(HttpExchange exchange, int upstream) throws IOException {
            String key = exchange.getRequestMethod() + " " + exchange.getRequestURI().getPath();
            seen.add(key);
            byte[] body = exchange.getRequestBody().readAllBytes();
            Predicate<String> kill = killWhen;
            if (kill != null && kill.test(key)) {
                try { killAction.run(); } catch (Exception failure) { throw new IOException(failure); }
                exchange.close(); // the connection drops with no response at all
                return;
            }
            HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(
                            "http://127.0.0.1:" + upstream + exchange.getRequestURI()))
                    .method(exchange.getRequestMethod(), body.length == 0 && !"POST".equals(exchange.getRequestMethod())
                            && !"PUT".equals(exchange.getRequestMethod()) ? HttpRequest.BodyPublishers.noBody()
                            : HttpRequest.BodyPublishers.ofByteArray(body));
            exchange.getRequestHeaders().forEach((name, values) -> {
                if (!RESTRICTED.contains(name.toLowerCase(java.util.Locale.ROOT))) values.forEach(value -> request.header(name, value));
            });
            try {
                HttpResponse<byte[]> response = client.send(request.build(), HttpResponse.BodyHandlers.ofByteArray());
                Predicate<String> stall = stallWhen;
                if (stall != null && stall.test(key)) {
                    Thread.sleep(stallFor.toMillis()); // the host already acted; the caller never gets the answer
                    exchange.close();
                    return;
                }
                response.headers().map().forEach((name, values) -> {
                    if (!RESTRICTED.contains(name.toLowerCase(java.util.Locale.ROOT)) && !name.startsWith(":")) {
                        values.forEach(value -> exchange.getResponseHeaders().add(name, value));
                    }
                });
                byte[] payload = response.body();
                exchange.sendResponseHeaders(response.statusCode(), payload.length == 0 ? -1 : payload.length);
                if (payload.length > 0) exchange.getResponseBody().write(payload);
                exchange.close();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                exchange.close();
            } catch (IOException upstreamFailure) {
                exchange.close(); // upstream really is down: the caller sees a dropped connection
            }
        }

        @Override public void close() { server.stop(0); }
    }

    @FunctionalInterface private interface ThrowingRunnable { void run() throws Exception; }

    // ------------------------------------------------------------------ persistence and process helpers

    private static long count(String sql, String tenant) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(sql)) {
            statement.setString(1, tenant);
            try (var rows = statement.executeQuery()) { rows.next(); return rows.getLong(1); }
        }
    }

    private static long awaitCount(String sql, String tenant, long expected) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(15).toNanos();
        long value = count(sql, tenant);
        while (value != expected && System.nanoTime() < deadline) { Thread.sleep(200); value = count(sql, tenant); }
        return value;
    }

    private static List<Path> destinationFiles(Path destination) throws IOException {
        try (var files = Files.list(destination)) { return files.filter(Files::isRegularFile).toList(); }
    }

    private static HttpResponse<String> http(int port, String tenant, String token, String method, String path, String body)
            throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .header("Authorization", "Bearer " + token).header("X-Tenant-Id", tenant)
                .header("Content-Type", "application/json")
                .method(method, HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static byte[] noisePng() throws Exception {
        var image = new java.awt.image.BufferedImage(200, 150, java.awt.image.BufferedImage.TYPE_INT_RGB);
        Random random = new Random(24);
        for (int y = 0; y < 150; y++) for (int x = 0; x < 200; x++) image.setRGB(x, y, random.nextInt(0x1000000));
        var out = new java.io.ByteArrayOutputStream();
        javax.imageio.ImageIO.write(image, "png", out);
        return out.toByteArray();
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static Map<String, String> environment(String bucket, int port, Path destination) {
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
        env.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
        env.put("MEDIA_DELIVERY_DEV_ENABLED", "true");
        env.put("MEDIA_DELIVERY_DEV_DESTINATION_DIR", destination.toString());
        return env;
    }

    private static void installDescriptors(Path root) throws Exception {
        Path services = root.resolve("META-INF/services");
        Files.createDirectories(services);
        Files.writeString(services.resolve("com.ghatana.governance.PolicyEngine"),
                MediaLauncherProcessFixtures.Policy.class.getName() + "\n");
        Files.writeString(services.resolve("com.ghatana.media.runtime.MediaRuntimeContracts$MediaProcessingProvider"),
                MediaLauncherProcessFixtures.Stt.class.getName() + "\n");
    }

    private static S3Client s3() {
        return S3Client.builder().endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(
                        AwsBasicCredentials.create(LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build();
    }

    private static Process startLauncher(String classpath, Map<String, String> env, Path log) throws Exception {
        String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        ProcessBuilder builder = new ProcessBuilder(java, "-cp", classpath, "com.ghatana.media.launcher.MediaLauncher");
        builder.environment().putAll(env);
        builder.redirectErrorStream(true);
        builder.redirectOutput(ProcessBuilder.Redirect.appendTo(log.toFile()));
        return builder.start();
    }

    private static void awaitReady(Process process, int port) throws Exception {
        long deadline = System.nanoTime() + Duration.ofMinutes(2).toNanos();
        while (System.nanoTime() < deadline) {
            if (!process.isAlive()) throw new AssertionError("MediaLauncher exited: " + process.exitValue());
            try {
                HttpResponse<String> response = HttpClient.newHttpClient().send(HttpRequest.newBuilder(
                        URI.create("http://127.0.0.1:" + port + "/health/ready")).GET().build(), HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() == 200) return;
            } catch (IOException ignored) { }
            Thread.sleep(200);
        }
        throw new AssertionError("MediaLauncher did not become ready");
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
            s3.listObjectsV2(builder -> builder.bucket(bucket)).contents().forEach(object ->
                    s3.deleteObject(builder -> builder.bucket(bucket).key(object.key())));
            s3.deleteBucket(builder -> builder.bucket(bucket));
        } catch (Exception ignored) { }
    }

    private static void deleteTree(Path root) {
        try (var paths = Files.walk(root)) {
            paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                try { Files.deleteIfExists(path); } catch (Exception ignored) { }
            });
        } catch (Exception ignored) { }
    }
}
