package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaErasureContracts.ErasurePlan;
import com.ghatana.media.runtime.MediaErasureContracts.ErasureReceipt;
import com.ghatana.media.runtime.MediaErasureContracts.ErasureRefusedException;
import com.ghatana.media.runtime.MediaErasureContracts.LegalHold;
import com.ghatana.media.runtime.MediaErasureContracts.ReceiptItem;
import com.ghatana.media.runtime.MediaErasureContracts.Tombstone;
import com.ghatana.media.runtime.MediaErasureContracts.TreeNode;
import com.ghatana.media.runtime.MediaVerifiedIdentityContracts.AssuranceSource;
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
 * DEV_ONLY erasure and legal-hold routes (outside the canonical manifest/OpenAPI; PDP owns canonical routes):
 * <ul>
 *   <li>{@code GET /dev/v1/erasure-plans/{artifactId}}: the exact tree an erasure would remove (read-only);</li>
 *   <li>{@code POST /dev/v1/erasures}: erase the tree (needs {@code confirm:true}; refused under a legal hold);</li>
 *   <li>{@code GET /dev/v1/erasures/{erasureId}}: the content-free erasure receipt;</li>
 *   <li>{@code POST /dev/v1/legal-holds}, {@code GET /dev/v1/legal-holds[/{holdId}]},
 *       {@code POST /dev/v1/legal-holds/{holdId}/release}: owner-authorised holds.</li>
 * </ul>
 * Mutations require {@code media:artifact:write} and, in production-like profiles (or with
 * {@code MEDIA_DEV_ERASURE_REQUIRE_OIDC=true}), an {@code OIDC_VERIFIED} principal. Every response is labelled DEV_ONLY
 * and carries identifiers, kinds, counts and digests only.
 */
final class MediaDevErasureRoutes {
    static final String PLANS = "/dev/v1/erasure-plans";
    static final String ERASURES = "/dev/v1/erasures";
    static final String HOLDS = "/dev/v1/legal-holds";
    private static final Pattern PLAN = Pattern.compile("^/dev/v1/erasure-plans/([^/]+)$");
    private static final Pattern ERASURE = Pattern.compile("^/dev/v1/erasures/([^/]+)$");
    private static final Pattern HOLD = Pattern.compile("^/dev/v1/legal-holds/([^/]+)$");
    private static final Pattern RELEASE = Pattern.compile("^/dev/v1/legal-holds/([^/]+)/release$");
    /** Read routes that name one artifact-bearing id: a tombstoned id answers a typed 410. */
    private static final List<Pattern> ERASED_READS = List.of(
            Pattern.compile("^/dev/v1/artifacts/([^/]+)/content$"),
            Pattern.compile("^/dev/v1/speech/outputs/([^/]+)$"),
            Pattern.compile("^/dev/v1/captions/([^/]+)$"),
            Pattern.compile("^/dev/v1/vision/outputs/([^/]+)$"),
            Pattern.compile("^/dev/v1/grounded-answers/([^/]+)$"),
            Pattern.compile("^/dev/v1/creative-outputs/([^/]+)$"),
            Pattern.compile("^/dev/v1/rights/artifacts/([^/]+)/versions/[^/]+/attestations$"));
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();

    private final MediaDevErasureRuntime erasure;
    private final MediaRuntime runtime;
    private final boolean requireOidc;

    MediaDevErasureRoutes(MediaDevErasureRuntime erasure, MediaRuntime runtime, boolean requireOidc) {
        this.erasure = erasure;
        this.runtime = runtime;
        this.requireOidc = requireOidc || runtime.config().productionLike();
    }

    static boolean handles(String path) {
        return path.equals(ERASURES) || path.startsWith(ERASURES + "/") || path.startsWith(PLANS + "/")
                || path.equals(HOLDS) || path.startsWith(HOLDS + "/");
    }

