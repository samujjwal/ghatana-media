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

import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static com.ghatana.media.integration.MediaDevLiveSessionSupport.*;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.countArtifacts;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffmpeg;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-29 {@code media.dev.outcome-live-session-recovery} against REAL processes: the real launcher with the durable
 * PostgreSQL + S3 artifact store and the PostgreSQL rights and consent authority (Testcontainers), real FFmpeg-generated
 * PCM streamed over HTTP, and the real FFmpeg decoder for verification.
 *
 * <p>The stored WAV is read back from S3, decoded by FFmpeg and compared byte for byte with the PCM that was sent; the PTS
 * index artifact is checked frame by frame. Fault suite: a real TCP drop mid-frame, gaps, reorder window, duplicates,
 * bounded shared buffer (typed backpressure), lease expiry, consent revoked while live (bounded stop, nothing stored),
 * abort, wrong tenant, missing permission, no consent, and a launcher {@code kill -9} mid-stream followed by a restart
 * with resume from the acknowledged prefix. Load: 1, 16 and 64 concurrent clients (plus a real-time paced 64).</p>
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevLiveSessionIT {
    private static final long POLL_MS = 200;
    private static final String SESSIONS = "/dev/v1/live-sessions";

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private record Consent(String artifactId, String versionId, String attestationId) { }

    private static final class Rig {
        final String run;
        final String tenant;
        final String bucket;
        final String schema;
        final int port;
        final Path services;
        final Path work;
        final Path spool;
        final Path log;
        final Map<String, String> environment;
        final String classpath;
        Process launcher;

        Rig(String run, Path services, Path work, Path log, Map<String, String> environment, int port, String classpath) {
            this.run = run;
            this.tenant = "tenant-dev-live-" + run;
            this.bucket = "media-dev-live-" + run.substring(0, 16);
            this.schema = "media_dev_live_" + run;
            this.services = services; this.work = work; this.log = log; this.environment = environment; this.port = port;
            this.classpath = classpath; this.spool = work.resolve("live-spool");
        }

        void start() throws Exception {
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
        }

        void kill() throws Exception {
            launcher.destroyForcibly();
            assertThat(launcher.waitFor(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        }
    }

    private Rig rig(String label) throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-live-services-");
        Path work = Files.createTempDirectory("media-dev-live-work-");
        Path log = Files.createTempFile("media-dev-live-process-", ".log");
        String bucket = "media-dev-live-" + run.substring(0, 16);
        String schema = "media_dev_live_" + run;
        try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
        installDescriptors(services);
        String childClasspath = System.getProperty("media.child.classpath", "");
        assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
        Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
        environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
        environment.put("MEDIA_MAX_BODY_BYTES", Integer.toString(16 * 1024 * 1024));
        environment.put("MEDIA_MAX_CHUNK_BYTES", Integer.toString(16 * 1024 * 1024));
        environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpeg());
        environment.put("MEDIA_DEV_RENDER_FFPROBE", MediaDevVoiceJourneySupport.ffprobe());
        environment.put("MEDIA_DEV_LIVE_SESSION_DIR", work.resolve("live-spool").toString());
        environment.put("MEDIA_DEV_LIVE_REVOCATION_POLL_MS", Long.toString(POLL_MS));
        environment.put("MEDIA_DEV_LIVE_GLOBAL_BUFFER_BYTES", Integer.toString(256 * 1024));
        Rig rig = new Rig(run, services, work, log, environment, port, services + java.io.File.pathSeparator + childClasspath);
        return rig;
    }

    private void cleanup(Rig rig, boolean passed) {
        try { if (rig.launcher != null && rig.launcher.isAlive()) stopLauncher(rig.launcher); } catch (Exception ignored) { }
        deleteTree(rig.services);
        deleteTree(rig.work);
        dropSchema(POSTGRES, rig.schema);
        try {
            deleteBucket(LOCALSTACK, rig.bucket);
            if (passed) Files.deleteIfExists(rig.log);
            else System.out.println("J29-IT launcher log kept at " + rig.log);
        } catch (Exception ignored) { }
    }

    private Consent consent(Rig rig, String tenant, String principal, String token, String label, String scope, String confirmerToken) throws Exception {
        byte[] bytes = uniquePng(); // a small real PNG is the consent subject: the statement attaches to this exact file
        String artifactId = upload(rig.port, tenant, principal, token, label + "-" + UUID.randomUUID(), "consent-" + label + ".png", "image/png", bytes);
        String version = "sha256:" + sha256(bytes);
        boolean voice = "VOICE_OR_LIKENESS_USE".equals(scope);
        JsonNode attested = post(rig.port, tenant, token, "/dev/v1/rights/attestations", Map.of("artifactId", artifactId,
                "artifactVersionId", version, "statementKind", voice ? "IDENTIFIABLE_PERSON_CONSENT" : "MEDIA_RIGHTS",
                "scopes", List.of(scope), "basis", "TEST: synthetic generated audio in an automated test; a statement by a synthetic "
                        + "test principal, not a legal determination or real consent"), 201);
        String attestationId = attested.path("attestationId").asString();
        if (voice) {
            HttpResponse<String> confirmed = send(rig.port, tenant, confirmerToken, "POST",
                    "/dev/v1/rights/attestations/" + attestationId + "/confirm", "{}");
            assertThat(confirmed.statusCode()).as(confirmed.body()).isEqualTo(200);
        }
        return new Consent(artifactId, version, attestationId);
    }

    private static byte[] uniquePng() throws Exception {
        return solidPng(0xFF000000 | java.util.concurrent.ThreadLocalRandom.current().nextInt(0x1000000));
    }

    private byte[] storedBytes(String tenant, String principal, JsonNode artifact) throws Exception {
        byte[] bytes = s3Bytes(LOCALSTACK, rigBucket, storedArtifact(POSTGRES, tenant, principal, artifact.path("artifactId").asString()));
        assertThat(sha256(bytes)).isEqualTo(artifact.path("sha256").asString());
        return bytes;
    }

    private String rigBucket;

    /** Everything about a completed session verified independently of the launcher's own bookkeeping. */
    private void verifyStored(Rig rig, String tenant, String principal, JsonNode completed, byte[] sentPcm, long startPts, String label) throws Exception {
        assertThat(completed.path("state").asString()).isEqualTo("COMPLETED");
        JsonNode outputs = completed.path("outputs");
        byte[] wav = storedBytes(tenant, principal, outputs.path("wav"));
        byte[] decoded = decodeWav(wav, rig.work, label);
        assertThat(decoded.length).as(label + " decoded length").isEqualTo(sentPcm.length);
        assertThat(Arrays.equals(decoded, sentPcm)).as(label + ": FFmpeg-decoded stored audio equals the sent PCM exactly").isTrue();
        assertThat(sha256(sentPcm)).isEqualTo(outputs.path("pcmSha256").asString());
        JsonNode index = JSON.readTree(new String(storedBytes(tenant, principal, outputs.path("ptsIndex")), StandardCharsets.UTF_8));
        int frames = sentPcm.length / FRAME_BYTES;
        assertThat(index.path("frameCount").asInt()).isEqualTo(frames);
        assertThat(index.path("wavSha256").asString()).isEqualTo(outputs.path("wav").path("sha256").asString());
        assertThat(index.path("frames").size()).isEqualTo(frames);
        for (int i = 0; i < frames; i++) {
            JsonNode entry = index.path("frames").get(i);
            assertThat(entry.path("sequence").asInt()).isEqualTo(i);
            assertThat(entry.path("ptsSamples").asLong()).as(label + " pts of frame " + i).isEqualTo(startPts + (long) i * SAMPLES_PER_FRAME);
            java.util.zip.CRC32 crc = new java.util.zip.CRC32();
            crc.update(sentPcm, i * FRAME_BYTES, FRAME_BYTES);
            assertThat(entry.path("crc32").asLong()).isEqualTo(crc.getValue());
        }
    }

    // ---------------------------------------------------------------------------------------------------------------

    @Test
    void realLauncherStreamsLiveMediaStoresExactPtsAndSurvivesTheFaultSuite() throws Exception {
        assertThat(ffmpeg()).as("MEDIA_DEV_RENDER_FFMPEG").isNotBlank();
        Rig rig = rig("main");
        rigBucket = rig.bucket;
        String tenant = rig.tenant;
        boolean passed = false;
        try {
            rig.start();
            String principal = "media-dev-live-" + rig.run;
            String token = issueDevToken(tenant, principal);
            String confirmer = issueDevToken(tenant, "test-principal-confirmer-" + rig.run);

            JsonNode status = get(rig.port, tenant, token, SESSIONS + "/status", 200);
            assertThat(status.path("limits").path("codec").asString()).isEqualTo("PCM_S16LE");
            assertThat(status.path("limits").path("revocationPollMillis").asLong()).isEqualTo(POLL_MS);

            // ---- happy path: out-of-order frames, non-zero start PTS, replayed frames, stored and decoded exactly ----
            int frames = 300;
            long startPts = 48_000;
            byte[] pcm = generatePcm(1, frames);
            Consent consent = consent(rig, tenant, principal, token, "happy", "PROCESSING", null);
            Client client = new Client(rig.port, tenant, token);
            client.open("happy-" + rig.run, consent.artifactId(), consent.versionId(), "PROCESSING", 16, 60, startPts);
            assertThat(client.stream(pcm, startPts, 25, 0, 7, Duration.ofSeconds(60))).isNull();
            JsonNode beforeEos = client.state();
            assertThat(beforeEos.path("ackedThroughSequence").asInt()).isEqualTo(frames - 1);
            assertThat(beforeEos.path("reorderedFrames").asLong()).as("the shuffled batches were really reordered").isGreaterThan(0);
            // replaying acknowledged frames stores nothing twice
            HttpResponse<String> replayed = client.post(client.body(pcm, startPts, 10, 40, 1));
            assertThat(JSON.readTree(replayed.body()).path("duplicates").asInt()).isEqualTo(30);
            JsonNode completed = JSON.readTree(client.eos(frames - 1).body());
            verifyStored(rig, tenant, principal, completed, pcm, startPts, "happy");
            assertThat(countArtifacts(POSTGRES, tenant, principal, "audio/wav")).isEqualTo(1);
            assertThat(completed.path("consent").path("attestationIds").path(0).asString()).isEqualTo(consent.attestationId());
            // the stored WAV is also served by the exact-version content route
            HttpResponse<byte[]> served = java.net.http.HttpClient.newHttpClient().send(java.net.http.HttpRequest.newBuilder(
                            java.net.URI.create("http://127.0.0.1:" + rig.port + "/dev/v1/artifacts/" + completed.path("outputs").path("wav").path("artifactId").asString() + "/content?version="
                                    + completed.path("outputs").path("wav").path("artifactVersionId").asString()))
                    .header("Authorization", "Bearer " + token).header("X-Tenant-Id", tenant).GET().build(), java.net.http.HttpResponse.BodyHandlers.ofByteArray());
            assertThat(served.statusCode()).isEqualTo(200);
            assertThat(sha256(served.body())).isEqualTo(completed.path("outputs").path("wav").path("sha256").asString());
            // EOS is idempotent: a replay returns the same artifacts, registers nothing new
            JsonNode again = JSON.readTree(client.eos(frames - 1).body());
            assertThat(again.path("outputs").path("wav").path("artifactId").asString()).isEqualTo(completed.path("outputs").path("wav").path("artifactId").asString());
            assertThat(countArtifacts(POSTGRES, tenant, principal, "audio/wav")).isEqualTo(1);

            // ---- fault: a real TCP drop in the middle of a frame; the client resumes from the acknowledged prefix ----
            byte[] dropPcm = generatePcm(2, 120);
            Consent dropConsent = consent(rig, tenant, principal, token, "drop", "PROCESSING", null);
            Client dropper = new Client(rig.port, tenant, token);
            dropper.open("drop-" + rig.run, dropConsent.artifactId(), dropConsent.versionId(), "PROCESSING", 16, 60, 0);
            assertThat(dropper.post(dropper.body(dropPcm, 0, 0, 40, 3)).statusCode()).isEqualTo(200);
            byte[] doomed = dropper.body(dropPcm, 0, 40, 60, 99);
            // ordered, so exactly five whole frames precede the cut
            ByteArrayOutputStream ordered = new ByteArrayOutputStream();
            for (int seq = 40; seq < 60; seq++) ordered.writeBytes(record(seq, (long) seq * SAMPLES_PER_FRAME, Arrays.copyOfRange(dropPcm, seq * FRAME_BYTES, (seq + 1) * FRAME_BYTES)));
            byte[] orderedBytes = ordered.toByteArray();
            int whole = 5;
            int cut = whole * (24 + FRAME_BYTES) + 700; // 700 bytes into the sixth frame
            try (Socket socket = new Socket("127.0.0.1", rig.port)) {
                socket.setSoLinger(true, 0); // abortive close: RST, as a dropped network
                OutputStream out = socket.getOutputStream();
                String head = "POST " + SESSIONS + "/" + dropper.sessionId + "/frames HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer " + token
                        + "\r\nX-Tenant-Id: " + tenant + "\r\nContent-Type: application/octet-stream\r\nContent-Length: " + orderedBytes.length + "\r\n\r\n";
                out.write(head.getBytes(StandardCharsets.US_ASCII));
                out.write(orderedBytes, 0, cut);
                out.flush();
                Thread.sleep(400);
            }
            Thread.sleep(300);
            JsonNode afterDrop = dropper.state();
            assertThat(afterDrop.path("ackedThroughSequence").asInt()).as("the five whole frames before the cut were kept, the partial one was not").isEqualTo(44);
            assertThat(afterDrop.path("state").asString()).isEqualTo("OPEN");
            assertThat(dropper.stream(dropPcm, 0, 20, 0, 5, Duration.ofSeconds(60))).isNull();
            JsonNode afterResume = dropper.state();
            assertThat(afterResume.path("framesStored").asInt()).isEqualTo(120);
            verifyStored(rig, tenant, principal, JSON.readTree(dropper.eos(119).body()), dropPcm, 0, "drop");
            assertThat(doomed.length).isGreaterThan(0);

            // ---- fault: gap, window, conflicting duplicate, corruption: typed, nothing bad stored ----
            byte[] gapPcm = generatePcm(3, 40);
            Consent gapConsent = consent(rig, tenant, principal, token, "gap", "PROCESSING", null);
            Client gap = new Client(rig.port, tenant, token);
            gap.open("gap-" + rig.run, gapConsent.artifactId(), gapConsent.versionId(), "PROCESSING", 8, 60, 0);
            ByteArrayOutputStream skipping = new ByteArrayOutputStream();
            for (int seq : new int[] {0, 1, 2, 4, 5}) skipping.writeBytes(record(seq, (long) seq * SAMPLES_PER_FRAME, Arrays.copyOfRange(gapPcm, seq * FRAME_BYTES, (seq + 1) * FRAME_BYTES)));
            assertThat(gap.post(skipping.toByteArray()).statusCode()).isEqualTo(200);
            JsonNode gapState = gap.state();
            assertThat(gapState.path("ackedThroughSequence").asInt()).isEqualTo(2);
            assertThat(gapState.path("missingSequences").path(0).asInt()).isEqualTo(3);
            HttpResponse<String> gapEos = gap.eos(5);
            assertThat(gapEos.statusCode()).isEqualTo(409);
            assertThat(JSON.readTree(gapEos.body()).path("error").path("code").asString()).isEqualTo("EOS_GAP");
            assertThat(JSON.readTree(gapEos.body()).path("error").path("details").path("missingSequences").path(0).asInt()).isEqualTo(3);
            HttpResponse<String> beyond = gap.post(record(20, 20L * SAMPLES_PER_FRAME, Arrays.copyOfRange(gapPcm, 20 * FRAME_BYTES, 21 * FRAME_BYTES)));
            assertThat(JSON.readTree(beyond.body()).path("error").path("code").asString()).isEqualTo("SEQUENCE_WINDOW_EXCEEDED");
            byte[] evil = Arrays.copyOfRange(gapPcm, 0, FRAME_BYTES);
            evil[0] ^= 0x55;
            assertThat(JSON.readTree(gap.post(record(1, SAMPLES_PER_FRAME, evil)).body()).path("error").path("code").asString()).isEqualTo("DUPLICATE_SEQUENCE_CONFLICT");
            byte[] bad = record(3, 3L * SAMPLES_PER_FRAME, Arrays.copyOfRange(gapPcm, 3 * FRAME_BYTES, 4 * FRAME_BYTES));
            bad[bad.length - 1] ^= 1; // payload flipped after its CRC was computed
            assertThat(JSON.readTree(gap.post(bad).body()).path("error").path("code").asString()).isEqualTo("FRAME_CRC_MISMATCH");
            assertThat(JSON.readTree(gap.post(record(3, 77, Arrays.copyOfRange(gapPcm, 3 * FRAME_BYTES, 4 * FRAME_BYTES))).body())
                    .path("error").path("code").asString()).isEqualTo("PTS_MISMATCH");
            assertThat(gap.post(record(3, 3L * SAMPLES_PER_FRAME, Arrays.copyOfRange(gapPcm, 3 * FRAME_BYTES, 4 * FRAME_BYTES))).statusCode()).isEqualTo(200);
            assertThat(gap.state().path("ackedThroughSequence").asInt()).isEqualTo(5);
            verifyStored(rig, tenant, principal, JSON.readTree(gap.eos(5).body()), Arrays.copyOf(gapPcm, 6 * FRAME_BYTES), 0, "gap");

            // ---- fault: foreign tenant and missing permission ----
            String foreignToken = issueDevToken(tenant + "-other", principal);
            HttpResponse<String> foreign = send(rig.port, tenant + "-other", foreignToken, "GET", SESSIONS + "/" + gap.sessionId, null);
            assertThat(foreign.statusCode()).as("another tenant").isEqualTo(404);
            String otherPrincipalToken = issueDevToken(tenant, "someone-else-" + rig.run);
            assertThat(send(rig.port, tenant, otherPrincipalToken, "GET", SESSIONS + "/" + gap.sessionId, null).statusCode()).as("another principal").isEqualTo(404);
            assertThat(send(rig.port, tenant, otherPrincipalToken, "POST", SESSIONS + "/" + gap.sessionId + "/abort", "").statusCode()).isEqualTo(404);
            HttpResponse<String> noConsent = send(rig.port, tenant, token, "POST", SESSIONS, JSON.writeValueAsString(Map.of("requestId", "noconsent-" + rig.run,
                    "consent", Map.of("artifactId", gapConsent.artifactId() + "-nope", "artifactVersionId", gapConsent.versionId(), "scope", "PROCESSING"))));
            assertThat(noConsent.statusCode()).as(noConsent.body()).isEqualTo(404);
            byte[] unattestedBytes = uniquePng();
            String unattestedId = upload(rig.port, tenant, principal, token, "unattested-" + rig.run, "unattested.png", "image/png", unattestedBytes);
            HttpResponse<String> denied = send(rig.port, tenant, token, "POST", SESSIONS, JSON.writeValueAsString(Map.of("requestId", "denied-" + rig.run,
                    "consent", Map.of("artifactId", unattestedId, "artifactVersionId", "sha256:" + sha256(unattestedBytes), "scope", "PROCESSING"))));
            assertThat(denied.statusCode()).as(denied.body()).isEqualTo(403);
            assertThat(JSON.readTree(denied.body()).path("error").path("code").asString()).isEqualTo("RIGHTS_NOT_ADMITTED");

            // ---- backpressure: a bounded shared reorder buffer, a typed retryable refusal, and recovery ----
            List<Client> held = new ArrayList<>();
            List<byte[]> heldPcm = new ArrayList<>();
            int refused = 0;
            for (int i = 0; i < 3; i++) {
                byte[] hp = generatePcm(10 + i, 64);
                Consent hc = consent(rig, tenant, principal, token, "bp" + i, "PROCESSING", null);
                Client c = new Client(rig.port, tenant, token);
                c.open("bp-" + i + "-" + rig.run, hc.artifactId(), hc.versionId(), "PROCESSING", 64, 60, 0);
                ByteArrayOutputStream withheld = new ByteArrayOutputStream();
                for (int seq = 1; seq < 64; seq++) withheld.writeBytes(record(seq, (long) seq * SAMPLES_PER_FRAME, Arrays.copyOfRange(hp, seq * FRAME_BYTES, (seq + 1) * FRAME_BYTES)));
                HttpResponse<String> response = c.post(withheld.toByteArray());
                if (response.statusCode() == 429) {
                    refused++;
                    JsonNode error = JSON.readTree(response.body()).path("error");
                    assertThat(error.path("code").asString()).isEqualTo("BACKPRESSURE_SLOW_CONSUMER");
                    assertThat(error.path("retryable").asBoolean()).isTrue();
                    assertThat(response.headers().firstValue("Retry-After")).isPresent();
                } else assertThat(response.statusCode()).isEqualTo(200);
                held.add(c);
                heldPcm.add(hp);
            }
            assertThat(refused).as("three 120 KB reorder windows cannot fit a 256 KiB shared budget").isGreaterThanOrEqualTo(1);
            assertThat(get(rig.port, tenant, token, SESSIONS + "/status", 200).path("reorderBufferBytesInUse").asLong()).isLessThanOrEqualTo(256 * 1024);
            for (int i = 0; i < 3; i++) { // the retry succeeds once the gap frames arrive and buffers drain
                Client c = held.get(i);
                assertThat(c.stream(heldPcm.get(i), 0, 16, 0, 40 + i, Duration.ofSeconds(60))).isNull();
                // seq 0 first so the held ones drain
                verifyStored(rig, tenant, principal, JSON.readTree(c.eos(63).body()), heldPcm.get(i), 0, "bp" + i);
            }
            assertThat(get(rig.port, tenant, token, SESSIONS + "/status", 200).path("reorderBufferBytesInUse").asLong()).isZero();

            // ---- fault: lease expiry ends the session typed; abort discards ----
            int wavBefore = countArtifacts(POSTGRES, tenant, principal, "audio/wav");
            byte[] leasePcm = generatePcm(20, 30);
            Consent leaseConsent = consent(rig, tenant, principal, token, "lease", "PROCESSING", null);
            Client lease = new Client(rig.port, tenant, token);
            lease.open("lease-" + rig.run, leaseConsent.artifactId(), leaseConsent.versionId(), "PROCESSING", 8, 2, 0);
            assertThat(lease.post(lease.body(leasePcm, 0, 0, 20, 1)).statusCode()).isEqualTo(200);
            long leaseStart = System.nanoTime();
            JsonNode leaseState;
            do { Thread.sleep(100); leaseState = lease.state(); }
            while (!"EXPIRED".equals(leaseState.path("state").asString()) && System.nanoTime() - leaseStart < Duration.ofSeconds(10).toNanos());
            long leaseMillis = (System.nanoTime() - leaseStart) / 1_000_000;
            System.out.printf("J29-IT-LEASE lease=2000ms last frame -> EXPIRED observed after %d ms%n", leaseMillis);
            assertThat(leaseState.path("terminalCode").asString()).isEqualTo("LEASE_EXPIRED");
            assertThat(leaseMillis).isBetween(1_000L, 4_000L);
            HttpResponse<String> late = lease.post(lease.body(leasePcm, 0, 20, 30, 1));
            assertThat(late.statusCode()).isEqualTo(410);
            assertThat(JSON.readTree(late.body()).path("error").path("code").asString()).isEqualTo("SESSION_EXPIRED");
            assertThat(lease.eos(19).statusCode()).isEqualTo(410);
            assertThat(Files.exists(rig.spool.resolve(lease.sessionId).resolve("frames.spool"))).isFalse();

            Consent abortConsent = consent(rig, tenant, principal, token, "abort", "PROCESSING", null);
            Client abort = new Client(rig.port, tenant, token);
            abort.open("abort-" + rig.run, abortConsent.artifactId(), abortConsent.versionId(), "PROCESSING", 8, 60, 0);
            assertThat(abort.post(abort.body(leasePcm, 0, 0, 20, 1)).statusCode()).isEqualTo(200);
            assertThat(Files.exists(rig.spool.resolve(abort.sessionId).resolve("frames.spool"))).isTrue();
            HttpResponse<String> aborted = abort.call("POST", SESSIONS + "/" + abort.sessionId + "/abort", null, null);
            assertThat(JSON.readTree(aborted.body()).path("state").asString()).isEqualTo("ABORTED");
            assertThat(Files.exists(rig.spool.resolve(abort.sessionId).resolve("frames.spool"))).isFalse();
            assertThat(abort.eos(19).statusCode()).isEqualTo(410);
            assertThat(countArtifacts(POSTGRES, tenant, principal, "audio/wav")).as("expiry and abort stored nothing").isEqualTo(wavBefore);

            // ---- consent revoked while live: a second person confirmed VOICE_OR_LIKENESS_USE, then the owner revokes it ----
            byte[] livePcm = generatePcm(30, 500);
            Consent voice = consent(rig, tenant, principal, token, "voice", "VOICE_OR_LIKENESS_USE", confirmer);
            Client live = new Client(rig.port, tenant, token);
            live.open("revoke-" + rig.run, voice.artifactId(), voice.versionId(), "VOICE_OR_LIKENESS_USE", 16, 60, 0);
            AtomicLong revokedAt = new AtomicLong();
            AtomicLong refusedAt = new AtomicLong();
            AtomicLong storedAfterRevoke = new AtomicLong();
            AtomicBoolean refusedTyped = new AtomicBoolean();
            CountDownLatch streaming = new CountDownLatch(1);
            ExecutorService one = Executors.newSingleThreadExecutor();
            int wavsBeforeRevoke = countArtifacts(POSTGRES, tenant, principal, "audio/wav");
            Future<?> sender = one.submit(() -> {
                try {
                    for (int seq = 0; seq < 500; seq++) {
                        if (seq == 25) streaming.countDown();
                        HttpResponse<String> response = live.post(record(seq, (long) seq * SAMPLES_PER_FRAME, Arrays.copyOfRange(livePcm, seq * FRAME_BYTES, (seq + 1) * FRAME_BYTES)));
                        if (response.statusCode() != 200) {
                            refusedAt.set(System.nanoTime());
                            refusedTyped.set("SESSION_REVOKED".equals(JSON.readTree(response.body()).path("error").path("code").asString()));
                            return null;
                        }
                        Thread.sleep(20); // real time
                    }
                    return null;
                } catch (Exception failure) { throw new IllegalStateException(failure); }
            });
            assertThat(streaming.await(30, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            JsonNode revoked = post(rig.port, tenant, token, "/dev/v1/rights/attestations/" + voice.attestationId() + "/revoke",
                    Map.of("reason", "TEST: revoked while the stream is live"), 200);
            revokedAt.set(System.nanoTime());
            assertThat(revoked.path("status").asString()).isEqualTo("REVOKED");
            sender.get(30, java.util.concurrent.TimeUnit.SECONDS);
            one.shutdownNow();
            long refusedMs = (refusedAt.get() - revokedAt.get()) / 1_000_000;
            JsonNode afterRevoke = live.state();
            System.out.printf("J29-IT-REVOKE poll=%dms: first refused frame %d ms after the revoke call, state=%s code=%s%n",
                    POLL_MS, refusedMs, afterRevoke.path("state").asString(), afterRevoke.path("terminalCode").asString());
            assertThat(refusedAt.get()).as("the live sender was refused after the revoke").isPositive();
            assertThat(refusedTyped.get()).isTrue();
            assertThat(refusedMs).as("stopped within the bound (2 polls + slack)").isLessThanOrEqualTo(2 * POLL_MS + 800);
            assertThat(afterRevoke.path("state").asString()).isEqualTo("REVOKED");
            assertThat(afterRevoke.path("terminalCode").asString()).isEqualTo("CONSENT_REVOKED");
            assertThat(live.eos(24).statusCode()).isEqualTo(410);
            assertThat(countArtifacts(POSTGRES, tenant, principal, "audio/wav")).as("nothing was persisted by the revoked session").isEqualTo(wavsBeforeRevoke);
            assertThat(Files.exists(rig.spool.resolve(live.sessionId).resolve("frames.spool"))).as("received media destroyed").isFalse();
            assertThat(storedAfterRevoke.get()).isZero();
            HttpResponse<String> reopen = send(rig.port, tenant, token, "POST", SESSIONS, JSON.writeValueAsString(Map.of("requestId", "revoke-again-" + rig.run,
                    "consent", Map.of("artifactId", voice.artifactId(), "artifactVersionId", voice.versionId(), "scope", "VOICE_OR_LIKENESS_USE"))));
            assertThat(reopen.statusCode()).as("a revoked consent subject cannot start a new session").isEqualTo(403);

            // ---- load: 1, 16 and 64 concurrent clients, each verified by decode ----
            load(rig, tenant, 1, 500, 0);
            load(rig, tenant, 16, 500, 0);
            load(rig, tenant, 64, 500, 0);
            load(rig, tenant, 64, 500, 500);
            passed = true;
        } finally {
            cleanup(rig, passed);
        }
    }

    private void load(Rig rig, String tenant, int clients, int frames, long paceMillis) throws Exception {
        String label = "load" + clients + (paceMillis > 0 ? "p" : "");
        List<Client> list = new ArrayList<>();
        List<byte[]> pcms = new ArrayList<>();
        List<String> principals = new ArrayList<>();
        for (int i = 0; i < clients; i++) {
            String principal = "live-" + label + "-" + i + "-" + rig.run;
            String token = issueDevToken(tenant, principal);
            Consent consent = consent(rig, tenant, principal, token, label + i, "PROCESSING", null);
            Client c = new Client(rig.port, tenant, token);
            c.open(label + "-" + i + "-" + rig.run, consent.artifactId(), consent.versionId(), "PROCESSING", 16, 120, 0);
            list.add(c);
            pcms.add(generatePcm(100 + i, frames));
            principals.add(principal);
        }
        ExecutorService pool = Executors.newFixedThreadPool(clients);
        CountDownLatch gate = new CountDownLatch(1);
        List<Future<long[]>> futures = new ArrayList<>();
        for (int i = 0; i < clients; i++) {
            final int index = i;
            futures.add(pool.submit(() -> {
                gate.await();
                Client c = list.get(index);
                HttpResponse<String> stop = c.stream(pcms.get(index), 0, 25, paceMillis, index, Duration.ofMinutes(3));
                assertThat(stop).as("client " + index + " streamed to the end").isNull();
                long eosStart = System.nanoTime();
                HttpResponse<String> eos = c.eos(frames - 1);
                assertThat(eos.statusCode()).as(eos.body()).isEqualTo(201);
                return new long[] {System.nanoTime() - eosStart};
            }));
        }
        long start = System.nanoTime();
        gate.countDown();
        List<Long> eosNanos = new ArrayList<>();
        for (Future<long[]> future : futures) eosNanos.add(future.get(5, java.util.concurrent.TimeUnit.MINUTES)[0]);
        long wall = System.nanoTime() - start;
        pool.shutdownNow();
        List<Long> allBatches = new ArrayList<>();
        long net = 0;
        long bp = 0;
        for (Client c : list) { allBatches.addAll(c.batchNanos); net += c.networkErrors.get(); bp += c.backpressure.get(); }
        double seconds = wall / 1e9;
        double audioSeconds = clients * frames * SAMPLES_PER_FRAME / 48_000.0;
        double mbps = clients * (double) frames * (FRAME_BYTES + 24) / 1e6 / seconds;
        System.out.printf("J29-IT-LOAD clients=%d paced=%s audio=%.0fs wall=%.2fs payload=%.2f MB/s realtimeFactor=%.1fx batch(25 frames) p50=%.1fms p95=%.1fms p99=%.1fms max=%.1fms eos p50=%.1fms max=%.1fms retries(429/503)=%d networkErrors=%d%n",
                clients, paceMillis > 0, audioSeconds, seconds, mbps, audioSeconds / seconds,
                percentile(allBatches, 0.50), percentile(allBatches, 0.95), percentile(allBatches, 0.99), percentile(allBatches, 1.0),
                percentile(eosNanos, 0.50), percentile(eosNanos, 1.0), bp, net);
        for (int i = 0; i < clients; i++) {
            verifyStored(rig, tenant, principals.get(i), list.get(i).state(), pcms.get(i), 0, label + "-" + i);
        }
    }

    // ---------------------------------------------------------------------------------------------------------------

    @Test
    void launcherKilledMidStreamResumesFromTheAcknowledgedPrefixAndNeverSilentlyCompletes() throws Exception {
        assertThat(ffmpeg()).as("MEDIA_DEV_RENDER_FFMPEG").isNotBlank();
        Rig rig = rig("restart");
        rigBucket = rig.bucket;
        String tenant = rig.tenant;
        boolean passed = false;
        try {
            rig.start();
            String principal = "media-dev-live-" + rig.run;
            String token = issueDevToken(tenant, principal);
            int frames = 700;
            byte[] pcm = generatePcm(5, frames);
            Consent consent = consent(rig, tenant, principal, token, "restart", "PROCESSING", null);
            Client client = new Client(rig.port, tenant, token);
            client.open("restart-" + rig.run, consent.artifactId(), consent.versionId(), "PROCESSING", 16, 120, 0);

            // sessions that will meet other fates: one never resumes (its lease then ends it), one loses its spool
            byte[] idlePcm = generatePcm(6, 40);
            Consent idleConsent = consent(rig, tenant, principal, token, "idle", "PROCESSING", null);
            Client idle = new Client(rig.port, tenant, token);
            idle.open("idle-" + rig.run, idleConsent.artifactId(), idleConsent.versionId(), "PROCESSING", 16, 4, 0);
            assertThat(idle.post(idle.body(idlePcm, 0, 0, 30, 1)).statusCode()).isEqualTo(200);
            Consent lostConsent = consent(rig, tenant, principal, token, "lost", "PROCESSING", null);
            Client lost = new Client(rig.port, tenant, token);
            lost.open("lost-" + rig.run, lostConsent.artifactId(), lostConsent.versionId(), "PROCESSING", 16, 120, 0);
            assertThat(lost.post(lost.body(idlePcm, 0, 0, 30, 1)).statusCode()).isEqualTo(200);
            int wavsBefore = countArtifacts(POSTGRES, tenant, principal, "audio/wav");

            ExecutorService one = Executors.newSingleThreadExecutor();
            Future<HttpResponse<String>> streaming = one.submit(() -> client.stream(pcm, 0, 10, 20, 11, Duration.ofMinutes(3)));
            long deadline = System.nanoTime() + Duration.ofSeconds(60).toNanos();
            while (client.state().path("ackedThroughSequence").asInt() < 200) {
                assertThat(System.nanoTime()).isLessThan(deadline);
                Thread.sleep(50);
            }
            int ackedAtKill = client.state().path("ackedThroughSequence").asInt();
            rig.kill(); // kill -9 in the middle of the stream
            Thread.sleep(600); // the client keeps trying against a dead launcher
            assertThat(client.networkErrors.get()).as("the client observed the outage as typed network errors").isGreaterThan(0);
            deleteTree(rig.spool.resolve(lost.sessionId)); // this session's state is gone while the launcher is down
            rig.start(); // restart on the same port, same database, same spool directory

            HttpResponse<String> result = streaming.get(3, java.util.concurrent.TimeUnit.MINUTES);
            assertThat(result).as("the client resumed and streamed to the end").isNull();
            one.shutdownNow();
            JsonNode resumed = client.state();
            System.out.printf("J29-IT-RESTART killed at ack>=%d of %d; after restart recovered=%s recoveries=%d duplicatesAbsorbed=%d networkErrors=%d%n",
                    ackedAtKill, frames, resumed.path("recovered").asBoolean(), resumed.path("recoveries").asInt(),
                    resumed.path("duplicateFrames").asLong(), client.networkErrors.get());
            assertThat(resumed.path("recovered").asBoolean()).isTrue();
            assertThat(resumed.path("framesStored").asInt()).isEqualTo(frames);
            assertThat(resumed.path("state").asString()).as("not completed until end-of-stream").isEqualTo("OPEN");
            verifyStored(rig, tenant, principal, JSON.readTree(client.eos(frames - 1).body()), pcm, 0, "restart");
            assertThat(countArtifacts(POSTGRES, tenant, principal, "audio/wav")).isEqualTo(wavsBefore + 1);

            // the session whose spool vanished is a typed unknown session: honestly terminated, never "completed"
            HttpResponse<String> gone = lost.call("GET", SESSIONS + "/" + lost.sessionId, null, null);
            assertThat(gone.statusCode()).isEqualTo(404);
            assertThat(JSON.readTree(gone.body()).path("error").path("code").asString()).isEqualTo("SESSION_NOT_FOUND");
            assertThat(lost.eos(29).statusCode()).isEqualTo(404);
            // the idle one survived the kill (frames intact) and then, never resumed, ends by its lease
            JsonNode idleAfter = idle.state();
            assertThat(idleAfter.path("recovered").asBoolean()).isTrue();
            assertThat(idleAfter.path("ackedThroughSequence").asInt()).isEqualTo(29);
            long idleStart = System.nanoTime();
            JsonNode idleState;
            do { Thread.sleep(200); idleState = idle.state(); }
            while (!"EXPIRED".equals(idleState.path("state").asString()) && System.nanoTime() - idleStart < Duration.ofSeconds(15).toNanos());
            assertThat(idleState.path("state").asString()).isEqualTo("EXPIRED");
            assertThat(idle.eos(29).statusCode()).isEqualTo(410);
            assertThat(countArtifacts(POSTGRES, tenant, principal, "audio/wav")).as("neither the lost nor the expired session stored anything").isEqualTo(wavsBefore + 1);
            passed = true;
        } finally {
            cleanup(rig, passed);
        }
    }
}
