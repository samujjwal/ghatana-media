package com.ghatana.media.integration;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import tools.jackson.databind.JsonNode;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.InputStreamReader;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import static com.ghatana.media.integration.MediaDevCompositeSupport.Host;
import static com.ghatana.media.integration.MediaDevCompositeSupport.run;
import static com.ghatana.media.integration.MediaDevLiveFixtures.JSON;
import static com.ghatana.media.integration.MediaDevLiveFixtures.sha256;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffmpeg;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffprobe;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-28 outcome journey {@code media.dev.outcome-spatial-interactive-delivery} against REAL processes: a real launcher
 * (PostgreSQL + S3 + durable request ledger + rights authority), real FFmpeg/ffprobe and a real Chromium.
 *
 * <p>360 export: a synthetic 2:1 equirectangular video (markers at known yaw/pitch, a presentation-timestamp gap, frames
 * that only exist from frame 10) is stored, declared equirectangular by the user and exported; ffprobe and an independent
 * box read verify the Spherical Video V2 side data exactly, the frame count, every frame's PTS and the video packets are
 * unchanged, and viewer projections of known directions land on the markers (the expected pixels are computed in this test
 * and the colours are read from an independently decoded source frame). A 16:9 source is refused with a typed 422 and no
 * metadata is ever written for it.
 *
 * <p>Interactive demonstration: a branching graph of stored VP9 scenes with captions is exported as a sandboxed package,
 * unzipped, verified byte for byte and driven in Chromium (see dev-interactive-demo-live-browser.mjs).</p>
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevSpatialInteractiveIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private static final int W = 1024, H = 512, FRAMES = 20;
    /** name, yaw, pitch, colour (r,g,b), first frame on which the marker exists. */
    private record Marker(String name, double yaw, double pitch, int[] rgb, int fromFrame, String ffColor) { }

    private static final List<Marker> MARKERS = List.of(
            new Marker("red", 60, 20, new int[] {255, 0, 0}, 10, "red"),
            new Marker("green", -114, -20, new int[] {0, 255, 0}, 0, "0x00ff00"),
            new Marker("blue", -30, 45, new int[] {0, 0, 255}, 0, "blue"));
    private static final int[] GRAY = {64, 64, 64};

    // ------------------------------------------------------------------ 360 export

    @Test
    void exportsGenuineEquirectangularVideoWithExactSpatialMetadataAndRefusesEverythingElse() throws Exception {
        try (Host host = Host.start(POSTGRES, LOCALSTACK, Map.of())) {
            Path gen = Files.createDirectories(host.work.resolve("gen"));
            Path equirect = gen.resolve("equirect.mp4");
            generateEquirect(equirect);
            byte[] equirectBytes = Files.readAllBytes(equirect);
            Path flat = gen.resolve("flat.mp4");
            run(ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=10:d=2",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", flat.toString());
            byte[] flatBytes = Files.readAllBytes(flat);

            String source = host.upload("equirect.mp4", "video/mp4", equirectBytes);
            String flatSource = host.upload("flat.mp4", "video/mp4", flatBytes);
            byte[] unattestedBytes = java.util.Arrays.copyOf(equirectBytes, equirectBytes.length + 1); // distinct bytes: the store refuses duplicates
            String unattested = host.upload("unattested.mp4", "video/mp4", unattestedBytes);
            String attestation = host.attest(source, equirectBytes);
            host.attest(flatSource, flatBytes);
            String version = "sha256:" + sha256(equirectBytes);
            String flatVersion = "sha256:" + sha256(flatBytes);
            assertThat(schemaRows(host, "media.dev.spatial-export.v1")).isZero();

            // ---- status, the declaration is required, unsupported declarations are typed
            JsonNode status = host.ownerGet("/dev/v1/spatial/status", 200);
            assertThat(status.path("export").path("projections").get(0).asString()).isEqualTo("EQUIRECTANGULAR");
            HttpResponse<String> undeclared = host.owner("POST", "/dev/v1/spatial/exports", Map.of("requestId", "j28-undeclared",
                    "artifactId", source, "artifactVersionId", version));
            assertThat(undeclared.statusCode()).as(undeclared.body()).isEqualTo(422);
            assertThat(error(undeclared)).isEqualTo("SPHERICAL_DECLARATION_REQUIRED");
            assertThat(JSON.readTree(undeclared.body()).path("error").path("details").path("path").asString()).isEqualTo("declaration");
            HttpResponse<String> cubemap = host.owner("POST", "/dev/v1/spatial/exports", exportBody("j28-cube", source, version, "CUBEMAP", "MONO", null));
            assertThat(error(cubemap)).isEqualTo("PROJECTION_NOT_SUPPORTED");
            assertThat(cubemap.statusCode()).isEqualTo(422);
            HttpResponse<String> stereo = host.owner("POST", "/dev/v1/spatial/exports", exportBody("j28-stereo", source, version, "EQUIRECTANGULAR", "TOP_BOTTOM", null));
            assertThat(error(stereo)).isEqualTo("STEREO_MODE_NOT_SUPPORTED");
            HttpResponse<String> badPose = host.owner("POST", "/dev/v1/spatial/exports", exportBody("j28-pose", source, version,
                    "EQUIRECTANGULAR", "MONO", Map.of("yawDegrees", 200)));
            assertThat(badPose.statusCode()).isEqualTo(422);
            assertThat(error(badPose)).isEqualTo("INITIAL_VIEW_OUT_OF_RANGE");

            // ---- a non-spherical source gets NO metadata, only a typed refusal with nothing registered
            HttpResponse<String> notSpherical = host.owner("POST", "/dev/v1/spatial/exports",
                    exportBody("j28-flat", flatSource, flatVersion, "EQUIRECTANGULAR", "MONO", null));
            assertThat(notSpherical.statusCode()).as(notSpherical.body()).isEqualTo(422);
            assertThat(error(notSpherical)).isEqualTo("SOURCE_NOT_EQUIRECTANGULAR");
            JsonNode details = JSON.readTree(notSpherical.body()).path("error").path("details");
            assertThat(details.path("width").asInt()).isEqualTo(640);
            assertThat(details.path("height").asInt()).isEqualTo(360);
            assertThat(details.path("requiredAspect").asString()).isEqualTo("2:1");
            assertThat(schemaRows(host, "media.dev.spatial-export.v1")).as("nothing registered for a refused export").isZero();

            // ---- rights, tenancy
            HttpResponse<String> noRights = host.owner("POST", "/dev/v1/spatial/exports", exportBody("j28-norights", unattested,
                    "sha256:" + sha256(unattestedBytes), "EQUIRECTANGULAR", "MONO", null));
            assertThat(noRights.statusCode()).as(noRights.body()).isEqualTo(403);
            assertThat(host.other("POST", "/dev/v1/spatial/exports", exportBody("j28-other", source, version, "EQUIRECTANGULAR", "MONO", null))
                    .statusCode()).as("another principal of the same tenant").isEqualTo(404);
            HttpResponse<String> foreign = host.foreignTenant("POST", "/dev/v1/spatial/exports",
                    exportBody("j28-foreign", source, version, "EQUIRECTANGULAR", "MONO", null));
            assertThat(foreign.statusCode()).as("another tenant").isEqualTo(404);
            assertThat(error(foreign)).isEqualTo("SOURCE_VERSION_NOT_FOUND");
            assertThat(host.owner("POST", "/dev/v1/spatial/exports", exportBody("j28-ghost", source, "sha256:" + "0".repeat(64),
                    "EQUIRECTANGULAR", "MONO", null)).statusCode()).as("a version that does not exist").isEqualTo(404);
            assertThat(schemaRows(host, "media.dev.spatial-export.v1")).isZero();

            // ---- the real export, with a declared initial view (a fractional pose)
            Map<String, Object> view = Map.of("yawDegrees", 30.5, "pitchDegrees", -15.25, "rollDegrees", 0);
            Map<String, Object> body = exportBody("j28-export", source, version, "EQUIRECTANGULAR", "MONO", view);
            HttpResponse<String> created = host.owner("POST", "/dev/v1/spatial/exports", body);
            assertThat(created.statusCode()).as(created.body()).isEqualTo(201);
            JsonNode export = JSON.readTree(created.body());
            String exportId = export.path("exportId").asString();
            String exportVersion = export.path("artifact").path("artifactVersionId").asString();
            byte[] exportBytes = host.artifactBytes(exportId);
            assertThat(sha256(exportBytes)).isEqualTo(export.path("artifact").path("sha256").asString());
            Path exported = host.work.resolve("export.mp4");
            Files.write(exported, exportBytes);

            // ffprobe: side data present and exact
            JsonNode stream = JSON.readTree(run(ffprobe(), "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_streams",
                    "-of", "json", exported.toString())).path("streams").get(0);
            assertThat(stream.path("width").asInt()).isEqualTo(W);
            assertThat(stream.path("height").asInt()).isEqualTo(H);
            assertThat(stream.path("nb_read_frames").asString()).as("frame count").isEqualTo(Integer.toString(FRAMES));
            JsonNode spherical = null, stereoSide = null;
            for (JsonNode side : stream.path("side_data_list")) {
                if (side.path("side_data_type").asString().equals("Spherical Mapping")) spherical = side;
                if (side.path("side_data_type").asString().equals("Stereo 3D")) stereoSide = side;
            }
            assertThat(spherical).as("Spherical Mapping side data").isNotNull();
            assertThat(spherical.path("projection").asString()).isEqualTo("equirectangular");
            assertThat(spherical.path("yaw").asInt()).as("whole degrees as ffprobe prints them").isEqualTo(30);
            assertThat(spherical.path("pitch").asInt()).isEqualTo(-15);
            assertThat(spherical.path("roll").asInt()).isZero();
            assertThat(stereoSide).as("Stereo 3D side data").isNotNull();
            assertThat(stereoSide.path("type").asString()).isEqualTo("2D");
            // an independent walk of the raw boxes: exact 16.16 pose, full-sphere bounds, mono
            int prhd = indexOf(exportBytes, "prhd");
            ByteBuffer pose = ByteBuffer.wrap(exportBytes, prhd + 8, 12);
            assertThat(pose.getInt()).isEqualTo((int) Math.round(30.5 * 65536));
            assertThat(pose.getInt()).isEqualTo((int) Math.round(-15.25 * 65536));
            assertThat(pose.getInt()).isZero();
            int equi = indexOf(exportBytes, "equi");
            for (int i = 0; i < 16; i++) assertThat(exportBytes[equi + 8 + i]).as("projection bounds byte " + i).isZero();
            assertThat(exportBytes[indexOf(exportBytes, "st3d") + 8]).as("stereo_mode mono").isZero();

            // frame count and presentation timestamps unchanged, packets bit-identical, decodes cleanly
            List<String> sourcePts = framePts(equirect);
            List<String> exportPts = framePts(exported);
            assertThat(sourcePts).hasSize(FRAMES);
            assertThat(exportPts).as("every frame PTS equals the source's").isEqualTo(sourcePts);
            assertThat(Double.parseDouble(sourcePts.get(15)) - Double.parseDouble(sourcePts.get(14)))
                    .as("the source really has a timestamp gap (a normal step is 0.1 s)").isGreaterThan(0.35);
            assertThat(packetsMd5(exported)).isEqualTo(packetsMd5(equirect));
            run(ffmpeg(), "-v", "error", "-xerror", "-i", exported.toString(), "-f", "null", "-");
            // lineage
            JsonNode lineage = export.path("lineage");
            assertThat(lineage.path("source").path("artifactId").asString()).isEqualTo(source);
            assertThat(lineage.path("rightsDecision").path("verdict").asString()).isEqualTo("ADMITTED");
            assertThat(lineage.path("declaration").path("declaredBy").asString()).isEqualTo(host.owner);
            assertThat(lineage.path("verification").path("sideData").path("yawFixed1616").asInt()).isEqualTo((int) Math.round(30.5 * 65536));
            assertThat(lineage.path("verification").path("timeline").path("ptsEqualInstants").asBoolean()).isTrue();
            assertThat(lineage.path("claims").path("spatialMetadata").asString()).isEqualTo("USER_DECLARED_EQUIRECTANGULAR_GEOMETRY_CHECKED");

            // ---- viewer parity: the expected pixel is computed here, the colour is read from an independently decoded frame
            BufferedImage sourceFrame15 = decodedFrame(equirect, 15, host.work.resolve("src15.png"));
            BufferedImage sourceFrame3 = decodedFrame(equirect, 3, host.work.resolve("src3.png"));
            for (Marker marker : MARKERS) {
                int px = (int) Math.floor((marker.yaw() / 360.0 + 0.5) * W);
                int py = (int) Math.floor((0.5 - marker.pitch() / 180.0) * H);
                assertThat(near(sourceFrame15.getRGB(px, py), marker.rgb(), 40)).as(marker.name() + " marker in the decoded source frame").isTrue();
                JsonNode shown = viewport(host, exportId, exportVersion, 15, marker.yaw(), marker.pitch(), 40, 200, 200);
                assertThat(shown.path("sourcePixel").path("x").asInt()).as(marker.name() + " expected x").isEqualTo(px);
                assertThat(shown.path("sourcePixel").path("y").asInt()).as(marker.name() + " expected y").isEqualTo(py);
                BufferedImage png = ImageIO.read(new ByteArrayInputStream(Base64.getDecoder().decode(shown.path("pngBase64").asString())));
                assertThat(near(png.getRGB(100, 100), marker.rgb(), 40)).as(marker.name() + " at the viewport centre: " + Integer.toHexString(png.getRGB(100, 100))).isTrue();
                assertThat(shown.path("viewportCentre").path("r").asInt()).isEqualTo((png.getRGB(100, 100) >> 16) & 255);
                // 40 degrees away the marker is not in the middle of the view
                JsonNode away = viewport(host, exportId, exportVersion, 15, wrap(marker.yaw() + 40), marker.pitch(), 40, 200, 200);
                BufferedImage awayPng = ImageIO.read(new ByteArrayInputStream(Base64.getDecoder().decode(away.path("pngBase64").asString())));
                assertThat(near(awayPng.getRGB(100, 100), marker.rgb(), 40)).as(marker.name() + " is NOT at the centre 40 degrees away").isFalse();
                assertThat(shown.path("fileMetadata").path("projection").asString()).isEqualTo("equirectangular");
                assertThat(shown.path("fileMetadata").path("yawDegrees").asDouble()).isEqualTo(30.5);
            }
            // timestamps: the red marker exists only from frame 10
            Marker red = MARKERS.get(0);
            int redX = (int) Math.floor((red.yaw() / 360.0 + 0.5) * W), redY = (int) Math.floor((0.5 - red.pitch() / 180.0) * H);
            assertThat(near(sourceFrame3.getRGB(redX, redY), GRAY, 12)).as("no red marker on source frame 3").isTrue();
            JsonNode early = viewport(host, exportId, exportVersion, 3, red.yaw(), red.pitch(), 40, 200, 200);
            BufferedImage earlyPng = ImageIO.read(new ByteArrayInputStream(Base64.getDecoder().decode(early.path("pngBase64").asString())));
            assertThat(near(earlyPng.getRGB(100, 100), GRAY, 12)).as("frame 3 viewport shows the empty sky").isTrue();
            assertThat(early.path("frame").path("ptsMicros").asLong()).isEqualTo(Math.round(Double.parseDouble(sourcePts.get(3)) * 1_000_000));
            JsonNode gap = viewport(host, exportId, exportVersion, 16, red.yaw(), red.pitch(), 40, 64, 64);
            assertThat(gap.path("frame").path("ptsMicros").asLong()).as("the PTS after the gap").isEqualTo(Math.round(Double.parseDouble(sourcePts.get(16)) * 1_000_000));
            // viewer refusals: out of range, not an export, bad parameters
            assertThat(viewportResponse(host, exportId, exportVersion, 99, 0, 0, 90, 64, 64).statusCode()).isEqualTo(422);
            assertThat(error(viewportResponse(host, exportId, exportVersion, 99, 0, 0, 90, 64, 64))).isEqualTo("FRAME_OUT_OF_RANGE");
            assertThat(error(viewportResponse(host, exportId, exportVersion, 0, 181, 0, 90, 64, 64))).isEqualTo("VIEWPORT_PARAMETER_OUT_OF_RANGE");
            HttpResponse<String> rawSource = viewportResponse(host, source, version, 0, 0, 0, 90, 64, 64);
            assertThat(rawSource.statusCode()).isEqualTo(422);
            assertThat(error(rawSource)).as("a viewer shows only exported files, it never guesses a raw source is 360").isEqualTo("NOT_A_SPATIAL_EXPORT");
            assertThat(host.other("POST", "/dev/v1/spatial/viewports", viewportBody(exportId, exportVersion, 0, 0, 0, 90, 64, 64))
                    .statusCode()).isEqualTo(404);

            // an export is not re-exported: its metadata is neither overwritten nor duplicated
            host.attest(exportId, exportBytes);
            HttpResponse<String> again = host.owner("POST", "/dev/v1/spatial/exports", exportBody("j28-again", exportId, exportVersion,
                    "EQUIRECTANGULAR", "MONO", null));
            assertThat(again.statusCode()).as(again.body()).isEqualTo(422);
            assertThat(error(again)).isEqualTo("SOURCE_ALREADY_HAS_SPATIAL_METADATA");

            // ---- ledger: replay is 200 with the same artifact, another declaration under the same id is 409
            assertThat(schemaRows(host, "media.dev.spatial-export.v1")).isEqualTo(1);
            HttpResponse<String> replay = host.owner("POST", "/dev/v1/spatial/exports", body);
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
            assertThat(JSON.readTree(replay.body()).path("exportId").asString()).isEqualTo(exportId);
            assertThat(JSON.readTree(replay.body()).path("lineage").path("verification").path("sideData").path("yawFixed1616").asInt())
                    .isEqualTo((int) Math.round(30.5 * 65536));
            HttpResponse<String> conflict = host.owner("POST", "/dev/v1/spatial/exports", exportBody("j28-export", source, version,
                    "EQUIRECTANGULAR", "MONO", Map.of("yawDegrees", 1)));
            assertThat(conflict.statusCode()).as(conflict.body()).isEqualTo(409);
            assertThat(error(conflict)).isEqualTo("VIDEO_REQUEST_ID_REUSED");
            assertThat(schemaRows(host, "media.dev.spatial-export.v1")).as("replay registered nothing").isEqualTo(1);

            // ---- restart: the readback survives, bytes unchanged
            host.restart();
            JsonNode reopened = host.ownerGet("/dev/v1/spatial/exports/" + exportId, 200);
            assertThat(reopened.path("artifact").path("sha256").asString()).isEqualTo(sha256(exportBytes));
            assertThat(reopened.path("lineage").path("declaration").path("projection").asString()).isEqualTo("EQUIRECTANGULAR");
            assertThat(sha256(host.artifactBytes(exportId))).isEqualTo(sha256(exportBytes));
            assertThat(host.owner("POST", "/dev/v1/spatial/exports", body).statusCode()).isEqualTo(200);
            assertThat(host.other("GET", "/dev/v1/spatial/exports/" + exportId, null).statusCode()).isEqualTo(404);
            assertThat(host.foreignTenant("GET", "/dev/v1/spatial/exports/" + exportId, null).statusCode()).isEqualTo(404);

            // ---- revocation: the source loses its rights, the replay, the readback and the viewer all refuse
            host.ownerPost("/dev/v1/rights/attestations/" + attestation + "/revoke", Map.of("reason", "TEST: revoked"), 200);
            HttpResponse<String> revokedReplay = host.owner("POST", "/dev/v1/spatial/exports", body);
            assertThat(revokedReplay.statusCode()).as(revokedReplay.body()).isEqualTo(403);
            assertThat(revokedReplay.body()).contains("RIGHTS_REVOKED");
            assertThat(host.owner("GET", "/dev/v1/spatial/exports/" + exportId, null).statusCode()).isEqualTo(403);
            assertThat(viewportResponse(host, exportId, exportVersion, 0, 0, 0, 90, 64, 64).statusCode()).isEqualTo(403);
            host.passed = true;
        }
    }

    // ------------------------------------------------------------------ interactive demonstration package

    @Test
    void exportsASandboxedBranchingDemoAndAChromiumVerifiesItsBehaviourAndRefusals() throws Exception {
        try (Host host = Host.start(POSTGRES, LOCALSTACK, Map.of())) {
            Path gen = Files.createDirectories(host.work.resolve("gen"));
            Map<String, byte[]> scenes = new LinkedHashMap<>();
            for (String[] scene : new String[][] {{"intro", "red"}, {"left", "green"}, {"right", "blue"}, {"end", "yellow"}, {"spare", "white"}}) {
                Path webm = gen.resolve(scene[0] + ".webm");
                run(ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                        "color=c=" + scene[1] + ":s=320x180:r=10:d=2", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "45",
                        "-pix_fmt", "yuv420p", webm.toString());
                scenes.put(scene[0], Files.readAllBytes(webm));
            }
            byte[] vtt = "WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nWelcome to the demo\n".getBytes(StandardCharsets.UTF_8);
            Map<String, String> ids = new LinkedHashMap<>();
            for (var entry : scenes.entrySet()) {
                String id = host.upload(entry.getKey() + ".webm", "video/webm", entry.getValue());
                ids.put(entry.getKey(), id);
                if (!entry.getKey().equals("spare")) host.attest(id, entry.getValue());
            }
            String captions = host.upload("intro.vtt", "text/vtt", vtt);
            String captionAttestation = host.attest(captions, vtt);
            byte[] junkBytes = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nnot a video\n".getBytes(StandardCharsets.UTF_8);
            String junkVideo = host.upload("not-a-video.vtt", "text/vtt", junkBytes);
            host.attest(junkVideo, junkBytes);
            // a 2:1 H.264 export is a runtime OUTPUT: its scene is LIVE
            Path equirect = gen.resolve("equirect.mp4");
            generateEquirect(equirect);
            byte[] equirectBytes = Files.readAllBytes(equirect);
            String equirectId = host.upload("equirect.mp4", "video/mp4", equirectBytes);
            host.attest(equirectId, equirectBytes);
            JsonNode export = host.ownerPost("/dev/v1/spatial/exports", exportBody("j28-live-source", equirectId,
                    "sha256:" + sha256(equirectBytes), "EQUIRECTANGULAR", "MONO", null), 201);
            String liveId = export.path("exportId").asString();
            host.attest(liveId, host.artifactBytes(liveId));
            String liveVersion = export.path("artifact").path("artifactVersionId").asString();

            String capVersion = "sha256:" + sha256(vtt);
            Map<String, Object> nodeIntro = node("intro", "Welcome", ids.get("intro"), scenes.get("intro"), captions, capVersion,
                    choice("left", "Take the left path", "left"), choice("right", "Take the right path", "right"));
            Map<String, Object> nodeLeft = node("left", "Left path", ids.get("left"), scenes.get("left"), null, null,
                    choice("back", "Return to the start", "intro"), choice("done", "Finish", "end"));
            Map<String, Object> nodeRight = node("right", "Right path", ids.get("right"), scenes.get("right"), null, null, choice("done", "Finish", "end"));
            Map<String, Object> nodeEnd = node("end", "The end", ids.get("end"), scenes.get("end"), null, null);
            Map<String, Object> curated = Map.of("kind", "CURATED", "curationNote", "Assembled by the test author for the browser journey");
            Map<String, Object> request = demo("j28-demo", "Branching demo", "intro", curated, nodeIntro, nodeLeft, nodeRight, nodeEnd);

            // ---- status; invalid graphs are 422 with a path, before anything else is looked up
            assertThat(host.ownerGet("/dev/v1/interactive-demos/status", 200).path("graph").path("maxNodes").asInt()).isEqualTo(32);
            assertGraph(host, "j28-bad-dangling", "intro", curated, "EDGE_DANGLING", "nodes[0].choices[1].to",
                    node("intro", "Welcome", ids.get("intro"), scenes.get("intro"), null, null, choice("a", "Go", "end"), choice("b", "Nowhere", "nowhere")),
                    nodeEnd);
            assertGraph(host, "j28-bad-unreachable", "intro", curated, "NODE_UNREACHABLE", "nodes[1]",
                    node("intro", "Welcome", ids.get("intro"), scenes.get("intro"), null, null), nodeEnd);
            assertGraph(host, "j28-bad-cycle", "intro", curated, "GRAPH_CYCLE_WITHOUT_EXIT", "nodes[0]",
                    node("intro", "Welcome", ids.get("intro"), scenes.get("intro"), null, null, choice("go", "Go on", "left")),
                    node("left", "Left path", ids.get("left"), scenes.get("left"), null, null, choice("back", "Go back", "intro")));
            assertGraph(host, "j28-bad-blank", "intro", curated, "LABEL_BLANK", "nodes[0].label",
                    node("intro", "   ", ids.get("intro"), scenes.get("intro"), null, null));
            assertGraph(host, "j28-bad-blank-choice", "intro", curated, "LABEL_BLANK", "nodes[0].choices[0].label",
                    node("intro", "Welcome", ids.get("intro"), scenes.get("intro"), null, null, choice("a", " ", "end")), nodeEnd);
            assertGraph(host, "j28-bad-dup", "intro", curated, "NODE_ID_DUPLICATE", "nodes[1].id",
                    node("intro", "Welcome", ids.get("intro"), scenes.get("intro"), null, null), node("intro", "Again", ids.get("intro"), scenes.get("intro"), null, null));
            assertGraph(host, "j28-bad-start", "nowhere", curated, "START_NODE_UNKNOWN", "startNodeId", nodeEnd);
            assertGraph(host, "j28-bad-note", "end", Map.of("kind", "CURATED"), "CURATION_NOTE_REQUIRED", "sourceTruth.curationNote", nodeEnd);
            // truth: uploaded scenes cannot claim to be live
            HttpResponse<String> falseLive = host.owner("POST", "/dev/v1/interactive-demos",
                    demo("j28-false-live", "Not live", "intro", Map.of("kind", "LIVE"), nodeIntro, nodeLeft, nodeRight, nodeEnd));
            assertThat(falseLive.statusCode()).as(falseLive.body()).isEqualTo(422);
            assertThat(error(falseLive)).isEqualTo("SOURCE_TRUTH_NOT_LIVE");
            assertThat(JSON.readTree(falseLive.body()).path("error").path("details").path("notLive").size()).isEqualTo(4);
            // a non-video scene source
            Map<String, Object> junk = node("end", "The end", junkVideo, junkBytes, null, null);
            HttpResponse<String> junkResponse = host.owner("POST", "/dev/v1/interactive-demos", demo("j28-junk", "Junk", "end", curated, junk));
            assertThat(junkResponse.statusCode()).as(junkResponse.body()).isEqualTo(422);
            assertThat(error(junkResponse)).isEqualTo("SOURCE_FORMAT_NOT_SUPPORTED");
            assertThat(schemaRows(host, "media.dev.interactive-demo.v1")).isZero();

            // ---- rights, tenancy: the path names the offending source
            Map<String, Object> spare = node("end", "The end", ids.get("spare"), scenes.get("spare"), null, null);
            HttpResponse<String> unattested = host.owner("POST", "/dev/v1/interactive-demos", demo("j28-norights", "No rights", "intro", curated,
                    node("intro", "Welcome", ids.get("intro"), scenes.get("intro"), null, null, choice("a", "Go", "end")),
                    spare));
            assertThat(unattested.statusCode()).as(unattested.body()).isEqualTo(403);
            assertThat(JSON.readTree(unattested.body()).path("error").path("details").path("path").asString()).isEqualTo("nodes[1].video");
            assertThat(JSON.readTree(unattested.body()).path("error").path("details").path("artifactId").asString()).isEqualTo(ids.get("spare"));
            HttpResponse<String> other = host.other("POST", "/dev/v1/interactive-demos", request);
            assertThat(other.statusCode()).as("another principal").isEqualTo(404);
            assertThat(JSON.readTree(other.body()).path("error").path("details").path("path").asString()).isEqualTo("nodes[0].video");
            HttpResponse<String> foreign = host.foreignTenant("POST", "/dev/v1/interactive-demos", request);
            assertThat(foreign.statusCode()).as("another tenant").isEqualTo(404);
            assertThat(error(foreign)).isEqualTo("SOURCE_VERSION_NOT_FOUND");
            assertThat(schemaRows(host, "media.dev.interactive-demo.v1")).isZero();

            // ---- the package
            HttpResponse<String> created = host.owner("POST", "/dev/v1/interactive-demos", request);
            assertThat(created.statusCode()).as(created.body()).isEqualTo(201);
            JsonNode demo = JSON.readTree(created.body());
            String demoId = demo.path("demoId").asString();
            byte[] bundle = host.artifactBytes(demoId);
            assertThat(sha256(bundle)).isEqualTo(demo.path("artifact").path("sha256").asString());
            assertThat(demo.path("artifact").path("contentType").asString()).isEqualTo("application/json");
            assertThat(JSON.readTree(bundle).path("schema").asString()).isEqualTo("media.dev.interactive-demo-package.v1");
            assertThat(demo.path("packagePath").asString()).isEqualTo("/dev/v1/interactive-demos/" + demoId + "/package.zip");
            byte[] zip = download(host, demo.path("packagePath").asString(), 200);
            assertThat(download(host, demo.path("packagePath").asString(), 200)).as("the ZIP is deterministic").isEqualTo(zip);
            assertThat(sha256(zip)).isEqualTo(demo.path("lineage").path("package").path("zipSha256").asString());
            assertThat(demo.path("lineage").path("package").path("zipSizeBytes").asInt()).isEqualTo(zip.length);
            Path good = host.work.resolve("pkg-good");
            Map<String, byte[]> entries = unzip(zip, good);
            String introSha = sha256(scenes.get("intro")), rightSha = sha256(scenes.get("right")), leftSha = sha256(scenes.get("left"));
            assertThat(new TreeSet<>(entries.keySet())).containsExactlyInAnyOrder("index.html", "manifest.json", "player.css", "player.js",
                    "assets/" + introSha + ".webm", "assets/" + leftSha + ".webm", "assets/" + rightSha + ".webm",
                    "assets/" + sha256(scenes.get("end")) + ".webm", "captions/" + sha256(vtt) + ".vtt");
            for (var entry : entries.entrySet()) {
                if (entry.getKey().startsWith("assets/") || entry.getKey().startsWith("captions/")) {
                    String name = entry.getKey().substring(entry.getKey().indexOf('/') + 1);
                    assertThat(name).as("content-addressed name").startsWith(sha256(entry.getValue()));
                }
            }
            assertThat(entries.get("assets/" + introSha + ".webm")).isEqualTo(scenes.get("intro"));
            JsonNode manifest = JSON.readTree(entries.get("manifest.json"));
            assertThat(manifest.path("schema").asString()).isEqualTo("media.dev.interactive-demo.v1");
            assertThat(manifest.path("sourceTruth").path("kind").asString()).isEqualTo("CURATED");
            assertThat(manifest.path("nodes").size()).isEqualTo(4);
            assertThat(manifest.path("nodes").get(0).path("origin").asString()).isEqualTo("CURATED");
            assertThat(manifest.path("nodes").get(0).path("durationMs").asLong()).isBetween(1990L, 2100L);
            assertThat(manifest.path("nodes").get(0).path("captions").path("forVideoSha256").asString()).isEqualTo(introSha);
            String index = new String(entries.get("index.html"), StandardCharsets.UTF_8);
            assertThat(index).contains("http-equiv=\"Content-Security-Policy\"").contains("default-src 'none'")
                    .contains("connect-src 'self'").contains("media-src blob:").contains("script-src 'self'")
                    .doesNotContain("unsafe-inline").doesNotContain("unsafe-eval");
            for (String name : List.of("index.html", "player.js", "player.css")) {
                String text = new String(entries.get(name), StandardCharsets.UTF_8);
                assertThat(text).as(name + " has no off-package URL").doesNotContainPattern("https?://");
                if (name.equals("player.js")) {
                    assertThat(text).doesNotContainPattern("XMLHttpRequest|WebSocket|EventSource|importScripts|eval\\(|new Function|document\\.write|innerHTML|sendBeacon\\(");
                }
            }
            JsonNode lineage = demo.path("lineage");
            assertThat(lineage.path("sources").size()).isEqualTo(5);
            assertThat(lineage.path("demo").path("choiceCount").asInt()).isEqualTo(5);
            assertThat(lineage.path("package").path("files").path("player.js").asString()).isEqualTo(sha256(entries.get("player.js")));

            // ---- ledger
            HttpResponse<String> replay = host.owner("POST", "/dev/v1/interactive-demos", request);
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
            assertThat(JSON.readTree(replay.body()).path("demoId").asString()).isEqualTo(demoId);
            HttpResponse<String> reused = host.owner("POST", "/dev/v1/interactive-demos",
                    demo("j28-demo", "Branching demo", "end", curated, nodeEnd));
            assertThat(reused.statusCode()).as(reused.body()).isEqualTo(409);
            assertThat(schemaRows(host, "media.dev.interactive-demo.v1")).isEqualTo(1);
            host.restart();
            assertThat(host.ownerGet("/dev/v1/interactive-demos/" + demoId, 200).path("lineage").path("demo").path("title").asString())
                    .isEqualTo("Branching demo");
            assertThat(host.other("GET", "/dev/v1/interactive-demos/" + demoId, null).statusCode()).isEqualTo(404);
            assertThat(sha256(host.artifactBytes(demoId))).isEqualTo(sha256(bundle));
            assertThat(download(host, "/dev/v1/interactive-demos/" + demoId + "/package.zip", 200)).isEqualTo(zip);
            assertThat(host.other("GET", "/dev/v1/interactive-demos/" + demoId + "/package.zip", null).statusCode()).isEqualTo(404);
            assertThat(host.foreignTenant("GET", "/dev/v1/interactive-demos/" + demoId + "/package.zip", null).statusCode()).isEqualTo(404);

            // ---- LIVE: a scene that is a runtime output makes a live demonstration possible; a mixed one cannot claim it
            Map<String, Object> liveNode = Map.of("id", "only", "label", "Exported 360 video",
                    "video", Map.of("artifactId", liveId, "artifactVersionId", liveVersion));
            JsonNode liveDemo = host.ownerPost("/dev/v1/interactive-demos", Map.of("requestId", "j28-live", "title", "Live output",
                    "startNodeId", "only", "sourceTruth", Map.of("kind", "LIVE"), "nodes", List.of(liveNode)), 201);
            Path livePkg = host.work.resolve("pkg-live");
            Map<String, byte[]> liveEntries = unzip(download(host, liveDemo.path("packagePath").asString(), 200), livePkg);
            JsonNode liveManifest = JSON.readTree(liveEntries.get("manifest.json"));
            assertThat(liveManifest.path("sourceTruth").path("kind").asString()).isEqualTo("LIVE");
            assertThat(liveManifest.path("nodes").get(0).path("origin").asString()).isEqualTo("LIVE");
            assertThat(liveManifest.path("nodes").get(0).path("video").path("artifactId").asString()).isEqualTo(liveId);
            HttpResponse<String> mixed = host.owner("POST", "/dev/v1/interactive-demos", Map.of("requestId", "j28-mixed", "title", "Mixed",
                    "startNodeId", "only", "sourceTruth", Map.of("kind", "LIVE"), "nodes", List.of(Map.of("id", "only", "label", "Mixed",
                            "video", Map.of("artifactId", ids.get("intro"), "artifactVersionId", "sha256:" + introSha),
                            "choices", List.of(Map.of("id", "go", "label", "Next", "to", "second"))),
                            Map.of("id", "second", "label", "Second", "video", Map.of("artifactId", liveId, "artifactVersionId", liveVersion)))));
            assertThat(mixed.statusCode()).as(mixed.body()).isEqualTo(422);
            assertThat(error(mixed)).isEqualTo("SOURCE_TRUTH_NOT_LIVE");
            assertThat(JSON.readTree(mixed.body()).path("error").path("details").path("notLive").get(0).asString()).isEqualTo("nodes[0].video");

            // ---- the tampered variants Chromium must refuse
            Path staleAsset = copyTree(good, host.work.resolve("pkg-stale-asset"));
            Path rightAsset = staleAsset.resolve("assets/" + rightSha + ".webm");
            byte[] tampered = Files.readAllBytes(rightAsset);
            tampered[tampered.length - 5] ^= (byte) 0xff;
            Files.write(rightAsset, tampered);
            Path staleCaption = copyTree(good, host.work.resolve("pkg-stale-caption"));
            replaceInFiles(staleCaption, List.of("index.html", "manifest.json"), "\"forVideoSha256\":\"" + introSha + "\"", "\"forVideoSha256\":\"" + rightSha + "\"");
            Path offPackage = copyTree(good, host.work.resolve("pkg-off-package"));
            replaceInFiles(offPackage, List.of("index.html", "manifest.json"), "\"path\":\"assets/" + leftSha + ".webm\"",
                    "\"path\":\"ATTACKER_ORIGIN/assets/" + leftSha + ".webm\"");
            Path liveClaimTampered = copyTree(good, host.work.resolve("pkg-live-claim-tampered"));
            replaceInFiles(liveClaimTampered, List.of("index.html", "manifest.json"), "\"kind\":\"CURATED\"", "\"kind\":\"LIVE\"");

            // ---- real Chromium
            Map<String, Object> config = new LinkedHashMap<>();
            Map<String, String> packages = new LinkedHashMap<>();
            packages.put("good", good.toString());
            packages.put("staleAsset", staleAsset.toString());
            packages.put("staleCaption", staleCaption.toString());
            packages.put("offPackage", offPackage.toString());
            packages.put("live", livePkg.toString());
            packages.put("liveClaimTampered", liveClaimTampered.toString());
            config.put("packages", packages);
            config.put("labels", Map.of("intro", "Welcome", "left", "Left path", "right", "Right path", "end", "The end"));
            config.put("choices", Map.of("introLeft", "Take the left path", "introRight", "Take the right path"));
            Path configFile = host.work.resolve("browser-config.json");
            Files.writeString(configFile, JSON.writeValueAsString(config));
            JsonNode browser = runBrowser(configFile, host.work.resolve("browser.log"));
            assertThat(browser.path("ok").asBoolean()).isTrue();
            System.out.println("J28_BROWSER_EVENT " + browser);

            // ---- revocation after the fact: the readback refuses and so does a replay
            host.ownerPost("/dev/v1/rights/attestations/" + captionAttestation + "/revoke", Map.of("reason", "TEST: revoked"), 200);
            HttpResponse<String> revoked = host.owner("GET", "/dev/v1/interactive-demos/" + demoId, null);
            assertThat(revoked.statusCode()).as(revoked.body()).isEqualTo(403);
            assertThat(revoked.body()).contains("RIGHTS_REVOKED").contains("nodes[0].captions");
            assertThat(host.owner("GET", "/dev/v1/interactive-demos/" + demoId + "/package.zip", null).statusCode()).isEqualTo(403);
            HttpResponse<String> revokedReplay = host.owner("POST", "/dev/v1/interactive-demos", request);
            assertThat(revokedReplay.statusCode()).as(revokedReplay.body()).isEqualTo(403);
            assertThat(JSON.readTree(revokedReplay.body()).path("error").path("details").path("path").asString()).isEqualTo("nodes[0].captions");
            host.passed = true;
        }
    }

    // ------------------------------------------------------------------ request builders

    private static Map<String, Object> exportBody(String requestId, String artifactId, String version, String projection,
                                                   String stereoMode, Map<String, Object> initialView) {
        Map<String, Object> declaration = new LinkedHashMap<>();
        declaration.put("projection", projection);
        declaration.put("stereoMode", stereoMode);
        if (initialView != null) declaration.put("initialView", initialView);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("artifactId", artifactId);
        body.put("artifactVersionId", version);
        body.put("declaration", declaration);
        return body;
    }

    private static Map<String, Object> viewportBody(String artifactId, String version, int frame, double yaw, double pitch,
                                                    double fov, int width, int height) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("artifactId", artifactId);
        body.put("artifactVersionId", version);
        body.put("frameIndex", frame);
        body.put("yawDegrees", yaw);
        body.put("pitchDegrees", pitch);
        body.put("fovDegrees", fov);
        body.put("width", width);
        body.put("height", height);
        return body;
    }

    private static HttpResponse<String> viewportResponse(Host host, String id, String version, int frame, double yaw, double pitch,
                                                          double fov, int width, int height) throws Exception {
        return host.owner("POST", "/dev/v1/spatial/viewports", viewportBody(id, version, frame, yaw, pitch, fov, width, height));
    }

    private static JsonNode viewport(Host host, String id, String version, int frame, double yaw, double pitch, double fov,
                                     int width, int height) throws Exception {
        HttpResponse<String> response = viewportResponse(host, id, version, frame, yaw, pitch, fov, width, height);
        assertThat(response.statusCode()).as(response.body().length() > 300 ? response.body().substring(0, 300) : response.body()).isEqualTo(200);
        return JSON.readTree(response.body());
    }

    private static Map<String, Object> choice(String id, String label, String to) {
        return Map.of("id", id, "label", label, "to", to);
    }

    @SafeVarargs
    private static Map<String, Object> node(String id, String label, String videoId, byte[] videoBytes, String captionId,
                                            String captionVersion, Map<String, Object>... choices) {
        Map<String, Object> node = new LinkedHashMap<>();
        node.put("id", id);
        node.put("label", label);
        node.put("video", Map.of("artifactId", videoId, "artifactVersionId", "sha256:" + sha256Unchecked(videoBytes)));
        if (captionId != null) node.put("captions", Map.of("artifactId", captionId, "artifactVersionId", captionVersion, "language", "en"));
        node.put("choices", List.of(choices));
        return node;
    }

    @SafeVarargs
    private static Map<String, Object> demo(String requestId, String title, String start, Map<String, Object> truth,
                                            Map<String, Object>... nodes) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("title", title);
        body.put("startNodeId", start);
        body.put("sourceTruth", truth);
        body.put("nodes", List.of(nodes));
        return body;
    }

    @SafeVarargs
    private static void assertGraph(Host host, String requestId, String start, Map<String, Object> truth, String code, String path,
                                    Map<String, Object>... nodes) throws Exception {
        HttpResponse<String> response = host.owner("POST", "/dev/v1/interactive-demos", demo(requestId, "Bad graph", start, truth, nodes));
        assertThat(response.statusCode()).as(requestId + " " + response.body()).isEqualTo(422);
        assertThat(error(response)).as(requestId).isEqualTo(code);
        assertThat(JSON.readTree(response.body()).path("error").path("details").path("path").asString()).as(requestId).isEqualTo(path);
    }

    private static String error(HttpResponse<String> response) throws Exception {
        JsonNode body = JSON.readTree(response.body());
        return body.path("error").path("code").asString("");
    }

    private static String sha256Unchecked(byte[] bytes) {
        try { return sha256(bytes); } catch (Exception failure) { throw new IllegalStateException(failure); }
    }

    // ------------------------------------------------------------------ media helpers

    /** 1024x512, 10 fps, 20 frames: markers at known yaw/pitch, the red one only from frame 10, a 0.37 s PTS gap from frame 15. */
    private static void generateEquirect(Path out) throws Exception {
        StringBuilder graph = new StringBuilder("color=c=0x404040:s=" + W + "x" + H + ":r=10:d=2,format=yuv420p");
        for (Marker marker : MARKERS) {
            int x = (int) Math.round((marker.yaw() / 360.0 + 0.5) * W) - 13;
            int y = (int) Math.round((0.5 - marker.pitch() / 180.0) * H) - 13;
            graph.append(",drawbox=x=").append(x).append(":y=").append(y).append(":w=26:h=26:color=").append(marker.ffColor())
                    .append(":t=fill:enable='gte(n\\,").append(marker.fromFrame()).append(")'");
        }
        graph.append(",setpts='if(gte(N\\,15)\\,PTS+0.37/TB\\,PTS)'");
        run(ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", graph.toString(), "-c:v", "libx264",
                "-pix_fmt", "yuv420p", "-crf", "10", "-bf", "2", "-fps_mode", "passthrough", "-video_track_timescale", "10000", out.toString());
    }

    private static List<String> framePts(Path file) throws Exception {
        return List.of(run(ffprobe(), "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0",
                file.toString()).replace(",", "").trim().split("\\R"));
    }

    private static String packetsMd5(Path file) throws Exception {
        return run(ffmpeg(), "-v", "error", "-i", file.toString(), "-map", "0:v:0", "-c", "copy", "-f", "md5", "-").trim();
    }

    private static BufferedImage decodedFrame(Path video, int index, Path png) throws Exception {
        run(ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-i", video.toString(), "-vf", "select=eq(n\\," + index + ")",
                "-frames:v", "1", "-fps_mode", "passthrough", png.toString());
        return ImageIO.read(png.toFile());
    }

    private static boolean near(int argb, int[] rgb, int tolerance) {
        return Math.abs(((argb >> 16) & 255) - rgb[0]) <= tolerance && Math.abs(((argb >> 8) & 255) - rgb[1]) <= tolerance
                && Math.abs((argb & 255) - rgb[2]) <= tolerance;
    }

    private static double wrap(double yaw) {
        double wrapped = yaw;
        while (wrapped > 180) wrapped -= 360;
        while (wrapped < -180) wrapped += 360;
        return wrapped;
    }

    private static int indexOf(byte[] bytes, String type) {
        byte[] needle = type.getBytes(StandardCharsets.US_ASCII);
        outer:
        for (int i = 0; i + 4 <= bytes.length; i++) {
            for (int j = 0; j < 4; j++) if (bytes[i + j] != needle[j]) continue outer;
            return i;
        }
        throw new AssertionError("no '" + type + "' box");
    }

    // ------------------------------------------------------------------ package helpers

    private static Map<String, byte[]> unzip(byte[] zip, Path target) throws Exception {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        try (ZipInputStream in = new ZipInputStream(new ByteArrayInputStream(zip))) {
            for (ZipEntry entry = in.getNextEntry(); entry != null; entry = in.getNextEntry()) {
                assertThat(entry.getName()).doesNotContain("..").doesNotStartWith("/");
                byte[] bytes = in.readAllBytes();
                entries.put(entry.getName(), bytes);
                Path file = target.resolve(entry.getName());
                Files.createDirectories(file.getParent());
                Files.write(file, bytes);
            }
        }
        return entries;
    }

    private static byte[] download(Host host, String path, int status) throws Exception {
        var response = java.net.http.HttpClient.newHttpClient().send(java.net.http.HttpRequest.newBuilder(
                        java.net.URI.create("http://127.0.0.1:" + host.port + path))
                .header("Authorization", "Bearer " + host.ownerToken()).header("X-Tenant-Id", host.tenant).GET().build(),
                java.net.http.HttpResponse.BodyHandlers.ofByteArray());
        assertThat(response.statusCode()).as(path).isEqualTo(status);
        if (status == 200) assertThat(response.headers().firstValue("Content-Type")).contains("application/zip");
        return response.body();
    }

    private static Path copyTree(Path from, Path to) throws Exception {
        try (var walk = Files.walk(from)) {
            for (Path path : walk.toList()) {
                Path target = to.resolve(from.relativize(path).toString());
                if (Files.isDirectory(path)) Files.createDirectories(target);
                else Files.copy(path, target);
            }
        }
        return to;
    }

    private static void replaceInFiles(Path dir, List<String> files, String from, String to) throws Exception {
        for (String name : files) {
            Path file = dir.resolve(name);
            String text = Files.readString(file);
            assertThat(text).as(name + " contains " + from).contains(from);
            Files.writeString(file, text.replace(from, to));
        }
    }

    private static long schemaRows(Host host, String schema) throws Exception {
        try (var connection = DriverManager.getConnection(host.postgres.getJdbcUrl(), host.postgres.getUsername(), host.postgres.getPassword());
             var statement = connection.prepareStatement("SELECT count(*) FROM media_artifacts WHERE tenant_id=? AND metadata_json LIKE ?")) {
            statement.setString(1, host.tenant);
            statement.setString(2, "%\"videoSchema\":\"" + schema + "\"%");
            try (var row = statement.executeQuery()) {
                row.next();
                return row.getLong(1);
            }
        }
    }

    private static JsonNode runBrowser(Path config, Path log) throws Exception {
        Path repoRoot = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (!Files.isRegularFile(repoRoot.resolve("scripts/media-dev-identity-token.mjs"))) {
            repoRoot = repoRoot.getParent();
            if (repoRoot == null) throw new AssertionError("Could not locate the Media repository root");
        }
        Path script = repoRoot.resolve("apps/media-experience-explorer/test/dev-interactive-demo-live-browser.mjs");
        assertThat(script).isRegularFile();
        Path playwright = null;
        for (String candidate : List.of("node_modules/playwright/index.mjs", "apps/media-experience-explorer/node_modules/playwright/index.mjs")) {
            if (Files.isRegularFile(repoRoot.resolve(candidate))) { playwright = repoRoot.resolve(candidate); break; }
        }
        assertThat(playwright).as("Playwright 1.63.0 (pnpm install)").isNotNull();
        ProcessBuilder builder = new ProcessBuilder("node", script.toString());
        builder.directory(repoRoot.toFile());
        builder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
        builder.environment().put("MEDIA_DEV_DEMO_CONFIG", config.toString());
        builder.environment().put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwright.toString());
        Process process = builder.start();
        try {
            String line;
            try (BufferedReader output = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                FutureTask<String> task = new FutureTask<>(output::readLine);
                Thread reader = new Thread(task, "media-dev-demo-browser-output");
                reader.setDaemon(true);
                reader.start();
                line = task.get(300, TimeUnit.SECONDS);
            }
            assertThat(line).as("browser event; log=" + (Files.exists(log) ? Files.readString(log) : "")).isNotNull();
            assertThat(process.waitFor(60, TimeUnit.SECONDS)).isTrue();
            assertThat(process.exitValue()).as("live browser script must pass; see " + log).isZero();
            return JSON.readTree(line);
        } finally {
            if (process.isAlive()) process.destroyForcibly();
        }
    }
}
