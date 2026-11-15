package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectAccessDeniedException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectNotFoundException;
import com.sun.net.httpserver.HttpExchange;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DEV_ONLY storyboard routes (outside the canonical manifest/OpenAPI), all labelled DEV_ONLY:
 * {@code GET /dev/v1/storyboards/capabilities}, {@code POST /dev/v1/storyboards} (brief to version 1),
 * {@code GET /dev/v1/storyboards/{id}} (head), {@code GET /dev/v1/storyboards/{id}/versions},
 * {@code POST /dev/v1/storyboards/{id}/versions} (edit against {@code expectedVersion}),
 * {@code GET /dev/v1/storyboards/{id}/versions/{n}}, {@code GET /dev/v1/storyboards/{id}/readiness},
 * {@code POST /dev/v1/storyboards/{id}/renders}, {@code GET /dev/v1/storyboards/{id}/versions/{n}/render} and
 * {@code POST|GET /dev/v1/storyboards/{id}/versions/{n}/review}. A storyboard is visible only to its owner; anyone else,
 * including another tenant, gets 404.
 */
final class MediaDevStoryboardRoutes {
    static final String BASE = "/dev/v1/storyboards";
    private static final Pattern ONE = Pattern.compile("^/dev/v1/storyboards/([^/]+)$");
    private static final Pattern VERSIONS = Pattern.compile("^/dev/v1/storyboards/([^/]+)/versions$");
    private static final Pattern VERSION = Pattern.compile("^/dev/v1/storyboards/([^/]+)/versions/(\\d{1,6})$");
    private static final Pattern RENDER = Pattern.compile("^/dev/v1/storyboards/([^/]+)/versions/(\\d{1,6})/render$");
    private static final Pattern REVIEW = Pattern.compile("^/dev/v1/storyboards/([^/]+)/versions/(\\d{1,6})/review$");
    private static final Pattern READINESS = Pattern.compile("^/dev/v1/storyboards/([^/]+)/readiness$");
    private static final Pattern RENDERS = Pattern.compile("^/dev/v1/storyboards/([^/]+)/renders$");
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();

    private final MediaDevStoryboardRuntime storyboards;
    private final MediaRuntime runtime;

    MediaDevStoryboardRoutes(MediaDevStoryboardRuntime storyboards, MediaRuntime runtime) {
        this.storyboards = storyboards;
        this.runtime = runtime;
    }

    static boolean handles(String path) {
        return path.equals(BASE) || path.startsWith(BASE + "/");
    }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId, int maxBody,
                MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        try {
            dispatch(exchange, path, method, tenantId, principalId, maxBody, out);
        } catch (MediaDevSpeechRuntime.SpeechRefusedException failure) {
            if (failure.status() == 403) runtime.recordDeniedRequest();
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (ProjectNotFoundException failure) {
            out.error(exchange, 404, "PROJECT_NOT_FOUND", "Project is not available in this tenant and owner scope", Map.of());
        } catch (ProjectAccessDeniedException failure) {
            runtime.recordDeniedRequest();
            out.error(exchange, 403, "PROJECT_ACCESS_DENIED", "Principal is not authorized to access this project", Map.of());
        } catch (MediaDevRenderAdmission.CapacityExhaustedException failure) {
            out.error(exchange, 429, MediaDevRenderAdmission.CAPACITY_CODE,
                    "DEV_ONLY render capacity is exhausted; retry the same requestId after the Retry-After delay",
                    Map.of("scope", failure.scope()));
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException failure) {
            runtime.recordDeniedRequest();
            out.error(exchange, 404, "SOURCE_VERSION_NOT_FOUND",
                    "The exact source artifact version is not available to this DEV_ONLY principal", Map.of());
        } catch (MediaDevAnimationRuntime.AnimationRefusedException failure) {
            if (failure.status() == 403) runtime.recordDeniedRequest();
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevAnimationRuntime.AnimationOutcomeUnknownException failure) {
            out.error(exchange, 503, "ANIMATION_OUTCOME_UNKNOWN",
                    "An animation process did not finish; its outcome is UNKNOWN and nothing was registered. "
                            + "Retry the same requestId", Map.of("outcome", "UNKNOWN"));
        } catch (MediaDevRequestLedger.LedgerRefusedException failure) {
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevSpeechRuntime.SpeechRequestReusedException | MediaDevAnimationRuntime.AnimationRequestReusedException failure) {
            out.error(exchange, 409, "REQUEST_ID_REUSED", "requestId was already used with a different request", Map.of());
        } catch (MediaDevSpeechRuntime.SpeechRegistrationFailedException
                 | MediaDevAnimationRuntime.AnimationRegistrationFailedException failure) {
            out.error(exchange, 502, "OUTPUT_REGISTRATION_FAILED",
                    "Output was not registered; retry with the same requestId to resume", Map.of());
        } catch (MediaDevProjectRenderRuntime.RenderNotSupportedException failure) {
            out.error(exchange, 422, failure.code(), failure.getMessage(), Map.of());
        } catch (MediaDevProjectRenderRuntime.RenderTimeoutException failure) {
            out.error(exchange, 504, "RENDER_TIMEOUT", "The DEV_ONLY render exceeded its time budget and was cancelled; "
                    + "nothing was registered. Retry the same requestId", Map.of());
        } catch (MediaDevProjectRenderRuntime.RenderOutcomeUnknownException failure) {
            out.error(exchange, 503, "RENDER_OUTCOME_UNKNOWN", "The DEV_ONLY render process ended abnormally; its outcome "
                    + "is unknown and nothing was registered. Retry the same requestId", Map.of());
        } catch (MediaDevProjectRenderRuntime.RenderExecutionFailedException failure) {
            out.error(exchange, 502, "RENDER_EXECUTION_FAILED", "Render did not produce a verified output",
                    Map.of("reason", failure.reason()));
        }
    }

