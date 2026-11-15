package com.ghatana.media.launcher;

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
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DEV_ONLY translation and dubbing routes (outside the canonical manifest/OpenAPI):
 * {@code GET /dev/v1/translations/capabilities}, {@code POST /dev/v1/translations},
 * {@code POST /dev/v1/translations/revisions}, {@code GET /dev/v1/translations/{artifactId}},
 * {@code POST /dev/v1/dubs} and {@code GET /dev/v1/dubs/{timingArtifactId}}. Every response is labelled DEV_ONLY.
 */
final class MediaDevDubRoutes {
    static final String CAPABILITIES = "/dev/v1/translations/capabilities";
    static final String TRANSLATIONS = "/dev/v1/translations";
    static final String REVISIONS = "/dev/v1/translations/revisions";
    static final String DUBS = "/dev/v1/dubs";
    private static final Pattern TRANSLATION = Pattern.compile("^/dev/v1/translations/([^/]+)$");
    private static final Pattern DUB = Pattern.compile("^/dev/v1/dubs/([^/]+)$");
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();
    private static final String NOTE = "DEV_ONLY local translation and stock-voice dubbing; unreviewed, not a production, "
            + "quality, lip-sync or approval claim";

    private final MediaDevTranslationRuntime translations;
    private final MediaDevDubbingRuntime dubbing;
    private final MediaRuntime runtime;

    MediaDevDubRoutes(MediaDevTranslationRuntime translations, MediaDevDubbingRuntime dubbing, MediaRuntime runtime) {
        this.translations = translations;
        this.dubbing = dubbing;
        this.runtime = runtime;
    }

