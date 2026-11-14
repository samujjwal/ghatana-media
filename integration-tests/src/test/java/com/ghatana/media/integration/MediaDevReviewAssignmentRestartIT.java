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
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * Real launcher process + PostgreSQL + S3: a DEV_ONLY reviewer assignment and the assigned reviewer's decision survive
 * a launcher restart (V003 versioned assignment rows), the assignment keeps scoping decisions after restart, and an
 * owner revocation after restart blocks the reviewer, including after a second restart. No decision establishes approval.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevReviewAssignmentRestartIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void assignmentAndReviewerDecisionSurviveRestartAndRevocationAfterRestartBlocks() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-assign-" + run;
        String owner = "media-dev-owner-" + run;
        String reviewer = "media-dev-reviewer-" + run;
        String bucket = "media-dev-assign-" + run;
        String schema = "media_dev_assign_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-assign-services-");
        Path log = Files.createTempFile("media-dev-assign-process-", ".log");
        Process launcher = null;
        try {
            try (S3Client s3 = s3(LOCALSTACK)) {
                s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.put("MEDIA_DEV_REVIEW_ENABLED", "true");
            String ownerToken = issueDevToken(tenant, owner);
            String reviewerToken = issueDevToken(tenant, reviewer);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            String workspaceId = get(port, tenant, ownerToken, "/dev/v1/context", 200)
                    .path("selectedAuthorizedWorkspaceId").asString();
            JsonNode created = post(port, tenant, ownerToken, "/dev/v1/projects", Map.of(
                    "selectedAuthorizedWorkspaceId", workspaceId, "title", "Assignment restart " + run,
                    "requestId", "assign-project-" + run), 201);
            String projectId = created.path("project").path("projectId").asString();
            String revisionId = created.path("initialRevision").path("revisionId").asString();
            String caseId = post(port, tenant, ownerToken, "/dev/v1/reviews", Map.of("subject", Map.of(
                    "kind", "PROJECT_REVISION", "projectId", projectId, "revisionId", revisionId)), 201)
                    .path("reviewCaseId").asString();
            String casePath = "/dev/v1/reviews/" + caseId;

            // Owner cannot decide; self-assignment is refused; a reviewer is assigned with scopes and an expiry.
            Map<String, Object> ownerDecision = decision("d-owner-" + run, 0, "QUALITY");
            assertThat(send(port, tenant, ownerToken, "POST", casePath + "/decisions",
                    JSON.writeValueAsString(ownerDecision)).statusCode()).isEqualTo(403);
            Instant expires = Instant.now().plus(Duration.ofMinutes(25));
            HttpResponse<String> self = send(port, tenant, ownerToken, "POST", casePath + "/assignments",
                    JSON.writeValueAsString(assignment("self-" + run, owner, expires)));
            assertThat(self.statusCode()).isEqualTo(422);
            assertThat(self.body()).contains("REVIEW_SELF_ASSIGNMENT_REFUSED");
            Map<String, Object> assignBody = assignment("assign-" + run, reviewer, expires);
            JsonNode assigned = post(port, tenant, ownerToken, casePath + "/assignments", assignBody, 201);
            String assignmentId = assigned.path("assignment").path("assignmentId").asString();
            assertThat(assigned.path("assignment").path("assignmentVersion").asLong()).isEqualTo(1);
            assertThat(assigned.path("establishesApproval").asBoolean()).isFalse();

            JsonNode first = post(port, tenant, reviewerToken, casePath + "/decisions",
                    decision("d-1-" + run, 0, "QUALITY"), 201);
            assertThat(first.path("establishesApproval").asBoolean()).isFalse();

            stopLauncher(launcher);
            launcher = null;
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            ownerToken = issueDevToken(tenant, owner);
            reviewerToken = issueDevToken(tenant, reviewer);

            // After restart: the decision and the assignment are durable and still scope the reviewer.
            JsonNode view = get(port, tenant, reviewerToken, casePath, 200);
            assertThat(view.path("caseRevision").asLong()).isEqualTo(1);
            assertThat(view.path("reviewState").path("status").asString()).isEqualTo("DEV_ASSIGNED_REVIEWER_ACCEPT_CURRENT");
            assertThat(view.path("reviewState").path("establishesApproval").asBoolean()).isFalse();
            assertThat(view.path("reviewState").path("humanReviewApproval").asBoolean()).isFalse();
            assertThat(view.path("records").get(0).path("principalId").asString()).isEqualTo(reviewer);
            assertThat(view.path("records").get(0).path("scope").asString()).isEqualTo("QUALITY");
            assertThat(view.path("assignments").get(0).path("assignmentId").asString()).isEqualTo(assignmentId);
            assertThat(view.path("assignments").get(0).path("status").asString()).isEqualTo("ACTIVE");
            HttpResponse<String> outOfScope = send(port, tenant, reviewerToken, "POST", casePath + "/decisions",
                    JSON.writeValueAsString(decision("d-scope-" + run, 1, "APPROVAL")));
            assertThat(outOfScope.statusCode()).isEqualTo(403);
            assertThat(outOfScope.body()).contains("REVIEW_SCOPE_NOT_ASSIGNED");
            post(port, tenant, reviewerToken, casePath + "/decisions", decision("d-2-" + run, 1, "RIGHTS"), 201);
            JsonNode replay = post(port, tenant, ownerToken, casePath + "/assignments", assignBody, 200);
            assertThat(replay.path("replayed").asBoolean()).isTrue();
            assertThat(replay.path("assignment").path("assignmentId").asString()).isEqualTo(assignmentId);

            // Revocation after restart (owner only; CAS on the case revision) blocks the reviewer.
            String revokePath = casePath + "/assignments/" + assignmentId + "/revoke";
            assertThat(send(port, tenant, reviewerToken, "POST", revokePath, JSON.writeValueAsString(Map.of(
                    "requestId", "revoke-by-reviewer-" + run, "expectedCaseRevision", 2))).statusCode()).isEqualTo(403);
            assertThat(send(port, tenant, ownerToken, "POST", revokePath, JSON.writeValueAsString(Map.of(
                    "requestId", "revoke-stale-" + run, "expectedCaseRevision", 0))).statusCode()).isEqualTo(409);
            JsonNode revoked = post(port, tenant, ownerToken, revokePath, Map.of(
                    "requestId", "revoke-" + run, "expectedCaseRevision", 2), 200);
            assertThat(revoked.path("assignment").path("status").asString()).isEqualTo("REVOKED");
            assertThat(revoked.path("assignment").path("assignmentVersion").asLong()).isEqualTo(2);
            HttpResponse<String> blocked = send(port, tenant, reviewerToken, "POST", casePath + "/decisions",
                    JSON.writeValueAsString(decision("d-3-" + run, 2, "QUALITY")));
            assertThat(blocked.statusCode()).isEqualTo(403);
            assertThat(blocked.body()).contains("REVIEWER_NOT_ASSIGNED");

            // The revocation itself survives a second restart and still blocks.
            stopLauncher(launcher);
            launcher = null;
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            ownerToken = issueDevToken(tenant, owner);
            reviewerToken = issueDevToken(tenant, reviewer);
            HttpResponse<String> stillBlocked = send(port, tenant, reviewerToken, "POST", casePath + "/decisions",
                    JSON.writeValueAsString(decision("d-4-" + run, 2, "QUALITY")));
            assertThat(stillBlocked.statusCode()).isEqualTo(403);
            JsonNode afterRevoke = get(port, tenant, ownerToken, casePath, 200);
            assertThat(afterRevoke.path("caseRevision").asLong()).isEqualTo(2);
            assertThat(afterRevoke.path("assignments").get(0).path("status").asString()).isEqualTo("REVOKED");
            assertThat(afterRevoke.path("reviewState").path("establishesApproval").asBoolean()).isFalse();

            // Immutable versions live in the isolated DEV_ONLY schema: version 1 (ACTIVE) and version 2 (REVOKED).
            try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                    POSTGRES.getPassword());
                 var statement = connection.prepareStatement("SELECT assignment_version,status FROM \"" + schema
                         + "\".media_review_assignment_versions WHERE tenant_id=? ORDER BY assignment_version")) {
                statement.setString(1, tenant);
                try (var rows = statement.executeQuery()) {
                    assertThat(rows.next()).isTrue();
                    assertThat(rows.getLong(1)).isEqualTo(1);
                    assertThat(rows.getString(2)).isEqualTo("ACTIVE");
                    assertThat(rows.next()).isTrue();
                    assertThat(rows.getLong(1)).isEqualTo(2);
                    assertThat(rows.getString(2)).isEqualTo("REVOKED");
                    assertThat(rows.next()).isFalse();
                }
            }
        } finally {
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            Files.deleteIfExists(log);
            deleteTree(services);
        }
    }

    private static Map<String, Object> decision(String requestId, long revision, String scope) {
        return Map.of("requestId", requestId, "expectedCaseRevision", revision, "decision", "ACCEPT",
                "reason", "DEV_ONLY assigned review", "scope", scope, "confirmed", true);
    }

    private static Map<String, Object> assignment(String requestId, String reviewer, Instant expires) {
        return Map.of("requestId", requestId, "expectedCaseRevision", 0, "reviewerPrincipalId", reviewer,
                "scopes", List.of("QUALITY", "RIGHTS"), "expiresAt", expires.toString());
    }
}
