package com.ghatana.media.launcher;

import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;
import com.ghatana.media.runtime.MediaConsentAdministration;
import com.ghatana.media.runtime.MediaMetadataSanitizer;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamFrame;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSession;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSessionRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadSession;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;

import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Bounded tenant-scoped Media Runtime HTTP transport.
 *
 * @doc.type class
 * @doc.purpose Provide Media Http Handler behavior
 * @doc.layer product
 * @doc.pattern Controller
 */
public final class MediaHttpHandler implements HttpHandler {
    private static final Set<String> HEALTH_PATHS = Set.of(
            "/health", "/health/live", "/health/ready", "/health/startup",
            "/ready", "/metrics", "/info", "/api/v1/health");
    private static final Pattern UPLOAD_PATH = Pattern.compile("^/api/v1/artifacts/uploads/([^/]+)$");
    private static final Pattern CHUNK_PATH = Pattern.compile("^/api/v1/artifacts/uploads/([^/]+)/chunks/(\\d+)$");
    private static final Pattern COMPLETE_PATH = Pattern.compile("^/api/v1/artifacts/uploads/([^/]+)/complete$");
    private static final Pattern ARTIFACT_PATH = Pattern.compile("^/api/v1/artifacts/([^/]+)$");
    private static final Pattern JOB_PATH = Pattern.compile("^/api/v1/jobs/([^/]+)$");
    private static final Pattern CANCEL_PATH = Pattern.compile("^/api/v1/jobs/([^/]+)/cancel$");
    private static final Pattern STREAM_PATH = Pattern.compile("^/api/v1/streams/([^/]+)$");
    private static final Pattern STREAM_CONNECT_PATH = Pattern.compile("^/api/v1/streams/([^/]+)/connect$");
    private static final Pattern STREAM_FRAME_PATH = Pattern.compile("^/api/v1/streams/([^/]+)/frames/(\\d+)$");
    private static final Pattern STREAM_CLOSE_PATH = Pattern.compile("^/api/v1/streams/([^/]+)/close$");
    private static final Pattern CONSENT_PATH = Pattern.compile("^/api/v1/consents/([^/]+)$");

    private final MediaRuntime runtime;
    private final MediaConsentAdministration consentAdministration;
    private final ObjectMapper mapper = JsonMapper.builder().addModules(tools.jackson.databind.cfg.MapperBuilder.findModules()).build();

    public MediaHttpHandler(MediaRuntime runtime) {
        this(runtime, null);
    }

    public MediaHttpHandler(MediaRuntime runtime, MediaConsentAdministration consentAdministration) {
        this.runtime = java.util.Objects.requireNonNull(runtime, "runtime");
        this.consentAdministration = consentAdministration;
    }

