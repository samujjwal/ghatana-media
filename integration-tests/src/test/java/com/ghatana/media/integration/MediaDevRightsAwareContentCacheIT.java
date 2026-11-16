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

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * The rights-aware content cache in a real launcher process over PostgreSQL + S3 (LocalStack): hit rate and latency
 * against the uncached baseline, restart-cold, cross-tenant and cross-principal isolation, stale metadata, a rights
 * revocation dropping the entry immediately, single-flight under a stampede, eviction bounds, an outage of the rights
 * authority failing closed, and erasure leaving nothing served.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevRightsAwareContentCacheIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);
    private static final HttpClient CLIENT = HttpClient.newHttpClient();

    private record Read(int status, byte[] body, String cache, long nanos, String code) { }

    @Test
    void cacheNeverOutlivesVersionRightsRevocationErasureOrTheAuthority() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        String tenant = "tenant-dev-cache-" + run;
        String otherTenant = "tenant-dev-cache-b-" + run;
        String owner = "test-principal-owner-" + run;
        String peer = "test-principal-peer-" + run;
        String bucket = "media-dev-cache-" + run;
        String schema = "media_dev_cache_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-cache-services-");
        Path spool = Files.createTempDirectory("media-dev-cache-spool-");
        Path log = Files.createTempFile("media-dev-cache-process-", ".log");
        Process launcher = null;
        try {
            try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
            environment.put("MEDIA_DEV_ERASURE_ENABLED", "true");
            environment.put("MEDIA_DEV_SPEECH_SPOOL_DIR", spool.toString());
            environment.put("MEDIA_DEV_ARTIFACT_CONTENT_MAX_BYTES", Long.toString(4L * 1024 * 1024));
            environment.put(ENABLED, "false");

            // ---- 1. Uncached baseline (cache disabled) ----
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            String ownerToken = issueDevToken(tenant, owner);
            byte[][] payload = new byte[4][];
            String[] ids = new String[4];
            for (int i = 0; i < 4; i++) {
                payload[i] = noisePng(560, 400, 100 + i);
                ids[i] = upload(port, tenant, owner, ownerToken, run + "-" + i, "cache-" + i + ".png", "image/png", payload[i]);
            }
            assertThat(payload[0].length).isLessThan(786_000).isGreaterThan(300_000);
            for (int i = 0; i < 3; i++) read(port, tenant, ownerToken, ids[0], payload[0], null);
            List<Long> baseline = new ArrayList<>();
            for (int i = 0; i < 40; i++) {
                Read r = read(port, tenant, ownerToken, ids[i % 4], payload[i % 4], null);
                assertThat(r.status()).isEqualTo(200);
                assertThat(r.cache()).as("cache disabled: no cache header").isNull();
                baseline.add(r.nanos());
            }

            // ---- 2. Restart with the cache enabled: starts cold; measure hit rate and latency ----
            stopLauncher(launcher);
            environment.put(ENABLED, "true");
            environment.put("MEDIA_DEV_CONTENT_CACHE_MAX_ENTRIES", "6");
            environment.put("MEDIA_DEV_CONTENT_CACHE_MAX_BYTES", Long.toString(8L * 1024 * 1024));
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            ownerToken = issueDevToken(tenant, owner);
            List<Long> miss = new ArrayList<>();
            List<Long> hit = new ArrayList<>();
            int hits = 0;
            int total = 0;
            for (int round = 0; round < 25; round++) {
                for (int i = 0; i < 4; i++) {
                    Read r = read(port, tenant, ownerToken, ids[i], payload[i], null);
                    assertThat(r.status()).isEqualTo(200);
                    assertThat(r.body()).as("bytes identical to the uploaded source").isEqualTo(payload[i]);
                    total++;
                    if (round == 0) {
                        assertThat(r.cache()).as("cold after restart").isEqualTo("MISS");
                        miss.add(r.nanos());
                    } else {
                        assertThat(r.cache()).isEqualTo("HIT");
                        hits++;
                        hit.add(r.nanos());
                    }
                }
            }
            double hitRate = hits / (double) total;
            assertThat(hitRate).isGreaterThanOrEqualTo(0.95);
            System.out.printf("MEASURED content-cache: reads=%d hits=%d hitRate=%.3f | median ms: uncachedBaseline=%.2f "
                            + "coldMiss=%.2f hit=%.2f | p95 ms: baseline=%.2f hit=%.2f | speedup(median hit vs baseline)=%.2fx%n",
                    total, hits, hitRate, ms(median(baseline)), ms(median(miss)), ms(median(hit)),
                    ms(percentile(baseline, 95)), ms(percentile(hit, 95)), median(baseline) / (double) median(hit));

            // Ranged reads are sliced from the cached, verified object.
            Read ranged = read(port, tenant, ownerToken, ids[0], payload[0], "bytes=1000-1999");
            assertThat(ranged.status()).isEqualTo(206);
            assertThat(ranged.cache()).isEqualTo("HIT");
            assertThat(ranged.body()).isEqualTo(Arrays.copyOfRange(payload[0], 1000, 2000));

            // ---- 3. Cross-principal and cross-tenant reads never hit ----
            String peerToken = issueDevToken(tenant, peer);
            assertThat(read(port, tenant, peerToken, ids[0], payload[0], null).status()).isEqualTo(404);
            String otherToken = issueDevToken(otherTenant, owner);
            Read foreign = read(port, otherTenant, otherToken, ids[0], payload[0], null);
            assertThat(foreign.status()).isEqualTo(404);
            assertThat(foreign.body()).isNotEqualTo(payload[0]);
            // The same bytes uploaded by the other tenant are a separate entry: a miss first, then its own hit.
            String otherId = upload(port, otherTenant, owner, otherToken, run + "-b", "cache-b.png", "image/png", payload[0]);
            assertThat(read(port, otherTenant, otherToken, otherId, payload[0], null).cache()).isEqualTo("MISS");
            assertThat(read(port, otherTenant, otherToken, otherId, payload[0], null).cache()).isEqualTo("HIT");
            assertThat(read(port, tenant, ownerToken, ids[0], payload[0], null).cache()).isEqualTo("HIT");

            // ---- 4. Stale metadata / new source version ----
            String staleVersionRead = "sha256:" + "0".repeat(64);
            Read stale = readVersion(port, tenant, ownerToken, ids[1], staleVersionRead, null);
            assertThat(stale.status()).isEqualTo(412);
            assertThat(stale.body()).isNotEqualTo(payload[1]);
            // The artifact record is changed to a different digest (as if the source had a new version): the old
            // cached bytes are never served for it; the exact old version is now a version mismatch.
            String oldSha = sha256(payload[1]);
            String newSha = sha256(("drifted-" + run).getBytes());
            setArtifactSha(tenant, ids[1], newSha);
            assertThat(readVersion(port, tenant, ownerToken, ids[1], "sha256:" + oldSha, null).status()).isEqualTo(412);
            Read drift = readVersion(port, tenant, ownerToken, ids[1], "sha256:" + newSha, null);
            assertThat(drift.status()).as("verification against the object fails; the cache cannot fill the gap").isEqualTo(409);
            assertThat(drift.body()).isNotEqualTo(payload[1]);
            setArtifactSha(tenant, ids[1], oldSha);

            // ---- 5. Rights revocation drops the entry immediately ----
            assertThat(read(port, tenant, ownerToken, ids[2], payload[2], null).cache()).isEqualTo("HIT");
            JsonNode attested = post(port, tenant, ownerToken, "/dev/v1/rights/attestations", Map.of(
                    "artifactId", ids[2], "artifactVersionId", "sha256:" + sha256(payload[2]),
                    "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                    "basis", "TEST: synthetic noise image generated by the test, no real person or rights"), 201);
            String attestationId = attested.path("attestationId").asString();
            Read afterAttest = read(port, tenant, ownerToken, ids[2], payload[2], null);
            assertThat(afterAttest.cache()).as("a new statement is a new rights epoch").isEqualTo("MISS");
            assertThat(read(port, tenant, ownerToken, ids[2], payload[2], null).cache()).isEqualTo("HIT");
            JsonNode revoked = post(port, tenant, ownerToken, "/dev/v1/rights/attestations/" + attestationId + "/revoke",
                    Map.of("reason", "TEST: statement withdrawn"), 200);
            assertThat(revoked.path("status").asString()).isEqualTo("REVOKED");
            Read afterRevoke = read(port, tenant, ownerToken, ids[2], payload[2], null);
            assertThat(afterRevoke.cache()).as("no entry computed under the pre-revocation rights state is served")
                    .isEqualTo("MISS");
            assertThat(afterRevoke.body()).isEqualTo(payload[2]);

            // ---- 6. Stampede: concurrent cold reads of one key load the source once ----
            byte[] fresh = noisePng(560, 400, 777);
            String freshId = upload(port, tenant, owner, ownerToken, run + "-fresh", "cache-fresh.png", "image/png", fresh);
            ExecutorService pool = Executors.newFixedThreadPool(16);
            try {
                String token = ownerToken;
                int httpPort = port;
                List<Callable<Read>> calls = new ArrayList<>();
                for (int i = 0; i < 16; i++) calls.add(() -> read(httpPort, tenant, token, freshId, fresh, null));
                List<Future<Read>> futures = pool.invokeAll(calls);
                int misses = 0;
                for (Future<Read> future : futures) {
                    Read r = future.get();
                    assertThat(r.status()).isEqualTo(200);
                    assertThat(r.body()).isEqualTo(fresh);
                    if ("MISS".equals(r.cache())) misses++;
                }
                assertThat(misses).as("16 concurrent misses for one key computed once").isEqualTo(1);
            } finally {
                pool.shutdownNow();
            }

            // ---- 7. Eviction is bounded by entries (max 6): distinct artifacts push older ones out ----
            List<String> evictionIds = new ArrayList<>();
            List<byte[]> evictionPayloads = new ArrayList<>();
            for (int i = 0; i < 10; i++) {
                byte[] bytes = noisePng(120, 90, 3000 + i);
                String id = upload(port, tenant, owner, ownerToken, run + "-ev-" + i, "ev-" + i + ".png", "image/png", bytes);
                evictionIds.add(id);
                evictionPayloads.add(bytes);
                assertThat(read(port, tenant, ownerToken, id, bytes, null).cache()).isEqualTo("MISS");
            }
            int resident = 0;
            for (int i = 0; i < 10; i++) {
                Read r = read(port, tenant, ownerToken, evictionIds.get(i), evictionPayloads.get(i), null);
                assertThat(r.body()).as("an evicted entry is reloaded correctly").isEqualTo(evictionPayloads.get(i));
                if ("HIT".equals(r.cache())) resident++;
            }
            assertThat(resident).as("at most max-entries (6) of the 10 can be resident").isLessThanOrEqualTo(6);

            // ---- 8. Outage of the rights authority: fail closed, the cache is not the fallback authority ----
            assertThat(read(port, tenant, ownerToken, ids[3], payload[3], null).status()).isEqualTo(200);
            assertThat(read(port, tenant, ownerToken, ids[3], payload[3], null).cache()).isEqualTo("HIT");
            sql("ALTER TABLE media_rights_attestations RENAME TO media_rights_attestations_outage");
            try {
                Read down = read(port, tenant, ownerToken, ids[3], payload[3], null);
                assertThat(down.status()).isEqualTo(503);
                assertThat(down.code()).isEqualTo("ARTIFACT_AUTHORITY_UNAVAILABLE");
                assertThat(down.body()).isNotEqualTo(payload[3]);
                assertThat(down.cache()).isNull();
            } finally {
                sql("ALTER TABLE media_rights_attestations_outage RENAME TO media_rights_attestations");
            }
            assertThat(read(port, tenant, ownerToken, ids[3], payload[3], null).cache())
                    .as("the entry itself was never trusted or lost; it is served again once the authority answers")
                    .isEqualTo("HIT");

            // ---- 9. Erasure: nothing is served afterwards and the tenant's derived entries are dropped ----
            assertThat(read(port, tenant, ownerToken, ids[0], payload[0], null).status()).isEqualTo(200);
            HttpResponse<String> erased = send(port, tenant, ownerToken, "POST", "/dev/v1/erasures", JSON.writeValueAsString(
                    Map.of("erasureId", "erase-" + run, "artifactId", ids[0], "confirm", true)));
            assertThat(erased.statusCode()).as(erased.body()).isIn(200, 201);
            assertThat(JSON.readTree(erased.body()).path("items").toString()).contains("CACHE_TENANT_INVALIDATION");
            Read gone = read(port, tenant, ownerToken, ids[0], payload[0], null);
            assertThat(gone.status()).as("tombstoned (410) or absent (404)").isIn(404, 410);
            assertThat(gone.body()).isNotEqualTo(payload[0]);
            assertThat(read(port, tenant, ownerToken, ids[3], payload[3], null).cache())
                    .as("erasure drops every derived entry of the tenant").isEqualTo("MISS");
            // Another tenant's entry is unaffected.
            assertThat(read(port, otherTenant, otherToken, otherId, payload[0], null).cache()).isEqualTo("HIT");

            // ---- 10. Restart: cold again ----
            stopLauncher(launcher);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            ownerToken = issueDevToken(tenant, owner);
            assertThat(read(port, tenant, ownerToken, ids[3], payload[3], null).cache()).isEqualTo("MISS");
        } finally {
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            Files.deleteIfExists(log);
            deleteTree(services);
            deleteTree(spool);
        }
    }

    private static final String ENABLED = "MEDIA_DEV_CONTENT_CACHE_ENABLED";

    private static Read read(int port, String tenant, String token, String artifactId, byte[] expected, String range)
            throws Exception {
        return readVersion(port, tenant, token, artifactId, "sha256:" + sha256(expected), range);
    }

    private static Read readVersion(int port, String tenant, String token, String artifactId, String version, String range)
            throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port
                        + "/dev/v1/artifacts/" + artifactId + "/content?version=" + version))
                .header("Authorization", "Bearer " + token).header("X-Tenant-Id", tenant);
        if (range != null) request.header("Range", range);
        long started = System.nanoTime();
        HttpResponse<byte[]> response = CLIENT.send(request.GET().build(), HttpResponse.BodyHandlers.ofByteArray());
        long nanos = System.nanoTime() - started;
        String code = null;
        if (response.statusCode() >= 400) {
            try { code = JSON.readTree(response.body()).path("error").path("code").asString(); }
            catch (RuntimeException notJson) { code = null; }
        }
        return new Read(response.statusCode(), response.body(),
                response.headers().firstValue("X-Media-Content-Cache").orElse(null), nanos, code);
    }

    private static void setArtifactSha(String tenant, String artifactId, String sha) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "UPDATE media_artifacts SET sha256=? WHERE tenant_id=? AND artifact_id=?")) {
            statement.setString(1, sha);
            statement.setString(2, tenant);
            statement.setString(3, artifactId);
            assertThat(statement.executeUpdate()).isEqualTo(1);
        }
    }

    private static void sql(String statement) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var prepared = connection.createStatement()) {
            prepared.execute(statement);
        }
    }

    private static byte[] noisePng(int width, int height, long seed) throws Exception {
        var image = new java.awt.image.BufferedImage(width, height, java.awt.image.BufferedImage.TYPE_INT_RGB);
        Random random = new Random(seed);
        for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) image.setRGB(x, y, random.nextInt(0x1000000));
        var out = new java.io.ByteArrayOutputStream();
        javax.imageio.ImageIO.write(image, "png", out);
        return out.toByteArray();
    }

    private static long median(List<Long> values) { return percentile(values, 50); }

    private static long percentile(List<Long> values, int p) {
        List<Long> sorted = new ArrayList<>(values);
        java.util.Collections.sort(sorted);
        return sorted.get(Math.min(sorted.size() - 1, (int) Math.ceil(p / 100.0 * sorted.size()) - 1));
    }

    private static double ms(long nanos) { return nanos / 1_000_000.0; }
}
