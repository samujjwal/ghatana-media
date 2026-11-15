package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaErasureContracts.ErasureAuthority;
import com.ghatana.media.runtime.MediaErasureContracts.ErasureOperation;
import com.ghatana.media.runtime.MediaErasureContracts.ErasurePlan;
import com.ghatana.media.runtime.MediaErasureContracts.ErasureReceipt;
import com.ghatana.media.runtime.MediaErasureContracts.ErasureRefusedException;
import com.ghatana.media.runtime.MediaErasureContracts.HoldState;
import com.ghatana.media.runtime.MediaErasureContracts.LegalHold;
import com.ghatana.media.runtime.MediaErasureContracts.LocalWork;
import com.ghatana.media.runtime.MediaErasureContracts.Phase;
import com.ghatana.media.runtime.MediaErasureContracts.ReceiptItem;
import com.ghatana.media.runtime.MediaErasureContracts.Tombstone;
import com.ghatana.media.runtime.MediaErasureContracts.TreeNode;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaVerifiedIdentityContracts.AssuranceSource;
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
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The DEV_ONLY erasure and legal-hold routes through the real HTTP host and security filter, over an in-memory
 * authority (the PostgreSQL/S3 semantics are proven by {@code PostgresqlMediaErasureAuthorityTest} and the
 * real-process IT). Proves request validation, confirmation, owner scoping, hold refusal, the typed 410 on erased
 * reads, the OIDC-only gate of production-like profiles, and that no response carries content.
 */
class MediaDevErasureHttpTest {
    private static final String TENANT = "tenant-local";
    private static final String OWNER = "test-principal-owner";
    private static final String OTHER = "test-principal-other";
    private static final String SECRET = "test-only-dev-project-secret-at-least-32-bytes";
    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-11-14T10:00:00Z"), ZoneOffset.UTC);
    private static final Set<String> FULL = Set.of("media:project:dev:read", "media:project:dev:write",
            "media:artifact:read", "media:artifact:write", "media:artifact:create");
    private static final Set<String> READ_ONLY = Set.of("media:project:dev:read", "media:artifact:read");
    private static final ObjectMapper JSON = JsonMapper.builder().build();

