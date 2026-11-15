package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
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
 * DEV_ONLY video routes (outside the canonical manifest/OpenAPI):
 * {@code POST /dev/v1/video/enhancements}, {@code GET /dev/v1/video/enhancements/{artifactId}},
 * {@code POST /dev/v1/video/comparisons} and {@code GET /dev/v1/video/comparisons/{artifactId}}. Permissions are
 * {@code media:project:dev:write|read} plus {@code media:artifact:read} (and {@code media:artifact:create} for the
 * POSTs). The acting principal is the authenticated caller; no body field names one.
 *
 * <p>Every numeric parameter is validated against its declared bound while the body is parsed, so an out-of-range
 * request is refused (422 {@code VIDEO_PARAMETER_OUT_OF_RANGE}) before any source lookup, rights check or process.
 */
final class MediaDevVideoRoutes {
    static final String ENHANCEMENTS = "/dev/v1/video/enhancements";
    static final String COMPARISONS = "/dev/v1/video/comparisons";
    private static final Pattern ENHANCEMENT = Pattern.compile("^/dev/v1/video/enhancements/([^/]+)$");
    private static final Pattern COMPARISON = Pattern.compile("^/dev/v1/video/comparisons/([^/]+)$");
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();

    private final MediaDevVideoRuntime video;
    private final MediaRuntime runtime;

    MediaDevVideoRoutes(MediaDevVideoRuntime video, MediaRuntime runtime) {
        this.video = video;
        this.runtime = runtime;
    }

