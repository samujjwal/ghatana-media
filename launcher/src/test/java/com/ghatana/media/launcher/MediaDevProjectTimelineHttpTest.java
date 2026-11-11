package com.ghatana.media.launcher;

import com.ghatana.media.production.timeline.InMemoryProjectTimelineStore;
import com.ghatana.media.runtime.ManagedProjectTimelineStore;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Created;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Project;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectTimelineStore;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Revision;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.TimelineSnapshot;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

class MediaDevProjectTimelineHttpTest {
    private static final String TENANT = "tenant-local";
    private static final String PRINCIPAL = "principal-local";
    private static final String SECRET = "test-only-dev-project-secret-at-least-32-bytes";
    private static final String ISSUER = "urn:ghatana:media:dev-only";
    private static final String AUDIENCE = "ghatana-media-dev";
    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-11-09T20:00:00Z"), java.time.ZoneOffset.UTC);
    private static final Set<String> PROJECT_PERMISSIONS = Set.of(
            "media:project:dev:create", "media:project:dev:read", "media:project:dev:write");
    private static final Set<String> ARTIFACT_CREATE_PERMISSION = Set.of("media:artifact:create");
    private static final Set<String> JOB_CANCEL_PERMISSION = Set.of("media:job:cancel");
    private static final ObjectMapper JSON = JsonMapper.builder()
            .addModules(tools.jackson.databind.cfg.MapperBuilder.findModules()).build();

    @Test
    void localJobCancellationIsSignedScopedReplaySafeAndSeparateFromCanonicalRoutes() throws Exception {
        Path root = Files.createTempDirectory("media-dev-job-cancel-http-");
        AtomicInteger cancellationCalls = new AtomicInteger();
        AtomicInteger cooperativeSignals = new AtomicInteger();
        MediaRuntime mediaRuntime = runtime(root, new CancellationProvider(cancellationCalls, cooperativeSignals));
        HttpServer server = server(mediaRuntime, null);
        try {
            byte[] source = "dev-cancellation-route".getBytes(StandardCharsets.UTF_8);
            String sha256 = java.util.HexFormat.of().formatHex(
                    java.security.MessageDigest.getInstance("SHA-256").digest(source));
            var upload = mediaRuntime.beginUpload(new UploadRequest(TENANT, PRINCIPAL, "source.bin",
                    "application/octet-stream", source.length, sha256, "INTERNAL", Duration.ofMinutes(1), Map.of()),
                    "dev-cancel-route-upload");
            mediaRuntime.appendChunk(TENANT, PRINCIPAL, upload.uploadId(), 0, source);
            var artifact = mediaRuntime.completeUpload(TENANT, PRINCIPAL, upload.uploadId());
            var job = mediaRuntime.submit(new ProcessingJobRequest(
                    "dev-cancel-route-submit", TENANT, PRINCIPAL, "dev-cancel-route-correlation",
                    artifact.artifactId(), JobType.TRANSCODE, "dev-project-http-no-effect", Map.of()));
            awaitRunning(mediaRuntime, job.jobId());
            String request = JSON.writeValueAsString(Map.of("requestId", "dev-cancel-route-1"));

            HttpResponse<String> first = send(base(server), "POST", "/dev/v1/jobs/" + job.jobId() + "/cancel",
                    request, PRINCIPAL, TENANT, JOB_CANCEL_PERMISSION, true);
            assertThat(first.statusCode()).as(first.body()).isEqualTo(200);
            Map<String, Object> firstResult = read(first.body());
            assertThat(firstResult).containsEntry("schemaVersion", "media.dev.job-cancellation-result.v1")
                    .containsEntry("scope", "DEV_ONLY")
                    .containsEntry("requestId", "dev-cancel-route-1")
                    .containsEntry("outcome", "REQUESTED_UNCONFIRMED").containsEntry("replayed", false);
            Map<String, Object> cancellationJob = object(firstResult.get("job"));
            Map<String, Object> cancellationRecord = object(object(cancellationJob.get("result"))
                    .get("devOnlyCancellation"));
            assertThat(cancellationRecord).containsEntry("providerOutcome", "UNSUPPORTED")
                    .containsEntry("runtimeCancellationSignal", true);

            HttpResponse<String> replay = send(base(server), "POST", "/dev/v1/jobs/" + job.jobId() + "/cancel",
                    request, PRINCIPAL, TENANT, JOB_CANCEL_PERMISSION, true);
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
            assertThat(read(replay.body()).get("replayed")).isEqualTo(true);
            assertThat(cancellationCalls).hasValue(1);
            assertThat(cooperativeSignals).hasValue(1);

            HttpResponse<String> missingPermission = send(base(server), "POST",
                    "/dev/v1/jobs/" + job.jobId() + "/cancel", request, PRINCIPAL, TENANT,
                    ARTIFACT_CREATE_PERMISSION, true);
            assertThat(missingPermission.statusCode()).isEqualTo(403);
            assertThat(MediaRouteManifest.isKnownPath("/dev/v1/jobs/{jobId}/cancel")).isFalse();
            assertThat(MediaRouteManifest.isKnownPath("/api/v1/jobs/{jobId}/cancel")).isTrue();
        } finally {
            server.stop(0);
            mediaRuntime.close();
        }
    }

