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

import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-03 outcome journey {@code media.dev.outcome-transcript-to-reviewed-captions}, end to end against REAL processes:
 * a real launcher process (PostgreSQL + S3), the real whisper.cpp large-v3-turbo model, a real rights authority and a
 * real review engine. Real input is whisper.cpp's bundled {@code samples/jfk.wav} (MIT repository; a US government
 * public-domain speech). Principals are clearly synthetic test principals; the rights statements are statements by
 * those test principals, not a legal determination, and no decision here is a human approval.
 *
 * <p>Journey: audio -> rights attestation -> Whisper transcript revision (transcript + unreviewed WebVTT) -> human
 * correction as a NEW caption version (optimistic concurrency, lineage) -> owner opens a review and assigns a different
 * reviewer -> reviewer accepts the exact version -> only that exact version renders into an MP4 (subtitle stream read
 * back) -> launcher restart -> everything reads back. Faults: rights revoked before transcription, rights revoked
 * between versions and after review, the Whisper worker process killed mid-run (OUTCOME UNKNOWN, never success, retry
 * idempotent by requestId), stale expected version, forked correction, unauthorized corrector, unreviewed version.</p>
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevCaptionJourneyIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private static final Path MODEL_ROOT = Path.of(System.getProperty("user.home"), ".local", "share", "ghatana-media");
    private static final Path JFK = MODEL_ROOT.resolve("runtimes/whisper.cpp-src/samples/jfk.wav");
    private static final String JFK_SHA256 = "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e";
    private static final String PROVENANCE = "TEST: whisper.cpp samples/jfk.wav (MIT-licensed repository; a US "
            + "government public-domain speech) used by an automated test; a statement by a synthetic test principal, "
            + "not a legal determination";

    // ---- the whole journey ----

    @Test
    void realAudioBecomesAReviewedHumanCorrectedCaptionThatRendersOnlyAsTheReviewedExactVersion() throws Exception {
        try (Live live = Live.start("journey", true)) {
            byte[] audio = Files.readAllBytes(JFK);
            assertThat(sha256(audio)).as("the real input is the pinned jfk.wav").isEqualTo(JFK_SHA256);
            String audioId = live.upload("jfk.wav", "audio/wav", audio);
            String audioVersion = "sha256:" + JFK_SHA256;
            Map<String, Object> transcribe = Map.of("requestId", "stt-" + live.run, "artifactId", audioId,
                    "artifactVersionId", audioVersion, "language", "en");

            // 1. No rights statement: refused with nothing registered (only the uploaded audio exists).
            HttpResponse<String> unattested = live.owner("POST", "/dev/v1/speech/transcriptions", transcribe);
            assertThat(unattested.statusCode()).as(unattested.body()).isEqualTo(403);
            assertThat(unattested.body()).contains("RIGHTS_DECISION_DENIED");
            assertThat(live.artifactCounts()).containsOnlyKeys("audio/wav");

            // 2. A real attestation by the test owner; then real Whisper transcribes the exact audio version.
            String attestationId = live.attest(audioId, audioVersion);
            long started = System.nanoTime();
            JsonNode stt = live.ownerPost("/dev/v1/speech/transcriptions", transcribe, 201);
            long sttMillis = (System.nanoTime() - started) / 1_000_000;
            String machineText = stt.path("text").asString();
            System.out.println("J03_REAL_WHISPER_TRANSCRIPT millis=" + sttMillis + " text=\"" + machineText + "\"");
            assertThat(normalize(machineText)).contains("ask not what your country can do for you");
            assertThat(stt.path("transcript").path("lineage").path("rightsDecision").asString()).contains(attestationId);
            String machineId = stt.path("captions").path("artifact").path("artifactId").asString();
            String machineVersion = stt.path("captions").path("artifact").path("artifactVersionId").asString();
            assertThat(stt.path("captions").path("lineage").path("kind").asString())
                    .isEqualTo("LOCAL_STT_WEBVTT_UNREVIEWED");
            assertThat(live.artifactCounts()).containsEntry("text/vtt", 1).containsEntry("application/json", 1);

            JsonNode machine = live.ownerGet("/dev/v1/captions/" + machineId, 200);
            assertThat(machine.path("kind").asString()).isEqualTo("LOCAL_STT_WEBVTT_UNREVIEWED");
            assertThat(machine.path("review").path("acceptedByAssignedReviewer").asBoolean()).isFalse();
            List<Map<String, Object>> corrected = correctedCues(machine);

            // 3. Faults on the correction: wrong principal, missing permission, assigned-reviewer principal, stale
            //    expected version. Each refused with nothing registered.
            Map<String, Object> correction = correction("corr-1-" + live.run, machineId, machineVersion, corrected);
            HttpResponse<String> foreign = live.send(live.otherToken(), "POST", "/dev/v1/captions/corrections", correction);
            assertThat(foreign.statusCode()).as(foreign.body()).isEqualTo(404);
            assertThat(foreign.body()).doesNotContain("fellow Americans");
            assertThat(live.send(live.otherToken(), "GET", "/dev/v1/captions/" + machineId, null).statusCode()).isEqualTo(404);
            HttpResponse<String> reviewerAttempt = live.send(live.reviewerToken(), "POST",
                    "/dev/v1/captions/corrections", correction);
            assertThat(reviewerAttempt.statusCode()).as(reviewerAttempt.body()).isEqualTo(404);
            HttpResponse<String> readOnly = live.send(live.readOnlyToken(), "POST", "/dev/v1/captions/corrections", correction);
            assertThat(readOnly.statusCode()).as(readOnly.body()).isEqualTo(403);
            HttpResponse<String> stale = live.owner("POST", "/dev/v1/captions/corrections",
                    correction("corr-stale-" + live.run, machineId, "sha256:" + "0".repeat(64), corrected));
            assertThat(stale.statusCode()).as(stale.body()).isEqualTo(409);
            assertThat(stale.body()).contains("CAPTION_VERSION_CONFLICT").contains(machineVersion);
            assertThat(live.artifactCounts()).as("refused corrections registered nothing").containsEntry("text/vtt", 1);

            // 4. The correction: a NEW version with lineage; the machine version is untouched.
            JsonNode created = live.ownerPost("/dev/v1/captions/corrections", correction, 201);
            String correctedId = created.path("captionId").asString();
            String correctedVersion = created.path("artifact").path("artifactVersionId").asString();
            assertThat(correctedId).isNotEqualTo(machineId);
            JsonNode lineage = created.path("lineage");
            assertThat(lineage.path("kind").asString()).isEqualTo("LOCAL_CAPTION_USER_CORRECTED");
            assertThat(lineage.path("parent").path("artifactId").asString()).isEqualTo(machineId);
            assertThat(lineage.path("parent").path("artifactVersionId").asString()).isEqualTo(machineVersion);
            assertThat(lineage.path("machineVersion").path("artifactId").asString()).isEqualTo(machineId);
            assertThat(lineage.path("correctedByPrincipalId").asString()).isEqualTo(live.owner);
            assertThat(lineage.path("source").path("artifactVersionId").asString()).isEqualTo(audioVersion);
            assertThat(lineage.path("rightsDecision").asString()).contains(attestationId);
            assertThat(lineage.path("edit").path("textChanged").asInt()).isGreaterThan(0);
            assertThat(created.path("review").path("acceptedByAssignedReviewer").asBoolean()).isFalse();
            assertThat(live.artifactCounts()).containsEntry("text/vtt", 2);
            assertThat(live.ownerGet("/dev/v1/captions/" + machineId, 200).path("artifact").path("sha256").asString())
                    .as("the machine version is byte-identical").isEqualTo(machineVersion.substring("sha256:".length()));

            // Idempotency and no fork: same request replays; another correction of the same parent conflicts.
            JsonNode replay = live.ownerPost("/dev/v1/captions/corrections", correction, 200);
            assertThat(replay.path("captionId").asString()).isEqualTo(correctedId);
            assertThat(replay.path("replayed").asBoolean()).isTrue();
            HttpResponse<String> fork = live.owner("POST", "/dev/v1/captions/corrections",
                    correction("corr-fork-" + live.run, machineId, machineVersion, tweak(corrected, " (fork)")));
            assertThat(fork.statusCode()).as(fork.body()).isEqualTo(409);
            assertThat(live.artifactCounts()).containsEntry("text/vtt", 2);

            // 5. Mid-journey launcher restart: the corrected version, its lineage and the replay read back.
            live.restart();
            JsonNode reread = live.ownerGet("/dev/v1/captions/" + correctedId, 200);
            assertThat(reread.path("lineage")).isEqualTo(created.path("lineage"));
            assertThat(reread.path("cues")).isEqualTo(created.path("cues"));
            assertThat(live.ownerPost("/dev/v1/captions/corrections", correction, 200)
                    .path("captionId").asString()).isEqualTo(correctedId);
            assertThat(live.artifactCounts()).containsEntry("text/vtt", 2);

            // 6. Timeline with the corrected version, still unreviewed: a render is refused. So is the machine one.
            Timeline timeline = live.timeline(machineId, machineVersion);
            HttpResponse<String> machineRender = live.render(timeline, "render-machine-" + live.run);
            assertThat(machineRender.statusCode()).as(machineRender.body()).isEqualTo(422);
            assertThat(machineRender.body()).contains("CAPTION_NOT_REVIEWED");
            timeline.useCaption(live, correctedId, correctedVersion);
            HttpResponse<String> unreviewed = live.render(timeline, "render-unreviewed-" + live.run);
            assertThat(unreviewed.statusCode()).as(unreviewed.body()).isEqualTo(422);
            assertThat(unreviewed.body()).contains("CAPTION_NOT_REVIEWED");
            assertThat(live.artifactCounts()).as("refused renders registered nothing").doesNotContainKey("video/mp4");

            // 7. Review: the owner opens a case on the exact corrected version and assigns a different reviewer.
            JsonNode opened = live.ownerPost("/dev/v1/reviews", Map.of("subject", Map.of("kind", "ARTIFACT_VERSION",
                    "artifactId", correctedId, "artifactVersionId", correctedVersion)), 201);
            String caseId = opened.path("reviewCaseId").asString();
            live.ownerPost("/dev/v1/reviews/" + caseId + "/assignments", Map.of("requestId", "assign-" + live.run,
                    "expectedCaseRevision", 0, "reviewerPrincipalId", live.reviewer, "scopes", List.of("QUALITY"),
                    "expiresAt", java.time.Instant.now().plus(java.time.Duration.ofMinutes(25)).toString()), 201);
            // The owner may not decide, and an unrelated principal may not either.
            HttpResponse<String> ownerDecides = live.owner("POST", "/dev/v1/reviews/" + caseId + "/decisions",
                    decision("owner-" + live.run, "ACCEPT"));
            assertThat(ownerDecides.statusCode()).as(ownerDecides.body()).isEqualTo(403);
            assertThat(live.send(live.otherToken(), "POST", "/dev/v1/reviews/" + caseId + "/decisions",
                    decision("other-" + live.run, "ACCEPT")).statusCode()).isIn(403, 404);
            assertThat(live.render(timeline, "render-still-unreviewed-" + live.run).statusCode()).isEqualTo(422);
            JsonNode accepted = live.post(live.reviewerToken(), "/dev/v1/reviews/" + caseId + "/decisions",
                    decision("accept-" + live.run, "ACCEPT"), 201);
            assertThat(accepted.path("establishesApproval").asBoolean()).isFalse();
            JsonNode reviewed = live.ownerGet("/dev/v1/captions/" + correctedId, 200);
            assertThat(reviewed.path("review").path("acceptedByAssignedReviewer").asBoolean()).isTrue();
            assertThat(reviewed.path("review").path("establishesApproval").asBoolean()).isFalse();

            // 8. Only the reviewed exact version renders; the subtitle stream carries the corrected text.
            HttpResponse<String> rendered = live.render(timeline, "render-reviewed-" + live.run);
            assertThat(rendered.statusCode()).as(rendered.body()).isEqualTo(201);
            JsonNode render = JSON.readTree(rendered.body());
            String renderedHead = timeline.head;
            String renderId = render.path("renderId").asString();
            assertThat(render.path("artifact").path("contentType").asString()).isEqualTo("video/mp4");
            JsonNode captionSource = null;
            for (JsonNode source : render.path("lineage").path("sources")) {
                if ("CAPTION".equals(source.path("trackKind").asString())) captionSource = source;
            }
            assertThat(captionSource).isNotNull();
            assertThat(captionSource.path("artifactId").asString()).isEqualTo(correctedId);
            assertThat(captionSource.path("artifactVersionId").asString()).isEqualTo(correctedVersion);
            String subtitleText = live.subtitleText(renderId);
            System.out.println("J03_RENDERED_SUBTITLES=" + subtitleText.replace('\n', '|'));
            for (Map<String, Object> cue : corrected) {
                assertThat(normalize(subtitleText)).contains(normalize((String) cue.get("text")));
            }
            assertThat(live.artifactCounts()).containsEntry("video/mp4", 1);

            // 9. A further correction makes a new, unreviewed version: the reviewed version stays accepted and
            //    usable, the new one is not (review binds the exact version, never "latest").
            JsonNode next = live.ownerPost("/dev/v1/captions/corrections", correction("corr-2-" + live.run, correctedId,
                    correctedVersion, tweak(corrected, " (second pass)")), 201);
            assertThat(next.path("lineage").path("correctionNumber").asInt()).isEqualTo(2);
            assertThat(next.path("lineage").path("machineVersion").path("artifactId").asString()).isEqualTo(machineId);
            assertThat(next.path("review").path("acceptedByAssignedReviewer").asBoolean()).isFalse();
            assertThat(live.ownerGet("/dev/v1/captions/" + correctedId, 200).path("review")
                    .path("acceptedByAssignedReviewer").asBoolean()).isTrue();
            timeline.useCaption(live, next.path("captionId").asString(), next.path("artifact").path("artifactVersionId").asString());
            assertThat(live.render(timeline, "render-second-pass-" + live.run).statusCode()).isEqualTo(422);
            timeline.useCaption(live, correctedId, correctedVersion);

            // 10. Restart again: review, render and lineage read back; the render replay stays one artifact.
            live.restart();
            JsonNode afterRestart = live.ownerGet("/dev/v1/captions/" + correctedId, 200);
            assertThat(afterRestart.path("review").path("acceptedByAssignedReviewer").asBoolean()).isTrue();
            assertThat(afterRestart.path("lineage").path("parent").path("artifactId").asString()).isEqualTo(machineId);
            JsonNode reviewCase = live.ownerGet("/dev/v1/reviews/" + caseId, 200);
            assertThat(reviewCase.path("reviewState").path("status").asString())
                    .isEqualTo("DEV_ASSIGNED_REVIEWER_ACCEPT_CURRENT");
            assertThat(reviewCase.path("reviewState").path("humanReviewApproval").asBoolean()).isFalse();
            JsonNode rerender = live.get(live.ownerToken(), "/dev/v1/projects/" + timeline.projectId + "/renders/" + renderId, 200);
            assertThat(rerender.path("artifact").path("sha256").asString())
                    .isEqualTo(render.path("artifact").path("sha256").asString());
            HttpResponse<String> replayRender = live.render(timeline, "render-reviewed-" + live.run, renderedHead);
            assertThat(replayRender.statusCode()).as(replayRender.body()).isEqualTo(200);
            assertThat(live.artifactCounts()).containsEntry("video/mp4", 1);

            // 11. Revoking the rights AFTER review withdraws use: a fresh render of the reviewed version is refused,
            //     a correction is refused, and the withdrawal survives a restart.
            live.ownerPost("/dev/v1/rights/attestations/" + attestationId + "/revoke", Map.of("reason", "TEST: revoked"), 200);
            HttpResponse<String> revokedUse = live.render(timeline, "render-after-revoke-" + live.run);
            assertThat(revokedUse.statusCode()).as(revokedUse.body()).isEqualTo(422);
            assertThat(revokedUse.body()).contains("CAPTION_RIGHTS_NOT_ADMITTED");
            HttpResponse<String> revokedCorrection = live.owner("POST", "/dev/v1/captions/corrections", correction(
                    "corr-after-revoke-" + live.run, next.path("captionId").asString(),
                    next.path("artifact").path("artifactVersionId").asString(), tweak(corrected, " (after revoke)")));
            assertThat(revokedCorrection.statusCode()).as(revokedCorrection.body()).isEqualTo(403);
            assertThat(revokedCorrection.body()).contains("RIGHTS_DECISION_REVOKED");
            live.restart();
            assertThat(live.render(timeline, "render-after-revoke-restart-" + live.run).statusCode()).isEqualTo(422);
            assertThat(live.artifactCounts()).containsEntry("text/vtt", 3).containsEntry("video/mp4", 1);
        }
    }

    // ---- faults with their own real processes ----

    @Test
    void revokedRightsBeforeTranscriptionAreRefusedWithNoEffectAcrossRestart() throws Exception {
        try (Live live = Live.start("revoked-before", false)) {
            byte[] audio = trim(Files.readAllBytes(JFK), 5);
            String audioId = live.upload("jfk-5s.wav", "audio/wav", audio);
            String version = "sha256:" + sha256(audio);
            String attestationId = live.attest(audioId, version);
            live.ownerPost("/dev/v1/rights/attestations/" + attestationId + "/revoke", Map.of("reason", "TEST: revoked first"), 200);
            Map<String, Object> request = Map.of("requestId", "stt-revoked-" + live.run, "artifactId", audioId,
                    "artifactVersionId", version, "language", "en");
            HttpResponse<String> refused = live.owner("POST", "/dev/v1/speech/transcriptions", request);
            assertThat(refused.statusCode()).as(refused.body()).isEqualTo(403);
            assertThat(refused.body()).contains("RIGHTS_DECISION_REVOKED");
            assertThat(live.artifactCounts()).as("no transcript, no WebVTT, nothing but the audio")
                    .containsOnlyKeys("audio/wav");
            live.restart();
            HttpResponse<String> after = live.owner("POST", "/dev/v1/speech/transcriptions", request);
            assertThat(after.statusCode()).as(after.body()).isEqualTo(403);
            assertThat(after.body()).contains("RIGHTS_DECISION_REVOKED");
            assertThat(live.artifactCounts()).containsOnlyKeys("audio/wav");
        }
    }

    @Test
    void rightsRevokedBetweenTheMachineAndTheCorrectedVersionRefuseTheCorrectionAcrossRestart() throws Exception {
        try (Live live = Live.start("revoked-between", false)) {
            byte[] audio = trim(Files.readAllBytes(JFK), 6);
            String audioId = live.upload("jfk-6s.wav", "audio/wav", audio);
            String version = "sha256:" + sha256(audio);
            String attestationId = live.attest(audioId, version);
            JsonNode stt = live.ownerPost("/dev/v1/speech/transcriptions", Map.of("requestId", "stt-between-" + live.run,
                    "artifactId", audioId, "artifactVersionId", version, "language", "en"), 201);
            String machineId = stt.path("captions").path("artifact").path("artifactId").asString();
            String machineVersion = stt.path("captions").path("artifact").path("artifactVersionId").asString();
            JsonNode machine = live.ownerGet("/dev/v1/captions/" + machineId, 200);
            live.ownerPost("/dev/v1/rights/attestations/" + attestationId + "/revoke", Map.of("reason", "TEST: revoked between"), 200);
            Map<String, Object> request = correction("corr-between-" + live.run, machineId, machineVersion, correctedCues(machine));
            HttpResponse<String> refused = live.owner("POST", "/dev/v1/captions/corrections", request);
            assertThat(refused.statusCode()).as(refused.body()).isEqualTo(403);
            assertThat(refused.body()).contains("RIGHTS_DECISION_REVOKED");
            assertThat(live.artifactCounts()).containsEntry("text/vtt", 1);
            live.restart();
            HttpResponse<String> after = live.owner("POST", "/dev/v1/captions/corrections", request);
            assertThat(after.statusCode()).as(after.body()).isEqualTo(403);
            assertThat(live.artifactCounts()).containsEntry("text/vtt", 1);
            // The machine version itself still reads back (immutable, owner-visible), unreviewed.
            assertThat(live.ownerGet("/dev/v1/captions/" + machineId, 200).path("kind").asString())
                    .isEqualTo("LOCAL_STT_WEBVTT_UNREVIEWED");
        }
    }

    @Test
    void killedWhisperWorkerIsReportedUnknownNeverSuccessAndTheRetryIsIdempotentByRequestId() throws Exception {
        try (Live live = Live.start("unknown", false)) {
            byte[] audio = Files.readAllBytes(JFK);
            String audioId = live.upload("jfk.wav", "audio/wav", audio);
            String version = "sha256:" + JFK_SHA256;
            live.attest(audioId, version);
            Map<String, Object> request = Map.of("requestId", "stt-unknown-" + live.run, "artifactId", audioId,
                    "artifactVersionId", version, "language", "en");

            // SIGKILL the real whisper-cli worker (a descendant of THIS launcher only) as soon as it appears.
            AtomicBoolean killed = new AtomicBoolean();
            AtomicBoolean stop = new AtomicBoolean();
            Thread killer = new Thread(() -> {
                while (!stop.get() && !killed.get()) {
                    live.launcher.toHandle().descendants()
                            .filter(handle -> handle.info().command().map(c -> c.endsWith("whisper-cli")).orElse(false))
                            .findFirst().ifPresent(worker -> { worker.destroyForcibly(); killed.set(true); });
                    try { Thread.sleep(5); } catch (InterruptedException interrupted) { return; }
                }
            }, "j03-whisper-killer");
            killer.setDaemon(true);
            killer.start();
            HttpResponse<String> unknown;
            try {
                unknown = live.owner("POST", "/dev/v1/speech/transcriptions", request);
            } finally {
                stop.set(true);
            }
            assertThat(killed.get()).as("a real whisper-cli worker process was killed mid-run").isTrue();
            assertThat(unknown.statusCode()).as(unknown.body()).isEqualTo(503);
            assertThat(unknown.body()).contains("SPEECH_OUTCOME_UNKNOWN").contains("\"retrySafe\":true")
                    .doesNotContain("\"transcript\"");
            assertThat(live.artifactCounts()).as("UNKNOWN registered nothing: no transcript, no WebVTT")
                    .containsOnlyKeys("audio/wav");

            // Retry with the SAME requestId: real Whisper completes, registered exactly once.
            JsonNode retried = live.ownerPost("/dev/v1/speech/transcriptions", request, 201);
            assertThat(normalize(retried.path("text").asString())).contains("ask not what your country can do for you");
            assertThat(live.artifactCounts()).containsEntry("text/vtt", 1).containsEntry("application/json", 1);
            // A further retry (also across a restart) re-runs the recognizer and registers through the same idempotency
            // key. The host never registers a second output: it replays the first (HTTP 200) when the recognizer output
            // is byte-identical, and refuses with 409 SPEECH_REQUEST_ID_REUSED when real Whisper produced different
            // bytes (observed intermittently under GPU contention on this host). Either way the first outputs remain.
            String firstTranscript = retried.path("transcript").path("artifact").path("artifactId").asString();
            for (int attempt = 0; attempt < 2; attempt++) {
                if (attempt == 1) live.restart();
                HttpResponse<String> again = live.owner("POST", "/dev/v1/speech/transcriptions", request);
                System.out.println("J03_RETRY_AFTER_SUCCESS attempt=" + attempt + " status=" + again.statusCode());
                assertThat(again.statusCode()).as(again.body()).isIn(200, 409);
                if (again.statusCode() == 200) {
                    JsonNode replay = JSON.readTree(again.body());
                    assertThat(replay.path("replayed").asBoolean()).isTrue();
                    assertThat(replay.path("transcript").path("artifact").path("artifactId").asString()).isEqualTo(firstTranscript);
                } else {
                    assertThat(again.body()).contains("SPEECH_REQUEST_ID_REUSED");
                }
                assertThat(live.artifactCounts()).containsEntry("text/vtt", 1).containsEntry("application/json", 1);
                assertThat(live.ownerGet("/dev/v1/speech/outputs/" + firstTranscript, 200).path("lineage").path("requestId")
                        .asString()).isEqualTo("stt-unknown-" + live.run);
            }
            // The same requestId for a different request is a conflict, never a second output.
            byte[] other = trim(audio, 4);
            String otherId = live.upload("jfk-4s.wav", "audio/wav", other);
            live.attest(otherId, "sha256:" + sha256(other));
            HttpResponse<String> reused = live.owner("POST", "/dev/v1/speech/transcriptions", Map.of(
                    "requestId", "stt-unknown-" + live.run, "artifactId", otherId,
                    "artifactVersionId", "sha256:" + sha256(other), "language", "en"));
            assertThat(reused.statusCode()).as(reused.body()).isEqualTo(409);
            assertThat(live.artifactCounts()).containsEntry("text/vtt", 1);
        }
    }

    // ---- helpers ----

    private static String normalize(String text) {
        return text.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9 ]", " ").replaceAll("\\s+", " ").trim();
    }

    /** A human-style edit on top of the machine cues: punctuate, never invent timing. */
    private static List<Map<String, Object>> correctedCues(JsonNode machine) {
        List<Map<String, Object>> cues = new ArrayList<>();
        for (JsonNode cue : machine.path("cues")) {
            String text = cue.path("text").asString().strip()
                    .replace("And so my fellow Americans", "And so, my fellow Americans")
                    .replace("for you, ask", "for you; ask").replace("for you ask", "for you; ask");
            if (!text.endsWith(".") && !text.endsWith(",") && !text.endsWith(";")) text = text + " [TEST human-reviewed edit]";
            cues.add(Map.of("startMillis", cue.path("startMillis").asLong(), "endMillis", cue.path("endMillis").asLong(),
                    "text", text));
        }
        assertThat(cues).isNotEmpty();
        return cues;
    }

    private static List<Map<String, Object>> tweak(List<Map<String, Object>> cues, String suffix) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (int i = 0; i < cues.size(); i++) {
            Map<String, Object> cue = new HashMap<>(cues.get(i));
            if (i == cues.size() - 1) cue.put("text", cue.get("text") + suffix);
            out.add(cue);
        }
        return out;
    }

    private static Map<String, Object> correction(String requestId, String artifactId, String version,
                                                  List<Map<String, Object>> cues) {
        return Map.of("requestId", requestId, "baseArtifactId", artifactId, "expectedVersionId", version, "cues", cues);
    }

    private static Map<String, Object> decision(String requestId, String decision) {
        return Map.of("requestId", requestId, "expectedCaseRevision", 0, "decision", decision,
                "reason", "TEST: DEV_ONLY assigned-reviewer decision on the exact corrected caption version",
                "scope", "QUALITY", "confirmed", true);
    }

    /** Keeps the first {@code seconds} of a 16 kHz mono PCM16 WAV (rewrites the header; drops other chunks). */
    private static byte[] trim(byte[] wav, int seconds) {
        int dataAt = -1;
        for (int i = 12; i + 8 < wav.length; ) {
            String id = new String(wav, i, 4, StandardCharsets.US_ASCII);
            int size = ByteBuffer.wrap(wav, i + 4, 4).order(ByteOrder.LITTLE_ENDIAN).getInt();
            if (id.equals("data")) { dataAt = i + 8; break; }
            i += 8 + size + (size & 1);
        }
        assertThat(dataAt).isPositive();
        int data = Math.min(seconds * 16_000 * 2, wav.length - dataAt);
        ByteBuffer out = ByteBuffer.allocate(44 + data).order(ByteOrder.LITTLE_ENDIAN);
        out.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + data).put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII))
                .putInt(16).putShort((short) 1).putShort((short) 1).putInt(16_000).putInt(32_000).putShort((short) 2)
                .putShort((short) 16).put("data".getBytes(StandardCharsets.US_ASCII)).putInt(data);
        out.put(wav, dataAt, data);
        return out.array();
    }

    /** One real launcher process plus the harness around it. */
    private static final class Live implements AutoCloseable {
        final String run = UUID.randomUUID().toString().replace("-", "").substring(0, 16);
        final String tenant;
        final String owner;
        final String reviewer;
        final String other;
        final String bucket;
        final String schema;
        final int port;
        final Path services;
        final Path log;
        final String classpath;
        final Map<String, String> environment;
        Process launcher;
        boolean passed;

        private Live(String name, boolean render) throws Exception {
            tenant = "tenant-dev-j03-" + name + "-" + run;
            owner = "test-principal-owner-" + run;
            reviewer = "test-principal-reviewer-" + run;
            other = "test-principal-other-" + run;
            bucket = "media-dev-j03-" + name + "-" + run;
            schema = "media_dev_j03_" + name.replace('-', '_') + "_" + run;
            try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
            services = Files.createTempDirectory("media-dev-j03-services-");
            log = Files.createTempFile("media-dev-j03-process-", ".log");
            try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            classpath = services + java.io.File.pathSeparator + childClasspath;
            environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
            environment.put("MEDIA_DEV_REVIEW_ENABLED", "true");
            environment.put("MEDIA_DEV_CAPTION_REVIEW_REQUIRED", "true");
            environment.put("MEDIA_LOCAL_MODEL_ROOT", MODEL_ROOT.toString());
            environment.put("MEDIA_WHISPER_CPP_BIN", MODEL_ROOT.resolve("runtimes/whisper.cpp-src/build-vulkan/bin/whisper-cli").toString());
            environment.put("MEDIA_WHISPER_CPP_THREADS", "8");
            String ffmpeg = firstEnv("MEDIA_DEV_RENDER_FFMPEG", "GHATANA_MEDIA_FFMPEG", "MEDIA_FFMPEG");
            String ffprobe = firstEnv("MEDIA_DEV_RENDER_FFPROBE", "GHATANA_MEDIA_FFPROBE", "MEDIA_FFPROBE");
            if (render) {
                assumeTrue(ffmpeg != null && ffprobe != null, "runnable FFmpeg/FFprobe are required for the MP4 render step");
                environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpeg);
                environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe);
                ffmpegPath = ffmpeg;
            }
        }

        String ffmpegPath;
        private final Map<String, long[]> tokenExpiry = new HashMap<>();
        private final Map<String, String> tokenCache = new HashMap<>();

        /** DEV_ONLY tokens live at most 300 s; the journey is longer, so each role refreshes its token on demand. */
        private String cached(String role, String principal, String... permissions) throws Exception {
            long now = System.nanoTime();
            long[] expiry = tokenExpiry.get(role);
            if (expiry == null || now > expiry[0]) {
                tokenCache.put(role, token(tenant, principal, permissions));
                tokenExpiry.put(role, new long[] {now + java.util.concurrent.TimeUnit.SECONDS.toNanos(200)});
            }
            return tokenCache.get(role);
        }

        String ownerToken() throws Exception {
            return cached("owner", owner, "media:project:dev:create", "media:project:dev:read", "media:project:dev:write",
                    "media:artifact:create", "media:artifact:write", "media:artifact:read");
        }
        String reviewerToken() throws Exception {
            // Full artifact permissions on purpose: an assigned reviewer still cannot correct what it does not own.
            return cached("reviewer", reviewer, "media:project:dev:create", "media:project:dev:read", "media:project:dev:write",
                    "media:artifact:create", "media:artifact:write", "media:artifact:read");
        }
        String otherToken() throws Exception {
            return cached("other", other, "media:project:dev:create", "media:project:dev:read", "media:project:dev:write",
                    "media:artifact:create", "media:artifact:write", "media:artifact:read");
        }
        /** The owner identity without artifact create: may read but not register a correction. */
        String readOnlyToken() throws Exception {
            return cached("readonly", owner, "media:project:dev:read", "media:project:dev:write", "media:artifact:read");
        }

        static Live start(String name, boolean render) throws Exception {
            Map<String, String> probe = Map.of("MEDIA_LOCAL_MODEL_ROOT", MODEL_ROOT.toString(),
                    "MEDIA_WHISPER_CPP_BIN", MODEL_ROOT.resolve("runtimes/whisper.cpp-src/build-vulkan/bin/whisper-cli").toString(),
                    "MEDIA_WHISPER_CPP_THREADS", "8");
            assumeTrue(Files.isRegularFile(JFK) && com.ghatana.stt.provider.LocalWhisperCppSttProvider
                            .fromEnvironment(probe).ready(),
                    "the verified whisper.cpp runtime/model and jfk.wav sample are not installed on this host");
            Live live = new Live(name, render);
            live.launcher = startLauncher(live.classpath, live.environment, live.log);
            awaitReady(live.launcher, live.port);
            return live;
        }

        static String firstEnv(String... names) {
            for (String name : names) {
                String value = System.getenv(name);
                if (value != null && !value.isBlank()) return value;
            }
            return null;
        }

        /** Same DEV_ONLY issuer as the shared fixtures, with an explicit permission set. */
        static String token(String tenant, String principal, String... permissions) throws Exception {
            Path repoRoot = Path.of(System.getProperty("user.dir")).toAbsolutePath();
            while (!Files.isRegularFile(repoRoot.resolve("scripts/media-dev-identity-token.mjs"))) {
                repoRoot = repoRoot.getParent();
            }
            List<String> command = new ArrayList<>(List.of("node", "scripts/media-dev-identity-token.mjs",
                    "--tenant", tenant, "--subject", principal, "--expires-in", "300"));
            for (String permission : permissions) { command.add("--permission"); command.add(permission); }
            ProcessBuilder builder = new ProcessBuilder(command).directory(repoRoot.toFile()).redirectErrorStream(true);
            builder.environment().put("MEDIA_PROFILE", "dev");
            builder.environment().put("MEDIA_RUNTIME_ENVIRONMENT", "dev");
            builder.environment().put("MEDIA_DEV_IDENTITY_ENABLED", "true");
            builder.environment().put("MEDIA_DEV_JWT_HMAC_SECRET", DEV_SECRET);
            Process issuer = builder.start();
            String output = new String(issuer.getInputStream().readAllBytes(), StandardCharsets.US_ASCII).trim();
            assertThat(issuer.waitFor()).as(output).isZero();
            return output;
        }

        void restart() throws Exception {
            stopLauncher(launcher);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
        }

        String upload(String fileName, String contentType, byte[] bytes) throws Exception {
            return MediaDevLiveFixtures.upload(port, tenant, owner, ownerToken(), run + "-" + fileName, fileName, contentType, bytes);
        }

        String attest(String artifactId, String version) throws Exception {
            return ownerPost("/dev/v1/rights/attestations", Map.of("artifactId", artifactId, "artifactVersionId", version,
                    "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"), "basis", PROVENANCE), 201)
                    .path("attestationId").asString();
        }

        HttpResponse<String> send(String token, String method, String path, Object body) throws Exception {
            return MediaDevLiveFixtures.send(port, tenant, token, method, path, body == null ? null : JSON.writeValueAsString(body));
        }
        HttpResponse<String> owner(String method, String path, Object body) throws Exception { return send(ownerToken(), method, path, body); }
        JsonNode post(String token, String path, Object body, int status) throws Exception { return MediaDevLiveFixtures.post(port, tenant, token, path, body, status); }
        JsonNode get(String token, String path, int status) throws Exception { return MediaDevLiveFixtures.get(port, tenant, token, path, status); }
        JsonNode ownerPost(String path, Object body, int status) throws Exception { return post(ownerToken(), path, body, status); }
        JsonNode ownerGet(String path, int status) throws Exception { return get(ownerToken(), path, status); }

        /** Durable artifacts of the owner by content type (what a refused or unknown step must not have changed). */
        Map<String, Integer> artifactCounts() throws Exception {
            Map<String, Integer> counts = new TreeMap<>();
            try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                 var statement = connection.prepareStatement("SELECT content_type, count(*) FROM media_artifacts "
                         + "WHERE tenant_id=? AND principal_id=? GROUP BY content_type")) {
                statement.setString(1, tenant);
                statement.setString(2, owner);
                try (var rows = statement.executeQuery()) {
                    while (rows.next()) counts.put(rows.getString(1), rows.getInt(2));
                }
            }
            return counts;
        }

        Timeline timeline(String captionId, String captionVersion) throws Exception {
            byte[] png = solidPng(0xff204080);
            String pngId = upload("still.png", "image/png", png);
            String workspaceId = ownerGet("/dev/v1/context", 200).path("selectedAuthorizedWorkspaceId").asString();
            JsonNode created = ownerPost("/dev/v1/projects", Map.of("selectedAuthorizedWorkspaceId", workspaceId,
                    "title", "J-03 captions " + run, "requestId", "j03-project-" + run), 201);
            String projectId = created.path("project").path("projectId").asString();
            String head = created.path("initialRevision").path("revisionId").asString();
            head = ownerPost("/dev/v1/projects/" + projectId + "/timelines", Map.of("expectedHeadRevisionId", head,
                    "timelineId", "timeline-main"), 201).path("revision").path("revisionId").asString();
            Timeline timeline = new Timeline(projectId, head);
            timeline.edit(this, List.of(
                    Map.of("type", "addScene", "sceneId", "scene-main", "order", 0),
                    Map.of("type", "addTrack", "trackId", "video-main", "sceneId", "scene-main", "trackKind", "VIDEO", "order", 0),
                    Map.of("type", "putClip", "clip", Map.of("clipId", "clip-still", "sceneId", "scene-main",
                            "trackId", "video-main", "source", Map.of("artifactId", pngId, "artifactVersionId", "sha256:" + sha256(png)),
                            "sourceIn", Map.of("ticks", "0", "rateNumerator", "24", "rateDenominator", "1", "clock", "SOURCE_PRESENTATION"), "sourceOut", Map.of("ticks", "1", "rateNumerator", "24", "rateDenominator", "1", "clock", "SOURCE_PRESENTATION"), "storyStart", time(0), "storyDuration", time(264))),
                    Map.of("type", "addTrack", "trackId", "caption-main", "sceneId", "scene-main", "trackKind", "CAPTION", "order", 1),
                    captionClip(captionId, captionVersion)));
            return timeline;
        }

        static Map<String, Object> time(long ticks) {
            return Map.of("ticks", Long.toString(ticks), "rateNumerator", "24", "rateDenominator", "1", "clock", "STORY");
        }

        static Map<String, Object> captionClip(String captionId, String captionVersion) {
            return Map.of("type", "putClip", "clip", Map.of("clipId", "clip-captions", "sceneId", "scene-main",
                    "trackId", "caption-main", "source", Map.of("artifactId", captionId, "artifactVersionId", captionVersion),
                    "sourceIn", Map.of("ticks", "0", "rateNumerator", "24", "rateDenominator", "1", "clock", "SOURCE_PRESENTATION"),
                    "sourceOut", Map.of("ticks", "264", "rateNumerator", "24", "rateDenominator", "1", "clock", "SOURCE_PRESENTATION"),
                    "storyStart", time(0), "storyDuration", time(264)));
        }

        HttpResponse<String> render(Timeline timeline, String requestId) throws Exception {
            return render(timeline, requestId, timeline.head);
        }

        HttpResponse<String> render(Timeline timeline, String requestId, String revisionId) throws Exception {
            return owner("POST", "/dev/v1/projects/" + timeline.projectId + "/renders", Map.of("requestId", requestId,
                    "revisionId", revisionId, "timelineId", "timeline-main", "width", 320, "height", 180,
                    "framesPerSecond", 10, "format", "mp4"));
        }

        /** Reads the rendered MP4 back from S3 and extracts its mov_text subtitle stream with FFmpeg. */
        String subtitleText(String renderId) throws Exception {
            StoredArtifact stored = storedArtifact(POSTGRES, tenant, owner, renderId);
            Path mp4 = Files.createTempFile("j03-render-", ".mp4");
            Path srt = Files.createTempFile("j03-render-", ".srt");
            try {
                Files.write(mp4, s3Bytes(LOCALSTACK, bucket, stored));
                Process process = new ProcessBuilder(ffmpegPath, "-v", "error", "-y", "-i", mp4.toString(), "-map", "0:s:0",
                        "-f", "srt", srt.toString()).redirectErrorStream(true).start();
                String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
                assertThat(process.waitFor()).as(output).isZero();
                return Files.readString(srt);
            } finally {
                Files.deleteIfExists(mp4);
                Files.deleteIfExists(srt);
            }
        }

        @Override public void close() throws Exception {
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            deleteTree(services);
            Files.deleteIfExists(log);
        }
    }

    /** Project head tracking for the render steps. */
    private static final class Timeline {
        final String projectId;
        String head;
        Timeline(String projectId, String head) { this.projectId = projectId; this.head = head; }

        void edit(Live live, List<?> edits) throws Exception {
            head = live.ownerPost("/dev/v1/projects/" + projectId + "/timelines/timeline-main/edits",
                    Map.of("expectedHeadRevisionId", head, "edits", edits), 201).path("revision").path("revisionId").asString();
        }

        void useCaption(Live live, String captionId, String version) throws Exception {
            edit(live, List.of(Live.captionClip(captionId, version)));
        }
    }
}