    private boolean permitted(HttpExchange exchange, boolean write, MediaDevCreativeOutputRoutes.Responder out)
            throws IOException {
        if (MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")
                && (!write || MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:create"))) return true;
        runtime.recordDeniedRequest();
        out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                "DEV_ONLY artifact read" + (write ? " and create" : "") + " permissions are required", Map.of());
        return false;
    }

    private void dispatch(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                          int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        if ((BASE + "/capabilities").equals(path)) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            out.json(exchange, 200, storyboards.capabilities());
            return;
        }
        if (BASE.equals(path)) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!permitted(exchange, true, out)) return;
            Map<String, Object> body = body(exchange, maxBody);
            Object requestId = body.remove("requestId");
            Object storyboardId = body.remove("storyboardId");
            if (storyboardId != null && !(storyboardId instanceof String)) {
                throw MediaDevStoryboardSpec.invalid("$.storyboardId", "storyboardId must be a string");
            }
            var written = storyboards.create(tenantId, principalId, requestId(requestId), (String) storyboardId, body);
            out.json(exchange, written.replayed() ? 200 : 201, storyboards.view(written.version(), written.replayed()));
            return;
        }
        Matcher one = ONE.matcher(path);
        if (one.matches()) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            if (!permitted(exchange, false, out)) return;
            var head = storyboards.head(tenantId, principalId, segment(one.group(1)))
                    .orElseThrow(MediaDevStoryboardRuntime::notFound);
            out.json(exchange, 200, withRender(tenantId, principalId, head));
            return;
        }
        Matcher versions = VERSIONS.matcher(path);
        if (versions.matches()) {
            String id = segment(versions.group(1));
            if ("GET".equals(method)) {
                if (!permitted(exchange, false, out)) return;
                var history = storyboards.history(tenantId, principalId, id);
                if (history.isEmpty()) throw MediaDevStoryboardRuntime.notFound();
                List<Object> items = new ArrayList<>();
                for (var version : history) {
                    Map<String, Object> item = new LinkedHashMap<>();
                    item.put("versionNumber", version.versionNumber());
                    item.put("artifactId", version.artifactId());
                    item.put("artifactVersionId", version.artifactVersionId());
                    item.put("head", version.versionNumber() == history.getLast().versionNumber());
                    item.put("render", storyboards.renderOf(tenantId, principalId, id, version.versionNumber())
                            .map(found -> found.artifact().artifactId()).orElse(null));
                    items.add(item);
                }
                Map<String, Object> view = new LinkedHashMap<>();
                view.put("scope", "DEV_ONLY");
                view.put("storyboardId", id);
                view.put("headVersion", history.getLast().versionNumber());
                view.put("versions", items);
                out.json(exchange, 200, view);
                return;
            }
            if (!"POST".equals(method)) { notAllowed(exchange, "GET, POST", out); return; }
            if (!permitted(exchange, true, out)) return;
            Map<String, Object> body = body(exchange, maxBody);
            Object requestId = body.remove("requestId");
            Object expected = body.remove("expectedVersion");
            if (!(expected instanceof Integer || expected instanceof Long) || ((Number) expected).longValue() < 1
                    || ((Number) expected).longValue() > 1_000_000) {
                throw MediaDevStoryboardSpec.invalid("$.expectedVersion", "expectedVersion must be a positive integer");
            }
            var written = storyboards.edit(tenantId, principalId, requestId(requestId), id, ((Number) expected).intValue(), body);
            out.json(exchange, written.replayed() ? 200 : 201, storyboards.view(written.version(), written.replayed()));
            return;
        }
        Matcher version = VERSION.matcher(path);
        if (version.matches()) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            if (!permitted(exchange, false, out)) return;
            var found = storyboards.version(tenantId, principalId, segment(version.group(1)), Integer.parseInt(version.group(2)))
                    .orElseThrow(MediaDevStoryboardRuntime::notFound);
            out.json(exchange, 200, withRender(tenantId, principalId, found));
            return;
        }
        Matcher readiness = READINESS.matcher(path);
        if (readiness.matches()) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            if (!permitted(exchange, false, out)) return;
            var head = storyboards.head(tenantId, principalId, segment(readiness.group(1)))
                    .orElseThrow(MediaDevStoryboardRuntime::notFound);
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("scope", "DEV_ONLY");
            view.put("storyboardId", head.storyboardId());
            view.put("versionNumber", head.versionNumber());
            view.putAll(storyboards.readiness(tenantId, principalId, head).view());
            view.put("note", "Derived from live state on every call; a shot is RENDERABLE only when its source, rights and "
                    + "the renderer are all present now.");
            out.json(exchange, 200, view);
            return;
        }
        Matcher renders = RENDERS.matcher(path);
        if (renders.matches()) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!permitted(exchange, true, out)) return;
            Map<String, Object> body = body(exchange, maxBody);
            requireKeys(body, Set.of("requestId", "storyboardVersion"));
            Object number = body.get("storyboardVersion");
            if (!(number instanceof Integer || number instanceof Long) || ((Number) number).longValue() < 1
                    || ((Number) number).longValue() > 1_000_000) {
                throw MediaDevStoryboardSpec.invalid("$.storyboardVersion", "storyboardVersion must be a positive integer");
            }
            var rendered = storyboards.render(tenantId, principalId, requestId(body.get("requestId")),
                    segment(renders.group(1)), ((Number) number).intValue());
            out.json(exchange, rendered.replayed() ? 200 : 201, storyboards.renderView(rendered));
            return;
        }
        Matcher render = RENDER.matcher(path);
        if (render.matches()) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            if (!permitted(exchange, false, out)) return;
            String id = segment(render.group(1));
            int number = Integer.parseInt(render.group(2));
            if (storyboards.version(tenantId, principalId, id, number).isEmpty()) throw MediaDevStoryboardRuntime.notFound();
            var found = storyboards.renderOf(tenantId, principalId, id, number);
            if (found.isEmpty()) {
                out.error(exchange, 404, "RENDER_NOT_FOUND",
                        "This storyboard version has no render in this tenant and owner scope", Map.of());
                return;
            }
            out.json(exchange, 200, storyboards.renderView(id, number, found.get().artifact(), found.get().lineage(), true));
            return;
        }
        Matcher review = REVIEW.matcher(path);
        if (review.matches()) {
            String id = segment(review.group(1));
            int number = Integer.parseInt(review.group(2));
            if ("GET".equals(method)) {
                if (!permitted(exchange, false, out)) return;
                if (storyboards.version(tenantId, principalId, id, number).isEmpty()) throw MediaDevStoryboardRuntime.notFound();
                out.json(exchange, 200, reviewView(id, number, tenantId, principalId));
                return;
            }
            if (!"POST".equals(method)) { notAllowed(exchange, "GET, POST", out); return; }
            if (!permitted(exchange, true, out)) return;
            var handoff = storyboards.handoff(tenantId, principalId, id, number);
            Map<String, Object> view = reviewView(id, number, tenantId, principalId);
            view.put("created", handoff.created());
            out.json(exchange, handoff.created() ? 201 : 200, view);
            return;
        }
        out.error(exchange, 404, "NOT_FOUND", "Storyboard route not found", Map.of());
    }

    private Map<String, Object> reviewView(String id, int number, String tenantId, String principalId) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("scope", "DEV_ONLY");
        view.put("storyboardId", id);
        view.put("storyboardVersion", number);
        Optional<MediaDevCompositeRenderRuntime.Result> render = storyboards.renderOf(tenantId, principalId, id, number);
        view.put("renderId", render.map(found -> found.artifact().artifactId()).orElse(null));
        view.put("renderArtifactVersionId", render.map(found -> found.artifact().version().value()).orElse(null));
        var status = storyboards.reviewStatus(tenantId, principalId, id, number);
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("caseExists", status.map(MediaDevReviewRuntime.SubjectReviewStatus::caseExists).orElse(false));
        state.put("reviewCaseId", status.filter(MediaDevReviewRuntime.SubjectReviewStatus::caseExists)
                .map(MediaDevReviewRuntime.SubjectReviewStatus::reviewCaseId).orElse(null));
        state.put("currentness", status.map(MediaDevReviewRuntime.SubjectReviewStatus::currentness).orElse("NONE"));
        state.put("latestDecision", status.map(MediaDevReviewRuntime.SubjectReviewStatus::latestDecision).orElse("NONE"));
        state.put("acceptedByAssignedReviewer",
                status.map(MediaDevReviewRuntime.SubjectReviewStatus::acceptedByAssignedReviewer).orElse(false));
        state.put("establishesApproval", false);
        view.put("review", state);
        if (state.get("reviewCaseId") != null) view.put("reviewPath", "/dev/v1/reviews/" + state.get("reviewCaseId"));
        view.put("note", "DEV_ONLY: a review of this exact render. It goes STALE the moment the storyboard gains a later "
                + "version and never establishes approval.");
        return view;
    }

    private Map<String, Object> withRender(String tenantId, String principalId,
                                           MediaDevStoryboardRuntime.StoryboardVersion version) {
        Map<String, Object> view = storyboards.view(version, false);
        view.put("render", storyboards.renderOf(tenantId, principalId, version.storyboardId(), version.versionNumber())
                .map(found -> (Object) Map.of("renderId", found.artifact().artifactId(), "artifactVersionId",
                        found.artifact().version().value(), "sha256", found.artifact().sha256()))
                .orElse(null));
        return view;
    }

    private static String requestId(Object value) {
        if (!(value instanceof String text)) throw MediaDevStoryboardSpec.invalid("$.requestId", "requestId must be a string");
        if (!text.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
            throw MediaDevStoryboardSpec.invalid("$.requestId", "requestId must be a 1-128 character opaque id");
        }
        return text;
    }

    private static void requireKeys(Map<String, Object> body, Set<String> keys) {
        for (String key : keys) if (!body.containsKey(key)) throw MediaDevStoryboardSpec.invalid("$." + key, "is required");
        for (String key : body.keySet()) if (!keys.contains(key)) throw MediaDevStoryboardSpec.invalid("$." + key, "is not a known field");
    }

    private static Map<String, Object> body(HttpExchange exchange, int maxBody) throws IOException {
        try {
            Map<String, Object> body = JSON.readValue(MediaHttpHandler.boundedBody(exchange, maxBody, false),
                    new TypeReference<LinkedHashMap<String, Object>>() { });
            if (body == null) throw MediaDevStoryboardSpec.invalid("$", "the request body is required");
            return body;
        } catch (tools.jackson.core.JacksonException malformed) {
            throw MediaDevStoryboardSpec.invalid("$", "the request body is not a valid JSON object");
        }
    }

    private static void notAllowed(HttpExchange exchange, String allow, MediaDevCreativeOutputRoutes.Responder out)
            throws IOException {
        exchange.getResponseHeaders().set("Allow", allow);
        out.error(exchange, 405, "METHOD_NOT_ALLOWED", "Method not allowed", Map.of());
    }

    private static String segment(String raw) {
        String decoded = URLDecoder.decode(raw.replace("+", "%2B"), StandardCharsets.UTF_8);
        if (decoded.indexOf('/') >= 0 || decoded.indexOf('\\') >= 0) {
            throw new IllegalArgumentException("Path identifier must not contain a separator");
        }
        return decoded;
    }
}