    static boolean handles(String path) { return path.startsWith("/dev/v1/video/"); }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        try {
            dispatch(exchange, path, method, tenantId, principalId, maxBody, out);
        } catch (MediaDevRenderAdmission.CapacityExhaustedException failure) {
            out.error(exchange, 429, MediaDevRenderAdmission.CAPACITY_CODE,
                    "DEV_ONLY video capacity is exhausted; retry the same requestId after the Retry-After delay",
                    Map.of("scope", failure.scope()));
        } catch (MediaDevVideoRuntime.VideoParameterException failure) {
            out.error(exchange, 422, failure.code(), failure.getMessage(), Map.of("parameter", failure.parameter()));
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException failure) {
            runtime.recordDeniedRequest();
            out.error(exchange, 404, "SOURCE_VERSION_NOT_FOUND",
                    "The exact source artifact version is not available to this DEV_ONLY principal", Map.of());
        } catch (MediaDevVideoRuntime.VideoRightsNotAdmittedException failure) {
            runtime.recordDeniedRequest();
            out.error(exchange, "RIGHTS_AUTHORITY_UNAVAILABLE".equals(failure.code()) ? 503 : 403, failure.code(),
                    "A source version has no current PROCESSING rights and consent admission; nothing was run",
                    Map.of("scope", "PROCESSING", "verdict", failure.resolution().verdict().name(),
                            "artifactId", failure.artifactId(),
                            "reasons", failure.resolution().reasons().stream().map(Enum::name).sorted().toList()));
        } catch (MediaDevVideoRuntime.VideoOutcomeUnknownException failure) {
            out.error(exchange, 503, "VIDEO_OUTCOME_UNKNOWN",
                    "The video process did not finish; its outcome is UNKNOWN and nothing was registered. "
                            + "Retry the same requestId",
                    Map.of("outcome", "UNKNOWN"));
        } catch (MediaDevVideoRuntime.VideoRefusedException failure) {
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevRequestLedger.LedgerRefusedException failure) {
            out.error(exchange, failure.status(), failure.code(), failure.getMessage(), failure.details());
        } catch (MediaDevVideoRuntime.VideoRequestReusedException failure) {
            out.error(exchange, 409, "VIDEO_REQUEST_ID_REUSED",
                    "requestId was already used with a different video request", Map.of());
        } catch (MediaDevVideoRuntime.VideoRegistrationFailedException failure) {
            out.error(exchange, 502, "VIDEO_OUTPUT_REGISTRATION_FAILED",
                    "The output was not registered; retry with the same requestId to resume", Map.of());
        }
    }

    private void dispatch(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                          int maxBody, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        if (ENHANCEMENTS.equals(path) || COMPARISONS.equals(path)) {
            if (!"POST".equals(method)) { notAllowed(exchange, "POST", out); return; }
            if (!MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")
                    || !MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:create")) {
                runtime.recordDeniedRequest();
                out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                        "DEV_ONLY artifact read and create permissions are required for video outputs", Map.of());
                return;
            }
            Map<String, Object> body = JSON.readValue(MediaHttpHandler.boundedBody(exchange, maxBody, false),
                    new TypeReference<Map<String, Object>>() { });
            if (body == null) throw new IllegalArgumentException("request body is required");
            boolean enhancement = ENHANCEMENTS.equals(path);
            MediaDevVideoRuntime.VideoResult result = enhancement
                    ? video.enhance(tenantId, principalId, parseEnhancement(body))
                    : video.compare(tenantId, principalId, parseComparison(body));
            out.json(exchange, result.replayed() ? 200 : 201, view(result,
                    enhancement ? MediaDevVideoRuntime.ENHANCEMENT_SCHEMA : MediaDevVideoRuntime.COMPARISON_SCHEMA));
            return;
        }
        Matcher enhancementOne = ENHANCEMENT.matcher(path);
        Matcher comparisonOne = COMPARISON.matcher(path);
        boolean isEnhancement = enhancementOne.matches();
        if (isEnhancement || comparisonOne.matches()) {
            if (!"GET".equals(method)) { notAllowed(exchange, "GET", out); return; }
            if (!MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")) {
                runtime.recordDeniedRequest();
                out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                        "DEV_ONLY artifact read permission is required", Map.of());
                return;
            }
            String schema = isEnhancement ? MediaDevVideoRuntime.ENHANCEMENT_SCHEMA : MediaDevVideoRuntime.COMPARISON_SCHEMA;
            String id = pathSegment((isEnhancement ? enhancementOne : comparisonOne).group(1));
            var found = video.reopen(tenantId, principalId, id, schema);
            if (found.isEmpty()) {
                out.error(exchange, 404, "VIDEO_OUTPUT_NOT_FOUND",
                        "Video output is not available in this tenant and owner scope", Map.of());
                return;
            }
            out.json(exchange, 200, view(found.get(), schema));
            return;
        }
        out.error(exchange, 404, "NOT_FOUND", "Video route not found", Map.of());
    }

    // ------------------------------------------------------------------ request parsing

    private static MediaDevVideoRuntime.EnhanceRequest parseEnhancement(Map<String, Object> body) {
        requireKeys(body, Set.of("requestId", "artifactId", "artifactVersionId", "operations"), Set.of("encoder"),
                "enhancement request");
        int crf = 18;
        if (body.containsKey("encoder")) {
            Map<String, Object> encoder = object(body.get("encoder"), "encoder");
            requireKeys(encoder, Set.of(), Set.of("crf"), "encoder");
            if (encoder.containsKey("crf")) crf = integer(encoder.get("crf"), "encoder.crf");
        }
        if (!(body.get("operations") instanceof List<?> raw)) throw new IllegalArgumentException("operations must be an array");
        if (raw.size() > 5) {
            throw new MediaDevVideoRuntime.VideoParameterException("VIDEO_PARAMETER_OUT_OF_RANGE", "operations",
                    "operations must contain between 1 and 5 entries");
        }
        List<MediaDevVideoRuntime.Operation> operations = new ArrayList<>();
        for (Object entry : raw) operations.add(parseOperation(object(entry, "operation")));
        return new MediaDevVideoRuntime.EnhanceRequest(string(body.get("requestId"), "requestId"),
                string(body.get("artifactId"), "artifactId"), string(body.get("artifactVersionId"), "artifactVersionId"),
                operations, crf);
    }

    private static MediaDevVideoRuntime.Operation parseOperation(Map<String, Object> operation) {
        String type = string(operation.get("type"), "operation.type");
        return switch (type) {
            case "deinterlace" -> {
                requireKeys(operation, Set.of("type"), Set.of(), "deinterlace");
                yield new MediaDevVideoRuntime.Deinterlace();
            }
            case "denoise" -> {
                requireKeys(operation, Set.of("type", "method", "strength"), Set.of(), "denoise");
                String method = string(operation.get("method"), "denoise.method");
                MediaDevVideoRuntime.DenoiseMethod parsed = switch (method) {
                    case "hqdn3d" -> MediaDevVideoRuntime.DenoiseMethod.HQDN3D;
                    case "nlmeans" -> MediaDevVideoRuntime.DenoiseMethod.NLMEANS;
                    default -> throw new MediaDevVideoRuntime.VideoParameterException("VIDEO_PARAMETER_OUT_OF_RANGE",
                            "denoise.method", "denoise.method must be hqdn3d or nlmeans");
                };
                yield new MediaDevVideoRuntime.Denoise(parsed, decimal(operation.get("strength"), "denoise.strength"));
            }
            case "deblock" -> {
                requireKeys(operation, Set.of("type", "strength"), Set.of(), "deblock");
                yield new MediaDevVideoRuntime.Deblock(decimal(operation.get("strength"), "deblock.strength"));
            }
            case "sharpen" -> {
                requireKeys(operation, Set.of("type", "amount"), Set.of(), "sharpen");
                yield new MediaDevVideoRuntime.Sharpen(decimal(operation.get("amount"), "sharpen.amount"));
            }
            case "colourCorrection" -> {
                requireKeys(operation, Set.of("type"), Set.of("brightness", "contrast", "saturation", "gamma"),
                        "colourCorrection");
                yield new MediaDevVideoRuntime.ColourCorrection(
                        operation.containsKey("brightness") ? decimal(operation.get("brightness"), "colourCorrection.brightness") : 0.0,
                        operation.containsKey("contrast") ? decimal(operation.get("contrast"), "colourCorrection.contrast") : 1.0,
                        operation.containsKey("saturation") ? decimal(operation.get("saturation"), "colourCorrection.saturation") : 1.0,
                        operation.containsKey("gamma") ? decimal(operation.get("gamma"), "colourCorrection.gamma") : 1.0);
            }
            default -> throw new MediaDevVideoRuntime.VideoParameterException("VIDEO_PARAMETER_OUT_OF_RANGE",
                    "operation.type", "operation.type must be deinterlace, denoise, deblock, sharpen or colourCorrection");
        };
    }

    private static MediaDevVideoRuntime.CompareRequest parseComparison(Map<String, Object> body) {
        requireKeys(body, Set.of("requestId", "subjects"), Set.of("reference"), "comparison request");
        MediaDevVideoRuntime.SourceRef reference = null;
        if (body.containsKey("reference")) reference = source(object(body.get("reference"), "reference"), "reference");
        if (!(body.get("subjects") instanceof List<?> raw)) throw new IllegalArgumentException("subjects must be an array");
        if (raw.size() > MediaDevVideoRuntime.MAX_SUBJECTS) {
            throw new MediaDevVideoRuntime.VideoParameterException("VIDEO_PARAMETER_OUT_OF_RANGE", "subjects",
                    "subjects must contain between 1 and " + MediaDevVideoRuntime.MAX_SUBJECTS + " entries");
        }
        List<MediaDevVideoRuntime.Subject> subjects = new ArrayList<>();
        for (Object entry : raw) {
            Map<String, Object> subject = object(entry, "subject");
            requireKeys(subject, Set.of("label", "artifactId", "artifactVersionId"), Set.of(), "subject");
            subjects.add(new MediaDevVideoRuntime.Subject(string(subject.get("label"), "label"),
                    source(subject, "subject")));
        }
        return new MediaDevVideoRuntime.CompareRequest(string(body.get("requestId"), "requestId"), reference, subjects);
    }

    private static MediaDevVideoRuntime.SourceRef source(Map<String, Object> value, String field) {
        if (!value.containsKey("artifactId") || !value.containsKey("artifactVersionId")) {
            throw new IllegalArgumentException(field + " needs artifactId and artifactVersionId");
        }
        return new MediaDevVideoRuntime.SourceRef(string(value.get("artifactId"), "artifactId"),
                string(value.get("artifactVersionId"), "artifactVersionId"));
    }

    // ------------------------------------------------------------------ response

    private static Map<String, Object> view(MediaDevVideoRuntime.VideoResult result, String schema) {
        MediaArtifact artifact = result.artifact();
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", schema);
        view.put("outputId", artifact.artifactId());
        view.put("artifact", Map.of(
                "artifactId", artifact.artifactId(),
                "artifactVersionId", artifact.version().value(),
                "contentType", artifact.contentType(),
                "sizeBytes", artifact.sizeBytes(),
                "sha256", artifact.sha256(),
                "artifactPath", "/api/v1/artifacts/" + artifact.artifactId()));
        view.put("lineage", result.lineage());
        view.put("replayed", result.replayed());
        if (result.admission() != null) {
            view.put("admission", Map.of("scope", "PROCESSING", "verdict", result.admission().verdict().name(),
                    "attestationIds", result.admission().attestationIds(),
                    "resolverId", result.admission().resolverId()));
        }
        view.put("scope", "DEV_ONLY");
        view.put("note", MediaDevVideoRuntime.ENHANCEMENT_SCHEMA.equals(schema)
                ? "DEV_ONLY FFmpeg filter output with verified source timeline; no quality, rights, approval or production claim"
                : "DEV_ONLY measured luma PSNR/SSIM and no-reference estimates; no perceptual, rights, approval or production claim");
        return view;
    }

    // ------------------------------------------------------------------ strict JSON helpers

    private static void requireKeys(Map<String, Object> value, Set<String> required, Set<String> optional, String field) {
        if (!value.keySet().containsAll(required)
                || !java.util.stream.Stream.concat(required.stream(), optional.stream())
                        .collect(java.util.stream.Collectors.toSet()).containsAll(value.keySet())) {
            throw new IllegalArgumentException(field + " fields do not match its declared shape");
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object value, String field) {
        if (!(value instanceof Map<?, ?> map)) throw new IllegalArgumentException(field + " must be an object");
        return (Map<String, Object>) map;
    }

    private static String string(Object value, String field) {
        if (!(value instanceof String text)) throw new IllegalArgumentException(field + " must be a string");
        return text;
    }

    private static int integer(Object value, String field) {
        if (!(value instanceof Integer || value instanceof Long || value instanceof Short)) {
            throw new IllegalArgumentException(field + " must be an integer");
        }
        long v = ((Number) value).longValue();
        if (v < Integer.MIN_VALUE || v > Integer.MAX_VALUE) {
            throw new MediaDevVideoRuntime.VideoParameterException("VIDEO_PARAMETER_OUT_OF_RANGE", field,
                    field + " is out of range");
        }
        return (int) v;
    }

    private static double decimal(Object value, String field) {
        if (!(value instanceof Number number)) throw new IllegalArgumentException(field + " must be a number");
        return number.doubleValue();
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
