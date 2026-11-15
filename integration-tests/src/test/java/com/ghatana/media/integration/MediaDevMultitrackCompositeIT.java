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
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevCompositeSupport.*;
import static com.ghatana.media.integration.MediaDevLiveFixtures.JSON;
import static com.ghatana.media.integration.MediaDevLiveFixtures.sha256;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-18 outcome journey {@code media.dev.outcome-multitrack-finished-master} against REAL processes: a real launcher
 * (PostgreSQL + S3 + durable request ledger), a real rights authority and real FFmpeg. Real generated video (25 fps and
 * 30 fps, different geometry), narration with a beep marker, music, a PNG graphic and WebVTT are placed on a project
 * timeline and rendered into an H.264+AAC MP4 with muxed and burned captions, an overlay and a colour grade; every
 * assertion measures the DECODED bytes read back from S3. Faults: rights (revoked/denied/no statement), wrong tenant and
 * principal, bad timelines (typed paths), budgets (duration, output, space), cancellation (encoder killed, nothing
 * registered), a SIGKILLed launcher mid-render (orphan swept, exactly one registration on retry) and ledger replay/409.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevMultitrackCompositeIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void rendersAFinishedMasterAndMeasuresItAcrossRestartAndErasure() throws Exception {
        try (Host host = Host.start(POSTGRES, LOCALSTACK, Map.of())) {
            Media media = generate(host.work.resolve("gen"));
            Placed placed = place(host, media, true);
            HttpResponse<String> created = host.owner("POST", "/dev/v1/composite-renders", request(placed, "j18-main", "BOTH"));
            assertThat(created.statusCode()).as(created.body()).isEqualTo(201);
            JsonNode body = JSON.readTree(created.body());
            String renderId = body.path("renderId").asString();
            Path mp4 = host.work.resolve("master.mp4");
            byte[] bytes = host.artifactBytes(renderId);
            Files.write(mp4, bytes);
            assertThat(sha256(bytes)).as("checksum of the registered bytes").isEqualTo(body.path("artifact").path("sha256").asString());

            // container, codecs, exact frame count and duration
            JsonNode probe = probe(mp4);
            int video = 0, audio = 0, subtitle = 0;
            for (JsonNode stream : probe.path("streams")) {
                switch (stream.path("codec_type").asString()) {
                    case "video" -> {
                        video++;
                        assertThat(stream.path("codec_name").asString()).isEqualTo("h264");
                        assertThat(stream.path("width").asInt()).isEqualTo(W);
                        assertThat(stream.path("height").asInt()).isEqualTo(H);
                        assertThat(stream.path("r_frame_rate").asString()).isEqualTo("25/1");
                        assertThat(stream.path("nb_read_frames").asString()).as("exact frame count").isEqualTo("100");
                    }
                    case "audio" -> {
                        audio++;
                        assertThat(stream.path("codec_name").asString()).isEqualTo("aac");
                        assertThat(Double.parseDouble(stream.path("duration").asString())).isBetween(3.95, 4.05);
                    }
                    case "subtitle" -> { subtitle++; assertThat(stream.path("codec_name").asString()).isEqualTo("mov_text"); }
                    default -> { }
                }
            }
            assertThat(new int[] {video, audio, subtitle}).containsExactly(1, 1, 1);
            assertThat(Double.parseDouble(probe.path("format").path("duration").asString())).isBetween(3.99, 4.05);

            // each clip's content at its timeline position (the 30 fps 640x360 source conformed with letterbox bars)
            int[][] expected = {{5, 0, 255, 0}, {24, 0, 255, 0}, {25, 0, 0, 255}, {49, 0, 0, 255}, {50, 255, 255, 255},
                    {74, 255, 255, 255}, {75, 0, 0, 0}, {99, 0, 0, 0}};
            for (int[] e : expected) {
                assertThat(nearly(frame(mp4, e[0]), 250, 60, e[1], e[2], e[3])).as("frame " + e[0]).isTrue();
            }
            assertThat(nearly(frame(mp4, 60), 250, 5, 0, 0, 0)).as("letterbox bar").isTrue();
            // overlay pixels at the expected position and only inside its window
            assertThat(nearly(frame(mp4, 49), 30, 110, 0, 0, 255)).isTrue();
            assertThat(nearly(frame(mp4, 50), 30, 110, 255, 0, 255)).as("overlay from frame 50").isTrue();
            assertThat(nearly(frame(mp4, 99), 30, 110, 255, 0, 255)).isTrue();
            assertThat(nearly(frame(mp4, 60), 30, 144, 255, 255, 255)).as("below the graphic").isTrue();
            // audio/video sync: the beep marker (story 1.000 s) against the green to blue cut at frame 25
            double onset = beepOnsetSeconds(leftChannel(mp4));
            assertThat(Math.abs(onset - 25 / 25.0)).as("beep onset " + onset).isLessThanOrEqualTo(1.0 / FPS);
            // muxed caption timing exact
            assertThat(subtitleCues(mp4)).containsExactly("00:00:00,500 --> 00:00:01,500 Hello world",
                    "00:00:02,500 --> 00:00:03,500 Second cue");

            // lineage names every exact source; erasure follows it
            JsonNode lineage = body.path("lineage");
            List<String> sourceIds = new ArrayList<>();
            lineage.path("sources").forEach(source -> sourceIds.add(source.path("artifactId").asString()));
            assertThat(sourceIds).containsExactlyInAnyOrder(placed.a(), placed.b(), placed.narration(), placed.music(),
                    placed.graphic(), placed.vtt());
            assertThat(lineage.path("rightsDecision").asString()).contains(placed.attestations().get(placed.a()));
            assertThat(lineage.path("encoding").path("videoFrameCount").asInt()).isEqualTo(100);

            // ledger: replay is 200 with the same artifact and registers nothing; another payload is 409
            HttpResponse<String> replay = host.owner("POST", "/dev/v1/composite-renders", request(placed, "j18-main", "BOTH"));
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
            assertThat(JSON.readTree(replay.body()).path("renderId").asString()).isEqualTo(renderId);
            assertThat(host.renderRows("j18-main")).isEqualTo(1);
            Map<String, Object> changed = request(placed, "j18-main", "BOTH");
            changed.put("color", Map.of("brightness", 0.1));
            HttpResponse<String> reuse = host.owner("POST", "/dev/v1/composite-renders", changed);
            assertThat(reuse.statusCode()).as(reuse.body()).isEqualTo(409);
            assertThat(reuse.body()).contains("REQUEST_ID_REUSED");

            // restart: readback and replay survive; no duplicate registered
            host.restart();
            JsonNode reopened = host.ownerGet("/dev/v1/composite-renders/" + renderId, 200);
            assertThat(reopened.path("artifact").path("sha256").asString()).isEqualTo(body.path("artifact").path("sha256").asString());
            assertThat(reopened.path("lineage").path("sources")).hasSize(6);
            assertThat(host.owner("POST", "/dev/v1/composite-renders", request(placed, "j18-main", "BOTH")).statusCode()).isEqualTo(200);
            assertThat(host.renderRows("j18-main")).isEqualTo(1);
            assertThat(host.other("GET", "/dev/v1/composite-renders/" + renderId, null).statusCode()).isEqualTo(404);
            assertThat(host.foreignTenant("GET", "/dev/v1/composite-renders/" + renderId, null).statusCode()).isEqualTo(404);

            // erasure follows sources[]: erasing the narration erases the finished master
            JsonNode plan = host.ownerGet("/dev/v1/erasure-plans/" + placed.narration(), 200);
            Map<String, String> kinds = new java.util.TreeMap<>();
            for (JsonNode node : plan.path("artifacts")) kinds.put(node.path("artifactId").asString(), node.path("kind").asString());
            assertThat(kinds).containsEntry(renderId, "RENDER");
            HttpResponse<String> erased = host.owner("POST", "/dev/v1/erasures", Map.of("erasureId", "j18-erase-" + host.run,
                    "artifactId", placed.narration(), "confirm", true));
            assertThat(erased.statusCode()).as(erased.body()).isEqualTo(201);
            assertThat(host.owner("GET", "/dev/v1/composite-renders/" + renderId, null).statusCode()).as("the master went with its source")
                    .isEqualTo(404);
            assertThat(host.renderRows("j18-main")).isZero();
            host.passed = true;
        }
    }

    @Test
    void refusesRightsTenantTimelineBudgetAndCancellationFaultsWithTypedOutcomes() throws Exception {
        try (Host host = Host.start(POSTGRES, LOCALSTACK, Map.of("MEDIA_DEV_COMPOSITE_X264_PRESET", "slower"))) {
            Media media = generate(host.work.resolve("gen"));
            Placed placed = place(host, media, true);
            String path = "/dev/v1/composite-renders";

            // wrong tenant / principal / permission
            assertThat(host.foreignTenant("POST", path, request(placed, "f-tenant", "BOTH")).statusCode()).isEqualTo(404);
            assertThat(host.other("POST", path, request(placed, "f-other", "BOTH")).statusCode()).isEqualTo(403);

            // bad timeline: typed path (use the unattested-free project by re-attesting is not needed: the plan is checked first)
            String head = edit(host, placed.projectId(), placed.revisionId(), List.of(
                    clip("c-trim", "video-main", placed.a(), media.videoA(), 3000, 5000, 4000, 2000)));
            HttpResponse<String> trim = host.owner("POST", path, withRevision(request(placed, "f-trim", "BOTH"), head));
            assertThat(trim.statusCode()).as(trim.body()).isEqualTo(422);
            assertThat(trim.body()).contains("TRIM_OUT_OF_RANGE").contains("timeline.clips[c-trim].sourceOut");
            head = edit(host, placed.projectId(), head, List.of(Map.of("type", "removeClip", "clipId", "c-trim"),
                    clip("c-ov", "video-main", placed.a(), media.videoA(), 0, 1000, 480, 1000)));
            HttpResponse<String> overlap = host.owner("POST", path, withRevision(request(placed, "f-overlap", "BOTH"), head));
            assertThat(overlap.statusCode()).as(overlap.body()).isEqualTo(422);
            assertThat(overlap.body()).contains("TIMELINE_OVERLAP").contains("timeline.clips[c-ov].storyStart");
            head = edit(host, placed.projectId(), head, List.of(Map.of("type", "removeClip", "clipId", "c-ov"),
                    clip("c-gap", "video-main", placed.a(), media.videoA(), 0, 1000, 4480, 1000)));
            HttpResponse<String> gap = host.owner("POST", path, withRevision(request(placed, "f-gap", "BOTH"), head));
            assertThat(gap.statusCode()).as(gap.body()).isEqualTo(422);
            assertThat(gap.body()).contains("TIMELINE_GAP").contains("timeline.clips[c-gap].storyStart");

            // output budget: the encoder is stopped when the file exceeds the request's byte budget
            Map<String, Object> tiny = request(placed, "f-size", "BOTH");
            tiny.put("maxOutputBytes", 4_000);
            tiny.put("width", 640);
            tiny.put("height", 360);
            tiny.put("overlays", List.of(Map.of("clipId", "ov-1", "x", 20, "y", 100)));
            HttpResponse<String> size = host.owner("POST", path, tiny);
            assertThat(size.statusCode()).as(size.body()).isEqualTo(422);
            assertThat(size.body()).contains("RENDER_OUTPUT_BUDGET_EXCEEDED");
            assertThat(host.renderRows("f-size")).isZero();
            assertThat(host.workDirectories()).as("nothing left behind").isEmpty();

            // duration and space budgets (server limits)
            host.environment.put("MEDIA_DEV_COMPOSITE_MAX_SECONDS", "2");
            host.restart();
            HttpResponse<String> duration = host.owner("POST", path, request(placed, "f-duration", "BOTH"));
            assertThat(duration.statusCode()).as(duration.body()).isEqualTo(422);
            assertThat(duration.body()).contains("RENDER_DURATION_BUDGET");
            host.environment.remove("MEDIA_DEV_COMPOSITE_MAX_SECONDS");
            host.environment.put("MEDIA_DEV_COMPOSITE_SPACE_RESERVE_BYTES", Long.toString(1L << 49));
            host.restart();
            HttpResponse<String> space = host.owner("POST", path, request(placed, "f-space", "BOTH"));
            assertThat(space.statusCode()).as(space.body()).isEqualTo(422);
            assertThat(space.body()).contains("RENDER_SPACE_BUDGET");
            host.environment.remove("MEDIA_DEV_COMPOSITE_SPACE_RESERVE_BYTES");
            host.restart();
            assertThat(host.workDirectories()).isEmpty();

            // cancellation mid-render: the encoder is killed, nothing is registered, the retry registers exactly once
            Map<String, Object> slow = request(placed, "f-cancel", "BOTH");
            slow.put("width", 1280);
            slow.put("height", 720);
            CompletableFuture<HttpResponse<String>> pending = CompletableFuture.supplyAsync(() -> {
                try { return host.owner("POST", path, slow); } catch (Exception failure) { throw new IllegalStateException(failure); }
            });
            awaitEncoder(host);
            assertThat(host.other("POST", path + "/f-cancel/cancel", Map.of()).statusCode()).as("not the requester").isEqualTo(404);
            assertThat(host.owner("POST", path + "/f-cancel/cancel", Map.of()).statusCode()).isEqualTo(200);
            HttpResponse<String> cancelled = pending.get(60, TimeUnit.SECONDS);
            assertThat(cancelled.statusCode()).as(cancelled.body()).isEqualTo(409);
            assertThat(cancelled.body()).contains("RENDER_CANCELLED");
            assertThat(host.encoders()).as("ffmpeg was killed").isEmpty();
            assertThat(host.workDirectories()).as("work directory removed").isEmpty();
            assertThat(host.renderRows("f-cancel")).isZero();
            HttpResponse<String> retry = host.owner("POST", path, slow);
            assertThat(retry.statusCode()).as(retry.body()).isEqualTo(201);
            assertThat(host.renderRows("f-cancel")).isEqualTo(1);
            assertThat(host.owner("POST", path, slow).statusCode()).isEqualTo(200);
            assertThat(host.renderRows("f-cancel")).isEqualTo(1);

            // rights: a source with no statement at all is refused (403), a revoked one too, a replay included
            String vtt2 = host.upload("other-cues.vtt", "text/vtt", "WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nNo statement\n"
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8));
            byte[] vtt2Bytes = "WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nNo statement\n".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            String swapped = edit(host, placed.projectId(), head, List.of(Map.of("type", "removeClip", "clipId", "c-gap"),
                    clip("cap-1", "caption-main", vtt2, vtt2Bytes, 0, 4000, 0, 4000)));
            HttpResponse<String> unattested = host.owner("POST", path, withRevision(request(placed, "f-nostatement", "BOTH"), swapped));
            assertThat(unattested.statusCode()).as(unattested.body()).isEqualTo(403);
            assertThat(unattested.body()).contains("RIGHTS_DECISION_DENIED").contains(vtt2);
            assertThat(host.renderRows("f-nostatement")).isZero();
            host.ownerPost("/dev/v1/rights/attestations/" + placed.attestations().get(placed.narration()) + "/revoke",
                    Map.of("reason", "TEST: revoked"), 200);
            for (Map<String, Object> attempt : List.of(request(placed, "f-rights", "BOTH"), slow)) {
                HttpResponse<String> revoked = host.owner("POST", path, attempt);
                assertThat(revoked.statusCode()).as(attempt.get("requestId") + " " + revoked.body()).isEqualTo(403);
                assertThat(revoked.body()).contains("RIGHTS_DECISION_REVOKED").contains(placed.narration());
            }
            host.passed = true;
        }
    }

    @Test
    void aKilledLauncherMidRenderLeavesNothingAndTheRetryRegistersExactlyOnce() throws Exception {
        try (Host host = Host.start(POSTGRES, LOCALSTACK, Map.of("MEDIA_DEV_COMPOSITE_X264_PRESET", "slower"))) {
            Media media = generate(host.work.resolve("gen"));
            Placed placed = place(host, media, true);
            String path = "/dev/v1/composite-renders";
            Map<String, Object> slow = request(placed, "k-main", "BOTH");
            slow.put("width", 1280);
            slow.put("height", 720);
            CompletableFuture<HttpResponse<String>> pending = CompletableFuture.supplyAsync(() -> {
                try { return host.owner("POST", path, slow); } catch (Exception failure) { return null; }
            });
            awaitEncoder(host);
            Thread.sleep(500);
            host.kill();
            assertThat(pending.get(60, TimeUnit.SECONDS)).as("the caller never got a response").isNull();
            assertThat(host.renderRows("k-main")).as("nothing was registered by the killed run").isZero();

            host.restartAfterKill();
            assertThat(host.encoders()).as("the orphaned encoder was swept at start").isEmpty();
            assertThat(host.workDirectories()).as("the orphaned work directory was swept at start").isEmpty();
            HttpResponse<String> retry = host.owner("POST", path, slow);
            assertThat(retry.statusCode()).as(retry.body()).isEqualTo(201);
            assertThat(host.renderRows("k-main")).as("exactly once after the retry").isEqualTo(1);
            JsonNode first = JSON.readTree(retry.body());
            HttpResponse<String> again = host.owner("POST", path, slow);
            assertThat(again.statusCode()).isEqualTo(200);
            assertThat(JSON.readTree(again.body()).path("renderId").asString()).isEqualTo(first.path("renderId").asString());
            assertThat(host.renderRows("k-main")).isEqualTo(1);
            Path mp4 = host.work.resolve("retried.mp4");
            Files.write(mp4, host.artifactBytes(first.path("renderId").asString()));
            assertThat(probe(mp4).path("streams").get(0).path("nb_read_frames").asString()).isEqualTo("100");
            host.passed = true;
        }
    }

    private static Map<String, Object> withRevision(Map<String, Object> request, String revisionId) {
        request.put("revisionId", revisionId);
        return request;
    }

    private static void awaitEncoder(Host host) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(90);
        while (System.nanoTime() < deadline) {
            if (!host.encoders().isEmpty()) return;
            Thread.sleep(50);
        }
        throw new AssertionError("no running encoder was observed");
    }
}
