package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRightsConsentContracts.Reason;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Verdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.InMemoryManagedStore;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.TENANT;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.base;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.object;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.read;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.send;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * J-10 DEV_ONLY rights-checked reference-conditioned scenes over the real HTTP host, filter and artifact store (no
 * FFmpeg, no model). The durable PostgreSQL/S3 path, restart and the browser are covered by
 * {@code MediaDevReferenceSceneIT} and the Explorer live test.
 */
class MediaDevReferenceSceneHttpTest {
    private static final String OWNER = "test-principal-owner";
    private static final String OTHER = "test-principal-other";
    private static final Set<String> PERMISSIONS = Set.of("media:project:dev:create", "media:project:dev:read",
            "media:project:dev:write", "media:artifact:read", "media:artifact:create");
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final String SETS = "/dev/v1/reference-scenes/reference-sets";
    private static final String RUNS = "/dev/v1/reference-scenes/runs";

    private static Path root;

    private final Set<String> admitted = ConcurrentHashMap.newKeySet();
    private final Set<String> revokedIds = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean unavailable = new AtomicBoolean();
    private final RightsConsentResolver resolver = new RightsConsentResolver() {
        @Override public String resolverId() { return "test-resolver"; }
        @Override public boolean ready() { return true; }
        @Override public Resolution resolve(ResolutionRequest request) {
            if (unavailable.get()) return Resolution.unavailable(resolverId());
            if (revokedIds.contains(request.artifactId())) {
                return new Resolution(Verdict.REVOKED, Set.of(Reason.REVOKED), List.of(), resolverId());
            }
            if (!admitted.contains(request.artifactId())) {
                return new Resolution(Verdict.DENIED, Set.of(Reason.NO_ATTESTATION), List.of(), resolverId());
            }
            return new Resolution(Verdict.ADMITTED, Set.of(), List.of("att-" + request.artifactId()), resolverId());
        }
    };

    @BeforeAll
    static void tools() throws Exception {
        root = Files.createTempDirectory("media-dev-reference-scene-http-");
    }

    @AfterAll
    static void cleanup() {
        if (root != null) deleteTree(root);
    }

