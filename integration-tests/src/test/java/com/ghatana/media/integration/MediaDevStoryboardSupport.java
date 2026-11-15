package com.ghatana.media.integration;

import tools.jackson.databind.JsonNode;

import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static com.ghatana.media.integration.MediaDevCompositeSupport.*;
import static com.ghatana.media.integration.MediaDevLiveFixtures.JSON;
import static com.ghatana.media.integration.MediaDevLiveFixtures.sha256;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffmpeg;

/**
 * Shared pieces of the J-09 (brief to reviewed media) journeys: generated media, storyboard document builders, the
 * attestation and review helpers, and the decoded-frame signatures of the expected render. TEST principals only; every
 * rights statement is a statement by a synthetic test principal about generated media, not a legal determination.
 */
final class MediaDevStoryboardSupport {

    private MediaDevStoryboardSupport() { }

    /** A 1.5 s mono narration whose 1 kHz marker starts 0.5 s into the file. */
    static byte[] narration(Path dir, double seconds) throws Exception {
        Files.createDirectories(dir);
        Path out = dir.resolve("scene-narration-" + seconds + ".wav");
        run(ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                "sine=f=1000:r=48000:d=0.2,volume=4,adelay=500,apad=whole_dur=" + seconds, "-ac", "1", "-c:a", "pcm_s16le",
                out.toString());
        return Files.readAllBytes(out);
    }

    static String version(byte[] bytes) throws Exception {
        return "sha256:" + sha256(bytes);
    }

    static Map<String, Object> animation(String background, boolean movingRectangle) {
        Map<String, Object> spec = new LinkedHashMap<>();
        spec.put("background", background);
        List<Object> shapes = new ArrayList<>();
        if (movingRectangle) {
            Map<String, Object> rect = new LinkedHashMap<>();
            rect.put("id", "box");
            rect.put("primitive", "RECTANGLE");
            rect.put("x", 10);
            rect.put("y", 10);
            rect.put("width", 40);
            rect.put("height", 40);
            rect.put("color", "#FFFFFF");
            rect.put("keyframes", List.of(key(0, 0), key(24, 200)));
            shapes.add(rect);
        }
        spec.put("shapes", shapes);
        return Map.of("kind", "ANIMATION", "spec", spec);
    }

    private static Map<String, Object> key(int frame, double x) {
        Map<String, Object> key = new LinkedHashMap<>();
        key.put("frame", frame);
        key.put("x", x);
        key.put("y", 0);
        key.put("scaleX", 1);
        key.put("scaleY", 1);
        key.put("opacity", 1);
        key.put("easing", "LINEAR");
        return key;
    }

    static Map<String, Object> asset(String artifactId, byte[] bytes, long sourceInMs) throws Exception {
        Map<String, Object> source = new LinkedHashMap<>();
        source.put("kind", "ASSET");
        source.put("artifactId", artifactId);
        source.put("artifactVersionId", version(bytes));
        source.put("sourceInMs", sourceInMs);
        return source;
    }

    static Map<String, Object> placeholder(String note) {
        return Map.of("kind", "PLACEHOLDER", "note", note);
    }

    static Map<String, Object> shot(String id, long durationMs, Map<String, Object> source) {
        Map<String, Object> shot = new LinkedHashMap<>();
        shot.put("shotId", id);
        shot.put("durationMs", durationMs);
        shot.put("source", source);
        return shot;
    }

    static Map<String, Object> ref(String artifactId, byte[] bytes) throws Exception {
        Map<String, Object> ref = new LinkedHashMap<>();
        ref.put("artifactId", artifactId);
        ref.put("artifactVersionId", version(bytes));
        return ref;
    }

    @SafeVarargs
    static Map<String, Object> scene(String id, String title, Map<String, Object> narration, Map<String, Object>... shots) {
        Map<String, Object> scene = new LinkedHashMap<>();
        scene.put("sceneId", id);
        scene.put("title", title);
        if (narration != null) scene.put("narration", narration);
        scene.put("shots", new ArrayList<>(List.of(shots)));
        return scene;
    }

