package com.ghatana.media.integration;

import com.ghatana.media.launcher.MediaDevRigFrames;
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
import java.io.ByteArrayOutputStream;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffmpeg;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffprobe;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-13 {@code media.dev.outcome-three-dimensional-animation} against REAL processes: the real launcher with the durable
 * PostgreSQL + S3 artifact store and request ledger (Testcontainers) and real FFmpeg/ffprobe.
 *
 * <p>A 3-bone arm (joint limits, axis-angle keyframes about tilted axes, root translation, a rest rotation) with a
 * perspective camera, an end-effector marker and a textured floor (an uploaded asset with a PROCESSING rights
 * statement) is rendered through {@code POST /dev/v1/rigs/renders}. Everything below is verified INDEPENDENTLY of the
 * launcher's kinematics and rasterizer code:
 * <ul>
 *   <li>end-effector (and every bone) world positions per frame from this test's own forward kinematics match both the
 *       manifest and the transforms decoded from the STORED GLB (translation/rotation accessors, glTF LINEAR/slerp
 *       sampling, parent chain) to 1e-5 m;</li>
 *   <li>the marker centroid measured in the DECODED H.264 frames matches this test's own pinhole projection of that end
 *       effector to 1 px, the marker's pixel area matches 1/depth (right-handed Z toward the camera), and each bone's
 *       capsule is found at its independently projected midpoint;</li>
 *   <li>coordinate conventions (right-handed, Y-up, metres) are read back from the GLB extras;</li>
 *   <li>determinism: the same spec under new request ids yields identical frame digests, kinematics and GLB animation
 *       data, in one launcher, against an in-process render, and after the launcher was killed and restarted;</li>
 *   <li>PSNR of the decoded frames against the pre-encode frames (in-process render) is measured and compared with the
 *       manifest's own report.</li>
 * </ul>
 * Fault suite: joint limit / left-handed / budget refusals with their JSON paths, missing and revoked texture rights,
 * wrong tenant and owner, idempotent replay and a changed body (409), the real encoder killed mid-render, and the
 * launcher killed mid-render: each registers exactly one video, one GLB and one manifest. Missing runtime
 * prerequisites FAIL the test.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevRigRenderIT {
    private static final String RENDERS = "/dev/v1/rigs/renders";
    private static final int W = 320;
    private static final int H = 240;
    private static final int FRAMES = 48;
    private static final double FOV_DEG = 40;
    private static final double[] CAMERA = {0, 0.7, 3.6};
    private static final double[] TARGET = {0, 0.5, 0};
    private static final double MARKER_RADIUS = 0.07;

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    @SuppressWarnings("unchecked")
    void realLauncherRendersRigWithIndependentlyVerifiedKinematicsGlbAndPixelsAndSurvivesTheFaultSuite() throws Exception {
        assertThat(ffmpeg()).as("MEDIA_DEV_RENDER_FFMPEG").isNotBlank();
        assertThat(ffprobe()).as("MEDIA_DEV_RENDER_FFPROBE").isNotBlank();
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-rig-" + run;
        String otherTenant = "tenant-dev-rig-other-" + run;
        String principal = "media-dev-rig-" + run;
        String bucket = "media-dev-rig-" + run.substring(0, 16);
        String schema = "media_dev_rig_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-rig-services-");
        Path work = Files.createTempDirectory("media-dev-rig-work-");
        Path log = Files.createTempFile("media-dev-rig-process-", ".log");
        Process launcher = null;
        boolean passed = false;
        try {
            try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            MediaDevFaultInjector.ModeScript wrapper = MediaDevFaultInjector.ModeScript.ffmpeg(work, Path.of(ffmpeg()));
            Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
            environment.put("MEDIA_DEV_RENDER_FFMPEG", wrapper.path().toString());
            environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe());
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            String token = issueDevToken(tenant, principal);

            JsonNode status = get(port, tenant, token, "/dev/v1/rigs/status", 200);
            assertThat(status.path("ready").asBoolean()).isTrue();
            assertThat(status.path("limits").path("maxBones").asInt()).isEqualTo(16);
            assertThat(status.path("coordinateFrame").path("handedness").asString()).isEqualTo("RIGHT_HANDED");

            // ---- inputs: two lawful-texture candidates; A is attested, B is not ----
            byte[] textureA = texture(0xFF9AA5B8, 0xFF6E7A90);
            byte[] textureB = texture(0xFF7FA58A, 0xFF4F7A5C);
            String assetA = upload(port, tenant, principal, token, run + "-a", "floor-a.png", "image/png", textureA);
            String assetB = upload(port, tenant, principal, token, run + "-b", "floor-b.png", "image/png", textureB);
            String versionA = "sha256:" + sha256(textureA);
            String versionB = "sha256:" + sha256(textureB);
            assertThat(rows(tenant, principal, "video/mp4")).isZero();

            // ---- fault: typed 422 with JSON paths (joint limit, coordinates, structure, budgets); nothing registered ----
            Map<String, Object> over = spec(assetA, versionA);
            ((Map<String, Object>) ((List<?>) ((Map<String, Object>) ((List<?>) over.get("bones")).get(1)).get("keyframes")).get(1))
                    .put("rotation", Map.of("axis", List.of(0, 0, 1), "degrees", 141));
            JsonNode limit = expect(port, tenant, token, request("limit-" + run, over, 14), 422, "JOINT_LIMIT_EXCEEDED");
            assertThat(limit.path("error").path("details").path("path").asString()).isEqualTo("$.bones[1].keyframes[1].rotation");
            assertThat(limit.path("error").path("details").path("bone").asString()).isEqualTo("elbow");
            assertThat(limit.path("error").path("details").path("limitDegrees").asDouble()).isEqualTo(140.0);
            Map<String, Object> between = spec(assetA, versionA);
            Map<String, Object> shoulder = (Map<String, Object>) ((List<?>) between.get("bones")).get(0);
            shoulder.put("maxDeviationDegrees", 175);
            shoulder.put("keyframes", List.of(
                    Map.of("frame", 0, "rotation", Map.of("axis", List.of(0, 0, 1), "degrees", 170)),
                    Map.of("frame", 40, "rotation", Map.of("axis", List.of(0, 0, 1), "degrees", -170))));
            JsonNode interval = expect(port, tenant, token, request("between-" + run, between, 14), 422, "JOINT_LIMIT_EXCEEDED");
            assertThat(interval.path("error").path("details").path("path").asString()).startsWith("$.bones[0].keyframes");
            Map<String, Object> leftHanded = spec(assetA, versionA);
            ((Map<String, Object>) leftHanded.get("coordinateFrame")).put("handedness", "LEFT_HANDED");
            assertThat(expect(port, tenant, token, request("lh-" + run, leftHanded, 14), 422, "COORDINATE_PROFILE_UNSUPPORTED")
                    .path("error").path("details").path("path").asString()).isEqualTo("$.coordinateFrame.handedness");
            Map<String, Object> zUp = spec(assetA, versionA);
            ((Map<String, Object>) zUp.get("coordinateFrame")).put("upAxis", "Z");
            expect(port, tenant, token, request("zup-" + run, zUp, 14), 422, "COORDINATE_PROFILE_UNSUPPORTED");
            Map<String, Object> badKey = spec(assetA, versionA);
            ((Map<String, Object>) ((List<?>) ((Map<String, Object>) ((List<?>) badKey.get("bones")).get(2)).get("keyframes")).get(1))
                    .put("frame", 0);
            assertThat(expect(port, tenant, token, request("badkey-" + run, badKey, 14), 422, "RIG_SPEC_INVALID")
                    .path("error").path("details").path("path").asString()).isEqualTo("$.bones[2].keyframes[1].frame");
            Map<String, Object> tooMany = spec(assetA, versionA);
            tooMany.put("frameCount", 241);
            JsonNode budget = expect(port, tenant, token, request("budget-" + run, tooMany, 14), 422, "RIG_BUDGET_EXCEEDED");
            assertThat(budget.path("error").path("details").path("requested").asInt()).isEqualTo(241);
            Map<String, Object> tooBig = spec(assetA, versionA);
            tooBig.put("width", 960);
            tooBig.put("height", 540);
            tooBig.put("frameCount", 100);
            assertThat(expect(port, tenant, token, request("budget2-" + run, tooBig, 14), 422, "RIG_BUDGET_EXCEEDED")
                    .path("error").path("details").path("limit").asString()).contains("total render pixels");
            assertThat(rows(tenant, principal, "video/mp4")).isZero();
            assertThat(rows(tenant, principal, "model/gltf-binary")).isZero();
            assertThat(rows(tenant, principal, "application/json")).isZero();

            // ---- fault: floor texture without a rights statement is a typed 403; nothing rendered or registered ----
            Map<String, Object> golden = spec(assetA, versionA);
            JsonNode denied = expect(port, tenant, token, request("golden-" + run, golden, 14), 403, "RIGHTS_NOT_ADMITTED");
            assertThat(denied.path("error").path("details").path("verdict").asString()).isEqualTo("DENIED");
            assertThat(denied.path("error").path("details").path("artifactId").asString()).isEqualTo(assetA);
            assertThat(rows(tenant, principal, "video/mp4")).isZero();
            String attestationA = attest(port, tenant, token, assetA, versionA, "A");

            // ---- the render: stored MP4 + GLB + manifest ----
            long started = System.nanoTime();
            JsonNode created = render(port, tenant, token, request("golden-" + run, golden, 14), 201);
            long renderMillis = (System.nanoTime() - started) / 1_000_000;
            assertThat(created.path("replayed").asBoolean()).isFalse();
            String renderId = created.path("renderId").asString();
            assertThat(created.path("video").path("contentType").asString()).isEqualTo("video/mp4");
            assertThat(created.path("glb").path("contentType").asString()).isEqualTo("model/gltf-binary");
            assertThat(rows(tenant, principal, "golden-" + run)).as("one video, one GLB, one manifest").isEqualTo(3);
            JsonNode manifest = created.path("manifest");
            assertThat(manifest.path("frames")).hasSize(FRAMES);
            assertThat(created.path("videoLineage").path("parent").path("artifactId").asString()).isEqualTo(assetA);
            assertThat(created.path("glbLineage").path("glb").path("sourceVersions")).hasSize(2);

            // ---- independent verification of the STORED bytes ----
            byte[] mp4 = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, created.path("video").path("artifactId").asString()));
            byte[] glbBytes = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, created.path("glb").path("artifactId").asString()));
            assertThat(sha256(mp4)).isEqualTo(created.path("video").path("sha256").asString());
            assertThat(sha256(glbBytes)).isEqualTo(created.path("glb").path("sha256").asString());
            Path file = work.resolve("rig.mp4");
            Files.write(file, mp4);
            Probe probe = probe(file);
            assertThat(probe.codec).isEqualTo("h264");
            assertThat(probe.pixFmt).isEqualTo("yuv420p");
            assertThat(probe.width).isEqualTo(W);
            assertThat(probe.height).isEqualTo(H);
            assertThat(probe.avgFrameRate).isEqualTo("24/1");
            assertThat(probe.pts).hasSize(FRAMES);
            long ticks = Long.parseLong(manifest.path("verification").path("ticksPerFrame").asString());
            for (int i = 0; i < FRAMES; i++) assertThat(probe.pts.get(i)).isEqualTo(i * ticks);
            assertThat(probe.readFrames).isEqualTo(FRAMES);
            System.out.printf("J13-IT-ENCODE renderMillis=%d mp4Bytes=%d glbBytes=%d codec=%s fps=%s frames=%d profile=%s%n",
                    renderMillis, mp4.length, glbBytes.length, probe.codec, probe.avgFrameRate, probe.pts.size(), probe.profile);

            // ---- GLB: decoded transforms vs this test's own FK (<= 1e-5 m) ----
            Glb glb = Glb.decode(glbBytes);
            assertThat(glb.json.path("asset").path("version").asString()).isEqualTo("2.0");
            JsonNode spatial = glb.json.path("extras").path("mediaSpatial");
            assertThat(spatial.path("handedness").asString()).isEqualTo("RIGHT_HANDED");
            assertThat(spatial.path("axisDirections").toString()).isEqualTo("[\"POS_X\",\"POS_Y\",\"POS_Z\"]");
            assertThat(spatial.path("positionUnitRef").asString()).isEqualTo("urn:media:spatial:unit:metre:v1");
            assertThat(spatial.path("orientationUnitRef").asString()).isEqualTo("urn:media:spatial:orientation:unit-quaternion-xyzw:v1");
            assertThat(spatial.path("lossDisposition").asString()).isEqualTo("FLOAT32_APPROXIMATION");
            assertThat(spatial.path("sourceVersions")).hasSize(2);
            assertThat(glb.json.path("nodes")).hasSize(3);
            double maxGlbError = 0;
            double maxManifestError = 0;
            double maxBoneError = 0;
            double[][] effectorWorld = new double[FRAMES][];
            for (int f = 0; f < FRAMES; f++) {
                Map<String, double[][]> world = fk(f);
                double[] expected = effector(world);
                effectorWorld[f] = expected;
                Map<String, double[][]> decoded = glb.world(f / 24.0);
                double[] viaGlb = effector(decoded);
                maxGlbError = Math.max(maxGlbError, dist(expected, viaGlb));
                JsonNode frame = manifest.path("frames").path(f);
                double[] viaManifest = vec(frame.path("endEffector").path("world"));
                maxManifestError = Math.max(maxManifestError, dist(expected, viaManifest));
                for (String bone : List.of("shoulder", "elbow", "wrist")) {
                    maxBoneError = Math.max(maxBoneError, dist(world.get(bone)[0], decoded.get(bone)[0]));
                    maxBoneError = Math.max(maxBoneError, dist(world.get(bone)[0], vec(frame.path("bones").path(bone).path("position"))));
                }
            }
            System.out.printf("J13-IT-KINEMATICS frames=%d maxEndEffectorErrGlbVsIndependentFk=%.3e m maxEndEffectorErrManifestVsFk=%.3e m "
                    + "maxAllBoneOriginErr=%.3e m%n", FRAMES, maxGlbError, maxManifestError, maxBoneError);
            assertThat(maxGlbError).isLessThanOrEqualTo(1e-5);
            assertThat(maxManifestError).isLessThanOrEqualTo(1e-5);
            assertThat(maxBoneError).isLessThanOrEqualTo(1e-5);
            double reach = 0;
            for (int f = 1; f < FRAMES; f++) reach = Math.max(reach, dist(effectorWorld[0], effectorWorld[f]));
            assertThat(reach).as("the end effector really moves in 3D").isGreaterThan(0.4);
            double zRange = 0;
            for (int f = 1; f < FRAMES; f++) zRange = Math.max(zRange, Math.abs(effectorWorld[f][2] - effectorWorld[0][2]));
            assertThat(zRange).as("motion has real depth, not just a plane").isGreaterThan(0.05);

            // ---- joint angles in the manifest vs independently computed deviation from rest ----
            double maxAngleError = 0;
            for (int f = 0; f < FRAMES; f++) {
                for (Bone bone : BONES) {
                    double expected = Math.toDegrees(bone.deviation(f));
                    double reported = manifest.path("frames").path(f).path("jointAnglesDegrees").path(bone.id).asDouble();
                    maxAngleError = Math.max(maxAngleError, Math.abs(expected - reported));
                    assertThat(reported).as(bone.id + " within its limit at frame " + f).isLessThanOrEqualTo(bone.maxDegrees + 1e-6);
                }
            }
            System.out.printf("J13-IT-JOINT-ANGLES maxErrVsIndependentDeg=%.3e%n", maxAngleError);
            assertThat(maxAngleError).isLessThanOrEqualTo(1e-6);

            // ---- DECODED video: marker centroid, marker area, bone capsules ----
            byte[] decoded = decodeRgb(file);
            assertThat(decoded).hasSize(FRAMES * W * H * 3);
            double focal = H / (2 * Math.tan(Math.toRadians(FOV_DEG) / 2));
            double maxMarkerErr = 0;
            List<Double> areaRatios = new ArrayList<>();
            List<String> capsuleMisses = new ArrayList<>();
            int capsuleHits = 0;
            int capsuleSamples = 0;
            for (int f = 0; f < FRAMES; f++) {
                double[] projected = project(effectorWorld[f], focal);
                double sx = 0, sy = 0;
                int n = 0;
                for (int y = 0; y < H; y++) {
                    for (int x = 0; x < W; x++) {
                        int i = f * W * H * 3 + (y * W + x) * 3;
                        if ((decoded[i] & 0xff) > 170 && (decoded[i + 1] & 0xff) < 110 && (decoded[i + 2] & 0xff) > 170) {
                            sx += x + 0.5; sy += y + 0.5; n++;
                        }
                    }
                }
                assertThat(n).as("marker pixels in decoded frame " + f).isGreaterThan(20);
                double err = Math.hypot(sx / n - projected[0], sy / n - projected[1]);
                maxMarkerErr = Math.max(maxMarkerErr, err);
                double expectedArea = Math.PI * Math.pow(focal * MARKER_RADIUS / projected[2], 2);
                areaRatios.add(n / expectedArea);
                Map<String, double[][]> world = fk(f);
                for (Bone bone : BONES) {
                    double[][] pose = world.get(bone.id);
                    double[] tipWorld = add(pose[0], rotate(pose[1], bone.tip));
                    double[] mid = {(pose[0][0] + tipWorld[0]) / 2, (pose[0][1] + tipWorld[1]) / 2, (pose[0][2] + tipWorld[2]) / 2};
                    double[] px = project(mid, focal);
                    // the end-effector marker is an overlay disc: a bone midpoint under it shows the marker, not the bone
                    if (Math.hypot(px[0] - projected[0], px[1] - projected[1]) <= focal * MARKER_RADIUS / projected[2] + 2) continue;
                    int x = (int) Math.floor(px[0]);
                    int y = (int) Math.floor(px[1]);
                    int i = f * W * H * 3 + (y * W + x) * 3;
                    int r = decoded[i] & 0xff, g = decoded[i + 1] & 0xff, b = decoded[i + 2] & 0xff;
                    capsuleSamples++;
                    if (nearest(r, g, b) == bone.rgb) capsuleHits++;
                    else capsuleMisses.add("f" + f + ":" + bone.id + "@" + x + "," + y + "=" + r + "/" + g + "/" + b);
                }
            }
            List<Double> sortedRatios = new ArrayList<>(areaRatios);
            java.util.Collections.sort(sortedRatios);
            double medianRatio = sortedRatios.get(sortedRatios.size() / 2);
            double maxAreaDeviation = 0;
            for (double ratio : areaRatios) maxAreaDeviation = Math.max(maxAreaDeviation, Math.abs(ratio / medianRatio - 1));
            System.out.printf("J13-IT-PIXELS maxMarkerCentroidErrorPx=%.3f markerAreaRatioToPiRSquared median=%.3f maxDeviationFromMedian=%.3f "
                            + "boneCapsuleMidpointHits=%d/%d misses=%s%n", maxMarkerErr, medianRatio, maxAreaDeviation, capsuleHits,
                    capsuleSamples, capsuleMisses);
            assertThat(maxMarkerErr).as("decoded marker centroid vs independent projection").isLessThanOrEqualTo(1.0);
            assertThat(medianRatio).as("threshold area vs the projected disc").isBetween(0.7, 1.15);
            assertThat(maxAreaDeviation).as("marker area follows 1/depth^2 frame by frame (right-handed Z toward the viewer)")
                    .isLessThan(0.15);
            assertThat(capsuleHits).as("each bone capsule is rendered where independent FK puts it: " + capsuleMisses)
                    .isGreaterThanOrEqualTo((int) (capsuleSamples * 0.97));

            // ---- pre-encode frames: this test renders the same spec in-process; digests and PSNR ----
            MediaDevRigFrames.Result local = MediaDevRigFrames.render(tenant, golden, textureA);
            assertThat(local.frameSetSha256()).as("launcher frame set == in-process render").isEqualTo(manifest.path("frameSetSha256").asString());
            double minPsnr = Double.MAX_VALUE, sumPsnr = 0;
            int worst = -1;
            double maxReportedDelta = 0;
            for (int f = 0; f < FRAMES; f++) {
                assertThat(sha256(local.rgb24Frames().get(f))).isEqualTo(manifest.path("frames").path(f).path("pixelSha256").asString());
                double psnr = psnr(local.rgb24Frames().get(f), 0, decoded, f * W * H * 3, W * H * 3);
                sumPsnr += psnr;
                if (psnr < minPsnr) { minPsnr = psnr; worst = f; }
                maxReportedDelta = Math.max(maxReportedDelta, Math.abs(psnr - manifest.path("frames").path(f).path("psnrDb").asDouble()));
            }
            System.out.printf("J13-IT-PSNR decoded-vs-preencode frames=%d minPsnrDb=%.2f (frame %d) meanPsnrDb=%.2f; manifest-reported min=%.2f mean=%.2f "
                            + "maxPerFrameDelta=%.3f dB%n", FRAMES, minPsnr, worst, sumPsnr / FRAMES,
                    manifest.path("quality").path("minPsnrDb").asDouble(), manifest.path("quality").path("meanPsnrDb").asDouble(), maxReportedDelta);
            assertThat(minPsnr).isGreaterThan(30.0);
            assertThat(maxReportedDelta).as("manifest PSNR (explicit bt709 accurate-rounding decode) vs this test's default FFmpeg decode")
                    .isLessThan(3.0);

            // ---- determinism: same spec, new request ids, same frames/kinematics/GLB animation data ----
            JsonNode second = render(port, tenant, token, request("golden-b-" + run, golden, 14), 201);
            assertThat(second.path("manifest").path("frameSetSha256").asString()).isEqualTo(manifest.path("frameSetSha256").asString());
            assertThat(second.path("manifest").path("frames").toString().replaceAll("\"psnrDb\":[0-9.E-]+", ""))
                    .isEqualTo(manifest.path("frames").toString().replaceAll("\"psnrDb\":[0-9.E-]+", ""));
            byte[] glb2 = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, second.path("glb").path("artifactId").asString()));
            assertThat(Glb.decode(glb2).bin).as("GLB animation buffers identical").isEqualTo(glb.bin);
            assertThat(second.path("glb").path("sha256").asString()).as("GLB binds the request id").isNotEqualTo(created.path("glb").path("sha256").asString());
            assertThat(second.path("video").path("sha256").asString()).isNotEqualTo(created.path("video").path("sha256").asString());

            // ---- idempotent replay and a changed body under the same requestId ----
            int videosBefore = rows(tenant, principal, "video/mp4");
            JsonNode replay = render(port, tenant, token, request("golden-" + run, golden, 14), 200);
            assertThat(replay.path("replayed").asBoolean()).isTrue();
            assertThat(replay.path("renderId").asString()).isEqualTo(renderId);
            assertThat(replay.path("glb").path("sha256").asString()).isEqualTo(created.path("glb").path("sha256").asString());
            Map<String, Object> changed = spec(assetA, versionA);
            changed.put("background", "#000000");
            expect(port, tenant, token, request("golden-" + run, changed, 14), 409, "RIG_REQUEST_ID_REUSED");
            expect(port, tenant, token, request("golden-" + run, golden, 20), 409, "RIG_REQUEST_ID_REUSED");
            assertThat(rows(tenant, principal, "video/mp4")).isEqualTo(videosBefore);

            // ---- wrong tenant: the texture and the render are invisible; nothing is registered there ----
            String otherToken = issueDevToken(otherTenant, principal);
            expect(port, otherTenant, otherToken, request("foreign-" + run, golden, 14), 404, "SOURCE_VERSION_NOT_FOUND");
            assertThat(send(port, otherTenant, otherToken, "GET", RENDERS + "/" + renderId, null).statusCode()).isEqualTo(404);
            assertThat(rows(otherTenant, principal, "video/mp4")).isZero();
            assertThat(send(port, tenant, issueDevToken(tenant, "someone-else-" + run), "GET", RENDERS + "/" + renderId, null).statusCode())
                    .isEqualTo(404);

            // ---- revoked rights: a NEW request and a REPLAY of the stored render are both refused ----
            assertThat(post(port, tenant, token, "/dev/v1/rights/attestations/" + attestationA + "/revoke",
                    Map.of("reason", "TEST: revoked to prove fail-closed"), 200).path("status").asString()).isEqualTo("REVOKED");
            assertThat(expect(port, tenant, token, request("golden2-" + run, golden, 14), 403, "RIGHTS_NOT_ADMITTED")
                    .path("error").path("details").path("verdict").asString()).isEqualTo("REVOKED");
            expect(port, tenant, token, request("golden-" + run, golden, 14), 403, "RIGHTS_NOT_ADMITTED");
            assertThat(rows(tenant, principal, "video/mp4")).isEqualTo(videosBefore);
            attest(port, tenant, token, assetB, versionB, "B");
            Map<String, Object> goldenB = spec(assetB, versionB);

            // ---- the real encoder killed mid-render: UNKNOWN, nothing registered, then exactly one registration ----
            wrapper.mode("hang");
            String killBody = request("kill-encoder-" + run, goldenB, 14);
            CompletableFuture<HttpResponse<String>> inFlight = sendAsync(port, tenant, token, killBody);
            ProcessHandle encoder = MediaDevFaultInjector.awaitDescendant(launcher, "sleep 3600", Duration.ofSeconds(120));
            assertThat(inFlight.isDone()).isFalse();
            MediaDevFaultInjector.signal(encoder, "KILL");
            HttpResponse<String> unknown = inFlight.get(2, TimeUnit.MINUTES);
            assertThat(unknown.statusCode()).as(unknown.body()).isEqualTo(503);
            assertThat(unknown.body()).contains("RIG_OUTCOME_UNKNOWN").contains("\"outcome\":\"UNKNOWN\"");
            assertThat(rows(tenant, principal, "kill-encoder-" + run)).as("the killed run registered nothing").isZero();
            wrapper.mode("ok");
            JsonNode retried = render(port, tenant, token, killBody, 201);
            assertThat(retried.path("replayed").asBoolean()).isFalse();
            assertThat(render(port, tenant, token, killBody, 200).path("renderId").asString()).isEqualTo(retried.path("renderId").asString());
            assertThat(rows(tenant, principal, "kill-encoder-" + run)).as("one video, one GLB, one manifest").isEqualTo(3);

            // ---- the launcher killed mid-render: restart, retry the same requestId, exactly one registration ----
            wrapper.mode("hang");
            String crashBody = request("kill-launcher-" + run, goldenB, 14);
            CompletableFuture<HttpResponse<String>> doomed = sendAsync(port, tenant, token, crashBody);
            MediaDevFaultInjector.awaitDescendant(launcher, "sleep 3600", Duration.ofSeconds(120));
            List<ProcessHandle> orphans = MediaDevFaultInjector.descendants(launcher);
            launcher.destroyForcibly();
            for (ProcessHandle orphan : orphans) orphan.destroyForcibly();
            assertThat(launcher.waitFor(30, TimeUnit.SECONDS)).isTrue();
            try {
                doomed.get(1, TimeUnit.MINUTES);
                throw new AssertionError("the in-flight request of a killed launcher cannot complete");
            } catch (java.util.concurrent.ExecutionException expected) {
                // the connection died with the launcher
            }
            assertThat(rows(tenant, principal, "kill-launcher-" + run)).as("nothing registered by the killed launcher").isZero();
            wrapper.mode("ok");
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            token = issueDevToken(tenant, principal);
            JsonNode afterCrash = render(port, tenant, token, crashBody, 201);
            assertThat(afterCrash.path("replayed").asBoolean()).isFalse();
            assertThat(render(port, tenant, token, crashBody, 200).path("renderId").asString()).isEqualTo(afterCrash.path("renderId").asString());
            assertThat(rows(tenant, principal, "kill-launcher-" + run)).as("exactly one video, one GLB and one manifest").isEqualTo(3);

            // ---- restart: replay and determinism across the restart ----
            JsonNode replayAfterRestart = render(port, tenant, token, request("kill-encoder-" + run, goldenB, 14), 200);
            assertThat(replayAfterRestart.path("renderId").asString()).isEqualTo(retried.path("renderId").asString());
            JsonNode again = render(port, tenant, token, request("restart-1-" + run, goldenB, 14), 201);
            assertThat(again.path("manifest").path("frameSetSha256").asString())
                    .as("same spec after a launcher kill+restart: identical pre-encode frame set")
                    .isEqualTo(retried.path("manifest").path("frameSetSha256").asString())
                    .isEqualTo(afterCrash.path("manifest").path("frameSetSha256").asString());
            byte[] glbAfter = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, again.path("glb").path("artifactId").asString()));
            byte[] glbBefore = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, retried.path("glb").path("artifactId").asString()));
            assertThat(Glb.decode(glbAfter).bin).as("GLB animation data identical across the restart").isEqualTo(Glb.decode(glbBefore).bin);
            assertThat(Glb.decode(glbAfter).bin).as("texture B does not change the rig data").isEqualTo(glb.bin);
            // revoked texture A: the stored golden render is still readable by id (reads are not processing)
            JsonNode reopened = get(port, tenant, token, RENDERS + "/" + renderId, 200);
            assertThat(reopened.path("manifest").path("frameSetSha256").asString()).isEqualTo(manifest.path("frameSetSha256").asString());
            System.out.println("J13-IT-DETERMINISM frameSetSha256(textureA)=" + manifest.path("frameSetSha256").asString()
                    + " identical across two requests and the in-process render; textureB set=" + again.path("manifest").path("frameSetSha256").asString()
                    + " identical across three requests incl. a launcher kill+restart; GLB animation buffers identical in all five renders");
            passed = true;
        } finally {
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("J-13 rig IT failure log retained at " + log);
            deleteTree(services);
            deleteTree(work);
        }
    }

    // ------------------------------------------------------------------------------------------ the scene

    private static final class Key {
        final int frame;
        final double[] axis;
        final double degrees;
        final double[] position; // null = rest position

        Key(int frame, double[] axis, double degrees, double[] position) {
            this.frame = frame; this.axis = axis; this.degrees = degrees; this.position = position;
        }
    }

    private static final class Bone {
        final String id;
        final String parent;
        final double[] rest;
        final double[] restAxis;
        final double restDegrees;
        final double[] tip;
        final double radius;
        final String color;
        final int rgb;
        final double maxDegrees;
        final List<Key> keys;

        Bone(String id, String parent, double[] rest, double[] restAxis, double restDegrees, double[] tip, double radius,
             String color, double maxDegrees, List<Key> keys) {
            this.id = id; this.parent = parent; this.rest = rest; this.restAxis = restAxis; this.restDegrees = restDegrees;
            this.tip = tip; this.radius = radius; this.color = color; this.maxDegrees = maxDegrees; this.keys = keys;
            this.rgb = Integer.parseInt(color.substring(1), 16);
        }

        double[] restQ() { return axisAngle(restAxis, restDegrees); }

        /** Local pose at a frame: lerped position, slerped (rest * delta) rotation, clamped outside the keys. */
        double[][] local(int frame) {
            double[] q0 = restQ();
            if (keys.isEmpty()) return new double[][] {rest, q0};
            Key first = keys.getFirst();
            Key last = keys.getLast();
            if (frame <= first.frame) return new double[][] {pos(first), mulQ(q0, axisAngle(first.axis, first.degrees))};
            if (frame >= last.frame) return new double[][] {pos(last), mulQ(q0, axisAngle(last.axis, last.degrees))};
            for (int i = 1; i < keys.size(); i++) {
                Key right = keys.get(i);
                if (frame <= right.frame) {
                    Key left = keys.get(i - 1);
                    double t = (double) (frame - left.frame) / (right.frame - left.frame);
                    double[] a = pos(left), b = pos(right);
                    double[] position = {a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t};
                    return new double[][] {position, slerp(mulQ(q0, axisAngle(left.axis, left.degrees)),
                            mulQ(q0, axisAngle(right.axis, right.degrees)), t)};
                }
            }
            throw new IllegalStateException();
        }

        double[] pos(Key key) { return key.position == null ? rest : key.position; }

        /** Angular deviation from rest of the local orientation (radians). */
        double deviation(int frame) {
            double[] q = local(frame)[1];
            double[] r = restQ();
            double dot = Math.abs(q[0] * r[0] + q[1] * r[1] + q[2] * r[2] + q[3] * r[3]);
            return 2 * Math.acos(Math.min(1, dot));
        }
    }

    private static final List<Bone> BONES = List.of(
            new Bone("shoulder", null, new double[] {-0.7, 0.3, 0}, new double[] {0, 0, 1}, 0, new double[] {0.6, 0, 0}, 0.05,
                    "#4080FF", 120, List.of(
                            new Key(0, new double[] {0, 0, 1}, 0, new double[] {-0.7, 0.3, 0}),
                            new Key(20, new double[] {0.15, 0.1, 1}, 55, new double[] {-0.55, 0.4, 0.1}),
                            new Key(47, new double[] {0, 0, 1}, -15, new double[] {-0.5, 0.3, 0.2}))),
            new Bone("elbow", "shoulder", new double[] {0.6, 0, 0}, new double[] {0, 0, 1}, 10, new double[] {0.5, 0, 0}, 0.04,
                    "#40FF80", 140, List.of(
                            new Key(0, new double[] {0, 0, 1}, 0, null),
                            new Key(24, new double[] {0, 0, 1}, 80, null),
                            new Key(47, new double[] {0, 0, 1}, 15, null))),
            new Bone("wrist", "elbow", new double[] {0.5, 0, 0}, new double[] {0, 1, 0}, 0, new double[] {0.25, 0, 0}, 0.03,
                    "#FFC040", 90, List.of(
                            new Key(0, new double[] {0, 1, 0}, 0, null),
                            new Key(30, new double[] {0, 1, 0.3}, 60, null),
                            new Key(47, new double[] {0, 1, 0}, 25, null))));
    private static final double[] EFFECTOR_OFFSET = {0.25, 0, 0};

    private static Map<String, Object> spec(String textureArtifactId, String textureVersion) {
        Map<String, Object> spec = new LinkedHashMap<>();
        spec.put("width", W);
        spec.put("height", H);
        spec.put("background", "#101828");
        spec.put("fps", new LinkedHashMap<>(Map.of("numerator", 24, "denominator", 1)));
        spec.put("frameCount", FRAMES);
        spec.put("coordinateFrame", new LinkedHashMap<>(Map.of("handedness", "RIGHT_HANDED", "upAxis", "Y", "unit", "METRE")));
        Map<String, Object> camera = new LinkedHashMap<>();
        camera.put("position", list(CAMERA));
        camera.put("lookAt", list(TARGET));
        camera.put("verticalFovDegrees", FOV_DEG);
        camera.put("near", 0.1);
        camera.put("far", 30.0);
        spec.put("camera", camera);
        List<Object> bones = new ArrayList<>();
        for (Bone bone : BONES) {
            Map<String, Object> json = new LinkedHashMap<>();
            json.put("id", bone.id);
            json.put("parent", bone.parent);
            json.put("restPosition", list(bone.rest));
            if (bone.restDegrees != 0) json.put("restRotation", new LinkedHashMap<>(Map.of("axis", list(bone.restAxis), "degrees", bone.restDegrees)));
            json.put("tip", list(bone.tip));
            json.put("radius", bone.radius);
            json.put("color", bone.color);
            json.put("maxDeviationDegrees", bone.maxDegrees);
            List<Object> keys = new ArrayList<>();
            for (Key key : bone.keys) {
                Map<String, Object> k = new LinkedHashMap<>();
                k.put("frame", key.frame);
                k.put("rotation", new LinkedHashMap<>(Map.of("axis", list(key.axis), "degrees", key.degrees)));
                if (key.position != null) k.put("position", list(key.position));
                keys.add(k);
            }
            json.put("keyframes", keys);
            bones.add(json);
        }
        spec.put("bones", bones);
        spec.put("endEffector", new LinkedHashMap<>(Map.of("bone", "wrist", "offset", list(EFFECTOR_OFFSET),
                "markerRadius", MARKER_RADIUS, "color", "#FF00FF")));
        Map<String, Object> floor = new LinkedHashMap<>();
        floor.put("y", -0.5);
        floor.put("halfExtent", 3.0);
        floor.put("tiles", 6);
        floor.put("colorA", "#808080");
        floor.put("colorB", "#404040");
        floor.put("textureAssetId", "floorTexture");
        spec.put("floor", floor);
        spec.put("assets", new ArrayList<>(List.of(new LinkedHashMap<>(Map.of("id", "floorTexture", "artifactId", textureArtifactId,
                "artifactVersionId", textureVersion)))));
        return spec;
    }

    private static List<Object> list(double... values) {
        List<Object> out = new ArrayList<>();
        for (double v : values) out.add(v);
        return out;
    }

    private static String request(String requestId, Map<String, Object> spec, int crf) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("spec", spec);
        body.put("encoder", Map.of("crf", crf));
        return JSON.writeValueAsString(body);
    }

    private static byte[] texture(int first, int second) throws Exception {
        BufferedImage image = new BufferedImage(16, 16, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < 16; y++) for (int x = 0; x < 16; x++) image.setRGB(x, y, ((x / 8 + y / 8) % 2 == 0) ? first : second);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(image, "png", out);
        return out.toByteArray();
    }

    // ------------------------------------------------------------------------------------------ independent math

    private static double[] axisAngle(double[] axis, double degrees) {
        double n = Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]);
        double half = Math.toRadians(degrees) / 2;
        double s = Math.sin(half) / n;
        return canonical(new double[] {axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)});
    }

    private static double[] canonical(double[] q) {
        double n = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
        double[] r = {q[0] / n, q[1] / n, q[2] / n, q[3] / n};
        if (r[3] < 0) for (int i = 0; i < 4; i++) r[i] = -r[i];
        return r;
    }

    /** Hamilton product a*b for [x,y,z,w]. */
    private static double[] mulQ(double[] a, double[] b) {
        return new double[] {
                a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
                a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
                a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
                a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]};
    }

    private static double[] rotate(double[] q, double[] v) {
        // v' = v + 2w(q x v) + 2 q x (q x v)
        double[] qv = {q[0], q[1], q[2]};
        double[] t = scale(cross(qv, v), 2);
        return add(add(v, scale(t, q[3])), cross(qv, t));
    }

    private static double[] slerp(double[] a, double[] b, double t) {
        double dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
        double[] bb = b;
        if (dot < 0) { dot = -dot; bb = new double[] {-b[0], -b[1], -b[2], -b[3]}; }
        if (dot > 0.9995) {
            return canonical(new double[] {a[0] + t * (bb[0] - a[0]), a[1] + t * (bb[1] - a[1]), a[2] + t * (bb[2] - a[2]),
                    a[3] + t * (bb[3] - a[3])});
        }
        double theta = Math.acos(dot);
        double sa = Math.sin((1 - t) * theta) / Math.sin(theta);
        double sb = Math.sin(t * theta) / Math.sin(theta);
        return canonical(new double[] {sa * a[0] + sb * bb[0], sa * a[1] + sb * bb[1], sa * a[2] + sb * bb[2], sa * a[3] + sb * bb[3]});
    }

    private static double[] cross(double[] a, double[] b) {
        return new double[] {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
    }

    private static double[] add(double[] a, double[] b) { return new double[] {a[0] + b[0], a[1] + b[1], a[2] + b[2]}; }

    private static double[] scale(double[] a, double s) { return new double[] {a[0] * s, a[1] * s, a[2] * s}; }

    private static double dist(double[] a, double[] b) { return Math.sqrt(Math.pow(a[0] - b[0], 2) + Math.pow(a[1] - b[1], 2) + Math.pow(a[2] - b[2], 2)); }

    private static double[] vec(JsonNode node) { return new double[] {node.path(0).asDouble(), node.path(1).asDouble(), node.path(2).asDouble()}; }

    /** World {position, rotation} of every bone from the spec's own keyframes. */
    private static Map<String, double[][]> fk(int frame) {
        Map<String, double[][]> world = new LinkedHashMap<>();
        for (Bone bone : BONES) {
            double[][] local = bone.local(frame);
            if (bone.parent == null) {
                world.put(bone.id, new double[][] {local[0], local[1]});
            } else {
                double[][] parent = world.get(bone.parent);
                world.put(bone.id, new double[][] {add(parent[0], rotate(parent[1], local[0])), mulQ(parent[1], local[1])});
            }
        }
        return world;
    }

    private static double[] effector(Map<String, double[][]> world) {
        double[][] wrist = world.get("wrist");
        return add(wrist[0], rotate(wrist[1], EFFECTOR_OFFSET));
    }

    /** Pinhole projection by this test's own look-at basis: {x_px, y_px, depth}. */
    private static double[] project(double[] p, double focal) {
        double[] forward = unit(new double[] {TARGET[0] - CAMERA[0], TARGET[1] - CAMERA[1], TARGET[2] - CAMERA[2]});
        double[] right = unit(cross(forward, new double[] {0, 1, 0}));
        double[] up = cross(right, forward);
        double[] rel = {p[0] - CAMERA[0], p[1] - CAMERA[1], p[2] - CAMERA[2]};
        double depth = dot(rel, forward);
        return new double[] {W / 2.0 + focal * dot(rel, right) / depth, H / 2.0 - focal * dot(rel, up) / depth, depth};
    }

    private static double dot(double[] a, double[] b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

    private static double[] unit(double[] a) { return scale(a, 1 / Math.sqrt(dot(a, a))); }

    /** Nearest of the three bone colours and the background/floor shades, by RGB distance of the lit colour. */
    private static int nearest(int r, int g, int b) {
        int best = -1;
        double bestDistance = Double.MAX_VALUE;
        for (Bone bone : BONES) {
            // flat lit colour ranges over ambient..1: compare the chromaticity direction instead of the magnitude
            double cr = (bone.rgb >> 16) & 0xff, cg = (bone.rgb >> 8) & 0xff, cb = bone.rgb & 0xff;
            double nc = Math.sqrt(cr * cr + cg * cg + cb * cb);
            double np = Math.sqrt((double) r * r + g * g + b * b);
            if (np < 40) continue;
            double d = Math.sqrt(Math.pow(cr / nc - r / np, 2) + Math.pow(cg / nc - g / np, 2) + Math.pow(cb / nc - b / np, 2));
            if (d < bestDistance) { bestDistance = d; best = bone.rgb; }
        }
        return bestDistance < 0.12 ? best : -1;
    }

    // ------------------------------------------------------------------------------------------ GLB decoder

    /** Minimal independent GLB 2.0 reader: JSON + BIN chunks, accessors, glTF LINEAR sampling of node TRS. */
    private static final class Glb {
        final JsonNode json;
        final byte[] bin;
        final Map<String, Integer> nodeByName = new LinkedHashMap<>();

        private Glb(JsonNode json, byte[] bin) {
            this.json = json;
            this.bin = bin;
            for (int i = 0; i < json.path("nodes").size(); i++) nodeByName.put(json.path("nodes").path(i).path("name").asString(), i);
        }

        static Glb decode(byte[] bytes) throws Exception {
            ByteBuffer buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
            assertThat(buffer.getInt(0)).isEqualTo(0x46546c67);
            assertThat(buffer.getInt(4)).isEqualTo(2);
            assertThat(buffer.getInt(8)).isEqualTo(bytes.length);
            int jsonLength = buffer.getInt(12);
            assertThat(buffer.getInt(16)).isEqualTo(0x4e4f534a);
            JsonNode json = JSON.readTree(new String(bytes, 20, jsonLength, StandardCharsets.UTF_8));
            int binHeader = 20 + jsonLength;
            int binLength = buffer.getInt(binHeader);
            assertThat(buffer.getInt(binHeader + 4)).isEqualTo(0x004e4942);
            byte[] bin = java.util.Arrays.copyOfRange(bytes, binHeader + 8, binHeader + 8 + binLength);
            return new Glb(json, bin);
        }

        float[] accessor(int index) {
            JsonNode accessor = json.path("accessors").path(index);
            JsonNode view = json.path("bufferViews").path(accessor.path("bufferView").asInt());
            int components = switch (accessor.path("type").asString()) { case "SCALAR" -> 1; case "VEC3" -> 3; case "VEC4" -> 4; default -> throw new IllegalStateException(); };
            assertThat(accessor.path("componentType").asInt()).isEqualTo(5126);
            int count = accessor.path("count").asInt();
            ByteBuffer data = ByteBuffer.wrap(bin).order(ByteOrder.LITTLE_ENDIAN);
            float[] out = new float[count * components];
            int offset = view.path("byteOffset").asInt() + accessor.path("byteOffset").asInt(0);
            for (int i = 0; i < out.length; i++) out[i] = data.getFloat(offset + i * 4);
            return out;
        }

        /** World {position, rotation} of every bone at {@code seconds}, sampled the way a glTF viewer samples it. */
        Map<String, double[][]> world(double seconds) {
            JsonNode animation = json.path("animations").path(0);
            double[][][] local = new double[json.path("nodes").size()][][];
            for (int n = 0; n < local.length; n++) {
                JsonNode node = json.path("nodes").path(n);
                local[n] = new double[][] {
                        {node.path("translation").path(0).asDouble(), node.path("translation").path(1).asDouble(), node.path("translation").path(2).asDouble()},
                        {node.path("rotation").path(0).asDouble(), node.path("rotation").path(1).asDouble(), node.path("rotation").path(2).asDouble(), node.path("rotation").path(3).asDouble()}};
            }
            for (JsonNode channel : animation.path("channels")) {
                JsonNode sampler = animation.path("samplers").path(channel.path("sampler").asInt());
                assertThat(sampler.path("interpolation").asString()).isEqualTo("LINEAR");
                float[] times = accessor(sampler.path("input").asInt());
                float[] values = accessor(sampler.path("output").asInt());
                int node = channel.path("target").path("node").asInt();
                boolean rotation = "rotation".equals(channel.path("target").path("path").asString());
                int width = rotation ? 4 : 3;
                int i = 0;
                double t = seconds;
                double[] result;
                if (t <= times[0]) result = slice(values, 0, width);
                else if (t >= times[times.length - 1]) result = slice(values, times.length - 1, width);
                else {
                    while (times[i + 1] < t) i++;
                    double f = (t - times[i]) / (times[i + 1] - times[i]);
                    double[] a = slice(values, i, width), b = slice(values, i + 1, width);
                    if (rotation) result = slerp(a, b, f);
                    else result = new double[] {a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f};
                }
                local[node][rotation ? 1 : 0] = result;
            }
            Map<String, double[][]> world = new LinkedHashMap<>();
            for (Bone bone : BONES) { // parents precede children in BONES
                int n = nodeByName.get(bone.id);
                double[][] l = local[n];
                if (bone.parent == null) world.put(bone.id, new double[][] {l[0], l[1]});
                else {
                    double[][] p = world.get(bone.parent);
                    world.put(bone.id, new double[][] {add(p[0], rotate(p[1], l[0])), mulQ(p[1], l[1])});
                }
            }
            return world;
        }

        private static double[] slice(float[] values, int index, int width) {
            double[] out = new double[width];
            for (int i = 0; i < width; i++) out[i] = values[index * width + i];
            return out;
        }
    }

    // ------------------------------------------------------------------------------------------ ffprobe / ffmpeg

    private static double psnr(byte[] a, int aOffset, byte[] b, int bOffset, int length) {
        double sum = 0;
        for (int i = 0; i < length; i++) {
            double d = (a[aOffset + i] & 0xff) - (b[bOffset + i] & 0xff);
            sum += d * d;
        }
        double mse = sum / length;
        return mse == 0 ? 99.0 : 10 * Math.log10(255.0 * 255.0 / mse);
    }

    private record Probe(String codec, String profile, String pixFmt, int width, int height, String avgFrameRate,
                         String timeBase, List<Long> pts, int readFrames) { }

    private static Probe probe(Path file) throws Exception {
        String streams = exec(List.of(ffprobe(), "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
                "stream=codec_name,profile,pix_fmt,width,height,avg_frame_rate,time_base,nb_read_frames", "-of", "json", file.toString()));
        JsonNode stream = JSON.readTree(streams).path("streams").path(0);
        String frames = exec(List.of(ffprobe(), "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts", "-of", "csv=p=0",
                file.toString()));
        List<Long> pts = new ArrayList<>();
        for (String line : frames.strip().split("\n")) if (!line.isBlank()) pts.add(Long.parseLong(line.strip().split(",")[0]));
        return new Probe(stream.path("codec_name").asString(), stream.path("profile").asString(), stream.path("pix_fmt").asString(),
                stream.path("width").asInt(), stream.path("height").asInt(), stream.path("avg_frame_rate").asString(),
                stream.path("time_base").asString(), pts, Integer.parseInt(stream.path("nb_read_frames").asString()));
    }

    private static byte[] decodeRgb(Path file) throws Exception {
        Process process = new ProcessBuilder(ffmpeg(), "-nostdin", "-v", "error", "-i", file.toString(), "-f", "rawvideo",
                "-pix_fmt", "rgb24", "-").redirectErrorStream(false).start();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        process.getInputStream().transferTo(out);
        byte[] err = process.getErrorStream().readAllBytes();
        assertThat(process.waitFor(2, TimeUnit.MINUTES)).isTrue();
        assertThat(process.exitValue()).as(new String(err)).isZero();
        return out.toByteArray();
    }

    private static String exec(List<String> command) throws Exception {
        Process process = new ProcessBuilder(command).redirectErrorStream(false).start();
        byte[] out = process.getInputStream().readAllBytes();
        byte[] err = process.getErrorStream().readAllBytes();
        assertThat(process.waitFor(2, TimeUnit.MINUTES)).isTrue();
        assertThat(process.exitValue()).as(new String(err)).isZero();
        return new String(out);
    }

    // ------------------------------------------------------------------------------------------ HTTP and database helpers

    private static JsonNode expect(int port, String tenant, String token, String body, int status, String code) throws Exception {
        HttpResponse<String> response = send(port, tenant, token, "POST", RENDERS, body);
        assertThat(response.statusCode()).as(response.body()).isEqualTo(status);
        JsonNode parsed = JSON.readTree(response.body());
        assertThat(parsed.path("error").path("code").asString()).as(response.body()).isEqualTo(code);
        return parsed;
    }

    private static JsonNode render(int port, String tenant, String token, String body, int status) throws Exception {
        HttpResponse<String> response = send(port, tenant, token, "POST", RENDERS, body);
        assertThat(response.statusCode()).as(response.body()).isEqualTo(status);
        return JSON.readTree(response.body());
    }

    private static CompletableFuture<HttpResponse<String>> sendAsync(int port, String tenant, String token, String body) {
        return CompletableFuture.supplyAsync(() -> {
            try {
                return send(port, tenant, token, "POST", RENDERS, body);
            } catch (Exception failure) {
                throw new IllegalStateException(failure);
            }
        });
    }

    private static String attest(int port, String tenant, String token, String artifactId, String version, String label) throws Exception {
        JsonNode attested = post(port, tenant, token, "/dev/v1/rights/attestations", Map.of("artifactId", artifactId,
                "artifactVersionId", version, "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                "basis", "TEST: floor texture " + label + " is a synthetic image generated inside an automated test; a statement by a "
                        + "synthetic test principal, not a legal determination"), 201);
        return attested.path("attestationId").asString();
    }

    /** Durable artifact rows of the principal whose content type or metadata mentions {@code needle}. */
    private static int rows(String tenant, String principal, String needle) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement("SELECT count(*) FROM media_artifacts WHERE tenant_id=? AND principal_id=? "
                     + "AND (content_type=? OR metadata_json LIKE ?)")) {
            statement.setString(1, tenant);
            statement.setString(2, principal);
            statement.setString(3, needle);
            statement.setString(4, "%" + needle + "%");
            try (var row = statement.executeQuery()) {
                row.next();
                return row.getInt(1);
            }
        }
    }
}