    @Test
    void devHostCreatesAndReopensProjectTimelineWithOwnerAndRevisionBoundaries() throws Exception {
        Path root = Files.createTempDirectory("media-dev-project-http-");
        MediaRuntime mediaRuntime = runtime(root);
        MediaDevProjectTimelineRuntime projectRuntime = new MediaDevProjectTimelineRuntime(new InMemoryManagedStore());
        HttpServer server = server(mediaRuntime, projectRuntime);
        try {
            String base = base(server);
            HttpResponse<String> context = send(base, "GET", "/dev/v1/context", null, PRINCIPAL,
                    TENANT, PROJECT_PERMISSIONS, true);
            assertThat(context.statusCode()).isEqualTo(200);
            assertThat(context.body()).contains("DEV_ONLY", "synthetic-local-owner-scope");
            Map<String, Object> contextBody = read(context.body());
            String workspaceId = (String) contextBody.get("selectedAuthorizedWorkspaceId");

            String createBody = JSON.writeValueAsString(Map.of(
                    "selectedAuthorizedWorkspaceId", workspaceId,
                    "title", "Local edit",
                    "requestId", "create-local-1"));
            HttpResponse<String> created = send(base, "POST", "/dev/v1/projects", createBody,
                    PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(created.statusCode()).isEqualTo(201);
            Map<String, Object> createdBody = read(created.body());
            Map<String, Object> project = object(createdBody.get("project"));
            Map<String, Object> initial = object(createdBody.get("initialRevision"));
            String projectId = (String) project.get("projectId");
            String initialRevisionId = (String) initial.get("revisionId");
            assertThat(initial.get("timelines")).isEqualTo(List.of());
            assertThat(project.get("workspaceId")).isEqualTo(workspaceId);
            assertThat(createdBody.get("scope")).isEqualTo("DEV_ONLY");

            HttpResponse<String> replay = send(base, "POST", "/dev/v1/projects", createBody,
                    PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(replay.statusCode()).isEqualTo(200);
            assertThat(read(replay.body()).get("createdNow")).isEqualTo(false);
            assertThat(object(read(replay.body()).get("project")).get("projectId")).isEqualTo(projectId);

            String timelineBody = JSON.writeValueAsString(Map.of(
                    "expectedHeadRevisionId", initialRevisionId,
                    "timelineId", "timeline-main"));
            HttpResponse<String> timeline = send(base, "POST", "/dev/v1/projects/" + projectId + "/timelines",
                    timelineBody, PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(timeline.statusCode()).isEqualTo(201);
            Map<String, Object> timelineRevision = object(read(timeline.body()).get("revision"));
            String currentRevisionId = (String) timelineRevision.get("revisionId");
            assertThat(timelineRevision.get("parentRevisionId")).isEqualTo(initialRevisionId);
            assertThat(timelineRevision.get("timelines").toString()).contains("timeline-main");

            String editBody = JSON.writeValueAsString(Map.of(
                    "expectedHeadRevisionId", currentRevisionId,
                    "edits", List.of(
                            Map.of("type", "addScene", "sceneId", "scene-main", "order", 0),
                            Map.of("type", "addTrack", "trackId", "video-main", "sceneId", "scene-main",
                                    "trackKind", "VIDEO", "order", 0))));
            HttpResponse<String> edited = send(base, "POST",
                    "/dev/v1/projects/" + projectId + "/timelines/timeline-main/edits", editBody,
                    PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(edited.statusCode()).isEqualTo(201);
            Map<String, Object> editedRevision = object(read(edited.body()).get("revision"));
            String editedRevisionId = (String) editedRevision.get("revisionId");
            assertThat(editedRevision.get("parentRevisionId")).isEqualTo(currentRevisionId);
            assertThat(editedRevision.get("timelines").toString()).contains("scene-main", "video-main", "VIDEO");
            currentRevisionId = editedRevisionId;

            HttpResponse<String> reopened = send(base, "GET", "/dev/v1/projects/" + projectId,
                    null, PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(reopened.statusCode()).isEqualTo(200);
            assertThat(object(read(reopened.body()).get("currentRevision")).get("revisionId"))
                    .isEqualTo(currentRevisionId);
            HttpResponse<String> exactRevision = send(base, "GET",
                    "/dev/v1/projects/" + projectId + "/revisions/" + initialRevisionId,
                    null, PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(exactRevision.statusCode()).isEqualTo(200);
            assertThat(object(read(exactRevision.body()).get("revision")).get("timelines")).isEqualTo(List.of());

            assertThat(object(read(timeline.body()).get("revision")).get("timelines").toString())
                    .doesNotContain("scene-main", "video-main");

            HttpResponse<String> staleEdit = send(base, "POST",
                    "/dev/v1/projects/" + projectId + "/timelines/timeline-main/edits",
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", initialRevisionId,
                            "edits", List.of(Map.of("type", "addScene", "sceneId", "scene-stale", "order", 1)))),
                    PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(staleEdit.statusCode()).isEqualTo(409);
            assertThat(staleEdit.body()).contains("REVISION_CONFLICT", currentRevisionId);

            HttpResponse<String> malformedEdit = send(base, "POST",
                    "/dev/v1/projects/" + projectId + "/timelines/timeline-main/edits",
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", currentRevisionId,
                            "edits", List.of(Map.of("type", "addTrack", "trackId", "detached-track",
                                    "sceneId", "missing-scene", "trackKind", "VIDEO", "order", 0)))),
                    PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(malformedEdit.statusCode()).isEqualTo(400);
            assertThat(object(read(send(base, "GET", "/dev/v1/projects/" + projectId,
                    null, PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true).body()).get("currentRevision"))
                    .get("revisionId")).isEqualTo(currentRevisionId);

            HttpResponse<String> blockedSceneRemoval = send(base, "POST",
                    "/dev/v1/projects/" + projectId + "/timelines/timeline-main/edits",
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", currentRevisionId,
                            "edits", List.of(Map.of("type", "removeScene", "sceneId", "scene-main")))),
                    PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(blockedSceneRemoval.statusCode()).isEqualTo(400);
            assertThat(blockedSceneRemoval.body()).contains("INVALID_REQUEST");
            assertThat(object(read(send(base, "GET", "/dev/v1/projects/" + projectId,
                    null, PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true).body()).get("currentRevision"))
                    .get("revisionId")).isEqualTo(currentRevisionId);

            HttpResponse<String> removeTrack = send(base, "POST",
                    "/dev/v1/projects/" + projectId + "/timelines/timeline-main/edits",
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", currentRevisionId,
                            "edits", List.of(Map.of("type", "removeTrack", "trackId", "video-main")))),
                    PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(removeTrack.statusCode()).isEqualTo(201);
            Map<String, Object> trackRemovedRevision = object(read(removeTrack.body()).get("revision"));
            String trackRemovedRevisionId = (String) trackRemovedRevision.get("revisionId");
            assertThat(trackRemovedRevision.get("parentRevisionId")).isEqualTo(currentRevisionId);
            assertThat(trackRemovedRevision.get("timelines").toString()).contains("scene-main")
                    .doesNotContain("video-main");
            currentRevisionId = trackRemovedRevisionId;

            HttpResponse<String> removeScene = send(base, "POST",
                    "/dev/v1/projects/" + projectId + "/timelines/timeline-main/edits",
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", currentRevisionId,
                            "edits", List.of(Map.of("type", "removeScene", "sceneId", "scene-main")))),
                    PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(removeScene.statusCode()).isEqualTo(201);
            Map<String, Object> sceneRemovedRevision = object(read(removeScene.body()).get("revision"));
            String sceneRemovedRevisionId = (String) sceneRemovedRevision.get("revisionId");
            assertThat(sceneRemovedRevision.get("parentRevisionId")).isEqualTo(currentRevisionId);
            assertThat(sceneRemovedRevision.get("timelines").toString()).contains("timeline-main")
                    .doesNotContain("scene-main", "video-main");
            currentRevisionId = sceneRemovedRevisionId;

            HttpResponse<String> undoSceneRemoval = send(base, "POST", "/dev/v1/projects/" + projectId + "/restore",
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", currentRevisionId,
                            "targetRevisionId", trackRemovedRevisionId)),
                    PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(undoSceneRemoval.statusCode()).isEqualTo(201);
            Map<String, Object> undoSceneRevision = object(read(undoSceneRemoval.body()).get("revision"));
            String undoSceneRevisionId = (String) undoSceneRevision.get("revisionId");
            assertThat(undoSceneRevision.get("parentRevisionId")).isEqualTo(currentRevisionId);
            assertThat(undoSceneRevisionId).isNotEqualTo(trackRemovedRevisionId);
            assertThat(undoSceneRevision.get("timelines").toString()).contains("scene-main")
                    .doesNotContain("video-main");
            currentRevisionId = undoSceneRevisionId;

            HttpResponse<String> undoTrackRemoval = send(base, "POST", "/dev/v1/projects/" + projectId + "/restore",
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", currentRevisionId,
                            "targetRevisionId", editedRevisionId)),
                    PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(undoTrackRemoval.statusCode()).isEqualTo(201);
            Map<String, Object> undoTrackRevision = object(read(undoTrackRemoval.body()).get("revision"));
            String undoTrackRevisionId = (String) undoTrackRevision.get("revisionId");
            assertThat(undoTrackRevision.get("parentRevisionId")).isEqualTo(currentRevisionId);
            assertThat(undoTrackRevisionId).isNotEqualTo(editedRevisionId);
            assertThat(undoTrackRevision.get("timelines").toString()).contains("scene-main", "video-main", "VIDEO");
            currentRevisionId = undoTrackRevisionId;

            HttpResponse<String> redoTrackRemoval = send(base, "POST", "/dev/v1/projects/" + projectId + "/restore",
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", currentRevisionId,
                            "targetRevisionId", trackRemovedRevisionId)),
                    PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(redoTrackRemoval.statusCode()).isEqualTo(201);
            Map<String, Object> redoTrackRevision = object(read(redoTrackRemoval.body()).get("revision"));
            String redoTrackRevisionId = (String) redoTrackRevision.get("revisionId");
            assertThat(redoTrackRevision.get("parentRevisionId")).isEqualTo(currentRevisionId);
            assertThat(redoTrackRevision.get("timelines").toString()).contains("scene-main")
                    .doesNotContain("video-main");
            currentRevisionId = redoTrackRevisionId;