    @Override
    public void handle(HttpExchange exchange) throws IOException {
        try {
            String path = exchange.getRequestURI().getPath();
            String method = exchange.getRequestMethod();
            if (HEALTH_PATHS.contains(path)) {
                health(exchange, path);
                return;
            }
            if (!runtime.ready()) {
                error(exchange, 503, "RUNTIME_NOT_READY", "Media Runtime is not ready");
                return;
            }
            String tenantId = requiredHeader(exchange, "X-Tenant-Id");
            String principalId = requiredHeader(exchange, "X-Principal-Id");

            if ("/api/v1/consents".equals(path)) {
                if ("POST".equals(method)) grantConsent(exchange, tenantId);
                else if ("GET".equals(method)) listConsents(exchange, tenantId);
                else methodNotAllowed(exchange, "GET, POST");
                return;
            }
            Matcher consent = CONSENT_PATH.matcher(path);
            if (consent.matches()) {
                String consentId = decode(consent.group(1));
                if ("GET".equals(method)) readConsent(exchange, tenantId, consentId);
                else if ("DELETE".equals(method)) revokeConsent(exchange, tenantId, consentId);
                else methodNotAllowed(exchange, "GET, DELETE");
                return;
            }
            if ("/api/v1/artifacts/uploads".equals(path)) {
                if (!"POST".equals(method)) { methodNotAllowed(exchange, "POST"); return; }
                beginUpload(exchange, tenantId, principalId); return;
            }
            Matcher chunk = CHUNK_PATH.matcher(path);
            if (chunk.matches()) {
                if (!"PUT".equals(method)) { methodNotAllowed(exchange, "PUT"); return; }
                appendChunk(exchange, tenantId, principalId, decode(chunk.group(1)), Integer.parseInt(chunk.group(2))); return;
            }
            Matcher complete = COMPLETE_PATH.matcher(path);
            if (complete.matches()) {
                if (!"POST".equals(method)) { methodNotAllowed(exchange, "POST"); return; }
                completeUpload(exchange, tenantId, principalId, decode(complete.group(1))); return;
            }
            Matcher upload = UPLOAD_PATH.matcher(path);
            if (upload.matches()) {
                if (!"GET".equals(method)) { methodNotAllowed(exchange, "GET"); return; }
                upload(exchange, tenantId, principalId, decode(upload.group(1))); return;
            }
            Matcher artifact = ARTIFACT_PATH.matcher(path);
            if (artifact.matches()) {
                if (!"GET".equals(method)) { methodNotAllowed(exchange, "GET"); return; }
                artifact(exchange, tenantId, principalId, decode(artifact.group(1))); return;
            }
            if ("/api/v1/jobs".equals(path)) {
                if ("POST".equals(method)) submit(exchange, tenantId, principalId);
                else if ("GET".equals(method)) listJobs(exchange, tenantId, principalId);
                else methodNotAllowed(exchange, "GET, POST");
                return;
            }
            Matcher cancel = CANCEL_PATH.matcher(path);
            if (cancel.matches()) {
                if (!"POST".equals(method)) { methodNotAllowed(exchange, "POST"); return; }
                cancel(exchange, tenantId, principalId, decode(cancel.group(1))); return;
            }
            Matcher job = JOB_PATH.matcher(path);
            if (job.matches()) {
                if (!"GET".equals(method)) { methodNotAllowed(exchange, "GET"); return; }
                job(exchange, tenantId, principalId, decode(job.group(1))); return;
            }
            if ("/api/v1/streams".equals(path)) {
                if (!"POST".equals(method)) { methodNotAllowed(exchange, "POST"); return; }
                openStream(exchange, tenantId, principalId); return;
            }
            Matcher connect = STREAM_CONNECT_PATH.matcher(path);
            if (connect.matches()) {
                if (!"POST".equals(method)) { methodNotAllowed(exchange, "POST"); return; }
                connectStream(exchange, tenantId, principalId, decode(connect.group(1))); return;
            }
            Matcher frame = STREAM_FRAME_PATH.matcher(path);
            if (frame.matches()) {
                if (!"POST".equals(method)) { methodNotAllowed(exchange, "POST"); return; }
                frame(exchange, tenantId, principalId, decode(frame.group(1)), Long.parseLong(frame.group(2))); return;
            }
            Matcher close = STREAM_CLOSE_PATH.matcher(path);
            if (close.matches()) {
                if (!"POST".equals(method)) { methodNotAllowed(exchange, "POST"); return; }
                closeStream(exchange, tenantId, principalId, decode(close.group(1))); return;
            }
            Matcher stream = STREAM_PATH.matcher(path);
            if (stream.matches()) {
                if (!"GET".equals(method)) { methodNotAllowed(exchange, "GET"); return; }
                stream(exchange, tenantId, principalId, decode(stream.group(1))); return;
            }
            if ("/api/v1/providers".equals(path)) {
                if (!"GET".equals(method)) { methodNotAllowed(exchange, "GET"); return; }
                providers(exchange); return;
            }
            error(exchange, 404, "NOT_FOUND", "Route not found");
        } catch (SecurityException failure) {
            error(exchange, 403, "TENANT_FORBIDDEN", "Request tenant is not permitted");
        } catch (IllegalArgumentException failure) {
            error(exchange, 400, "INVALID_REQUEST", "Media request is invalid");
        } catch (IllegalStateException failure) {
            error(exchange, 409, "MEDIA_STATE_CONFLICT", "Media resource state changed; re-read before retrying");
        } catch (Exception failure) {
            error(exchange, 500, "INTERNAL_ERROR", "Media Runtime request failed");
        }
    }

