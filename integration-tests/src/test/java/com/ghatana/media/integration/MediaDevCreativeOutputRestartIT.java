package com.ghatana.media.integration;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import tools.jackson.databind.JsonNode;

import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import com.ghatana.media.integration.MediaDevLiveFixtures.StoredArtifact;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * DEV_ONLY creative outputs (audio repair, simulation, spatial GLB) through a real launcher with the durable
 * PostgreSQL + S3 artifact store: registration, independent readback of the stored rows/bytes, restart and reopen.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevCreativeOutputRestartIT {
    private static final String AUDIO = "/dev/v1/creative-outputs/audio-repairs";
    private static final String SIM = "/dev/v1/creative-outputs/simulations";
    private static final String SPATIAL = "/dev/v1/creative-outputs/spatial-glb";
    private static final int RATE = 8_000;

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void audioRepairSimulationAndSpatialGlbRegisterDurablyAndReopenAfterRestart() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-creative-" + run;
        String principal = "media-dev-creative-" + run;
        String bucket = "media-dev-creative-" + run;
        String schema = "media_dev_creative_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-creative-services-");
        Path log = Files.createTempFile("media-dev-creative-process-", ".log");
        Process launcher = null;
        try {
            try (S3Client s3 = s3(LOCALSTACK)) {
                s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = environment(POSTGRES, LOCALSTACK, bucket, port, schema);
            String token = issueDevToken(tenant, principal);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            // ---- sources ----
            byte[] clipped = clippedWav(36_000);
            String wavId = upload(port, tenant, principal, token, run + "-wav", "clipped.wav", "audio/wav", clipped);
            byte[] pngA = solidPng(0xffff0000);
            byte[] pngB = solidPng(0xff0000ff);
            String pngAId = upload(port, tenant, principal, token, run + "-a", "rig-a.png", "image/png", pngA);
            String pngBId = upload(port, tenant, principal, token, run + "-b", "rig-b.png", "image/png", pngB);

            // ---- audio repair ----
            JsonNode audio = post(port, tenant, token, AUDIO, Map.of("requestId", "repair-" + run,
                    "source", Map.of("artifactId", wavId, "artifactVersionId", "sha256:" + sha256(clipped)),
                    "profile", Map.of("threshold", 0.94, "maxRunFrames", 64)), 201);
            String audioId = audio.path("outputId").asString();
            String audioSha = audio.path("artifact").path("sha256").asString();
            assertThat(audioId).isNotEqualTo(wavId);
            assertThat(audio.path("lineage").path("kind").asString()).isEqualTo("AUDIO_REPAIR_CANDIDATE");
            assertThat(audio.path("lineage").path("source").path("sha256").asString()).isEqualTo(sha256(clipped));
            StoredArtifact audioRow = storedArtifact(POSTGRES, tenant, principal, audioId);
            assertThat(audioRow.contentType()).isEqualTo("audio/wav");
            assertThat(audioRow.sha256()).isEqualTo(audioSha);
            byte[] audioBytes = s3Bytes(LOCALSTACK, bucket, audioRow);
            assertThat(sha256(audioBytes)).isEqualTo(audioSha);
            assertThat(new String(audioBytes, 0, 4, StandardCharsets.US_ASCII)).isEqualTo("RIFF");
            assertThat(audioBytes).hasSameSizeAs(clipped).isNotEqualTo(clipped);
            // Source is untouched.
            StoredArtifact wavRow = storedArtifact(POSTGRES, tenant, principal, wavId);
            assertThat(s3Bytes(LOCALSTACK, bucket, wavRow)).isEqualTo(clipped);

            // ---- simulation ----
            JsonNode sim = post(port, tenant, token, SIM,
                    Map.of("requestId", "sim-" + run, "scenario", scenario(6.0, 6.0)), 201);
            String simId = sim.path("outputId").asString();
            String simSha = sim.path("artifact").path("sha256").asString();
            assertThat(sim.path("lineage").path("kind").asString()).isEqualTo("SIMULATED_OUTPUT_NOT_MEASUREMENT");
            assertThat(sim.path("lineage").path("validation").path("disposition").asString()).isEqualTo("VALID");
            StoredArtifact simRow = storedArtifact(POSTGRES, tenant, principal, simId);
            assertThat(simRow.contentType()).isEqualTo("application/json");
            byte[] simBytes = s3Bytes(LOCALSTACK, bucket, simRow);
            assertThat(sha256(simBytes)).isEqualTo(simSha);
            JsonNode simDocument = JSON.readTree(new String(simBytes, StandardCharsets.UTF_8));
            assertThat(simDocument.path("outputKind").asString()).isEqualTo("SIMULATED_OUTPUT_NOT_MEASUREMENT");
            assertThat(simDocument.path("observations").get(simDocument.path("observations").size() - 1)
                    .path("position").asDouble()).isEqualTo(6.0, org.assertj.core.data.Offset.offset(1e-8));

            // ---- spatial GLB sourced from uploaded artifacts ----
            List<Map<String, Object>> sources = List.of(
                    Map.of("artifactId", pngBId, "artifactVersionId", "sha256:" + sha256(pngB)),
                    Map.of("artifactId", pngAId, "artifactVersionId", "sha256:" + sha256(pngA)));
            JsonNode glb = post(port, tenant, token, SPATIAL, spatialBody("spatial-" + run, "rig-1", sources), 201);
            String glbId = glb.path("outputId").asString();
            String glbSha = glb.path("artifact").path("sha256").asString();
            assertThat(glb.path("artifact").path("contentType").asString()).isEqualTo("model/gltf-binary");
            assertThat(glb.path("lineage").path("kind").asString()).isEqualTo("SPATIAL_GLB_EXPORT");
            StoredArtifact glbRow = storedArtifact(POSTGRES, tenant, principal, glbId);
            assertThat(glbRow.contentType()).isEqualTo("model/gltf-binary");
            assertThat(glbRow.sha256()).isEqualTo(glbSha);
            byte[] glbBytes = s3Bytes(LOCALSTACK, bucket, glbRow);
            assertThat(sha256(glbBytes)).isEqualTo(glbSha);
            assertThat(new String(glbBytes, 0, 4, StandardCharsets.US_ASCII)).isEqualTo("glTF");
            ByteBuffer header = ByteBuffer.wrap(glbBytes).order(ByteOrder.LITTLE_ENDIAN);
            assertThat(header.getInt(4)).isEqualTo(2);
            assertThat(header.getInt(8)).isEqualTo(glbBytes.length);
            Map<String, String> sourceShas = new LinkedHashMap<>();
            glb.path("lineage").path("sources").forEach(source ->
                    sourceShas.put(source.path("artifactId").asString(), source.path("sha256").asString()));
            assertThat(sourceShas).containsEntry(pngAId, sha256(pngA)).containsEntry(pngBId, sha256(pngB));

            // ---- restart and reopen each ----
            stopLauncher(launcher);
            launcher = null;
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            token = issueDevToken(tenant, principal); // fresh short-lived token after the restart

            for (Object[] expected : new Object[][] {{audioId, audio, audioSha}, {simId, sim, simSha},
                    {glbId, glb, glbSha}}) {
                String id = (String) expected[0];
                JsonNode original = (JsonNode) expected[1];
                JsonNode reopened = get(port, tenant, token, "/dev/v1/creative-outputs/" + id, 200);
                assertThat(reopened.path("artifact").path("sha256").asString()).isEqualTo((String) expected[2]);
                assertThat(reopened.path("lineage")).isEqualTo(original.path("lineage"));
                assertThat(reopened.path("artifact").path("contentType").asString())
                        .isEqualTo(original.path("artifact").path("contentType").asString());
            }
            // Replays after restart resolve to the same outputs.
            JsonNode replayed = post(port, tenant, token, SPATIAL,
                    spatialBody("spatial-" + run, "rig-1", sources), 200);
            assertThat(replayed.path("outputId").asString()).isEqualTo(glbId);
            assertThat(replayed.path("replayed").asBoolean()).isTrue();

            // Foreign principal and non-output artifacts are not readable as creative outputs.
            String otherToken = issueDevToken(tenant, principal + "-other");
            HttpResponse<String> foreign = send(port, tenant, otherToken, "GET",
                    "/dev/v1/creative-outputs/" + glbId, null);
            assertThat(foreign.statusCode()).as(foreign.body()).isIn(403, 404);
            assertThat(foreign.body()).doesNotContain(glbSha);
            assertThat(send(port, tenant, token, "GET", "/dev/v1/creative-outputs/" + wavId, null).statusCode())
                    .isEqualTo(404);
        } finally {
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            Files.deleteIfExists(log);
            deleteTree(services);
        }
    }

    private static Map<String, Object> quantity(double value, String unit) {
        Map<String, Object> q = new LinkedHashMap<>();
        q.put("value", value);
        q.put("unit", unit);
        return q;
    }

    private static Map<String, Object> measurement(double value, String unit) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("value", quantity(value, unit));
        m.put("standardUncertainty", quantity(0, unit));
        return m;
    }

    /** Constant force 6 N on 2 kg for 2 s from rest: terminal position/velocity are both 6. */
    private static Map<String, Object> scenario(double expectedPosition, double force) {
        Map<String, Object> model = new LinkedHashMap<>();
        model.put("type", "CONSTANT_FORCE");
        model.put("mass", measurement(2, "KILOGRAM"));
        model.put("force", measurement(force, "NEWTON"));
        Map<String, Object> initial = new LinkedHashMap<>();
        initial.put("position", measurement(0, "METER"));
        initial.put("velocity", measurement(0, "METER_PER_SECOND"));
        Map<String, Object> policy = new LinkedHashMap<>();
        policy.put("duration", quantity(2, "SECOND"));
        policy.put("maxStep", quantity(0.25, "SECOND"));
        policy.put("minStep", quantity(1e-5, "SECOND"));
        policy.put("absolutePositionTolerance", quantity(1e-8, "METER"));
        policy.put("absoluteVelocityTolerance", quantity(1e-8, "METER_PER_SECOND"));
        policy.put("maxAcceptedSteps", 100);
        policy.put("maxIterations", 1000);
        Map<String, Object> invariant = new LinkedHashMap<>();
        invariant.put("id", "terminal-position");
        invariant.put("observable", "POSITION");
        invariant.put("expected", quantity(expectedPosition, "METER"));
        invariant.put("absoluteTolerance", quantity(1e-8, "METER"));
        Map<String, Object> scenario = new LinkedHashMap<>();
        scenario.put("model", model);
        scenario.put("initialState", initial);
        scenario.put("solverPolicy", policy);
        scenario.put("expectedDuration", quantity(2, "SECOND"));
        scenario.put("invariants", new ArrayList<>(List.of(invariant)));
        return scenario;
    }

    /** Two-bone rig with exact rational keyframes (0, 1/3, 1). */
    private static Map<String, Object> spatialBody(String requestId, String rigId, List<Map<String, Object>> sources) {
        double half = Math.sin(Math.PI / 12);
        double halfW = Math.cos(Math.PI / 12);
        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("frameRef", "urn:media:frame:glb");
        frame.put("frameVersionRef", "v1");
        frame.put("handedness", "RIGHT_HANDED");
        frame.put("axisDirections", new ArrayList<>(List.of("POS_X", "POS_Y", "POS_Z")));
        frame.put("positionUnitRef", "urn:media:spatial:unit:metre:v1");
        frame.put("orientationUnitRef", "urn:media:spatial:orientation:unit-quaternion-xyzw:v1");
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("id", "root");
        root.put("restPose", Map.of("position", List.of(0, 0, 0), "orientation", List.of(0, 0, 0, 1)));
        root.put("constraint", new LinkedHashMap<>(Map.of("kind", "BALL", "maxAngularDeviationRadians", Math.PI)));
        Map<String, Object> child = new LinkedHashMap<>();
        child.put("id", "child");
        child.put("parentId", "root");
        child.put("restPose", Map.of("position", List.of(0, 1, 0), "orientation", List.of(0, 0, 0, 1)));
        child.put("constraint", new LinkedHashMap<>(Map.of("kind", "BALL", "maxAngularDeviationRadians", Math.PI)));
        Map<String, Object> track = new LinkedHashMap<>();
        track.put("root", new ArrayList<>(List.of(
                key(0, 1, 0, 0, 0, 0, 0, 0, 1),
                key(1, 3, 0.5, 0, 0, 0, 0, half, halfW),
                key(1, 1, 1, 0, 0, 0, 0, 0.7071067811865476, 0.7071067811865476))));
        Map<String, Object> rig = new LinkedHashMap<>();
        rig.put("id", rigId);
        rig.put("sourceProjectRevisionRef", "project:edit:revision-8");
        rig.put("coordinateFrame", frame);
        rig.put("sourceVersions", new ArrayList<>(sources));
        rig.put("bones", new ArrayList<>(List.of(root, child)));
        rig.put("tracks", track);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("rig", rig);
        return body;
    }

    private static Map<String, Object> key(long num, long den, double x, double y, double z, double qx, double qy,
                                           double qz, double qw) {
        return Map.of("time", Map.of("numerator", num, "denominator", den),
                "pose", Map.of("position", List.of(x, y, z), "orientation", List.of(qx, qy, qz, qw)));
    }

    /** Mono 16-bit sine whose peaks exceed full scale and are hard-clipped. */
    private static byte[] clippedWav(int amplitude) {
        int[] samples = new int[RATE];
        for (int i = 0; i < samples.length; i++) {
            long v = Math.round(amplitude * Math.sin(2 * Math.PI * 440 * i / (double) RATE));
            samples[i] = (int) Math.max(-32768, Math.min(32767, v));
        }
        ByteBuffer wav = ByteBuffer.allocate(44 + samples.length * 2).order(ByteOrder.LITTLE_ENDIAN);
        wav.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + samples.length * 2)
                .put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) 1)
                .putInt(RATE).putInt(RATE * 2).putShort((short) 2).putShort((short) 16)
                .put("data".getBytes(StandardCharsets.US_ASCII)).putInt(samples.length * 2);
        for (int sample : samples) wav.putShort((short) sample);
        return wav.array();
    }
}