    static Map<String, Object> board(List<Map<String, Object>> scenes, Map<String, Object> captions) {
        Map<String, Object> board = new LinkedHashMap<>();
        board.put("brief", new LinkedHashMap<>(Map.of("title", "Spring thaw", "text", "A short film about the thaw")));
        Map<String, Object> format = new LinkedHashMap<>();
        format.put("width", W);
        format.put("height", H);
        format.put("fps", FPS);
        board.put("format", format);
        if (captions != null) board.put("captions", captions);
        board.put("scenes", new ArrayList<>(scenes));
        return board;
    }

    static Map<String, Object> create(String requestId, Map<String, Object> board) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("storyboardId", requestId);
        body.putAll(board);
        return body;
    }

    static Map<String, Object> edit(String requestId, int expectedVersion, Map<String, Object> board) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("expectedVersion", expectedVersion);
        body.putAll(board);
        return body;
    }

    static Map<String, Object> render(String requestId, int version) {
        return Map.of("requestId", requestId, "storyboardVersion", version);
    }

    /** The owner's statement about the exact storyboard version document (it covers the authored animation content). */
    static String attestStoryboard(Host host, JsonNode version) throws Exception {
        return host.ownerPost("/dev/v1/rights/attestations", Map.of("artifactId", version.path("artifact").path("artifactId").asString(),
                "artifactVersionId", version.path("artifact").path("artifactVersionId").asString(), "statementKind", "MEDIA_RIGHTS",
                "scopes", List.of("PROCESSING"), "basis", "TEST: authored procedural animation in an automated test; a statement "
                        + "by a synthetic test principal, not a legal determination"), 201).path("attestationId").asString();
    }

    static String code(HttpResponse<String> response) throws Exception {
        return JSON.readTree(response.body()).path("error").path("code").asString();
    }

    static JsonNode details(HttpResponse<String> response) throws Exception {
        return JSON.readTree(response.body()).path("error").path("details");
    }

    static List<String> blockerCodes(JsonNode blockers) {
        List<String> codes = new ArrayList<>();
        blockers.forEach(blocker -> codes.add(blocker.path("code").asString() + "@" + blocker.path("shotId").asString("")
                + blocker.path("sceneId").asString("")));
        return codes;
    }

    /** Durable composite renders of the owner whose lineage names this storyboard version. */
    static int storyboardRenderRows(Host host, String storyboardId, int version) throws Exception {
        try (var connection = DriverManager.getConnection(host.postgres.getJdbcUrl(), host.postgres.getUsername(),
                host.postgres.getPassword());
             var statement = connection.prepareStatement("SELECT count(*) FROM media_artifacts WHERE tenant_id=? AND principal_id=? "
                     + "AND metadata_json LIKE ? AND metadata_json LIKE ? AND metadata_json LIKE ?")) {
            statement.setString(1, host.tenant);
            statement.setString(2, host.owner);
            statement.setString(3, "%media.dev.composite-render.v1%");
            statement.setString(4, "%\"storyboardId\":\"" + storyboardId + "\"%");
            statement.setString(5, "%\"storyboardVersion\":" + version + "%");
            try (var row = statement.executeQuery()) {
                row.next();
                return row.getInt(1);
            }
        }
    }

    // ---------------------------------------------------------------- review helpers

    static long caseRevision(Host host, String reviewCaseId, boolean owner) throws Exception {
        String path = "/dev/v1/reviews/" + reviewCaseId;
        HttpResponse<String> response = owner ? host.owner("GET", path, null) : host.other("GET", path, null);
        return JSON.readTree(response.body()).path("caseRevision").asLong();
    }

    static Map<String, Object> assignment(String requestId, long revision, String reviewer) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("expectedCaseRevision", revision);
        body.put("reviewerPrincipalId", reviewer);
        body.put("scopes", List.of("QUALITY", "APPROVAL"));
        body.put("expiresAt", Instant.now().plus(2, ChronoUnit.HOURS).truncatedTo(ChronoUnit.SECONDS).toString());
        return body;
    }

    static Map<String, Object> decision(String requestId, long revision, String decision, String scope) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("expectedCaseRevision", revision);
        body.put("decision", decision);
        body.put("reason", "TEST reviewer statement for " + decision + " (" + scope + "); not a human approval");
        body.put("confirmed", true);
        body.put("scope", scope);
        return body;
    }

    static byte[] utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }
}
