package com.ghatana.media.launcher;

import com.ghatana.media.production.timeline.InMemoryProjectTimelineStore;
import com.ghatana.media.production.review.InMemoryReviewStore;
import com.ghatana.media.production.review.ManagedReviewStore;
import com.ghatana.media.runtime.ManagedProjectTimelineStore;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Clock;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Created;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Project;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectTimelineStore;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.RationalTime;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Revision;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.TimelineSnapshot;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * DEV_ONLY hosted versioned review through the HTTP host: open on an exact project revision / registered render
 * artifact version, comment, decide, read back after a runtime restart, stale-after-change, idempotency and denial.
 */
class MediaDevReviewHttpTest {
    private static final String TENANT = "tenant-local";
    private static final String PRINCIPAL = "principal-local";
    private static final String OTHER = "principal-other";
    private static final String REVIEWER = "principal-reviewer";
    private static final String EXPIRES = "2026-11-13T21:00:00Z";
    private static final String SECRET = "test-only-dev-project-secret-at-least-32-bytes";
    private static final String ISSUER = "urn:ghatana:media:dev-only";
    private static final String AUDIENCE = "ghatana-media-dev";
    private static final java.time.Clock CLOCK =
            java.time.Clock.fixed(Instant.parse("2026-11-13T20:00:00Z"), java.time.ZoneOffset.UTC);
    /** Advances only the review runtime clock (not token validation) to model assignment expiry. */
    private static final java.util.concurrent.atomic.AtomicReference<Duration> CLOCK_OFFSET =
            new java.util.concurrent.atomic.AtomicReference<>(Duration.ZERO);
    private static final java.time.Clock REVIEW_CLOCK = new java.time.Clock() {
        @Override public java.time.ZoneId getZone() { return CLOCK.getZone(); }
        @Override public java.time.Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public Instant instant() { return CLOCK.instant().plus(CLOCK_OFFSET.get()); }
    };
    private static final Set<String> PERMISSIONS = Set.of(
            "media:project:dev:create", "media:project:dev:read", "media:project:dev:write",
            "media:artifact:read", "media:artifact:create");
    private static final ObjectMapper JSON = JsonMapper.builder()
            .addModules(tools.jackson.databind.cfg.MapperBuilder.findModules()).build();

    private Path root;
    private MediaRuntime runtime;
    private InMemoryManagedStore projectStore;
    private ManagedReviewStore reviewStore;
    private HttpServer server;
    private String base;
    private com.nimbusds.jose.jwk.RSAKey oidcKey;
    private com.ghatana.media.launcher.oidc.OidcAccessTokenVerifier oidcVerifier;

    @org.junit.jupiter.api.BeforeEach
    void start() throws Exception {
        oidcKey = com.ghatana.media.launcher.oidc.OidcTestSupport.rsa("review-it-key");
        var config = com.ghatana.media.launcher.oidc.OidcConfig.of(
                com.ghatana.media.launcher.oidc.OidcTestSupport.ISSUER,
                com.ghatana.media.launcher.oidc.OidcTestSupport.AUDIENCE, null);
        var idp = new com.ghatana.media.launcher.oidc.OidcTestSupport.FakeIdp(
                com.ghatana.media.launcher.oidc.OidcTestSupport.jwks(oidcKey.toPublicJWK()));
        oidcVerifier = new com.ghatana.media.launcher.oidc.OidcAccessTokenVerifier(config,
                new com.ghatana.media.launcher.oidc.OidcJwksCache(config, idp, CLOCK), CLOCK);
        root = Files.createTempDirectory("media-dev-review-http-");
        projectStore = new InMemoryManagedStore();
        reviewStore = new InMemoryReviewStore(List.of());
        boot();
    }

    @org.junit.jupiter.api.AfterEach
    void stop() {
        server.stop(0);
        runtime.close();
    }

