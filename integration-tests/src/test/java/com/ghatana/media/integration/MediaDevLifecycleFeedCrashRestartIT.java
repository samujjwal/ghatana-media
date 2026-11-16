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
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * Transactional outbox relay and the public lifecycle event channel, through the real launcher process with PostgreSQL.
 * Real FFmpeg TRANSCODE jobs write their lifecycle rows in the job's own transaction; the relay publishes them into the
 * DEV_ONLY feed and marks a row published only after the feed commit. The launcher is hard-halted between the feed commit
 * and the mark: after a restart the same event is delivered again (higher deliveryNo, same eventRef), consumers dedupe by
 * eventRef, every consumer sees every event from its own cursor, and the job readback, never an event or a consumer
 * cursor, is the authority for the job's state.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevLifecycleFeedCrashRestartIT {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String DEV_SECRET = "media-dev-lifecycle-feed-secret-0123456789";
    private static final String REDACTION_KEY = "media-dev-lifecycle-feed-redaction-key-0123456789";
    private static final String PROVIDER = "local-ffmpeg-transcode";
    private static final List<String> DEFAULT_PERMISSIONS = List.of("media:artifact:create", "media:artifact:write",
            "media:artifact:read", "media:job:create", "media:job:read", "media:project:dev:read");

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private record Fixture(String run, String tenant, String principal, String bucket, int port, Path spool, Path log,
                           Path faultMarker, String classpath, Map<String, String> environment) { }

    private record Source(String artifactId, String sha256) { }

    private record Pulled(long cursor, int deliveryNo, JsonNode event) { }

    @Test
    void crashBetweenFeedCommitAndMarkRedeliversAndConsumersDedupeWithReadbackParity() throws Exception {
        Fixture f = fixture();
        Process launcher = null;
        try {
            launcher = start(f, false, 200);
            String owner = token(f.tenant, f.principal, DEFAULT_PERMISSIONS);

            // ---- Phase 1: a healthy relay. Job A runs to COMPLETED; its outbox rows reach the feed and are marked.
            Source a = upload(f, owner, 1);
            String jobA = submit(f, owner, a, "a-" + f.run).path("jobId").asString();
            JsonNode finalA = awaitStatus(f, owner, jobA, "COMPLETED", 60);
            long versionA = finalA.path("version").asLong();

            List<Pulled> consumerX = new ArrayList<>();
            long cursorX = pullUntil(f, owner, 0, consumerX, 2, 30);
            assertThat(consumerX).hasSize(2);
            assertThat(consumerX.get(0).event().path("eventType").asString()).isEqualTo("media.job.accepted");
            JsonNode completedA = consumerX.get(1).event();
            assertThat(completedA.path("eventType").asString()).isEqualTo("media.job.completed");
            for (Pulled pulled : consumerX) {
                assertThat(pulled.deliveryNo()).isEqualTo(1);
                assertEnvelopeAbi(pulled.event());
                assertThat(pulled.event().path("appendFinality").asString()).isEqualTo("NON_FINAL_APPEND");
            }
            assertThat(completedA.path("terminalReadbackRequired").asBoolean()).isTrue();
            assertThat(consumerX.get(0).event().path("aggregateRef")).isEqualTo(completedA.path("aggregateRef"));
            assertThat(consumerX.get(0).event().path("aggregateVersion").asLong())
                    .isLessThan(completedA.path("aggregateVersion").asLong());

            // Readback parity: the event says COMPLETED at version N and the authoritative readback agrees.
            String refA = completedA.path("aggregateRef").asString();
            JsonNode readbackA = readback(f, owner, refA);
            assertThat(readbackA.path("authority").asString()).isEqualTo("JOB_STORE_READBACK");
            assertThat(readbackA.path("status").asString()).isEqualTo("COMPLETED");
            assertThat(readbackA.path("terminal").asBoolean()).isTrue();
            assertThat(readbackA.path("version").asLong()).isEqualTo(completedA.path("aggregateVersion").asLong())
                    .isEqualTo(versionA);
            assertThat(readbackA.path("jobId").asString()).isEqualTo(jobA);

            // A lost acknowledgement: the consumer never advanced its cursor, asks again, and gets the identical entries;
            // nothing about the job changed.
            List<Pulled> again = new ArrayList<>();
            pullUntil(f, owner, 0, again, 2, 30);
            assertThat(again).extracting(p -> p.event().path("eventRef").asString())
                    .containsExactlyElementsOf(consumerX.stream().map(p -> p.event().path("eventRef").asString()).toList());
            assertThat(get(f, owner, jobA)).isEqualTo(finalA);

            // The feed never carries raw identifiers and publishes its JSON Schema.
            String feedBody = http(f, f.tenant, owner, "/dev/v1/lifecycle-events?after=0").body();
            assertThat(feedBody).doesNotContain(jobA).doesNotContain(f.tenant).doesNotContain(f.principal);
            JsonNode schema = JSON.readTree(http(f, f.tenant, owner, "/dev/v1/lifecycle-events/schema").body());
            assertThat(schema.path("$id").asString()).isEqualTo("urn:ghatana:media-public-lifecycle-event:v1");
            Set<String> required = new LinkedHashSet<>();
            schema.path("required").forEach(n -> required.add(n.asString()));
            Set<String> actualFields = new LinkedHashSet<>();
            completedA.propertyNames().forEach(actualFields::add);
            assertThat(actualFields).isEqualTo(required);

            // Auth, tenant and principal isolation on the feed and the readback.
            assertThat(httpNoAuth(f, f.tenant, "/dev/v1/lifecycle-events").statusCode()).isEqualTo(401);
            String noJobRead = token(f.tenant, f.principal, List.of("media:project:dev:read"));
            assertThat(http(f, f.tenant, noJobRead, "/dev/v1/lifecycle-events").statusCode()).isEqualTo(403);
            assertThat(http(f, f.tenant, noJobRead, "/dev/v1/lifecycle-events/jobs/" + refA).statusCode()).isEqualTo(403);
            String otherTenant = "tenant-other-" + f.run;
            String foreign = token(otherTenant, f.principal, DEFAULT_PERMISSIONS);
            assertThat(JSON.readTree(http(f, otherTenant, foreign, "/dev/v1/lifecycle-events?after=0").body())
                    .path("entries").size()).isZero();
            assertThat(http(f, otherTenant, foreign, "/dev/v1/lifecycle-events/jobs/" + refA).statusCode()).isEqualTo(404);
            String sibling = token(f.tenant, "principal-sibling-" + f.run, DEFAULT_PERMISSIONS);
            assertThat(JSON.readTree(http(f, f.tenant, sibling, "/dev/v1/lifecycle-events?after=0").body())
                    .path("entries").size()).isZero();
            assertThat(http(f, f.tenant, sibling, "/dev/v1/lifecycle-events/jobs/" + refA).statusCode()).isEqualTo(404);
            assertThat(http(f, f.tenant, owner, "/dev/v1/lifecycle-events?after=-1").statusCode()).isEqualTo(400);
            assertThat(http(f, f.tenant, owner, "/dev/v1/lifecycle-events?limit=0").statusCode()).isEqualTo(400);
            assertThat(http(f, f.tenant, owner, "/dev/v1/lifecycle-events/jobs/" + "r1_" + "0".repeat(64)).statusCode())
                    .isEqualTo(404);
            await(() -> unpublishedOutboxRows(f) == 0, 30, "all of job A's outbox rows are marked published");

            // ---- Phase 2: restart with the crash seam; job B's first feed commit halts the launcher before the mark.
            stop(launcher);
            launcher = start(f, true, 3_000);
            owner = token(f.tenant, f.principal, DEFAULT_PERMISSIONS);
            Source b = upload(f, owner, 2);
            String jobB = submit(f, owner, b, "b-" + f.run).path("jobId").asString();
            assertThat(launcher.waitFor(60, TimeUnit.SECONDS)).as("launcher halted between publish and mark").isTrue();
            assertThat(launcher.exitValue()).isEqualTo(137);
            launcher = null;
            assertThat(Files.exists(f.faultMarker)).isTrue();
            // The feed holds the first delivery, but the outbox row was never marked published.
            assertThat(feedDeliveries(f, "accepted")).containsExactly(1);
            assertThat(unpublishedOutboxRows(f)).as("rows relayed to the feed but not marked").isGreaterThanOrEqualTo(1);

            // ---- Phase 3: restart. The claim lease expires, the row is relayed again, consumers dedupe by eventRef.
            launcher = start(f, true, 200);
            owner = token(f.tenant, f.principal, DEFAULT_PERMISSIONS);
            JsonNode finalB = awaitTerminal(f, owner, jobB, 120);
            await(() -> unpublishedOutboxRows(f) == 0, 60, "every outbox row is marked published after the restart");

            List<Pulled> consumerXTail = new ArrayList<>();
            pullUntil(f, owner, cursorX, consumerXTail, 3, 60);
            List<Pulled> consumerY = new ArrayList<>();
            pullUntil(f, owner, 0, consumerY, 5, 60);

            List<Pulled> redelivered = consumerXTail.stream().filter(p -> p.deliveryNo() > 1).toList();
            assertThat(redelivered).as("the crashed publication is delivered again").hasSize(1);
            assertThat(redelivered.getFirst().event().path("eventType").asString()).isEqualTo("media.job.accepted");
            assertThat(redelivered.getFirst().deliveryNo()).isEqualTo(2);

            // Consumer X (resuming from its own cursor) and consumer Y (from zero) dedupe by eventRef and converge.
            Map<String, JsonNode> xEvents = dedupe(consumerXTail);
            Map<String, JsonNode> yEvents = dedupe(consumerY);
            assertThat(xEvents).hasSize(2); // accepted + terminal of job B
            assertThat(yEvents).hasSize(4); // job A and job B, once each per eventRef
            assertThat(yEvents.keySet()).containsAll(xEvents.keySet());
            assertThat(yEvents.keySet()).containsAll(consumerX.stream().map(p -> p.event().path("eventRef").asString()).toList());
            // Cursors are strictly increasing; per-aggregate versions never go backwards among first deliveries.
            long last = 0;
            for (Pulled pulled : consumerY) { assertThat(pulled.cursor()).isGreaterThan(last); last = pulled.cursor(); }
            Map<String, Long> versions = new LinkedHashMap<>();
            for (Pulled pulled : consumerY) {
                if (pulled.deliveryNo() > 1) continue;
                String aggregate = pulled.event().path("aggregateRef").asString();
                long version = pulled.event().path("aggregateVersion").asLong();
                assertThat(version).isGreaterThan(versions.getOrDefault(aggregate, 0L));
                versions.put(aggregate, version);
            }

            // Readback parity for job B: whatever the terminal event says, the job store agrees, version included.
            JsonNode terminalB = xEvents.values().stream().filter(e -> e.path("terminalReadbackRequired").asBoolean())
                    .findFirst().orElseThrow();
            String refB = terminalB.path("aggregateRef").asString();
            JsonNode readbackB = readback(f, owner, refB);
            assertThat(readbackB.path("jobId").asString()).isEqualTo(jobB);
            assertThat(readbackB.path("status").asString()).isEqualTo(finalB.path("status").asString());
            assertThat("media.job." + readbackB.path("status").asString().toLowerCase(java.util.Locale.ROOT))
                    .isEqualTo(terminalB.path("eventType").asString());
            assertThat(readbackB.path("version").asLong()).isEqualTo(terminalB.path("aggregateVersion").asLong());
            assertThat(readbackB.path("terminal").asBoolean()).isTrue();
            // Job A is untouched by the crash and the redelivery.
            assertThat(get(f, owner, jobA)).isEqualTo(finalA);
        } finally {
            if (launcher != null) launcher.destroyForcibly();
            cleanup(f);
        }
    }

    // ---- helpers ------------------------------------------------------------------------------------------------

    private static void assertEnvelopeAbi(JsonNode event) {
        assertThat(event.path("schemaVersion").asString()).isEqualTo("1.0.0");
        for (String ref : List.of("eventRef", "tenantRef", "principalRef", "correlationRef", "aggregateRef")) {
            assertThat(event.path(ref).asString()).matches("^r1_[0-9a-f]{64}$");
        }
        assertThat(event.path("aggregateType").asString()).isEqualTo("job");
        assertThat(event.path("aggregateVersion").isIntegralNumber()).isTrue();
    }

    private static Map<String, JsonNode> dedupe(List<Pulled> pulled) {
        Map<String, JsonNode> byRef = new LinkedHashMap<>();
        for (Pulled entry : pulled) {
            JsonNode previous = byRef.put(entry.event().path("eventRef").asString(), entry.event());
            if (previous != null) assertThat(entry.event()).as("a redelivery is the identical event").isEqualTo(previous);
        }
        return byRef;
    }

    /** Pulls pages from {@code after} until at least {@code wanted} entries were collected; returns the cursor reached. */
    private static long pullUntil(Fixture f, String token, long after, List<Pulled> out, int wanted, int seconds)
            throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        long cursor = after;
        while (System.nanoTime() < deadline) {
            HttpResponse<String> response = http(f, f.tenant, token, "/dev/v1/lifecycle-events?limit=50&after=" + cursor);
            assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
            JsonNode page = JSON.readTree(response.body());
            assertThat(page.path("delivery").asString()).isEqualTo("AT_LEAST_ONCE");
            assertThat(page.path("finality").asString()).isEqualTo("NON_FINAL_APPEND");
            for (JsonNode entry : page.path("entries")) {
                out.add(new Pulled(entry.path("cursor").asLong(), entry.path("deliveryNo").asInt(), entry.path("event")));
            }
            cursor = page.path("nextCursor").asLong();
            if (out.size() >= wanted) {
                // One more empty-page read proves nothing else is pending beyond what the caller expects.
                return cursor;
            }
            Thread.sleep(200);
        }
        throw new AssertionError("expected " + wanted + " feed entries but pulled " + out.size());
    }

    private static JsonNode readback(Fixture f, String token, String aggregateRef) throws Exception {
        HttpResponse<String> response = http(f, f.tenant, token, "/dev/v1/lifecycle-events/jobs/" + aggregateRef);
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        return JSON.readTree(response.body());
    }

    private static long unpublishedOutboxRows(Fixture f) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT (SELECT COUNT(*) FROM media_lifecycle_outbox WHERE tenant_id=? AND published_at IS NULL "
                             + "AND event_type IN ('MEDIA_JOB_ACCEPTED','MEDIA_JOB_COMPLETED','MEDIA_JOB_FAILED','MEDIA_JOB_CANCELLED')) "
                             + "+ (SELECT COUNT(*) FROM media_processing_lifecycle_outbox WHERE tenant_id=? AND published_at IS NULL "
                             + "AND dead_lettered_at IS NULL AND event_type IN ('media.job.completed','media.job.failed','media.job.cancelled'))")) {
            statement.setString(1, f.tenant);
            statement.setString(2, f.tenant);
            try (var rows = statement.executeQuery()) { rows.next(); return rows.getLong(1); }
        }
    }

    private static List<Integer> feedDeliveries(Fixture f, String typeSuffix) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT delivery_no FROM media_dev_lifecycle_feed WHERE tenant_id=? AND event_type=? "
                             + "ORDER BY feed_seq")) {
            statement.setString(1, f.tenant);
            statement.setString(2, "media.job." + typeSuffix);
            List<Integer> numbers = new ArrayList<>();
            try (var rows = statement.executeQuery()) { while (rows.next()) numbers.add(rows.getInt(1)); }
            // Job A's accepted entry (delivery 1) was committed before the crash; only job B's is the crashed one.
            return numbers.size() > 1 ? numbers.subList(1, numbers.size()) : numbers;
        }
    }

    private interface Condition { boolean check() throws Exception; }

    private static void await(Condition condition, int seconds, String what) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        while (System.nanoTime() < deadline) {
            if (condition.check()) return;
            Thread.sleep(250);
        }
        throw new AssertionError("timed out: " + what);
    }

    private static Fixture fixture() throws Exception {
        String ffmpeg = System.getenv("MEDIA_FFMPEG"), ffprobe = System.getenv("MEDIA_FFPROBE");
        Assumptions.assumeTrue(ffmpeg != null && ffprobe != null, "MEDIA_FFMPEG and MEDIA_FFPROBE must name a working FFmpeg pair");
        String run = UUID.randomUUID().toString().replace("-", "");
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        String bucket = "media-lifecycle-feed-" + run;
        try (S3Client s3 = s3()) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
        Path services = Files.createTempDirectory("media-lifecycle-feed-services-");
        installDescriptors(services);
        String childClasspath = System.getProperty("media.child.classpath", "");
        assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
        Path spool = Files.createTempDirectory("media-lifecycle-feed-spool-");
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
        env.put("MEDIA_DEV_LIFECYCLE_FEED", "true");
        env.put("MEDIA_DEV_LIFECYCLE_FEED_REDACTION_KEY", REDACTION_KEY);
        env.put("MEDIA_DEV_LIFECYCLE_FEED_CLAIM_MS", "2000");
        return new Fixture(run, "tenant-lifecycle-feed-" + run, "principal-lifecycle-feed-" + run, bucket, port, spool,
                Files.createTempFile("media-lifecycle-feed-process-", ".log"),
                Files.createTempDirectory("media-lifecycle-feed-fault-").resolve("halt.marker"),
                services + java.io.File.pathSeparator + childClasspath, env);
    }

    private static Process start(Fixture f, boolean withFault, int relayIntervalMs) throws Exception {
        Map<String, String> env = new HashMap<>(f.environment);
        env.put("MEDIA_DEV_RENDER_FFMPEG", System.getenv("MEDIA_FFMPEG"));
        env.put("MEDIA_DEV_RENDER_FFPROBE", System.getenv("MEDIA_FFPROBE"));
        env.put("MEDIA_DEV_FFMPEG_JOB_SPOOL", f.spool.toString());
        env.put("MEDIA_DEV_LIFECYCLE_FEED_INTERVAL_MS", Integer.toString(relayIntervalMs));
        if (withFault) env.put("MEDIA_DEV_LIFECYCLE_FEED_FAULT_MARKER", f.faultMarker.toString());
        String javaBin = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        ProcessBuilder builder = new ProcessBuilder(javaBin, "-Dmedia.lifecycle.outbox.claimLeaseMillis=2000", "-cp", f.classpath, "com.ghatana.media.launcher.MediaLauncher");
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

    private static String token(String tenant, String principal, List<String> permissions) throws Exception {
        Path repoRoot = repoRoot();
        List<String> command = new ArrayList<>(List.of("node", "scripts/media-dev-identity-token.mjs",
                "--tenant", tenant, "--subject", principal, "--expires-in", "300"));
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

    private static HttpResponse<String> http(Fixture f, String tenant, String token, String path) throws Exception {
        return HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + f.port + path))
                .header("X-Tenant-Id", tenant).header("Authorization", "Bearer " + token).GET().build(),
                HttpResponse.BodyHandlers.ofString());
    }

    private static HttpResponse<String> httpNoAuth(Fixture f, String tenant, String path) throws Exception {
        return HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + f.port + path))
                .header("X-Tenant-Id", tenant).GET().build(), HttpResponse.BodyHandlers.ofString());
    }

    private static HttpResponse<String> post(Fixture f, String token, String path, String body) throws Exception {
        return HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + f.port + path))
                .header("X-Tenant-Id", f.tenant).header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body)).build(),
                HttpResponse.BodyHandlers.ofString());
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
        HttpResponse<String> started = HttpClient.newHttpClient().send(
                HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + f.port + "/api/v1/artifacts/uploads"))
                        .header("X-Tenant-Id", f.tenant).header("Authorization", "Bearer " + token)
                        .header("Content-Type", "application/json")
                        .header("Idempotency-Key", "lifecycle-feed-" + f.run + "-" + seed)
                        .POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
        assertThat(started.statusCode()).as(started.body()).isEqualTo(201);
        String uploadId = JSON.readTree(started.body()).path("uploadId").asString();
        HttpResponse<String> ack = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create(
                        "http://127.0.0.1:" + f.port + "/api/v1/artifacts/uploads/" + uploadId + "/chunks/0"))
                .header("X-Tenant-Id", f.tenant).header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/octet-stream")
                .PUT(HttpRequest.BodyPublishers.ofByteArray(wav)).build(), HttpResponse.BodyHandlers.ofString());
        assertThat(ack.statusCode()).as(ack.body()).isEqualTo(200);
        HttpResponse<String> done = post(f, token, "/api/v1/artifacts/uploads/" + uploadId + "/complete", "");
        assertThat(done.statusCode()).as(done.body()).isEqualTo(201);
        return new Source(JSON.readTree(done.body()).path("artifactId").asString(), digest);
    }

    private static JsonNode submit(Fixture f, String token, Source source, String requestId) throws Exception {
        String request = """
                {"requestId":"%s","tenantId":"%s","principalId":"%s","correlationId":"corr-%s","artifactId":"%s",
                 "expectedArtifactVersion":"sha256:%s","jobType":"TRANSCODE","providerHint":"%s",
                 "parameters":{"container":"flac","sampleRateHz":8000,"channels":1}}
                """.formatted(requestId, f.tenant, f.principal, requestId, source.artifactId(), source.sha256(), PROVIDER);
        HttpResponse<String> response = post(f, token, "/api/v1/jobs", request);
        assertThat(response.statusCode()).as(response.body()).isIn(200, 202);
        return JSON.readTree(response.body());
    }

    private static JsonNode get(Fixture f, String token, String jobId) throws Exception {
        HttpResponse<String> response = http(f, f.tenant, token, "/api/v1/jobs/" + jobId);
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
            if (List.of("COMPLETED", "FAILED", "CANCELLED").contains(job.path("status").asString())) return job;
            Thread.sleep(500);
        }
        throw new AssertionError("job " + jobId + " did not reach COMPLETED/FAILED/CANCELLED: " + job);
    }

    private static void cleanup(Fixture f) {
        try (S3Client s3 = s3()) {
            var objects = s3.listObjectsV2(builder -> builder.bucket(f.bucket));
            objects.contents().forEach(object -> s3.deleteObject(builder -> builder.bucket(f.bucket).key(object.key())));
            s3.deleteBucket(builder -> builder.bucket(f.bucket));
        } catch (Exception ignored) { }
        try (var walk = Files.walk(f.spool)) {
            walk.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
        } catch (Exception ignored) { }
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
