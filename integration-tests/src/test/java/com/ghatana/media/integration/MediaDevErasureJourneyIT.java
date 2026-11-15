package com.ghatana.media.integration;

import com.ghatana.media.runtime.MediaRuntimeContracts;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import software.amazon.awssdk.services.s3.model.HeadObjectRequest;
import software.amazon.awssdk.services.s3.model.NoSuchKeyException;
import tools.jackson.databind.JsonNode;

import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.DriverManager;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.stream.Collectors;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffmpeg;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffprobe;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.kokoroEnvironment;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.modelRoot;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-26 outcome journey {@code media.dev.outcome-retention-and-erasure}, end to end against REAL processes: a real
 * launcher (PostgreSQL + LocalStack S3), real Kokoro synthesis, real Whisper transcription, a real human caption
 * correction, a real review, a real FFmpeg MP4 render and a real delivery export. The tree is erased through the
 * DEV_ONLY routes and every surface is read back directly: S3 GETs, PostgreSQL rows, the request ledger, the speech
 * spool, the delivered file and the HTTP routes. Principals are clearly synthetic test principals; rights statements are
 * statements by those test principals, not a legal determination, and nothing here is a human approval or a release.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevErasureJourneyIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private static final String SENTENCE = "Ask not what your country can do for you.";
    private static final String PROVENANCE = "TEST: speech synthesized by Kokoro-82M (Apache-2.0) from a test sentence; "
            + "a statement by a synthetic test principal, not a legal determination";

    // ------------------------------------------------------------------------------------------ the journey

    @Test
    void erasingARealTreeRemovesEverySurfaceHonorsHoldsAndDiscloses_nothing_afterwardsAcrossARestart() throws Exception {
        try (Host host = Host.start("tree", Map.of(), true)) {
            // 1. Real Kokoro speech is the root; an unrelated control artifact proves nothing else is touched.
            JsonNode synth = host.ownerPost("/dev/v1/speech/syntheses", Map.of("requestId", "tts-" + host.run,
                    "text", SENTENCE, "voice", "am_michael", "locale", "en"), 201);
            String rootId = synth.path("artifact").path("artifactId").asString();
            String rootVersion = synth.path("artifact").path("artifactVersionId").asString();
            JsonNode control = host.ownerPost("/dev/v1/speech/syntheses", Map.of("requestId", "tts-control-" + host.run,
                    "text", "This unrelated sentence must survive.", "voice", "af_heart", "locale", "en"), 201);
            String controlId = control.path("artifact").path("artifactId").asString();
            String controlVersion = control.path("artifact").path("artifactVersionId").asString();

            // 2. Real Whisper transcribes the exact synthesized version (after the owner states PROCESSING rights).
            String attestationId = host.ownerPost("/dev/v1/rights/attestations", Map.of("artifactId", rootId,
                    "artifactVersionId", rootVersion, "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                    "basis", PROVENANCE), 201).path("attestationId").asString();
            Map<String, Object> transcribe = Map.of("requestId", "stt-" + host.run, "artifactId", rootId,
                    "artifactVersionId", rootVersion, "language", "en");
            JsonNode stt = host.ownerPost("/dev/v1/speech/transcriptions", transcribe, 201);
            String transcriptText = stt.path("text").asString();
            System.out.println("J26_REAL_WHISPER_TRANSCRIPT text=\"" + transcriptText + "\"");
            assertThat(normalize(transcriptText)).contains("ask not what your country");
            String transcriptId = stt.path("transcript").path("artifact").path("artifactId").asString();
            String machineId = stt.path("captions").path("artifact").path("artifactId").asString();
            String machineVersion = stt.path("captions").path("artifact").path("artifactVersionId").asString();

            // 3. A human caption correction (new version), a review that accepts the exact version, a real MP4 render.
            JsonNode machine = host.ownerGet("/dev/v1/captions/" + machineId, 200);
            List<Map<String, Object>> cues = new ArrayList<>();
            for (JsonNode cue : machine.path("cues")) {
                cues.add(Map.of("startMillis", cue.path("startMillis").asLong(), "endMillis", cue.path("endMillis").asLong(),
                        "text", cue.path("text").asString().strip() + " [TEST human-reviewed edit]"));
            }
            JsonNode corrected = host.ownerPost("/dev/v1/captions/corrections", Map.of("requestId", "corr-" + host.run,
                    "baseArtifactId", machineId, "expectedVersionId", machineVersion, "cues", cues), 201);
            String captionId = corrected.path("captionId").asString();
            String captionVersion = corrected.path("artifact").path("artifactVersionId").asString();
            String caseId = host.ownerPost("/dev/v1/reviews", Map.of("subject", Map.of("kind", "ARTIFACT_VERSION",
                    "artifactId", captionId, "artifactVersionId", captionVersion)), 201).path("reviewCaseId").asString();
            host.ownerPost("/dev/v1/reviews/" + caseId + "/assignments", Map.of("requestId", "assign-" + host.run,
                    "expectedCaseRevision", 0, "reviewerPrincipalId", host.reviewer, "scopes", List.of("QUALITY"),
                    "expiresAt", java.time.Instant.now().plus(java.time.Duration.ofMinutes(25)).toString()), 201);
            host.post(host.token("reviewer"), "/dev/v1/reviews/" + caseId + "/decisions", Map.of("requestId", "accept-" + host.run,
                    "expectedCaseRevision", 0, "decision", "ACCEPT",
                    "reason", "TEST: DEV_ONLY assigned-reviewer decision on the exact corrected caption version",
                    "scope", "QUALITY", "confirmed", true), 201);
            String pngId = host.upload("still.png", "image/png", solidPng(0xff204080));
            String pngVersion = "sha256:" + sha256(solidPng(0xff204080));
            String workspaceId = host.ownerGet("/dev/v1/context", 200).path("selectedAuthorizedWorkspaceId").asString();
            JsonNode project = host.ownerPost("/dev/v1/projects", Map.of("selectedAuthorizedWorkspaceId", workspaceId,
                    "title", "J-26 erasure " + host.run, "requestId", "j26-project-" + host.run), 201);
            String projectId = project.path("project").path("projectId").asString();
            String head = project.path("initialRevision").path("revisionId").asString();
            head = host.ownerPost("/dev/v1/projects/" + projectId + "/timelines", Map.of("expectedHeadRevisionId", head,
                    "timelineId", "timeline-main"), 201).path("revision").path("revisionId").asString();
            head = host.ownerPost("/dev/v1/projects/" + projectId + "/timelines/timeline-main/edits", Map.of(
                    "expectedHeadRevisionId", head, "edits", List.of(
                    Map.of("type", "addScene", "sceneId", "scene-main", "order", 0),
                    Map.of("type", "addTrack", "trackId", "video-main", "sceneId", "scene-main", "trackKind", "VIDEO", "order", 0),
                    Map.of("type", "putClip", "clip", clip("clip-still", "video-main", pngId, pngVersion, 264)),
                    Map.of("type", "addTrack", "trackId", "caption-main", "sceneId", "scene-main", "trackKind", "CAPTION", "order", 1),
                    Map.of("type", "putClip", "clip", clip("clip-captions", "caption-main", captionId, captionVersion, 264)))), 201)
                    .path("revision").path("revisionId").asString();
            HttpResponse<String> rendered = host.owner("POST", "/dev/v1/projects/" + projectId + "/renders", Map.of(
                    "requestId", "render-" + host.run, "revisionId", head, "timelineId", "timeline-main", "width", 320,
                    "height", 180, "framesPerSecond", 10, "format", "mp4"));
            assertThat(rendered.statusCode()).as(rendered.body()).isEqualTo(201);
            String renderId = JSON.readTree(rendered.body()).path("renderId").asString();
            String renderVersion = JSON.readTree(rendered.body()).path("artifact").path("artifactVersionId").asString();

            // 4. A real delivery export of the render to the configured destination directory (rights: EXTERNAL_DELIVERY).
            String deliveryAttestation = host.ownerPost("/dev/v1/rights/attestations", Map.of("artifactId", renderId,
                    "artifactVersionId", renderVersion, "statementKind", "MEDIA_RIGHTS", "scopes", List.of("EXTERNAL_DELIVERY"),
                    "basis", PROVENANCE), 201).path("attestationId").asString();
            assertThat(host.send(host.token("confirmer"), "POST", "/dev/v1/rights/attestations/" + deliveryAttestation + "/confirm", Map.of())
                    .statusCode()).isEqualTo(200);
            JsonNode exported = host.post(host.exportToken(), "/dev/v1/exports", Map.of("requestId", "export-" + host.run,
                    "artifactId", renderId, "artifactVersionId", renderVersion, "destinationId", "dev-local-directory"), 201);
            assertThat(exported.path("status").asString()).isEqualTo("DESTINATION_CONFIRMED");
            Path delivered = host.deliveredFile("export-" + host.run);
            assertThat(delivered).exists();

            // 5. Inventory before: every surface holds something, captured by id and digest (never by content).
            List<String> tree = List.of(rootId, transcriptId, machineId, captionId, renderId);
            Inventory before = host.inventory(tree);
            assertThat(before.objectKeys).hasSize(5);
            assertThat(before.artifactRows).isEqualTo(5);
            assertThat(before.deliveryRows).isEqualTo(1);
            assertThat(before.reviewRows).as("review case + records in the DEV_ONLY review schema").isGreaterThanOrEqualTo(2);
            assertThat(before.completedLedgerRows).as("tts x2 + stt + correction").isGreaterThanOrEqualTo(4);
            assertThat(host.spoolFilesWithDigest(sha256Of(before.sha256.get(rootId)))).as("the spool holds the synthesized audio").isNotEmpty();
            for (String key : before.objectKeys.values()) assertThat(host.s3Exists(key)).isTrue();

            // 6. The plan shows the exact tree by kind; a non-owner sees nothing and can do nothing.
            JsonNode plan = host.ownerGet("/dev/v1/erasure-plans/" + rootId, 200);
            Map<String, String> kinds = new TreeMap<>();
            for (JsonNode node : plan.path("artifacts")) kinds.put(node.path("artifactId").asString(), node.path("kind").asString());
            assertThat(kinds).containsEntry(rootId, "SYNTHESIZED_AUDIO").containsEntry(transcriptId, "TRANSCRIPT")
                    .containsEntry(machineId, "WEBVTT").containsEntry(captionId, "CAPTION_VERSION").containsEntry(renderId, "RENDER");
            assertThat(kinds).as("the unrelated artifacts are not in the tree").doesNotContainKeys(controlId, pngId).hasSize(5);
            assertThat(plan.path("erasable").asBoolean()).isTrue();
            assertThat(plan.path("dependentRecords").path("DELIVERY_RECORD").asInt()).isEqualTo(1);
            assertThat(plan.path("dependentRecords").path("REQUEST_LEDGER_ROW").asInt()).isGreaterThanOrEqualTo(3);
            Map<String, Object> eraseBody = erase("erase-" + host.run, rootId, 5);
            for (HttpResponse<String> refused : List.of(
                    host.send(host.token("other"), "GET", "/dev/v1/erasure-plans/" + rootId, null),
                    host.send(host.token("other"), "POST", "/dev/v1/erasures", eraseBody),
                    host.send(host.token("other"), "POST", "/dev/v1/legal-holds", Map.of("requestId", "h-other", "artifactId", rootId, "reason", "not mine")))) {
                assertThat(refused.statusCode()).as(refused.body()).isEqualTo(404);
                assertThat(refused.body()).contains("ARTIFACT_NOT_FOUND");
            }
            assertThat(host.send(host.token("reviewer"), "POST", "/dev/v1/erasures", eraseBody).statusCode())
                    .as("an assigned reviewer is not the owner").isEqualTo(404);
            assertThat(host.inventory(tree).artifactRows).as("refusals erased nothing").isEqualTo(5);

            // 7. Unconfirmed, stale-tree and unknown-field requests are refused with nothing erased.
            assertThat(host.owner("POST", "/dev/v1/erasures", Map.of("erasureId", "e-x", "artifactId", rootId, "confirm", false)).statusCode()).isEqualTo(422);
            assertThat(host.owner("POST", "/dev/v1/erasures", erase("e-y", rootId, 4)).statusCode()).isEqualTo(409);
            assertThat(host.inventory(tree).artifactRows).isEqualTo(5);

            // 8. Legal hold: an owner hold (on the root, then on a derived render) blocks erasure of the whole tree.
            JsonNode hold = host.ownerPost("/dev/v1/legal-holds", Map.of("requestId", "hold-" + host.run, "artifactId", rootId,
                    "reason", "TEST legal hold for the erasure journey"), 201);
            String holdId = hold.path("holdId").asString();
            assertThat(hold.path("placedBy").asString()).isEqualTo(host.owner);
            assertThat(hold.path("placedIdentityAssurance").asString()).isEqualTo("DEV_ISSUED");
            HttpResponse<String> held = host.owner("POST", "/dev/v1/erasures", eraseBody);
            assertThat(held.statusCode()).as(held.body()).isEqualTo(409);
            assertThat(held.body()).contains("LEGAL_HOLD_ACTIVE").contains(holdId);
            assertThat(host.inventory(tree).artifactRows).as("a held tree loses nothing").isEqualTo(5);
            for (String key : before.objectKeys.values()) assertThat(host.s3Exists(key)).isTrue();
            assertThat(host.send(host.token("other"), "POST", "/dev/v1/legal-holds/" + holdId + "/release", Map.of("reason", "x")).statusCode()).isEqualTo(404);
            JsonNode released = host.ownerPost("/dev/v1/legal-holds/" + holdId + "/release", Map.of("reason", "TEST matter closed"), 200);
            assertThat(released.path("state").asString()).isEqualTo("RELEASED");
            assertThat(released.path("releasedBy").asString()).isEqualTo(host.owner);
            assertThat(released.path("releaseReason").asString()).isEqualTo("TEST matter closed");
            JsonNode derivedHold = host.ownerPost("/dev/v1/legal-holds", Map.of("requestId", "hold-render-" + host.run,
                    "artifactId", renderId, "reason", "TEST hold on a derived render"), 201);
            HttpResponse<String> heldByDerived = host.owner("POST", "/dev/v1/erasures", eraseBody);
            assertThat(heldByDerived.statusCode()).as(heldByDerived.body()).isEqualTo(409);
            assertThat(heldByDerived.body()).contains("LEGAL_HOLD_ACTIVE");
            host.ownerPost("/dev/v1/legal-holds/" + derivedHold.path("holdId").asString() + "/release", Map.of("reason", "TEST closed"), 200);

            // 9. Rights revocation is NOT erasure: it stops new processing and replays and deletes nothing.
            host.ownerPost("/dev/v1/rights/attestations/" + attestationId + "/revoke", Map.of("reason", "TEST revocation"), 200);
            HttpResponse<String> replayAfterRevoke = host.owner("POST", "/dev/v1/speech/transcriptions", transcribe);
            assertThat(replayAfterRevoke.statusCode()).as(replayAfterRevoke.body()).isEqualTo(403);
            assertThat(replayAfterRevoke.body()).doesNotContain(transcriptText);
            Inventory afterRevoke = host.inventory(tree);
            assertThat(afterRevoke.artifactRows).as("revocation deleted no artifact").isEqualTo(5);
            assertThat(afterRevoke.completedLedgerRows).isEqualTo(before.completedLedgerRows);
            for (String key : before.objectKeys.values()) assertThat(host.s3Exists(key)).as("revocation deleted no object").isTrue();
            HttpResponse<String> stillReadable = host.owner("GET", "/dev/v1/artifacts/" + rootId + "/content", null, Map.of("If-Match", "\"" + rootVersion + "\""));
            assertThat(stillReadable.statusCode()).as("revoked rights do not erase the bytes").isEqualTo(200);

            // 10. Erase. The receipt names kinds, counts and digests - never content.
            HttpResponse<String> erasedResponse = host.owner("POST", "/dev/v1/erasures", eraseBody);
            assertThat(erasedResponse.statusCode()).as(erasedResponse.body()).isEqualTo(201);
            JsonNode receipt = JSON.readTree(erasedResponse.body());
            assertThat(receipt.path("phase").asString()).isEqualTo("COMPLETED");
            assertThat(receipt.path("complete").asBoolean()).isTrue();
            assertThat(receipt.path("contentDisclosed").asString()).isEqualTo("none");
            Map<String, JsonNode> items = new TreeMap<>();
            for (JsonNode item : receipt.path("items")) items.put(item.path("kind").asString(), item);
            assertThat(items).containsKeys("SYNTHESIZED_AUDIO", "TRANSCRIPT", "WEBVTT", "CAPTION_VERSION", "RENDER",
                    "S3_OBJECT", "REQUEST_LEDGER_ROW", "DELIVERY_RECORD", "DEV_REVIEW_RECORD", "UPLOAD_SESSION",
                    "LOCAL_SPOOL_ENTRY", "DELIVERED_OBJECT");
            assertThat(items.get("S3_OBJECT").path("count").asInt()).isEqualTo(5);
            assertThat(items.get("TRANSCRIPT").path("digests").get(0).asString()).isEqualTo(before.sha256.get(transcriptId));
            assertThat(items.get("RENDER").path("digests").get(0).asString()).isEqualTo(before.sha256.get(renderId));
            assertThat(items.get("SYNTHESIZED_AUDIO").path("digests").get(0).asString()).isEqualTo(before.sha256.get(rootId));
            assertThat(items.get("LOCAL_SPOOL_ENTRY").path("count").asInt()).isGreaterThanOrEqualTo(1);
            assertThat(items.get("DELIVERED_OBJECT").path("count").asInt()).isEqualTo(1);
            assertThat(items.get("REQUEST_LEDGER_ROW").path("count").asInt()).isGreaterThanOrEqualTo(3);
            assertThat(items.get("DELIVERY_RECORD").path("count").asInt()).isEqualTo(1);
            assertThat(erasedResponse.body()).as("the receipt carries no content").doesNotContain(transcriptText)
                    .doesNotContain("fellow").doesNotContain("RIFF").doesNotContain("WEBVTT\n").doesNotContain(SENTENCE);
            assertNothingDisclosed(host, before, tree, rootId, rootVersion, transcriptId, machineId, captionId, renderId,
                    caseId, projectId, controlId, controlVersion, pngId, delivered, transcribe, synth, transcriptText);

            // 11. The same receipt reads back; the same erasure id is idempotent; a different id is refused as erased.
            JsonNode reread = host.ownerGet("/dev/v1/erasures/erase-" + host.run, 200);
            assertThat(reread.path("items")).isEqualTo(receipt.path("items"));
            assertThat(host.send(host.token("other"), "GET", "/dev/v1/erasures/erase-" + host.run, null).statusCode()).isEqualTo(404);
            assertThat(JSON.readTree(host.owner("POST", "/dev/v1/erasures", eraseBody).body()).path("items")).isEqualTo(receipt.path("items"));
            HttpResponse<String> again = host.owner("POST", "/dev/v1/erasures", erase("erase-2-" + host.run, rootId, null));
            assertThat(again.statusCode()).isEqualTo(410);
            assertThat(again.body()).contains("ARTIFACT_ERASED");

            // 12. A restart changes nothing: every surface still discloses nothing and the receipt is still there.
            host.restart(Map.of());
            assertNothingDisclosed(host, before, tree, rootId, rootVersion, transcriptId, machineId, captionId, renderId,
                    caseId, projectId, controlId, controlVersion, pngId, delivered, transcribe, synth, transcriptText);
            assertThat(host.ownerGet("/dev/v1/erasures/erase-" + host.run, 200).path("items")).isEqualTo(receipt.path("items"));
            host.passed = true;
        }
    }

    /** Reads every surface after erasure; none may return content. */
    private static void assertNothingDisclosed(Host host, Inventory before, List<String> tree, String rootId, String rootVersion,
                                               String transcriptId, String machineId, String captionId, String renderId,
                                               String caseId, String projectId, String controlId, String controlVersion,
                                               String pngId, Path delivered, Map<String, Object> transcribe, JsonNode synth,
                                               String transcriptText) throws Exception {
        // S3: a fresh GET of every object of the tree fails.
        for (Map.Entry<String, String> object : before.objectKeys.entrySet()) {
            assertThat(host.s3Exists(object.getValue())).as("S3 object of " + object.getKey()).isFalse();
            try (var s3 = s3(LOCALSTACK)) {
                org.assertj.core.api.Assertions.assertThatThrownBy(() -> s3.getObjectAsBytes(b -> b.bucket(host.bucket).key(object.getValue())))
                        .isInstanceOf(NoSuchKeyException.class);
            }
        }
        // PostgreSQL: no row of the tree survives anywhere; the ledger answers ERASED; tombstones record the digests.
        Inventory after = host.inventory(tree);
        assertThat(after.artifactRows).isZero();
        assertThat(after.lineageRows).isZero();
        assertThat(after.deliveryRows).isZero();
        assertThat(after.reviewRows).isZero();
        assertThat(after.uploadSessionRows).isZero();
        assertThat(after.tombstones).isEqualTo(5);
        assertThat(after.erasedLedgerRows).isGreaterThanOrEqualTo(3);
        assertThat(after.completedLedgerRowsReferencing).as("no completed ledger row can replay an erased output").isZero();
        // Local copies: the spool and the delivered file are gone.
        assertThat(host.spoolFilesWithDigest(sha256Of(before.sha256.get(rootId)))).isEmpty();
        assertThat(delivered).doesNotExist();
        // HTTP: every artifact-bearing route answers a typed 410 (or 404), never bytes.
        for (String id : tree) {
            HttpResponse<String> content = host.owner("GET", "/dev/v1/artifacts/" + id + "/content", null, Map.of("If-Match", "\"sha256:" + before.sha256.get(id) + "\""));
            assertThat(content.statusCode()).as(id).isEqualTo(410);
            assertThat(content.body()).contains("ARTIFACT_ERASED");
        }
        for (String path : List.of("/dev/v1/speech/outputs/" + transcriptId, "/dev/v1/speech/outputs/" + rootId,
                "/dev/v1/captions/" + captionId, "/dev/v1/captions/" + machineId)) {
            HttpResponse<String> gone = host.owner("GET", path, null);
            assertThat(gone.statusCode()).as(path).isEqualTo(410);
            assertThat(gone.body()).doesNotContain(transcriptText);
        }
        HttpResponse<String> canonical = host.owner("GET", "/api/v1/artifacts/" + rootId, null);
        assertThat(canonical.statusCode()).as("canonical artifact metadata read").isEqualTo(404);
        assertThat(host.owner("GET", "/dev/v1/reviews/" + caseId, null).statusCode()).as("review case").isEqualTo(404);
        assertThat(host.send(host.exportToken(), "GET", "/dev/v1/exports/export-" + host.run, null).statusCode()).as("delivery record").isEqualTo(404);
        assertThat(host.owner("GET", "/dev/v1/erasure-plans/" + rootId, null).statusCode()).isEqualTo(410);
        // Ledger replay: the same request ids never return bytes and never run a model again.
        int wavBefore = host.count("audio/wav");
        HttpResponse<String> ttsReplay = host.owner("POST", "/dev/v1/speech/syntheses", Map.of("requestId", "tts-" + host.run,
                "text", SENTENCE, "voice", "am_michael", "locale", "en"));
        assertThat(ttsReplay.statusCode()).as(ttsReplay.body()).isEqualTo(410);
        assertThat(ttsReplay.body()).contains("OUTPUT_ERASED");
        HttpResponse<String> sttReplay = host.owner("POST", "/dev/v1/speech/transcriptions", transcribe);
        assertThat(sttReplay.statusCode()).as(sttReplay.body()).isIn(403, 404, 410);
        assertThat(sttReplay.body()).doesNotContain(transcriptText);
        assertThat(host.count("audio/wav")).as("no model ran again").isEqualTo(wavBefore);
        // Nothing unrelated was touched.
        assertThat(host.owner("GET", "/dev/v1/artifacts/" + controlId + "/content", null, Map.of("If-Match", "\"" + controlVersion + "\"")).statusCode()).isEqualTo(200);
        assertThat(host.owner("GET", "/dev/v1/artifacts/" + pngId + "/content", null, Map.of("If-Match", "\"sha256:" + sha256(solidPng(0xff204080)) + "\"")).statusCode()).isEqualTo(200);
        assertThat(host.inventory(List.of(controlId, pngId)).artifactRows).isEqualTo(2);
    }

    // ---------------------------------------------------------------------------------------- crash and resume

    @Test
    void aCrashMidErasureResumesToCompletionAfterRestartWithNoWindowInWhichAnythingIsReadable() throws Exception {
        try (Host host = Host.start("crash", Map.of("MEDIA_DEV_ERASURE_CRASH_AT", "AFTER_DB_ERASED"), false)) {
            // Crash point 1: after the database transaction committed, before any object was deleted.
            JsonNode synth = host.ownerPost("/dev/v1/speech/syntheses", Map.of("requestId", "tts-crash-a-" + host.run,
                    "text", "Crash test sentence one.", "voice", "af_heart", "locale", "en"), 201);
            String firstId = synth.path("artifact").path("artifactId").asString();
            String firstSha = synth.path("artifact").path("sha256").asString();
            Inventory before = host.inventory(List.of(firstId));
            assertThat(before.objectKeys).hasSize(1);
            assertThat(host.spoolFilesWithDigest(sha256Of(firstSha))).isNotEmpty();
            try {
                host.owner("POST", "/dev/v1/erasures", erase("crash-a-" + host.run, firstId, 1));
            } catch (java.io.IOException expectedConnectionLoss) {
                // the launcher halted mid-erasure
            }
            assertThat(host.launcher.waitFor(30, java.util.concurrent.TimeUnit.SECONDS)).as("launcher halted").isTrue();
            assertThat(host.launcher.exitValue()).isEqualTo(137);
            // No window: the metadata is already gone, so no launcher can read the tree; only orphaned bytes remain.
            Inventory crashed = host.inventory(List.of(firstId));
            assertThat(crashed.artifactRows).as("the database commit removed every metadata row").isZero();
            assertThat(crashed.tombstones).isEqualTo(1);
            assertThat(host.operationState("crash-a-" + host.run)).isEqualTo("DB_ERASED");
            assertThat(host.s3Exists(before.objectKeys.get(firstId))).as("the object is an unreachable orphan until resumed").isTrue();
            assertThat(host.spoolFilesWithDigest(sha256Of(firstSha))).as("the local copy awaits the resume").isNotEmpty();

            // Restart WITHOUT the fault: start-up resumes the operation to completion before serving.
            host.restart(Map.of("MEDIA_DEV_ERASURE_CRASH_AT", ""));
            JsonNode receipt = host.ownerGet("/dev/v1/erasures/crash-a-" + host.run, 200);
            assertThat(receipt.path("complete").asBoolean()).isTrue();
            assertThat(receipt.path("phase").asString()).isEqualTo("COMPLETED");
            assertThat(host.operationState("crash-a-" + host.run)).isEqualTo("COMPLETED");
            assertThat(host.s3Exists(before.objectKeys.get(firstId))).isFalse();
            assertThat(host.spoolFilesWithDigest(sha256Of(firstSha))).isEmpty();
            Set<String> kinds = new java.util.TreeSet<>();
            for (JsonNode item : receipt.path("items")) kinds.add(item.path("kind").asString());
            assertThat(kinds).contains("SYNTHESIZED_AUDIO", "S3_OBJECT", "LOCAL_SPOOL_ENTRY", "REQUEST_LEDGER_ROW");
            assertThat(host.owner("GET", "/dev/v1/artifacts/" + firstId + "/content", null, Map.of("If-Match", "\"sha256:" + firstSha + "\"")).statusCode()).isEqualTo(410);
            HttpResponse<String> replay = host.owner("POST", "/dev/v1/speech/syntheses", Map.of("requestId", "tts-crash-a-" + host.run,
                    "text", "Crash test sentence one.", "voice", "af_heart", "locale", "en"));
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(410);
            assertThat(host.inventory(List.of(firstId)).completedLedgerRowsReferencing).isZero();

            // Crash point 2: after every object was deleted, before the local copies were removed.
            host.restart(Map.of("MEDIA_DEV_ERASURE_CRASH_AT", "AFTER_OBJECTS_ERASED"));
            JsonNode second = host.ownerPost("/dev/v1/speech/syntheses", Map.of("requestId", "tts-crash-b-" + host.run,
                    "text", "Crash test sentence two.", "voice", "af_heart", "locale", "en"), 201);
            String secondId = second.path("artifact").path("artifactId").asString();
            String secondSha = second.path("artifact").path("sha256").asString();
            Inventory secondBefore = host.inventory(List.of(secondId));
            try {
                host.owner("POST", "/dev/v1/erasures", erase("crash-b-" + host.run, secondId, 1));
            } catch (java.io.IOException expectedConnectionLoss) {
                // halted
            }
            assertThat(host.launcher.waitFor(30, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            assertThat(host.operationState("crash-b-" + host.run)).isEqualTo("OBJECTS_ERASED");
            assertThat(host.s3Exists(secondBefore.objectKeys.get(secondId))).isFalse();
            assertThat(host.inventory(List.of(secondId)).artifactRows).isZero();
            assertThat(host.spoolFilesWithDigest(sha256Of(secondSha))).as("the spool copy awaits the resume").isNotEmpty();
            host.restart(Map.of("MEDIA_DEV_ERASURE_CRASH_AT", ""));
            assertThat(host.ownerGet("/dev/v1/erasures/crash-b-" + host.run, 200).path("complete").asBoolean()).isTrue();
            assertThat(host.spoolFilesWithDigest(sha256Of(secondSha))).isEmpty();
            assertThat(host.operationState("crash-b-" + host.run)).isEqualTo("COMPLETED");
            host.passed = true;
        }
    }

    // ----------------------------------------------------------------------- production-like identity gate

    @Test
    void aProductionLikeGateRefusesHoldReleaseAndEraseFromADevIssuedPrincipalAndErasesNothing() throws Exception {
        try (Host host = Host.start("oidc", Map.of("MEDIA_DEV_ERASURE_REQUIRE_OIDC", "true"), false)) {
            JsonNode synth = host.ownerPost("/dev/v1/speech/syntheses", Map.of("requestId", "tts-oidc-" + host.run,
                    "text", "Identity gate sentence.", "voice", "af_heart", "locale", "en"), 201);
            String id = synth.path("artifact").path("artifactId").asString();
            for (HttpResponse<String> refused : List.of(
                    host.owner("POST", "/dev/v1/legal-holds", Map.of("requestId", "h", "artifactId", id, "reason", "r")),
                    host.owner("POST", "/dev/v1/legal-holds/hold-x/release", Map.of("reason", "r")),
                    host.owner("POST", "/dev/v1/erasures", erase("e-oidc", id, 1)))) {
                assertThat(refused.statusCode()).as(refused.body()).isEqualTo(403);
                assertThat(refused.body()).contains("IDENTITY_ASSURANCE_REQUIRED").contains("OIDC_VERIFIED").contains("DEV_ISSUED");
            }
            assertThat(host.inventory(List.of(id)).artifactRows).isEqualTo(1);
            assertThat(host.ownerGet("/dev/v1/erasure-plans/" + id, 200).path("erasable").asBoolean())
                    .as("a read-only plan stays available").isTrue();
            host.passed = true;
        }
    }

    // ------------------------------------------------------------------------------------------ helpers

    private static Map<String, Object> erase(String id, String artifactId, Integer expected) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("erasureId", id);
        body.put("artifactId", artifactId);
        body.put("confirm", true);
        if (expected != null) body.put("expectedArtifactCount", expected);
        return body;
    }

    private static Map<String, Object> clip(String clipId, String trackId, String artifactId, String version, long ticks) {
        Map<String, Object> time = Map.of("ticks", "0", "rateNumerator", "24", "rateDenominator", "1", "clock", "SOURCE_PRESENTATION");
        return Map.of("clipId", clipId, "sceneId", "scene-main", "trackId", trackId,
                "source", Map.of("artifactId", artifactId, "artifactVersionId", version), "sourceIn", time,
                "sourceOut", Map.of("ticks", Long.toString(ticks), "rateNumerator", "24", "rateDenominator", "1", "clock", "SOURCE_PRESENTATION"),
                "storyStart", Map.of("ticks", "0", "rateNumerator", "24", "rateDenominator", "1", "clock", "STORY"),
                "storyDuration", Map.of("ticks", Long.toString(ticks), "rateNumerator", "24", "rateDenominator", "1", "clock", "STORY"));
    }

    private static String normalize(String text) {
        return text.toLowerCase(java.util.Locale.ROOT).replaceAll("[^a-z ]", " ").replaceAll("\\s+", " ").trim();
    }

    /** SHA-256 hex of a hex string's bytes is not needed: the spool is addressed by audio digest, so this is the identity. */
    private static String sha256Of(String hexDigest) { return hexDigest; }

    /** Counts of every durable surface for a set of artifact ids (identifiers only). */
    private static final class Inventory {
        final Map<String, String> objectKeys = new LinkedHashMap<>();
        final Map<String, String> sha256 = new LinkedHashMap<>();
        int artifactRows, lineageRows, deliveryRows, reviewRows, uploadSessionRows, tombstones;
        int completedLedgerRows, erasedLedgerRows, completedLedgerRowsReferencing;
    }

    /** One real launcher process plus the harness around it. */
    private static final class Host implements AutoCloseable {
        final String run = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        final String tenant, owner, reviewer, confirmer, other, bucket, schema;
        final int port;
        final Path services, log, spool, destination;
        final String classpath;
        final Map<String, String> environment;
        Process launcher;
        boolean passed;
        private final Map<String, long[]> expiry = new HashMap<>();
        private final Map<String, String> tokens = new HashMap<>();

        private Host(String name, Map<String, String> extra, boolean render) throws Exception {
            tenant = "tenant-dev-j26-" + name + "-" + run;
            owner = "test-principal-owner-" + run;
            reviewer = "test-principal-reviewer-" + run;
            confirmer = "test-principal-confirmer-" + run;
            other = "test-principal-other-" + run;
            bucket = "media-dev-j26-" + name + "-" + run;
            schema = "media_dev_j26_" + name + "_" + run;
            try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
            services = Files.createTempDirectory("media-dev-j26-services-");
            spool = Files.createTempDirectory("media-dev-j26-spool-");
            destination = Files.createTempDirectory("media-dev-j26-destination-").toRealPath();
            log = Files.createTempFile("media-dev-j26-process-", ".log");
            try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            classpath = services + java.io.File.pathSeparator + childClasspath;
            environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.putAll(kokoroEnvironment(modelRoot()));
            environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
            environment.put("MEDIA_DEV_REVIEW_ENABLED", "true");
            environment.put("MEDIA_DEV_CAPTION_REVIEW_REQUIRED", "true");
            environment.put("MEDIA_DEV_ERASURE_ENABLED", "true");
            environment.put("MEDIA_DEV_SPEECH_SPOOL_DIR", spool.toString());
            environment.put("MEDIA_DELIVERY_DEV_ENABLED", "true");
            environment.put("MEDIA_DELIVERY_DEV_DESTINATION_DIR", destination.toString());
            environment.put("MEDIA_WHISPER_CPP_BIN", modelRoot().resolve("runtimes/whisper.cpp-src/build-vulkan/bin/whisper-cli").toString());
            environment.put("MEDIA_WHISPER_CPP_THREADS", "8");
            environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpeg());
            environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe());
            environment.putAll(extra);
        }

        static Host start(String name, Map<String, String> extra, boolean render) throws Exception {
            Map<String, String> kokoro = kokoroEnvironment(modelRoot());
            Map<String, String> probe = new HashMap<>(kokoro);
            probe.put("MEDIA_WHISPER_CPP_BIN", modelRoot().resolve("runtimes/whisper.cpp-src/build-vulkan/bin/whisper-cli").toString());
            probe.put("MEDIA_WHISPER_CPP_THREADS", "8");
            assumeTrue(com.ghatana.tts.local.LocalKokoroTtsProvider.fromEnvironment(kokoro).ready(),
                    "the verified local Kokoro-82M install is required");
            assumeTrue(com.ghatana.stt.provider.LocalWhisperCppSttProvider.fromEnvironment(probe).ready(),
                    "the verified whisper.cpp runtime/model is required");
            assumeTrue(ffmpeg() != null && ffprobe() != null, "FFmpeg/FFprobe are required");
            Host host = new Host(name, extra, render);
            host.launcher = startLauncher(host.classpath, host.environment, host.log);
            awaitReady(host.launcher, host.port);
            return host;
        }

        void restart(Map<String, String> override) throws Exception {
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            environment.putAll(override);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
        }

        private String cached(String role, String principal, String... extra) throws Exception {
            long now = System.nanoTime();
            long[] until = expiry.get(role);
            if (until == null || now > until[0]) {
                tokens.put(role, issueDevToken(tenant, principal, extra));
                expiry.put(role, new long[] {now + java.util.concurrent.TimeUnit.SECONDS.toNanos(200)});
            }
            return tokens.get(role);
        }

        String token(String role) throws Exception {
            return switch (role) {
                case "owner" -> cached("owner", owner);
                case "reviewer" -> cached("reviewer", reviewer);
                case "confirmer" -> cached("confirmer", confirmer);
                case "other" -> cached("other", other);
                default -> throw new IllegalArgumentException(role);
            };
        }

        String exportToken() throws Exception {
            return cached("export", owner, "media:delivery:dev:export", "media:delivery:dev:read");
        }

        HttpResponse<String> send(String token, String method, String path, Object body) throws Exception {
            return MediaDevLiveFixtures.send(port, tenant, token, method, path, body == null ? null : JSON.writeValueAsString(body));
        }

        HttpResponse<String> owner(String method, String path, Object body) throws Exception {
            return send(token("owner"), method, path, body);
        }

        HttpResponse<String> owner(String method, String path, Object body, Map<String, String> headers) throws Exception {
            var request = java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:" + port + path))
                    .header("Authorization", "Bearer " + token("owner")).header("X-Tenant-Id", tenant);
            headers.forEach(request::header);
            request.method(method, java.net.http.HttpRequest.BodyPublishers.noBody());
            return java.net.http.HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString());
        }

        JsonNode post(String token, String path, Object body, int status) throws Exception {
            return MediaDevLiveFixtures.post(port, tenant, token, path, body, status);
        }

        JsonNode ownerPost(String path, Object body, int status) throws Exception { return post(token("owner"), path, body, status); }

        JsonNode ownerGet(String path, int status) throws Exception { return MediaDevLiveFixtures.get(port, tenant, token("owner"), path, status); }

        String upload(String fileName, String contentType, byte[] bytes) throws Exception {
            return MediaDevLiveFixtures.upload(port, tenant, owner, token("owner"), run + "-" + fileName, fileName, contentType, bytes);
        }

        Path deliveredFile(String requestId) throws Exception {
            return destination.resolve(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(
                    (tenant + "\u0000" + owner + "\u0000" + requestId).getBytes(StandardCharsets.UTF_8))) + ".bin");
        }

        boolean s3Exists(String key) {
            try (var s3 = s3(LOCALSTACK)) {
                s3.headObject(HeadObjectRequest.builder().bucket(bucket).key(key).build());
                return true;
            } catch (NoSuchKeyException absent) {
                return false;
            }
        }

        /** Spool entries (audio files) whose SHA-256 equals the digest. Reads names and hashes only. */
        List<Path> spoolFilesWithDigest(String sha256) throws Exception {
            List<Path> matches = new ArrayList<>();
            try (var files = Files.list(spool)) {
                for (Path file : files.filter(p -> p.getFileName().toString().endsWith(".wav")).toList()) {
                    if (sha256(Files.readAllBytes(file)).equals(sha256)) matches.add(file);
                }
            }
            return matches;
        }

        String operationState(String erasureId) throws Exception {
            try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                 var statement = connection.prepareStatement("SELECT state FROM media_erasure_operations WHERE tenant_id=? AND erasure_id=?")) {
                statement.setString(1, tenant);
                statement.setString(2, erasureId);
                try (var rows = statement.executeQuery()) { return rows.next() ? rows.getString(1) : null; }
            }
        }

        int count(String contentType) throws Exception {
            return MediaDevVoiceJourneySupport.countArtifacts(POSTGRES, tenant, owner, contentType);
        }

        Inventory inventory(List<String> ids) throws Exception {
            Inventory inventory = new Inventory();
            String in = ids.stream().map(id -> "'" + id + "'").collect(Collectors.joining(","));
            try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())) {
                try (var rows = connection.createStatement().executeQuery("SELECT artifact_id,object_reference,sha256 FROM media_artifacts WHERE tenant_id='"
                        + tenant + "' AND artifact_id IN (" + in + ")")) {
                    while (rows.next()) {
                        inventory.artifactRows++;
                        inventory.objectKeys.put(rows.getString(1), rows.getString(2).substring(("s3://" + bucket + "/").length()));
                        inventory.sha256.put(rows.getString(1), rows.getString(3));
                    }
                }
                inventory.lineageRows = scalar(connection, "SELECT count(*) FROM media_artifact_lineage WHERE tenant_id='" + tenant
                        + "' AND (source_artifact_id IN (" + in + ") OR derived_artifact_id IN (" + in + "))");
                inventory.deliveryRows = scalar(connection, "SELECT count(*) FROM media_delivery_operations WHERE tenant_id='" + tenant
                        + "' AND artifact_id IN (" + in + ")");
                inventory.uploadSessionRows = scalar(connection, "SELECT count(*) FROM media_upload_sessions WHERE tenant_id='" + tenant
                        + "' AND artifact_id IN (" + in + ")");
                inventory.tombstones = scalar(connection, "SELECT count(*) FROM media_erasure_tombstones WHERE tenant_id='" + tenant
                        + "' AND artifact_id IN (" + in + ")");
                inventory.reviewRows = scalar(connection, "SELECT count(*) FROM \"" + schema + "\".media_review_cases WHERE tenant_id='" + tenant
                        + "' AND subject_object_id IN (" + in + ")")
                        + scalar(connection, "SELECT count(*) FROM \"" + schema + "\".media_review_records r JOIN \"" + schema
                        + "\".media_review_cases c ON c.tenant_id=r.tenant_id AND c.review_case_id=r.review_case_id WHERE c.tenant_id='"
                        + tenant + "' AND c.subject_object_id IN (" + in + ")");
                inventory.completedLedgerRows = scalar(connection, "SELECT count(*) FROM media_dev_request_ledger WHERE tenant_id='" + tenant + "' AND state='COMPLETED'");
                inventory.erasedLedgerRows = scalar(connection, "SELECT count(*) FROM media_dev_request_ledger WHERE tenant_id='" + tenant + "' AND state='ERASED'");
                int referencing = 0;
                for (String id : ids) {
                    referencing += scalar(connection, "SELECT count(*) FROM media_dev_request_ledger WHERE tenant_id='" + tenant
                            + "' AND state='COMPLETED' AND outputs_json LIKE '%" + id + "%'");
                }
                inventory.completedLedgerRowsReferencing = referencing;
            }
            return inventory;
        }

        private static int scalar(java.sql.Connection connection, String sql) throws Exception {
            try (var rows = connection.createStatement().executeQuery(sql)) { rows.next(); return rows.getInt(1); }
        }

        @Override public void close() throws Exception {
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            deleteTree(services);
            deleteTree(spool);
            deleteTree(destination);
            if (passed) Files.deleteIfExists(log); else System.err.println("J-26 failure log retained at " + log);
        }
    }

    @SuppressWarnings("unused")
    private static final Class<?> CONTRACTS = MediaRuntimeContracts.class;
}