    private void grantConsent(HttpExchange exchange, String tenantId) throws IOException {
        MediaConsentAdministration administration = requireConsentAdministration();
        String principalId = requiredHeader(exchange, "X-Principal-Id");
        ConsentGrantBody body = mapper.readValue(
                boundedBody(exchange, runtime.config().maximumBodyBytes()), ConsentGrantBody.class);
        String correlationId = optionalHeader(
                exchange, "X-Correlation-Id", UUID.randomUUID().toString());
        MediaConsentAdministration.ConsentRecord record = administration.grant(
                new MediaConsentAdministration.GrantRequest(
                        tenantId,
                        principalId,
                        correlationId,
                        body.purposes(),
                        body.allowedRegions(),
                        body.externalProcessingAllowed(),
                        body.biometricProcessingAllowed(),
                        body.expiresAt()));
        json(exchange, 201, record);
    }

    private void listConsents(HttpExchange exchange, String tenantId) throws IOException {
        MediaConsentAdministration administration = requireConsentAdministration();
        String principalId = requiredHeader(exchange, "X-Principal-Id");
        var values = administration.list(tenantId, principalId, queryLimit(exchange, 100));
        json(exchange, 200, Map.of("consents", values, "count", values.size()));
    }

    private void readConsent(HttpExchange exchange, String tenantId, String consentId) throws IOException {
        MediaConsentAdministration administration = requireConsentAdministration();
        String principalId = requiredHeader(exchange, "X-Principal-Id");
        var record = administration.find(tenantId, principalId, consentId);
        if (record.isEmpty()) {
            error(exchange, 404, "CONSENT_NOT_FOUND", "Media consent not found");
            return;
        }
        json(exchange, 200, record.orElseThrow());
    }

    private void revokeConsent(HttpExchange exchange, String tenantId, String consentId) throws IOException {
        MediaConsentAdministration administration = requireConsentAdministration();
        String principalId = requiredHeader(exchange, "X-Principal-Id");
        String correlationId = optionalHeader(
                exchange, "X-Correlation-Id", UUID.randomUUID().toString());
        var record = administration.revoke(tenantId, principalId, consentId, correlationId);
        if (record.isEmpty()) {
            error(exchange, 404, "CONSENT_NOT_FOUND", "Media consent not found");
            return;
        }
        json(exchange, 200, record.orElseThrow());
    }

    private void beginUpload(HttpExchange exchange, String tenantId, String principalId) throws IOException {
        UploadRequest request = mapper.readValue(
                boundedBody(exchange, runtime.config().maximumBodyBytes()), UploadRequest.class);
        if (!tenantId.equals(request.tenantId())) {
            throw new SecurityException("Upload tenant does not match authenticated tenant");
        }
        if (!principalId.equals(request.principalId())) {
            throw new SecurityException("Upload principal does not match authenticated principal");
        }
        UploadRequest sanitized = new UploadRequest(
                request.tenantId(),
                principalId,
                request.fileName(),
                request.contentType(),
                request.expectedSizeBytes(),
                request.expectedSha256(),
                request.classification(),
                request.retention(),
                MediaMetadataSanitizer.sanitize(request.metadata()));
        json(exchange, 201, runtime.beginUpload(sanitized));
    }

    private void appendChunk(
            HttpExchange exchange, String tenantId, String principalId, String uploadId, int index) throws IOException {
        UploadSession existing = runtime.upload(tenantId, principalId, uploadId).orElse(null);
        if (existing == null) {
            error(exchange, 404, "UPLOAD_NOT_FOUND", "Upload session not found");
            return;
        }
        json(exchange, 200, runtime.appendChunk(
                tenantId, uploadId, index, boundedBody(exchange, runtime.config().maximumChunkBytes())));
    }