            HttpResponse<String> redoSceneRemoval = send(base, "POST", "/dev/v1/projects/" + projectId + "/restore",
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", currentRevisionId,
                            "targetRevisionId", sceneRemovedRevisionId)),
                    PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(redoSceneRemoval.statusCode()).isEqualTo(201);
            Map<String, Object> redoSceneRevision = object(read(redoSceneRemoval.body()).get("revision"));
            String redoSceneRevisionId = (String) redoSceneRevision.get("revisionId");
            assertThat(redoSceneRevision.get("parentRevisionId")).isEqualTo(currentRevisionId);
            assertThat(redoSceneRevision.get("timelines").toString()).contains("timeline-main")
                    .doesNotContain("scene-main", "video-main");
            currentRevisionId = redoSceneRevisionId;

            HttpResponse<String> exactTrackRemoved = send(base, "GET",
                    "/dev/v1/projects/" + projectId + "/revisions/" + trackRemovedRevisionId,
                    null, PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(exactTrackRemoved.statusCode()).isEqualTo(200);
            assertThat(object(read(exactTrackRemoved.body()).get("revision")).get("timelines").toString())
                    .contains("scene-main").doesNotContain("video-main");
            HttpResponse<String> exactSceneRemoved = send(base, "GET",
                    "/dev/v1/projects/" + projectId + "/revisions/" + sceneRemovedRevisionId,
                    null, PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(exactSceneRemoved.statusCode()).isEqualTo(200);
            assertThat(object(read(exactSceneRemoved.body()).get("revision")).get("timelines").toString())
                    .doesNotContain("scene-main", "video-main");
            HttpResponse<String> exactUndoTrack = send(base, "GET",
                    "/dev/v1/projects/" + projectId + "/revisions/" + undoTrackRevisionId,
                    null, PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(exactUndoTrack.statusCode()).isEqualTo(200);
            assertThat(object(read(exactUndoTrack.body()).get("revision")).get("timelines").toString())
                    .contains("scene-main", "video-main");
            HttpResponse<String> exactRedoScene = send(base, "GET",
                    "/dev/v1/projects/" + projectId + "/revisions/" + redoSceneRevisionId,
                    null, PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(exactRedoScene.statusCode()).isEqualTo(200);
            assertThat(object(read(exactRedoScene.body()).get("revision")).get("timelines").toString())
                    .doesNotContain("scene-main", "video-main");

            HttpResponse<String> exactBeforeUndo = send(base, "GET",
                    "/dev/v1/projects/" + projectId + "/revisions/" + editedRevisionId,
                    null, PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(exactBeforeUndo.statusCode()).isEqualTo(200);
            assertThat(object(read(exactBeforeUndo.body()).get("revision")).get("timelines").toString())
                    .contains("scene-main", "video-main");
            HttpResponse<String> staleRestore = send(base, "POST", "/dev/v1/projects/" + projectId + "/restore",
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", editedRevisionId,
                            "targetRevisionId", timelineRevision.get("revisionId"))),
                    PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(staleRestore.statusCode()).isEqualTo(409);
            assertThat(staleRestore.body()).contains("REVISION_CONFLICT", currentRevisionId);
            HttpResponse<String> missingRestoreTarget = send(base, "POST",
                    "/dev/v1/projects/" + projectId + "/restore",
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", currentRevisionId,
                            "targetRevisionId", "missing-revision")),
                    PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(missingRestoreTarget.statusCode()).isEqualTo(404);

            HttpResponse<String> missingWritePermission = send(base, "POST",
                    "/dev/v1/projects/" + projectId + "/timelines/timeline-main/edits", editBody,
                    PRINCIPAL, TENANT, Set.of("media:project:dev:read"), true);
            assertThat(missingWritePermission.statusCode()).isEqualTo(403);
            HttpResponse<String> missingRestoreWritePermission = send(base, "POST",
                    "/dev/v1/projects/" + projectId + "/restore",
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", currentRevisionId,
                            "targetRevisionId", editedRevisionId)),
                    PRINCIPAL, TENANT, Set.of("media:project:dev:read"), true);
            assertThat(missingRestoreWritePermission.statusCode()).isEqualTo(403);

            HttpResponse<String> stale = send(base, "POST", "/dev/v1/projects/" + projectId + "/timelines",
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", initialRevisionId,
                            "timelineId", "timeline-stale")), PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(stale.statusCode()).isEqualTo(409);
            assertThat(stale.body()).contains("REVISION_CONFLICT", currentRevisionId);

            HttpResponse<String> otherOwner = send(base, "GET", "/dev/v1/projects/" + projectId,
                    null, "principal-other", TENANT, PROJECT_PERMISSIONS, true);
            assertThat(otherOwner.statusCode()).isEqualTo(403);
            HttpResponse<String> otherOwnerRestore = send(base, "POST", "/dev/v1/projects/" + projectId + "/restore",
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", currentRevisionId,
                            "targetRevisionId", timelineRevision.get("revisionId"))),
                    "principal-other", TENANT, PROJECT_PERMISSIONS, true);
            assertThat(otherOwnerRestore.statusCode()).isEqualTo(403);
            HttpResponse<String> otherTenant = send(base, "GET", "/dev/v1/projects/" + projectId,
                    null, PRINCIPAL, "tenant-other", PROJECT_PERMISSIONS, true);
            assertThat(otherTenant.statusCode()).isEqualTo(404);
            HttpResponse<String> otherTenantRestore = send(base, "POST", "/dev/v1/projects/" + projectId + "/restore",
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", currentRevisionId,
                            "targetRevisionId", timelineRevision.get("revisionId"))),
                    PRINCIPAL, "tenant-other", PROJECT_PERMISSIONS, true);
            assertThat(otherTenantRestore.statusCode()).isEqualTo(404);

            HttpResponse<String> ordinaryToken = send(base, "GET", "/dev/v1/context",
                    null, PRINCIPAL, TENANT, Set.of("media:project:dev:read"), false);
            assertThat(ordinaryToken.statusCode()).isEqualTo(401);
        } finally {
            server.stop(0);
            projectRuntime.close();
            mediaRuntime.close();
            try (var paths = Files.walk(root)) {
                for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
            }
        }
    }

    @Test
    void devTimelineClipEditsRequireExactPrincipalOwnedArtifactVersionAndPreserveRationalTicks() throws Exception {
        Path root = Files.createTempDirectory("media-dev-project-clips-");
        MediaRuntime mediaRuntime = runtime(root);
        MediaDevProjectTimelineRuntime projectRuntime = new MediaDevProjectTimelineRuntime(new InMemoryManagedStore());
        HttpServer server = server(mediaRuntime, projectRuntime);
        try {
            String base = base(server);
            String bytes = "clip source fixture";
            byte[] sourceBytes = bytes.getBytes(StandardCharsets.UTF_8);
            Set<String> artifactPermissions = Set.of("media:artifact:create", "media:artifact:write", "media:artifact:read");
            Map<String, Object> artifact = createArtifact(base, PRINCIPAL, TENANT, artifactPermissions,
                    sourceBytes, "clip-source-upload");
            String artifactId = (String) artifact.get("artifactId");
            String artifactVersionId = "sha256:" + artifact.get("sha256");
            HttpResponse<String> noArtifactRead = send(base, "GET", "/api/v1/artifacts/" + artifactId,
                    null, PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(noArtifactRead.statusCode()).isEqualTo(403);

            String workspaceId = (String) read(send(base, "GET", "/dev/v1/context", null,
                    PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true).body()).get("selectedAuthorizedWorkspaceId");
            HttpResponse<String> created = send(base, "POST", "/dev/v1/projects", JSON.writeValueAsString(Map.of(
                    "selectedAuthorizedWorkspaceId", workspaceId, "title", "Clip test", "requestId", "clip-project-1")),
                    PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            String projectId = (String) object(read(created.body()).get("project")).get("projectId");
            String revisionId = (String) object(read(created.body()).get("initialRevision")).get("revisionId");
            HttpResponse<String> timeline = send(base, "POST", "/dev/v1/projects/" + projectId + "/timelines",
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", revisionId, "timelineId", "timeline-main")),
                    PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            revisionId = (String) object(read(timeline.body()).get("revision")).get("revisionId");
            HttpResponse<String> nodes = send(base, "POST", "/dev/v1/projects/" + projectId + "/timelines/timeline-main/edits",
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", revisionId, "edits", List.of(
                            Map.of("type", "addScene", "sceneId", "scene-main", "order", 0),
                            Map.of("type", "addTrack", "trackId", "video-main", "sceneId", "scene-main",
                                    "trackKind", "VIDEO", "order", 0)))), PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(nodes.statusCode()).as(nodes.body()).isEqualTo(201);
            revisionId = (String) object(read(nodes.body()).get("revision")).get("revisionId");

            Map<String, Object> clip = Map.of(
                    "clipId", "clip-main", "sceneId", "scene-main", "trackId", "video-main",
                    "source", Map.of("artifactId", artifactId, "artifactVersionId", artifactVersionId),
                    "sourceIn", Map.of("ticks", "9007199254740993", "rateNumerator", "30000", "rateDenominator", "1001", "clock", "SOURCE_PRESENTATION"),
                    "sourceOut", Map.of("ticks", "9007199254743993", "rateNumerator", "30000", "rateDenominator", "1001", "clock", "SOURCE_PRESENTATION"),
                    "storyStart", Map.of("ticks", "0", "rateNumerator", "24", "rateDenominator", "1", "clock", "STORY"),
                    "storyDuration", Map.of("ticks", "240", "rateNumerator", "24", "rateDenominator", "1", "clock", "STORY"));
            String clipEditPath = "/dev/v1/projects/" + projectId + "/timelines/timeline-main/edits";
            HttpResponse<String> noReadPermission = send(base, "POST", clipEditPath,
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", revisionId,
                            "edits", List.of(Map.of("type", "putClip", "clip", clip)))),
                    PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true);
            assertThat(noReadPermission.statusCode()).isEqualTo(403);
            assertThat(read(send(base, "GET", "/dev/v1/projects/" + projectId, null,
                    PRINCIPAL, TENANT, PROJECT_PERMISSIONS, true).body()).get("currentRevision").toString())
                    .contains(revisionId);

            Set<String> editorPermissions = new java.util.HashSet<>(PROJECT_PERMISSIONS);
            editorPermissions.add("media:artifact:read");
            HttpResponse<String> put = send(base, "POST", clipEditPath,
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", revisionId,
                            "edits", List.of(Map.of("type", "putClip", "clip", clip)))),
                    PRINCIPAL, TENANT, editorPermissions, true);
            assertThat(put.statusCode()).as(put.body()).isEqualTo(201);
            Map<String, Object> putRevision = object(read(put.body()).get("revision"));
            String putRevisionId = (String) putRevision.get("revisionId");
            String clips = putRevision.get("timelines").toString();
            assertThat(clips).contains(artifactId, artifactVersionId, "9007199254740993", "30000", "SOURCE_PRESENTATION", "STORY");

            HttpResponse<String> remove = send(base, "POST", clipEditPath,
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", putRevisionId,
                            "edits", List.of(Map.of("type", "removeClip", "clipId", "clip-main")))),
                    PRINCIPAL, TENANT, editorPermissions, true);
            assertThat(remove.statusCode()).as(remove.body()).isEqualTo(201);
            String removedRevisionId = (String) object(read(remove.body()).get("revision")).get("revisionId");

            Map<String, Object> foreignArtifact = createArtifact(base, "principal-other", TENANT, artifactPermissions,
                    "foreign source".getBytes(StandardCharsets.UTF_8), "foreign-clip-source-upload");
            Map<String, Object> foreignSourceClip = new java.util.LinkedHashMap<>(clip);
            foreignSourceClip.put("clipId", "clip-foreign");
            foreignSourceClip.put("source", Map.of("artifactId", foreignArtifact.get("artifactId"),
                    "artifactVersionId", "sha256:" + foreignArtifact.get("sha256")));
            HttpResponse<String> wrongPrincipal = send(base, "POST", clipEditPath,
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", removedRevisionId,
                            "edits", List.of(Map.of("type", "putClip", "clip", foreignSourceClip)))),
                    PRINCIPAL, TENANT, editorPermissions, true);
            assertThat(wrongPrincipal.statusCode()).isEqualTo(404);
            Map<String, Object> missingArtifactClip = new java.util.LinkedHashMap<>(clip);
            missingArtifactClip.put("clipId", "clip-missing-source");
            missingArtifactClip.put("source", Map.of("artifactId", "artifact-missing", "artifactVersionId", artifactVersionId));
            HttpResponse<String> missingArtifact = send(base, "POST", clipEditPath,
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", removedRevisionId,
                            "edits", List.of(Map.of("type", "putClip", "clip", missingArtifactClip)))),
                    PRINCIPAL, TENANT, editorPermissions, true);
            assertThat(missingArtifact.statusCode()).isEqualTo(404);
            Map<String, Object> staleSourceClip = new java.util.LinkedHashMap<>(clip);
            staleSourceClip.put("source", Map.of("artifactId", artifactId, "artifactVersionId", "sha256:" + "0".repeat(64)));
            HttpResponse<String> staleVersion = send(base, "POST", clipEditPath,
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", removedRevisionId,
                            "edits", List.of(Map.of("type", "putClip", "clip", staleSourceClip)))),
                    PRINCIPAL, TENANT, editorPermissions, true);
            assertThat(staleVersion.statusCode()).isEqualTo(404);
            Map<String, Object> wrongClockClip = new java.util.LinkedHashMap<>(clip);
            wrongClockClip.put("sourceIn", Map.of("ticks", "1", "rateNumerator", "1", "rateDenominator", "1", "clock", "STORY"));
            HttpResponse<String> wrongClock = send(base, "POST", clipEditPath,
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", removedRevisionId,
                            "edits", List.of(Map.of("type", "putClip", "clip", wrongClockClip)))),
                    PRINCIPAL, TENANT, editorPermissions, true);
            assertThat(wrongClock.statusCode()).isEqualTo(400);
            HttpResponse<String> extraField = send(base, "POST", clipEditPath,
                    "{\"expectedHeadRevisionId\":\"" + removedRevisionId + "\",\"unexpected\":true,\"edits\":[]}",
                    PRINCIPAL, TENANT, editorPermissions, true);
            assertThat(extraField.statusCode()).isEqualTo(400);

            Map<String, Object> current = read(send(base, "GET", "/dev/v1/projects/" + projectId, null,
                    PRINCIPAL, TENANT, editorPermissions, true).body());
            assertThat(object(current.get("currentRevision")).get("revisionId")).isEqualTo(removedRevisionId);
        } finally {
            server.stop(0);
            projectRuntime.close();
            mediaRuntime.close();
            try (var paths = Files.walk(root)) {
                for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
            }
        }
    }

    @Test
    void contextProjectsArtifactCapabilitiesFromVerifiedDevTokenPermissions() throws Exception {
        Path root = Files.createTempDirectory("media-dev-project-capabilities-");
        MediaRuntime mediaRuntime = runtime(root);
        MediaDevProjectTimelineRuntime projectRuntime = new MediaDevProjectTimelineRuntime(new InMemoryManagedStore());
        HttpServer server = server(mediaRuntime, projectRuntime);
        try {
            String base = base(server);
            Set<String> projectRead = Set.of("media:project:dev:read");
            assertCapabilities(base, projectRead, false, false);

            Set<String> uploadOnlyMissingWrite = new java.util.HashSet<>(projectRead);
            uploadOnlyMissingWrite.add("media:artifact:create");
            assertCapabilities(base, uploadOnlyMissingWrite, false, false);

            Set<String> upload = new java.util.HashSet<>(projectRead);
            upload.addAll(Set.of("media:artifact:create", "media:artifact:write"));
            assertCapabilities(base, upload, true, false);

            Set<String> read = new java.util.HashSet<>(projectRead);
            read.add("media:artifact:read");
            assertCapabilities(base, read, false, true);

            Set<String> all = new java.util.HashSet<>(upload);
            all.add("media:artifact:read");
            assertCapabilities(base, all, true, true);
        } finally {
            server.stop(0);
            projectRuntime.close();
            mediaRuntime.close();
            try (var paths = Files.walk(root)) {
                for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
            }
        }
    }

    private static void assertCapabilities(String base, Set<String> permissions,
            boolean expectedUpload, boolean expectedRead) throws Exception {
        HttpResponse<String> response = send(base, "GET", "/dev/v1/context", null,
                PRINCIPAL, TENANT, permissions, true);
        assertThat(response.statusCode()).isEqualTo(200);
        Map<String, Object> context = read(response.body());
        assertThat(context.get("scope")).isEqualTo("DEV_ONLY");
        assertThat(object(context.get("capabilities"))).containsExactlyInAnyOrderEntriesOf(Map.of(
                "artifactUpload", expectedUpload,
                "artifactRead", expectedRead));
    }

    @Test
    void disabledLocalProjectRuntimeDoesNotExposeDevRoute() throws Exception {
        Path root = Files.createTempDirectory("media-dev-project-disabled-");
        MediaRuntime mediaRuntime = runtime(root);
        HttpServer server = server(mediaRuntime, null);
        try {
            HttpResponse<String> response = send(base(server), "GET", "/dev/v1/context",
                    null, PRINCIPAL, TENANT, Set.of("media:project:dev:read"), true);
            assertThat(response.statusCode()).isEqualTo(404);
            assertThat(response.body()).contains("NOT_FOUND");

            HttpResponse<String> policy = send(base(server), "GET", "/dev/v1/artifact-upload-policy",
                    null, PRINCIPAL, TENANT, ARTIFACT_CREATE_PERMISSION, true);
            assertThat(policy.statusCode()).isEqualTo(200);
            assertThat(read(policy.body())).containsExactlyInAnyOrderEntriesOf(Map.of(
                    "schemaVersion", "media.dev.artifact-upload-policy.v1",
                    "scope", "DEV_ONLY",
                    "maxChunkBytes", 131_072));

            HttpResponse<String> missingPermission = send(base(server), "GET", "/dev/v1/artifact-upload-policy",
                    null, PRINCIPAL, TENANT, Set.of("media:artifact:read"), true);
            assertThat(missingPermission.statusCode()).isEqualTo(403);
            HttpResponse<String> ordinaryToken = send(base(server), "GET", "/dev/v1/artifact-upload-policy",
                    null, PRINCIPAL, TENANT, ARTIFACT_CREATE_PERMISSION, false);
            assertThat(ordinaryToken.statusCode()).isEqualTo(401);
        } finally {
            server.stop(0);
            mediaRuntime.close();
            try (var paths = Files.walk(root)) {
                for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
            }
        }
    }

    @Test
    void devProjectRoutesRemainOutsideCanonicalProductionManifest() {
        assertThat(MediaRouteManifest.requiredPermission("GET", "/dev/v1/context")).isNull();
        assertThat(MediaRouteManifest.requiredPermission("POST", "/dev/v1/projects")).isNull();
        assertThat(MediaRouteManifest.isKnownPath("/dev/v1/projects")).isFalse();
        assertThat(MediaRouteManifest.requiredPermission("POST", "/dev/v1/projects/p/timelines/t/edits")).isNull();
        assertThat(MediaRouteManifest.isKnownPath("/dev/v1/projects/p/timelines/t/edits")).isFalse();
        assertThat(MediaRouteManifest.requiredPermission("POST", "/dev/v1/projects/p/restore")).isNull();
        assertThat(MediaRouteManifest.isKnownPath("/dev/v1/projects/p/restore")).isFalse();
        assertThat(MediaRouteManifest.requiredPermission("GET", "/dev/v1/artifact-upload-policy")).isNull();
        assertThat(MediaRouteManifest.isKnownPath("/dev/v1/artifact-upload-policy")).isFalse();
    }

    private static MediaRuntime runtime(Path root) {
        return runtime(root, new NoEffectProvider());
    }

    private static MediaRuntime runtime(Path root, MediaProcessingProvider provider) {
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "dev", 8093, 1_048_576, 131_072, 1_048_576,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(false),
                new LocalMediaRuntimeSupport.StreamStore(), null,
                List.of(provider),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
    }

    private static void awaitRunning(MediaRuntime runtime, String jobId) throws Exception {
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            JobStatus status = runtime.job(TENANT, PRINCIPAL, jobId).orElseThrow().status();
            if (status == JobStatus.RUNNING) return;
            if (status != JobStatus.ACCEPTED) throw new AssertionError("job left active state before cancellation: " + status);
            Thread.sleep(5);
        }
        throw new AssertionError("job did not become RUNNING before cancellation");
    }

    private static HttpServer server(MediaRuntime runtime, MediaDevProjectTimelineRuntime projectRuntime) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", new MediaSecurityFilter(
                new MediaHttpHandler(runtime, null, null, projectRuntime), "dev", devEnvironment(), CLOCK));
        server.start();
        return server;
    }

    private static String base(HttpServer server) { return "http://127.0.0.1:" + server.getAddress().getPort(); }

    private static HttpResponse<String> send(String base, String method, String path, String body,
            String principal, String tenant, Set<String> permissions, boolean devOnly) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(base + path))
                .header("Authorization", "Bearer " + token(principal, tenant, permissions, devOnly))
                .header("X-Tenant-Id", tenant);
        if (body != null) request.header("Content-Type", "application/json");
        request.method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private static HttpResponse<String> sendBytes(String base, String method, String path, byte[] body,
            String principal, String tenant, Set<String> permissions, String contentType, String idempotencyKey)
            throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(base + path))
                .header("Authorization", "Bearer " + token(principal, tenant, permissions, true))
                .header("X-Tenant-Id", tenant);
        if (contentType != null) request.header("Content-Type", contentType);
        if (idempotencyKey != null) request.header("Idempotency-Key", idempotencyKey);
        request.method(method, HttpRequest.BodyPublishers.ofByteArray(body));
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private static Map<String, Object> createArtifact(String base, String principal, String tenant,
            Set<String> permissions, byte[] sourceBytes, String idempotencyKey) throws Exception {
        String digest = java.util.HexFormat.of().formatHex(
                java.security.MessageDigest.getInstance("SHA-256").digest(sourceBytes));
        HttpResponse<String> upload = sendBytes(base, "POST", "/api/v1/artifacts/uploads", JSON.writeValueAsBytes(Map.of(
                "tenantId", tenant, "principalId", principal, "fileName", "source.mov",
                "contentType", "video/quicktime", "expectedSizeBytes", sourceBytes.length,
                "expectedSha256", digest, "classification", "INTERNAL", "retention", "PT10M", "metadata", Map.of())),
                principal, tenant, permissions, "application/json", idempotencyKey);
        assertThat(upload.statusCode()).as(upload.body()).isEqualTo(201);
        String uploadId = (String) read(upload.body()).get("uploadId");
        HttpResponse<String> chunk = sendBytes(base, "PUT", "/api/v1/artifacts/uploads/" + uploadId + "/chunks/0",
                sourceBytes, principal, tenant, Set.of("media:artifact:write"), "application/octet-stream", null);
        assertThat(chunk.statusCode()).as(chunk.body()).isEqualTo(200);
        HttpResponse<String> completed = sendBytes(base, "POST", "/api/v1/artifacts/uploads/" + uploadId + "/complete",
                new byte[0], principal, tenant, Set.of("media:artifact:write"), null, null);
        assertThat(completed.statusCode()).as(completed.body()).isEqualTo(201);
        return read(completed.body());
    }

    private static String token(String principal, String tenant, Set<String> permissions, boolean devOnly) throws Exception {
        String header = encode("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        String permissionJson = permissions.stream().sorted().map(permission -> "\"" + permission + "\"")
                .collect(java.util.stream.Collectors.joining(","));
        String payload = "{\"sub\":\"" + principal + "\",\"tenant_id\":\"" + tenant
                + "\",\"iss\":\"" + ISSUER + "\",\"aud\":\"" + AUDIENCE + "\","
                + (devOnly ? "\"dev_only\":true," : "")
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

    private static class NoEffectProvider implements MediaProcessingProvider {
        @Override public String providerId() { return "dev-project-http-no-effect"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.TRANSCODE); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 0; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            return CompletableFuture.failedFuture(new AssertionError("project routes must not invoke processing"));
        }
    }

    private static final class CancellationProvider extends NoEffectProvider {
        private final AtomicInteger cancellationCalls;
        private final AtomicInteger cooperativeSignals;
        private CancellationProvider(AtomicInteger cancellationCalls, AtomicInteger cooperativeSignals) {
            this.cancellationCalls = cancellationCalls;
            this.cooperativeSignals = cooperativeSignals;
        }
        @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            context.cancellation().onCancel(cooperativeSignals::incrementAndGet);
            return new CompletableFuture<>();
        }
        @Override public com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome cancel(
                String tenantId, String principalId, String correlationId, String jobId) {
            cancellationCalls.incrementAndGet();
            return com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome.UNSUPPORTED;
        }
    }
}
