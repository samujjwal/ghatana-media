package com.ghatana.media.integration;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import tools.jackson.databind.JsonNode;

import java.awt.image.BufferedImage;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static com.ghatana.media.integration.MediaDevCompositeSupport.*;
import static com.ghatana.media.integration.MediaDevLiveFixtures.JSON;
import static com.ghatana.media.integration.MediaDevLiveFixtures.sha256;
import static com.ghatana.media.integration.MediaDevStoryboardSupport.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-09 outcome journey {@code media.dev.outcome-brief-to-reviewed-media} against REAL processes: a real launcher
 * (PostgreSQL + S3 + durable request ledger + review store), a real rights authority and real FFmpeg. A brief becomes a
 * versioned storyboard; the plan is edited to ordered scenes of animation, stored-video and placeholder shots; readiness
 * is typed per shot and blocks the render until every shot is genuinely renderable; the render is one MP4 whose DECODED
 * frames show every shot at its exact story-time boundary; the render goes to version-specific review; a storyboard edit
 * makes that review STALE; a stale edit is refused; erasing an asset erases the render. TEST principals only.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevStoryboardJourneyIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    static final Map<String, String> ENV = Map.of("MEDIA_DEV_REVIEW_ENABLED", "true", "MEDIA_DEV_STORYBOARD_ENABLED", "true");

    /** The storyboard the journey renders: intro (animation, stored A), middle (stored B, animation; narrated), outro. */
    static List<Map<String, Object>> scenes(String a, Media media, String b, String narration, byte[] narrationBytes,
                                            long teal) throws Exception {
        return List.of(
                scene("intro", "Intro", null, shot("s1", 1000, animation("#FF8000", true)),
                        shot("s2", 1000, asset(a, media.videoA(), 1000))),
                scene("middle", "Middle", ref(narration, narrationBytes), shot("s3", 1000, asset(b, media.videoB(), 2000)),
                        shot("s4", teal, animation("#008080", false))),
                scene("outro", "Outro", null, shot("s5", 1000, asset(a, media.videoA(), 3000))));
    }

    @Test
    void briefBecomesAVersionedStoryboardRendersExactlyAndIsReviewedPerVersion() throws Exception {
        try (Host host = Host.start(POSTGRES, LOCALSTACK, withEnv(Map.of()))) {
            Media media = generate(host.work.resolve("gen"));
            byte[] narrationBytes = narration(host.work.resolve("gen"), 1.5);
            String a = host.upload("a.mp4", "video/mp4", media.videoA());
            String b = host.upload("b.mp4", "video/mp4", media.videoB());
            String nar = host.upload("scene-narration.wav", "audio/wav", narrationBytes);
            String vtt = host.upload("cues.vtt", "text/vtt", media.vtt());
            Map<String, String> attestations = new LinkedHashMap<>();
            attestations.put(a, host.attest(a, media.videoA()));
            attestations.put(b, host.attest(b, media.videoB()));
            attestations.put(nar, host.attest(nar, narrationBytes));
            attestations.put(vtt, host.attest(vtt, media.vtt()));
            String base = "/dev/v1/storyboards";

            // ---- 1. a brief becomes a versioned storyboard (one placeholder scene per paragraph); it cannot render ----
            Map<String, Object> brief = new LinkedHashMap<>();
            brief.put("requestId", "j09");
            brief.put("storyboardId", "j09");
            brief.put("brief", Map.of("title", "Spring thaw", "text", "Snow on a field.\n\nThe snow melts.\n\nBirds return."));
            JsonNode v1 = host.ownerPost(base, brief, 201);
            assertThat(v1.path("versionNumber").asInt()).isEqualTo(1);
            assertThat(v1.path("scenes")).hasSize(3);
            assertThat(v1.path("scenes").get(1).path("shots").get(0).path("source").path("kind").asString()).isEqualTo("PLACEHOLDER");
            assertThat(v1.path("timeline").path("totalMs").asLong()).isEqualTo(6000);
            JsonNode notReady = host.ownerGet(base + "/j09/readiness", 200);
            assertThat(notReady.path("renderable").asBoolean()).isFalse();
            assertThat(blockerCodes(notReady.path("blockers"))).containsExactly("PLACEHOLDER_NOT_RENDERABLE@shot-1-1scene-1",
                    "PLACEHOLDER_NOT_RENDERABLE@shot-2-1scene-2", "PLACEHOLDER_NOT_RENDERABLE@shot-3-1scene-3");
            assertThat(notReady.path("shots").get(0).path("state").asString()).isEqualTo("BLOCKED");
            HttpResponse<String> placeholderRender = host.owner("POST", base + "/j09/renders", render("r-ph", 1));
            assertThat(placeholderRender.statusCode()).as(placeholderRender.body()).isEqualTo(422);
            assertThat(code(placeholderRender)).isEqualTo("STORYBOARD_NOT_RENDERABLE");
            assertThat(storyboardRenderRows(host, "j09", 1)).isZero();

            // ---- 2. an edit against version 1: ordered scenes with derived story time ----
            Map<String, Object> authored = board(scenes(a, media, b, nar, narrationBytes, 520), ref(vtt, media.vtt()));
            JsonNode v2 = host.ownerPost(base + "/j09/versions", edit("j09-e1", 1, authored), 201);
            assertThat(v2.path("versionNumber").asInt()).isEqualTo(2);
            assertThat(v2.path("headVersion").asInt()).isEqualTo(2);
            JsonNode timeline = v2.path("timeline");
            assertThat(timeline.path("totalMs").asLong()).isEqualTo(4520);
            assertThat(timeline.path("totalFrames").asLong()).isEqualTo(113);
            long[][] expectedScenes = {{0, 2000}, {2000, 3520}, {3520, 4520}};
            long[][] expectedShots = {{0, 1000}, {1000, 2000}, {2000, 3000}, {3000, 3520}, {3520, 4520}};
            int shotIndex = 0;
            for (int i = 0; i < 3; i++) {
                JsonNode scene = timeline.path("scenes").get(i);
                assertThat(new long[] {scene.path("startMs").asLong(), scene.path("endMs").asLong()}).containsExactly(expectedScenes[i]);
                for (JsonNode shot : scene.path("shots")) {
                    assertThat(new long[] {shot.path("startMs").asLong(), shot.path("endMs").asLong()})
                            .containsExactly(expectedShots[shotIndex++]);
                }
            }
            // ledger replay of the same edit is a 200 returning the same version, not a third version
            HttpResponse<String> editReplay = host.owner("POST", base + "/j09/versions", edit("j09-e1", 1, authored));
            assertThat(editReplay.statusCode()).as(editReplay.body()).isEqualTo(200);
            assertThat(JSON.readTree(editReplay.body()).path("artifact").path("artifactId").asString())
                    .isEqualTo(v2.path("artifact").path("artifactId").asString());
            assertThat(host.ownerGet(base + "/j09/versions", 200).path("versions")).hasSize(2);
            // the same requestId with a different body is a 409
            Map<String, Object> other = board(scenes(a, media, b, nar, narrationBytes, 560), ref(vtt, media.vtt()));
            HttpResponse<String> reused = host.owner("POST", base + "/j09/versions", edit("j09-e1", 1, other));
            assertThat(reused.statusCode()).as(reused.body()).isEqualTo(409);
            assertThat(code(reused)).isEqualTo("REQUEST_ID_REUSED");

            // ---- 3. readiness is typed per shot: stored assets are renderable, authored animation lacks its statement ----
            JsonNode blocked = host.ownerGet(base + "/j09/readiness", 200);
            assertThat(blocked.path("renderable").asBoolean()).isFalse();
            assertThat(blockerCodes(blocked.path("blockers"))).containsExactly("AUTHORED_RIGHTS_DENIED@s1intro",
                    "AUTHORED_RIGHTS_DENIED@s4middle");
            Map<String, String> states = new LinkedHashMap<>();
            blocked.path("shots").forEach(shot -> states.put(shot.path("shotId").asString(), shot.path("state").asString()));
            assertThat(states).containsExactly(Map.entry("s1", "BLOCKED"), Map.entry("s2", "RENDERABLE"),
                    Map.entry("s3", "RENDERABLE"), Map.entry("s4", "BLOCKED"), Map.entry("s5", "RENDERABLE"));
            HttpResponse<String> noRights = host.owner("POST", base + "/j09/renders", render("r-main", 2));
            assertThat(noRights.statusCode()).as(noRights.body()).isEqualTo(403);
            assertThat(code(noRights)).isEqualTo("STORYBOARD_RIGHTS_DENIED");
            assertThat(storyboardRenderRows(host, "j09", 2)).isZero();
            // a version that is not the head cannot render (and is not rendered silently)
            HttpResponse<String> staleRender = host.owner("POST", base + "/j09/renders", render("r-old", 1));
            assertThat(staleRender.statusCode()).as(staleRender.body()).isEqualTo(409);
            assertThat(code(staleRender)).isEqualTo("STORYBOARD_VERSION_STALE");

            // ---- 4. the owner's own statement about this exact version makes it genuinely renderable ----
            String storyboardAttestation = attestStoryboard(host, v2);
            JsonNode ready = host.ownerGet(base + "/j09/readiness", 200);
            assertThat(ready.path("renderable").asBoolean()).as(ready.toString()).isTrue();
            assertThat(host.owner("GET", base + "/j09/versions/2/render", null).statusCode()).isEqualTo(404);

            // ---- 5. render: one MP4 whose decoded frames show every shot at its exact boundary ----
            HttpResponse<String> created = host.owner("POST", base + "/j09/renders", render("r-main", 2));
            assertThat(created.statusCode()).as(created.body()).isEqualTo(201);
            JsonNode render = JSON.readTree(created.body());
            String renderId = render.path("renderId").asString();
            Path mp4 = host.work.resolve("storyboard.mp4");
            byte[] bytes = host.artifactBytes(renderId);
            Files.write(mp4, bytes);
            assertThat(sha256(bytes)).isEqualTo(render.path("artifact").path("sha256").asString());
            JsonNode probe = probe(mp4);
            int video = 0, audio = 0, subtitle = 0;
            for (JsonNode stream : probe.path("streams")) {
                switch (stream.path("codec_type").asString()) {
                    case "video" -> {
                        video++;
                        assertThat(stream.path("codec_name").asString()).isEqualTo("h264");
                        assertThat(stream.path("r_frame_rate").asString()).isEqualTo("25/1");
                        assertThat(stream.path("nb_read_frames").asString()).as("exact frame count").isEqualTo("113");
                    }
                    case "audio" -> audio++;
                    case "subtitle" -> subtitle++;
                    default -> { }
                }
            }
            assertThat(new int[] {video, audio, subtitle}).containsExactly(1, 1, 1);
            assertThat(Double.parseDouble(probe.path("format").path("duration").asString())).isBetween(4.51, 4.56);
            // first and last frame of every shot: scene order and story-time boundaries visible in the decoded MP4
            int[][] signatures = {
                    {0, 255, 128, 0}, {24, 255, 128, 0},    // s1 animation orange
                    {25, 0, 255, 0}, {49, 0, 255, 0},       // s2 stored A at 1 s: green
                    {50, 255, 0, 255}, {74, 255, 0, 255},   // s3 stored B at 2 s (30 fps source): magenta
                    {75, 0, 128, 128}, {87, 0, 128, 128},   // s4 animation teal, 13 frames
                    {88, 255, 255, 0}, {112, 255, 255, 0}}; // s5 stored A at 3 s: yellow
            for (int[] signature : signatures) {
                int x = signature[0] >= 50 && signature[0] <= 74 ? 250 : 160;
                int y = signature[0] >= 50 && signature[0] <= 74 ? 60 : 200;
                assertThat(nearly(frame(mp4, signature[0]), x, y, signature[1], signature[2], signature[3]))
                        .as("frame " + signature[0]).isTrue();
            }
            // the animation lane really rendered motion: the white box is at the left on frame 0 and at the right on frame 24
            assertThat(nearly(frame(mp4, 0), 30, 30, 255, 255, 255)).as("box at the start").isTrue();
            assertThat(nearly(frame(mp4, 24), 30, 30, 255, 128, 0)).as("box has left the start").isTrue();
            assertThat(nearly(frame(mp4, 24), 230, 30, 255, 255, 255)).as("box at the end").isTrue();
            // narration lands at its scene: the marker is 0.5 s into the middle scene which starts at 2.0 s
            double onset = beepOnsetSeconds(leftChannel(mp4));
            assertThat(Math.abs(onset - 2.5)).as("narration onset " + onset).isLessThanOrEqualTo(1.0 / FPS);
            assertThat(subtitleCues(mp4)).containsExactly("00:00:00,500 --> 00:00:01,500 Hello world",
                    "00:00:02,500 --> 00:00:03,500 Second cue");

            // ---- 6. lineage: storyboard version and every asset, including the rendered animation shots ----
            JsonNode lineage = render.path("lineage");
            JsonNode annotations = lineage.path("annotations");
            assertThat(annotations.path("storyboardId").asString()).isEqualTo("j09");
            assertThat(annotations.path("storyboardVersion").asInt()).isEqualTo(2);
            assertThat(annotations.path("storyboardArtifactId").asString()).isEqualTo(v2.path("artifact").path("artifactId").asString());
            assertThat(annotations.path("shots")).hasSize(5);
            assertThat(annotations.path("shots").get(3).path("startFrame").asInt()).isEqualTo(75);
            assertThat(annotations.path("shots").get(3).path("frames").asInt()).isEqualTo(13);
            List<String> sourceIds = new ArrayList<>();
            lineage.path("sources").forEach(source -> sourceIds.add(source.path("artifactId").asString()));
            assertThat(sourceIds).contains(a, b, nar, vtt);
            assertThat(sourceIds).as("A twice (s2, s5), B, narration, captions, two animation shots").hasSize(7);
            for (JsonNode shot : annotations.path("shots")) {
                assertThat(sourceIds).contains(shot.path("artifactId").asString());
            }
            String animationOne = annotations.path("shots").get(0).path("artifactId").asString();
            JsonNode animationLineage = host.ownerGet("/dev/v1/animations/renders/"
                    + annotations.path("shots").get(0).path("animationRenderId").asString(), 200);
            assertThat(animationLineage.path("video").path("artifactId").asString()).isEqualTo(animationOne);
            assertThat(animationLineage.path("videoLineage").path("parent").path("artifactId").asString())
                    .as("the animation names the storyboard version as its authored anchor")
                    .isEqualTo(v2.path("artifact").path("artifactId").asString());
            JsonNode listed = host.ownerGet(base + "/j09/versions", 200);
            assertThat(listed.path("versions").get(1).path("render").asString()).isEqualTo(renderId);
            assertThat(listed.path("versions").get(0).path("render").isNull()).isTrue();
            assertThat(storyboardRenderRows(host, "j09", 2)).isEqualTo(1);

            // ---- 7. ledger replay is 200 with nothing registered; the render is readable back ----
            HttpResponse<String> replay = host.owner("POST", base + "/j09/renders", render("r-main", 2));
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
            assertThat(JSON.readTree(replay.body()).path("renderId").asString()).isEqualTo(renderId);
            // another request for the same version converges on the same render (one render per storyboard version)
            HttpResponse<String> second = host.owner("POST", base + "/j09/renders", render("r-main-b", 2));
            assertThat(second.statusCode()).as(second.body()).isIn(200, 201);
            assertThat(JSON.readTree(second.body()).path("renderId").asString()).isEqualTo(renderId);
            assertThat(storyboardRenderRows(host, "j09", 2)).isEqualTo(1);

            // ---- 8. review handoff of this exact render; a reviewer accepts it; it is CURRENT ----
            JsonNode handoff = host.ownerPost(base + "/j09/versions/2/review", Map.of(), 201);
            String caseId = handoff.path("review").path("reviewCaseId").asString();
            assertThat(caseId).isNotBlank();
            assertThat(handoff.path("renderId").asString()).isEqualTo(renderId);
            assertThat(handoff.path("review").path("currentness").asString()).isEqualTo("CURRENT");
            assertThat(host.ownerPost(base + "/j09/versions/2/review", Map.of(), 200).path("review").path("reviewCaseId").asString())
                    .as("the handoff is idempotent").isEqualTo(caseId);
            host.ownerPost("/dev/v1/reviews/" + caseId + "/assignments", assignment("j09-assign", caseRevision(host, caseId, true),
                    host.other), 201);
            JsonNode accepted = JSON.readTree(host.other("POST", "/dev/v1/reviews/" + caseId + "/decisions",
                    decision("j09-accept", caseRevision(host, caseId, false), "ACCEPT", "APPROVAL")).body());
            assertThat(accepted.path("currentness").asString()).isEqualTo("CURRENT");
            assertThat(accepted.path("establishesApproval").asBoolean()).isFalse();
            JsonNode accepted1 = host.ownerGet(base + "/j09/versions/2/review", 200);
            assertThat(accepted1.path("review").path("acceptedByAssignedReviewer").asBoolean()).isTrue();
            assertThat(accepted1.path("review").path("currentness").asString()).isEqualTo("CURRENT");
            // the reviewer reads exactly the rendered bytes
            HttpResponse<byte[]> content = reviewerBytes(host, "/dev/v1/reviews/" + caseId + "/content");
            assertThat(content.statusCode()).isEqualTo(200);
            assertThat(content.body()).isEqualTo(bytes);

            // ---- 9. stale edit: against version 1 -> 409 and nothing written; against head -> version 3 ----
            HttpResponse<String> stale = host.owner("POST", base + "/j09/versions", edit("j09-e-stale", 1,
                    board(scenes(a, media, b, nar, narrationBytes, 560), ref(vtt, media.vtt()))));
            assertThat(stale.statusCode()).as(stale.body()).isEqualTo(409);
            assertThat(code(stale)).isEqualTo("STORYBOARD_VERSION_STALE");
            assertThat(details(stale).path("headVersion").asInt()).isEqualTo(2);
            assertThat(host.ownerGet(base + "/j09/versions", 200).path("versions")).as("nothing written").hasSize(2);
            HttpResponse<String> badEdit = host.owner("POST", base + "/j09/versions", edit("j09-e-bad", 2,
                    board(scenes(a, media, b, nar, narrationBytes, 530), ref(vtt, media.vtt()))));
            assertThat(badEdit.statusCode()).as(badEdit.body()).isEqualTo(422);
            assertThat(code(badEdit)).isEqualTo("DURATION_NOT_FRAME_ALIGNED");
            assertThat(details(badEdit).path("path").asString()).isEqualTo("$.scenes[1].shots[1].durationMs");
            Map<String, Object> derived = board(scenes(a, media, b, nar, narrationBytes, 520), ref(vtt, media.vtt()));
            @SuppressWarnings("unchecked")
            Map<String, Object> animationSource = (Map<String, Object>) ((Map<String, Object>) ((List<Object>) ((Map<String, Object>)
                    ((List<Object>) derived.get("scenes")).get(0)).get("shots")).get(0)).get("source");
            @SuppressWarnings("unchecked")
            Map<String, Object> spec = (Map<String, Object>) animationSource.get("spec");
            spec.put("frameCount", 99);
            HttpResponse<String> derivedEdit = host.owner("POST", base + "/j09/versions", edit("j09-e-derived", 2, derived));
            assertThat(derivedEdit.statusCode()).isEqualTo(422);
            assertThat(details(derivedEdit).path("path").asString()).isEqualTo("$.scenes[0].shots[0].source.spec.frameCount");

            JsonNode v3 = host.ownerPost(base + "/j09/versions", edit("j09-e3", 2,
                    board(scenes(a, media, b, nar, narrationBytes, 560), ref(vtt, media.vtt()))), 201);
            assertThat(v3.path("versionNumber").asInt()).isEqualTo(3);
            assertThat(v3.path("timeline").path("totalMs").asLong()).isEqualTo(4560);

            // ---- 10. the review of version 2's render is STALE for the new storyboard version ----
            JsonNode staleReview = host.ownerGet(base + "/j09/versions/2/review", 200);
            assertThat(staleReview.path("review").path("currentness").asString()).isEqualTo("STALE");
            assertThat(staleReview.path("review").path("acceptedByAssignedReviewer").asBoolean()).isFalse();
            assertThat(host.ownerGet("/dev/v1/reviews/" + caseId, 200).path("currentness").asString()).isEqualTo("STALE");
            HttpResponse<String> late = host.other("POST", "/dev/v1/reviews/" + caseId + "/decisions",
                    decision("j09-late", caseRevision(host, caseId, false), "ACCEPT", "APPROVAL"));
            assertThat(late.statusCode()).as(late.body()).isEqualTo(409);
            assertThat(code(late)).isEqualTo("REVIEW_SUBJECT_STALE");
            JsonNode staleHandoff = host.ownerPost(base + "/j09/versions/2/review", Map.of(), 200);
            assertThat(staleHandoff.path("review").path("currentness").asString()).isEqualTo("STALE");
            // version 2 no longer renders; version 3 has no statement of its own (rights are per exact version)
            assertThat(host.owner("POST", base + "/j09/renders", render("r-v2-again", 2)).statusCode()).isEqualTo(409);
            HttpResponse<String> v3NoRights = host.owner("POST", base + "/j09/renders", render("r-v3", 3));
            assertThat(v3NoRights.statusCode()).as(v3NoRights.body()).isEqualTo(403);
            attestStoryboard(host, v3);
            HttpResponse<String> v3Render = host.owner("POST", base + "/j09/renders", render("r-v3", 3));
            assertThat(v3Render.statusCode()).as(v3Render.body()).isEqualTo(201);
            JsonNode render3 = JSON.readTree(v3Render.body());
            assertThat(render3.path("renderId").asString()).isNotEqualTo(renderId);
            Path mp43 = host.work.resolve("storyboard-v3.mp4");
            Files.write(mp43, host.artifactBytes(render3.path("renderId").asString()));
            assertThat(probe(mp43).path("streams").get(0).path("nb_read_frames").asString()).isEqualTo("114");
            assertThat(nearly(frame(mp43, 88), 160, 200, 0, 128, 128)).as("the longer teal shot now runs to frame 88").isTrue();
            assertThat(nearly(frame(mp43, 89), 160, 200, 255, 255, 0)).as("outro moved one frame later").isTrue();
            // the old render and its review stay readable history; the new render is not yet reviewed
            assertThat(host.ownerGet(base + "/j09/versions/2/render", 200).path("renderId").asString()).isEqualTo(renderId);
            assertThat(host.ownerGet(base + "/j09/versions/3/review", 200).path("review").path("caseExists").asBoolean()).isFalse();

            // ---- 11. launcher restart: versions, renders, replay and the stale review all read back ----
            host.restart();
            JsonNode headAfter = host.ownerGet(base + "/j09", 200);
            assertThat(headAfter.path("versionNumber").asInt()).isEqualTo(3);
            assertThat(headAfter.path("render").path("renderId").asString()).isEqualTo(render3.path("renderId").asString());
            assertThat(host.ownerGet(base + "/j09/versions/2", 200).path("timeline").path("totalMs").asLong()).isEqualTo(4520);
            assertThat(host.owner("POST", base + "/j09/renders", render("r-v3", 3)).statusCode()).isEqualTo(200);
            assertThat(host.ownerGet(base + "/j09/versions/2/review", 200).path("review").path("currentness").asString())
                    .isEqualTo("STALE");
            assertThat(host.owner("POST", base + "/j09/versions", edit("j09-e3", 2,
                    board(scenes(a, media, b, nar, narrationBytes, 560), ref(vtt, media.vtt())))).statusCode())
                    .as("the edit replay survives the restart").isEqualTo(200);
            assertThat(storyboardRenderRows(host, "j09", 3)).isEqualTo(1);

            // ---- 12. wrong tenant and other principal: 404, never a leak ----
            for (String path : List.of(base + "/j09", base + "/j09/versions", base + "/j09/readiness", base + "/j09/versions/3",
                    base + "/j09/versions/3/render")) {
                assertThat(host.foreignTenant("GET", path, null).statusCode()).as("foreign tenant " + path).isEqualTo(404);
                assertThat(host.other("GET", path, null).statusCode()).as("other principal " + path).isEqualTo(404);
            }
            assertThat(host.foreignTenant("POST", base + "/j09/versions", edit("x-1", 3, authored)).statusCode()).isEqualTo(404);
            assertThat(host.other("POST", base + "/j09/renders", render("x-2", 3)).statusCode()).isEqualTo(404);
            assertThat(host.other("POST", base + "/j09/versions/3/review", Map.of()).statusCode()).isEqualTo(404);

            // ---- 13. a revoked stored asset blocks the render on every call, a replay included ----
            host.ownerPost("/dev/v1/rights/attestations/" + attestations.get(a) + "/revoke", Map.of("reason", "TEST: revoked"), 200);
            JsonNode revoked = host.ownerGet(base + "/j09/readiness", 200);
            assertThat(revoked.path("renderable").asBoolean()).isFalse();
            assertThat(blockerCodes(revoked.path("blockers"))).contains("RIGHTS_REVOKED@s2intro", "RIGHTS_REVOKED@s5outro");
            HttpResponse<String> revokedRender = host.owner("POST", base + "/j09/renders", render("r-v3", 3));
            assertThat(revokedRender.statusCode()).as(revokedRender.body()).isEqualTo(403);
            assertThat(code(revokedRender)).isEqualTo("STORYBOARD_RIGHTS_DENIED");

            // ---- 14. erasing the narration asset erases every render that depends on it ----
            JsonNode plan = host.ownerGet("/dev/v1/erasure-plans/" + nar, 200);
            Map<String, String> kinds = new java.util.TreeMap<>();
            for (JsonNode node : plan.path("artifacts")) kinds.put(node.path("artifactId").asString(), node.path("kind").asString());
            assertThat(kinds).containsEntry(renderId, "RENDER").containsEntry(render3.path("renderId").asString(), "RENDER");
            HttpResponse<String> erased = host.owner("POST", "/dev/v1/erasures", Map.of("erasureId", "j09-erase-" + host.run,
                    "artifactId", nar, "confirm", true));
            assertThat(erased.statusCode()).as(erased.body()).isEqualTo(201);
            assertThat(host.owner("GET", "/dev/v1/composite-renders/" + renderId, null).statusCode()).isEqualTo(404);
            assertThat(host.owner("GET", "/dev/v1/composite-renders/" + render3.path("renderId").asString(), null).statusCode())
                    .isEqualTo(404);
            assertThat(host.owner("GET", base + "/j09/versions/3/render", null).statusCode()).isEqualTo(404);
            assertThat(host.owner("GET", base + "/j09/versions/2/render", null).statusCode()).isEqualTo(404);
            assertThat(storyboardRenderRows(host, "j09", 2) + storyboardRenderRows(host, "j09", 3)).isZero();
            JsonNode afterErase = host.ownerGet(base + "/j09/readiness", 200);
            assertThat(blockerCodes(afterErase.path("blockers"))).contains("NARRATION_UNAVAILABLE@middle");
            HttpResponse<String> erasedRender = host.owner("POST", base + "/j09/renders", render("r-v3", 3));
            assertThat(erasedRender.statusCode()).as("a blocked storyboard never replays an erased render").isGreaterThanOrEqualTo(403);
            host.passed = true;
        }
    }

    static HttpResponse<byte[]> reviewerBytes(Host host, String path) throws Exception {
        return java.net.http.HttpClient.newHttpClient().send(java.net.http.HttpRequest.newBuilder(
                        java.net.URI.create("http://127.0.0.1:" + host.port + path))
                .header("Authorization", "Bearer " + host.otherToken()).header("X-Tenant-Id", host.tenant).GET().build(),
                HttpResponse.BodyHandlers.ofByteArray());
    }

    static Map<String, String> withEnv(Map<String, String> extra) {
        Map<String, String> env = new LinkedHashMap<>(ENV);
        env.putAll(extra);
        return env;
    }
}