    private void completeUpload(
            HttpExchange exchange, String tenantId, String principalId, String uploadId) throws IOException {
        UploadSession existing = runtime.upload(tenantId, principalId, uploadId).orElse(null);
        if (existing == null) {
            error(exchange, 404, "UPLOAD_NOT_FOUND", "Upload session not found");
            return;
        }
        json(exchange, 201, runtime.completeUpload(tenantId, uploadId));
    }

    private void upload(HttpExchange exchange, String tenantId, String principalId, String uploadId) throws IOException {
        UploadSession session = runtime.upload(tenantId, principalId, uploadId).orElse(null);
        if (session == null) {
            error(exchange, 404, "UPLOAD_NOT_FOUND", "Upload session not found"); return;
        }
        json(exchange, 200, session);
    }

    private void artifact(HttpExchange exchange, String tenantId, String principalId, String artifactId) throws IOException {
        MediaArtifact artifact = runtime.artifact(tenantId, principalId, artifactId).orElse(null);
        if (artifact == null) {
            error(exchange, 404, "ARTIFACT_NOT_FOUND", "Media artifact not found"); return;
        }
        json(exchange, 200, artifact);
    }

    private void submit(HttpExchange exchange, String tenantId, String principalId) throws IOException {
        ProcessingJobRequest request = mapper.readValue(
                boundedBody(exchange, runtime.config().maximumBodyBytes()), ProcessingJobRequest.class);
        if (!tenantId.equals(request.tenantId())) throw new SecurityException("Job tenant does not match authenticated tenant");
        if (!principalId.equals(request.principalId())) {
            throw new SecurityException("Job principal does not match authenticated principal");
        }
        json(exchange, 202, runtime.submit(request));
    }

    private void listJobs(HttpExchange exchange, String tenantId, String principalId) throws IOException {
        var jobs = runtime.jobs(tenantId, principalId, queryLimit(exchange, 100));
        json(exchange, 200, Map.of("jobs", jobs));
    }

    private void job(HttpExchange exchange, String tenantId, String principalId, String jobId) throws IOException {
        ProcessingJob job = runtime.job(tenantId, principalId, jobId).orElse(null);
        if (job == null) {
            error(exchange, 404, "JOB_NOT_FOUND", "Media job not found"); return;
        }
        json(exchange, 200, job);
    }

    private void cancel(HttpExchange exchange, String tenantId, String principalId, String jobId) throws IOException {
        ProcessingJob existing = runtime.job(tenantId, principalId, jobId).orElse(null);
        if (existing == null) {
            error(exchange, 404, "JOB_NOT_FOUND", "Media job not found"); return;
        }
        json(exchange, 200, runtime.cancel(tenantId, principalId, jobId));
    }

    private void openStream(HttpExchange exchange, String tenantId, String principalId) throws IOException {
        StreamSessionRequest request = mapper.readValue(
                boundedBody(exchange, runtime.config().maximumBodyBytes()), StreamSessionRequest.class);
        if (!tenantId.equals(request.tenantId())) {
            throw new SecurityException("Stream tenant does not match authenticated tenant");
        }
        if (!principalId.equals(request.principalId())) {
            throw new SecurityException("Stream principal does not match authenticated principal");
        }
        StreamSessionRequest sanitized = new StreamSessionRequest(
                request.tenantId(),
                request.principalId(),
                request.correlationId(),
                request.streamKind(),
                request.providerHint(),
                request.maximumBufferedBytes(),
                request.leaseDuration(),
                MediaMetadataSanitizer.sanitize(request.metadata()),
                request.governanceContext());
        json(exchange, 201, runtime.openStream(sanitized));
    }

