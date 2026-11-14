package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRightsConsentContracts.Reason;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Verdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;

import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.InMemoryManagedStore;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.TENANT;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.base;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.object;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.read;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.runtime;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.send;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * DEV_ONLY caption correction over the real HTTP host, filter and artifact store with a programmable rights
 * resolver. The machine caption is a registered fixture artifact carrying the same lineage keys the speech lane writes;
 * the real Whisper path is covered by {@code MediaDevCaptionJourneyIT}.
 */
class MediaDevCaptionCorrectionHttpTest {
    private static final String OWNER = "test-principal-owner";
    private static final String OTHER = "test-principal-other";
    private static final Set<String> PERMISSIONS = Set.of("media:project:dev:create", "media:project:dev:read",
            "media:project:dev:write", "media:artifact:read", "media:artifact:create");
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final String MACHINE_VTT = "WEBVTT\n\n1\n00:00.000 --> 00:02.000\nAnd so my fellow Americans\n\n"
            + "2\n00:02.000 --> 00:04.500\nask not what your country can do for you\n\n";

    private final AtomicReference<Verdict> verdict = new AtomicReference<>(Verdict.ADMITTED);
    private final java.util.concurrent.atomic.AtomicInteger resolutions = new java.util.concurrent.atomic.AtomicInteger();
    private final RightsConsentResolver resolver = new RightsConsentResolver() {
        @Override public String resolverId() { return "test-resolver"; }
        @Override public boolean ready() { return true; }
        @Override public Resolution resolve(ResolutionRequest request) {
            resolutions.incrementAndGet();
            assertThat(request.artifactId()).isEqualTo("source-audio-1");
            return switch (verdict.get()) {
                case ADMITTED -> new Resolution(Verdict.ADMITTED, Set.of(), List.of("att-1"), resolverId());
                case REVOKED -> new Resolution(Verdict.REVOKED, Set.of(Reason.REVOKED), List.of(), resolverId());
                default -> Resolution.unavailable(resolverId());
            };
        }
    };

