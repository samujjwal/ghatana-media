package com.ghatana.media.launcher;

import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * DEV_ONLY authored branching demonstration exported as a self-contained, sandboxed package (J-28
 * {@code media.dev.interactive-demo-player}). Nodes are stored video versions (with optional WebVTT captions) and edges are
 * labelled choices. The package is ONE immutable artifact: a JSON bundle (the artifact store admits no ZIP signature) from
 * which {@code GET .../package.zip} serves the deterministic ZIP. The ZIP holds {@code index.html} (strict
 * Content-Security-Policy: no network beyond the package itself, scripts and media only from the package), a vanilla
 * {@code player.js}, the manifest, and every asset content-addressed by SHA-256 ({@code assets/<sha256>.<ext>},
 * {@code captions/<sha256>.vtt}). The player checks each digest before a scene can play and refuses a stale asset, a
 * caption written for another version of the video, or an off-package path with a visible typed message.
 *
 * <p>Truth labelling is decided here, not by the author alone: a scene is {@code LIVE} only when its video is an output
 * registered by one of this runtime's lanes (its lineage carries a {@code ...Schema} key); an uploaded file is
 * {@code CURATED}. A demonstration may claim {@code LIVE} only when every scene is live; otherwise it must be
 * {@code CURATED} with a curation note, and the player says so.</p>
 *
 * <p>Refusals: invalid graph 422 with the JSON path; every source needs a current PROCESSING admission (403, with the
 * path), an unknown or foreign-tenant source is 404; a caption whose lineage names a different video version is 422.
 * The durable request ledger gives replay (200) and request-id reuse (409).</p>
 */
final class MediaDevInteractiveDemoRuntime {
    static final String SCHEMA = "media.dev.interactive-demo.v1";
    static final String KIND = "INTERACTIVE_DEMO_PACKAGE";
    static final String LANE = "demo.package";
    static final String BUNDLE_SCHEMA = "media.dev.interactive-demo-package.v1";
    static final int MAX_VIDEO_BYTES = 24 * 1024 * 1024;
    static final int MAX_TOTAL_BYTES = 48 * 1024 * 1024;
    static final int MAX_CAPTION_BYTES = 512 * 1024;
    private static final Duration TOOL_TIMEOUT = Duration.ofMinutes(4);
    private static final Set<String> VIDEO_CODECS = Set.of("vp8", "vp9", "av1", "h264", "theora");
    private static final Set<String> AUDIO_CODECS = Set.of("opus", "vorbis", "aac", "mp3", "flac");
    private static final Map<String, String> EXTENSIONS = Map.of("video/webm", "webm", "video/mp4", "mp4", "video/ogg", "ogv");
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final List<String> LINEAGE_KEYS = List.of("videoSchema", "scope", "kind", "requestId", "sources",
            "parent", "demo", "package", "rightsDecision", "rightsDecisions", "tools", "resultSha256", "claims");

    record NodeSpec(String id, String label, MediaDevVideoRuntime.SourceRef video, MediaDevVideoRuntime.SourceRef captions,
                    String captionLanguage, List<MediaDevDemoGraph.Choice> choices) { }

    record DemoRequest(String requestId, String title, String startNodeId, String truthKind, String curationNote,
                       List<NodeSpec> nodes) {
        DemoRequest {
            requestId = MediaDevVideoRuntime.boundedId(requestId);
            nodes = nodes == null ? List.of() : List.copyOf(nodes);
        }
    }

    private final MediaDevVideoRuntime video;
    private final MediaRuntime runtime;