    @Test
    void modelModeIsATypedUnavailableWithZeroArtifactsAndNoTemplateFallback() throws Exception {
        MediaRuntime runtime = runtime();
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            HttpResponse<String> status = send(base, "GET", "/dev/v1/reference-scenes/status", null, OWNER, PERMISSIONS);
            assertThat(status.statusCode()).isEqualTo(200);
            Map<String, Object> model = object(read(status.body()).get("model"));
            assertThat(model).containsEntry("available", false).containsEntry("fallback", "NONE");

            MediaArtifact ref = upload(runtime, "ref.png", "image/png", png(48, 64, 0xFFFFD000, 0xFF2060FF));
            admitted.add(ref.artifactId());
            Map<String, Object> set = createSet(base, "set-model", ref, "hero");
            int before = artifactCount(runtime);
            for (Map<String, Object> body : List.of(
                    Map.<String, Object>of("requestId", "model-1", "mode", "MODEL", "referenceSetId", set.get("referenceSetId"),
                            "seed", 7, "sceneCount", 2, "prompt", "a hero walking"),
                    Map.<String, Object>of("requestId", "model-2", "mode", "MODEL"))) {
                HttpResponse<String> response = send(base, "POST", RUNS, JSON.writeValueAsString(body), OWNER, PERMISSIONS);
                assertThat(response.statusCode()).as(response.body()).isEqualTo(503);
                Map<String, Object> error = object(read(response.body()).get("error"));
                assertThat(error).containsEntry("code", "MODEL_UNAVAILABLE");
                assertThat(object(error.get("details"))).containsEntry("fallback", "NONE").containsEntry("artifactsCreated", 0);
            }
            assertThat(artifactCount(runtime)).as("MODEL mode created nothing").isEqualTo(before);
            // An unknown field in MODEL mode is still a typed 422, not a model call.
            HttpResponse<String> bad = send(base, "POST", RUNS, "{\"requestId\":\"m3\",\"mode\":\"MODEL\",\"template\":{}}",
                    OWNER, PERMISSIONS);
            assertThat(bad.statusCode()).isEqualTo(422);
            HttpResponse<String> noMode = send(base, "POST", RUNS, "{\"requestId\":\"m4\"}", OWNER, PERMISSIONS);
            assertThat(noMode.statusCode()).isEqualTo(422);
            assertThat(object(object(read(noMode.body()).get("error")).get("details"))).containsEntry("path", "$.mode");
        } finally {
            server.stop(0);
        }
    }

    @Test
    void referenceSetsNeedProcessingRightsAreOwnerScopedAndIdempotent() throws Exception {
        MediaRuntime runtime = runtime();
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            MediaArtifact ref = upload(runtime, "ref.png", "image/png", png(48, 64, 0xFFFFD000, 0xFF2060FF));
            MediaArtifact text = upload(runtime, "note.txt", "text/plain", "hello".getBytes());
            int before = artifactCount(runtime);
            String body = setBody("set-1", ref, "hero");

            HttpResponse<String> denied = send(base, "POST", SETS, body, OWNER, PERMISSIONS);
            assertThat(denied.statusCode()).as(denied.body()).isEqualTo(403);
            Map<String, Object> error = object(read(denied.body()).get("error"));
            assertThat(error).containsEntry("code", "RIGHTS_NOT_ADMITTED");
            assertThat(object(error.get("details"))).containsEntry("verdict", "DENIED").containsEntry("path", "$.references[0]");
            assertThat(artifactCount(runtime)).isEqualTo(before);

            admitted.add(ref.artifactId());
            HttpResponse<String> created = send(base, "POST", SETS, body, OWNER, PERMISSIONS);
            assertThat(created.statusCode()).as(created.body()).isEqualTo(201);
            Map<String, Object> view = read(created.body());
            String setId = (String) view.get("referenceSetId");
            Map<String, Object> entry = object(((List<?>) object(view.get("document")).get("references")).getFirst());
            assertThat(entry).containsEntry("width", 48).containsEntry("height", 64);
            assertThat(object(entry.get("rights"))).containsEntry("verdict", "ADMITTED").containsEntry("scope", "PROCESSING");
            assertThat(object(view.get("lineage")).get("parent")).isNotNull();

            HttpResponse<String> replay = send(base, "POST", SETS, body, OWNER, PERMISSIONS);
            assertThat(replay.statusCode()).isEqualTo(200);
            assertThat(read(replay.body())).containsEntry("referenceSetId", setId).containsEntry("replayed", true);
            HttpResponse<String> reused = send(base, "POST", SETS, setBody("set-1", ref, "other-name"), OWNER, PERMISSIONS);
            assertThat(reused.statusCode()).isEqualTo(409);

            assertThat(send(base, "GET", SETS + "/" + setId, null, OWNER, PERMISSIONS).statusCode()).isEqualTo(200);
            assertThat(send(base, "GET", SETS + "/" + setId, null, OTHER, PERMISSIONS).statusCode()).isEqualTo(404);
            assertThat(send(base, "POST", SETS, setBody("set-other", ref, "x"), OTHER, PERMISSIONS).statusCode())
                    .as("another owner cannot reference this artifact").isEqualTo(404);

            admitted.add(text.artifactId());
            HttpResponse<String> notImage = send(base, "POST", SETS, setBody("set-text", text, "t"), OWNER, PERMISSIONS);
            assertThat(notImage.statusCode()).isEqualTo(422);
            assertThat(object(read(notImage.body()).get("error"))).containsEntry("code", "REFERENCE_NOT_SUPPORTED");

            unavailable.set(true);
            HttpResponse<String> down = send(base, "POST", SETS, setBody("set-down", ref, "d"), OWNER, PERMISSIONS);
            assertThat(down.statusCode()).isEqualTo(503);
            assertThat(object(read(down.body()).get("error"))).containsEntry("code", "RIGHTS_AUTHORITY_UNAVAILABLE");
            unavailable.set(false);

            HttpResponse<String> noPermission = send(base, "POST", SETS, setBody("set-np", ref, "n"), OWNER,
                    Set.of("media:project:dev:write", "media:artifact:read"));
            assertThat(noPermission.statusCode()).isEqualTo(403);
        } finally {
            server.stop(0);
        }
    }

    @Test
    void scenesUseTheReferencesReproduceFromTheSeedAndTheFullFaultSuiteIsTyped() throws Exception {
        MediaRuntime runtime = runtime();
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            MediaArtifact hero = upload(runtime, "hero.png", "image/png", png(48, 64, 0xFFFFD000, 0xFF2060FF));
            MediaArtifact logo = upload(runtime, "logo.png", "image/png", gradientPng(64, 64));
            MediaArtifact unlisted = upload(runtime, "unlisted.png", "image/png", png(40, 40, 0xFF00FF00, 0xFF000000));
            admitted.add(hero.artifactId());
            admitted.add(logo.artifactId());
            Map<String, Object> set = createSet(base, "set-main", List.of(hero, logo), List.of("hero", "logo"));
            String setId = (String) set.get("referenceSetId");

            // ---- invalid parameters: typed 422 with the JSON path; nothing registered ----
            int before = artifactCount(runtime);
            Map<String, String> invalid = new LinkedHashMap<>();
            invalid.put("$.template.id", run("bad-1", setId, p -> { }, r -> ((Map<String, Object>) r.get("template")).put("id", "movie-maker")));
            invalid.put("$.sceneCount", run("bad-2", setId, p -> { }, r -> r.put("sceneCount", 99)));
            invalid.put("$.seed", run("bad-3", setId, p -> { }, r -> r.put("seed", "seven")));
            invalid.put("$.parameters.palette[1]", run("bad-4", setId, p -> ((List<Object>) p.get("palette")).set(1, "blue"), r -> { }));
            invalid.put("$.parameters.slots[0].height", run("bad-5", setId, p -> slot(p, 0).put("height", 3.0), r -> { }));
            invalid.put("$.parameters.slots[0].tint.strength", run("bad-6", setId,
                    p -> slot(p, 0).put("tint", Map.of("color", "#FF0000", "strength", 2)), r -> { }));
            invalid.put("$.parameters.canvas.width", run("bad-7", setId, p -> p.put("canvas", Map.of("width", 10, "height", 180)), r -> { }));
            invalid.put("$.parameters.slots[1].x", run("bad-8", setId, p -> slot(p, 1).put("x", 0.3), r -> { }));
            invalid.put("$.parameters.extra", run("bad-9", setId, p -> p.put("extra", 1), r -> { }));
            invalid.put("$.continuity.minSsim", run("bad-10", setId, p -> { }, r -> r.put("continuity", Map.of("minSsim", 7))));
            for (Map.Entry<String, String> entry : invalid.entrySet()) {
                HttpResponse<String> response = send(base, "POST", RUNS, entry.getValue(), OWNER, PERMISSIONS);
                assertThat(response.statusCode()).as(entry.getKey() + " " + response.body()).isEqualTo(422);
                Map<String, Object> error = object(read(response.body()).get("error"));
                assertThat(error).containsEntry("code", "REFERENCE_SCENE_SPEC_INVALID");
                assertThat(object(error.get("details"))).containsEntry("path", entry.getKey());
            }
            // A placed reference that does not fit the canvas is the height path.
            HttpResponse<String> tooBig = send(base, "POST", RUNS, run("bad-fit", setId,
                    p -> slot(p, 0).put("height", 0.8), r -> r.put("sceneCount", 2)), OWNER, PERMISSIONS);
            assertThat(tooBig.statusCode()).as(tooBig.body()).isEqualTo(422);
            assertThat(object(object(read(tooBig.body()).get("error")).get("details"))).containsEntry("path", "$.parameters.slots[0].height");
            assertThat(artifactCount(runtime)).as("no refusal registered anything").isEqualTo(before);

            // ---- a reference that is not in the set is a typed 422 and nothing is read ----
            admitted.add(unlisted.artifactId());
            HttpResponse<String> outsider = send(base, "POST", RUNS, run("out-1", setId,
                    p -> slot(p, 1).put("referenceId", "stranger"), r -> { }), OWNER, PERMISSIONS);
            assertThat(outsider.statusCode()).isEqualTo(422);
            Map<String, Object> outsiderError = object(read(outsider.body()).get("error"));
            assertThat(outsiderError).containsEntry("code", "REFERENCE_NOT_IN_SET");
            assertThat(object(outsiderError.get("details"))).containsEntry("path", "$.parameters.slots[1].referenceId");
            assertThat(send(base, "POST", RUNS, run("wrong-set", "no-such-set", p -> { }, r -> { }), OWNER, PERMISSIONS)
                    .statusCode()).isEqualTo(404);
            assertThat(send(base, "POST", RUNS, run("foreign-set", setId, p -> { }, r -> { }), OTHER, PERMISSIONS)
                    .statusCode()).as("another owner cannot use this set").isEqualTo(404);

            // ---- the happy path: three scenes, tinted logo ----
            HttpResponse<String> created = send(base, "POST", RUNS, run("run-1", setId, p -> { }, r -> { }), OWNER, PERMISSIONS);
            assertThat(created.statusCode()).as(created.body()).isEqualTo(201);
            Map<String, Object> view = read(created.body());
            assertThat(view).containsEntry("outcome", "CONTINUITY_PASSED").containsEntry("mode", "TEMPLATE");
            List<?> sceneArtifacts = (List<?>) view.get("scenes");
            assertThat(sceneArtifacts).hasSize(3);
            Map<String, Object> manifest = object(view.get("manifest"));
            assertThat(object(manifest.get("generator"))).containsEntry("kind", "AUTHORED_TEMPLATE")
                    .containsEntry("generativeModelUsed", false).containsEntry("seed", 20260101);
            assertThat(((List<?>) manifest.get("references"))).hasSize(2);
            List<?> scenesDoc = (List<?>) manifest.get("scenes");
            for (int i = 0; i < 3; i++) {
                Map<String, Object> scene = object(scenesDoc.get(i));
                String artifactId = (String) object(object(sceneArtifacts.get(i))).get("artifactId");
                byte[] stored = content(runtime, artifactId);
                // The stored PNG decodes, carries its request tag, and minus the tag IS the canonical renderer PNG.
                BufferedImage image = ImageIO.read(new ByteArrayInputStream(stored));
                assertThat(image.getWidth()).isEqualTo(320);
                assertThat(image.getHeight()).isEqualTo(180);
                assertThat(new String(stored, java.nio.charset.StandardCharsets.ISO_8859_1)).contains("media.reference-scene");
                assertThat(MediaDevReferenceSceneImaging.sha256(MediaDevReferenceSceneImaging.untag(stored)))
                        .isEqualTo(scene.get("canonicalPngSha256"));
                // Independent check of the genuine use of the references: the decoded pixels at the placed rectangle.
                List<?> slotMetrics = (List<?>) object(scene.get("metrics")).get("slots");
                Map<String, Object> hero0 = object(slotMetrics.get(0));
                Map<String, Object> rect = object(hero0.get("rect"));
                int x = (int) rect.get("x");
                int y = (int) rect.get("y");
                int w = (int) rect.get("width");
                int h = (int) rect.get("height");
                assertThat(h).isEqualTo(Math.round(180 * 0.55 * (0.9 + 0.3 * (i / 2.0))));
                assertThat(((Number) hero0.get("histogramDistance")).doubleValue()).isZero();
                assertThat((int) hero0.get("renderMaxAbsDiff")).isZero();
                assertThat(image.getRGB(x + 1, y + 1) & 0xFFFFFF).as("hero top-left cell is the yellow of the reference")
                        .isEqualTo(0xFFD000);
                assertThat(image.getRGB(x + w - 2, y + 1) & 0xFFFFFF).as("next cell is the blue of the reference")
                        .isEqualTo(0x2060FF);
                Map<String, Object> logo1 = object(slotMetrics.get(1));
                assertThat(((Number) logo1.get("histogramDistance")).doubleValue())
                        .as("the recoloured logo departs from the reference but within the threshold").isGreaterThan(0.0)
                        .isLessThanOrEqualTo(0.35);
                assertThat(((Number) object(scene.get("metrics")).get("paletteAdherence")).doubleValue()).isEqualTo(1.0);
                if (i > 0) assertThat(hero0.get("crossScene")).isNotNull();
            }

            // ---- reproducibility: regeneration re-renders from the manifest and matches byte for byte ----
            String runId = (String) view.get("runId");
            HttpResponse<String> regenerated = send(base, "POST", RUNS + "/" + runId + "/regenerations", "{}", OWNER, PERMISSIONS);
            assertThat(regenerated.statusCode()).as(regenerated.body()).isEqualTo(200);
            Map<String, Object> proof = read(regenerated.body());
            assertThat(proof).containsEntry("byteIdentical", true).containsEntry("artifactsCreated", 0)
                    .containsEntry("rightsRechecked", true);

            // The same request under another id has the same canonical bytes (the registered bytes differ by the tag only).
            HttpResponse<String> twin = send(base, "POST", RUNS, run("run-2", setId, p -> { }, r -> { }), OWNER, PERMISSIONS);
            assertThat(twin.statusCode()).as(twin.body()).isEqualTo(201);
            List<?> twinScenes = (List<?>) object(read(twin.body()).get("manifest")).get("scenes");
            for (int i = 0; i < 3; i++) {
                assertThat(object(twinScenes.get(i)).get("canonicalPngSha256")).isEqualTo(object(scenesDoc.get(i)).get("canonicalPngSha256"));
                assertThat(object(twinScenes.get(i)).get("pixelSha256")).isEqualTo(object(scenesDoc.get(i)).get("pixelSha256"));
            }
            // A different seed gives different scenes.
            HttpResponse<String> reseeded = send(base, "POST", RUNS, run("run-3", setId, p -> { }, r -> r.put("seed", 99)), OWNER, PERMISSIONS);
            assertThat(reseeded.statusCode()).as(reseeded.body()).isEqualTo(201);
            List<?> reseededScenes = (List<?>) object(read(reseeded.body()).get("manifest")).get("scenes");
            assertThat(object(reseededScenes.get(1)).get("canonicalPngSha256")).isNotEqualTo(object(scenesDoc.get(1)).get("canonicalPngSha256"));

            // ---- idempotency ----
            HttpResponse<String> replay = send(base, "POST", RUNS, run("run-1", setId, p -> { }, r -> { }), OWNER, PERMISSIONS);
            assertThat(replay.statusCode()).isEqualTo(200);
            assertThat(read(replay.body())).containsEntry("runId", runId).containsEntry("replayed", true);
            HttpResponse<String> changed = send(base, "POST", RUNS, run("run-1", setId, p -> { }, r -> r.put("seed", 5)), OWNER, PERMISSIONS);
            assertThat(changed.statusCode()).isEqualTo(409);
            assertThat(object(read(changed.body()).get("error"))).containsEntry("code", "REFERENCE_SCENE_REQUEST_ID_REUSED");
            assertThat(send(base, "GET", RUNS + "/" + runId, null, OWNER, PERMISSIONS).statusCode()).isEqualTo(200);
            assertThat(send(base, "GET", RUNS + "/" + runId, null, OTHER, PERMISSIONS).statusCode()).isEqualTo(404);
            assertThat(send(base, "POST", RUNS + "/" + runId + "/regenerations", "{}", OTHER, PERMISSIONS).statusCode()).isEqualTo(404);

            // ---- continuity threshold failure is a typed outcome with nothing registered ----
            int beforeStrict = artifactCount(runtime);
            HttpResponse<String> strict = send(base, "POST", RUNS, run("run-strict", setId, p -> { },
                    r -> r.put("continuity", Map.of("maxHistogramDistance", 0.01))), OWNER, PERMISSIONS);
            assertThat(strict.statusCode()).as(strict.body()).isEqualTo(422);
            Map<String, Object> strictError = object(read(strict.body()).get("error"));
            assertThat(strictError).containsEntry("code", "CONTINUITY_THRESHOLD_FAILED");
            Map<String, Object> strictDetails = object(strictError.get("details"));
            assertThat(strictDetails).containsEntry("artifactsCreated", 0);
            Map<String, Object> first = object(((List<?>) strictDetails.get("violations")).getFirst());
            assertThat(first).containsEntry("metric", "histogramDistance").containsEntry("limit", "MAX");
            assertThat(artifactCount(runtime)).as("a continuity failure registers nothing").isEqualTo(beforeStrict);
            // A fully recoloured subject fails the default thresholds.
            HttpResponse<String> recoloured = send(base, "POST", RUNS, run("run-recolour", setId,
                    p -> slot(p, 1).put("tint", Map.of("color", "#00FF00", "strength", 1.0)), r -> { }), OWNER, PERMISSIONS);
            assertThat(recoloured.statusCode()).isEqualTo(422);
            assertThat(object(read(recoloured.body()).get("error"))).containsEntry("code", "CONTINUITY_THRESHOLD_FAILED");

            // ---- spotlight template ----
            HttpResponse<String> spotlight = send(base, "POST", RUNS, JSON.writeValueAsString(spotlightRequest("run-spot", setId)),
                    OWNER, PERMISSIONS);
            assertThat(spotlight.statusCode()).as(spotlight.body()).isEqualTo(201);
            assertThat(((List<?>) read(spotlight.body()).get("scenes"))).hasSize(2);

            // ---- revoked rights: a NEW run, a REPLAY and a regeneration are all refused; reads of the registry still work ----
            int beforeRevoke = artifactCount(runtime);
            revokedIds.add(logo.artifactId());
            HttpResponse<String> revokedNew = send(base, "POST", RUNS, run("run-after", setId, p -> { }, r -> { }), OWNER, PERMISSIONS);
            assertThat(revokedNew.statusCode()).as(revokedNew.body()).isEqualTo(403);
            Map<String, Object> revokedError = object(read(revokedNew.body()).get("error"));
            assertThat(revokedError).containsEntry("code", "RIGHTS_NOT_ADMITTED");
            assertThat(object(revokedError.get("details"))).containsEntry("verdict", "REVOKED")
                    .containsEntry("artifactId", logo.artifactId()).containsEntry("path", "$.parameters.slots[1].referenceId");
            assertThat(send(base, "POST", RUNS, run("run-1", setId, p -> { }, r -> { }), OWNER, PERMISSIONS).statusCode())
                    .as("replay re-checks rights").isEqualTo(403);
            assertThat(send(base, "POST", RUNS + "/" + runId + "/regenerations", "{}", OWNER, PERMISSIONS).statusCode())
                    .isEqualTo(403);
            assertThat(artifactCount(runtime)).isEqualTo(beforeRevoke);
            // A run that does not use the revoked reference still works.
            HttpResponse<String> unaffected = send(base, "POST", RUNS, JSON.writeValueAsString(spotlightRequest("run-spot-2", setId)),
                    OWNER, PERMISSIONS);
            assertThat(unaffected.statusCode()).as(unaffected.body()).isEqualTo(201);
        } finally {
            server.stop(0);
        }
    }

    // ---- request builders ----

    private static Map<String, Object> slot(Map<String, Object> parameters, int index) {
        return (Map<String, Object>) ((List<Object>) parameters.get("slots")).get(index);
    }

    private static Map<String, Object> spotlightRequest(String requestId, String setId) {
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("requestId", requestId);
        request.put("mode", "TEMPLATE");
        request.put("referenceSetId", setId);
        request.put("template", new LinkedHashMap<>(Map.of("id", "product-spotlight", "version", 1)));
        request.put("seed", 11);
        request.put("sceneCount", 2);
        Map<String, Object> parameters = new LinkedHashMap<>();
        parameters.put("palette", List.of("#101828", "#334155", "#FACC15"));
        parameters.put("subject", new LinkedHashMap<>(Map.of("referenceId", "hero", "height", 0.5)));
        parameters.put("sparkles", 12);
        request.put("parameters", parameters);
        return request;
    }

    private static String run(String requestId, String setId, java.util.function.Consumer<Map<String, Object>> parameterChange,
                              java.util.function.Consumer<Map<String, Object>> requestChange) throws Exception {
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("requestId", requestId);
        request.put("mode", "TEMPLATE");
        request.put("referenceSetId", setId);
        request.put("template", new LinkedHashMap<>(Map.of("id", "reference-stage", "version", 1)));
        request.put("seed", 20260101);
        request.put("sceneCount", 3);
        Map<String, Object> parameters = new LinkedHashMap<>();
        parameters.put("palette", new ArrayList<>(List.of("#101828", "#1E293B", "#38BDF8")));
        parameters.put("slots", new ArrayList<>(List.of(
                new LinkedHashMap<>(Map.of("referenceId", "hero", "x", 0.3, "height", 0.55)),
                new LinkedHashMap<>(Map.of("referenceId", "logo", "x", 0.75, "height", 0.3,
                        "tint", Map.of("color", "#38BDF8", "strength", 0.1))))));
        parameters.put("drift", 4);
        parameters.put("push", Map.of("start", 0.9, "end", 1.2));
        parameters.put("sparkles", 20);
        request.put("parameters", parameters);
        parameterChange.accept(parameters);
        requestChange.accept(request);
        return JSON.writeValueAsString(request);
    }

    private static String setBody(String requestId, MediaArtifact artifact, String referenceId) throws Exception {
        return JSON.writeValueAsString(Map.of("requestId", requestId, "name", "set " + referenceId, "references", List.of(
                Map.of("referenceId", referenceId, "artifactId", artifact.artifactId(),
                        "artifactVersionId", artifact.version().value()))));
    }

    private Map<String, Object> createSet(String base, String requestId, MediaArtifact artifact, String referenceId) throws Exception {
        return createSet(base, requestId, List.of(artifact), List.of(referenceId));
    }

    private Map<String, Object> createSet(String base, String requestId, List<MediaArtifact> artifacts, List<String> ids)
            throws Exception {
        List<Map<String, Object>> references = new ArrayList<>();
        for (int i = 0; i < artifacts.size(); i++) {
            references.add(Map.of("referenceId", ids.get(i), "artifactId", artifacts.get(i).artifactId(),
                    "artifactVersionId", artifacts.get(i).version().value()));
        }
        HttpResponse<String> response = send(base, "POST", SETS, JSON.writeValueAsString(Map.of("requestId", requestId,
                "references", references)), OWNER, PERMISSIONS);
        assertThat(response.statusCode()).as(response.body()).isEqualTo(201);
        return read(response.body());
    }

    private static byte[] gradientPng(int width, int height) throws Exception {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                image.setRGB(x, y, 0xFF000000 | ((x * 255 / (width - 1)) << 16) | ((y * 255 / (height - 1)) << 8) | 0x80);
            }
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(image, "png", out);
        return out.toByteArray();
    }

    private static byte[] png(int width, int height, int colourA, int colourB) throws Exception {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) image.setRGB(x, y, x < width / 2 ? colourA : colourB);
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(image, "png", out);
        return out.toByteArray();
    }

    // ---- host builders ----

    private HttpServer server(MediaRuntime runtime) throws Exception {
        MediaDevProjectTimelineRuntime projects = new MediaDevProjectTimelineRuntime(new InMemoryManagedStore());
        HttpServer server = MediaDevProjectRenderHttpTest.server(runtime, projects, null);
        server.removeContext("/");
        MediaDevReferenceSceneRuntime scenes = new MediaDevReferenceSceneRuntime(runtime, resolver,
                MediaDevProjectRenderRuntime.canonicalRegistrar(runtime), MediaDevRequestLedger.inMemory());
        MediaHttpHandler handler = new MediaHttpHandler(runtime, null, null, projects).withDevReferenceScenes(scenes);
        server.createContext("/", new MediaSecurityFilter(handler, "dev", Map.of("MEDIA_DEV_IDENTITY_ENABLED", "true",
                "MEDIA_DEV_JWT_HMAC_SECRET", "test-only-dev-project-secret-at-least-32-bytes"),
                java.time.Clock.fixed(java.time.Instant.parse("2026-11-13T20:00:00Z"), java.time.ZoneOffset.UTC)));
        return server;
    }

    private static MediaRuntime runtime() throws Exception {
        Path store = Files.createTempDirectory(root, "store-");
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "dev", 8093, 1_048_576, 131_072, 64L * 1024 * 1024, Duration.ofSeconds(2),
                        2, "", "", true, false, store, 0, MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT,
                        MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT_PER_TENANT),
                new LocalMediaRuntimeSupport.FileArtifactStore(store), new LocalMediaRuntimeSupport.JobStore(false),
                new LocalMediaRuntimeSupport.StreamStore(), null,
                List.of(new MediaDevProjectRenderHttpTest.NoEffectProvider()),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
    }

    private static int artifactCount(MediaRuntime runtime) throws Exception {
        try (var files = Files.walk(Path.of(runtime.config().localStorageRoot().toString()))) {
            return (int) files.filter(Files::isRegularFile).count();
        }
    }

    private static MediaArtifact upload(MediaRuntime runtime, String name, String contentType, byte[] bytes) throws Exception {
        String digest = HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        var session = runtime.beginUpload(new UploadRequest(TENANT, OWNER, name, contentType, bytes.length, digest,
                "INTERNAL", Duration.ofMinutes(30), Map.of()), "fixture-" + digest);
        int chunk = runtime.config().maximumChunkBytes();
        int index = 0;
        for (int offset = 0; offset < bytes.length; offset += chunk, index++) {
            runtime.appendChunk(TENANT, OWNER, session.uploadId(), index,
                    java.util.Arrays.copyOfRange(bytes, offset, Math.min(bytes.length, offset + chunk)));
        }
        return runtime.completeUpload(TENANT, OWNER, session.uploadId());
    }

    private static byte[] content(MediaRuntime runtime, String artifactId) throws Exception {
        MediaArtifact artifact = runtime.artifact(TENANT, OWNER, artifactId).orElseThrow();
        var out = new ByteArrayOutputStream();
        runtime.copyArtifactContent(TENANT, OWNER, artifactId, artifact.version(), out, 64L << 20).orElseThrow();
        return out.toByteArray();
    }

    private static void deleteTree(Path path) {
        try (var walk = Files.walk(path)) {
            walk.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
        } catch (java.io.IOException ignored) { }
    }
}