    @Test
    void correctionCreatesNewVersionWithLineageAndNeverOverwritesOrForks() throws Exception {
        Path root = Files.createTempDirectory("media-dev-caption-http-");
        MediaRuntime runtime = runtime(root, MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT, MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT_PER_TENANT);
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            MediaArtifact machine = machineCaption(runtime, MACHINE_VTT);

            HttpResponse<String> created = correct(base, OWNER, "corr-1", machine.artifactId(),
                    machine.version().value(), cues(0, 2000, "And so, my fellow Americans,", 2000, 4500,
                            "ask not what your country can do for you."));
            assertThat(created.statusCode()).as(created.body()).isEqualTo(201);
            Map<String, Object> body = read(created.body());
            String correctedId = (String) body.get("captionId");
            assertThat(correctedId).isNotEqualTo(machine.artifactId());
            assertThat(body).containsEntry("kind", MediaDevCaptionRuntime.KIND_CORRECTED)
                    .containsEntry("replayed", false).containsEntry("scope", "DEV_ONLY");
            Map<String, Object> lineage = object(body.get("lineage"));
            assertThat(object(lineage.get("parent"))).containsEntry("artifactId", machine.artifactId())
                    .containsEntry("artifactVersionId", machine.version().value())
                    .containsEntry("sha256", machine.sha256());
            assertThat(object(lineage.get("machineVersion"))).containsEntry("artifactId", machine.artifactId());
            assertThat(lineage).containsEntry("correctedByPrincipalId", OWNER).containsEntry("correctionNumber", 1);
            assertThat(object(lineage.get("source"))).containsEntry("artifactId", "source-audio-1");
            assertThat(object(lineage.get("edit"))).containsEntry("textChanged", 2).containsEntry("timingChanged", 0);
            assertThat(object(body.get("review"))).containsEntry("acceptedByAssignedReviewer", false)
                    .containsEntry("establishesApproval", false);

            // The base machine version is untouched, byte for byte.
            assertThat(new String(content(runtime, machine.artifactId()), StandardCharsets.UTF_8)).isEqualTo(MACHINE_VTT);
            // Reopen returns the corrected cues and lineage.
            Map<String, Object> reopened = read(send(base, "GET", "/dev/v1/captions/" + correctedId, null, OWNER,
                    PERMISSIONS).body());
            assertThat(((List<?>) reopened.get("cues"))).hasSize(2);
            assertThat(object(((List<?>) reopened.get("cues")).get(0))).containsEntry("text", "And so, my fellow Americans,");

            // Same requestId and cues replays the same artifact.
            HttpResponse<String> replay = correct(base, OWNER, "corr-1", machine.artifactId(),
                    machine.version().value(), cues(0, 2000, "And so, my fellow Americans,", 2000, 4500,
                            "ask not what your country can do for you."));
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
            assertThat(read(replay.body())).containsEntry("captionId", correctedId).containsEntry("replayed", true);

            // A second corrector of the same parent version cannot fork or overwrite: conflict.
            HttpResponse<String> fork = correct(base, OWNER, "corr-2", machine.artifactId(), machine.version().value(),
                    cues(0, 2000, "Different text", 2000, 4500, "ask not."));
            assertThat(fork.statusCode()).as(fork.body()).isEqualTo(409);
            assertThat(fork.body()).contains("CAPTION_VERSION_CONFLICT");
            // The same requestId with different cues is also refused, never a second version.
            HttpResponse<String> reuse = correct(base, OWNER, "corr-1", machine.artifactId(), machine.version().value(),
                    cues(0, 2000, "Other", 2000, 4500, "words."));
            assertThat(reuse.statusCode()).as(reuse.body()).isEqualTo(409);

            // A stale expected version is a conflict that names the current version.
            HttpResponse<String> stale = correct(base, OWNER, "corr-3", machine.artifactId(),
                    "sha256:" + "0".repeat(64), cues(0, 2000, "x", 2000, 4500, "y"));
            assertThat(stale.statusCode()).as(stale.body()).isEqualTo(409);
            assertThat(stale.body()).contains("CAPTION_VERSION_CONFLICT").contains(machine.version().value());

            // The chain continues from the corrected version (correction number 2, same machine root).
            MediaArtifact corrected = runtime.artifact(TENANT, OWNER, correctedId).orElseThrow();
            HttpResponse<String> second = correct(base, OWNER, "corr-4", correctedId, corrected.version().value(),
                    cues(0, 2000, "And so, my fellow Americans,", 2000, 4800, "ask not what your country can do for you."));
            assertThat(second.statusCode()).as(second.body()).isEqualTo(201);
            Map<String, Object> secondLineage = object(read(second.body()).get("lineage"));
            assertThat(secondLineage).containsEntry("correctionNumber", 2);
            assertThat(object(secondLineage.get("machineVersion"))).containsEntry("artifactId", machine.artifactId());
            assertThat(object(object(secondLineage.get("edit")))).containsEntry("timingChanged", 1)
                    .containsEntry("textChanged", 0);
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    @Test
    void refusedCorrectionsRegisterNothingAndNameTheTypedReason() throws Exception {
        Path root = Files.createTempDirectory("media-dev-caption-http-refused-");
        MediaRuntime runtime = runtime(root, MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT, MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT_PER_TENANT);
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            MediaArtifact machine = machineCaption(runtime, MACHINE_VTT);
            String v = machine.version().value();

            // Not the owner: refused as if absent; the machine text is not disclosed.
            HttpResponse<String> foreign = correct(base, OTHER, "f-1", machine.artifactId(), v,
                    cues(0, 2000, "x", 2000, 4500, "y"));
            assertThat(foreign.statusCode()).as(foreign.body()).isEqualTo(404);
            assertThat(foreign.body()).doesNotContain("fellow Americans");
            assertThat(send(base, "GET", "/dev/v1/captions/" + machine.artifactId(), null, OTHER, PERMISSIONS)
                    .statusCode()).isEqualTo(404);
            // Missing artifact permissions or the route permission.
            assertThat(send(base, "POST", "/dev/v1/captions/corrections", body("p-1", machine.artifactId(), v,
                    cues(0, 2000, "x", 2000, 4500, "y")), OWNER,
                    Set.of("media:project:dev:write", "media:artifact:read")).statusCode()).isEqualTo(403);
            assertThat(send(base, "POST", "/dev/v1/captions/corrections", body("p-2", machine.artifactId(), v,
                    cues(0, 2000, "x", 2000, 4500, "y")), OWNER, Set.of("media:project:dev:read",
                    "media:artifact:read", "media:artifact:create")).statusCode()).isEqualTo(403);

            // Rights revoked between the machine version and the correction: refused, nothing registered.
            verdict.set(Verdict.REVOKED);
            HttpResponse<String> revoked = correct(base, OWNER, "r-1", machine.artifactId(), v,
                    cues(0, 2000, "x", 2000, 4500, "y"));
            assertThat(revoked.statusCode()).as(revoked.body()).isEqualTo(403);
            assertThat(revoked.body()).contains("RIGHTS_DECISION_REVOKED");
            verdict.set(Verdict.UNAVAILABLE);
            HttpResponse<String> unavailable = correct(base, OWNER, "r-2", machine.artifactId(), v,
                    cues(0, 2000, "x", 2000, 4500, "y"));
            assertThat(unavailable.statusCode()).as(unavailable.body()).isEqualTo(422);
            assertThat(unavailable.body()).contains("RIGHTS_AUTHORITY_UNAVAILABLE");
            verdict.set(Verdict.ADMITTED);

            // Invalid cue sets are typed and never repaired.
            assertCode(correct(base, OWNER, "c-1", machine.artifactId(), v,
                    cues(0, 3000, "a", 2000, 4500, "b")), 422, "CAPTION_TIMING_INVALID");
            assertCode(correct(base, OWNER, "c-2", machine.artifactId(), v,
                    cues(0, 2000, "<b>bold</b>", 2000, 4500, "b")), 422, "CAPTION_MARKUP_NOT_SUPPORTED");
            assertCode(correct(base, OWNER, "c-3", machine.artifactId(), v,
                    cues(0, 2000, "   ", 2000, 4500, "b")), 422, "CAPTION_TEXT_EMPTY");
            assertCode(correct(base, OWNER, "c-4", machine.artifactId(), v,
                    cues(0, 2000, "And so my fellow Americans", 2000, 4500,
                            "ask not what your country can do for you")), 422, "CAPTION_UNCHANGED");
            assertCode(send(base, "POST", "/dev/v1/captions/corrections", body("c-5", machine.artifactId(), v,
                    List.of()), OWNER, PERMISSIONS), 422, "CAPTION_DRAFT_EMPTY");
            // A non-caption artifact is not a correction base.
            MediaArtifact png = upload(runtime, "x.txt", "text/plain", "hello".getBytes(StandardCharsets.UTF_8), Map.of());
            assertCode(correct(base, OWNER, "c-6", png.artifactId(), png.version().value(),
                    cues(0, 2000, "a", 2000, 4500, "b")), 422, "CAPTION_BASE_NOT_SUPPORTED");

            // After all refusals the machine version still has no child: a valid correction now succeeds once.
            assertThat(correct(base, OWNER, "ok-1", machine.artifactId(), v,
                    cues(0, 2000, "And so, my fellow Americans", 2000, 4500,
                            "ask not what your country can do for you")).statusCode()).isEqualTo(201);
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    @Test
    void renderUseGateRefusesCaptionVersionsWithoutAnAssignedReviewerAccept() throws Exception {
        Path root = Files.createTempDirectory("media-dev-caption-gate-");
        MediaRuntime runtime = runtime(root, MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT, MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT_PER_TENANT);
        try {
            MediaArtifact machine = machineCaption(runtime, MACHINE_VTT);
            MediaDevCaptionRuntime captions = MediaDevCaptionRuntime.compose(runtime, resolver, null);
            assertThatThrownBy(() -> captions.captionUseGate().requireReviewed(TENANT, OWNER, machine))
                    .isInstanceOf(MediaDevProjectRenderRuntime.RenderNotSupportedException.class)
                    .hasMessageContaining("review lane is not enabled");
            MediaArtifact plain = upload(runtime, "plain.vtt", "text/vtt",
                    (MACHINE_VTT + "\n").getBytes(StandardCharsets.UTF_8), Map.of());
            assertThatThrownBy(() -> captions.captionUseGate().requireReviewed(TENANT, OWNER, plain))
                    .isInstanceOf(MediaDevProjectRenderRuntime.RenderNotSupportedException.class);
        } finally {
            runtime.close();
        }
    }

    // ---- helpers ----

    private HttpServer server(MediaRuntime runtime) throws Exception {
        MediaDevProjectTimelineRuntime projects = new MediaDevProjectTimelineRuntime(new InMemoryManagedStore());
        HttpServer server = MediaDevProjectRenderHttpTest.server(runtime, projects, null);
        // Replace the default context with one that also serves the caption routes.
        server.removeContext("/");
        MediaHttpHandler handler = new MediaHttpHandler(runtime, null, null, projects)
                .withDevCaptions(MediaDevCaptionRuntime.compose(runtime, resolver, null), false);
        server.createContext("/", new MediaSecurityFilter(handler, "dev", Map.of("MEDIA_DEV_IDENTITY_ENABLED", "true",
                "MEDIA_DEV_JWT_HMAC_SECRET", "test-only-dev-project-secret-at-least-32-bytes"),
                java.time.Clock.fixed(java.time.Instant.parse("2026-11-13T20:00:00Z"), java.time.ZoneOffset.UTC)));
        return server;
    }

    private static MediaArtifact machineCaption(MediaRuntime runtime, String vtt) throws Exception {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("speechSchema", MediaDevSpeechRuntime.SCHEMA);
        metadata.put("scope", "DEV_ONLY");
        metadata.put("kind", MediaDevSpeechRuntime.KIND_CAPTIONS);
        metadata.put("requestId", "stt-fixture");
        metadata.put("language", "en");
        metadata.put("source", Map.of("artifactId", "source-audio-1", "artifactVersionId", "sha256:" + "a".repeat(64),
                "sha256", "a".repeat(64), "contentType", "audio/wav"));
        metadata.put("rightsDecision", "rights-attestation:att-1");
        metadata.put("cueCount", 2);
        return upload(runtime, "captions.vtt", "text/vtt", vtt.getBytes(StandardCharsets.UTF_8), metadata);
    }

    private static MediaArtifact upload(MediaRuntime runtime, String name, String contentType, byte[] bytes,
                                        Map<String, Object> metadata) throws Exception {
        String digest = HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        var session = runtime.beginUpload(new UploadRequest(TENANT, OWNER, name, contentType, bytes.length, digest,
                "INTERNAL", Duration.ofMinutes(30), metadata), "fixture-" + digest);
        runtime.appendChunk(TENANT, OWNER, session.uploadId(), 0, bytes);
        return runtime.completeUpload(TENANT, OWNER, session.uploadId());
    }

    private static byte[] content(MediaRuntime runtime, String artifactId) throws Exception {
        MediaArtifact artifact = runtime.artifact(TENANT, OWNER, artifactId).orElseThrow();
        var out = new java.io.ByteArrayOutputStream();
        runtime.copyArtifactContent(TENANT, OWNER, artifactId, artifact.version(), out, 1 << 20).orElseThrow();
        return out.toByteArray();
    }

    private static List<Map<String, Object>> cues(long s1, long e1, String t1, long s2, long e2, String t2) {
        return List.of(Map.of("startMillis", s1, "endMillis", e1, "text", t1),
                Map.of("startMillis", s2, "endMillis", e2, "text", t2));
    }

    private static String body(String requestId, String artifactId, String version, List<Map<String, Object>> cues)
            throws Exception {
        return JSON.writeValueAsString(Map.of("requestId", requestId, "baseArtifactId", artifactId,
                "expectedVersionId", version, "cues", cues));
    }

    private HttpResponse<String> correct(String base, String principal, String requestId, String artifactId,
                                         String version, List<Map<String, Object>> cues) throws Exception {
        return send(base, "POST", "/dev/v1/captions/corrections", body(requestId, artifactId, version, cues),
                principal, PERMISSIONS);
    }

    private static void assertCode(HttpResponse<String> response, int status, String code) {
        assertThat(response.statusCode()).as(response.body()).isEqualTo(status);
        assertThat(response.body()).contains(code);
    }
}
