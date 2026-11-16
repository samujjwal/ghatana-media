package com.ghatana.media.integration;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.images.builder.Transferable;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import tools.jackson.databind.JsonNode;

import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static com.ghatana.media.integration.MediaDevLiveSessionSupport.Client;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * {@code media.dev.service-observability}: a REAL launcher process, a REAL Prometheus scraping it every second with
 * the repository's own rule file, and a REAL Alertmanager delivering to a local webhook receiver. Everything is
 * observed through the Prometheus and Alertmanager HTTP APIs and the launcher's {@code /metrics}:
 *
 * <ol>
 *   <li>readiness is the real probe verdict (FFmpeg ready; models that are not installed are never "ready");</li>
 *   <li>load at 1, 16 and 64 concurrent clients on a cheap CPU lane (artifact intake against PostgreSQL + S3): the
 *       server-side per-lane counters equal the client-side request counts exactly and the histogram is reported;</li>
 *   <li>typed refusals (401, 404, capacity 429) are counted as REFUSED, never FAILED;</li>
 *   <li>alerts fire and clear: provider outage (FFmpeg removed then restored), budget saturation and capacity refusals
 *       (live sessions at the ceiling then released), disk budget (reserve above the free space, then restored),
 *       launcher down (process killed);</li>
 *   <li>restart: counters honestly reset (process-local, not persisted), and readiness is re-derived by the new
 *       process from a live probe rather than carried over;</li>
 *   <li>no tenant, principal, artifact id, path, credential or schema name reaches any metric label or value.</li>
 * </ol>
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class MediaDevServiceObservabilityIT {
    private static final String PROMETHEUS_IMAGE =
            "prom/prometheus@sha256:fa3302279710be2f21a8301ec17a8b4f2301fd829bd113839b3b6b02b6f191a2";
    private static final String ALERTMANAGER_IMAGE =
            "prom/alertmanager@sha256:286ad8838533a5a01d89bd09643f43d2b68b65203123b5700e54a8f80ff9c1f4";
    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private static GenericContainer<?> prometheus;
    private static GenericContainer<?> alertmanager;
    private static HttpServer webhook;
    private static final List<JsonNode> WEBHOOKS = new CopyOnWriteArrayList<>();

    private static String run;
    private static String tenant;
    private static String principal;
    private static String token;
    private static String bucket;
    private static String schema;
    private static int port;
    private static int promPort;
    private static int amPort;
    private static Path work;
    private static Path services;
    private static Path injectDir;
    private static Path log;
    private static Path liveSpool;
    private static String classpath;
    private static Process launcher;
    private static MediaDevFaultInjector.ModeScript ffmpegScript;
    private static boolean ffmpegAway;
    private static boolean passed;
    private static final Set<String> ISSUED_IDS = ConcurrentSet.create();
    private static final StringBuilder REPORT = new StringBuilder();

    /** A concurrent string set without a diamond-typed static factory noise. */
    private static final class ConcurrentSet {
        static Set<String> create() { return java.util.concurrent.ConcurrentHashMap.newKeySet(); }
    }

    // ------------------------------------------------------------------------------------------------ set up

    @BeforeAll
    static void startStack() throws Exception {
        assertThat(MediaDevVoiceJourneySupport.ffmpeg()).as("MEDIA_DEV_RENDER_FFMPEG").isNotBlank();
        run = UUID.randomUUID().toString().replace("-", "");
        tenant = "tenant-dev-obs-" + run;
        principal = "principal-dev-obs-" + run;
        bucket = "media-dev-obs-" + run.substring(0, 16);
        schema = "media_dev_obs_" + run;
        port = freePort();
        promPort = freePort();
        amPort = freePort();
        work = Files.createTempDirectory("media-obs-work-");
        services = Files.createTempDirectory("media-obs-services-");
        injectDir = Files.createTempDirectory("media-obs-inject-");
        log = Files.createTempFile("media-obs-process-", ".log");
        liveSpool = work.resolve("live-spool");
        try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
        installDescriptors(services);
        String childClasspath = System.getProperty("media.child.classpath", "");
        assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
        classpath = services + java.io.File.pathSeparator + childClasspath;
        ffmpegScript = MediaDevFaultInjector.ModeScript.ffmpeg(injectDir, Path.of(MediaDevVoiceJourneySupport.ffmpeg()));

        webhook = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        webhook.createContext("/hook", exchange -> {
            byte[] body = exchange.getRequestBody().readAllBytes();
            try { WEBHOOKS.add(JSON.readTree(new String(body, StandardCharsets.UTF_8))); } catch (RuntimeException ignored) { }
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        webhook.start();
        int webhookPort = webhook.getAddress().getPort();

        String rules = Files.readString(locate("infra/monitoring/alerts/media-launcher.yml"));
        String amConfig = """
                route:
                  receiver: sink
                  group_by: [alertname, provider, lane, resource, volume]
                  group_wait: 1s
                  group_interval: 2s
                  repeat_interval: 1h
                receivers:
                  - name: sink
                    webhook_configs:
                      - url: http://127.0.0.1:%d/hook
                        send_resolved: true
                """.formatted(webhookPort);
        String promConfig = """
                global:
                  scrape_interval: 1s
                  scrape_timeout: 1s
                  evaluation_interval: 1s
                rule_files: ["/etc/prometheus/media-launcher.yml"]
                alerting:
                  alertmanagers:
                    - static_configs:
                        - targets: ["127.0.0.1:%d"]
                scrape_configs:
                  - job_name: media-launcher
                    metrics_path: /metrics
                    static_configs:
                      - targets: ["127.0.0.1:%d"]
                """.formatted(amPort, port);
        alertmanager = new GenericContainer<>(DockerImageName.parse(ALERTMANAGER_IMAGE))
                .withNetworkMode("host")
                .withCopyToContainer(Transferable.of(amConfig, 0644), "/etc/alertmanager/alertmanager.yml")
                .withCommand("--config.file=/etc/alertmanager/alertmanager.yml", "--storage.path=/alertmanager",
                        "--web.listen-address=127.0.0.1:" + amPort, "--cluster.listen-address=")
                .waitingFor(Wait.forLogMessage(".*Listening on.*", 1).withStartupTimeout(Duration.ofSeconds(60)));
        alertmanager.start();
        prometheus = new GenericContainer<>(DockerImageName.parse(PROMETHEUS_IMAGE))
                .withNetworkMode("host")
                .withCopyToContainer(Transferable.of(promConfig, 0644), "/etc/prometheus/prometheus.yml")
                .withCopyToContainer(Transferable.of(rules, 0644), "/etc/prometheus/media-launcher.yml")
                .withCommand("--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.path=/tmp/tsdb",
                        "--web.listen-address=127.0.0.1:" + promPort)
                .waitingFor(Wait.forLogMessage(".*Server is ready to receive web requests.*", 1)
                        .withStartupTimeout(Duration.ofSeconds(60)));
        prometheus.start();

        startLauncherProcess(Map.of());
        token = issueDevToken(tenant, principal);
    }

    @AfterAll
    static void tearDown() throws Exception {
        System.out.println("SERVICE-OBSERVABILITY REPORT\n" + REPORT);
        try { if (launcher != null && launcher.isAlive()) stopLauncher(launcher); } catch (Exception ignored) { }
        if (prometheus != null) prometheus.stop();
        if (alertmanager != null) alertmanager.stop();
        if (webhook != null) webhook.stop(0);
        deleteTree(services);
        deleteTree(work);
        deleteTree(injectDir);
        dropSchema(POSTGRES, schema);
        deleteBucket(LOCALSTACK, bucket);
        if (passed) Files.deleteIfExists(log); else System.out.println("OBS-IT launcher log kept at " + log);
    }

    private static int freePort() throws Exception {
        try (var socket = new java.net.ServerSocket(0)) { return socket.getLocalPort(); }
    }

    private static Path locate(String relative) {
        Path root = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (root != null && !Files.exists(root.resolve(relative))) root = root.getParent();
        if (root == null) throw new AssertionError("could not locate " + relative);
        return root.resolve(relative);
    }

    /** (Re)start the real launcher on the same port; extra environment overrides the defaults. */
    private static void startLauncherProcess(Map<String, String> overrides) throws Exception {
        Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
        environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
        environment.put("MEDIA_MAX_BODY_BYTES", Integer.toString(16 * 1024 * 1024));
        environment.put("MEDIA_MAX_CHUNK_BYTES", Integer.toString(16 * 1024 * 1024));
        environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpegScript.path().toString());
        environment.put("MEDIA_DEV_RENDER_FFPROBE", MediaDevVoiceJourneySupport.ffprobe());
        environment.put("MEDIA_DEV_LIVE_SESSION_DIR", liveSpool.toString());
        environment.put("MEDIA_DEV_LIVE_MAX_OPEN_SESSIONS", "2");
        environment.put("MEDIA_DEV_LIVE_GLOBAL_BUFFER_BYTES", Integer.toString(256 * 1024));
        environment.put("MEDIA_DEV_COMPOSITE_SPACE_RESERVE_BYTES", Long.toString(1L << 20));
        environment.put("MEDIA_DEV_PROVIDER_CATALOG_TTL_SECONDS", "1");
        environment.put("MEDIA_DEV_PROVIDER_CATALOG_REFRESH_SECONDS", "1");
        environment.putAll(overrides);
        launcher = startLauncher(classpath, environment, log);
        awaitReady(launcher, port);
    }

    private static void killLauncher() throws Exception {
        launcher.destroyForcibly();
        assertThat(launcher.waitFor(10, TimeUnit.SECONDS)).isTrue();
    }

    // ------------------------------------------------------------------------- Prometheus / Alertmanager clients

    private static String body(String url) throws Exception {
        return HTTP.send(HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(10)).GET().build(),
                HttpResponse.BodyHandlers.ofString()).body();
    }

    /** One instant-query sample: labels and value. */
    private record Sample(Map<String, String> labels, double value) { }

    private static List<Sample> query(String promql) throws Exception {
        JsonNode root = JSON.readTree(body("http://127.0.0.1:" + promPort + "/api/v1/query?query="
                + URLEncoder.encode(promql, StandardCharsets.UTF_8)));
        assertThat(root.path("status").asString()).as(promql).isEqualTo("success");
        List<Sample> out = new ArrayList<>();
        for (JsonNode row : root.path("data").path("result")) {
            Map<String, String> labels = new TreeMap<>();
            row.path("metric").properties().forEach(entry -> labels.put(entry.getKey(), entry.getValue().asString()));
            out.add(new Sample(labels, Double.parseDouble(row.path("value").get(1).asString())));
        }
        return out;
    }

    private static double scalar(String promql) throws Exception {
        List<Sample> samples = query(promql);
        return samples.isEmpty() ? Double.NaN : samples.get(0).value();
    }

    private static boolean promAlert(String alertname, String labelKey, String labelValue, String state) throws Exception {
        JsonNode alerts = JSON.readTree(body("http://127.0.0.1:" + promPort + "/api/v1/alerts")).path("data").path("alerts");
        for (JsonNode alert : alerts) {
            JsonNode labels = alert.path("labels");
            if (alertname.equals(labels.path("alertname").asString())
                    && (labelKey == null || labelValue.equals(labels.path(labelKey).asString()))
                    && state.equals(alert.path("state").asString())) return true;
        }
        return false;
    }

    private static boolean amActive(String alertname, String labelKey, String labelValue) throws Exception {
        JsonNode alerts = JSON.readTree(body("http://127.0.0.1:" + amPort + "/api/v2/alerts?active=true&silenced=false&inhibited=false"));
        for (JsonNode alert : alerts) {
            JsonNode labels = alert.path("labels");
            if (alertname.equals(labels.path("alertname").asString())
                    && (labelKey == null || labelValue.equals(labels.path(labelKey).asString()))
                    && "active".equals(alert.path("status").path("state").asString())) return true;
        }
        return false;
    }

    private static boolean webhookSaw(String status, String alertname, String labelKey, String labelValue) {
        for (JsonNode delivery : WEBHOOKS) {
            for (JsonNode alert : delivery.path("alerts")) {
                JsonNode labels = alert.path("labels");
                if (status.equals(alert.path("status").asString()) && alertname.equals(labels.path("alertname").asString())
                        && (labelKey == null || labelValue.equals(labels.path(labelKey).asString()))) return true;
            }
        }
        return false;
    }

    private static void await(String what, Duration timeout, BooleanSupplierWithException condition) throws Exception {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            try { if (condition.getAsBoolean()) return; } catch (java.io.IOException transientFailure) { /* retried */ }
            Thread.sleep(500);
        }
        throw new AssertionError("timed out after " + timeout + " waiting for: " + what);
    }

    @FunctionalInterface
    private interface BooleanSupplierWithException { boolean getAsBoolean() throws Exception; }

    // ------------------------------------------------------------------------------------- /metrics parsing

    private static final Pattern LINE = Pattern.compile("^([a-zA-Z_:][a-zA-Z0-9_:]*)(\\{(.*)\\})? (\\S+)$");
    private static final Pattern LABEL = Pattern.compile("([a-zA-Z_][a-zA-Z0-9_]*)=\"((?:[^\"\\\\]|\\\\.)*)\"");

    private record Series(String name, Map<String, String> labels, double value) { }

    private static String scrapeText() throws Exception {
        HttpResponse<String> response = HTTP.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/metrics"))
                .header("Accept", "text/plain; version=0.0.4").GET().build(), HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).isEqualTo(200);
        return response.body();
    }

    private static List<Series> scrape() throws Exception {
        List<Series> out = new ArrayList<>();
        for (String line : scrapeText().split("\n")) {
            if (line.isBlank() || line.startsWith("#")) continue;
            Matcher matcher = LINE.matcher(line);
            if (!matcher.matches()) continue;
            Map<String, String> labels = new TreeMap<>();
            if (matcher.group(3) != null) {
                Matcher label = LABEL.matcher(matcher.group(3));
                while (label.find()) labels.put(label.group(1), label.group(2));
            }
            out.add(new Series(matcher.group(1), labels, Double.parseDouble(matcher.group(4))));
        }
        return out;
    }

    private static double laneRequests(List<Series> all, String lane, String outcome) {
        return all.stream().filter(s -> s.name().equals("media_lane_requests_total") && lane.equals(s.labels().get("lane"))
                && (outcome == null || outcome.equals(s.labels().get("outcome")))).mapToDouble(Series::value).sum();
    }

    /** Cumulative histogram buckets for a lane (le -> count). */
    private static TreeMap<Double, Double> laneBuckets(List<Series> all, String lane) {
        TreeMap<Double, Double> out = new TreeMap<>();
        for (Series s : all) {
            if (s.name().equals("media_lane_request_duration_seconds_bucket") && lane.equals(s.labels().get("lane"))) {
                String le = s.labels().get("le");
                out.put("+Inf".equals(le) ? Double.POSITIVE_INFINITY : Double.parseDouble(le), s.value());
            }
        }
        return out;
    }

    /** Quantile (ms) from the difference of two cumulative histograms, linear within the bucket like Prometheus. */
    private static double bucketQuantileMs(TreeMap<Double, Double> before, TreeMap<Double, Double> after, double q) {
        double total = after.getOrDefault(Double.POSITIVE_INFINITY, 0.0) - before.getOrDefault(Double.POSITIVE_INFINITY, 0.0);
        if (total <= 0) return Double.NaN;
        double rank = q * total;
        double lowerBound = 0, lowerCount = 0;
        for (var entry : after.entrySet()) {
            double count = entry.getValue() - before.getOrDefault(entry.getKey(), 0.0);
            if (count >= rank) {
                if (Double.isInfinite(entry.getKey())) return lowerBound * 1000;
                double span = count - lowerCount;
                return (lowerBound + (entry.getKey() - lowerBound) * (span <= 0 ? 1 : (rank - lowerCount) / span)) * 1000;
            }
            lowerBound = entry.getKey();
            lowerCount = count;
        }
        return Double.NaN;
    }

    // ---------------------------------------------------------------------------------------------- tests

    @Test
    @Order(1)
    void prometheusScrapesTheRealLauncherAndReadinessIsTheProbeVerdictNeverAssumed() throws Exception {
        await("Prometheus target up", Duration.ofSeconds(60), () -> scalar("up{job=\"media-launcher\"}") == 1.0);
        await("ffmpeg probed ready", Duration.ofSeconds(60),
                () -> scalar("media_dev_provider_state{provider=\"ffmpeg\",state=\"ready\"}") == 1.0);
        // The real FFmpeg answered -version/-encoders: ready, with a recent observation timestamp.
        assertThat(scalar("time() - media_dev_provider_checked_at_seconds{provider=\"ffmpeg\"}")).isBetween(-5.0, 30.0);
        // No model is installed or configured in this rig: none of them may ever be reported ready.
        for (String provider : List.of("whisper", "kokoro", "florence", "qwen")) {
            await(provider + " observed", Duration.ofSeconds(30),
                    () -> !query("media_dev_provider_state{provider=\"" + provider + "\",state=\"ready\"}").isEmpty());
            assertThat(scalar("media_dev_provider_state{provider=\"" + provider + "\",state=\"ready\"}"))
                    .as(provider + " must not be ready: no model is loaded").isEqualTo(0.0);
            assertThat(scalar("media_dev_provider_state{provider=\"" + provider + "\",state=\"unavailable\"}")
                    + scalar("media_dev_provider_state{provider=\"" + provider + "\",state=\"not_admitted\"}"))
                    .as(provider + " is observed unavailable or not admitted").isEqualTo(1.0);
        }
        // Budgets are exported from the live semaphores / volumes.
        assertThat(scalar("media_budget_limit{resource=\"live_sessions\"}")).isEqualTo(2.0);
        assertThat(scalar("media_budget_available{resource=\"live_sessions\"}")).isEqualTo(2.0);
        assertThat(scalar("media_budget_limit{resource=\"render_concurrency\"}")).isGreaterThanOrEqualTo(1.0);
        assertThat(scalar("media_budget_limit{resource=\"job_concurrency\"}")).isGreaterThanOrEqualTo(1.0);
        assertThat(scalar("media_disk_free_bytes{volume=\"render_scratch\"}")).isGreaterThan(1L << 20);
        assertThat(scalar("media_disk_reserve_bytes{volume=\"render_scratch\"}")).isEqualTo((double) (1L << 20));
        assertThat(scalar("media_disk_free_bytes{volume=\"live_spool\"}")).isGreaterThan(0.0);
        // No alert is firing for the healthy, probed FFmpeg lane.
        assertThat(promAlert("MediaDevProviderUnavailable", "provider", "ffmpeg", "firing")).isFalse();
        // The launcher is its own source of truth: the same series without Prometheus.
        assertThat(scrape().stream().anyMatch(s -> s.name().equals("media_dev_provider_state")
                && "ffmpeg".equals(s.labels().get("provider")) && "ready".equals(s.labels().get("state")) && s.value() == 1.0)).isTrue();
    }

    /** One intake operation (begin, one chunk, complete) = 3 requests on lane api_artifacts. */
    private record Op(boolean ok, long beginNanos, long chunkNanos, long completeNanos, String detail) { }

    private static Op intake(int index, SecureRandom random) throws Exception {
        byte[] bytes = solidPng(0xFF000000 | random.nextInt(0x1000000)); // a real, tiny, decodable image per request
        Map<String, Object> requestBody = Map.of(
                "tenantId", tenant, "principalId", principal, "fileName", "obs-" + index + ".png",
                "contentType", "image/png", "expectedSizeBytes", bytes.length, "expectedSha256", sha256(bytes),
                "classification", "INTERNAL", "retention", "P30D", "metadata", Map.of("scope", "DEV_ONLY", "fixture", "obs-load"));
        long t0 = System.nanoTime();
        HttpResponse<String> begun = HTTP.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/v1/artifacts/uploads"))
                .timeout(Duration.ofSeconds(60)).header("Authorization", "Bearer " + token).header("X-Tenant-Id", tenant)
                .header("Idempotency-Key", "obs-" + UUID.randomUUID()).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(requestBody))).build(), HttpResponse.BodyHandlers.ofString());
        long t1 = System.nanoTime();
        if (begun.statusCode() != 201) return new Op(false, t1 - t0, 0, 0, "begin " + begun.statusCode() + " " + begun.body());
        String uploadId = JSON.readTree(begun.body()).path("uploadId").asString();
        HttpResponse<String> chunk = HTTP.send(HttpRequest.newBuilder(URI.create(
                        "http://127.0.0.1:" + port + "/api/v1/artifacts/uploads/" + uploadId + "/chunks/0"))
                .timeout(Duration.ofSeconds(60)).header("Authorization", "Bearer " + token).header("X-Tenant-Id", tenant)
                .header("Content-Type", "application/octet-stream").PUT(HttpRequest.BodyPublishers.ofByteArray(bytes)).build(),
                HttpResponse.BodyHandlers.ofString());
        long t2 = System.nanoTime();
        HttpResponse<String> done = HTTP.send(HttpRequest.newBuilder(URI.create(
                        "http://127.0.0.1:" + port + "/api/v1/artifacts/uploads/" + uploadId + "/complete"))
                .timeout(Duration.ofSeconds(60)).header("Authorization", "Bearer " + token).header("X-Tenant-Id", tenant)
                .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofString());
        long t3 = System.nanoTime();
        boolean ok = chunk.statusCode() == 200 && done.statusCode() == 201;
        if (ok) ISSUED_IDS.add(JSON.readTree(done.body()).path("artifactId").asString());
        ISSUED_IDS.add(uploadId);
        return new Op(ok, t1 - t0, t2 - t1, t3 - t2, ok ? "" : "chunk " + chunk.statusCode() + " " + chunk.body()
                + " | complete " + done.statusCode() + " " + done.body());
    }

    private static void loadAt(int clients, int opsPerClient) throws Exception {
        List<Series> before = scrape();
        double requestsBefore = laneRequests(before, "api_artifacts", null);
        TreeMap<Double, Double> bucketsBefore = laneBuckets(before, "api_artifacts");
        ExecutorService pool = Executors.newFixedThreadPool(clients);
        List<Future<List<Op>>> futures = new ArrayList<>();
        long started = System.nanoTime();
        for (int c = 0; c < clients; c++) {
            final int client = c;
            futures.add(pool.submit(() -> {
                SecureRandom random = new SecureRandom();
                List<Op> ops = new ArrayList<>();
                for (int i = 0; i < opsPerClient; i++) ops.add(intake(client * 1000 + i, random));
                return ops;
            }));
        }
        List<Op> all = new ArrayList<>();
        for (Future<List<Op>> future : futures) all.addAll(future.get(5, TimeUnit.MINUTES));
        double elapsedSeconds = (System.nanoTime() - started) / 1e9;
        pool.shutdown();

        long sentRequests = all.stream().mapToLong(op -> op.ok() ? 3 : 1).sum();
        assertThat(all.stream().filter(op -> !op.ok()).map(Op::detail).findFirst().orElse("")).as("first failed op").isEmpty();
        List<Series> after = scrape();
        double counted = laneRequests(after, "api_artifacts", null) - requestsBefore;
        assertThat(counted).as("server-side lane counter equals the client's request count exactly").isEqualTo((double) sentRequests);
        assertThat(laneRequests(after, "api_artifacts", "failed")).isZero();
        assertThat(laneRequests(after, "api_artifacts", "unknown")).isZero();

        List<Long> requestNanos = new ArrayList<>();
        for (Op op : all) { requestNanos.add(op.beginNanos()); requestNanos.add(op.chunkNanos()); requestNanos.add(op.completeNanos()); }
        Collections.sort(requestNanos);
        double p50 = requestNanos.get(requestNanos.size() / 2) / 1e6;
        double p95 = requestNanos.get((int) (requestNanos.size() * 0.95) - 1) / 1e6;
        double p99 = requestNanos.get((int) (requestNanos.size() * 0.99) - 1) / 1e6;
        TreeMap<Double, Double> bucketsAfter = laneBuckets(after, "api_artifacts");
        double s50 = bucketQuantileMs(bucketsBefore, bucketsAfter, 0.5);
        double s95 = bucketQuantileMs(bucketsBefore, bucketsAfter, 0.95);
        double s99 = bucketQuantileMs(bucketsBefore, bucketsAfter, 0.99);
        String line = String.format("load clients=%d ops=%d requests=%d elapsed=%.2fs throughput=%.1f req/s (%.1f ops/s) "
                        + "client p50/p95/p99=%.1f/%.1f/%.1f ms  server-histogram p50/p95/p99=%.1f/%.1f/%.1f ms",
                clients, all.size(), sentRequests, elapsedSeconds, sentRequests / elapsedSeconds, all.size() / elapsedSeconds,
                p50, p95, p99, s50, s95, s99);
        REPORT.append(line).append('\n');
        System.out.println("OBS-LOAD " + line);
        // Prometheus saw the very same totals (1s scrape): counters are not cached or sampled.
        double expected = laneRequests(after, "api_artifacts", null);
        await("Prometheus lane total catches up (" + clients + " clients)", Duration.ofSeconds(30),
                () -> scalar("sum(media_lane_requests_total{lane=\"api_artifacts\"})") == expected);
        // The histogram saw every request too (count == counter), so no request skipped timing.
        assertThat(after.stream().filter(s -> s.name().equals("media_lane_request_duration_seconds_count")
                && "api_artifacts".equals(s.labels().get("lane"))).mapToDouble(Series::value).sum()).isEqualTo(expected);
    }

    @Test
    @Order(2)
    void loadAtOneSixteenAndSixtyFourConcurrentClientsIsCountedExactly() throws Exception {
        loadAt(1, 30);
        loadAt(16, 15);
        loadAt(64, 8);
        // Under load the lane never leaked into failed/unknown and no alert was raised for it.
        assertThat(promAlert("MediaLaneErrorBudgetBurn", null, null, "firing")).isFalse();
    }

    @Test
    @Order(3)
    void refusalsAreTypedAndNeverCountedAsFailures() throws Exception {
        List<Series> before = scrape();
        double refusedBefore = laneRequests(before, "api_artifacts", "refused");
        // no credentials -> 401
        HttpResponse<String> anonymous = HTTP.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/v1/artifacts/x"))
                .GET().build(), HttpResponse.BodyHandlers.ofString());
        assertThat(anonymous.statusCode()).isIn(401, 403);
        // another tenant's principal asking for this tenant's artifact -> refused (not found), never served
        String artifactId = ISSUED_IDS.stream().filter(id -> id.length() > 20).findFirst().orElseThrow();
        String foreignToken = issueDevToken(tenant + "-other", principal);
        HttpResponse<String> foreign = send(port, tenant + "-other", foreignToken, "GET", "/api/v1/artifacts/" + artifactId, null);
        assertThat(foreign.statusCode()).as(foreign.body()).isBetween(400, 499);
        // unknown route -> 404
        assertThat(send(port, tenant, token, "GET", "/api/v1/nope", null).statusCode()).isBetween(400, 499);
        List<Series> after = scrape();
        assertThat(laneRequests(after, "api_artifacts", "refused") + laneRequests(after, "other", "refused")
                + laneRequests(after, "dev_context", "refused")).isGreaterThan(refusedBefore);
        assertThat(laneRequests(after, "other", "failed") + laneRequests(after, "dev_context", "failed")
                + laneRequests(after, "api_artifacts", "failed")).isZero();
        assertThat(after.stream().anyMatch(s -> s.name().equals("media_lane_requests_total")
                && "refused".equals(s.labels().get("outcome")) && s.labels().get("code").matches("[A-Z_0-9]+"))).isTrue();
    }

    private record Consent(String artifactId, String versionId) { }

    private static Consent consent(String label) throws Exception {
        byte[] bytes = solidPng(0xFF000000 | java.util.concurrent.ThreadLocalRandom.current().nextInt(0x1000000));
        String artifactId = upload(port, tenant, principal, token, label + "-" + UUID.randomUUID(), "consent-" + label + ".png", "image/png", bytes);
        String version = "sha256:" + sha256(bytes);
        post(port, tenant, token, "/dev/v1/rights/attestations", Map.of("artifactId", artifactId, "artifactVersionId", version,
                "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                "basis", "TEST: synthetic generated audio in an automated test; a statement by a synthetic test principal, "
                        + "not a legal determination or real consent"), 201);
        ISSUED_IDS.add(artifactId);
        return new Consent(artifactId, version);
    }

    @Test
    @Order(4)
    void exhaustingTheLiveSessionBudgetFiresSaturationAndCapacityAlertsThenClears() throws Exception {
        Consent consent = consent("live");
        Client first = new Client(port, tenant, token);
        Client second = new Client(port, tenant, token);
        first.open("obs-a-" + run, consent.artifactId(), consent.versionId(), "PROCESSING", 16, 120, 0);
        second.open("obs-b-" + run, consent.artifactId(), consent.versionId(), "PROCESSING", 16, 120, 0);
        ISSUED_IDS.add(first.sessionId);
        ISSUED_IDS.add(second.sessionId);
        await("live_sessions budget fully in use", Duration.ofSeconds(30),
                () -> scalar("media_budget_available{resource=\"live_sessions\"}") == 0.0);
        // The third open is refused with a typed capacity code while the budget is exhausted.
        Client third = new Client(port, tenant, token);
        long deadline = System.nanoTime() + Duration.ofSeconds(150).toNanos();
        boolean saturationFired = false, refusingFired = false;
        int refused = 0;
        while (System.nanoTime() < deadline && !(saturationFired && refusingFired)) {
            String body = JSON.writeValueAsString(Map.of("requestId", "obs-c-" + UUID.randomUUID(),
                    "consent", Map.of("artifactId", consent.artifactId(), "artifactVersionId", consent.versionId(), "scope", "PROCESSING"),
                    "format", Map.of("sampleRate", 48_000, "channels", 1, "samplesPerFrame", 960),
                    "startPtsSamples", 0, "reorderWindowFrames", 16, "leaseSeconds", 60));
            HttpResponse<String> response = third.call("POST", "/dev/v1/live-sessions", body.getBytes(StandardCharsets.UTF_8), "application/json");
            assertThat(response.statusCode()).as(response.body()).isEqualTo(429);
            assertThat(JSON.readTree(response.body()).path("error").path("code").asString()).isEqualTo("LIVE_CAPACITY_EXHAUSTED");
            refused++;
            saturationFired = promAlert("MediaBackpressureSaturation", "resource", "live_sessions", "firing");
            refusingFired = promAlert("MediaBackpressureRefusing", "lane", "dev_live_sessions", "firing");
            Thread.sleep(1000);
        }
        assertThat(saturationFired).as("MediaBackpressureSaturation firing in Prometheus").isTrue();
        assertThat(refusingFired).as("MediaBackpressureRefusing firing in Prometheus").isTrue();
        await("Alertmanager holds both", Duration.ofSeconds(30),
                () -> amActive("MediaBackpressureSaturation", "resource", "live_sessions")
                        && amActive("MediaBackpressureRefusing", "lane", "dev_live_sessions"));
        await("webhook delivered firing", Duration.ofSeconds(30),
                () -> webhookSaw("firing", "MediaBackpressureSaturation", "resource", "live_sessions"));
        assertThat(scrape().stream().filter(s -> s.name().equals("media_lane_requests_total")
                && "dev_live_sessions".equals(s.labels().get("lane")) && "refused".equals(s.labels().get("outcome"))
                && "LIVE_CAPACITY_EXHAUSTED".equals(s.labels().get("code"))).mapToDouble(Series::value).sum())
                .as("every refused open was counted as REFUSED/LIVE_CAPACITY_EXHAUSTED").isGreaterThanOrEqualTo(refused);
        assertThat(laneRequests(scrape(), "dev_live_sessions", "failed")).isZero();

        // Restore: release the budget -> saturation clears immediately; refusal rate clears after its 1m window.
        assertThat(first.call("POST", "/dev/v1/live-sessions/" + first.sessionId + "/abort", new byte[0], "application/json").statusCode()).isEqualTo(200);
        assertThat(second.call("POST", "/dev/v1/live-sessions/" + second.sessionId + "/abort", new byte[0], "application/json").statusCode()).isEqualTo(200);
        await("budget free again", Duration.ofSeconds(30), () -> scalar("media_budget_available{resource=\"live_sessions\"}") == 2.0);
        await("saturation cleared in Prometheus", Duration.ofSeconds(30),
                () -> !promAlert("MediaBackpressureSaturation", "resource", "live_sessions", "firing")
                        && !promAlert("MediaBackpressureSaturation", "resource", "live_sessions", "pending"));
        await("refusal alert cleared (rate window drains)", Duration.ofSeconds(150),
                () -> !promAlert("MediaBackpressureRefusing", "lane", "dev_live_sessions", "firing"));
        await("Alertmanager no longer active", Duration.ofSeconds(60),
                () -> !amActive("MediaBackpressureSaturation", "resource", "live_sessions")
                        && !amActive("MediaBackpressureRefusing", "lane", "dev_live_sessions"));
        await("webhook delivered resolved", Duration.ofSeconds(60),
                () -> webhookSaw("resolved", "MediaBackpressureSaturation", "resource", "live_sessions")
                        && webhookSaw("resolved", "MediaBackpressureRefusing", "lane", "dev_live_sessions"));
        // After release a new session is admitted again.
        Client again = new Client(port, tenant, token);
        again.open("obs-d-" + run, consent.artifactId(), consent.versionId(), "PROCESSING", 16, 60, 0);
        assertThat(again.call("POST", "/dev/v1/live-sessions/" + again.sessionId + "/abort", new byte[0], "application/json").statusCode()).isEqualTo(200);
    }

    @Test
    @Order(5)
    void aProviderOutageFiresAndRecoveryClearsWithoutLeakingProviderIdentity() throws Exception {
        assertThat(promAlert("MediaDevProviderUnavailable", "provider", "ffmpeg", "firing")).isFalse();
        ffmpegScript.removeAway();
        ffmpegAway = true;
        try {
            await("ffmpeg observed unavailable", Duration.ofSeconds(30),
                    () -> scalar("media_dev_provider_state{provider=\"ffmpeg\",state=\"unavailable\"}") == 1.0);
            assertThat(scalar("media_dev_provider_state{provider=\"ffmpeg\",state=\"ready\"}")).isEqualTo(0.0);
            await("alert firing in Prometheus", Duration.ofSeconds(60),
                    () -> promAlert("MediaDevProviderUnavailable", "provider", "ffmpeg", "firing"));
            await("alert active in Alertmanager", Duration.ofSeconds(30),
                    () -> amActive("MediaDevProviderUnavailable", "provider", "ffmpeg"));
            await("webhook delivered firing", Duration.ofSeconds(30),
                    () -> webhookSaw("firing", "MediaDevProviderUnavailable", "provider", "ffmpeg"));
        } finally {
            ffmpegScript.restore();
            ffmpegAway = false;
        }
        await("ffmpeg observed ready again", Duration.ofSeconds(30),
                () -> scalar("media_dev_provider_state{provider=\"ffmpeg\",state=\"ready\"}") == 1.0);
        await("alert cleared in Prometheus", Duration.ofSeconds(30),
                () -> !promAlert("MediaDevProviderUnavailable", "provider", "ffmpeg", "firing"));
        await("Alertmanager cleared", Duration.ofSeconds(60), () -> !amActive("MediaDevProviderUnavailable", "provider", "ffmpeg"));
        await("webhook delivered resolved", Duration.ofSeconds(60),
                () -> webhookSaw("resolved", "MediaDevProviderUnavailable", "provider", "ffmpeg"));
    }

    @Test
    @Order(6)
    void restartResetsCountersHonestlyAndReReadsReadinessAndTheDiskBudget() throws Exception {
        double requestsBeforeKill = laneRequests(scrape(), "api_artifacts", null);
        assertThat(requestsBeforeKill).isGreaterThan(1000);
        double promBefore = scalar("sum(media_lane_requests_total{lane=\"api_artifacts\"})");
        assertThat(promBefore).isEqualTo(requestsBeforeKill);
        long killedAt = System.currentTimeMillis() / 1000;

        // Crash the process, then break two things while it is down: FFmpeg is gone and the disk reserve is raised
        // above any free space. A cached readiness would still say "ready"; a fresh process must re-observe.
        killLauncher();
        await("MediaLauncherDown fires while the process is dead", Duration.ofSeconds(60),
                () -> promAlert("MediaLauncherDown", null, null, "firing"));
        await("MediaLauncherDown reaches the webhook", Duration.ofSeconds(30),
                () -> webhookSaw("firing", "MediaLauncherDown", null, null));
        ffmpegScript.removeAway();
        ffmpegAway = true;
        startLauncherProcess(Map.of("MEDIA_DEV_COMPOSITE_SPACE_RESERVE_BYTES", Long.toString(1L << 49)));
        try {
            // Counters restarted from zero: process-local, NOT persisted (Prometheus handles the reset in rate()).
            List<Series> fresh = scrape();
            assertThat(laneRequests(fresh, "api_artifacts", null)).as("counters reset on restart").isLessThan(requestsBeforeKill);
            await("Prometheus sees the counter reset", Duration.ofSeconds(30),
                    () -> scalar("resets(media_lane_requests_total{lane=\"api_artifacts\",outcome=\"completed\"}[5m])") >= 1.0
                            || query("media_lane_requests_total{lane=\"api_artifacts\",outcome=\"completed\"}").isEmpty());
            await("MediaLauncherDown clears after restart", Duration.ofSeconds(60),
                    () -> !promAlert("MediaLauncherDown", null, null, "firing")
                            && !promAlert("MediaLauncherDown", null, null, "pending"));
            await("webhook delivered MediaLauncherDown resolved", Duration.ofSeconds(60),
                    () -> webhookSaw("resolved", "MediaLauncherDown", null, null));
            // Readiness re-derived: FFmpeg observed unavailable by THIS process, stamped after the restart.
            await("fresh process reports ffmpeg unavailable", Duration.ofSeconds(30),
                    () -> scalar("media_dev_provider_state{provider=\"ffmpeg\",state=\"unavailable\"}") == 1.0);
            assertThat(scalar("media_dev_provider_state{provider=\"ffmpeg\",state=\"ready\"}")).isEqualTo(0.0);
            assertThat(scalar("media_dev_provider_checked_at_seconds{provider=\"ffmpeg\"}")).isGreaterThanOrEqualTo((double) killedAt);
            // ... and the raised reserve is read from the volume: the disk budget alert fires.
            await("disk budget exhausted alert fires", Duration.ofSeconds(60),
                    () -> promAlert("MediaDiskBudgetExhausted", "volume", "render_scratch", "firing"));
            assertThat(promAlert("MediaDiskBudgetExhausted", "volume", "live_spool", "firing")).isFalse();
            await("disk alert in Alertmanager", Duration.ofSeconds(30),
                    () -> amActive("MediaDiskBudgetExhausted", "volume", "render_scratch"));
            await("disk alert delivered", Duration.ofSeconds(30),
                    () -> webhookSaw("firing", "MediaDiskBudgetExhausted", "volume", "render_scratch"));
        } finally {
            ffmpegScript.restore();
            ffmpegAway = false;
        }
        // Restore: a clean restart (normal reserve, FFmpeg present) clears the alerts from a fresh observation.
        killLauncher();
        startLauncherProcess(Map.of());
        await("ffmpeg ready again from a fresh probe", Duration.ofSeconds(60),
                () -> scalar("media_dev_provider_state{provider=\"ffmpeg\",state=\"ready\"}") == 1.0);
        await("disk alert cleared", Duration.ofSeconds(60),
                () -> !promAlert("MediaDiskBudgetExhausted", "volume", "render_scratch", "firing"));
        await("disk alert resolved at the webhook", Duration.ofSeconds(60),
                () -> webhookSaw("resolved", "MediaDiskBudgetExhausted", "volume", "render_scratch"));
        await("Alertmanager clear of disk alert", Duration.ofSeconds(60),
                () -> !amActive("MediaDiskBudgetExhausted", "volume", "render_scratch"));
        REPORT.append("restart: counters reset (process-local, not persisted); readiness re-probed; disk alert fired and cleared\n");
    }

    @Test
    @Order(7)
    void noTenantPrincipalArtifactPathOrCredentialReachesAnyMetric() throws Exception {
        // Touch a few more lanes so every series family exists, then inspect the whole exposition.
        send(port, tenant, token, "GET", "/dev/v1/context", null);
        send(port, tenant, token, "GET", "/dev/v1/providers/catalog", null);
        String text = scrapeText();
        String prometheusSide = body("http://127.0.0.1:" + promPort + "/api/v1/label/__name__/values");
        List<String> forbidden = new ArrayList<>(List.of(tenant, principal, run, bucket, schema, DEV_SECRET, token,
                work.toString(), services.toString(), injectDir.toString(), liveSpool.toString(),
                System.getProperty("java.io.tmpdir"), System.getProperty("user.home"), "jdbc:", "postgres", "localstack",
                "secret:env", "Bearer ", "eyJ"));
        forbidden.addAll(ISSUED_IDS);
        for (String needle : forbidden) {
            if (needle == null || needle.isBlank()) continue;
            assertThat(text).as("/metrics must not contain " + (needle.length() > 12 ? needle.substring(0, 12) + "..." : needle))
                    .doesNotContain(needle);
        }
        Pattern safe = Pattern.compile("^[A-Za-z0-9_.:+-]{0,64}$");
        Set<String> laneSeries = new HashSet<>();
        for (Series series : scrape()) {
            if (!series.name().startsWith("media_")) continue;
            for (var label : series.labels().entrySet()) {
                if (label.getKey().equals("le")) continue;
                assertThat(label.getValue()).as(series.name() + " label " + label.getKey()).matches(safe);
            }
            if (series.name().startsWith("media_lane_")) laneSeries.add(series.name() + series.labels());
        }
        assertThat(laneSeries.size()).as("lane series are bounded").isLessThan(500);
        // Only the fixed lane vocabulary appears.
        Set<String> lanes = new HashSet<>();
        scrape().stream().filter(s -> s.name().equals("media_lane_requests_total")).forEach(s -> lanes.add(s.labels().get("lane")));
        assertThat(lanes).allMatch(lane -> lane.equals("other") || lane.startsWith("dev_") || lane.startsWith("api_"));
        assertThat(prometheusSide).doesNotContain(tenant).doesNotContain(principal);
        REPORT.append("lanes observed: ").append(lanes).append(", lane series: ").append(laneSeries.size()).append('\n');
        passed = true;
    }
}