    private void connectStream(
            HttpExchange exchange, String tenantId, String principalId, String sessionId) throws IOException {
        if (runtime.stream(tenantId, principalId, sessionId).isEmpty()) {
            error(exchange, 404, "STREAM_NOT_FOUND", "Media stream not found"); return;
        }
        json(exchange, 200, runtime.connectStream(
                tenantId, principalId, sessionId, requiredHeader(exchange, "X-Stream-Token")));
    }

    private void frame(
            HttpExchange exchange, String tenantId, String principalId, String sessionId, long sequence) throws IOException {
        if (runtime.stream(tenantId, principalId, sessionId).isEmpty()) {
            error(exchange, 404, "STREAM_NOT_FOUND", "Media stream not found"); return;
        }
        boolean end = Boolean.parseBoolean(optionalHeader(exchange, "X-End-Of-Stream", "false"));
        byte[] payload = boundedBody(exchange, runtime.config().maximumChunkBytes(), end);
        json(exchange, 202, runtime.acceptFrame(new StreamFrame(
                tenantId, sessionId, requiredHeader(exchange, "X-Stream-Token"),
                sequence, payload, end, Instant.now())));
    }

    private void closeStream(
            HttpExchange exchange, String tenantId, String principalId, String sessionId) throws IOException {
        if (runtime.stream(tenantId, principalId, sessionId).isEmpty()) {
            error(exchange, 404, "STREAM_NOT_FOUND", "Media stream not found"); return;
        }
        json(exchange, 200, runtime.closeStream(
                tenantId, principalId, sessionId, requiredHeader(exchange, "X-Stream-Token")));
    }

    private void stream(HttpExchange exchange, String tenantId, String principalId, String sessionId) throws IOException {
        StreamSession session = runtime.stream(tenantId, principalId, sessionId).orElse(null);
        if (session == null) {
            error(exchange, 404, "STREAM_NOT_FOUND", "Media stream not found"); return;
        }
        json(exchange, 200, session);
    }

    private void providers(HttpExchange exchange) throws IOException {
        Map<String, Object> health = runtime.healthSnapshot();
        Map<String, Object> response = new java.util.LinkedHashMap<>();
        response.put("processingProviders", runtime.providerIds());
        response.put("capabilityProfiles", runtime.capabilityProfiles());
        response.put("streamingProviders", runtime.streamingProviderIds());
        response.put("artifactStoreId", health.get("artifactStoreId"));
        response.put("jobStoreId", health.get("jobStoreId"));
        response.put("streamStoreId", health.get("streamStoreId"));
        response.put("consentAdministrationId", consentAdministration == null
                ? "not-configured" : consentAdministration.administrationId());
        response.put("genericModelIntegration", "ai-inference-capability");
        response.put("metadataIntegration", "data-cloud-capability");
        json(exchange, 200, Map.copyOf(response));
    }

    private void health(HttpExchange exchange, String path) throws IOException {
        boolean ready = runtime.ready();
        if ("/health/live".equals(path)) json(exchange, 200, Map.of("status", "LIVE"));
        else if ("/health/ready".equals(path) || "/ready".equals(path)) {
            json(exchange, ready ? 200 : 503, Map.of("status", ready ? "READY" : "NOT_READY"));
        } else if ("/health/startup".equals(path)) {
            json(exchange, ready ? 200 : 503, Map.of("status", ready ? "STARTED" : "STARTING"));
        } else if ("/metrics".equals(path)) {
            Map<String, Object> snapshot = runtime.healthSnapshot();
            json(exchange, 200, Map.of(
                    "service", "media", "ready", ready,
                    "activeJobs", snapshot.get("activeJobs"),
                    "activeStreams", snapshot.get("activeStreams")));
        } else if ("/info".equals(path)) {
            json(exchange, 200, Map.of(
                    "service", "media",
                    "metadataIntegration", "data-cloud-capability",
                    "genericModelIntegration", "ai-inference-capability"));
        } else {
            json(exchange, ready ? 200 : 503, Map.of("status", ready ? "UP" : "DOWN"));
        }
    }