    @Test
    void routePermissionsAreExactMethodAndPath() {
        for (String path : List.of("/dev/v1/erasure-plans/a", "/dev/v1/erasures/e", "/dev/v1/legal-holds",
                "/dev/v1/legal-holds/h")) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", path)).as(path)
                    .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
        }
        for (String path : List.of("/dev/v1/erasures", "/dev/v1/legal-holds", "/dev/v1/legal-holds/h/release")) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", path)).as(path)
                    .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_WRITE);
        }
        for (String[] route : new String[][] {{"DELETE", "/dev/v1/erasures/e"}, {"PUT", "/dev/v1/erasures"},
                {"POST", "/dev/v1/erasures/e"}, {"GET", "/dev/v1/erasures"}, {"POST", "/dev/v1/erasure-plans/a"},
                {"POST", "/dev/v1/legal-holds/h"}, {"GET", "/dev/v1/legal-holds/h/release"}}) {
            assertThat(MediaDevOnlyRoutePermissions.requiredPermission(route[0], route[1]))
                    .as(route[0] + " " + route[1]).isNull();
        }
    }

    @Test
    void planConfirmationHoldReleaseErasureReceiptAndErasedReadsThroughHttp() throws Exception {
        Fixture fixture = new Fixture(false);
        try {
            fixture.authority.seed(OWNER, "root", "SOURCE_ARTIFACT", null);
            fixture.authority.seed(OWNER, "child-1", "TRANSCRIPT", "root");
            fixture.authority.seed(OWNER, "child-2", "RENDER", "child-1");
            fixture.authority.seed(OWNER, "unrelated", "SOURCE_ARTIFACT", null);

            Map<String, Object> plan = read(fixture.send("GET", "/dev/v1/erasure-plans/root", null, OWNER, FULL, 200));
            assertThat(plan).containsEntry("artifactCount", 3).containsEntry("erasable", true).containsEntry("scope", "DEV_ONLY");
            assertThat(plan.toString()).contains("RENDER").contains("TRANSCRIPT");

            // Non-owner: the tree does not exist for them (typed 404), and they cannot hold or erase it.
            assertThat(fixture.send("GET", "/dev/v1/erasure-plans/root", null, OTHER, FULL, 404).body()).contains("ARTIFACT_NOT_FOUND");
            assertThat(fixture.send("POST", "/dev/v1/erasures", erase("e-other", "root", true, null), OTHER, FULL, 404).body())
                    .contains("ARTIFACT_NOT_FOUND");
            // Missing permission, unconfirmed, unknown field, stale tree size: nothing erased.
            assertThat(fixture.send("POST", "/dev/v1/erasures", erase("e-1", "root", true, null), OWNER, READ_ONLY, 403).body())
                    .contains("FORBIDDEN");
            assertThat(fixture.send("POST", "/dev/v1/erasures", erase("e-1", "root", false, null), OWNER, FULL, 422).body())
                    .contains("ERASURE_NOT_CONFIRMED");
            assertThat(fixture.send("POST", "/dev/v1/erasures", "{\"erasureId\":\"e-1\",\"artifactId\":\"root\",\"confirm\":true,\"x\":1}",
                    OWNER, FULL, 400).body()).contains("INVALID_REQUEST");
            assertThat(fixture.send("POST", "/dev/v1/erasures", erase("e-1", "root", true, 99), OWNER, FULL, 409).body())
                    .contains("ERASURE_TREE_CHANGED");
            assertThat(fixture.authority.erasedCount()).isZero();

            // Owner hold: erasure is refused with a typed code; the hold records reason and principal.
            Map<String, Object> hold = read(fixture.send("POST", "/dev/v1/legal-holds",
                    JSON.writeValueAsString(Map.of("requestId", "h-1", "artifactId", "root", "reason", "TEST litigation hold")),
                    OWNER, FULL, 201));
            assertThat(hold).containsEntry("state", "ACTIVE").containsEntry("placedBy", OWNER)
                    .containsEntry("reason", "TEST litigation hold").containsEntry("placedIdentityAssurance", "DEV_ISSUED");
            String holdId = (String) hold.get("holdId");
            assertThat(fixture.send("POST", "/dev/v1/legal-holds", JSON.writeValueAsString(Map.of("requestId", "h-1",
                    "artifactId", "root", "reason", "TEST litigation hold")), OWNER, FULL, 200).body()).contains("\"replayed\":true");
            assertThat(fixture.send("POST", "/dev/v1/erasures", erase("e-1", "root", true, 3), OWNER, FULL, 409).body())
                    .contains("LEGAL_HOLD_ACTIVE");
            assertThat(read(fixture.send("GET", "/dev/v1/erasure-plans/root", null, OWNER, FULL, 200)))
                    .containsEntry("erasable", false);
            assertThat(fixture.authority.erasedCount()).isZero();
            assertThat(fixture.send("POST", "/dev/v1/legal-holds/" + holdId + "/release",
                    "{\"reason\":\"matter closed\"}", OTHER, FULL, 404).body()).contains("HOLD_NOT_FOUND");
            Map<String, Object> released = read(fixture.send("POST", "/dev/v1/legal-holds/" + holdId + "/release",
                    "{\"reason\":\"TEST matter closed\"}", OWNER, FULL, 200));
            assertThat(released).containsEntry("state", "RELEASED").containsEntry("releasedBy", OWNER)
                    .containsEntry("releaseReason", "TEST matter closed");

            // Erase; the receipt lists kinds, counts and digests and no content.
            Map<String, Object> receipt = read(fixture.send("POST", "/dev/v1/erasures", erase("e-1", "root", true, 3),
                    OWNER, FULL, 201));
            assertThat(receipt).containsEntry("phase", "COMPLETED").containsEntry("complete", true)
                    .containsEntry("contentDisclosed", "none").containsEntry("totalRemoved", 3);
            assertThat(receipt.toString()).contains("RENDER").contains("sha-of-child-2");
            assertThat(fixture.send("GET", "/dev/v1/erasures/e-1", null, OWNER, FULL, 200).body()).contains("COMPLETED");
            assertThat(fixture.send("GET", "/dev/v1/erasures/e-1", null, OTHER, FULL, 404).body()).contains("ERASURE_NOT_FOUND");

            // Erased ids answer a typed 410 on every artifact-bearing read; the unrelated tree is untouched.
            for (String path : List.of("/dev/v1/artifacts/child-2/content", "/dev/v1/speech/outputs/child-1",
                    "/dev/v1/captions/root", "/dev/v1/vision/outputs/child-1", "/dev/v1/grounded-answers/child-2",
                    "/dev/v1/creative-outputs/child-1")) {
                HttpResponse<String> gone = fixture.send("GET", path, null, OWNER, FULL, 410);
                assertThat(gone.body()).as(path).contains("ARTIFACT_ERASED").contains("e-1");
            }
            assertThat(fixture.send("GET", "/dev/v1/erasure-plans/root", null, OWNER, FULL, 410).body()).contains("ARTIFACT_ERASED");
            assertThat(fixture.send("POST", "/dev/v1/erasures", erase("e-2", "root", true, null), OWNER, FULL, 410).body())
                    .contains("ARTIFACT_ERASED");
            assertThat(read(fixture.send("GET", "/dev/v1/erasure-plans/unrelated", null, OWNER, FULL, 200)))
                    .containsEntry("artifactCount", 1);
        } finally {
            fixture.close();
        }
    }

    @Test
    void aProductionLikeGateRefusesHoldsReleasesAndErasuresFromADevIssuedIdentity() throws Exception {
        Fixture fixture = new Fixture(true);
        try {
            fixture.authority.seed(OWNER, "root", "SOURCE_ARTIFACT", null);
            for (String[] request : new String[][] {
                    {"/dev/v1/legal-holds", "{\"requestId\":\"h\",\"artifactId\":\"root\",\"reason\":\"r\"}"},
                    {"/dev/v1/legal-holds/hold-1/release", "{\"reason\":\"r\"}"},
                    {"/dev/v1/erasures", erase("e", "root", true, null)}}) {
                HttpResponse<String> refused = fixture.send("POST", request[0], request[1], OWNER, FULL, 403);
                assertThat(refused.body()).contains("IDENTITY_ASSURANCE_REQUIRED").contains("OIDC_VERIFIED").contains("DEV_ISSUED");
            }
            assertThat(fixture.authority.erasedCount()).isZero();
            // Reads of the plan stay available: they change nothing.
            fixture.send("GET", "/dev/v1/erasure-plans/root", null, OWNER, FULL, 200);
        } finally {
            fixture.close();
        }
    }

    private static String erase(String id, String artifact, boolean confirm, Integer expected) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("erasureId", id); body.put("artifactId", artifact); body.put("confirm", confirm);
        if (expected != null) body.put("expectedArtifactCount", expected);
        return JSON.writeValueAsString(body);
    }

    private static Map<String, Object> read(HttpResponse<String> response) throws Exception {
        return JSON.readValue(response.body(), new TypeReference<Map<String, Object>>() { });
    }

    /** Minimal in-memory authority with the same refusal vocabulary as the PostgreSQL one. */
    private static final class FakeAuthority implements ErasureAuthority {
        private record Node(String owner, String id, String kind, String parent) { }
        private final Map<String, Node> nodes = new LinkedHashMap<>();
        private final Map<String, LegalHold> holds = new LinkedHashMap<>();
        private final Map<String, Tombstone> tombstones = new LinkedHashMap<>();
        private final Map<String, ErasureReceipt> receipts = new LinkedHashMap<>();
        private final Map<String, String> erasureRoots = new LinkedHashMap<>();

        void seed(String owner, String id, String kind, String parent) { nodes.put(id, new Node(owner, id, kind, parent)); }
        int erasedCount() { return tombstones.size(); }

        private List<Node> tree(String principal, String root) {
            Node rootNode = nodes.get(root);
            if (rootNode == null || !rootNode.owner().equals(principal)) {
                Tombstone erased = tombstones.get(root);
                if (erased != null) {
                    throw new ErasureRefusedException(410, "ARTIFACT_ERASED", "erased", Map.of("erasureId", erased.erasureId()));
                }
                throw new ErasureRefusedException(404, "ARTIFACT_NOT_FOUND", "not found", Map.of());
            }
            List<Node> found = new ArrayList<>(List.of(rootNode));
            for (int i = 0; i < found.size(); i++) {
                String id = found.get(i).id();
                nodes.values().stream().filter(n -> id.equals(n.parent())).forEach(found::add);
            }
            return found;
        }

        private List<LegalHold> blocking(String principal, String root) {
            List<String> ids = tree(principal, root).stream().map(Node::id).toList();
            return holds.values().stream().filter(h -> h.state() == HoldState.ACTIVE)
                    .filter(h -> tree(h.placedBy(), h.rootArtifactId()).stream().anyMatch(n -> ids.contains(n.id()))).toList();
        }

        @Override public String authorityId() { return "fake"; }
        @Override public boolean ready() { return true; }
        @Override public ErasurePlan plan(String tenantId, String principalId, String artifactId) {
            List<TreeNode> list = new ArrayList<>();
            for (Node n : tree(principalId, artifactId)) {
                list.add(new TreeNode(n.id(), n.kind(), "audio/wav", "sha-of-" + n.id(), 10,
                        n.parent() == null ? List.of() : List.of(n.parent())));
            }
            List<LegalHold> blocking = blocking(principalId, artifactId);
            return new ErasurePlan(artifactId, list, Map.of(), blocking, blocking.isEmpty());
        }
        @Override public LegalHold placeHold(String t, String principalId, String requestId, String artifactId, String reason,
                                             AssuranceSource assurance) {
            tree(principalId, artifactId);
            for (LegalHold existing : holds.values()) {
                if (existing.placedBy().equals(principalId) && existing.holdId().endsWith(requestId)) {
                    return new LegalHold(existing.holdId(), existing.rootArtifactId(), existing.reason(), existing.placedBy(),
                            existing.placedAssurance(), existing.placedAt(), existing.state(), null, null, null, null, true);
                }
            }
            LegalHold hold = new LegalHold("hold-" + requestId, artifactId, reason, principalId, assurance, CLOCK.instant(),
                    HoldState.ACTIVE, null, null, null, null, false);
            holds.put(hold.holdId(), hold);
            return hold;
        }
        @Override public LegalHold releaseHold(String t, String principalId, String holdId, String reason, AssuranceSource assurance) {
            LegalHold hold = holds.get(holdId);
            if (hold == null || !hold.placedBy().equals(principalId)) {
                throw new ErasureRefusedException(404, "HOLD_NOT_FOUND", "not found", Map.of());
            }
            LegalHold released = new LegalHold(holdId, hold.rootArtifactId(), hold.reason(), hold.placedBy(),
                    hold.placedAssurance(), hold.placedAt(), HoldState.RELEASED, principalId, assurance, reason,
                    CLOCK.instant(), false);
            holds.put(holdId, released);
            return released;
        }
        @Override public Optional<LegalHold> hold(String t, String principalId, String holdId) {
            return Optional.ofNullable(holds.get(holdId)).filter(h -> h.placedBy().equals(principalId));
        }
        @Override public List<LegalHold> holds(String t, String principalId, String artifactId) {
            return holds.values().stream().filter(h -> h.rootArtifactId().equals(artifactId) && h.placedBy().equals(principalId)).toList();
        }
        @Override public ErasureOperation begin(String t, String principalId, String erasureId, String artifactId,
                                                AssuranceSource assurance) {
            List<Node> tree = tree(principalId, artifactId);
            List<LegalHold> blocking = blocking(principalId, artifactId);
            if (!blocking.isEmpty()) {
                throw new ErasureRefusedException(409, "LEGAL_HOLD_ACTIVE", "held", Map.of("holdIds", List.of(blocking.getFirst().holdId())));
            }
            List<ReceiptItem> items = new ArrayList<>();
            for (Node n : tree) {
                items.add(new ReceiptItem(n.kind(), 1, List.of("sha-of-" + n.id())));
                tombstones.put(n.id(), new Tombstone(n.id(), erasureId, n.kind(), "sha-of-" + n.id(), CLOCK.instant()));
                nodes.remove(n.id());
            }
            receipts.put(erasureId, new ErasureReceipt(erasureId, artifactId, Phase.COMPLETED, principalId, CLOCK.instant(),
                    CLOCK.instant(), items));
            erasureRoots.put(erasureId, principalId);
            return new ErasureOperation(t, erasureId, principalId, artifactId, Phase.DB_ERASED,
                    new LocalWork(tree.stream().map(Node::id).toList(), List.of(), List.of()), false);
        }
        @Override public ErasureOperation eraseObjects(ErasureOperation operation) { return operation; }
        @Override public ErasureReceipt complete(ErasureOperation operation, List<ReceiptItem> localItems) {
            return receipts.get(operation.erasureId());
        }
        @Override public Optional<ErasureReceipt> receipt(String t, String principalId, String erasureId) {
            return Optional.ofNullable(receipts.get(erasureId)).filter(r -> r.requestedBy().equals(principalId));
        }
        @Override public List<ErasureOperation> incomplete() { return List.of(); }
        @Override public Optional<Tombstone> tombstone(String t, String artifactId) { return Optional.ofNullable(tombstones.get(artifactId)); }
        @Override public void close() { }
    }

    private static final class Fixture {
        final FakeAuthority authority = new FakeAuthority();
        final MediaRuntime runtime;
        final HttpServer server;

        Fixture(boolean requireOidc) throws Exception {
            Path root = Files.createTempDirectory("media-dev-erasure-http-");
            runtime = new MediaRuntime(
                    new MediaRuntimeConfig(true, "dev", 8094, 1_048_576, 131_072, 8_388_608,
                            Duration.ofSeconds(2), 2, "", "", true, false, root),
                    new LocalMediaRuntimeSupport.FileArtifactStore(root),
                    new LocalMediaRuntimeSupport.JobStore(false),
                    new LocalMediaRuntimeSupport.StreamStore(), null,
                    List.of(new NoEffectProvider()),
                    List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
            MediaDevErasureRuntime erasure = new MediaDevErasureRuntime(authority, List.of(), "");
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            MediaHttpHandler handler = new MediaHttpHandler(runtime, null, null, null).withDevErasure(erasure, requireOidc);
            server.createContext("/", new MediaSecurityFilter(handler, "dev",
                    Map.of("MEDIA_DEV_IDENTITY_ENABLED", "true", "MEDIA_DEV_JWT_HMAC_SECRET", SECRET), CLOCK));
            server.start();
        }

        void close() { server.stop(0); runtime.close(); }

        HttpResponse<String> send(String method, String path, String body, String principal, Set<String> permissions,
                                  int expectedStatus) throws Exception {
            HttpRequest.Builder request = HttpRequest.newBuilder(
                            URI.create("http://127.0.0.1:" + server.getAddress().getPort() + path))
                    .header("Authorization", "Bearer " + token(principal, permissions)).header("X-Tenant-Id", TENANT);
            if (body != null) request.header("Content-Type", "application/json");
            request.method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                    : HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
            HttpResponse<String> response = HttpClient.newHttpClient().send(request.build(),
                    HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            assertThat(response.statusCode()).as(method + " " + path + " -> " + response.body()).isEqualTo(expectedStatus);
            return response;
        }
    }

    private static String token(String principal, Set<String> permissions) throws Exception {
        String header = encode("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        String permissionJson = permissions.stream().sorted().map(permission -> "\"" + permission + "\"")
                .collect(java.util.stream.Collectors.joining(","));
        String payload = "{\"sub\":\"" + principal + "\",\"tenant_id\":\"" + TENANT
                + "\",\"iss\":\"urn:ghatana:media:dev-only\",\"aud\":\"ghatana-media-dev\",\"dev_only\":true,"
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

    private static final class NoEffectProvider implements MediaProcessingProvider {
        @Override public String providerId() { return "dev-erasure-http-no-effect"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.TRANSCODE); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 0; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            return CompletableFuture.failedFuture(new AssertionError("erasure routes must not invoke processing"));
        }
    }
}
