package com.ghatana.media.integration;

import org.junit.jupiter.api.Assumptions;
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

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
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
import java.util.stream.Stream;

import static com.ghatana.media.integration.MediaLauncherProcessFixtures.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-20: a real {@code TRANSCODE} job (real FFmpeg decode and FLAC re-encode, CPU only) runs through the real launcher
 * process with PostgreSQL, the launcher process is SIGKILLed at three distinct effect boundaries, restarted, and each
 * job is reconciled to an honest, provider-proven state. Nothing is re-run: the committed output is the very file the
 * first process wrote. The Explorer job page watches the job in real Chromium across the kill and the restart.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevJobRestartRecoveryIT {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String DEV_SECRET = "media-dev-job-restart-recovery-secret";
    private static final String PROVIDER = "local-ffmpeg-transcode";

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private record Fixture(String run, String tenant, String principal, String bucket, int port, Path spool,
                           Path gate, Path log, String classpath, Map<String, String> environment) { }

    private record Source(String artifactId, String sha256, byte[] bytes) { }

    @Test
    void killedLauncherJobsAreReconciledAcrossRestartWithoutRerunAndTheExplorerWatchesThem() throws Exception {
        Fixture f = fixture(true);
        Process launcher = null;
        Process browser = null;
        try {
            launcher = start(f, true);
            String owner = token(f.tenant, f.principal);
            String otherTenantToken = token("tenant-other-" + f.run, f.principal);
            String otherPrincipalToken = token(f.tenant, "principal-other-" + f.run);

            Source a = upload(f, owner, 1), b = upload(f, owner, 2), c = upload(f, owner, 3),
                    d = upload(f, owner, 4), e = upload(f, owner, 5), refused = upload(f, owner, 6);

            // A parameter outside the provider contract is refused before any attempt or spool effect exists.
            HttpResponse<String> refusedResponse = submitRaw(f, owner, refused, "refused-" + f.run,
                    "{\"container\":\"mp3\"}");
            assertThat(refusedResponse.statusCode()).as(refusedResponse.body()).isEqualTo(400);
            assertThat(refusedResponse.body()).contains("INVALID_REQUEST");
            try (Stream<Path> spooled = Files.list(f.spool)) {
                assertThat(spooled.count()).as("a refused transcode has no spool effect").isZero();
            }

            hold(f, "before-effect", a);
            hold(f, "after-ffmpeg", b);
            hold(f, "after-commit", c);
            hold(f, "after-ffmpeg", d);
            hold(f, "after-commit", e);
            JsonNode jobA = submit(f, owner, a, "a-" + f.run, Map.of());
            JsonNode jobB = submit(f, owner, b, "b-" + f.run, Map.of());
            JsonNode jobC = submit(f, owner, c, "c-" + f.run, Map.of());
            JsonNode jobD = submit(f, owner, d, "d-" + f.run, Map.of());
            JsonNode jobE = submit(f, owner, e, "e-" + f.run, Map.of());
            // Pending then running: the 202 projection is ACCEPTED or already RUNNING, never terminal.
            for (JsonNode submitted : List.of(jobA, jobB, jobC, jobD, jobE)) {
                assertThat(submitted.path("status").asString()).isIn("ACCEPTED", "RUNNING");
            }
            String idA = jobA.path("jobId").asString(), idB = jobB.path("jobId").asString(),
                    idC = jobC.path("jobId").asString(), idD = jobD.path("jobId").asString(),
                    idE = jobE.path("jobId").asString();
            awaitReached(f, "before-effect", a);
            awaitReached(f, "after-ffmpeg", b);
            awaitReached(f, "after-commit", c);
            awaitReached(f, "after-ffmpeg", d);
            awaitReached(f, "after-commit", e);
            for (String id : List.of(idA, idB, idC, idD, idE)) {
                assertThat(get(f, owner, id).path("status").asString()).isEqualTo("RUNNING");
            }

            // Wrong tenant and wrong principal: indistinguishable from a job that does not exist.
            HttpResponse<String> absent = http(f, f.tenant, owner, "GET", "/api/v1/jobs/job-does-not-exist-" + f.run, null);
            assertThat(absent.statusCode()).isEqualTo(404);
            for (String foreign : List.of(otherTenantToken, otherPrincipalToken)) {
                String foreignTenant = foreign.equals(otherTenantToken) ? "tenant-other-" + f.run : f.tenant;
                HttpResponse<String> denied = http(f, foreignTenant, foreign, "GET", "/api/v1/jobs/" + idC, null);
                assertThat(denied.statusCode()).isEqualTo(404);
                assertThat(JSON.readTree(denied.body()).path("error")).isEqualTo(JSON.readTree(absent.body()).path("error"));
                assertThat(denied.body()).doesNotContain(idC).doesNotContain("RUNNING").doesNotContain(c.sha256());
            }

            // Cancel while running, before the output is committed: the provider proves it stopped (CONFIRMED).
            JsonNode cancelD = cancel(f, owner, idD, "cancel-d-" + f.run);
            assertThat(cancelD.path("outcome").asString()).isEqualTo("CONFIRMED");
            assertThat(cancelD.path("job").path("status").asString()).isEqualTo("CANCELLED");
            release(f, "after-ffmpeg", d);
            Thread.sleep(500);
            assertThat(Files.exists(opDir(f, idD).resolve("out.bin"))).isFalse();
            assertThat(Files.exists(opDir(f, idD).resolve("receipt.json"))).isFalse();
            assertThat(get(f, owner, idD).path("status").asString()).isEqualTo("CANCELLED");

            // Cancel racing completion: the output is already committed, so the cancel is only REQUESTED_UNCONFIRMED
            // and the definitive provider success is what finalizes the job (never a blind CANCELLED).
            JsonNode cancelE = cancel(f, owner, idE, "cancel-e-" + f.run);
            assertThat(cancelE.path("outcome").asString()).isEqualTo("REQUESTED_UNCONFIRMED");
            release(f, "after-commit", e);
            JsonNode finalE = awaitStatus(f, owner, idE, "COMPLETED", 30);
            assertDecodedOutput(f, idE, finalE, e);
            // Replaying the same cancel request reads the durable operation: no second dispatch, and the job is COMPLETED.
            JsonNode replayCancelE = cancel(f, owner, idE, "cancel-e-" + f.run);
            assertThat(replayCancelE.path("replayed").asBoolean()).isTrue();
            assertThat(replayCancelE.path("outcome").asString()).isEqualTo("REQUESTED_UNCONFIRMED");
            assertThat(replayCancelE.path("job").path("status").asString()).isEqualTo("COMPLETED");

            // The Explorer page starts watching job C (committed output, process about to die) in real Chromium.
            browser = startBrowser(f);
            JsonNode ready = readBrowser(browser);
            assertThat(ready.path("ok").asBoolean()).as(ready.toString()).isTrue();
            browserCommand(browser, Map.of("cmd", "connect", "token", token(f.tenant, f.principal)));
            browserCommand(browser, Map.of("cmd", "watch", "jobId", idC));
            browserCommand(browser, Map.of("cmd", "expectObservation", "text", "RUNNING", "timeoutMs", 20000));

            Path receiptC = opDir(f, idC).resolve("receipt.json");
            byte[] receiptBeforeKill = Files.readAllBytes(receiptC);
            long outMtimeBeforeKill = Files.getLastModifiedTime(opDir(f, idC).resolve("out.bin")).toMillis();
            String outShaBeforeKill = sha256(Files.readAllBytes(opDir(f, idC).resolve("out.bin")));
            long versionBeforeKill = get(f, owner, idC).path("version").asLong();

            launcher.destroyForcibly();
            assertThat(launcher.waitFor(15, TimeUnit.SECONDS)).isTrue();
            launcher = null;
            browserCommand(browser, Map.of("cmd", "expectObservation", "text", "unreachable", "timeoutMs", 20000));
            JsonNode downState = browserCommand(browser, Map.of("cmd", "expectWatchState", "state", "host-unavailable"));
            assertThat(downState.path("text").asString()).contains("Last observed state: RUNNING");
            clearGate(f);

            launcher = start(f, true);
            owner = token(f.tenant, f.principal);
            browserCommand(browser, Map.of("cmd", "expectObservation", "text", "reachable again", "timeoutMs", 30000));
            // Restart readback is exact and idempotent while the dead owner's lease is still live: the job stays RUNNING.
            for (String id : List.of(idA, idB, idC)) {
                JsonNode after = get(f, owner, id);
                assertThat(after.path("status").asString()).isEqualTo("RUNNING");
            }
            assertThat(get(f, owner, idC).path("version").asLong()).isEqualTo(versionBeforeKill);

            JsonNode finalA = awaitTerminal(f, owner, idA, 150);
            JsonNode finalB = awaitTerminal(f, owner, idB, 150);
            JsonNode finalC = awaitTerminal(f, owner, idC, 150);
            // Killed before the effect started, and killed after FFmpeg wrote but before the commit: provably no effect.
            for (JsonNode noEffect : List.of(finalA, finalB)) {
                assertThat(noEffect.path("status").asString()).isEqualTo("FAILED");
                assertThat(noEffect.path("failureCode").asString()).isEqualTo("RESTART_NO_EFFECT_PROVEN");
                assertThat(noEffect.path("result").path("providerOutcome").asString()).isEqualTo("NO_EFFECT_PROVEN");
            }
            for (String id : List.of(idA, idB)) {
                assertThat(Files.exists(opDir(f, id).resolve("out.bin"))).isFalse();
                assertThat(Files.exists(opDir(f, id).resolve("out.part"))).isFalse();
                assertThat(Files.exists(opDir(f, id).resolve("receipt.json"))).isFalse();
            }
            // Killed after the commit but before the job store learned of it: completed from the receipt, not re-run.
            assertThat(finalC.path("status").asString()).isEqualTo("COMPLETED");
            assertThat(finalC.path("result").path("providerOutcome").asString()).isEqualTo("SUCCEEDED");
            assertThat(finalC.path("result").path("reconciliation").asString()).contains("not re-run");
            assertThat(finalC.path("result").path("outputSha256").asString()).isEqualTo(outShaBeforeKill);
            assertDecodedOutput(f, idC, finalC, c);
            assertThat(Files.readAllBytes(receiptC)).isEqualTo(receiptBeforeKill);
            assertThat(Files.getLastModifiedTime(opDir(f, idC).resolve("out.bin")).toMillis()).isEqualTo(outMtimeBeforeKill);
            try (Stream<Path> reached = Files.list(f.gate)) {
                assertThat(reached.map(p -> p.getFileName().toString()).filter(n -> n.startsWith("reached-")).toList())
                        .as("no job was dispatched again after the restart").isEmpty();
            }
            assertThat(attemptStates(f, idA)).containsExactly("NO_EFFECT_PROVEN");
            assertThat(attemptStates(f, idB)).containsExactly("NO_EFFECT_PROVEN");
            assertThat(attemptStates(f, idC)).containsExactly("SUCCEEDED");
            assertThat(attemptStates(f, idE)).containsExactly("SUCCEEDED");
            assertThat(get(f, owner, idD).path("status").asString()).isEqualTo("CANCELLED");

            // Cancelling an already-terminal reconciled job is a typed no-op, never a state change.
            JsonNode cancelTerminal = cancel(f, owner, idA, "cancel-a-" + f.run);
            assertThat(cancelTerminal.path("outcome").asString()).isEqualTo("ALREADY_TERMINAL");
            assertThat(cancelTerminal.path("job").path("status").asString()).isEqualTo("FAILED");

            // Same requestId replays the same job; it never starts a second attempt.
            JsonNode replay = submit(f, owner, c, "c-" + f.run, Map.of());
            assertThat(replay.path("jobId").asString()).isEqualTo(idC);
            assertThat(replay.path("status").asString()).isEqualTo("COMPLETED");
            assertThat(attemptStates(f, idC)).containsExactly("SUCCEEDED");

            // The browser followed the whole story and reports the reconciled terminal state.
            browserCommand(browser, Map.of("cmd", "expectObservation", "text", "COMPLETED", "timeoutMs", 30000));
            JsonNode snapshot = browserCommand(browser, Map.of("cmd", "snapshot"));
            List<String> observed = new ArrayList<>();
            snapshot.path("observed").forEach(node -> observed.add(node.asString()));
            assertThat(observed.get(0)).startsWith("RUNNING");
            int down = indexContaining(observed, "unreachable"), up = indexContaining(observed, "reachable again"),
                    done = indexContaining(observed, "COMPLETED");
            assertThat(down).isGreaterThan(0);
            assertThat(up).isGreaterThan(down);
            assertThat(done).isGreaterThan(up);
            assertThat(snapshot.path("detail").asString()).contains("SUCCEEDED").contains(outShaBeforeKill);
            assertThat(snapshot.path("status").asString()).contains("Final state observed: COMPLETED");
            assertThat(snapshot.path("storage").asInt()).isZero();
            assertThat(snapshot.path("overflow").asBoolean()).isFalse();
            assertThat(snapshot.path("mutations").asInt()).isZero();
            assertThat(snapshot.path("errors").size()).isZero();

            // A different tenant sees nothing: the page reports an unknown status and shows no job detail.
            browserCommand(browser, Map.of("cmd", "disconnect"));
            browserCommand(browser, Map.of("cmd", "connect", "token", token("tenant-other-" + f.run, f.principal)));
            browserCommand(browser, Map.of("cmd", "watch", "jobId", idC));
            browserCommand(browser, Map.of("cmd", "expectWatchState", "state", "unknown"));
            JsonNode foreignView = browserCommand(browser, Map.of("cmd", "snapshot"));
            assertThat(foreignView.path("detail").asString()).isEmpty();
            assertThat(foreignView.path("observed").size()).isZero();
            browserCommand(browser, Map.of("cmd", "close"));
            assertThat(browser.waitFor(30, TimeUnit.SECONDS)).isTrue();
            assertThat(browser.exitValue()).isZero();
            browser = null;

            // A clean restart reads every job back byte-identically.
            owner = token(f.tenant, f.principal);
            Map<String, JsonNode> before = new LinkedHashMap<>();
            for (String id : List.of(idA, idB, idC, idD, idE)) before.put(id, get(f, owner, id));
            stop(launcher);
            launcher = start(f, true);
            owner = token(f.tenant, f.principal);
            for (var entry : before.entrySet()) {
                assertThat(get(f, owner, entry.getKey())).isEqualTo(entry.getValue());
            }
            assertThat(attemptStates(f, idC)).containsExactly("SUCCEEDED");
        } finally {
            if (browser != null) browser.destroyForcibly();
            if (launcher != null) { launcher.destroyForcibly(); }
            cleanup(f);
        }
    }

    @Test
    void providerAbsentAfterRestartLeavesAnHonestUnknownAndNeverReRunsOrGuessesTheOutput() throws Exception {
        Fixture f = fixture(true);
        Process launcher = null;
        try {
            launcher = start(f, true);
            String owner = token(f.tenant, f.principal);
            Source c = upload(f, owner, 7);
            hold(f, "after-commit", c);
            String id = submit(f, owner, c, "u-" + f.run, Map.of()).path("jobId").asString();
            awaitReached(f, "after-commit", c);
            byte[] receipt = Files.readAllBytes(opDir(f, id).resolve("receipt.json"));
            launcher.destroyForcibly();
            assertThat(launcher.waitFor(15, TimeUnit.SECONDS)).isTrue();
            clearGate(f);

            // The provider is not configured in the restarted process: it cannot prove anything, so it must not guess.
            launcher = start(f, false);
            owner = token(f.tenant, f.principal);
            JsonNode unknown = awaitTerminal(f, owner, id, 150);
            assertThat(unknown.path("status").asString()).isEqualTo("OUTCOME_UNKNOWN");
            assertThat(unknown.path("failureCode").asString()).isEqualTo("PROCESSING_OUTCOME_UNKNOWN");
            assertThat(unknown.path("result").path("providerOutcome").asString()).isEqualTo("UNKNOWN");
            assertThat(Files.readAllBytes(opDir(f, id).resolve("receipt.json"))).isEqualTo(receipt);
            assertThat(attemptStates(f, id)).containsExactly("OUTCOME_UNKNOWN");

            // Even once the provider is back, a recorded UNKNOWN is never silently rewritten or re-dispatched.
            stop(launcher);
            launcher = start(f, true);
            owner = token(f.tenant, f.principal);
            assertThat(get(f, owner, id)).isEqualTo(unknown);
            assertThat(attemptStates(f, id)).containsExactly("OUTCOME_UNKNOWN");
            try (Stream<Path> reached = Files.list(f.gate)) {
                assertThat(reached.map(p -> p.getFileName().toString()).filter(n -> n.startsWith("reached-")).count())
                        .isZero();
            }
        } finally {
            if (launcher != null) launcher.destroyForcibly();
            cleanup(f);
        }
    }

    // ---- fixtures and helpers -------------------------------------------------------------------------------

    private static Fixture fixture(boolean requireFfmpeg) throws Exception {
        String ffmpeg = System.getenv("MEDIA_FFMPEG"), ffprobe = System.getenv("MEDIA_FFPROBE");
        Assumptions.assumeTrue(!requireFfmpeg || (ffmpeg != null && ffprobe != null),
                "MEDIA_FFMPEG and MEDIA_FFPROBE must name a working FFmpeg pair");
        String run = UUID.randomUUID().toString().replace("-", "");
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        String bucket = "media-job-restart-" + run;
        try (S3Client s3 = s3()) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
        Path services = Files.createTempDirectory("media-job-restart-services-");
        installDescriptors(services);
        String childClasspath = System.getProperty("media.child.classpath", "");
        assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
        Path spool = Files.createTempDirectory("media-job-restart-spool-");
        Path gate = Files.createTempDirectory("media-job-restart-gate-");
        Map<String, String> env = new HashMap<>();
        env.put("MEDIA_RUNTIME_ENABLED", "true");
        env.put("MEDIA_RUNTIME_ENVIRONMENT", "dev");
        env.put("MEDIA_PROFILE", "dev");
        env.put("MEDIA_DEV_IDENTITY_ENABLED", "true");
        env.put("MEDIA_DEV_JWT_HMAC_SECRET", DEV_SECRET);
        env.put("MEDIA_HTTP_PORT", Integer.toString(port));
        env.put("MEDIA_LOCAL_PROVIDER_ENABLED", "true");
        env.put("MEDIA_JOB_TIMEOUT_MS", "20000");
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
        // The Explorer's DEV_ONLY context route (/dev/v1/context) is served by the dev project host.
        env.put("MEDIA_PROJECT_TIMELINE_DEV_ENABLED", "true");
        env.put("MEDIA_PROJECT_TIMELINE_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        env.put("MEDIA_PROJECT_TIMELINE_SCHEMA", "media_dev_job_restart_" + run);
        env.put("MEDIA_PROJECT_TIMELINE_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_PROJECT_TIMELINE_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_PROJECT_TIMELINE_DB_PASSWORD");
        env.put("MEDIA_PROJECT_TIMELINE_DB_PASSWORD", POSTGRES.getPassword());
        return new Fixture(run, "tenant-job-restart-" + run, "principal-job-restart-" + run, bucket, port, spool, gate,
                Files.createTempFile("media-job-restart-process-", ".log"),
                services + java.io.File.pathSeparator + childClasspath, env);
    }

    private static Process start(Fixture f, boolean withProvider) throws Exception {
        Map<String, String> env = new HashMap<>(f.environment);
        String ffmpeg = System.getenv("MEDIA_FFMPEG"), ffprobe = System.getenv("MEDIA_FFPROBE");
        if (withProvider) {
            env.put("MEDIA_DEV_RENDER_FFMPEG", ffmpeg);
            env.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe);
            env.put("MEDIA_DEV_FFMPEG_JOB_SPOOL", f.spool.toString());
            env.put("MEDIA_DEV_FFMPEG_JOB_FAULT_GATE_DIR", f.gate.toString());
        }
        String javaBin = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        ProcessBuilder builder = new ProcessBuilder(javaBin, "-cp", f.classpath, "com.ghatana.media.launcher.MediaLauncher");
        builder.environment().putAll(env);
        builder.redirectErrorStream(true);
        builder.redirectOutput(ProcessBuilder.Redirect.appendTo(f.log.toFile()));
        Process process = builder.start();
        long deadline = System.nanoTime() + java.time.Duration.ofMinutes(2).toNanos();
        while (System.nanoTime() < deadline) {
            if (!process.isAlive()) throw new AssertionError("MediaLauncher exited: " + process.exitValue()
                    + "\n" + Files.readString(f.log));
            try {
                HttpResponse<String> response = HttpClient.newHttpClient().send(
                        HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + f.port + "/health/ready")).GET().build(),
                        HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() == 200) return process;
            } catch (java.io.IOException ignored) { }
            Thread.sleep(200);
        }
        throw new AssertionError("MediaLauncher did not become ready");
    }

    private static void stop(Process process) throws Exception {
        process.destroy();
        if (!process.waitFor(15, TimeUnit.SECONDS)) {
            process.destroyForcibly();
            assertThat(process.waitFor(10, TimeUnit.SECONDS)).isTrue();
        }
    }

    private static String token(String tenant, String principal) throws Exception {
        Path repoRoot = repoRoot();
        List<String> command = new ArrayList<>(List.of("node", "scripts/media-dev-identity-token.mjs",
                "--tenant", tenant, "--subject", principal, "--expires-in", "300"));
        for (String permission : List.of("media:artifact:create", "media:artifact:write", "media:artifact:read",
                "media:job:create", "media:job:read", "media:job:cancel", "media:project:dev:read")) {
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
        String output = new String(issuer.getInputStream().readAllBytes(), StandardCharsets.US_ASCII).trim();
        assertThat(issuer.waitFor(10, TimeUnit.SECONDS)).isTrue();
        assertThat(issuer.exitValue()).as("DEV_ONLY issuer output: " + output).isZero();
        return output;
    }

    private static Path repoRoot() {
        Path root = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (!Files.isRegularFile(root.resolve("scripts/media-dev-identity-token.mjs"))) {
            root = root.getParent();
            if (root == null) throw new AssertionError("Could not locate the Media repository root");
        }
        return root;
    }

    private static HttpResponse<String> http(Fixture f, String tenant, String token, String method, String path,
                                             String body) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + f.port + path))
                .header("X-Tenant-Id", tenant).header("Authorization", "Bearer " + token);
        if ("POST".equals(method)) {
            request.header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body == null ? "" : body));
        } else {
            request.GET();
        }
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static Source upload(Fixture f, String token, int seed) throws Exception {
        byte[] wav = sineWav(seed);
        String digest = sha256(wav);
        String body = """
                {"tenantId":"%s","principalId":"%s","fileName":"tone-%d.wav","contentType":"audio/wav",
                 "expectedSizeBytes":%d,"expectedSha256":"%s","classification":"CONFIDENTIAL","retention":"P30D",
                 "metadata":{"sourceClockId":"fixture-clock","sourceClockMappingEvidenceRef":"fixture-clock-evidence",
                 "sourceClockTicksPerSecond":16000,"sourceDurationTicks":16000}}
                """.formatted(f.tenant, f.principal, seed, wav.length, digest);
        HttpRequest begin = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + f.port + "/api/v1/artifacts/uploads"))
                .header("X-Tenant-Id", f.tenant).header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/json").header("Idempotency-Key", "job-restart-" + f.run + "-" + seed)
                .POST(HttpRequest.BodyPublishers.ofString(body)).build();
        HttpResponse<String> started = HttpClient.newHttpClient().send(begin, HttpResponse.BodyHandlers.ofString());
        assertThat(started.statusCode()).as(started.body()).isEqualTo(201);
        String uploadId = JSON.readTree(started.body()).path("uploadId").asString();
        HttpRequest chunk = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + f.port
                        + "/api/v1/artifacts/uploads/" + uploadId + "/chunks/0"))
                .header("X-Tenant-Id", f.tenant).header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/octet-stream")
                .PUT(HttpRequest.BodyPublishers.ofByteArray(wav)).build();
        HttpResponse<String> ack = HttpClient.newHttpClient().send(chunk, HttpResponse.BodyHandlers.ofString());
        assertThat(ack.statusCode()).as(ack.body()).isEqualTo(200);
        HttpResponse<String> done = http(f, f.tenant, token, "POST", "/api/v1/artifacts/uploads/" + uploadId + "/complete", "");
        assertThat(done.statusCode()).as(done.body()).isEqualTo(201);
        return new Source(JSON.readTree(done.body()).path("artifactId").asString(), digest, wav);
    }

    private static JsonNode submit(Fixture f, String token, Source source, String requestId,
                                   Map<String, Object> parameters) throws Exception {
        HttpResponse<String> response = submitRaw(f, token, source, requestId,
                parameters.isEmpty() ? "{\"container\":\"flac\",\"sampleRateHz\":8000,\"channels\":1}"
                        : JSON.writeValueAsString(parameters));
        assertThat(response.statusCode()).as(response.body()).isIn(200, 202);
        return JSON.readTree(response.body());
    }

    private static HttpResponse<String> submitRaw(Fixture f, String token, Source source, String requestId,
                                                  String parametersJson) throws Exception {
        String request = """
                {"requestId":"%s","tenantId":"%s","principalId":"%s","correlationId":"corr-%s","artifactId":"%s",
                 "expectedArtifactVersion":"sha256:%s","jobType":"TRANSCODE","providerHint":"%s","parameters":%s}
                """.formatted(requestId, f.tenant, f.principal, requestId, source.artifactId(), source.sha256(), PROVIDER, parametersJson);
        return http(f, f.tenant, token, "POST", "/api/v1/jobs", request);
    }

    private static JsonNode get(Fixture f, String token, String jobId) throws Exception {
        HttpResponse<String> response = http(f, f.tenant, token, "GET", "/api/v1/jobs/" + jobId, null);
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        return JSON.readTree(response.body());
    }

    private static JsonNode awaitStatus(Fixture f, String token, String jobId, String status, int seconds) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        JsonNode job = null;
        while (System.nanoTime() < deadline) {
            job = get(f, token, jobId);
            if (status.equals(job.path("status").asString())) return job;
            Thread.sleep(200);
        }
        throw new AssertionError("job " + jobId + " did not reach " + status + ": " + job);
    }

    private static JsonNode awaitTerminal(Fixture f, String token, String jobId, int seconds) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        JsonNode job = null;
        while (System.nanoTime() < deadline) {
            job = get(f, token, jobId);
            if (List.of("COMPLETED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN").contains(job.path("status").asString())) return job;
            Thread.sleep(1000);
        }
        throw new AssertionError("job " + jobId + " did not reach a final state: " + job);
    }

    private static JsonNode cancel(Fixture f, String token, String jobId, String requestId) throws Exception {
        HttpResponse<String> response = http(f, f.tenant, token, "POST", "/dev/v1/jobs/" + jobId + "/cancel",
                "{\"requestId\":\"" + requestId + "\"}");
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        return JSON.readTree(response.body());
    }

    private static Path opDir(Fixture f, String jobId) throws Exception {
        return f.spool.resolve(sha256(("local-ffmpeg-transcode:" + jobId + ":1").getBytes(StandardCharsets.UTF_8)).substring(0, 40));
    }

    private static String tag(String phase, Source source) { return phase + "-" + source.sha256().substring(0, 16); }

    private static void hold(Fixture f, String phase, Source source) throws Exception {
        Files.writeString(f.gate.resolve("hold-" + tag(phase, source)), "hold");
    }

    private static void release(Fixture f, String phase, Source source) throws Exception {
        Files.deleteIfExists(f.gate.resolve("hold-" + tag(phase, source)));
    }

    private static void awaitReached(Fixture f, String phase, Source source) throws Exception {
        Path reached = f.gate.resolve("reached-" + tag(phase, source));
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (!Files.exists(reached)) {
            assertThat(System.nanoTime()).as("fault gate " + phase + " was never reached").isLessThan(deadline);
            Thread.sleep(50);
        }
    }

    private static void clearGate(Fixture f) throws Exception {
        try (Stream<Path> files = Files.list(f.gate)) {
            for (Path file : files.toList()) Files.deleteIfExists(file);
        }
    }

    private static List<String> attemptStates(Fixture f, String jobId) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT state FROM media_processing_attempts WHERE tenant_id=? AND job_id=? ORDER BY attempt_number")) {
            statement.setString(1, f.tenant);
            statement.setString(2, jobId);
            List<String> states = new ArrayList<>();
            try (var rows = statement.executeQuery()) { while (rows.next()) states.add(rows.getString(1)); }
            return states;
        }
    }

    /** The committed output is a real FLAC: fully decodable, with the requested rate and channels, and its digest matches. */
    private static void assertDecodedOutput(Fixture f, String jobId, JsonNode job, Source source) throws Exception {
        Path out = opDir(f, jobId).resolve("out.bin");
        assertThat(out).isRegularFile();
        byte[] bytes = Files.readAllBytes(out);
        JsonNode result = job.path("result");
        assertThat(job.path("status").asString()).isEqualTo("COMPLETED");
        assertThat(result.path("outputSha256").asString()).isEqualTo(sha256(bytes));
        assertThat(result.path("outputBytes").asLong()).isEqualTo(bytes.length);
        assertThat(result.path("sourceSha256").asString()).isEqualTo(source.sha256());
        assertThat(result.path("outputContentType").asString()).isEqualTo("audio/flac");
        assertThat(new String(bytes, 0, 4, StandardCharsets.US_ASCII)).isEqualTo("fLaC");
        Process probe = new ProcessBuilder(System.getenv("MEDIA_FFPROBE"), "-v", "error", "-select_streams", "a:0",
                "-show_entries", "stream=codec_name,sample_rate,channels,duration", "-of", "json", out.toString())
                .redirectErrorStream(true).start();
        String probeJson = new String(probe.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(probe.waitFor(30, TimeUnit.SECONDS)).isTrue();
        JsonNode stream = JSON.readTree(probeJson).path("streams").path(0);
        assertThat(stream.path("codec_name").asString()).isEqualTo("flac");
        assertThat(stream.path("sample_rate").asString()).isEqualTo("8000");
        assertThat(stream.path("channels").asInt()).isEqualTo(1);
        assertThat(Double.parseDouble(stream.path("duration").asString())).isBetween(0.95, 1.05);
        Process decode = new ProcessBuilder(System.getenv("MEDIA_FFMPEG"), "-v", "error", "-i", out.toString(), "-f", "null", "-")
                .redirectErrorStream(true).start();
        String decodeOutput = new String(decode.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(decode.waitFor(60, TimeUnit.SECONDS)).isTrue();
        assertThat(decode.exitValue()).as(decodeOutput).isZero();
        assertThat(decodeOutput).isBlank();
    }

    private static int indexContaining(List<String> items, String text) {
        for (int index = 0; index < items.size(); index++) if (items.get(index).contains(text)) return index;
        return -1;
    }

    private static Process startBrowser(Fixture f) throws Exception {
        ProcessBuilder builder = new ProcessBuilder("node", "apps/media-experience-explorer/test/dev-job-restart-live-browser.mjs");
        builder.directory(repoRoot().toFile());
        builder.environment().put("MEDIA_DEV_JOB_RESTART_BROWSER_HOST_PORT", Integer.toString(f.port));
        builder.redirectError(ProcessBuilder.Redirect.appendTo(f.log.toFile()));
        return builder.start();
    }

    private static final Map<Process, BufferedReader> READERS = new java.util.concurrent.ConcurrentHashMap<>();
    private static final Map<Process, BufferedWriter> WRITERS = new java.util.concurrent.ConcurrentHashMap<>();

    private static JsonNode readBrowser(Process browser) throws Exception {
        BufferedReader reader = READERS.computeIfAbsent(browser,
                p -> new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8)));
        String line = reader.readLine();
        assertThat(line).as("browser stdout closed").isNotNull();
        return JSON.readTree(line);
    }

    private static JsonNode browserCommand(Process browser, Map<String, Object> command) throws Exception {
        BufferedWriter writer = WRITERS.computeIfAbsent(browser,
                p -> new BufferedWriter(new OutputStreamWriter(p.getOutputStream(), StandardCharsets.UTF_8)));
        writer.write(JSON.writeValueAsString(command));
        writer.newLine();
        writer.flush();
        JsonNode reply = readBrowser(browser);
        assertThat(reply.path("ok").asBoolean()).as("browser command " + command.get("cmd") + ": " + reply).isTrue();
        return reply;
    }

    private static void cleanup(Fixture f) {
        try (S3Client s3 = s3()) {
            var objects = s3.listObjectsV2(builder -> builder.bucket(f.bucket));
            objects.contents().forEach(object -> s3.deleteObject(builder -> builder.bucket(f.bucket).key(object.key())));
            s3.deleteBucket(builder -> builder.bucket(f.bucket));
        } catch (Exception ignored) { }
        for (Path dir : List.of(f.spool, f.gate)) {
            try (Stream<Path> walk = Files.walk(dir)) {
                walk.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
            } catch (Exception ignored) { }
        }
    }

    private static S3Client s3() {
        return S3Client.builder().endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(
                        AwsBasicCredentials.create(LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build();
    }

    private static void installDescriptors(Path root) throws Exception {
        Path services = root.resolve("META-INF/services");
        Files.createDirectories(services);
        Files.writeString(services.resolve("com.ghatana.governance.PolicyEngine"),
                MediaLauncherProcessFixtures.Policy.class.getName() + "\n");
        Files.writeString(services.resolve("com.ghatana.media.runtime.MediaRuntimeContracts$MediaProcessingProvider"),
                MediaLauncherProcessFixtures.Stt.class.getName() + "\n");
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    /** One second of a seed-specific 16 kHz mono 16-bit sine tone, so every source has a distinct digest. */
    private static byte[] sineWav(int seed) {
        int samples = 16_000;
        byte[] bytes = new byte[44 + samples * 2];
        putAscii(bytes, 0, "RIFF"); putInt(bytes, 4, bytes.length - 8); putAscii(bytes, 8, "WAVE");
        putAscii(bytes, 12, "fmt "); putInt(bytes, 16, 16); putShort(bytes, 20, 1); putShort(bytes, 22, 1);
        putInt(bytes, 24, 16_000); putInt(bytes, 28, 32_000); putShort(bytes, 32, 2); putShort(bytes, 34, 16);
        putAscii(bytes, 36, "data"); putInt(bytes, 40, samples * 2);
        double frequency = 300 + seed * 70;
        for (int index = 0; index < samples; index++) {
            putShort(bytes, 44 + index * 2, (int) (Math.sin(2 * Math.PI * frequency * index / 16_000.0) * 12_000));
        }
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