    private MediaConsentAdministration requireConsentAdministration() {
        if (consentAdministration == null || !consentAdministration.ready()) {
            throw new IllegalStateException("Media consent administration is not configured or ready");
        }
        return consentAdministration;
    }

    private static byte[] boundedBody(HttpExchange exchange, int maximum) throws IOException {
        return boundedBody(exchange, maximum, false);
    }

    static byte[] boundedBody(HttpExchange exchange, int maximum, boolean allowEmpty) throws IOException {
        if (maximum < 1) throw new IllegalArgumentException("maximum must be positive");
        byte[] bytes = exchange.getRequestBody().readNBytes(maximum + 1);
        if (bytes.length > maximum) throw new IllegalArgumentException("Request body exceeds " + maximum + " bytes");
        if (!allowEmpty && bytes.length == 0) throw new IllegalArgumentException("Request body is required");
        return bytes;
    }

    private static int queryLimit(HttpExchange exchange, int fallback) {
        String query = exchange.getRequestURI().getRawQuery();
        if (query == null) return fallback;
        for (String part : query.split("&")) {
            String[] pair = part.split("=", 2);
            if (pair.length == 2 && "limit".equals(pair[0])) {
                try { return Math.max(1, Math.min(Integer.parseInt(pair[1]), 1_000)); }
                catch (NumberFormatException failure) { throw new IllegalArgumentException("limit must be an integer"); }
            }
        }
        return fallback;
    }

    private static String requiredHeader(HttpExchange exchange, String name) {
        String value = exchange.getRequestHeaders().getFirst(name);
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " header is required");
        return value.trim();
    }

    private static String optionalHeader(HttpExchange exchange, String name, String fallback) {
        String value = exchange.getRequestHeaders().getFirst(name);
        return value == null || value.isBlank() ? fallback : value.trim();
    }

    private void methodNotAllowed(HttpExchange exchange, String allow) throws IOException {
        exchange.getResponseHeaders().set("Allow", allow);
        error(exchange, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
    }

    private void error(HttpExchange exchange, int status, String code, String message) throws IOException {
        String requestId = safeIdentity(exchange.getRequestHeaders().getFirst("X-Request-ID"));
        if (requestId == null) requestId = UUID.randomUUID().toString();
        String correlationId = safeIdentity(exchange.getRequestHeaders().getFirst("X-Correlation-ID"));
        if (correlationId == null) correlationId = requestId;
        exchange.getResponseHeaders().set("X-Request-ID", requestId);
        exchange.getResponseHeaders().set("X-Correlation-ID", correlationId);
        json(exchange, status, Map.of(
                "error", Map.of("code", code, "message", message, "retryable", isRetryable(status),
                        "evidenceRefs", List.of(), "actionRefs", List.of()),
                "meta", Map.of("requestId", requestId, "correlationId", correlationId,
                        "timestamp", Instant.now().toString(), "apiVersion", "1.0.0")));
    }

    private void json(HttpExchange exchange, int status, Object body) throws IOException {
        byte[] bytes = mapper.writeValueAsBytes(body);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, bytes.length);
        try (var output = exchange.getResponseBody()) { output.write(bytes); }
    }

    private static String decode(String value) { return URLDecoder.decode(value, StandardCharsets.UTF_8); }
    private static boolean isRetryable(int status) {
        return status == 429 || status == 502 || status == 503 || status == 504;
    }

    private static String safeIdentity(String value) {
        if (value == null || value.isBlank() || value.length() > 255) return null;
        return value.chars().allMatch(character -> character >= 0x21 && character <= 0x7e) ? value : null;
    }

    private record ConsentGrantBody(
            Set<String> purposes,
            Set<String> allowedRegions,
            boolean externalProcessingAllowed,
            boolean biometricProcessingAllowed,
            Instant expiresAt) {
        private ConsentGrantBody {
            purposes = Set.copyOf(purposes == null ? Set.of() : purposes);
            allowedRegions = Set.copyOf(allowedRegions == null ? Set.of() : allowedRegions);
        }
    }
}
