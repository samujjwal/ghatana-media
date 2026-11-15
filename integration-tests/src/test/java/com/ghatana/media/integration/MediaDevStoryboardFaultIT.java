package com.ghatana.media.integration;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import tools.jackson.databind.JsonNode;

import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevCompositeSupport.*;
import static com.ghatana.media.integration.MediaDevLiveFixtures.JSON;
import static com.ghatana.media.integration.MediaDevStoryboardSupport.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-09 fault suite against a REAL launcher: typed 422 refusals with JSON paths, a stale edit and a concurrent edit race, ledger
 * 409s, rights missing and revoked (403), assets that are the wrong type, too short, missing or another principal's, narration
 * that does not fit its scene, a render budget, no renderer configured (never a fake ready), wrong tenant and principal (404),
 * and a launcher restart. A storyboard of stored assets only renders without any authored-content statement.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevStoryboardFaultIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private static final String BASE = "/dev/v1/storyboards";

    private static Map<String, Object> assets(String a, Media media, String b, long ms) throws Exception {
        return board(List.of(scene("one", "One", null, shot("x1", ms, asset(a, media.videoA(), 0)),
                shot("x2", ms, asset(b, media.videoB(), 0)))), null);
    }

    @Test
    void refusesInvalidStaleRacingAndRightsFaultsWithTypedOutcomes() throws Exception {
        try (Host host = Host.start(POSTGRES, LOCALSTACK, MediaDevStoryboardJourneyIT.withEnv(Map.of()))) {
            Media media = generate(host.work.resolve("gen"));
            String a = host.upload("a.mp4", "video/mp4", media.videoA());
            String b = host.upload("b.mp4", "video/mp4", media.videoB());
            String a1 = host.attest(a, media.videoA());
            host.attest(b, media.videoB());
            String png = host.upload("g.png", "image/png", media.graphic());
            host.attest(png, media.graphic());
            String unattested = host.upload("raw.mp4", "video/mp4", mutated(media.videoB()));
            // another principal's stored video in the same tenant
            String foreign = MediaDevLiveFixtures.upload(host.port, host.tenant, host.other, host.otherToken(), host.run + "-foreign",
                    "foreign.mp4", "video/mp4", mutated(media.videoA(), 2));

            // ---- invalid storyboards: typed 422 with the JSON path ----
            Map<String, Object> good = assets(a, media, b, 1000);
            HttpResponse<String> created = host.owner("POST", BASE, create("f1", good));
            assertThat(created.statusCode()).as(created.body()).isEqualTo(201);
            String[][] invalids = {
                    {"empty scenes", "$.scenes"}, {"duplicate shot id", "$.scenes[0].shots[1].shotId"},
                    {"unknown source kind", "$.scenes[0].shots[0].source.kind"}, {"unknown field", "$.scenes[0].extra"},
                    {"short brief title", "$.brief.title"}, {"not frame aligned", "$.scenes[0].shots[0].durationMs"},
                    {"bad version", "$.scenes[0].shots[0].source.artifactVersionId"}, {"bad animation colour", null}};
            for (String[] invalid : invalids) {
                Map<String, Object> board = assets(a, media, b, 1000);
                @SuppressWarnings("unchecked") List<Map<String, Object>> scenes = (List<Map<String, Object>>) board.get("scenes");
                @SuppressWarnings("unchecked") List<Map<String, Object>> shots = (List<Map<String, Object>>) scenes.get(0).get("shots");
                switch (invalid[0]) {
                    case "empty scenes" -> scenes.clear();
                    case "duplicate shot id" -> shots.get(1).put("shotId", "x1");
                    case "unknown source kind" -> ((Map<String, Object>) shots.get(0).get("source")).put("kind", "STOCK");
                    case "unknown field" -> scenes.get(0).put("extra", true);
                    case "short brief title" -> board.put("brief", Map.of("title", "", "text", "x"));
                    case "not frame aligned" -> shots.get(0).put("durationMs", 1001);
                    case "bad version" -> ((Map<String, Object>) shots.get(0).get("source")).put("artifactVersionId", "v1");
                    default -> shots.set(0, shot("bad", 1000, animation("red", false)));
                }
                HttpResponse<String> refused = host.owner("POST", BASE + "/f1/versions", edit("bad-" + invalid[0].replace(' ', '-'), 1, board));
                assertThat(refused.statusCode()).as(invalid[0] + " " + refused.body()).isEqualTo(422);
                if (invalid[1] != null) assertThat(details(refused).path("path").asString()).as(invalid[0]).isEqualTo(invalid[1]);
                else assertThat(details(refused).path("path").asString()).startsWith("$.scenes[0].shots[0].source.spec");
            }
            HttpResponse<String> malformed = host.owner("POST", BASE + "/f1/versions", null);
            assertThat(malformed.statusCode()).isGreaterThanOrEqualTo(400).isLessThan(500);
            assertThat(host.ownerGet(BASE + "/f1/versions", 200).path("versions")).as("no refusal wrote a version").hasSize(1);

            // ---- ledger: same requestId different body is 409, same id under a new request is 409 STORYBOARD_EXISTS ----
            HttpResponse<String> reuse = host.owner("POST", BASE, create("f1", assets(a, media, b, 1040)));
            assertThat(reuse.statusCode()).as(reuse.body()).isEqualTo(409);
            assertThat(code(reuse)).isEqualTo("REQUEST_ID_REUSED");
            Map<String, Object> again = create("f1-other-request", good);
            again.put("storyboardId", "f1");
            HttpResponse<String> exists = host.owner("POST", BASE, again);
            assertThat(exists.statusCode()).as(exists.body()).isEqualTo(409);
            assertThat(code(exists)).isEqualTo("STORYBOARD_EXISTS");
            assertThat(host.owner("POST", BASE, create("f1", good)).statusCode()).as("create replay").isEqualTo(200);

            // ---- a concurrent pair of edits against one version: exactly one wins, the other is a stale 409 ----
            List<CompletableFuture<HttpResponse<String>>> race = new ArrayList<>();
            for (int i = 0; i < 2; i++) {
                int n = i;
                race.add(CompletableFuture.supplyAsync(() -> {
                    try { return host.owner("POST", BASE + "/f1/versions", edit("race-" + n, 1, assets(a, media, b, n == 0 ? 1000 : 1040))); }
                    catch (Exception failure) { throw new IllegalStateException(failure); }
                }));
            }
            List<Integer> statuses = new ArrayList<>();
            for (var future : race) statuses.add(future.get(60, TimeUnit.SECONDS).statusCode());
            assertThat(statuses).containsExactlyInAnyOrder(201, 409);
            assertThat(host.ownerGet(BASE + "/f1/versions", 200).path("versions")).hasSize(2);
            assertThat(host.ownerGet(BASE + "/f1", 200).path("versionNumber").asInt()).isEqualTo(2);

            // ---- readiness is typed per shot ----
            Map<String, Object> mixed = board(List.of(
                    scene("one", "One", null, shot("png", 1000, asset(png, media.graphic(), 0)),
                            shot("short", 1000, asset(a, media.videoA(), 3480)), shot("none", 1000, asset(unattested, mutated(media.videoB()), 0)),
                            shot("gone", 1000, asset("no-such-artifact", media.videoA(), 0)),
                            shot("theirs", 1000, asset(foreign, mutated(media.videoA(), 2), 0)), shot("ph", 1000, placeholder("later"))),
                    scene("two", "Two", ref(a, media.videoA()), shot("fine", 1000, asset(b, media.videoB(), 0)))), ref(a, media.videoA()));
            JsonNode v3 = host.ownerPost(BASE + "/f1/versions", edit("mixed", 2, mixed), 201);
            assertThat(v3.path("versionNumber").asInt()).isEqualTo(3);
            JsonNode readiness = host.ownerGet(BASE + "/f1/readiness", 200);
            assertThat(readiness.path("renderable").asBoolean()).isFalse();
            Map<String, String> reasons = new LinkedHashMap<>();
            readiness.path("shots").forEach(shot -> reasons.put(shot.path("shotId").asString(),
                    shot.path("state").asString() + ":" + (shot.path("reasons").isEmpty() ? "" : shot.path("reasons").get(0).path("code").asString())));
            assertThat(reasons).containsEntry("png", "BLOCKED:ASSET_NOT_VIDEO").containsEntry("short", "BLOCKED:ASSET_TOO_SHORT")
                    .containsEntry("none", "BLOCKED:RIGHTS_DENIED").containsEntry("gone", "BLOCKED:ASSET_UNAVAILABLE")
                    .containsEntry("theirs", "BLOCKED:ASSET_UNAVAILABLE").containsEntry("ph", "BLOCKED:PLACEHOLDER_NOT_RENDERABLE")
                    .containsEntry("fine", "RENDERABLE:");
            List<String> blockers = blockerCodes(readiness.path("blockers"));
            assertThat(blockers).contains("NARRATION_NOT_AUDIO@two", "CAPTIONS_NOT_VTT@");
            HttpResponse<String> refusedRender = host.owner("POST", BASE + "/f1/renders", render("rr-1", 3));
            assertThat(refusedRender.statusCode()).as(refusedRender.body()).isEqualTo(403);
            assertThat(code(refusedRender)).isEqualTo("STORYBOARD_RIGHTS_DENIED");
            assertThat(details(refusedRender).path("blockers")).isNotEmpty();
            assertThat(storyboardRenderRows(host, "f1", 3)).isZero();

            // ---- a stored-asset storyboard needs no authored-content statement and renders exactly ----
            JsonNode v4 = host.ownerPost(BASE + "/f1/versions", edit("assets-only", 3, assets(a, media, b, 1000)), 201);
            assertThat(host.ownerGet(BASE + "/f1/readiness", 200).path("renderable").asBoolean()).isTrue();
            HttpResponse<String> rendered = host.owner("POST", BASE + "/f1/renders", render("rr-4", 4));
            assertThat(rendered.statusCode()).as(rendered.body()).isEqualTo(201);
            JsonNode render = JSON.readTree(rendered.body());
            Path mp4 = host.work.resolve("assets-only.mp4");
            Files.write(mp4, host.artifactBytes(render.path("renderId").asString()));
            assertThat(probe(mp4).path("streams").get(0).path("nb_read_frames").asString()).isEqualTo("50");
            assertThat(nearly(frame(mp4, 0), 160, 200, 255, 0, 0)).as("first shot is A's red second").isTrue();
            assertThat(nearly(frame(mp4, 25), 250, 60, 255, 255, 255)).as("second shot is B's white second").isTrue();
            assertThat(v4.path("versionNumber").asInt()).isEqualTo(4);

            // ---- revoked asset rights block the render, a replay included ----
            host.ownerPost("/dev/v1/rights/attestations/" + a1 + "/revoke", Map.of("reason", "TEST: revoked"), 200);
            for (String requestId : List.of("rr-4", "rr-5")) {
                HttpResponse<String> revoked = host.owner("POST", BASE + "/f1/renders", render(requestId, 4));
                assertThat(revoked.statusCode()).as(requestId + " " + revoked.body()).isEqualTo(403);
                assertThat(code(revoked)).isEqualTo("STORYBOARD_RIGHTS_DENIED");
            }
            assertThat(blockerCodes(host.ownerGet(BASE + "/f1/readiness", 200).path("blockers"))).contains("RIGHTS_REVOKED@x1one");
            assertThat(storyboardRenderRows(host, "f1", 4)).as("the earlier render is untouched history").isEqualTo(1);

            // ---- wrong tenant and other principal: 404 on every route ----
            for (String path : List.of(BASE + "/f1", BASE + "/f1/versions", BASE + "/f1/versions/1", BASE + "/f1/readiness",
                    BASE + "/f1/versions/4/render", BASE + "/f1/versions/4/review")) {
                assertThat(host.foreignTenant("GET", path, null).statusCode()).as("foreign " + path).isEqualTo(404);
                assertThat(host.other("GET", path, null).statusCode()).as("other " + path).isEqualTo(404);
            }
            assertThat(host.other("POST", BASE + "/f1/renders", render("o-1", 4)).statusCode()).isEqualTo(404);
            assertThat(host.foreignTenant("POST", BASE + "/f1/versions", edit("o-2", 4, good)).statusCode()).isEqualTo(404);
            assertThat(host.other("POST", BASE, create("f1", good)).statusCode()).as("another principal cannot replay my create")
                    .isIn(200, 201, 409).isNotEqualTo(500);
            assertThat(host.ownerGet(BASE + "/capabilities", 200).path("renderer").path("compositeAvailable").asBoolean()).isTrue();

            // ---- restart: versions, head, render and the replay refusal all read back ----
            host.restart();
            assertThat(host.ownerGet(BASE + "/f1/versions", 200).path("versions")).hasSize(4);
            assertThat(host.ownerGet(BASE + "/f1/versions/4/render", 200).path("renderId").asString()).isEqualTo(render.path("renderId").asString());
            assertThat(host.owner("POST", BASE, create("f1", good)).statusCode()).as("create replay after restart").isEqualTo(200);
            assertThat(host.owner("POST", BASE + "/f1/renders", render("rr-4", 4)).statusCode()).as("revoked still refused").isEqualTo(403);
            host.passed = true;
        }
    }

    @Test
    void neverClaimsReadinessWithoutARendererOrWithinABudgetItCannotMeet() throws Exception {
        try (Host host = Host.start(POSTGRES, LOCALSTACK, MediaDevStoryboardJourneyIT.withEnv(
                Map.of("MEDIA_DEV_RENDER_FFMPEG", "", "MEDIA_DEV_RENDER_FFPROBE", "")))) {
            Media media = generate(host.work.resolve("gen"));
            String a = host.upload("a.mp4", "video/mp4", media.videoA());
            String b = host.upload("b.mp4", "video/mp4", media.videoB());
            host.attest(a, media.videoA());
            host.attest(b, media.videoB());
            assertThat(host.owner("POST", BASE, create("n1", assets(a, media, b, 1000))).statusCode()).isEqualTo(201);
            JsonNode capabilities = host.ownerGet(BASE + "/capabilities", 200);
            assertThat(capabilities.path("renderer").path("compositeAvailable").asBoolean()).isFalse();
            assertThat(capabilities.path("renderer").path("animationAvailable").asBoolean()).isFalse();
            JsonNode readiness = host.ownerGet(BASE + "/n1/readiness", 200);
            assertThat(readiness.path("renderable").asBoolean()).as("fully attested stored assets but no renderer").isFalse();
            assertThat(blockerCodes(readiness.path("blockers"))).contains("RENDERER_UNAVAILABLE@x1one", "RENDERER_UNAVAILABLE@x2one",
                    "RENDERER_UNAVAILABLE@");
            readiness.path("shots").forEach(shot -> assertThat(shot.path("state").asString()).isEqualTo("BLOCKED"));
            HttpResponse<String> render = host.owner("POST", BASE + "/n1/renders", render("n-r", 1));
            assertThat(render.statusCode()).as(render.body()).isEqualTo(422);
            assertThat(code(render)).isEqualTo("STORYBOARD_NOT_RENDERABLE");
            host.passed = true;
        }
    }

    @Test
    void narrationMustFitItsSceneAndTheRenderBudgetIsEnforced() throws Exception {
        try (Host host = Host.start(POSTGRES, LOCALSTACK, MediaDevStoryboardJourneyIT.withEnv(Map.of()))) {
            Media media = generate(host.work.resolve("gen"));
            String a = host.upload("a.mp4", "video/mp4", media.videoA());
            host.attest(a, media.videoA());
            String longNarration = host.upload("long.wav", "audio/wav", media.narration());
            host.attest(longNarration, media.narration());
            Map<String, Object> board = board(List.of(scene("one", "One", ref(longNarration, media.narration()),
                    shot("x1", 2000, asset(a, media.videoA(), 0)))), null);
            assertThat(host.owner("POST", BASE, create("m1", board)).statusCode()).isEqualTo(201);
            JsonNode readiness = host.ownerGet(BASE + "/m1/readiness", 200);
            assertThat(blockerCodes(readiness.path("blockers"))).containsExactly("NARRATION_LONGER_THAN_SCENE@one");
            assertThat(readiness.path("blockers").get(0).path("details").path("narrationMs").asLong()).isGreaterThanOrEqualTo(3999);
            assertThat(readiness.path("blockers").get(0).path("details").path("sceneMs").asLong()).isEqualTo(2000);

            host.environment.put("MEDIA_DEV_COMPOSITE_MAX_SECONDS", "1");
            host.restart();
            JsonNode budget = host.ownerGet(BASE + "/m1/readiness", 200);
            assertThat(blockerCodes(budget.path("blockers"))).contains("RENDER_DURATION_BUDGET@");
            HttpResponse<String> refused = host.owner("POST", BASE + "/m1/renders", render("m-r", 1));
            assertThat(refused.statusCode()).isEqualTo(422);
            assertThat(code(refused)).isEqualTo("STORYBOARD_NOT_RENDERABLE");
            host.passed = true;
        }
    }

    /** A different, still valid file: the store refuses a second artifact with identical bytes, so tests vary the tail. */
    private static byte[] mutated(byte[] bytes) {
        return mutated(bytes, 1);
    }

    private static byte[] mutated(byte[] bytes, int salt) {
        byte[] copy = java.util.Arrays.copyOf(bytes, bytes.length + salt);
        for (int i = 0; i < salt; i++) copy[bytes.length + i] = (byte) (0x40 + i);
        return copy;
    }
}