    /** A read of an erased artifact id answers 410 {@code ARTIFACT_ERASED} (never bytes). True when it answered. */
    boolean refuseIfErased(HttpExchange exchange, String path, String method, String tenantId,
                           MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        if (!"GET".equals(method)) return false;
        for (Pattern pattern : ERASED_READS) {
            Matcher matcher = pattern.matcher(path);
            if (!matcher.matches()) continue;
            Optional<Tombstone> tombstone = erasure.tombstone(tenantId, pathSegment(matcher.group(1)));
            if (tombstone.isEmpty()) return false;
            out.error(exchange, 410, "ARTIFACT_ERASED",
                    "This artifact was erased on request; its content is no longer available",
                    Map.of("erasureId", tombstone.get().erasureId(), "kind", tombstone.get().kind()));
            return true;
        }
        return false;
    }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId, int maxBody,
                MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        try {
            dispatch(exchange, path, method, tenantId, principalId, maxBody, out);
        } catch (ErasureRefusedException refused) {
            runtime.recordDeniedRequest();
            out.error(exchange, refused.status(), refused.code(), refused.getMessage(), refused.details());
        }
    }

    private void dispatch(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                          int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        Matcher plan = PLAN.matcher(path);
        if (plan.matches()) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            if (!permitted(exchange, out, false)) return;
            out.json(exchange, 200, planView(erasure.plan(tenantId, principalId, pathSegment(plan.group(1)))));
            return;
        }
        if (ERASURES.equals(path)) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!permitted(exchange, out, true)) return;
            AssuranceSource assurance = assuranceOrRefuse(exchange, out);
            if (assurance == null) return;
            Map<String, Object> body = body(exchange, maxBody);
            requireKeys(body, Set.of("erasureId", "artifactId", "confirm", "expectedArtifactCount"),
                    Set.of("erasureId", "artifactId", "confirm"));
            if (!Boolean.TRUE.equals(body.get("confirm"))) {
                out.error(exchange, 422, "ERASURE_NOT_CONFIRMED",
                        "an erasure is destructive and permanent: send confirm=true after reviewing the plan", Map.of());
                return;
            }
            String artifactId = string(body.get("artifactId"), "artifactId");
            if (body.containsKey("expectedArtifactCount")) {
                int expected = integer(body.get("expectedArtifactCount"), "expectedArtifactCount");
                int current = erasure.plan(tenantId, principalId, artifactId).artifacts().size();
                if (expected != current) {
                    out.error(exchange, 409, "ERASURE_TREE_CHANGED",
                            "the tree changed since it was reviewed; nothing was erased",
                            Map.of("expectedArtifactCount", expected, "currentArtifactCount", current));
                    return;
                }
            }
            ErasureReceipt receipt = erasure.erase(tenantId, principalId, string(body.get("erasureId"), "erasureId"),
                    artifactId, assurance);
            out.json(exchange, 201, receiptView(receipt));
            return;
        }
        Matcher single = ERASURE.matcher(path);
        if (single.matches()) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            if (!permitted(exchange, out, false)) return;
            Optional<ErasureReceipt> receipt = erasure.receipt(tenantId, principalId, pathSegment(single.group(1)));
            if (receipt.isEmpty()) {
                out.error(exchange, 404, "ERASURE_NOT_FOUND", "Erasure not found in this tenant and owner scope", Map.of());
                return;
            }
            out.json(exchange, 200, receiptView(receipt.get()));
            return;
        }
        if (HOLDS.equals(path)) {
            if ("GET".equals(method)) {
                if (!permitted(exchange, out, false)) return;
                String artifactId = queryValue(exchange, "artifactId");
                if (artifactId == null) throw new IllegalArgumentException("artifactId query parameter is required");
                List<Map<String, Object>> holds = new ArrayList<>();
                for (LegalHold hold : erasure.holds(tenantId, principalId, artifactId)) holds.add(holdView(hold));
                out.json(exchange, 200, Map.of("artifactId", artifactId, "holds", holds, "scope", "DEV_ONLY"));
                return;
            }
            if (!"POST".equals(method)) { notAllowed(exchange, "GET, POST", out); return; }
            if (!permitted(exchange, out, true)) return;
            AssuranceSource assurance = assuranceOrRefuse(exchange, out);
            if (assurance == null) return;
            Map<String, Object> body = body(exchange, maxBody);
            requireKeys(body, Set.of("requestId", "artifactId", "reason"), Set.of("requestId", "artifactId", "reason"));
            LegalHold hold = erasure.placeHold(tenantId, principalId, string(body.get("requestId"), "requestId"),
                    string(body.get("artifactId"), "artifactId"), string(body.get("reason"), "reason"), assurance);
            out.json(exchange, hold.replayed() ? 200 : 201, holdView(hold));
            return;
        }
        Matcher release = RELEASE.matcher(path);
        if (release.matches()) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!permitted(exchange, out, true)) return;
            AssuranceSource assurance = assuranceOrRefuse(exchange, out);
            if (assurance == null) return;
            Map<String, Object> body = body(exchange, maxBody);
            requireKeys(body, Set.of("reason"), Set.of("reason"));
            out.json(exchange, 200, holdView(erasure.releaseHold(tenantId, principalId,
                    pathSegment(release.group(1)), string(body.get("reason"), "reason"), assurance)));
            return;
        }
        Matcher hold = HOLD.matcher(path);
        if (hold.matches()) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            if (!permitted(exchange, out, false)) return;
            Optional<LegalHold> found = erasure.hold(tenantId, principalId, pathSegment(hold.group(1)));
            if (found.isEmpty()) {
                out.error(exchange, 404, "HOLD_NOT_FOUND", "Legal hold not found in this tenant and owner scope", Map.of());
                return;
            }
            out.json(exchange, 200, holdView(found.get()));
            return;
        }
        out.error(exchange, 404, "NOT_FOUND", "Erasure route not found", Map.of());
    }

    // ---------------------------------------------------------------------------------------------- views

    static Map<String, Object> planView(ErasurePlan plan) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("rootArtifactId", plan.rootArtifactId());
        List<Map<String, Object>> artifacts = new ArrayList<>();
        for (TreeNode node : plan.artifacts()) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("artifactId", node.artifactId());
            item.put("kind", node.kind());
            item.put("contentType", node.contentType());
            item.put("sha256", node.sha256());
            item.put("sizeBytes", node.sizeBytes());
            item.put("derivedFrom", node.derivedFrom());
            artifacts.add(item);
        }
        view.put("artifacts", artifacts);
        view.put("artifactCount", artifacts.size());
        view.put("dependentRecords", plan.dependentRecords());
        List<Map<String, Object>> holds = new ArrayList<>();
        for (LegalHold hold : plan.blockingHolds()) holds.add(holdView(hold));
        view.put("blockingHolds", holds);
        view.put("erasable", plan.erasable());
        view.put("note", "Erasure is permanent. Revoking a rights statement does not delete anything; erasure is a separate act.");
        view.put("scope", "DEV_ONLY");
        return view;
    }

    static Map<String, Object> receiptView(ErasureReceipt receipt) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("erasureId", receipt.erasureId());
        view.put("rootArtifactId", receipt.rootArtifactId());
        view.put("phase", receipt.phase().name());
        view.put("complete", receipt.phase() == com.ghatana.media.runtime.MediaErasureContracts.Phase.COMPLETED);
        view.put("requestedBy", receipt.requestedBy());
        view.put("requestedAt", receipt.requestedAt().toString());
        view.put("completedAt", receipt.completedAt() == null ? null : receipt.completedAt().toString());
        List<Map<String, Object>> items = new ArrayList<>();
        for (ReceiptItem item : receipt.items()) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("kind", item.kind());
            entry.put("count", item.count());
            entry.put("digests", item.digests());
            items.add(entry);
        }
        view.put("items", items);
        view.put("totalRemoved", receipt.totalRemoved());
        view.put("contentDisclosed", "none");
        view.put("scope", "DEV_ONLY");
        return view;
    }

    static Map<String, Object> holdView(LegalHold hold) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("holdId", hold.holdId());
        view.put("rootArtifactId", hold.rootArtifactId());
        view.put("state", hold.state().name());
        view.put("reason", hold.reason());
        view.put("placedBy", hold.placedBy());
        view.put("placedIdentityAssurance", hold.placedAssurance().name());
        view.put("placedAt", hold.placedAt().toString());
        view.put("releasedBy", hold.releasedBy());
        view.put("releasedIdentityAssurance", hold.releasedAssurance() == null ? null : hold.releasedAssurance().name());
        view.put("releaseReason", hold.releaseReason());
        view.put("releasedAt", hold.releasedAt() == null ? null : hold.releasedAt().toString());
        view.put("replayed", hold.replayed());
        view.put("scope", "DEV_ONLY");
        return view;
    }

    // --------------------------------------------------------------------------------------------- helpers

    /** Reads need {@code media:artifact:read}; mutations need {@code media:artifact:write}. */
    private boolean permitted(HttpExchange exchange, MediaDevCreativeOutputRoutes.Responder out, boolean mutation)
            throws IOException {
        String needed = mutation ? "media:artifact:write" : "media:artifact:read";
        if (MediaSecurityFilter.hasDevOnlyPermission(exchange, needed)) return true;
        runtime.recordDeniedRequest();
        out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                "DEV_ONLY " + needed + " permission is required", Map.of());
        return false;
    }

    /** The identity assurance of the caller; refused unless {@code OIDC_VERIFIED} where the profile demands it. */
    private AssuranceSource assuranceOrRefuse(HttpExchange exchange, MediaDevCreativeOutputRoutes.Responder out)
            throws IOException {
        var verified = MediaSecurityFilter.verifiedIdentity(exchange);
        AssuranceSource assurance = verified == null ? AssuranceSource.UNSPECIFIED : verified.assurance();
        if (verified == null) {
            var principal = MediaSecurityFilter.authenticatedPrincipal(exchange);
            if (principal != null) assurance = principal.assurance();
        }
        if (requireOidc && assurance != AssuranceSource.OIDC_VERIFIED) {
            runtime.recordDeniedRequest();
            out.error(exchange, 403, "IDENTITY_ASSURANCE_REQUIRED",
                    "holds, releases and erasure require an identity-provider verified (OIDC_VERIFIED) principal in this profile",
                    Map.of("required", AssuranceSource.OIDC_VERIFIED.name(), "presented", assurance.name()));
            return null;
        }
        return assurance;
    }

    private static Map<String, Object> body(HttpExchange exchange, int maxBody) throws IOException {
        Map<String, Object> body = JSON.readValue(MediaHttpHandler.boundedBody(exchange, maxBody, false),
                new TypeReference<Map<String, Object>>() { });
        if (body == null) throw new IllegalArgumentException("request body is required");
        return body;
    }

    private static void requireKeys(Map<String, Object> body, Set<String> allowed, Set<String> required) {
        if (!body.keySet().containsAll(required) || !allowed.containsAll(body.keySet())) {
            throw new IllegalArgumentException("request fields do not match its declared shape");
        }
    }

    private static String string(Object value, String field) {
        if (!(value instanceof String text) || text.isBlank()) throw new IllegalArgumentException(field + " must be a non-blank string");
        return text;
    }

    private static int integer(Object value, String field) {
        if (value instanceof Integer number && number >= 0) return number;
        throw new IllegalArgumentException(field + " must be a non-negative integer");
    }

    private static String queryValue(HttpExchange exchange, String name) {
        String query = exchange.getRequestURI().getRawQuery();
        if (query == null) return null;
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq > 0 && pair.substring(0, eq).equals(name)) {
                return URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8);
            }
        }
        return null;
    }

    private static String pathSegment(String raw) {
        return URLDecoder.decode(raw.replace("+", "%2B"), StandardCharsets.UTF_8);
    }

    private static void notAllowed(HttpExchange exchange, String allow, MediaDevCreativeOutputRoutes.Responder out)
            throws IOException {
        exchange.getResponseHeaders().set("Allow", allow);
        out.error(exchange, 405, "METHOD_NOT_ALLOWED", "Method not allowed", Map.of());
    }
}