    private void boot() throws Exception {
        runtime = runtime(root);
        MediaDevProjectTimelineRuntime projects = new MediaDevProjectTimelineRuntime(projectStore);
        MediaDevReviewRuntime reviews = new MediaDevReviewRuntime(reviewStore, runtime, projects, REVIEW_CLOCK);
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", new MediaSecurityFilter(
                new MediaHttpHandler(runtime, null, null, projects, reviews), "dev", devEnvironment(), CLOCK, oidcVerifier));
        server.start();
        base = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private void restart() throws Exception {
        server.stop(0);
        runtime.close();
        boot();
    }

    @Test
    void ownerReviewsExactProjectRevisionAndReadsItBackAfterRestart() throws Exception {
        Proj project = projectWithClip("review-1");
        Map<String, Object> opened = open(project.projectId(), project.revisionId());
        String caseId = (String) opened.get("reviewCaseId");
        assertThat(opened).containsEntry("created", true).containsEntry("currentness", "CURRENT")
                .containsEntry("caseRevision", 0).containsEntry("scope", "DEV_ONLY");
        assertThat(object(opened.get("subject"))).containsEntry("kind", "PROJECT_REVISION")
                .containsEntry("projectId", project.projectId()).containsEntry("revisionId", project.revisionId())
                .containsEntry("reference", "project_revision:" + project.projectId() + "@" + project.revisionId());
        assertThat(object(opened.get("reviewState"))).containsEntry("status", "NO_DECISION")
                .containsEntry("establishesApproval", false).containsEntry("humanReviewApproval", false);

        // Re-open is the same case, not a second one.
        HttpResponse<String> again = post("/dev/v1/reviews", openBody(project.projectId(), project.revisionId()), PRINCIPAL);
        assertThat(again.statusCode()).isEqualTo(200);
        assertThat(read(again.body())).containsEntry("reviewCaseId", caseId).containsEntry("created", false);

        HttpResponse<String> comment = post("/dev/v1/reviews/" + caseId + "/comments", JSON.writeValueAsString(Map.of(
                "requestId", "c-1", "expectedCaseRevision", 0, "text", "Tighten the cut; mail me at a.b@example.com",
                "disposition", "OPEN", "annotation", Map.of(
                        "timeRange", Map.of("start", rational(24), "end", rational(48)),
                        "roi", Map.of("x", 0.25, "y", 0.25, "width", 0.5, "height", 0.5)))), PRINCIPAL);
        assertThat(comment.statusCode()).as(comment.body()).isEqualTo(201);
        Map<String, Object> receipt = read(comment.body());
        assertThat(receipt).containsEntry("caseRevision", 1).containsEntry("establishesApproval", false)
                .containsEntry("replayed", false).containsEntry("currentness", "CURRENT");

        assign(caseId, REVIEWER, List.of("QUALITY"), EXPIRES, 1, "a-1", 201);
        HttpResponse<String> decision = post("/dev/v1/reviews/" + caseId + "/decisions", JSON.writeValueAsString(Map.of(
                "requestId", "d-1", "expectedCaseRevision", 1, "decision", "ACCEPT", "reason", "Looks right",
                "scope", "QUALITY", "confirmed", true)), REVIEWER);
        assertThat(decision.statusCode()).as(decision.body()).isEqualTo(201);
        assertThat(read(decision.body())).containsEntry("establishesApproval", false).containsEntry("caseRevision", 2);

        restart();
        HttpResponse<String> reread = get("/dev/v1/reviews/" + caseId, REVIEWER);
        assertThat(reread.statusCode()).as(reread.body()).isEqualTo(200);
        Map<String, Object> view = read(reread.body());
        assertThat(view).containsEntry("caseRevision", 2).containsEntry("currentness", "CURRENT");
        List<?> records = (List<?>) view.get("records");
        assertThat(records).hasSize(2);
        Map<String, Object> first = object(records.get(0));
        assertThat(first).containsEntry("kind", "COMMENT").containsEntry("disposition", "OPEN");
        assertThat((String) first.get("text")).contains("[redacted-email]").doesNotContain("example.com");
        assertThat(object(first.get("annotation"))).containsKeys("timeRange", "roi");
        assertThat(object(view.get("reviewState"))).containsEntry("status", "DEV_ASSIGNED_REVIEWER_ACCEPT_CURRENT")
                .containsEntry("establishesApproval", false).containsEntry("humanReviewApproval", false);
        assertThat(object(records.get(1))).containsEntry("recordedAs", "DEV_ASSIGNED_REVIEWER_ACCEPT")
                .containsEntry("scope", "QUALITY").containsEntry("principalId", REVIEWER);
        assertThat(((List<?>) view.get("assignments"))).hasSize(1);
        assertThat((String) view.get("note")).contains("not an issued human reviewer authority");
    }

    @Test
    void anOidcVerifiedAssignedReviewerDecisionIsRecordedAsIdentityBackedButStillEstablishesNoApproval()
            throws Exception {
        Proj project = projectWithClip("review-oidc");
        String caseId = (String) open(project.projectId(), project.revisionId()).get("reviewCaseId");
        String subject = "keycloak-subject-1";
        String oidcPrincipal = com.ghatana.media.runtime.MediaVerifiedIdentityContracts.oidcPrincipalId(
                com.ghatana.media.launcher.oidc.OidcTestSupport.ISSUER, subject);
        assign(caseId, oidcPrincipal, List.of("QUALITY"), EXPIRES, 0, "a-oidc", 201);

        String idpToken = com.ghatana.media.launcher.oidc.OidcTestSupport.signRs256(oidcKey,
                com.ghatana.media.launcher.oidc.OidcTestSupport.claims(CLOCK.instant())
                        .subject(subject).claim("tenant_id", TENANT)
                        .claim("realm_access", Map.of("roles", List.of(
                                "media:project:dev:read", "media:project:dev:write"))).build());
        HttpResponse<String> decision = sendBearer("POST", "/dev/v1/reviews/" + caseId + "/decisions", idpToken,
                JSON.writeValueAsString(Map.of("requestId", "d-oidc", "expectedCaseRevision", 0, "decision", "ACCEPT",
                        "reason", "Verified reviewer", "scope", "QUALITY", "confirmed", true)));
        assertThat(decision.statusCode()).as(decision.body()).isEqualTo(201);
        assertThat(read(decision.body())).containsEntry("establishesApproval", false);

        Map<String, Object> view = read(sendBearer("GET", "/dev/v1/reviews/" + caseId, idpToken, null).body());
        assertThat(object(view.get("reviewState")))
                .containsEntry("status", "IDP_VERIFIED_REVIEWER_ACCEPT_CURRENT")
                .containsEntry("identityAssurance", "OIDC_VERIFIED")
                .containsEntry("establishesApproval", false).containsEntry("humanReviewApproval", false);
        Map<String, Object> record = object(((List<?>) view.get("records")).get(0));
        assertThat(record).containsEntry("recordedAs", "IDP_VERIFIED_REVIEWER_ACCEPT")
                .containsEntry("identityAssurance", "OIDC_VERIFIED")
                .containsEntry("identityBackedHumanDecision", true)
                .containsEntry("principalId", oidcPrincipal).containsEntry("scope", "QUALITY");
        assertThat((String) record.get("authorityVersion")).startsWith(MediaDevReviewRuntime.IDP_ASSIGNED_AUTHORITY_PREFIX);
        assertThat((String) record.get("identityNote")).contains("not an approval");
    }

    @Test
    void aDevIssuedReviewerStaysADevAssignedDecisionAndCannotImpersonateAnOidcPrincipal() throws Exception {
        Proj project = projectWithClip("review-dev-vs-oidc");
        String caseId = (String) open(project.projectId(), project.revisionId()).get("reviewCaseId");
        assign(caseId, REVIEWER, List.of("QUALITY"), EXPIRES, 0, "a-dev", 201);
        assertThat(post("/dev/v1/reviews/" + caseId + "/decisions", JSON.writeValueAsString(Map.of(
                "requestId", "d-dev", "expectedCaseRevision", 0, "decision", "ACCEPT", "reason", "ok",
                "scope", "QUALITY", "confirmed", true)), REVIEWER).statusCode()).isEqualTo(201);
        Map<String, Object> record = object(((List<?>) read(get("/dev/v1/reviews/" + caseId, REVIEWER).body())
                .get("records")).get(0));
        assertThat(record).containsEntry("recordedAs", "DEV_ASSIGNED_REVIEWER_ACCEPT")
                .containsEntry("identityAssurance", "NOT_IDP_VERIFIED")
                .containsEntry("identityBackedHumanDecision", false);

        // A DEV token cannot take a principal id in the reserved identity-provider space.
        String victim = com.ghatana.media.runtime.MediaVerifiedIdentityContracts.oidcPrincipalId(
                com.ghatana.media.launcher.oidc.OidcTestSupport.ISSUER, "keycloak-subject-1");
        assertThat(get("/dev/v1/reviews/" + caseId, victim).statusCode()).isEqualTo(401);
    }

    private HttpResponse<String> sendBearer(String method, String path, String bearer, String body) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(base + path))
                .header("Authorization", "Bearer " + bearer);
        if (body != null) request.header("Content-Type", "application/json");
        request.method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(body));
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void anyChangeOfTheReviewedProjectMakesEarlierAcceptanceStale() throws Exception {
        Proj project = projectWithClip("review-stale");
        String caseId = (String) open(project.projectId(), project.revisionId()).get("reviewCaseId");
        assign(caseId, REVIEWER, List.of("QUALITY"), EXPIRES, 0, "a-stale", 201);
        HttpResponse<String> accept = post("/dev/v1/reviews/" + caseId + "/decisions", JSON.writeValueAsString(Map.of(
                "requestId", "d-accept", "expectedCaseRevision", 0, "decision", "ACCEPT", "reason", "ok",
                "scope", "QUALITY", "confirmed", true)), REVIEWER);
        assertThat(accept.statusCode()).as(accept.body()).isEqualTo(201);

        // Material edit creates a new head revision.
        String newHead = edit(project.projectId(), "timeline-main", project.revisionId(), List.of(
                Map.of("type", "addScene", "sceneId", "scene-two", "order", 1)));
        assertThat(newHead).isNotEqualTo(project.revisionId());

        Map<String, Object> view = read(get("/dev/v1/reviews/" + caseId, PRINCIPAL).body());
        assertThat(view).containsEntry("currentness", "STALE");
        assertThat(object(view.get("reviewState"))).containsEntry("status", "DEV_ASSIGNED_REVIEWER_ACCEPT_STALE")
                .containsEntry("establishesApproval", false);
        assertThat(object(((List<?>) view.get("records")).get(0))).containsEntry("currentness", "STALE");

        // A new decision on the stale exact version is refused; comments are still recorded as STALE.
        HttpResponse<String> late = post("/dev/v1/reviews/" + caseId + "/decisions", JSON.writeValueAsString(Map.of(
                "requestId", "d-late", "expectedCaseRevision", 1, "decision", "ACCEPT", "reason", "again",
                "scope", "QUALITY", "confirmed", true)), REVIEWER);
        assertThat(late.statusCode()).isEqualTo(409);
        assertThat(late.body()).contains("REVIEW_SUBJECT_STALE");
        HttpResponse<String> comment = post("/dev/v1/reviews/" + caseId + "/comments", JSON.writeValueAsString(Map.of(
                "requestId", "c-late", "expectedCaseRevision", 1, "text", "noted", "disposition", "OPEN")), PRINCIPAL);
        assertThat(comment.statusCode()).isEqualTo(201);
        assertThat(read(comment.body())).containsEntry("currentness", "STALE");

        // The new head is a different exact subject with its own case and no inherited approval.
        Map<String, Object> fresh = open(project.projectId(), newHead);
        assertThat(fresh.get("reviewCaseId")).isNotEqualTo(caseId);
        assertThat(object(fresh.get("reviewState"))).containsEntry("status", "NO_DECISION");
        // Exact-retry of the pre-change decision still reconciles to its original receipt (not a new decision).
        HttpResponse<String> retry = post("/dev/v1/reviews/" + caseId + "/decisions", JSON.writeValueAsString(Map.of(
                "requestId", "d-accept", "expectedCaseRevision", 0, "decision", "ACCEPT", "reason", "ok",
                "scope", "QUALITY", "confirmed", true)), REVIEWER);
        assertThat(retry.statusCode()).as(retry.body()).isEqualTo(200);
        assertThat(read(retry.body())).containsEntry("replayed", true).containsEntry("currentness", "STALE")
                .containsEntry("establishesApproval", false).containsEntry("caseRevision", 1);
    }

    @Test
    void reviewsARegisteredRenderArtifactVersionAndBindsTheExactVersion() throws Exception {
        Proj project = projectWithClip("review-artifact");
        HttpResponse<String> render = post("/dev/v1/projects/" + project.projectId() + "/renders",
                JSON.writeValueAsString(Map.of("requestId", "render-r1", "revisionId", project.revisionId(),
                        "timelineId", "timeline-main", "width", 16, "height", 12, "framesPerSecond", 10)), PRINCIPAL);
        assertThat(render.statusCode()).as(render.body()).isEqualTo(201);
        Map<String, Object> artifact = object(read(render.body()).get("artifact"));
        String artifactId = (String) artifact.get("artifactId");
        String versionId = (String) artifact.get("artifactVersionId");

        HttpResponse<String> opened = post("/dev/v1/reviews", JSON.writeValueAsString(Map.of("subject", Map.of(
                "kind", "ARTIFACT_VERSION", "artifactId", artifactId, "artifactVersionId", versionId))), PRINCIPAL);
        assertThat(opened.statusCode()).as(opened.body()).isEqualTo(201);
        Map<String, Object> view = read(opened.body());
        assertThat(object(view.get("subject"))).containsEntry("artifactId", artifactId)
                .containsEntry("artifactVersionId", versionId);
        assertThat(view).containsEntry("currentness", "CURRENT");

        // Wrong version of the same artifact is not an exact registered subject.
        HttpResponse<String> wrong = post("/dev/v1/reviews", JSON.writeValueAsString(Map.of("subject", Map.of(
                "kind", "ARTIFACT_VERSION", "artifactId", artifactId, "artifactVersionId", "sha256:" + "0".repeat(64)))),
                PRINCIPAL);
        assertThat(wrong.statusCode()).isEqualTo(404);
        assertThat(wrong.body()).contains("REVIEW_SUBJECT_NOT_FOUND");

        // Artifact review additionally needs artifact read permission.
        Set<String> projectOnly = Set.of("media:project:dev:read", "media:project:dev:write");
        HttpResponse<String> noPermission = send("GET", "/dev/v1/reviews/" + view.get("reviewCaseId"), null,
                PRINCIPAL, projectOnly);
        assertThat(noPermission.statusCode()).isEqualTo(403);
        assertThat(noPermission.body()).contains("ARTIFACT_PERMISSION_REQUIRED");
    }

    @Test
    void idempotentReplayConflictingReuseAndRevisionCasAreTyped() throws Exception {
        Proj project = projectWithClip("review-idem");
        String caseId = (String) open(project.projectId(), project.revisionId()).get("reviewCaseId");
        String comment = JSON.writeValueAsString(Map.of("requestId", "same", "expectedCaseRevision", 0,
                "text", "first", "disposition", "OPEN"));
        HttpResponse<String> first = post("/dev/v1/reviews/" + caseId + "/comments", comment, PRINCIPAL);
        assertThat(first.statusCode()).isEqualTo(201);
        HttpResponse<String> replay = post("/dev/v1/reviews/" + caseId + "/comments", comment, PRINCIPAL);
        assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
        assertThat(read(replay.body())).containsEntry("replayed", true)
                .containsEntry("appendRecordId", read(first.body()).get("appendRecordId"));

        HttpResponse<String> reuse = post("/dev/v1/reviews/" + caseId + "/comments", JSON.writeValueAsString(Map.of(
                "requestId", "same", "expectedCaseRevision", 0, "text", "different", "disposition", "OPEN")), PRINCIPAL);
        assertThat(reuse.statusCode()).isEqualTo(409);
        assertThat(reuse.body()).contains("REVIEW_REQUEST_ID_REUSED");

        HttpResponse<String> casMiss = post("/dev/v1/reviews/" + caseId + "/comments", JSON.writeValueAsString(Map.of(
                "requestId", "other", "expectedCaseRevision", 0, "text", "second", "disposition", "OPEN")), PRINCIPAL);
        assertThat(casMiss.statusCode()).isEqualTo(409);
        assertThat(casMiss.body()).contains("REVIEW_CASE_REVISION_CONFLICT");

        assertThat(read(get("/dev/v1/reviews/" + caseId, PRINCIPAL).body())).containsEntry("caseRevision", 1);
    }

    @Test
    void deniesOtherPrincipalsMissingPermissionsAndInvalidRequestsWithTypedErrors() throws Exception {
        Proj project = projectWithClip("review-deny");
        String caseId = (String) open(project.projectId(), project.revisionId()).get("reviewCaseId");

        assertThat(get("/dev/v1/reviews/" + caseId, OTHER).statusCode()).isEqualTo(404);
        HttpResponse<String> foreignComment = post("/dev/v1/reviews/" + caseId + "/comments", JSON.writeValueAsString(
                Map.of("requestId", "x", "expectedCaseRevision", 0, "text", "hi", "disposition", "OPEN")), OTHER);
        assertThat(foreignComment.statusCode()).isEqualTo(404);
        // Another owner cannot open a case on a project they do not own.
        HttpResponse<String> foreignOpen = post("/dev/v1/reviews", openBody(project.projectId(), project.revisionId()),
                OTHER);
        assertThat(foreignOpen.statusCode()).isEqualTo(404);
        assertThat(foreignOpen.body()).contains("REVIEW_SUBJECT_NOT_FOUND");

        Set<String> readOnly = Set.of("media:project:dev:read");
        assertThat(send("POST", "/dev/v1/reviews", openBody(project.projectId(), project.revisionId()), PRINCIPAL,
                readOnly).statusCode()).isEqualTo(403);
        assertThat(send("POST", "/dev/v1/reviews/" + caseId + "/comments", "{}", PRINCIPAL, readOnly).statusCode())
                .isEqualTo(403);
        assertThat(send("GET", "/dev/v1/reviews/" + caseId, null, PRINCIPAL, Set.of()).statusCode()).isEqualTo(403);

        HttpResponse<String> unconfirmed = post("/dev/v1/reviews/" + caseId + "/decisions", JSON.writeValueAsString(Map.of(
                "requestId", "u", "expectedCaseRevision", 0, "decision", "ACCEPT", "reason", "r",
                "scope", "QUALITY", "confirmed", false)), PRINCIPAL);
        assertThat(unconfirmed.statusCode()).isEqualTo(422);
        assertThat(unconfirmed.body()).contains("REVIEW_CONFIRMATION_REQUIRED");
        assertThat(post("/dev/v1/reviews/" + caseId + "/decisions", JSON.writeValueAsString(Map.of(
                "requestId", "u2", "expectedCaseRevision", 0, "decision", "MAYBE", "reason", "r", "scope", "QUALITY", "confirmed", true)),
                PRINCIPAL).statusCode()).isEqualTo(400);
        assertThat(post("/dev/v1/reviews/" + caseId + "/comments", JSON.writeValueAsString(Map.of(
                "requestId", "u3", "expectedCaseRevision", 0, "text", "x", "disposition", "OPEN", "extra", 1)),
                PRINCIPAL).statusCode()).isEqualTo(400);
        assertThat(post("/dev/v1/reviews", JSON.writeValueAsString(Map.of("subject", Map.of(
                "kind", "PROCESSING_JOB", "projectId", "p", "revisionId", "r"))), PRINCIPAL).statusCode()).isEqualTo(400);
        assertThat(post("/dev/v1/reviews", openBody(project.projectId(), "no-such-revision"), PRINCIPAL).statusCode())
                .isEqualTo(404);
        assertThat(get("/dev/v1/reviews/devreview.unknown", PRINCIPAL).statusCode()).isEqualTo(404);
        assertThat(send("DELETE", "/dev/v1/reviews/" + caseId, null, PRINCIPAL, PERMISSIONS).statusCode())
                .isIn(403, 405);
        assertThat(read(get("/dev/v1/reviews/" + caseId, PRINCIPAL).body())).containsEntry("caseRevision", 0);
    }

    // ---- reviewer assignment ----

    @Test
    void assignedReviewerDecidesWithinScopeAndOwnerCannotDecide() throws Exception {
        Proj project = projectWithClip("review-assign");
        String caseId = (String) open(project.projectId(), project.revisionId()).get("reviewCaseId");
        String path = "/dev/v1/reviews/" + caseId;

        // Nobody is assigned: neither the owner nor a stranger can decide; a stranger cannot even see the case.
        assertThat(decide(caseId, PRINCIPAL, "d-owner0", 0, "QUALITY").statusCode()).isEqualTo(403);
        assertThat(get(path, REVIEWER).statusCode()).isEqualTo(404);

        Map<String, Object> assigned = read(assign(caseId, REVIEWER, List.of("QUALITY", "RIGHTS"), EXPIRES, 0,
                "a-1", 201).body());
        Map<String, Object> assignment = object(assigned.get("assignment"));
        assertThat(assignment).containsEntry("reviewerPrincipalId", REVIEWER).containsEntry("assignedByPrincipalId", PRINCIPAL)
                .containsEntry("status", "ACTIVE").containsEntry("assignmentVersion", 1)
                .containsEntry("scopes", List.of("QUALITY", "RIGHTS"));
        assertThat(assigned).containsEntry("establishesApproval", false).containsEntry("humanReviewApproval", false);

        // Owner may comment but not decide, even though the case now has an assigned reviewer.
        assertThat(post(path + "/comments", JSON.writeValueAsString(Map.of("requestId", "c-owner", "expectedCaseRevision", 0,
                "text", "owner note", "disposition", "OPEN")), PRINCIPAL).statusCode()).isEqualTo(201);
        HttpResponse<String> ownerDecision = decide(caseId, PRINCIPAL, "d-owner", 1, "QUALITY");
        assertThat(ownerDecision.statusCode()).isEqualTo(403);
        assertThat(ownerDecision.body()).contains("REVIEWER_NOT_ASSIGNED");

        // Out-of-scope decision is refused with a typed error; in-scope decision is recorded.
        HttpResponse<String> outOfScope = decide(caseId, REVIEWER, "d-scope", 1, "APPROVAL");
        assertThat(outOfScope.statusCode()).isEqualTo(403);
        assertThat(outOfScope.body()).contains("REVIEW_SCOPE_NOT_ASSIGNED");
        HttpResponse<String> inScope = decide(caseId, REVIEWER, "d-ok", 1, "RIGHTS");
        assertThat(inScope.statusCode()).as(inScope.body()).isEqualTo(201);
        assertThat(read(inScope.body())).containsEntry("establishesApproval", false).containsEntry("caseRevision", 2);

        Map<String, Object> view = read(get(path, REVIEWER).body());
        Map<String, Object> state = object(view.get("reviewState"));
        assertThat(state).containsEntry("status", "DEV_ASSIGNED_REVIEWER_ACCEPT_CURRENT")
                .containsEntry("establishesApproval", false).containsEntry("humanReviewApproval", false);
        assertThat(object(((List<?>) view.get("records")).get(1))).containsEntry("scope", "RIGHTS")
                .containsEntry("recordedAs", "DEV_ASSIGNED_REVIEWER_ACCEPT");

        // The reviewer cannot assign, revoke or mint further reviewers.
        assertThat(assign(caseId, "principal-third", List.of("QUALITY"), EXPIRES, 2, "a-by-reviewer", REVIEWER, 403)
                .body()).contains("REVIEW_ACCESS_DENIED");
    }

    @Test
    void assignmentIdempotencyCasSelfAssignmentAndExpiryAreTyped() throws Exception {
        Proj project = projectWithClip("review-assign-edge");
        String caseId = (String) open(project.projectId(), project.revisionId()).get("reviewCaseId");

        assertThat(assign(caseId, PRINCIPAL, List.of("QUALITY"), EXPIRES, 0, "a-self", 422).body())
                .contains("REVIEW_SELF_ASSIGNMENT_REFUSED");
        assertThat(assign(caseId, REVIEWER, List.of(), EXPIRES, 0, "a-empty", 400).statusCode()).isEqualTo(400);
        assertThat(assign(caseId, REVIEWER, List.of("QUALITY"), "2026-11-13T19:00:00Z", 0, "a-past", 400).statusCode())
                .isEqualTo(400);
        assertThat(assign(caseId, REVIEWER, List.of("QUALITY"), "2027-01-01T00:00:00Z", 0, "a-far", 400).statusCode())
                .isEqualTo(400);
        assertThat(assign(caseId, REVIEWER, List.of("NOPE"), EXPIRES, 0, "a-bad-scope", 400).statusCode()).isEqualTo(400);
        assertThat(assign(caseId, REVIEWER, List.of("QUALITY"), EXPIRES, 5, "a-cas", 409).body())
                .contains("REVIEW_CASE_REVISION_CONFLICT");

        HttpResponse<String> first = assign(caseId, REVIEWER, List.of("QUALITY"), EXPIRES, 0, "a-same", 201);
        String assignmentId = (String) object(read(first.body()).get("assignment")).get("assignmentId");
        HttpResponse<String> replay = assign(caseId, REVIEWER, List.of("QUALITY"), EXPIRES, 0, "a-same", 200);
        assertThat(read(replay.body())).containsEntry("replayed", true);
        assertThat(object(read(replay.body()).get("assignment"))).containsEntry("assignmentId", assignmentId);
        assertThat(assign(caseId, REVIEWER, List.of("QUALITY", "RIGHTS"), EXPIRES, 0, "a-same", 409).body())
                .contains("REVIEW_REQUEST_ID_REUSED");
        assertThat(assign(caseId, REVIEWER, List.of("RIGHTS"), EXPIRES, 0, "a-dup", 409).body())
                .contains("REVIEW_ASSIGNMENT_ALREADY_ACTIVE");

        // Revoke: CAS, idempotent replay, not-found, already-revoked.
        String revokePath = "/dev/v1/reviews/" + caseId + "/assignments/" + assignmentId + "/revoke";
        assertThat(post(revokePath, JSON.writeValueAsString(Map.of("requestId", "r-cas", "expectedCaseRevision", 3)),
                PRINCIPAL).statusCode()).isEqualTo(409);
        HttpResponse<String> revoked = post(revokePath, JSON.writeValueAsString(Map.of("requestId", "r-1",
                "expectedCaseRevision", 0)), PRINCIPAL);
        assertThat(revoked.statusCode()).as(revoked.body()).isEqualTo(200);
        assertThat(object(read(revoked.body()).get("assignment"))).containsEntry("status", "REVOKED")
                .containsEntry("assignmentVersion", 2);
        HttpResponse<String> revokedAgain = post(revokePath, JSON.writeValueAsString(Map.of("requestId", "r-1",
                "expectedCaseRevision", 0)), PRINCIPAL);
        assertThat(read(revokedAgain.body())).containsEntry("replayed", true);
        assertThat(post(revokePath, JSON.writeValueAsString(Map.of("requestId", "r-2", "expectedCaseRevision", 0)),
                PRINCIPAL).body()).contains("REVIEW_ASSIGNMENT_ALREADY_REVOKED");
        assertThat(post("/dev/v1/reviews/" + caseId + "/assignments/nope/revoke", JSON.writeValueAsString(Map.of(
                "requestId", "r-3", "expectedCaseRevision", 0)), PRINCIPAL).body())
                .contains("REVIEW_ASSIGNMENT_NOT_FOUND");
        // Reviewer cannot revoke their own assignment; DELETE is not a route.
        assertThat(post(revokePath, JSON.writeValueAsString(Map.of("requestId", "r-by-rev", "expectedCaseRevision", 0)),
                REVIEWER).statusCode()).isEqualTo(403);
        assertThat(send("DELETE", "/dev/v1/reviews/" + caseId + "/assignments/" + assignmentId, null, PRINCIPAL,
                PERMISSIONS).statusCode()).isIn(403, 405);
        // A revoked assignment can be replaced by a fresh one (new assignmentId, version 1).
        HttpResponse<String> again = assign(caseId, REVIEWER, List.of("QUALITY"), EXPIRES, 0, "a-new", 201);
        assertThat(object(read(again.body()).get("assignment")).get("assignmentId")).isNotEqualTo(assignmentId);
    }

    @Test
    void revokedAndExpiredReviewersAreRefusedAndWrongTenantSeesNothing() throws Exception {
        Proj project = projectWithClip("review-revoke");
        String caseId = (String) open(project.projectId(), project.revisionId()).get("reviewCaseId");
        String assignmentId = (String) object(read(assign(caseId, REVIEWER, List.of("QUALITY"), EXPIRES, 0,
                "a-rv", 201).body()).get("assignment")).get("assignmentId");
        assertThat(decide(caseId, REVIEWER, "d-rv1", 0, "QUALITY").statusCode()).isEqualTo(201);

        HttpResponse<String> revoked = post("/dev/v1/reviews/" + caseId + "/assignments/" + assignmentId + "/revoke",
                JSON.writeValueAsString(Map.of("requestId", "r-rv", "expectedCaseRevision", 1)), PRINCIPAL);
        assertThat(revoked.statusCode()).as(revoked.body()).isEqualTo(200);
        HttpResponse<String> afterRevoke = decide(caseId, REVIEWER, "d-rv2", 1, "QUALITY");
        assertThat(afterRevoke.statusCode()).isEqualTo(403);
        assertThat(afterRevoke.body()).contains("REVIEWER_NOT_ASSIGNED");
        assertThat(get("/dev/v1/reviews/" + caseId, REVIEWER).statusCode()).isEqualTo(403);
        // The earlier decision remains durable evidence, visible to the owner.
        assertThat(read(get("/dev/v1/reviews/" + caseId, PRINCIPAL).body())).containsEntry("caseRevision", 1);

        // A different tenant cannot see or decide the case (same principal ids, other tenant header).
        HttpResponse<String> wrongTenant = send("GET", "/dev/v1/reviews/" + caseId, null, REVIEWER, PERMISSIONS,
                "tenant-other");
        assertThat(wrongTenant.statusCode()).isEqualTo(404);
        assertThat(send("POST", "/dev/v1/reviews/" + caseId + "/decisions", decisionBody("d-wt", 1, "QUALITY"),
                REVIEWER, PERMISSIONS, "tenant-other").statusCode()).isEqualTo(404);

        // Expiry: the fixed clock is 20:00Z, so a one-hour assignment cannot be moved past; use the store directly
        // to model a clock that has advanced beyond the expiry.
        Proj second = projectWithClip("review-expiry");
        String caseTwo = (String) open(second.projectId(), second.revisionId()).get("reviewCaseId");
        assign(caseTwo, REVIEWER, List.of("QUALITY"), "2026-11-13T20:30:00Z", 0, "a-exp", 201);
        assertThat(decide(caseTwo, REVIEWER, "d-before", 0, "QUALITY").statusCode()).isEqualTo(201);
        CLOCK_OFFSET.set(Duration.ofHours(1));
        try {
            HttpResponse<String> expired = decide(caseTwo, REVIEWER, "d-after", 1, "QUALITY");
            assertThat(expired.statusCode()).isEqualTo(403);
            assertThat(expired.body()).contains("REVIEW_ASSIGNMENT_EXPIRED");
            assertThat(get("/dev/v1/reviews/" + caseTwo, REVIEWER).body()).contains("REVIEW_ASSIGNMENT_EXPIRED");
        } finally {
            CLOCK_OFFSET.set(Duration.ZERO);
        }
    }

    @Test
    void staleSubjectStillRefusesAssignedReviewerAndApprovalStaysFalse() throws Exception {
        Proj project = projectWithClip("review-assign-stale");
        String caseId = (String) open(project.projectId(), project.revisionId()).get("reviewCaseId");
        assign(caseId, REVIEWER, List.of("QUALITY", "APPROVAL"), EXPIRES, 0, "a-st", 201);
        HttpResponse<String> accept = decide(caseId, REVIEWER, "d-st", 0, "APPROVAL");
        assertThat(accept.statusCode()).isEqualTo(201);
        assertThat(read(accept.body())).containsEntry("establishesApproval", false);
        edit(project.projectId(), "timeline-main", project.revisionId(), List.of(
                Map.of("type", "addScene", "sceneId", "scene-two", "order", 1)));
        HttpResponse<String> late = decide(caseId, REVIEWER, "d-st2", 1, "APPROVAL");
        assertThat(late.statusCode()).isEqualTo(409);
        assertThat(late.body()).contains("REVIEW_SUBJECT_STALE");
        Map<String, Object> state = object(read(get("/dev/v1/reviews/" + caseId, REVIEWER).body()).get("reviewState"));
        assertThat(state).containsEntry("status", "DEV_ASSIGNED_REVIEWER_ACCEPT_STALE")
                .containsEntry("establishesApproval", false).containsEntry("humanReviewApproval", false);
    }

    private static String decisionBody(String requestId, long revision, String scope) throws Exception {
        return JSON.writeValueAsString(Map.of("requestId", requestId, "expectedCaseRevision", revision,
                "decision", "ACCEPT", "reason", "assigned review", "scope", scope, "confirmed", true));
    }

    private HttpResponse<String> decide(String caseId, String principal, String requestId, long revision, String scope)
            throws Exception {
        return post("/dev/v1/reviews/" + caseId + "/decisions", decisionBody(requestId, revision, scope), principal);
    }

    private HttpResponse<String> assign(String caseId, String reviewer, List<String> scopes, String expiresAt,
                                        long revision, String requestId, int expectedStatus) throws Exception {
        return assign(caseId, reviewer, scopes, expiresAt, revision, requestId, PRINCIPAL, expectedStatus);
    }

    private HttpResponse<String> assign(String caseId, String reviewer, List<String> scopes, String expiresAt,
                                        long revision, String requestId, String as, int expectedStatus)
            throws Exception {
        HttpResponse<String> response = post("/dev/v1/reviews/" + caseId + "/assignments", JSON.writeValueAsString(
                Map.of("requestId", requestId, "expectedCaseRevision", revision, "reviewerPrincipalId", reviewer,
                        "scopes", scopes, "expiresAt", expiresAt)), as);
        assertThat(response.statusCode()).as(response.body()).isEqualTo(expectedStatus);
        return response;
    }

    // ---- fixtures ----

    private record Proj(String projectId, String revisionId) { }

    private Proj projectWithClip(String key) throws Exception {
        MediaArtifact red = upload(runtime, "red.png", "image/png", png(0xffff0000), key + "-red");
        String workspaceId = (String) read(get("/dev/v1/context", PRINCIPAL).body()).get("selectedAuthorizedWorkspaceId");
        HttpResponse<String> created = post("/dev/v1/projects", JSON.writeValueAsString(Map.of(
                "selectedAuthorizedWorkspaceId", workspaceId, "title", "Review " + key, "requestId", key)), PRINCIPAL);
        assertThat(created.statusCode()).as(created.body()).isEqualTo(201);
        String projectId = (String) object(read(created.body()).get("project")).get("projectId");
        String head = (String) object(read(get("/dev/v1/projects/" + projectId, PRINCIPAL).body())
                .get("currentRevision")).get("revisionId");
        HttpResponse<String> timeline = post("/dev/v1/projects/" + projectId + "/timelines", JSON.writeValueAsString(
                Map.of("expectedHeadRevisionId", head, "timelineId", "timeline-main")), PRINCIPAL);
        head = (String) object(read(timeline.body()).get("revision")).get("revisionId");
        head = edit(projectId, "timeline-main", head, List.of(
                Map.of("type", "addScene", "sceneId", "scene-main", "order", 0),
                Map.of("type", "addTrack", "trackId", "video-main", "sceneId", "scene-main",
                        "trackKind", "VIDEO", "order", 0)));
        head = edit(projectId, "timeline-main", head, List.of(putClip("clip-red", "video-main", red, 0, 24)));
        return new Proj(projectId, head);
    }

    private String edit(String projectId, String timelineId, String head, List<Map<String, Object>> edits)
            throws Exception {
        HttpResponse<String> response = post("/dev/v1/projects/" + projectId + "/timelines/" + timelineId + "/edits",
                JSON.writeValueAsString(Map.of("expectedHeadRevisionId", head, "edits", edits)), PRINCIPAL);
        assertThat(response.statusCode()).as(response.body()).isEqualTo(201);
        return (String) object(read(response.body()).get("revision")).get("revisionId");
    }

    private Map<String, Object> open(String projectId, String revisionId) throws Exception {
        HttpResponse<String> response = post("/dev/v1/reviews", openBody(projectId, revisionId), PRINCIPAL);
        assertThat(response.statusCode()).as(response.body()).isIn(200, 201);
        return read(response.body());
    }

    private static String openBody(String projectId, String revisionId) throws Exception {
        return JSON.writeValueAsString(Map.of("subject", Map.of(
                "kind", "PROJECT_REVISION", "projectId", projectId, "revisionId", revisionId)));
    }

    private static Map<String, Object> rational(long ticks) {
        return Map.of("ticks", ticks, "rateNumerator", 24, "rateDenominator", 1, "clock", "SOURCE_PRESENTATION");
    }

    private HttpResponse<String> post(String path, String body, String principal) throws Exception {
        return send("POST", path, body, principal, PERMISSIONS);
    }

    private HttpResponse<String> get(String path, String principal) throws Exception {
        return send("GET", path, null, principal, PERMISSIONS);
    }

    private HttpResponse<String> send(String method, String path, String body, String principal,
                                      Set<String> permissions) throws Exception {
        return send(method, path, body, principal, permissions, TENANT);
    }

    private HttpResponse<String> send(String method, String path, String body, String principal,
                                      Set<String> permissions, String tenant) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(base + path))
                .header("Authorization", "Bearer " + token(principal, permissions, tenant))
                .header("X-Tenant-Id", tenant);
        if (body != null) request.header("Content-Type", "application/json");
        request.method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private static Map<String, Object> putClip(String clipId, String trackId, MediaArtifact source,
                                               long storyStartTicks, long storyDurationTicks) {
        return Map.of("type", "putClip", "clip", Map.of(
                "clipId", clipId, "sceneId", "scene-main", "trackId", trackId,
                "source", Map.of("artifactId", source.artifactId(), "artifactVersionId", source.version().value()),
                "sourceIn", time(0, "SOURCE_PRESENTATION"), "sourceOut", time(1, "SOURCE_PRESENTATION"),
                "storyStart", time(storyStartTicks, "STORY"), "storyDuration", time(storyDurationTicks, "STORY")));
    }

    private static Map<String, Object> time(long ticks, String clock) {
        return Map.of("ticks", Long.toString(ticks), "rateNumerator", "24", "rateDenominator", "1", "clock", clock);
    }

    private static MediaArtifact upload(MediaRuntime runtime, String name, String contentType, byte[] bytes,
                                        String key) throws Exception {
        String digest = HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        var session = runtime.beginUpload(new UploadRequest(TENANT, PRINCIPAL, name, contentType, bytes.length,
                digest, "INTERNAL", Duration.ofMinutes(30), Map.of()), key);
        runtime.appendChunk(TENANT, PRINCIPAL, session.uploadId(), 0, bytes);
        return runtime.completeUpload(TENANT, PRINCIPAL, session.uploadId());
    }

    private static byte[] png(int argb) throws Exception {
        BufferedImage image = new BufferedImage(8, 6, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < 6; y++) for (int x = 0; x < 8; x++) image.setRGB(x, y, argb);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(image, "png", out);
        return out.toByteArray();
    }

    private static MediaRuntime runtime(Path root) {
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "dev", 8093, 1_048_576, 131_072, 1_048_576,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(false),
                new LocalMediaRuntimeSupport.StreamStore(), null,
                List.of(new NoEffectProvider()),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
    }

    private static String token(String principal, Set<String> permissions) throws Exception {
        return token(principal, permissions, TENANT);
    }

    private static String token(String principal, Set<String> permissions, String tenant) throws Exception {
        String header = encode("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        String permissionJson = permissions.stream().sorted().map(permission -> "\"" + permission + "\"")
                .collect(java.util.stream.Collectors.joining(","));
        String payload = "{\"sub\":\"" + principal + "\",\"tenant_id\":\"" + tenant
                + "\",\"iss\":\"" + ISSUER + "\",\"aud\":\"" + AUDIENCE + "\",\"dev_only\":true,"
                + "\"iat\":" + CLOCK.instant().getEpochSecond() + ",\"exp\":"
                + CLOCK.instant().plusSeconds(120).getEpochSecond() + ",\"permissions\":[" + permissionJson + "]}";
        String signingInput = header + "." + encode(payload);
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return signingInput + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.US_ASCII)));
    }

    private static String encode(String value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private static Map<String, String> devEnvironment() {
        return Map.of("MEDIA_DEV_IDENTITY_ENABLED", "true", "MEDIA_DEV_JWT_HMAC_SECRET", SECRET);
    }

    private static Map<String, Object> read(String json) throws Exception {
        return JSON.readValue(json, new TypeReference<Map<String, Object>>() { });
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object value) { return (Map<String, Object>) value; }

    private static final class InMemoryManagedStore implements ManagedProjectTimelineStore {
        private final ProjectTimelineStore delegate = new InMemoryProjectTimelineStore();
        @Override public Created create(Actor actor, String workspaceId, String title, String requestId,
                                        String projectId, String initialRevisionId) {
            return delegate.create(actor, workspaceId, title, requestId, projectId, initialRevisionId);
        }
        @Override public Project project(Actor actor, String projectId) { return delegate.project(actor, projectId); }
        @Override public Revision revision(Actor actor, String projectId, String revisionId) {
            return delegate.revision(actor, projectId, revisionId);
        }
        @Override public Revision commit(Actor actor, String projectId, String expectedHeadRevisionId,
                                         String newRevisionId, List<TimelineSnapshot> timelines) {
            return delegate.commit(actor, projectId, expectedHeadRevisionId, newRevisionId, timelines);
        }
        @Override public void close() { }
    }

    private static final class NoEffectProvider implements MediaProcessingProvider {
        @Override public String providerId() { return "dev-review-http-no-effect"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.TRANSCODE); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 0; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            return CompletableFuture.failedFuture(new AssertionError("render routes must not invoke processing"));
        }
    }
}