    static boolean handles(String path) {
        return path.equals(TRANSLATIONS) || path.startsWith(TRANSLATIONS + "/") || path.equals(DUBS)
                || path.startsWith(DUBS + "/");
    }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId, int maxBody,
                MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        try {
            dispatch(exchange, path, method, tenantId, principalId, maxBody, out);
        } catch (MediaDevRenderAdmission.CapacityExhaustedException failure) {
            out.error(exchange, 429, MediaDevRenderAdmission.CAPACITY_CODE,
                    "DEV_ONLY translation and dubbing capacity is exhausted; retry the same requestId after the "
                            + "Retry-After delay", Map.of("scope", failure.scope()));
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException failure) {
            runtime.recordDeniedRequest();
            out.error(exchange, 404, "SOURCE_VERSION_NOT_FOUND",
                    "The exact source artifact version is not available to this DEV_ONLY principal", Map.of());
        } catch (MediaDevSpeechRuntime.SpeechRefusedException failure) {
            if (failure.status() == 403) runtime.recordDeniedRequest();
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevRequestLedger.LedgerRefusedException failure) {
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevSpeechRuntime.SpeechRequestReusedException failure) {
            out.error(exchange, 409, "REQUEST_ID_REUSED", "requestId was already used with a different request", Map.of());
        } catch (MediaDevSpeechRuntime.SpeechRegistrationFailedException failure) {
            out.error(exchange, 502, "OUTPUT_REGISTRATION_FAILED",
                    "Output was not registered; retry with the same requestId to resume", Map.of());
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
        if (CAPABILITIES.equals(path)) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("schema", MediaDevTranslationRuntime.SCHEMA);
            view.put("scope", "DEV_ONLY");
            view.put("translation", translations.capabilities());
            view.put("dubbing", dubbing.capabilities());
            out.json(exchange, 200, view);
            return;
        }
        if (TRANSLATIONS.equals(path) || REVISIONS.equals(path) || DUBS.equals(path)) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!permitted(exchange, true, out)) return;
            Map<String, Object> body = body(exchange, maxBody);
            if (TRANSLATIONS.equals(path)) {
                requireKeys(body, Set.of("requestId", "transcriptArtifactId", "transcriptArtifactVersionId",
                        "sourceLanguage", "targetLanguage"), Set.of(), "translation request");
                var translation = translations.translate(tenantId, principalId,
                        new MediaDevTranslationRuntime.TranslateRequest(string(body.get("requestId"), "requestId"),
                                string(body.get("transcriptArtifactId"), "transcriptArtifactId"),
                                string(body.get("transcriptArtifactVersionId"), "transcriptArtifactVersionId"),
                                string(body.get("sourceLanguage"), "sourceLanguage"),
                                string(body.get("targetLanguage"), "targetLanguage")));
                out.json(exchange, translation.output().replayed() ? 200 : 201, translationView(translation));
            } else if (REVISIONS.equals(path)) {
                requireKeys(body, Set.of("requestId", "baseArtifactId", "baseArtifactVersionId", "segments"), Set.of(),
                        "translation revision request");
                var translation = translations.revise(tenantId, principalId,
                        new MediaDevTranslationRuntime.ReviseRequest(string(body.get("requestId"), "requestId"),
                                string(body.get("baseArtifactId"), "baseArtifactId"),
                                string(body.get("baseArtifactVersionId"), "baseArtifactVersionId"),
                                segmentTexts(body.get("segments"))));
                out.json(exchange, translation.output().replayed() ? 200 : 201, translationView(translation));
            } else {
                requireKeys(body, Set.of("requestId", "translatedArtifactId", "translatedArtifactVersionId"),
                        Set.of("voice", "overflowPolicy", "voiceReference", "likenessReference"), "dub request");
                var dub = dubbing.dub(tenantId, principalId, new MediaDevDubbingRuntime.DubRequest(
                        string(body.get("requestId"), "requestId"),
                        string(body.get("translatedArtifactId"), "translatedArtifactId"),
                        string(body.get("translatedArtifactVersionId"), "translatedArtifactVersionId"),
                        body.get("voice") == null ? null : string(body.get("voice"), "voice"),
                        policy(body.get("overflowPolicy")),
                        reference(body.get("voiceReference"), "voiceReference"),
                        reference(body.get("likenessReference"), "likenessReference")));
                out.json(exchange, dub.replayed() ? 200 : 201, dubView(dub));
            }
            return;
        }
        Matcher translation = TRANSLATION.matcher(path);
        Matcher dub = DUB.matcher(path);
        if (translation.matches() || dub.matches()) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            if (!permitted(exchange, false, out)) return;
            if (translation.matches()) {
                var found = translations.reopen(tenantId, principalId, pathSegment(translation.group(1)));
                if (found.isEmpty()) {
                    out.error(exchange, 404, "TRANSLATION_NOT_FOUND",
                            "Translation is not available in this tenant and owner scope", Map.of());
                    return;
                }
                out.json(exchange, 200, translationView(found.get()));
            } else {
                var found = dubbing.reopen(tenantId, principalId, pathSegment(dub.group(1)));
                if (found.isEmpty()) {
                    out.error(exchange, 404, "DUB_NOT_FOUND",
                            "Dub is not available in this tenant and owner scope", Map.of());
                    return;
                }
                out.json(exchange, 200, dubView(found.get()));
            }
            return;
        }
        out.error(exchange, 404, "NOT_FOUND", "Translation or dubbing route not found", Map.of());
    }

    private static Map<String, Object> translationView(MediaDevTranslationRuntime.Translation translation) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", MediaDevTranslationRuntime.SCHEMA);
        view.put("scope", "DEV_ONLY");
        view.put("translationId", translation.output().artifact().artifactId());
        view.put("translation", MediaDevDubSupport.outputView(translation.output()));
        view.put("sourceLanguage", translation.sourceLanguage());
        view.put("targetLanguage", translation.targetLanguage());
        List<Map<String, Object>> segments = new ArrayList<>();
        for (var segment : translation.segments()) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("segmentId", segment.segmentId());
            entry.put("startMillis", segment.startMillis());
            entry.put("endMillis", segment.endMillis());
            entry.put("sourceText", segment.sourceText());
            entry.put("text", segment.text());
            segments.add(entry);
        }
        view.put("segments", segments);
        view.put("replayed", translation.output().replayed());
        view.put("note", NOTE);
        return view;
    }

    private static Map<String, Object> dubView(MediaDevDubbingRuntime.Dub dub) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", MediaDevDubbingRuntime.SCHEMA);
        view.put("scope", "DEV_ONLY");
        view.put("dubId", dub.timing().artifact().artifactId());
        Map<String, Object> outputs = new LinkedHashMap<>();
        outputs.put("audio", MediaDevDubSupport.outputView(dub.audio()));
        outputs.put("captions", MediaDevDubSupport.outputView(dub.captions()));
        outputs.put("timing", MediaDevDubSupport.outputView(dub.timing()));
        view.put("outputs", outputs);
        view.put("timing", dub.timingDocument());
        view.put("replayed", dub.replayed());
        view.put("note", NOTE);
        return view;
    }

    private static List<MediaDevTranslationRuntime.SegmentText> segmentTexts(Object value) {
        if (!(value instanceof List<?> list)) throw new IllegalArgumentException("segments must be an array");
        List<MediaDevTranslationRuntime.SegmentText> segments = new ArrayList<>();
        for (Object item : list) {
            if (!(item instanceof Map<?, ?> map) || map.size() != 2 || !map.containsKey("segmentId")
                    || !map.containsKey("text")) {
                throw new IllegalArgumentException("each segment must be {segmentId, text}");
            }
            segments.add(new MediaDevTranslationRuntime.SegmentText(string(map.get("segmentId"), "segmentId"),
                    string(map.get("text"), "text")));
        }
        return segments;
    }

    private static MediaDevDubbingRuntime.OverflowPolicy policy(Object value) {
        if (value == null) return null;
        try {
            return MediaDevDubbingRuntime.OverflowPolicy.valueOf(string(value, "overflowPolicy"));
        } catch (IllegalArgumentException unknown) {
            throw new IllegalArgumentException("overflowPolicy must be REFUSE or ALLOW_SPILL");
        }
    }

    private static Map<String, Object> body(HttpExchange exchange, int maxBody) throws IOException {
        Map<String, Object> body = JSON.readValue(MediaHttpHandler.boundedBody(exchange, maxBody, false),
                new TypeReference<Map<String, Object>>() { });
        if (body == null) throw new IllegalArgumentException("request body is required");
        return body;
    }

    private static void requireKeys(Map<String, Object> value, Set<String> required, Set<String> optional,
                                    String field) {
        if (!value.keySet().containsAll(required)
                || !java.util.stream.Stream.concat(required.stream(), optional.stream())
                        .collect(java.util.stream.Collectors.toSet()).containsAll(value.keySet())) {
            throw new IllegalArgumentException(field + " fields do not match its declared shape");
        }
    }

    private static MediaDevSpeechRuntime.ArtifactVersionRef reference(Object value, String field) {
        if (value == null) return null;
        if (!(value instanceof Map<?, ?> map) || map.size() != 2 || !map.containsKey("artifactId")
                || !map.containsKey("artifactVersionId")) {
            throw new IllegalArgumentException(field + " must be {artifactId, artifactVersionId}");
        }
        return new MediaDevSpeechRuntime.ArtifactVersionRef(string(map.get("artifactId"), field + ".artifactId"),
                string(map.get("artifactVersionId"), field + ".artifactVersionId"));
    }

    private static String string(Object value, String field) {
        if (!(value instanceof String text)) throw new IllegalArgumentException(field + " must be a string");
        return text;
    }

    private static void notAllowed(HttpExchange exchange, String allow, MediaDevCreativeOutputRoutes.Responder out)
            throws IOException {
        exchange.getResponseHeaders().set("Allow", allow);
        out.error(exchange, 405, "METHOD_NOT_ALLOWED", "Method not allowed", Map.of());
    }

    private static String pathSegment(String raw) {
        String decoded = URLDecoder.decode(raw.replace("+", "%2B"), StandardCharsets.UTF_8);
        if (decoded.indexOf('/') >= 0 || decoded.indexOf('\\') >= 0) {
            throw new IllegalArgumentException("Path identifier must not contain a separator");
        }
        return decoded;
    }
}
