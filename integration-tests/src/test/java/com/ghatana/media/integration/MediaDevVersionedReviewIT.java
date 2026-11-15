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
import tools.jackson.databind.node.ObjectNode;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevAudioSupport.syntheticClip;
import static com.ghatana.media.integration.MediaDevAudioSupport.wav;
import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffmpeg;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffprobe;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-21: version-specific review against a real launcher process (PostgreSQL + S3 + FFmpeg/FFprobe). A real MP4 is
 * registered as version 1 of an intake lineage; an assigned reviewer comments with time ranges and accepts that exact
 * immutable version (APPROVAL scope); the uploader cannot decide and an unassigned principal cannot even see the case.
 * A revised MP4 is registered as version 2: the earlier acceptance becomes STALE (never transferred), a decision on the
 * old version is a typed 409, and delivery of either version is refused until version 2 is itself accepted. An
 * approve-versus-revise race is run repeatedly and must always end in one of the two CAS-consistent outcomes. The
 * launcher is SIGKILLed and the readback is identical. A legal hold blocks erasure; erasure removes the version's
 * comments and decisions. TEST principals only: no decision here is a human or production approval.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevVersionedReviewIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private static final Map<String, Object> T0 = time(0);

    private static Map<String, Object> time(long ticks) {
        return Map.of("ticks", ticks, "rateNumerator", 1000, "rateDenominator", 1, "clock", "SOURCE_PRESENTATION");
    }

    @Test
    void approvalBindsToTheExactVersionGoesStaleOnRevisionAndGatesDeliveryUntilReReviewed() throws Exception {
        assumeTrue(ffmpeg() != null && ffprobe() != null, "FFmpeg/FFprobe tool paths are required");
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-vreview-" + run;
        String uploader = "test-principal-uploader-" + run;
        String reviewer = "test-principal-reviewer-" + run;
        String intruder = "test-principal-intruder-" + run;
        String confirmer = "test-principal-confirmer-" + run;
        String bucket = "media-dev-vreview-" + run.substring(0, 12);
        String schema = "media_dev_vreview_" + run.substring(0, 12);
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-vreview-services-");
        Path work = Files.createTempDirectory("media-dev-vreview-work-");
        Path destination = Files.createTempDirectory("media-dev-vreview-destination-");
        Path log = Files.createTempFile("media-dev-vreview-process-", ".log");
        Process launcher = null;
        boolean passed = false;
        try {
            try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
            environment.put("MEDIA_DEV_INTAKE_ENABLED", "true");
            environment.put("MEDIA_DEV_REVIEW_ENABLED", "true");
            environment.put("MEDIA_DEV_REVIEW_REQUIRED_FOR_DELIVERY", "true");
            environment.put("MEDIA_DEV_ERASURE_ENABLED", "true");
            environment.put("MEDIA_DELIVERY_DEV_ENABLED", "true");
            environment.put("MEDIA_DELIVERY_DEV_DESTINATION_DIR", destination.toString());
            environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpeg());
            environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe());
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            Api api = new Api(port, tenant);
            String exportPerms = "media:delivery:dev:export";
            String uploaderToken = issueDevToken(tenant, uploader, exportPerms, "media:delivery:dev:read");
            String reviewerToken = issueDevToken(tenant, reviewer);
            String intruderToken = issueDevToken(tenant, intruder);
            String confirmerToken = issueDevToken(tenant, confirmer);
            String foreignToken = issueDevToken(tenant + "-other", reviewer);

            // ================= 1. two real MP4 revisions of the same source =================
            byte[] mp4v1 = mp4(work, "v1.mp4", "testsrc2=size=320x240:rate=12:duration=3", 440);
            byte[] mp4v2 = mp4(work, "v2.mp4", "smptebars=size=320x240:rate=12:duration=3", 660);
            assertThat(mp4v1).isNotEqualTo(mp4v2);
            String lineage = "review-lineage-" + run;
            String id1 = upload(port, tenant, uploader, uploaderToken, run + "-v1", "cut-v1.mp4", "video/mp4", mp4v1);
            String ver1 = "sha256:" + sha256(mp4v1);
            JsonNode reg1 = api.post(uploaderToken, "/dev/v1/intakes", Map.of("lineageId", lineage, "artifactId", id1,
                    "artifactVersionId", ver1), 201);
            assertThat(reg1.path("versionNumber").asInt()).isEqualTo(1);
            // rights are a separate authority: external delivery of every exact version is attested by the uploader and
            // confirmed by a different (TEST) principal, so a later refusal is unambiguously the review gate.
            attestDelivery(api, uploaderToken, confirmerToken, id1, ver1);

            // ================= 2. no review case: delivery is refused with a typed review code =================
            HttpResponse<String> noReview = api.send(uploaderToken, "POST", "/dev/v1/exports",
                    export("export-noreview-" + run, id1, ver1));
            assertThat(noReview.statusCode()).as(noReview.body()).isEqualTo(409);
            assertThat(code(noReview)).isEqualTo("EXPORT_REVIEW_REQUIRED");
            assertThat(destinationFiles(destination)).isEmpty();

            // ================= 3. open the case on the exact version; roles =================
            JsonNode case1 = api.post(uploaderToken, "/dev/v1/reviews", Map.of("subject",
                    Map.of("kind", "ARTIFACT_VERSION", "artifactId", id1, "artifactVersionId", ver1)), 201);
            String caseId1 = case1.path("reviewCaseId").asString();
            assertThat(case1.path("establishesApproval").asBoolean()).isFalse();
            // an unassigned principal and another tenant see nothing: the case does not exist for them
            for (String[] who : new String[][] {{tenant, intruderToken}, {tenant + "-other", foreignToken}}) {
                Api view = new Api(port, who[0]);
                for (HttpResponse<String> hidden : List.of(
                        view.send(who[1], "GET", "/dev/v1/reviews/" + caseId1, null),
                        view.send(who[1], "GET", "/dev/v1/reviews/" + caseId1 + "/versions", null),
                        view.send(who[1], "GET", "/dev/v1/reviews/" + caseId1 + "/content", null),
                        view.sendJson(who[1], "POST", "/dev/v1/reviews/" + caseId1 + "/comments", comment("c-x", 0, "x", 0, 1)),
                        view.sendJson(who[1], "POST", "/dev/v1/reviews/" + caseId1 + "/decisions", decision("d-x", 0, "ACCEPT", "APPROVAL")))) {
                    assertThat(hidden.statusCode()).as(hidden.body()).isEqualTo(404);
                    assertThat(code(hidden)).isEqualTo("REVIEW_CASE_NOT_FOUND");
                }
            }
            // the uploader cannot approve (or reject) their own revision, before and after assigning a reviewer
            HttpResponse<String> selfApprove = api.sendJson(uploaderToken, "POST", "/dev/v1/reviews/" + caseId1 + "/decisions",
                    decision("d-self", 0, "ACCEPT", "APPROVAL"));
            assertThat(selfApprove.statusCode()).as(selfApprove.body()).isEqualTo(403);
            assertThat(code(selfApprove)).isEqualTo("REVIEWER_NOT_ASSIGNED");
            HttpResponse<String> selfAssign = api.sendJson(uploaderToken, "POST", "/dev/v1/reviews/" + caseId1 + "/assignments",
                    assignment("a-self", 0, uploader, List.of("APPROVAL")));
            assertThat(selfAssign.statusCode()).as(selfAssign.body()).isEqualTo(422);
            assertThat(code(selfAssign)).isEqualTo("REVIEW_SELF_ASSIGNMENT_REFUSED");
            // a reviewer cannot assign themselves or anyone (owner only)
            api.post(uploaderToken, "/dev/v1/reviews/" + caseId1 + "/assignments",
                    assignment("a-r1", 0, reviewer, List.of("QUALITY", "APPROVAL")), 201);
            HttpResponse<String> reviewerAssigns = api.sendJson(reviewerToken, "POST", "/dev/v1/reviews/" + caseId1 + "/assignments",
                    assignment("a-r1-x", rev(api, reviewerToken, caseId1), intruder, List.of("APPROVAL")));
            assertThat(reviewerAssigns.statusCode()).as(reviewerAssigns.body()).isEqualTo(403);
            selfApprove = api.sendJson(uploaderToken, "POST", "/dev/v1/reviews/" + caseId1 + "/decisions",
                    decision("d-self-2", rev(api, uploaderToken, caseId1), "ACCEPT", "APPROVAL"));
            assertThat(selfApprove.statusCode()).as("the uploader still cannot decide").isEqualTo(403);
            assertThat(code(selfApprove)).isEqualTo("REVIEWER_NOT_ASSIGNED");

            // ================= 4. the reviewer reads the exact bytes, comments time-coded, accepts =================
            JsonNode mine = api.get(reviewerToken, "/dev/v1/reviews", 200);
            assertThat(mine.path("assignedToMe").size()).isEqualTo(1);
            assertThat(mine.path("assignedToMe").get(0).path("reviewCaseId").asString()).isEqualTo(caseId1);
            HttpResponse<byte[]> full = api.bytes(reviewerToken, "/dev/v1/reviews/" + caseId1 + "/content", null);
            assertThat(full.statusCode()).isEqualTo(200);
            assertThat(full.body()).as("the reviewer receives exactly version 1's bytes").isEqualTo(mp4v1);
            assertThat(full.headers().firstValue("ETag").orElse("")).isEqualTo("\"" + ver1 + "\"");
            HttpResponse<byte[]> ranged = api.bytes(reviewerToken, "/dev/v1/reviews/" + caseId1 + "/content", "bytes=100-299");
            assertThat(ranged.statusCode()).isEqualTo(206);
            assertThat(ranged.body()).isEqualTo(Arrays.copyOfRange(mp4v1, 100, 300));
            assertThat(api.send(intruderToken, "GET", "/dev/v1/reviews/" + caseId1 + "/content", null).statusCode()).isEqualTo(404);

            HttpResponse<String> badRange = api.sendJson(reviewerToken, "POST", "/dev/v1/reviews/" + caseId1 + "/comments",
                    comment("c-bad", rev(api, reviewerToken, caseId1), "inverted range", 2000, 1000));
            assertThat(badRange.statusCode()).as(badRange.body()).isEqualTo(400);
            JsonNode c1 = api.post(reviewerToken, "/dev/v1/reviews/" + caseId1 + "/comments",
                    comment("c-1", rev(api, reviewerToken, caseId1), "Logo flicker around 0.5 s", 500, 1200), 201);
            assertThat(c1.path("currentness").asString()).isEqualTo("CURRENT");
            api.post(reviewerToken, "/dev/v1/reviews/" + caseId1 + "/comments",
                    comment("c-2", rev(api, reviewerToken, caseId1), "Colour shifts after 2 s", 2000, 2800), 201);
            api.post(uploaderToken, "/dev/v1/reviews/" + caseId1 + "/comments",
                    comment("c-3", rev(api, uploaderToken, caseId1), "Will fix in the next cut", 500, 1200), 201);
            // wrong scope and a QUALITY-only accept do not open delivery
            HttpResponse<String> wrongScope = api.sendJson(reviewerToken, "POST", "/dev/v1/reviews/" + caseId1 + "/decisions",
                    decision("d-rights", rev(api, reviewerToken, caseId1), "ACCEPT", "RIGHTS"));
            assertThat(wrongScope.statusCode()).as(wrongScope.body()).isEqualTo(403);
            assertThat(code(wrongScope)).isEqualTo("REVIEW_SCOPE_NOT_ASSIGNED");
            api.post(reviewerToken, "/dev/v1/reviews/" + caseId1 + "/decisions",
                    decision("d-quality", rev(api, reviewerToken, caseId1), "ACCEPT", "QUALITY"), 201);
            HttpResponse<String> qualityOnly = api.send(uploaderToken, "POST", "/dev/v1/exports",
                    export("export-quality-" + run, id1, ver1));
            assertThat(qualityOnly.statusCode()).as(qualityOnly.body()).isEqualTo(409);
            assertThat(code(qualityOnly)).isEqualTo("EXPORT_REVIEW_APPROVAL_SCOPE_REQUIRED");
            // a stale expectedCaseRevision is a CAS miss, not a silent overwrite
            HttpResponse<String> casMiss = api.sendJson(reviewerToken, "POST", "/dev/v1/reviews/" + caseId1 + "/decisions",
                    decision("d-cas", 0, "ACCEPT", "APPROVAL"));
            assertThat(casMiss.statusCode()).as(casMiss.body()).isEqualTo(409);
            assertThat(code(casMiss)).isEqualTo("REVIEW_CASE_REVISION_CONFLICT");
            JsonNode accept1 = api.post(reviewerToken, "/dev/v1/reviews/" + caseId1 + "/decisions",
                    decision("d-approve-1", rev(api, reviewerToken, caseId1), "ACCEPT", "APPROVAL"), 201);
            assertThat(accept1.path("establishesApproval").asBoolean()).isFalse();
            assertThat(accept1.path("currentness").asString()).isEqualTo("CURRENT");
            JsonNode replay = api.post(reviewerToken, "/dev/v1/reviews/" + caseId1 + "/decisions",
                    decision("d-approve-1", accept1.path("caseRevision").asLong() - 1, "ACCEPT", "APPROVAL"), 200);
            assertThat(replay.path("replayed").asBoolean()).isTrue();
            assertThat(replay.path("appendRecordId").asString()).isEqualTo(accept1.path("appendRecordId").asString());

            JsonNode view1 = api.get(reviewerToken, "/dev/v1/reviews/" + caseId1, 200);
            assertThat(view1.path("role").asString()).isEqualTo("REVIEWER");
            assertThat(view1.path("reviewState").path("status").asString()).isEqualTo("DEV_ASSIGNED_REVIEWER_ACCEPT_CURRENT");
            assertThat(view1.path("reviewState").path("humanReviewApproval").asBoolean()).isFalse();
            int timeCoded = 0;
            for (JsonNode record : view1.path("records")) {
                if ("COMMENT".equals(record.path("kind").asString()) && record.path("annotation").has("timeRange")) timeCoded++;
            }
            assertThat(timeCoded).as("three time-coded comments recorded").isEqualTo(3);
            JsonNode versions1 = api.get(reviewerToken, "/dev/v1/reviews/" + caseId1 + "/versions", 200);
            assertThat(versions1.path("versions").size()).isEqualTo(1);
            assertThat(versions1.path("versions").get(0).path("state").asString()).isEqualTo("ACCEPT_CURRENT");
            assertThat(versions1.path("versions").get(0).path("acceptedForHead").asBoolean()).isTrue();

            // delivery of the accepted head is admitted and the destination holds exactly version 1
            JsonNode exported1 = api.post(uploaderToken, "/dev/v1/exports", exportMap("export-v1-" + run, id1, ver1), 201);
            assertThat(exported1.path("status").asString()).isEqualTo("DESTINATION_CONFIRMED");
            assertThat(destinationFiles(destination)).hasSize(1);
            assertThat(Files.readAllBytes(destinationFiles(destination).get(0))).isEqualTo(mp4v1);

            // ================= 5. the source is revised: version 2 =================
            String id2 = upload(port, tenant, uploader, uploaderToken, run + "-v2", "cut-v2.mp4", "video/mp4", mp4v2);
            String ver2 = "sha256:" + sha256(mp4v2);
            attestDelivery(api, uploaderToken, confirmerToken, id2, ver2);
            JsonNode reg2 = api.post(uploaderToken, "/dev/v1/intakes", Map.of("lineageId", lineage, "artifactId", id2,
                    "artifactVersionId", ver2), 201);
            assertThat(reg2.path("versionNumber").asInt()).isEqualTo(2);
            assertThat(reg2.path("parentArtifactVersionId").asString()).isEqualTo(ver1);

            JsonNode ownerLineage = api.get(uploaderToken, "/dev/v1/review-lineages/" + lineage, 200);
            JsonNode reviewerLineage = api.get(reviewerToken, "/dev/v1/reviews/" + caseId1 + "/versions", 200);
            for (JsonNode lineageView : List.of(ownerLineage, reviewerLineage)) {
                assertThat(lineageView.path("headVersionNumber").asInt()).isEqualTo(2);
                JsonNode first = lineageView.path("versions").get(0);
                assertThat(first.path("state").asString()).as("the earlier acceptance is STALE, never transferred")
                        .isEqualTo("ACCEPT_STALE");
                assertThat(first.path("superseded").asBoolean()).isTrue();
                assertThat(first.path("acceptedForHead").asBoolean()).isFalse();
                JsonNode second = lineageView.path("versions").get(1);
                assertThat(second.path("head").asBoolean()).isTrue();
                assertThat(second.path("acceptedForHead").asBoolean()).isFalse();
                assertThat(second.path("latestDecision").isNull()).isTrue();
            }
            assertThat(ownerLineage.path("versions").get(1).path("state").asString()).isEqualTo("NOT_REVIEWED");
            assertThat(reviewerLineage.path("versions").get(1).path("state").asString()).isEqualTo("NOT_ASSIGNED");
            JsonNode staleView = api.get(reviewerToken, "/dev/v1/reviews/" + caseId1, 200);
            assertThat(staleView.path("currentness").asString()).isEqualTo("STALE");
            assertThat(staleView.path("reviewState").path("status").asString()).isEqualTo("DEV_ASSIGNED_REVIEWER_ACCEPT_STALE");
            assertThat(staleView.path("lineage").path("superseded").asBoolean()).isTrue();
            // a decision on the superseded version is a typed 409 and records nothing
            HttpResponse<String> late = api.sendJson(reviewerToken, "POST", "/dev/v1/reviews/" + caseId1 + "/decisions",
                    decision("d-late", rev(api, reviewerToken, caseId1), "ACCEPT", "APPROVAL"));
            assertThat(late.statusCode()).as(late.body()).isEqualTo(409);
            assertThat(code(late)).isEqualTo("REVIEW_SUBJECT_STALE");
            assertThat(api.get(reviewerToken, "/dev/v1/reviews/" + caseId1, 200).path("caseRevision").asLong())
                    .isEqualTo(staleView.path("caseRevision").asLong());
            // delivery: the superseded version and the unreviewed new head are both refused; nothing new is written
            HttpResponse<String> staleExport = api.send(uploaderToken, "POST", "/dev/v1/exports",
                    export("export-v1-again-" + run, id1, ver1));
            assertThat(staleExport.statusCode()).as(staleExport.body()).isEqualTo(409);
            assertThat(code(staleExport)).isEqualTo("EXPORT_REVIEW_SUPERSEDED");
            HttpResponse<String> unreviewedExport = api.send(uploaderToken, "POST", "/dev/v1/exports",
                    export("export-v2-early-" + run, id2, ver2));
            assertThat(unreviewedExport.statusCode()).as(unreviewedExport.body()).isEqualTo(409);
            assertThat(code(unreviewedExport)).isEqualTo("EXPORT_REVIEW_REQUIRED");
            assertThat(destinationFiles(destination)).as("only version 1's earlier export exists").hasSize(1);
            // a case for the superseded version cannot be freshly opened; the existing one stays readable (history)
            api.post(uploaderToken, "/dev/v1/reviews", Map.of("subject",
                    Map.of("kind", "ARTIFACT_VERSION", "artifactId", id1, "artifactVersionId", ver1)), 200);

            // ================= 6. re-review of the new head =================
            JsonNode case2 = api.post(uploaderToken, "/dev/v1/reviews", Map.of("subject",
                    Map.of("kind", "ARTIFACT_VERSION", "artifactId", id2, "artifactVersionId", ver2)), 201);
            String caseId2 = case2.path("reviewCaseId").asString();
            assertThat(caseId2).isNotEqualTo(caseId1);
            assertThat(api.send(reviewerToken, "GET", "/dev/v1/reviews/" + caseId2, null).statusCode())
                    .as("the reviewer holds no assignment on the new version's case").isEqualTo(404);
            api.post(uploaderToken, "/dev/v1/reviews/" + caseId2 + "/assignments",
                    assignment("a-r2", 0, reviewer, List.of("QUALITY", "APPROVAL")), 201);
            assertThat(api.sendJson(uploaderToken, "POST", "/dev/v1/reviews/" + caseId2 + "/decisions",
                    decision("d-self-v2", rev(api, uploaderToken, caseId2), "ACCEPT", "APPROVAL")).statusCode()).isEqualTo(403);
            assertThat(api.bytes(reviewerToken, "/dev/v1/reviews/" + caseId2 + "/content", null).body()).isEqualTo(mp4v2);
            api.post(reviewerToken, "/dev/v1/reviews/" + caseId2 + "/decisions",
                    decision("d-changes", rev(api, reviewerToken, caseId2), "REQUEST_CHANGES", "APPROVAL"), 201);
            HttpResponse<String> changes = api.send(uploaderToken, "POST", "/dev/v1/exports", export("export-v2-changes-" + run, id2, ver2));
            assertThat(changes.statusCode()).as(changes.body()).isEqualTo(409);
            assertThat(code(changes)).isEqualTo("EXPORT_REVIEW_NOT_ACCEPTED");
            api.post(reviewerToken, "/dev/v1/reviews/" + caseId2 + "/comments",
                    comment("c2-1", rev(api, reviewerToken, caseId2), "Bars look correct", 0, 3000), 201);
            api.post(reviewerToken, "/dev/v1/reviews/" + caseId2 + "/decisions",
                    decision("d-approve-2", rev(api, reviewerToken, caseId2), "ACCEPT", "APPROVAL"), 201);
            JsonNode exported2 = api.post(uploaderToken, "/dev/v1/exports", exportMap("export-v2-" + run, id2, ver2), 201);
            assertThat(exported2.path("status").asString()).isEqualTo("DESTINATION_CONFIRMED");
            List<Path> delivered = destinationFiles(destination);
            assertThat(delivered).hasSize(2);
            List<byte[]> deliveredBytes = new ArrayList<>();
            for (Path file : delivered) deliveredBytes.add(Files.readAllBytes(file));
            assertThat(deliveredBytes).anySatisfy(bytes -> assertThat(bytes).isEqualTo(mp4v2));
            JsonNode finalLineage = api.get(reviewerToken, "/dev/v1/reviews/" + caseId2 + "/versions", 200);
            assertThat(finalLineage.path("versions").get(0).path("state").asString()).isEqualTo("ACCEPT_STALE");
            assertThat(finalLineage.path("versions").get(1).path("state").asString()).isEqualTo("ACCEPT_CURRENT");
            assertThat(finalLineage.path("versions").get(1).path("acceptedForHead").asBoolean()).isTrue();

            // ================= 7. revocation stops the reviewer; decisions already recorded are unchanged =================
            JsonNode assigned2 = api.get(uploaderToken, "/dev/v1/reviews/" + caseId2, 200);
            String assignment2 = assigned2.path("assignments").get(0).path("assignmentId").asString();
            api.post(uploaderToken, "/dev/v1/reviews/" + caseId2 + "/assignments/" + assignment2 + "/revoke",
                    Map.of("requestId", "revoke-2", "expectedCaseRevision", assigned2.path("caseRevision").asLong()), 200);
            HttpResponse<String> revokedDecision = api.sendJson(reviewerToken, "POST", "/dev/v1/reviews/" + caseId2 + "/decisions",
                    decision("d-after-revoke", 0, "REJECT", "APPROVAL"));
            assertThat(revokedDecision.statusCode()).as(revokedDecision.body()).isEqualTo(403);
            assertThat(code(revokedDecision)).isEqualTo("REVIEWER_NOT_ASSIGNED");
            assertThat(api.send(reviewerToken, "GET", "/dev/v1/reviews/" + caseId2 + "/content", null).statusCode()).isEqualTo(403);
            assertThat(api.send(reviewerToken, "GET", "/dev/v1/reviews/" + caseId2, null).statusCode())
                    .as("a revoked reviewer can no longer read the case").isEqualTo(403);

            // ================= 8. approve-versus-revise race: always one CAS-consistent outcome =================
            int approvedFirst = 0;
            int revisedFirst = 0;
            for (int round = 0; round < 8; round++) {
                String raceLineage = "race-" + round + "-" + run;
                byte[] a = wav(16_000, syntheticClip(16_000, 0.6, 1000 + round));
                byte[] b = wav(16_000, syntheticClip(16_000, 0.6, 5000 + round));
                String ida = upload(port, tenant, uploader, uploaderToken, run + "-ra" + round, "race-a.wav", "audio/wav", a);
                String idb = upload(port, tenant, uploader, uploaderToken, run + "-rb" + round, "race-b.wav", "audio/wav", b);
                String va = "sha256:" + sha256(a);
                String vb = "sha256:" + sha256(b);
                api.post(uploaderToken, "/dev/v1/intakes", Map.of("lineageId", raceLineage, "artifactId", ida,
                        "artifactVersionId", va), 201);
                String raceCase = api.post(uploaderToken, "/dev/v1/reviews", Map.of("subject",
                        Map.of("kind", "ARTIFACT_VERSION", "artifactId", ida, "artifactVersionId", va)), 201)
                        .path("reviewCaseId").asString();
                api.post(uploaderToken, "/dev/v1/reviews/" + raceCase + "/assignments",
                        assignment("race-a-" + round, 0, reviewer, List.of("APPROVAL")), 201);
                long revision = rev(api, reviewerToken, raceCase);
                final String raceReviewerToken = reviewerToken;
                final String raceUploaderToken = uploaderToken;
                final long approveDelayMs = round * 45L; // sweeps the approve across the registration's probe window
                CountDownLatch go = new CountDownLatch(1);
                ExecutorService pool = Executors.newFixedThreadPool(2);
                try {
                    Future<HttpResponse<String>> approve = pool.submit(() -> {
                        go.await();
                        Thread.sleep(approveDelayMs);
                        return api.sendJson(raceReviewerToken, "POST", "/dev/v1/reviews/" + raceCase + "/decisions",
                                decision("race-approve-" + raceLineage, revision, "ACCEPT", "APPROVAL"));
                    });
                    Future<HttpResponse<String>> revise = pool.submit(() -> {
                        go.await();
                        return api.send(raceUploaderToken, "POST", "/dev/v1/intakes", JSON.writeValueAsString(
                                Map.of("lineageId", raceLineage, "artifactId", idb, "artifactVersionId", vb)));
                    });
                    go.countDown();
                    HttpResponse<String> approved = approve.get(60, TimeUnit.SECONDS);
                    HttpResponse<String> revised = revise.get(60, TimeUnit.SECONDS);
                    assertThat(revised.statusCode()).as(revised.body()).isEqualTo(201);
                    JsonNode state = api.get(uploaderToken, "/dev/v1/review-lineages/" + raceLineage, 200);
                    assertThat(state.path("versions").get(1).path("state").asString())
                            .as("the new version never inherits an approval").isEqualTo("NOT_REVIEWED");
                    assertThat(state.path("versions").get(1).path("acceptedForHead").asBoolean()).isFalse();
                    if (approved.statusCode() == 201) {
                        approvedFirst++;
                        assertThat(state.path("versions").get(0).path("state").asString()).isEqualTo("ACCEPT_STALE");
                    } else {
                        revisedFirst++;
                        assertThat(approved.statusCode()).as(approved.body()).isEqualTo(409);
                        assertThat(code(approved)).isEqualTo("REVIEW_SUBJECT_STALE");
                        assertThat(state.path("versions").get(0).path("state").asString()).isEqualTo("IN_REVIEW");
                        assertThat(state.path("versions").get(0).path("latestDecision").isNull()).isTrue();
                    }
                    HttpResponse<String> exportB = api.send(uploaderToken, "POST", "/dev/v1/exports",
                            export("race-export-" + round + "-" + run, idb, vb));
                    assertThat(exportB.statusCode()).as("the revised version is never deliverable on the older approval")
                            .isEqualTo(409);
                } finally {
                    pool.shutdownNow();
                }
            }
            System.out.println("J21_RACE approveFirst=" + approvedFirst + " reviseFirst=" + revisedFirst);

            // ================= 9. restart (SIGKILL): readback is identical =================
            Map<String, JsonNode> before = readback(api, uploaderToken, reviewerToken, lineage, caseId1, caseId2);
            launcher.destroyForcibly();
            assertThat(launcher.waitFor(15, TimeUnit.SECONDS)).isTrue();
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            uploaderToken = issueDevToken(tenant, uploader, exportPerms, "media:delivery:dev:read");
            reviewerToken = issueDevToken(tenant, reviewer);
            assertThat(readback(api, uploaderToken, reviewerToken, lineage, caseId1, caseId2))
                    .as("review state, comments, decisions and per-version approval state survive SIGKILL unchanged")
                    .isEqualTo(before);
            HttpResponse<String> afterRestart = api.send(uploaderToken, "POST", "/dev/v1/exports",
                    export("export-v1-after-restart-" + run, id1, ver1));
            assertThat(code(afterRestart)).isEqualTo("EXPORT_REVIEW_SUPERSEDED");

            // ================= 10. retention: a legal hold blocks erasure; erasure removes comments and decisions =================
            JsonNode hold = api.post(uploaderToken, "/dev/v1/legal-holds", Map.of("requestId", "hold-" + run,
                    "artifactId", id1, "reason", "TEST legal hold on the reviewed version"), 201);
            JsonNode plan = api.get(uploaderToken, "/dev/v1/erasure-plans/" + id1, 200);
            int treeSize = plan.path("artifacts").size();
            HttpResponse<String> held = api.send(uploaderToken, "POST", "/dev/v1/erasures",
                    JSON.writeValueAsString(Map.of("erasureId", "erase-held-" + run, "artifactId", id1, "confirm", true,
                            "expectedArtifactCount", treeSize)));
            assertThat(held.statusCode()).as(held.body()).isEqualTo(409);
            assertThat(held.body()).contains("LEGAL_HOLD_ACTIVE");
            assertThat(api.get(reviewerToken, "/dev/v1/reviews/" + caseId1, 200).path("records").size())
                    .as("a held version keeps its comments and decisions").isEqualTo(view1.path("records").size());
            assertThat(reviewRows(schema, caseId1, "media_review_records")).isGreaterThan(0);
            api.post(uploaderToken, "/dev/v1/legal-holds/" + hold.path("holdId").asString() + "/release",
                    Map.of("reason", "TEST matter closed"), 200);
            api.post(uploaderToken, "/dev/v1/erasures", Map.of("erasureId", "erase-" + run, "artifactId", id1, "confirm", true,
                    "expectedArtifactCount", treeSize), 201);
            assertThat(api.send(uploaderToken, "GET", "/dev/v1/reviews/" + caseId1, null).statusCode()).isEqualTo(404);
            assertThat(api.send(reviewerToken, "GET", "/dev/v1/reviews/" + caseId1, null).statusCode()).isEqualTo(404);
            assertThat(reviewRows(schema, caseId1, "media_review_records")).as("comments and decisions erased").isZero();
            assertThat(reviewRows(schema, caseId1, "media_review_assignment_versions")).as("assignments erased").isZero();
            assertThat(reviewRows(schema, caseId2, "media_review_records")).as("the other version's review is untouched")
                    .isGreaterThan(0);
            JsonNode afterErase = api.get(uploaderToken, "/dev/v1/review-lineages/" + lineage, 200);
            assertThat(afterErase.path("versions").size()).as("the erased version leaves the lineage").isEqualTo(1);
            assertThat(afterErase.path("versions").get(0).path("artifactId").asString()).isEqualTo(id2);
            passed = true;
        } finally {
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            if (passed) Files.deleteIfExists(log); else System.err.println("versioned review IT log retained at " + log);
            deleteTree(services);
            deleteTree(work);
            deleteTree(destination);
        }
    }

    /**
     * Erasing the lineage head restores the earlier version as head. Its ACCEPT was a decision on v1's exact digest and
     * v1 is unchanged, so it becomes CURRENT again, but only visibly: the lineage read names the erasure that changed the
     * head (headChangedBy ERASURE with the erased version, erasure id and time), export admission still requires that
     * current ACCEPT, and the revival survives a SIGKILL restart unchanged.
     */
    @Test
    void erasingTheHeadRestoresTheEarlierAcceptanceVisiblyAndSurvivesRestart() throws Exception {
        assumeTrue(ffmpeg() != null && ffprobe() != null, "FFmpeg/FFprobe tool paths are required");
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-vrevive-" + run;
        String uploader = "test-principal-uploader-" + run;
        String reviewer = "test-principal-reviewer-" + run;
        String confirmer = "test-principal-confirmer-" + run;
        String bucket = "media-dev-vrevive-" + run.substring(0, 12);
        String schema = "media_dev_vrevive_" + run.substring(0, 12);
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-vrevive-services-");
        Path work = Files.createTempDirectory("media-dev-vrevive-work-");
        Path destination = Files.createTempDirectory("media-dev-vrevive-destination-");
        Path log = Files.createTempFile("media-dev-vrevive-process-", ".log");
        Process launcher = null;
        boolean passed = false;
        try {
            try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
            environment.put("MEDIA_DEV_INTAKE_ENABLED", "true");
            environment.put("MEDIA_DEV_REVIEW_ENABLED", "true");
            environment.put("MEDIA_DEV_REVIEW_REQUIRED_FOR_DELIVERY", "true");
            environment.put("MEDIA_DEV_ERASURE_ENABLED", "true");
            environment.put("MEDIA_DELIVERY_DEV_ENABLED", "true");
            environment.put("MEDIA_DELIVERY_DEV_DESTINATION_DIR", destination.toString());
            environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpeg());
            environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe());
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            Api api = new Api(port, tenant);
            String exportPerms = "media:delivery:dev:export";
            String uploaderToken = issueDevToken(tenant, uploader, exportPerms, "media:delivery:dev:read");
            String reviewerToken = issueDevToken(tenant, reviewer);
            String confirmerToken = issueDevToken(tenant, confirmer);

            byte[] mp4v1 = mp4(work, "v1.mp4", "testsrc2=size=320x240:rate=12:duration=3", 440);
            byte[] mp4v2 = mp4(work, "v2.mp4", "smptebars=size=320x240:rate=12:duration=3", 660);
            String lineage = "revive-lineage-" + run;

            // v1 registered, reviewed and accepted on its exact digest
            String id1 = upload(port, tenant, uploader, uploaderToken, run + "-v1", "cut-v1.mp4", "video/mp4", mp4v1);
            String ver1 = "sha256:" + sha256(mp4v1);
            api.post(uploaderToken, "/dev/v1/intakes", Map.of("lineageId", lineage, "artifactId", id1,
                    "artifactVersionId", ver1), 201);
            attestDelivery(api, uploaderToken, confirmerToken, id1, ver1);
            String caseId1 = api.post(uploaderToken, "/dev/v1/reviews", Map.of("subject",
                    Map.of("kind", "ARTIFACT_VERSION", "artifactId", id1, "artifactVersionId", ver1)), 201)
                    .path("reviewCaseId").asString();
            api.post(uploaderToken, "/dev/v1/reviews/" + caseId1 + "/assignments",
                    assignment("a-r1", 0, reviewer, List.of("APPROVAL")), 201);
            JsonNode accept1 = api.post(reviewerToken, "/dev/v1/reviews/" + caseId1 + "/decisions",
                    decision("d-approve-1", rev(api, reviewerToken, caseId1), "ACCEPT", "APPROVAL"), 201);
            assertThat(accept1.path("currentness").asString()).isEqualTo("CURRENT");

            // v2 registered: v1's acceptance is STALE
            String id2 = upload(port, tenant, uploader, uploaderToken, run + "-v2", "cut-v2.mp4", "video/mp4", mp4v2);
            String ver2 = "sha256:" + sha256(mp4v2);
            attestDelivery(api, uploaderToken, confirmerToken, id2, ver2);
            api.post(uploaderToken, "/dev/v1/intakes", Map.of("lineageId", lineage, "artifactId", id2,
                    "artifactVersionId", ver2), 201);
            assertThat(api.get(uploaderToken, "/dev/v1/review-lineages/" + lineage, 200)
                    .path("versions").get(0).path("state").asString()).isEqualTo("ACCEPT_STALE");

            // erase v2 (the head) through the DEV erasure route
            JsonNode plan2 = api.get(uploaderToken, "/dev/v1/erasure-plans/" + id2, 200);
            api.post(uploaderToken, "/dev/v1/erasures", Map.of("erasureId", "erase-head-" + run, "artifactId", id2,
                    "confirm", true, "expectedArtifactCount", plan2.path("artifacts").size()), 201);

            // v1 is head again; its decision is CURRENT for its exact, unchanged digest, and the revival is visible
            JsonNode revived = api.get(uploaderToken, "/dev/v1/review-lineages/" + lineage, 200);
            assertThat(revived.path("headVersionNumber").asInt()).isEqualTo(1);
            assertThat(revived.path("versions").size()).isEqualTo(1);
            JsonNode head = revived.path("versions").get(0);
            assertThat(head.path("artifactVersionId").asString()).isEqualTo(ver1);
            assertThat(head.path("head").asBoolean()).isTrue();
            assertThat(head.path("superseded").asBoolean()).isFalse();
            assertThat(head.path("state").asString()).isEqualTo("ACCEPT_CURRENT");
            assertThat(head.path("acceptedForHead").asBoolean()).isTrue();
            assertThat(revived.path("headChangedBy").asString())
                    .as("the head changed because of an erasure, and the read says so").isEqualTo("ERASURE");
            JsonNode change = revived.path("headChange");
            assertThat(change.path("erasedArtifactVersionId").asString()).isEqualTo(ver2);
            assertThat(change.path("erasedVersionNumber").asInt()).isEqualTo(2);
            assertThat(change.path("erasureId").asString()).isEqualTo("erase-head-" + run);
            assertThat(change.path("erasedAt").asString()).isNotBlank();

            JsonNode reviewerView = api.get(reviewerToken, "/dev/v1/reviews/" + caseId1, 200);
            assertThat(reviewerView.path("currentness").asString()).isEqualTo("CURRENT");
            assertThat(reviewerView.path("reviewState").path("status").asString())
                    .isEqualTo("DEV_ASSIGNED_REVIEWER_ACCEPT_CURRENT");
            assertThat(reviewerView.path("lineage").path("headChangedBy").asString()).isEqualTo("ERASURE");

            // export admission follows the revived, current ACCEPT of the exact v1 bytes
            JsonNode exported = api.post(uploaderToken, "/dev/v1/exports", exportMap("export-revived-" + run, id1, ver1), 201);
            assertThat(exported.path("status").asString()).isEqualTo("DESTINATION_CONFIRMED");
            List<Path> delivered = destinationFiles(destination);
            assertThat(delivered).hasSize(1);
            assertThat(Files.readAllBytes(delivered.get(0))).as("exactly version 1's bytes").isEqualTo(mp4v1);

            // SIGKILL: the revival and its attribution survive unchanged
            launcher.destroyForcibly();
            assertThat(launcher.waitFor(15, TimeUnit.SECONDS)).isTrue();
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            uploaderToken = issueDevToken(tenant, uploader, exportPerms, "media:delivery:dev:read");
            reviewerToken = issueDevToken(tenant, reviewer);
            assertThat(api.get(uploaderToken, "/dev/v1/review-lineages/" + lineage, 200))
                    .as("the lineage read after restart is identical").isEqualTo(revived);
            assertThat(stable(api.get(reviewerToken, "/dev/v1/reviews/" + caseId1, 200)))
                    .as("the reviewer's case view after restart is identical (clock fields aside)")
                    .isEqualTo(stable(reviewerView));
            passed = true;
        } finally {
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            if (passed) Files.deleteIfExists(log); else System.err.println("head-erasure revival IT log retained at " + log);
            deleteTree(services);
            deleteTree(work);
            deleteTree(destination);
        }
    }

    // ---------------------------------------------------------------------------------------------------- helpers

    private record Api(int port, String tenant) {
        HttpResponse<String> send(String token, String method, String path, String body) throws Exception {
            return MediaDevLiveFixtures.send(port, tenant, token, method, path, body);
        }

        HttpResponse<String> sendJson(String token, String method, String path, Map<String, Object> body) throws Exception {
            return send(token, method, path, JSON.writeValueAsString(body));
        }

        JsonNode post(String token, String path, Map<String, Object> body, int status) throws Exception {
            return MediaDevLiveFixtures.post(port, tenant, token, path, body, status);
        }

        JsonNode get(String token, String path, int status) throws Exception {
            return MediaDevLiveFixtures.get(port, tenant, token, path, status);
        }

        HttpResponse<byte[]> bytes(String token, String path, String range) throws Exception {
            HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                    .header("Authorization", "Bearer " + token).header("X-Tenant-Id", tenant);
            if (range != null) request.header("Range", range);
            return HttpClient.newHttpClient().send(request.GET().build(), HttpResponse.BodyHandlers.ofByteArray());
        }
    }

    private static String code(HttpResponse<String> response) throws Exception {
        return JSON.readTree(response.body()).path("error").path("code").asString();
    }

    private static long rev(Api api, String token, String caseId) throws Exception {
        return api.get(token, "/dev/v1/reviews/" + caseId, 200).path("caseRevision").asLong();
    }

    private static Map<String, Object> comment(String requestId, long revision, String text, long startMs, long endMs) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("expectedCaseRevision", revision);
        body.put("text", text);
        body.put("disposition", "OPEN");
        body.put("annotation", Map.of("timeRange", Map.of("start", time(startMs), "end", time(endMs))));
        return body;
    }

    private static Map<String, Object> decision(String requestId, long revision, String decision, String scope) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("expectedCaseRevision", revision);
        body.put("decision", decision);
        body.put("reason", "TEST reviewer statement for " + decision + " (" + scope + "); not a human approval");
        body.put("confirmed", true);
        body.put("scope", scope);
        return body;
    }

    private static Map<String, Object> assignment(String requestId, long revision, String reviewer, List<String> scopes) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("expectedCaseRevision", revision);
        body.put("reviewerPrincipalId", reviewer);
        body.put("scopes", scopes);
        body.put("expiresAt", Instant.now().plus(2, ChronoUnit.HOURS).truncatedTo(ChronoUnit.SECONDS).toString());
        return body;
    }

    private static Map<String, Object> exportMap(String requestId, String artifactId, String version) {
        return Map.of("requestId", requestId, "artifactId", artifactId, "artifactVersionId", version,
                "destinationId", "dev-local-directory");
    }

    private static String export(String requestId, String artifactId, String version) throws Exception {
        return JSON.writeValueAsString(exportMap(requestId, artifactId, version));
    }

    private static void attestDelivery(Api api, String ownerToken, String confirmerToken, String artifactId, String version)
            throws Exception {
        String attestation = api.post(ownerToken, "/dev/v1/rights/attestations", Map.of("artifactId", artifactId,
                "artifactVersionId", version, "statementKind", "MEDIA_RIGHTS", "scopes", List.of("EXTERNAL_DELIVERY"),
                "basis", "TEST: synthetic media generated by the test; a statement by a synthetic test principal"), 201)
                .path("attestationId").asString();
        HttpResponse<String> confirmed = api.send(confirmerToken, "POST", "/dev/v1/rights/attestations/" + attestation
                + "/confirm", "{}");
        assertThat(confirmed.statusCode()).as(confirmed.body()).isEqualTo(200);
    }

    private static Map<String, JsonNode> readback(Api api, String uploaderToken, String reviewerToken, String lineage,
                                                  String caseId1, String caseId2) throws Exception {
        Map<String, JsonNode> out = new LinkedHashMap<>();
        out.put("case1-owner", stable(api.get(uploaderToken, "/dev/v1/reviews/" + caseId1, 200)));
        out.put("case1-reviewer", stable(api.get(reviewerToken, "/dev/v1/reviews/" + caseId1, 200)));
        out.put("case2-owner", stable(api.get(uploaderToken, "/dev/v1/reviews/" + caseId2, 200)));
        out.put("lineage-owner", stable(api.get(uploaderToken, "/dev/v1/review-lineages/" + lineage, 200)));
        out.put("versions-reviewer", stable(api.get(reviewerToken, "/dev/v1/reviews/" + caseId1 + "/versions", 200)));
        return out;
    }

    /** Drops the clock-dependent fields so two readbacks can be compared for identity. */
    private static JsonNode stable(JsonNode node) {
        JsonNode copy = node.deepCopy();
        strip(copy);
        return copy;
    }

    private static void strip(JsonNode node) {
        if (node instanceof ObjectNode object) {
            object.remove("observedAt");
            for (String name : new ArrayList<>(object.propertyNames())) {
                if ("status".equals(name) && object.get(name).isString()
                        && ("ACTIVE".equals(object.get(name).asString()) || "EXPIRED".equals(object.get(name).asString()))) {
                    continue;
                }
                strip(object.get(name));
            }
        } else if (node != null) {
            for (JsonNode child : node) strip(child);
        }
    }

    private static List<Path> destinationFiles(Path destination) throws Exception {
        try (var files = Files.list(destination)) {
            return files.filter(Files::isRegularFile).sorted().toList();
        }
    }

    private static int reviewRows(String schema, String caseId, String table) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement("SELECT count(*) FROM " + schema + "." + table
                     + " WHERE review_case_id=?")) {
            statement.setString(1, caseId);
            try (var rows = statement.executeQuery()) {
                rows.next();
                return rows.getInt(1);
            }
        }
    }

    /** A real few-hundred-KB H.264/AAC MP4 produced by FFmpeg from a lavfi test pattern. */
    private static byte[] mp4(Path work, String name, String video, int toneHz) throws Exception {
        Path out = work.resolve(name);
        Process process = new ProcessBuilder(ffmpeg(), "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", video,
                "-f", "lavfi", "-i", "sine=frequency=" + toneHz + ":duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-shortest", "-movflags", "+faststart", out.toString()).redirectErrorStream(true).start();
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(process.waitFor(2, TimeUnit.MINUTES)).isTrue();
        assertThat(process.exitValue()).as("ffmpeg: " + output).isZero();
        byte[] bytes = Files.readAllBytes(out);
        assertThat(bytes.length).isBetween(5_000, 2_000_000);
        return bytes;
    }
}
