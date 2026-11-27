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
 * executes source-free JSON batches of independent job submissions against a real launcher process
 * (PostgreSQL + S3) with a DEV identity token. Covers exact plan confirmation, schema rejection before dispatch,
 * token-scope denial, genuine terminal job readback, an unanswered request reported UNKNOWN, and same-file
 * replay after launcher restart without duplicate jobs. The only test-owned component in the path is a loopback
 * TCP-level HTTP forwarder that stalls or cuts a real response; it never answers for the launcher.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevStructuredCliBatchIT {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String DEV_SECRET = "media-dev-structured-cli-batch-secret";
    private static final List<String> FULL = List.of("media:job:create", "media:job:read", "media:artifact:create",
            "media:artifact:write", "media:artifact:read");

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
        Path log = work.resolve("launcher.log");
        Path source = work.resolve("source.png");
        byte[] content = noisePng();
        Files.write(source, content);
        Process[] launcher = new Process[1];
        Forwarder forwarder = null;
        try {
            try (S3Client s3 = s3()) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = environment(bucket, port);
            launcher[0] = startLauncher(classpath, environment, log);
            awaitReady(launcher[0], port);
            forwarder = new Forwarder(port);
            int cliPort = forwarder.port();
            String ownerToken = token(tenant, principal, FULL);

            // Seed one real, durable artifact through the installed DEV_ONLY binary. Batch items are
            // deliberately limited to the source-bound job-submit operation; upload is a separate call.
            Cli uploaded = cliCommand(work, cliPort, tenant, principal, ownerToken,
                    "artifact", "upload", "--file", source.toString(), "--content-type", "image/png",
                    "--classification", "INTERNAL", "--retention", "P30D", "--idempotency-key", "up-" + run);
            assertThat(uploaded.exit).as(uploaded.toString()).isZero();
            String artifactId = uploaded.stdoutJson().path("artifact").path("artifactId").asString();
            assertThat(artifactId).as(uploaded.toString()).isNotBlank();
            assertThat(count("SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=?", tenant)).isEqualTo(1);

            // ---- 1. Closed-schema error and wrong exact-plan confirmation send no job request. ----
            long requestsBeforePreflight = forwarder.requests().size();
            Path invalid = batchFile(work, "invalid", List.of(Map.of("id", "bad", "command", "job submit",
                    "options", Map.of("artifact", artifactId, "request-id", "invalid-" + run,
                            "job-type", "TRANSCODE", "await-finality-ms", 10_000, "provider-hint", "local-diagnostic"))));
            Cli schemaError = cli(work, cliPort, tenant, principal, ownerToken, invalid, 20_000);
            assertThat(schemaError.exit).as(schemaError.toString()).isEqualTo(2);
            assertThat(schemaError.stdout).isEmpty();
            assertThat(schemaError.stderrJson().path("code").asString()).isEqualTo("BATCH_SCHEMA_INVALID");
            assertThat(forwarder.requests()).as("a rejected batch sends no item request")
                    .hasSize((int) requestsBeforePreflight);
            assertThat(count("SELECT COUNT(*) FROM media_processing_jobs WHERE tenant_id=?", tenant)).isZero();

            Path hashProbe = batchFile(work, "hash-probe", List.of(submit("h1", artifactId, "hash-" + run, 5_000)));
            Cli badConfirmation = cliWithConfirmation(work, cliPort, tenant, principal, ownerToken, hashProbe,
                    "sha256:" + "0".repeat(64), 20_000);
            assertThat(badConfirmation.exit).as(badConfirmation.toString()).isEqualTo(2);
            assertThat(badConfirmation.stdout).isEmpty();
            assertThat(badConfirmation.stderrJson().path("code").asString()).isEqualTo("BATCH_PLAN_CONFIRMATION_INVALID");
            assertThat(forwarder.requests()).as("a mismatched plan hash sends no item request")
                    .hasSize((int) requestsBeforePreflight);
            assertThat(count("SELECT COUNT(*) FROM media_processing_jobs WHERE tenant_id=?", tenant)).isZero();

            // ---- 2. The batch cannot expand a DEV_ONLY token's job-submit permissions. ----
            Path deniedPlan = batchFile(work, "denied", List.of(submit("d1", artifactId, "denied-" + run, 10_000)));
            long requestsBeforeDenied = forwarder.requests().size();
            Cli denied = cli(work, cliPort, tenant, principal, token(tenant, principal, List.of("media:job:read")),
                    deniedPlan, 20_000);
            assertThat(denied.exit).as(denied.toString()).isNotZero();
            JsonNode deniedItem = denied.stdoutJson().path("items").get(0);
            assertThat(deniedItem.path("status").asString()).as(denied.toString()).isEqualTo("ERROR");
            assertThat(deniedItem.path("finality").isNull()).isTrue();
            assertThat(deniedItem.path("error").path("code").asString()).isEqualTo("LOCAL_DEV_IDENTITY_REJECTED");
            assertThat(forwarder.requests()).as("permission refusal is rejected before the job endpoint")
                    .hasSize((int) requestsBeforeDenied);
            assertThat(count("SELECT COUNT(*) FROM media_processing_jobs WHERE tenant_id=?", tenant)).isZero();

            // ---- 3. A successful item requires a terminal COMPLETED owner readback. ----
            Path completedPlan = batchFile(work, "completed", List.of(
                    submit("c1", artifactId, "job-complete-a-" + run, 20_000),
                    submit("c2", artifactId, "job-complete-b-" + run, 20_000)));
            Cli completed = cli(work, cliPort, tenant, principal, ownerToken, completedPlan, 20_000);
            assertThat(completed.exit).as(completed.toString()).isZero();
            JsonNode completedOut = completed.stdoutJson();
            assertThat(completedOut.path("items").size()).isEqualTo(2);
            assertThat(statuses(completedOut.path("items"))).containsExactly("SUCCESS", "SUCCESS");
            for (JsonNode item : completedOut.path("items")) {
                assertThat(item.path("finality").asString()).isEqualTo("COMPLETED");
                assertThat(item.path("result").path("job").path("status").asString()).isEqualTo("COMPLETED");
                assertThat(item.path("result").path("job").path("jobId").asString()).isNotBlank();
            }
            assertThat(completedOut.path("summary").path("success").asBoolean()).isTrue();
            assertThat(count("SELECT COUNT(*) FROM media_processing_jobs WHERE tenant_id=?", tenant)).isEqualTo(2);

            // ---- 4. Lost submit response is UNKNOWN; replaying the unchanged file reconciles the same request. ----
            String stalledRequest = "job-stalled-" + run;
            Path stalled = batchFile(work, "stalled", List.of(submit("s1", artifactId, stalledRequest, 10_000)));
            forwarder.stallResponseAfterForward(request -> request.startsWith("POST /api/v1/jobs"), Duration.ofSeconds(8));
            Cli timedOut = cli(work, cliPort, tenant, principal, ownerToken, stalled, 1_500);
            forwarder.clearFault();
            assertThat(timedOut.exit).as(timedOut.toString()).isNotZero();
            JsonNode timedOutItem = timedOut.stdoutJson().path("items").get(0);
            assertThat(timedOutItem.path("status").asString()).isEqualTo("OUTCOME_UNKNOWN");
            assertThat(timedOutItem.path("finality").asString()).isEqualTo("UNKNOWN");
            assertThat(timedOutItem.path("error").path("requestId").asString()).isEqualTo(stalledRequest);
            assertThat(timedOutItem.path("resume").path("requestId").asString()).isEqualTo(stalledRequest);
            assertThat(awaitCount("SELECT COUNT(*) FROM media_processing_jobs WHERE tenant_id=? AND request_id='"
                    + stalledRequest + "'", tenant, 1)).isEqualTo(1);
            Cli resumed = cli(work, cliPort, tenant, principal, ownerToken, stalled, 20_000);
            assertThat(resumed.exit).as(resumed.toString()).isZero();
            assertThat(resumed.stdoutJson().path("items").get(0).path("finality").asString()).isEqualTo("COMPLETED");
            assertThat(count("SELECT COUNT(*) FROM media_processing_jobs WHERE tenant_id=? AND request_id='"
                    + stalledRequest + "'", tenant)).isEqualTo(1);

            // ---- 5. Kill the real launcher before the second submit; same-file replay after restart converges. ----
            String firstRequest = "job-kill-a-" + run;
            String secondRequest = "job-kill-b-" + run;
            Path killed = batchFile(work, "killed", List.of(
                    submit("k1", artifactId, firstRequest, 10_000),
                    submit("k2", artifactId, secondRequest, 10_000),
                    submit("k3", artifactId, "job-kill-c-" + run, 10_000)));
            final Forwarder live = forwarder;
            long submitsBefore = forwarder.requestsMatching("POST /api/v1/jobs");
            forwarder.killBeforeForward(request -> request.startsWith("POST /api/v1/jobs")
                    && live.requestsMatching("POST /api/v1/jobs") >= submitsBefore + 2, () -> {
                        launcher[0].destroyForcibly();
                        launcher[0].waitFor(15, TimeUnit.SECONDS);
                    });
            Cli cut = cli(work, cliPort, tenant, principal, ownerToken, killed, 4_000);
            forwarder.clearFault();
            assertThat(launcher[0].isAlive()).isFalse();
            assertThat(cut.exit).as(cut.toString()).isNotZero();
            JsonNode cutItems = cut.stdoutJson().path("items");
            assertThat(statuses(cutItems)).containsExactly("SUCCESS", "OUTCOME_UNKNOWN", "NOT_RUN");
            assertThat(cutItems.get(0).path("finality").asString()).isEqualTo("COMPLETED");
            assertThat(cutItems.get(1).path("finality").asString()).isEqualTo("UNKNOWN");
            assertThat(cutItems.get(2).path("exitCode").isNull()).isTrue();
            assertThat(count("SELECT COUNT(*) FROM media_processing_jobs WHERE tenant_id=? AND request_id='job-kill-c-"
                    + run + "'", tenant)).isZero();
            assertThat(cutItems.get(1).path("resume").path("requestId").asString()).isEqualTo(secondRequest);
            assertThat(cut.stdoutJson().path("summary").path("success").asBoolean()).isFalse();
            assertThat(count("SELECT COUNT(*) FROM media_processing_jobs WHERE tenant_id=? AND request_id='"
                    + firstRequest + "'", tenant)).isEqualTo(1);

            launcher[0] = startLauncher(classpath, environment, log);
            awaitReady(launcher[0], port);
            Cli rerun = cli(work, cliPort, tenant, principal, ownerToken, killed, 20_000);
            assertThat(rerun.exit).as(rerun.toString()).isZero();
            assertThat(statuses(rerun.stdoutJson().path("items"))).containsOnly("SUCCESS");
            assertThat(rerun.stdoutJson().path("items").get(0).path("result").path("job").path("jobId").asString())
                    .isEqualTo(cutItems.get(0).path("result").path("job").path("jobId").asString());
            for (String request : List.of(firstRequest, secondRequest, "job-kill-c-" + run)) {
                assertThat(count("SELECT COUNT(*) FROM media_processing_jobs WHERE tenant_id=? AND request_id='"
                        + request + "'", tenant)).isEqualTo(1);
            }
        } finally {
            if (forwarder != null) forwarder.close();
            if (launcher[0] != null && launcher[0].isAlive()) stopLauncher(launcher[0]);
            deleteBucket(bucket);
            deleteTree(work);
        }
    }

    // ------------------------------------------------------------------ batch documents

    private static Map<String, Object> submit(String id, String artifactId, String requestId, int awaitMs) {
        return Map.of("id", id, "command", "job submit", "options", Map.of("artifact", artifactId,
                "request-id", requestId, "job-type", "TRANSCODE", "await-finality-ms", awaitMs));
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
            int requestTimeoutMs) throws Exception {
        return cliWithConfirmation(work, port, tenant, principal, token, batch,
                "sha256:" + sha256(Files.readAllBytes(batch)), requestTimeoutMs);
    }

    private static Cli cliWithConfirmation(Path work, int port, String tenant, String principal, String token,
            Path batch, String confirmation, int requestTimeoutMs) throws Exception {
        Path repoRoot = repoRoot();
        Path packageJson = repoRoot.resolve("libs/audio-video-client/package.json");
        String entrypoint = JSON.readTree(Files.readString(packageJson)).path("bin").path("ghatanamedia-api-dev").asString();
        assertThat(entrypoint).isEqualTo("./dist/cli-dev.js");
        Path cli = packageJson.getParent().resolve(entrypoint).normalize();
        assertThat(Files.isRegularFile(cli)).as("build @audio-video/client before running this DEV_ONLY IT").isTrue();
        List<String> command = new ArrayList<>(List.of("node", cli.toString(), "batch", "run",
                "--endpoint", "http://127.0.0.1:" + port, "--tenant", tenant, "--principal", principal,
                "--file", batch.toString(), "--confirm-sha256", confirmation));
        return invokeCli(work, command, token, requestTimeoutMs);
    }

    private static Cli cliCommand(Path work, int port, String tenant, String principal, String token,
            String... args) throws Exception {
        Path repoRoot = repoRoot();
        Path packageJson = repoRoot.resolve("libs/audio-video-client/package.json");
        String entrypoint = JSON.readTree(Files.readString(packageJson)).path("bin").path("ghatanamedia-api-dev").asString();
        assertThat(entrypoint).isEqualTo("./dist/cli-dev.js");
        Path cli = packageJson.getParent().resolve(entrypoint).normalize();
        assertThat(Files.isRegularFile(cli)).as("build @audio-video/client before running this DEV_ONLY IT").isTrue();
        List<String> command = new ArrayList<>(List.of("node", cli.toString(), args[0], args[1],
                "--endpoint", "http://127.0.0.1:" + port, "--tenant", tenant, "--principal", principal));
        for (int index = 2; index < args.length; index++) command.add(args[index]);
        return invokeCli(work, command, token, 20_000);
    }

    private static Cli invokeCli(Path work, List<String> command, String token, int requestTimeoutMs) throws Exception {
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
            throw new AssertionError("CLI command exceeded 120 seconds");
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