    MediaDevInteractiveDemoRuntime(MediaRuntime runtime, MediaDevVideoRuntime video) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.video = Objects.requireNonNull(video, "video");
    }

    Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("scope", "DEV_ONLY");
        out.put("package", Map.of("format", "zip", "entry", "index.html", "assets", "content-addressed SHA-256",
                "csp", "default-src 'none'; script-src 'self'; media-src blob:; connect-src 'self'",
                "player", "vanilla JavaScript, no network beyond the package"));
        out.put("graph", Map.of("maxNodes", MediaDevDemoGraph.MAX_NODES, "maxChoicesPerNode", MediaDevDemoGraph.MAX_CHOICES,
                "cycles", "allowed only while an ending stays reachable"));
        out.put("truth", Map.of("kinds", List.of("LIVE", "CURATED"),
                "rule", "LIVE only when every scene video is an output registered by this runtime"));
        out.put("videoCodecs", new java.util.TreeSet<>(VIDEO_CODECS));
        return out;
    }

    // ------------------------------------------------------------------ create

    MediaDevVideoRuntime.VideoResult create(String tenantId, String principalId, DemoRequest request) {
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "interactive_demo", tenantId,
                () -> createAdmitted(tenantId, principalId, request));
    }

    private MediaDevVideoRuntime.VideoResult createAdmitted(String tenantId, String principalId, DemoRequest request) {
        // 1. structure first: nothing is looked up for a graph that cannot work
        if (request.title() == null || request.title().isBlank() || request.title().length() > 120
                || request.title().chars().anyMatch(Character::isISOControl)) {
            throw new MediaDevDemoGraph.GraphException("TITLE_INVALID", "title", "a title is 1-120 printable characters");
        }
        List<MediaDevDemoGraph.Node> graph = request.nodes().stream()
                .map(node -> new MediaDevDemoGraph.Node(node.id(), node.label(), node.choices())).toList();
        MediaDevDemoGraph.validate(request.startNodeId(), graph);
        if (!"LIVE".equals(request.truthKind()) && !"CURATED".equals(request.truthKind())) {
            throw new MediaDevDemoGraph.GraphException("SOURCE_TRUTH_INVALID", "sourceTruth.kind",
                    "sourceTruth.kind must be LIVE or CURATED");
        }
        if ("CURATED".equals(request.truthKind())) {
            String note = request.curationNote() == null ? "" : request.curationNote().trim();
            if (note.length() < 8 || note.length() > 400 || note.chars().anyMatch(Character::isISOControl)) {
                throw new MediaDevDemoGraph.GraphException("CURATION_NOTE_REQUIRED", "sourceTruth.curationNote",
                        "a curated demonstration needs a curation note of 8-400 characters saying who assembled it");
            }
        } else if (request.curationNote() != null) {
            throw new MediaDevDemoGraph.GraphException("CURATION_NOTE_NOT_ALLOWED", "sourceTruth.curationNote",
                    "a live demonstration carries no curation note");
        }
        for (int i = 0; i < request.nodes().size(); i++) {
            NodeSpec node = request.nodes().get(i);
            if (node.video() == null) {
                throw new MediaDevDemoGraph.GraphException("VIDEO_REQUIRED", "nodes[" + i + "].video", "every node needs a video");
            }
            if (node.captions() != null && (node.captionLanguage() == null
                    || !node.captionLanguage().matches("[a-z]{2,3}(-[A-Za-z0-9]{2,8})*"))) {
                throw new MediaDevDemoGraph.GraphException("CAPTION_LANGUAGE_INVALID", "nodes[" + i + "].captions.language",
                        "captions need a BCP 47 language tag");
            }
        }
        // 2. exact versions (404) and rights (403), in node order
        List<Resolved> resolved = new ArrayList<>();
        List<Resolution> resolutions = new ArrayList<>();
        for (int i = 0; i < request.nodes().size(); i++) {
            NodeSpec node = request.nodes().get(i);
            MediaArtifact videoArtifact = exact(tenantId, principalId, node.video(), "nodes[" + i + "].video");
            resolutions.add(admit(tenantId, videoArtifact, "nodes[" + i + "].video"));
            if (!videoArtifact.contentType().toLowerCase(Locale.ROOT).startsWith("video/")
                    || !EXTENSIONS.containsKey(videoArtifact.contentType().toLowerCase(Locale.ROOT))) {
                throw refused(422, "SOURCE_FORMAT_NOT_SUPPORTED", "a scene video must be video/webm, video/mp4 or video/ogg",
                        Map.of("path", "nodes[" + i + "].video", "contentType", videoArtifact.contentType()));
            }
            MediaArtifact captionArtifact = null;
            if (node.captions() != null) {
                captionArtifact = exact(tenantId, principalId, node.captions(), "nodes[" + i + "].captions");
                resolutions.add(admit(tenantId, captionArtifact, "nodes[" + i + "].captions"));
                if (!captionArtifact.contentType().toLowerCase(Locale.ROOT).startsWith("text/vtt")) {
                    throw refused(422, "CAPTION_FORMAT_NOT_SUPPORTED", "captions must be a text/vtt artifact version",
                            Map.of("path", "nodes[" + i + "].captions"));
                }
                requireCaptionBinding(captionArtifact, videoArtifact, "nodes[" + i + "].captions");
            }
            resolved.add(new Resolved(videoArtifact, captionArtifact));
        }
        // 3. truth is computed from the sources, not trusted from the author
        if ("LIVE".equals(request.truthKind())) {
            List<String> notLive = new ArrayList<>();
            for (int i = 0; i < resolved.size(); i++) {
                if (!isLive(resolved.get(i).video())) notLive.add("nodes[" + i + "].video");
            }
            if (!notLive.isEmpty()) {
                throw refused(422, "SOURCE_TRUTH_NOT_LIVE",
                        "a LIVE demonstration needs every scene video to be an output registered by this runtime; "
                                + "mark it CURATED instead", Map.of("path", "sourceTruth.kind", "notLive", notLive));
            }
        }
        long total = 0;
        for (Resolved item : resolved) {
            if (item.video().sizeBytes() > MAX_VIDEO_BYTES) {
                throw refused(422, "VIDEO_LIMIT_EXCEEDED", "a scene video exceeds " + MAX_VIDEO_BYTES + " bytes", Map.of());
            }
            total += item.video().sizeBytes();
        }
        if (total > MAX_TOTAL_BYTES) throw refused(422, "VIDEO_LIMIT_EXCEEDED", "the scenes exceed the package byte ceiling", Map.of());

        List<Object> parts = new ArrayList<>(List.of("media.dev.interactive-demo.create.v1", request.title(),
                request.startNodeId(), request.truthKind(), String.valueOf(request.curationNote())));
        for (int i = 0; i < request.nodes().size(); i++) {
            NodeSpec node = request.nodes().get(i);
            parts.add(node.id() + "|" + node.label() + "|" + resolved.get(i).video().version().value() + "|"
                    + resolved.get(i).video().sha256() + "|"
                    + (resolved.get(i).captions() == null ? "-" : resolved.get(i).captions().version().value() + "|"
                    + resolved.get(i).captions().sha256() + "|" + node.captionLanguage()));
            for (MediaDevDemoGraph.Choice choice : node.choices()) parts.add("  " + choice.id() + "|" + choice.label() + "|" + choice.to());
        }
        String fingerprint = MediaDevRequestLedger.fingerprint(SCHEMA, parts.toArray());
        Resolution headline = resolutions.getFirst();
        return video.requestLedger().run(tenantId, principalId, LANE, request.requestId(), fingerprint,
                outputs -> replay(tenantId, principalId, outputs, headline),
                () -> produce(tenantId, principalId, request, resolved, resolutions),
                result -> List.of(new OutputRef("package", result.artifact().artifactId(), result.artifact().version().value())),
                MediaDevVideoRuntime.VideoRequestReusedException::new);
    }

    private record Resolved(MediaArtifact video, MediaArtifact captions) { }

    private MediaArtifact exact(String tenantId, String principalId, MediaDevVideoRuntime.SourceRef ref, String path) {
        try {
            return video.source(tenantId, principalId, ref.artifactId(), ref.artifactVersionId());
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException missing) {
            throw refused(404, "SOURCE_VERSION_NOT_FOUND",
                    "the exact source artifact version is not available to this DEV_ONLY principal",
                    Map.of("path", path));
        }
    }

    private Resolution admit(String tenantId, MediaArtifact artifact, String path) {
        try {
            return video.admit(tenantId, artifact);
        } catch (MediaDevVideoRuntime.VideoRightsNotAdmittedException denied) {
            boolean unavailable = "RIGHTS_AUTHORITY_UNAVAILABLE".equals(denied.code());
            throw refused(unavailable ? 503 : 403, denied.code(),
                    "a source version has no current PROCESSING rights and consent admission; nothing was packaged",
                    Map.of("path", path, "scope", "PROCESSING", "verdict", denied.resolution().verdict().name(),
                            "artifactId", denied.artifactId(),
                            "reasons", denied.resolution().reasons().stream().map(Enum::name).sorted().toList()));
        }
    }

    /** A caption whose lineage names a different video version (or video) than the scene's is stale for this scene. */
    static void requireCaptionBinding(MediaArtifact caption, MediaArtifact scene, String path) {
        if (caption.metadata().get("source") instanceof Map<?, ?> source && source.get("artifactId") instanceof String id) {
            Object version = source.get("artifactVersionId");
            if (!id.equals(scene.artifactId()) || (version instanceof String v && !v.equals(scene.version().value()))) {
                throw refused(422, "CAPTION_VERSION_MISMATCH",
                        "the captions were written for a different video version than the one used by this scene",
                        Map.of("path", path, "captionSource", Map.of("artifactId", id,
                                "artifactVersionId", String.valueOf(version)),
                                "sceneVideo", Map.of("artifactId", scene.artifactId(),
                                        "artifactVersionId", scene.version().value())));
            }
        }
    }

    static boolean isLive(MediaArtifact artifact) {
        for (var entry : artifact.metadata().entrySet()) {
            if (entry.getKey().endsWith("Schema") && entry.getValue() instanceof String schema && schema.startsWith("media.dev.")) {
                return true;
            }
        }
        return false;
    }

    // ------------------------------------------------------------------ production

    private MediaDevVideoRuntime.VideoResult replay(String tenantId, String principalId, List<OutputRef> outputs,
                                                    Resolution headline) {
        OutputRef ref = outputs.getFirst();
        return find(tenantId, principalId, ref.artifactId())
                .filter(found -> found.artifact().version().value().equals(ref.versionId()))
                .map(found -> new MediaDevVideoRuntime.VideoResult(found.artifact(), found.lineage(), true, headline))
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(LANE));
    }

    private MediaDevVideoRuntime.VideoResult produce(String tenantId, String principalId, DemoRequest request,
                                                     List<Resolved> resolved, List<Resolution> resolutions) {
        Path dir = MediaDevVideoRuntime.privateTempDirectory();
        try {
            Map<String, byte[]> files = new TreeMap<>();
            Map<String, Long> durations = new java.util.HashMap<>();
            List<Map<String, Object>> manifestNodes = new ArrayList<>();
            List<Map<String, Object>> sources = new ArrayList<>();
            int counter = 0;
            for (int i = 0; i < request.nodes().size(); i++) {
                NodeSpec spec = request.nodes().get(i);
                Resolved item = resolved.get(i);
                String key = item.video().artifactId() + "@" + item.video().version().value();
                Path staged = dir.resolve("v" + (counter++) + ".bin");
                video.stage(tenantId, principalId, item.video(), staged);
                byte[] videoBytes = Files.readAllBytes(staged);
                String videoSha = MediaDevProjectRenderRuntime.sha256Hex(videoBytes);
                if (!videoSha.equals(item.video().sha256())) {
                    throw refused(422, "SOURCE_DIGEST_MISMATCH", "the stored video bytes do not match their recorded digest",
                            Map.of("path", "nodes[" + i + "].video"));
                }
                Long durationMs = durations.get(key);
                if (durationMs == null) {
                    durationMs = checkVideo(staged, dir, "nodes[" + i + "].video");
                    durations.put(key, durationMs);
                }
                String extension = EXTENSIONS.get(item.video().contentType().toLowerCase(Locale.ROOT));
                String assetPath = "assets/" + videoSha + "." + extension;
                files.put(assetPath, videoBytes);

                Map<String, Object> node = new LinkedHashMap<>();
                node.put("id", spec.id());
                node.put("label", spec.label().trim());
                node.put("origin", isLive(item.video()) ? "LIVE" : "CURATED");
                node.put("durationMs", durationMs);
                Map<String, Object> videoView = new LinkedHashMap<>();
                videoView.put("path", assetPath);
                videoView.put("sha256", videoSha);
                videoView.put("contentType", item.video().contentType());
                videoView.put("sizeBytes", videoBytes.length);
                videoView.put("artifactId", item.video().artifactId());
                videoView.put("artifactVersionId", item.video().version().value());
                node.put("video", videoView);
                sources.add(sourceView("nodes[" + i + "].video", item.video()));
                if (item.captions() != null) {
                    Path captionFile = dir.resolve("c" + (counter++) + ".vtt");
                    video.stage(tenantId, principalId, item.captions(), captionFile);
                    if (Files.size(captionFile) > MAX_CAPTION_BYTES) {
                        throw refused(422, "CAPTION_LIMIT_EXCEEDED", "the captions exceed the byte ceiling",
                                Map.of("path", "nodes[" + i + "].captions"));
                    }
                    byte[] captionBytes = Files.readAllBytes(captionFile);
                    List<MediaDevWebVtt.Cue> cues;
                    try {
                        cues = MediaDevWebVtt.parse(captionBytes);
                    } catch (MediaDevWebVtt.WebVttException malformed) {
                        throw refused(422, "CAPTION_INVALID", "the captions are not a well-formed WebVTT document",
                                Map.of("path", "nodes[" + i + "].captions"));
                    }
                    for (MediaDevWebVtt.Cue cue : cues) {
                        if (cue.endMillis() > durationMs + 50) {
                            throw refused(422, "CAPTION_BEYOND_VIDEO", "a caption cue ends after the scene video does",
                                    Map.of("path", "nodes[" + i + "].captions", "cueEndMillis", cue.endMillis(),
                                            "videoDurationMillis", durationMs));
                        }
                    }
                    String captionSha = MediaDevProjectRenderRuntime.sha256Hex(captionBytes);
                    String captionPath = "captions/" + captionSha + ".vtt";
                    files.put(captionPath, captionBytes);
                    Map<String, Object> captionView = new LinkedHashMap<>();
                    captionView.put("path", captionPath);
                    captionView.put("sha256", captionSha);
                    captionView.put("language", spec.captionLanguage());
                    captionView.put("forVideoSha256", videoSha);
                    captionView.put("artifactId", item.captions().artifactId());
                    captionView.put("artifactVersionId", item.captions().version().value());
                    captionView.put("binding", item.captions().metadata().get("source") instanceof Map
                            ? "LINEAGE_VERIFIED" : "AUTHOR_DECLARED");
                    node.put("captions", captionView);
                    sources.add(sourceView("nodes[" + i + "].captions", item.captions()));
                } else {
                    node.put("captions", null);
                }
                List<Map<String, Object>> choices = new ArrayList<>();
                for (MediaDevDemoGraph.Choice choice : spec.choices()) {
                    Map<String, Object> view = new LinkedHashMap<>();
                    view.put("id", choice.id());
                    view.put("label", choice.label().trim());
                    view.put("to", choice.to());
                    choices.add(view);
                }
                node.put("choices", choices);
                manifestNodes.add(node);
            }
            Map<String, Object> truth = new LinkedHashMap<>();
            truth.put("kind", request.truthKind());
            if ("CURATED".equals(request.truthKind())) truth.put("curationNote", request.curationNote().trim());
            truth.put("rule", "LIVE only when every scene video is an output registered by this Media runtime");
            Map<String, Object> manifest = new LinkedHashMap<>();
            manifest.put("schema", SCHEMA);
            manifest.put("scope", "DEV_ONLY");
            manifest.put("requestId", request.requestId());
            manifest.put("title", request.title().trim());
            manifest.put("startNodeId", request.startNodeId());
            manifest.put("sourceTruth", truth);
            manifest.put("nodes", manifestNodes);
            byte[] manifestJson = JSON.writeValueAsBytes(manifest);
            byte[] player = resource("player.js");
            byte[] css = resource("player.css");
            String html = new String(resource("index.html"), StandardCharsets.UTF_8)
                    .replace("__TITLE__", escapeHtml(request.title().trim()))
                    .replace("__MANIFEST__", escapeJsonForScript(new String(manifestJson, StandardCharsets.UTF_8)));
            files.put("index.html", html.getBytes(StandardCharsets.UTF_8));
            files.put("player.js", player);
            files.put("player.css", css);
            files.put("manifest.json", manifestJson);
            byte[] zip = zip(files);
            byte[] bundle = bundle(files);

            Map<String, Object> lineage = MediaDevVideoRuntime.baseLineage(SCHEMA, KIND, request.requestId(),
                    resolutions.getFirst(), bundle);
            lineage.put("sources", sources);
            lineage.put("parent", sources.getFirst());
            Map<String, Object> demo = new LinkedHashMap<>();
            demo.put("title", request.title().trim());
            demo.put("startNodeId", request.startNodeId());
            demo.put("sourceTruth", truth);
            demo.put("nodeCount", manifestNodes.size());
            demo.put("choiceCount", manifestNodes.stream().mapToInt(n -> ((List<?>) n.get("choices")).size()).sum());
            demo.put("manifestSha256", MediaDevProjectRenderRuntime.sha256Hex(manifestJson));
            demo.put("nodes", manifestNodes);
            lineage.put("demo", demo);
            Map<String, Object> pkg = new LinkedHashMap<>();
            pkg.put("format", "json-bundle (zip served from it)");
            pkg.put("bundleSchema", BUNDLE_SCHEMA);
            pkg.put("zipSha256", MediaDevProjectRenderRuntime.sha256Hex(zip));
            pkg.put("zipSizeBytes", zip.length);
            pkg.put("entry", "index.html");
            pkg.put("playerJsSha256", MediaDevProjectRenderRuntime.sha256Hex(player));
            pkg.put("playerCssSha256", MediaDevProjectRenderRuntime.sha256Hex(css));
            pkg.put("contentSecurityPolicy", "default-src 'none'; script-src 'self'; style-src 'self'; media-src blob:; "
                    + "connect-src 'self'; img-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; "
                    + "worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'");
            pkg.put("files", new TreeMap<>(files.entrySet().stream().collect(java.util.stream.Collectors.toMap(
                    Map.Entry::getKey, entry -> MediaDevProjectRenderRuntime.sha256Hex(entry.getValue())))));
            lineage.put("package", pkg);
            List<Map<String, Object>> decisions = new ArrayList<>();
            for (Resolution resolution : resolutions) {
                decisions.add(Map.of("verdict", resolution.verdict().name(), "attestationIds",
                        resolution.attestationIds().stream().sorted().toList()));
            }
            lineage.put("rightsDecisions", decisions);
            lineage.put("tools", Map.of("ffmpeg", video.ffmpegVersion()));
            lineage.put("claims", Map.of("truth", request.truthKind(), "note",
                    "DEV_ONLY authored branching demonstration; the labels say whether scenes are runtime output or "
                            + "uploaded media. No quality, rights, approval or production claim."));
            return video.register(tenantId, principalId, "interactive-demo-" + MediaDevVideoRuntime.shortHash(request.requestId())
                    + ".json", "application/json", KIND, request.requestId(), bundle, lineage, resolutions.getFirst());
        } catch (IOException failure) {
            throw new MediaDevVideoRuntime.VideoRefusedException(503, "VIDEO_TOOLS_UNAVAILABLE",
                    "the video tools could not be run; nothing was registered");
        } finally {
            MediaDevVideoRuntime.deleteTree(dir);
        }
    }

    private static Map<String, Object> sourceView(String path, MediaArtifact artifact) {
        Map<String, Object> view = new LinkedHashMap<>(MediaDevVideoRuntime.sourceRef(artifact));
        view.put("path", path);
        return view;
    }

    /** Decodes the whole video, checks browser-playable codecs and returns its duration in milliseconds. */
    private long checkVideo(Path file, Path dir, String path) throws IOException {
        MediaDevVideoRuntime.Probe probe = video.probe(file, dir, 1920L * 1080L, 3_600,
                BoundedProcessRunner.CancellationToken.NEVER);
        BoundedProcessRunner.Result codecs = video.runProcess(List.of(video.ffprobePath().toString(), "-v", "error",
                "-show_entries", "stream=codec_type,codec_name", "-of", "json", file.toString()), dir, TOOL_TIMEOUT,
                64 * 1024, null, 0, "probe", BoundedProcessRunner.CancellationToken.NEVER);
        if (!codecs.succeeded()) throw refused(422, "SOURCE_VIDEO_CORRUPT", "the video could not be probed", Map.of("path", path));
        JsonNode streams = JSON.readTree(new String(codecs.stdout(), StandardCharsets.UTF_8)).path("streams");
        for (JsonNode stream : streams) {
            String type = stream.path("codec_type").asString("");
            String codec = stream.path("codec_name").asString("");
            if (("video".equals(type) && !VIDEO_CODECS.contains(codec)) || ("audio".equals(type) && !AUDIO_CODECS.contains(codec))) {
                throw refused(422, "SOURCE_CODEC_NOT_BROWSER_PLAYABLE", "the " + type + " codec " + codec
                        + " is not one a browser plays from a package", Map.of("path", path, "codec", codec));
            }
        }
        BoundedProcessRunner.Result decoded = video.runProcess(List.of(video.ffmpegPath().toString(), "-nostdin",
                "-hide_banner", "-v", "error", "-xerror", "-i", file.toString(), "-f", "null", "-"), dir, TOOL_TIMEOUT,
                4096, null, 0, "decode", BoundedProcessRunner.CancellationToken.NEVER);
        if (!decoded.succeeded()) {
            if (decoded.end() != BoundedProcessRunner.End.EXITED || decoded.exitCode() >= 128) {
                throw new MediaDevVideoRuntime.VideoOutcomeUnknownException("decode");
            }
            throw refused(422, "SOURCE_VIDEO_UNDECODABLE", "the video does not decode cleanly", Map.of("path", path));
        }
        return Math.max(1L, Math.round(probe.durationMicros / 1000.0));
    }

    // ------------------------------------------------------------------ packaging helpers

    private static byte[] resource(String name) throws IOException {
        try (InputStream in = MediaDevInteractiveDemoRuntime.class.getResourceAsStream("/media-dev/interactive-demo/" + name)) {
            if (in == null) throw new IOException("missing player resource " + name);
            return in.readAllBytes();
        }
    }

    private static final Set<String> TEXT_EXTENSIONS = Set.of("html", "js", "css", "json", "vtt");

    /** The stored form: every file with its digest, text as UTF-8 and media as base64, sorted by path. */
    static byte[] bundle(Map<String, byte[]> files) {
        List<Map<String, Object>> entries = new ArrayList<>();
        for (Map.Entry<String, byte[]> file : new TreeMap<>(files).entrySet()) {
            String path = file.getKey();
            boolean text = TEXT_EXTENSIONS.contains(path.substring(path.lastIndexOf('.') + 1));
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("path", path);
            entry.put("sha256", MediaDevProjectRenderRuntime.sha256Hex(file.getValue()));
            entry.put("sizeBytes", file.getValue().length);
            entry.put("encoding", text ? "utf8" : "base64");
            entry.put("content", text ? new String(file.getValue(), StandardCharsets.UTF_8)
                    : java.util.Base64.getEncoder().encodeToString(file.getValue()));
            entries.add(entry);
        }
        Map<String, Object> document = new LinkedHashMap<>();
        document.put("schema", BUNDLE_SCHEMA);
        document.put("scope", "DEV_ONLY");
        document.put("entry", "index.html");
        document.put("files", entries);
        return JSON.writeValueAsBytes(document);
    }

    /** Decodes a stored bundle, verifying every file against its recorded digest. */
    static Map<String, byte[]> unbundle(byte[] bundle) {
        JsonNode document = JSON.readTree(bundle);
        if (!BUNDLE_SCHEMA.equals(document.path("schema").asString(""))) {
            throw refused(422, "DEMO_PACKAGE_INVALID", "the artifact is not an interactive demonstration package", Map.of());
        }
        Map<String, byte[]> files = new TreeMap<>();
        for (JsonNode entry : document.path("files")) {
            byte[] bytes = "base64".equals(entry.path("encoding").asString())
                    ? java.util.Base64.getDecoder().decode(entry.path("content").asString())
                    : entry.path("content").asString().getBytes(StandardCharsets.UTF_8);
            if (!MediaDevProjectRenderRuntime.sha256Hex(bytes).equals(entry.path("sha256").asString())) {
                throw refused(422, "DEMO_PACKAGE_DIGEST_MISMATCH", "a packaged file does not match its recorded digest",
                        Map.of("path", entry.path("path").asString()));
            }
            files.put(entry.path("path").asString(), bytes);
        }
        return files;
    }

    /** The package ZIP rebuilt (deterministically) from the stored bundle of an owner-visible demonstration. */
    Optional<byte[]> packageZip(String tenantId, String principalId, String artifactId) throws IOException {
        Optional<MediaDevVideoRuntime.VideoResult> found = reopen(tenantId, principalId, artifactId);
        if (found.isEmpty()) return Optional.empty();
        Path dir = MediaDevVideoRuntime.privateTempDirectory();
        try {
            Path staged = dir.resolve("bundle.json");
            video.stage(tenantId, principalId, found.get().artifact(), staged);
            return Optional.of(zip(unbundle(Files.readAllBytes(staged))));
        } finally {
            MediaDevVideoRuntime.deleteTree(dir);
        }
    }

    /** Deterministic ZIP: sorted entries, fixed timestamps, no extra fields. */
    static byte[] zip(Map<String, byte[]> files) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(out)) {
            zip.setLevel(6);
            for (Map.Entry<String, byte[]> file : new TreeMap<>(files).entrySet()) {
                ZipEntry entry = new ZipEntry(file.getKey());
                entry.setTimeLocal(LocalDateTime.of(1980, 1, 1, 0, 0, 0));
                CRC32 crc = new CRC32();
                crc.update(file.getValue());
                entry.setCrc(crc.getValue());
                zip.putNextEntry(entry);
                zip.write(file.getValue());
                zip.closeEntry();
            }
        }
        return out.toByteArray();
    }

    static String escapeJsonForScript(String json) {
        return json.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
                .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
    }

    static String escapeHtml(String text) {
        return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }

    // ------------------------------------------------------------------ readback

    private Optional<MediaDevVideoRuntime.VideoResult> find(String tenantId, String principalId, String artifactId) {
        return runtime.artifact(tenantId, principalId, artifactId)
                .filter(artifact -> SCHEMA.equals(artifact.metadata().get("videoSchema")))
                .map(artifact -> {
                    Map<String, Object> lineage = new LinkedHashMap<>();
                    for (String key : LINEAGE_KEYS) {
                        if (artifact.metadata().containsKey(key)) lineage.put(key, artifact.metadata().get(key));
                    }
                    return new MediaDevVideoRuntime.VideoResult(artifact, lineage, true, null);
                });
    }

    /** Reopens a package for its owner; every named source is re-admitted (a revoked source refuses the readback). */
    Optional<MediaDevVideoRuntime.VideoResult> reopen(String tenantId, String principalId, String artifactId) {
        Optional<MediaDevVideoRuntime.VideoResult> found = find(tenantId, principalId, artifactId);
        if (found.isEmpty()) return found;
        Resolution headline = null;
        if (found.get().lineage().get("sources") instanceof List<?> sources) {
            for (Object entry : sources) {
                if (entry instanceof Map<?, ?> ref && ref.get("artifactId") instanceof String id
                        && ref.get("artifactVersionId") instanceof String version) {
                    String path = String.valueOf(ref.get("path"));
                    Resolution resolution = admit(tenantId, exact(tenantId, principalId,
                            new MediaDevVideoRuntime.SourceRef(id, version), path), path);
                    if (headline == null) headline = resolution;
                }
            }
        }
        return Optional.of(new MediaDevVideoRuntime.VideoResult(found.get().artifact(), found.get().lineage(), true, headline));
    }

    private static MediaDevVideoRuntime.VideoRefusedException refused(int status, String code, String message,
                                                                      Map<String, Object> details) {
        return new MediaDevVideoRuntime.VideoRefusedException(status, code, message, details);
    }
}
