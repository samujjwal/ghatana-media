package com.ghatana.media.launcher;

import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;
import com.ghatana.media.runtime.MediaCapabilityNotAdmittedException;
import com.ghatana.media.runtime.MediaConsentAdministration;
import com.ghatana.media.runtime.MediaMetadataSanitizer;
import com.ghatana.audiovideo.observability.MediaWorkflowMetrics;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamFrame;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSession;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSessionRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamState;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
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
    private static final Pattern CHUNK_PATH = Pattern.compile("^/api/v1/artifacts/uploads/([^/]+)/chunks/(-?\\d+)$");
    private static final Pattern COMPLETE_PATH = Pattern.compile("^/api/v1/artifacts/uploads/([^/]+)/complete$");
    private static final Pattern ARTIFACT_PATH = Pattern.compile("^/api/v1/artifacts/([^/]+)$");
    private static final Pattern JOB_PATH = Pattern.compile("^/api/v1/jobs/([^/]+)$");
    private static final Pattern CANCEL_PATH = Pattern.compile("^/api/v1/jobs/([^/]+)/cancel$");
    private static final Pattern STREAM_PATH = Pattern.compile("^/api/v1/streams/([^/]+)$");
    private static final Pattern STREAM_CONNECT_PATH = Pattern.compile("^/api/v1/streams/([^/]+)/connect$");
    private static final Pattern STREAM_FRAME_PATH = Pattern.compile("^/api/v1/streams/([^/]+)/frames/(\\d+)$");
    private static final Pattern STREAM_CLOSE_PATH = Pattern.compile("^/api/v1/streams/([^/]+)/close$");
    private static final Pattern CONSENT_PATH = Pattern.compile("^/api/v1/consents/([^/]+)$");
    private static final Pattern CAPTION_VERSION_PATH = Pattern.compile("^/api/v1/caption-versions/([^/]+)$");

    private final MediaRuntime runtime;
    private final MediaConsentAdministration consentAdministration;
    private final MediaCaptionRuntime captions;
    private final ObjectMapper mapper = JsonMapper.builder().addModules(tools.jackson.databind.cfg.MapperBuilder.findModules()).build();

    public MediaHttpHandler(MediaRuntime runtime) {
        this(runtime, null, null);
    }

    public MediaHttpHandler(MediaRuntime runtime, MediaConsentAdministration consentAdministration) {
        this(runtime, consentAdministration, null);
    }

    public MediaHttpHandler(MediaRuntime runtime, MediaConsentAdministration consentAdministration,
                            MediaCaptionRuntime captions) {
        this.runtime = java.util.Objects.requireNonNull(runtime, "runtime");
        this.consentAdministration = consentAdministration;
        this.captions = captions;
    }

    @Override
    public void handle(HttpExchange exchange) throws IOException {
        // Route against the raw path so each dynamic segment is decoded exactly once below.
        // URI#getPath() is already decoded; decoding a captured value again can turn an
        // encoded percent sequence into a path separator and select a different resource.
        String requestPath = exchange.getRequestURI().getRawPath();
        io.micrometer.core.instrument.Timer.Sample requestSample = HEALTH_PATHS.contains(requestPath)
                ? null : runtime.startWorkflowStage();
        try {
            String path = requestPath;
            String method = exchange.getRequestMethod();
            if (HEALTH_PATHS.contains(path)) {
                if (!"GET".equals(method)) { methodNotAllowed(exchange, "GET"); return; }
                health(exchange, path);
                return;
            }
            runtime.recordHttpRequest();
            if (!runtime.ready()) {
                error(exchange, 503, "RUNTIME_NOT_READY", "Media Runtime is not ready");
                return;
            }
            MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated =
                    MediaSecurityFilter.authenticatedPrincipal(exchange);
            if (authenticated == null) {
                runtime.recordDeniedRequest();
                error(exchange, 401, "UNAUTHENTICATED", "Authenticated Media identity is required");
                return;
            }
            String tenantId = authenticated.tenantId();
            String principalId = authenticated.principalId();

            if ("/api/v1/consents".equals(path)) {
                if ("POST".equals(method)) grantConsent(exchange, tenantId);
                else if ("GET".equals(method)) listConsents(exchange, tenantId);
                else methodNotAllowed(exchange, "GET, POST");
                return;
            }
            Matcher consent = CONSENT_PATH.matcher(path);
            if (consent.matches()) {
                String consentId = decodePathSegment(consent.group(1));
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
                appendChunk(exchange, tenantId, principalId, decodePathSegment(chunk.group(1)), Integer.parseInt(chunk.group(2))); return;
            }
            Matcher complete = COMPLETE_PATH.matcher(path);
            if (complete.matches()) {
                if (!"POST".equals(method)) { methodNotAllowed(exchange, "POST"); return; }
                completeUpload(exchange, tenantId, principalId, decodePathSegment(complete.group(1))); return;
            }
            Matcher upload = UPLOAD_PATH.matcher(path);
            if (upload.matches()) {
                if (!"GET".equals(method)) { methodNotAllowed(exchange, "GET"); return; }
                upload(exchange, tenantId, principalId, decodePathSegment(upload.group(1))); return;
            }
            Matcher artifact = ARTIFACT_PATH.matcher(path);
            if (artifact.matches()) {
                if (!"GET".equals(method)) { methodNotAllowed(exchange, "GET"); return; }
                artifact(exchange, tenantId, principalId, decodePathSegment(artifact.group(1))); return;
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
                cancel(exchange, tenantId, principalId, decodePathSegment(cancel.group(1))); return;
            }
            Matcher job = JOB_PATH.matcher(path);
            if (job.matches()) {
                if (!"GET".equals(method)) { methodNotAllowed(exchange, "GET"); return; }
                job(exchange, tenantId, principalId, decodePathSegment(job.group(1))); return;
            }
            if ("/api/v1/streams".equals(path)) {
                if (!"POST".equals(method)) { methodNotAllowed(exchange, "POST"); return; }
                openStream(exchange, tenantId, principalId); return;
            }
            Matcher connect = STREAM_CONNECT_PATH.matcher(path);
            if (connect.matches()) {
                if (!"POST".equals(method)) { methodNotAllowed(exchange, "POST"); return; }
                connectStream(exchange, tenantId, principalId, decodePathSegment(connect.group(1))); return;
            }
            Matcher frame = STREAM_FRAME_PATH.matcher(path);
            if (frame.matches()) {
                if (!"POST".equals(method)) { methodNotAllowed(exchange, "POST"); return; }
                frame(exchange, tenantId, principalId, decodePathSegment(frame.group(1)), Long.parseLong(frame.group(2))); return;
            }
            Matcher close = STREAM_CLOSE_PATH.matcher(path);
            if (close.matches()) {
                if (!"POST".equals(method)) { methodNotAllowed(exchange, "POST"); return; }
                closeStream(exchange, tenantId, principalId, decodePathSegment(close.group(1))); return;
            }
            Matcher stream = STREAM_PATH.matcher(path);
            if (stream.matches()) {
                if (!"GET".equals(method)) { methodNotAllowed(exchange, "GET"); return; }
                stream(exchange, tenantId, principalId, decodePathSegment(stream.group(1))); return;
            }
            if ("/api/v1/caption-versions".equals(path)) {
                if ("POST".equals(method)) registerCaptionVersion(exchange, tenantId, principalId);
                else if ("GET".equals(method)) listCaptionVersions(exchange, tenantId, principalId);
                else methodNotAllowed(exchange, "GET, POST");
                return;
            }
            Matcher captionVersion = CAPTION_VERSION_PATH.matcher(path);
            if (captionVersion.matches()) {
                if (!"GET".equals(method)) { methodNotAllowed(exchange, "GET"); return; }
                readCaptionVersion(exchange, tenantId, principalId, decodePathSegment(captionVersion.group(1)));
                return;
            }
            if ("/api/v1/providers".equals(path)) {
                if (!"GET".equals(method)) { methodNotAllowed(exchange, "GET"); return; }
                providers(exchange); return;
            }
            error(exchange, 404, "NOT_FOUND", "Route not found");
        } catch (MediaCapabilityNotAdmittedException failure) {
            admissionFailure(exchange, failure);
        } catch (SecurityException failure) {
            runtime.recordDeniedRequest();
            error(exchange, 403, "TENANT_FORBIDDEN", "Request tenant is not permitted");
        } catch (IllegalArgumentException failure) {
            error(exchange, 400, "INVALID_REQUEST", "Media request is invalid");
        } catch (IllegalStateException failure) {
            error(exchange, 409, "MEDIA_STATE_CONFLICT", "Media resource state changed; re-read before retrying");
        } catch (Exception failure) {
            error(exchange, 500, "INTERNAL_ERROR", "Media Runtime request failed");
        } finally {
            runtime.stopWorkflowStage(requestSample, MediaWorkflowMetrics.Stage.REQUEST);
        }
    }

    private void grantConsent(HttpExchange exchange, String tenantId) throws IOException {
        MediaConsentAdministration administration = requireConsentAdministration();
        String principalId = requiredHeader(exchange, "X-Principal-Id");
        ConsentGrantBody body;
        try {
            body = mapper.readValue(
                    boundedBody(exchange, runtime.config().maximumBodyBytes()), ConsentGrantBody.class);
        } catch (Exception invalidBody) {
            throw new IllegalArgumentException("Consent grant body is invalid", invalidBody);
        }
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
        UploadRequest request;
        try {
            request = mapper.readValue(
                    boundedBody(exchange, runtime.config().maximumBodyBytes()), UploadRequest.class);
        } catch (Exception invalidBody) {
            throw new IllegalArgumentException("Upload request body is invalid", invalidBody);
        }
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
        String idempotencyKey = requiredHeader(exchange, "Idempotency-Key");
        json(exchange, 201, runtime.beginUpload(sanitized, idempotencyKey, authenticatedPrincipal(exchange)));
    }

    private void appendChunk(
            HttpExchange exchange, String tenantId, String principalId, String uploadId, int index) throws IOException {
        UploadSession existing = runtime.upload(tenantId, principalId, uploadId).orElse(null);
        if (existing == null) {
            error(exchange, 404, "UPLOAD_NOT_FOUND", "Upload session not found");
            return;
        }
        json(exchange, 200, runtime.appendUploadChunk(
                authenticatedPrincipal(exchange), uploadId, index,
                boundedBody(exchange, runtime.config().maximumChunkBytes())));
    }

    private void completeUpload(
            HttpExchange exchange, String tenantId, String principalId, String uploadId) throws IOException {
        UploadSession existing = runtime.upload(tenantId, principalId, uploadId).orElse(null);
        if (existing == null) {
            error(exchange, 404, "UPLOAD_NOT_FOUND", "Upload session not found");
            return;
        }
        json(exchange, 201, runtime.completeUpload(authenticatedPrincipal(exchange), uploadId));
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
        ProcessingJobRequest request;
        try {
            request = mapper.readValue(
                    boundedBody(exchange, runtime.config().maximumBodyBytes()), ProcessingJobRequest.class);
        } catch (Exception invalidBody) {
            throw new IllegalArgumentException("Job request body is invalid", invalidBody);
        }
        if (!tenantId.equals(request.tenantId())) throw new SecurityException("Job tenant does not match authenticated tenant");
        if (!principalId.equals(request.principalId())) {
            throw new SecurityException("Job principal does not match authenticated principal");
        }
        ProcessingJob submitted = runtime.submit(request, authenticatedPrincipal(exchange));
        operationStatusHeaders(exchange, "/api/v1/jobs/" + submitted.jobId());
        json(exchange, 202, runtime.projectJobView(submitted));
    }

    private void listJobs(HttpExchange exchange, String tenantId, String principalId) throws IOException {
        var jobs = runtime.jobViews(tenantId, principalId, queryLimit(exchange, 100));
        json(exchange, 200, Map.of("jobs", jobs));
    }

    private void job(HttpExchange exchange, String tenantId, String principalId, String jobId) throws IOException {
        ProcessingJob job = runtime.job(tenantId, principalId, jobId).orElse(null);
        String requestId = reconciliationRequestId(exchange);
        if (job == null || !matchesRequestIdentity(job, requestId)) {
            error(exchange, 404, "JOB_NOT_FOUND", "Media job not found"); return;
        }
        json(exchange, 200, runtime.projectJobView(job));
    }

    private void cancel(HttpExchange exchange, String tenantId, String principalId, String jobId) throws IOException {
        ProcessingJob existing = runtime.job(tenantId, principalId, jobId).orElse(null);
        if (existing == null) {
            error(exchange, 404, "JOB_NOT_FOUND", "Media job not found"); return;
        }
        json(exchange, 200, runtime.projectJobView(runtime.cancel(tenantId, principalId, jobId)));
    }

    private void openStream(HttpExchange exchange, String tenantId, String principalId) throws IOException {
        StreamSessionRequest request;
        try {
            request = mapper.readValue(
                    boundedBody(exchange, runtime.config().maximumBodyBytes()), StreamSessionRequest.class);
        } catch (Exception invalidBody) {
            throw new IllegalArgumentException("Stream session request body is invalid", invalidBody);
        }
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
        var registration = runtime.openStream(sanitized, authenticatedPrincipal(exchange));
        json(exchange, 201, new StreamSessionRegistrationView(
                streamSessionView(registration.session()), registration.connectionToken()));
    }

    private void connectStream(
            HttpExchange exchange, String tenantId, String principalId, String sessionId) throws IOException {
        if (runtime.stream(tenantId, principalId, sessionId).isEmpty()) {
            error(exchange, 404, "STREAM_NOT_FOUND", "Media stream not found"); return;
        }
        json(exchange, 200, streamSessionView(runtime.connectStream(
                tenantId, principalId, sessionId, requiredHeader(exchange, "X-Stream-Token"))));
    }

    private void frame(
            HttpExchange exchange, String tenantId, String principalId, String sessionId, long sequence) throws IOException {
        if (runtime.stream(tenantId, principalId, sessionId).isEmpty()) {
            error(exchange, 404, "STREAM_NOT_FOUND", "Media stream not found"); return;
        }
        boolean end = Boolean.parseBoolean(optionalHeader(exchange, "X-End-Of-Stream", "false"));
        byte[] payload = boundedBody(exchange, runtime.config().maximumChunkBytes(), end);
        var acknowledgement = runtime.acceptFrame(new StreamFrame(
                tenantId, sessionId, requiredHeader(exchange, "X-Stream-Token"),
                sequence, payload, end, Instant.now()));
        operationStatusHeaders(exchange, "/api/v1/streams/" + sessionId);
        json(exchange, 202, acknowledgement);
    }

    private void closeStream(
            HttpExchange exchange, String tenantId, String principalId, String sessionId) throws IOException {
        if (runtime.stream(tenantId, principalId, sessionId).isEmpty()) {
            error(exchange, 404, "STREAM_NOT_FOUND", "Media stream not found"); return;
        }
        json(exchange, 200, streamSessionView(runtime.closeStream(
                tenantId, principalId, sessionId, requiredHeader(exchange, "X-Stream-Token"))));
    }

    private void stream(HttpExchange exchange, String tenantId, String principalId, String sessionId) throws IOException {
        StreamSession session = runtime.stream(tenantId, principalId, sessionId).orElse(null);
        if (session == null) {
            error(exchange, 404, "STREAM_NOT_FOUND", "Media stream not found"); return;
        }
        json(exchange, 200, streamSessionView(session));
    }

    private static StreamSessionView streamSessionView(StreamSession session) {
        return new StreamSessionView(session.tenantId(), session.sessionId(), session.principalId(),
                session.streamKind(), session.providerId(), session.state(), session.lastSequence(),
                session.bufferedBytes(), session.maximumBufferedBytes(), session.reconnectCount(),
                session.leaseExpiresAt(), session.createdAt(), session.updatedAt(), session.closedAt(),
                session.metadata(), session.version(), session.acknowledgementRevision(), session.finality());
    }

    private void registerCaptionVersion(
            HttpExchange exchange, String tenantId, String principalId) throws IOException {
        MediaCaptionRuntime captionRuntime = requireCaptionRuntime();
        CaptionRegistrationBody body;
        try {
            body = mapper.readValue(
                    boundedBody(exchange, runtime.config().maximumBodyBytes()), CaptionRegistrationBody.class);
        } catch (Exception invalidBody) {
            throw new IllegalArgumentException("Caption registration body is invalid", invalidBody);
        }
        com.ghatana.media.runtime.MediaCaptionContracts.RegistrationRequest request;
        try {
            request = body.toRequest();
        } catch (com.ghatana.media.runtime.MediaCaptionContracts.CaptionRegistrationException invalid) {
            captionRejected(exchange, body.requestId(), null,
                    new com.ghatana.media.runtime.MediaCaptionContracts.Rejected(
                            body.requestId() == null ? "" : body.requestId(), null, invalid.error(), false));
            return;
        }
        // A caller-supplied fingerprint must equal the authoritative server-side digest; a
        // mismatch proves client/contract drift and fails closed before any durable effect.
        if (body.requestFingerprint() != null
                && !body.requestFingerprint().equals(
                        com.ghatana.media.runtime.MediaCaptionContracts.fingerprint(
                                tenantId, principalId, request))) {
            error(exchange, 400, "INVALID_REQUEST", "Supplied requestFingerprint does not match the canonical digest",
                    Map.of("error", "INVALID_REQUEST"));
            return;
        }
        var result = captionRuntime.register(tenantId, principalId, request);
        if (result instanceof com.ghatana.media.runtime.MediaCaptionContracts.Registered registered) {
            json(exchange, 201, registered);
        } else if (result instanceof com.ghatana.media.runtime.MediaCaptionContracts.Rejected rejected) {
            captionRejected(exchange, rejected.requestId(), rejected.requestFingerprint(), rejected);
        } else {
            error(exchange, 503, "UNKNOWN_OUTCOME", "Caption registration outcome is uncertain; reconcile by requestId",
                    Map.of("error", "UNKNOWN_OUTCOME", "retryable", true));
        }
    }

    private void captionRejected(HttpExchange exchange, String requestId, String fingerprint,
                                 com.ghatana.media.runtime.MediaCaptionContracts.Rejected rejected)
            throws IOException {
        int status = switch (rejected.error()) {
            case INVALID_REQUEST -> 400;
            case IDEMPOTENCY_CONFLICT, CAPTION_VERSION_CONFLICT, SOURCE_NOT_READY -> 409;
            case ACCESS_DENIED, VERSION_REGISTRATION_NOT_ALLOWED -> 403;
            case UNAVAILABLE, UNKNOWN_OUTCOME -> 503;
            default -> 422;
        };
        error(exchange, status, rejected.error().name(),
                "Caption version registration rejected", Map.of(
                        "requestId", rejected.requestId() == null ? "" : rejected.requestId(),
                        "requestFingerprint", rejected.requestFingerprint() == null
                                ? "" : rejected.requestFingerprint(),
                        "error", rejected.error().name(),
                        "retryable", rejected.retryable()));
    }

    private void listCaptionVersions(
            HttpExchange exchange, String tenantId, String principalId) throws IOException {
        MediaCaptionRuntime captionRuntime = requireCaptionRuntime();
        String sourceArtifactId = requiredQuery(exchange, "sourceArtifactId");
        String sourceArtifactVersionId = requiredQuery(exchange, "sourceArtifactVersionId");
        var versions = captionRuntime.versions(tenantId, principalId, sourceArtifactId, sourceArtifactVersionId);
        json(exchange, 200, Map.of("captionVersions", versions, "count", versions.size()));
    }

    private void readCaptionVersion(HttpExchange exchange, String tenantId, String principalId,
                                    String captionVersionId) throws IOException {
        MediaCaptionRuntime captionRuntime = requireCaptionRuntime();
        var snapshot = captionRuntime.version(tenantId, principalId, captionVersionId);
        if (snapshot.isEmpty()) {
            error(exchange, 404, "CAPTION_VERSION_NOT_FOUND", "Caption version not found");
            return;
        }
        json(exchange, 200, snapshot.orElseThrow());
    }

    private MediaCaptionRuntime requireCaptionRuntime() {
        if (captions == null || !captions.ready()) {
            throw new MediaCapabilityNotAdmittedException(
                    MediaCapabilityNotAdmittedException.Reason.PROVIDER_UNAVAILABLE, "caption-version");
        }
        return captions;
    }

    private static String requiredQuery(HttpExchange exchange, String name) {
        String query = exchange.getRequestURI().getRawQuery();
        String value = null;
        if (query != null) {
            for (String part : query.split("&")) {
                String[] pair = part.split("=", 2);
                if (pair.length == 2 && name.equals(decode(pair[0]))) {
                    if (value != null) throw new IllegalArgumentException(name + " must be supplied once");
                    value = decode(pair[1]);
                }
            }
        }
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " query parameter is required");
        return value;
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
        response.put("metadataIntegration", "data-cloud-capability");
        response.put("genericModelIntegration", "ai-inference-capability");
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
            String accept = exchange.getRequestHeaders().getFirst("Accept");
            if (accept != null && (accept.contains("text/plain") || accept.contains("application/openmetrics-text"))) {
                byte[] bytes = runtime.prometheusMetrics().getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
                exchange.getResponseHeaders().set("Cache-Control", "no-store");
                exchange.sendResponseHeaders(200, bytes.length);
                try (var output = exchange.getResponseBody()) { output.write(bytes); }
            } else {
                Map<String, Object> snapshot = runtime.healthSnapshot();
                json(exchange, 200, Map.of(
                        "service", "media", "ready", ready,
                        "activeJobs", snapshot.get("activeJobs"),
                        "activeStreams", snapshot.get("activeStreams")));
            }
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
            throw new MediaCapabilityNotAdmittedException(
                    MediaCapabilityNotAdmittedException.Reason.PROVIDER_UNAVAILABLE, "consent-administration");
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
        Integer limit = null;
        for (String part : query.split("&")) {
            String[] pair = part.split("=", 2);
            if (pair.length > 0 && "limit".equals(decode(pair[0]))) {
                if (limit != null || pair.length != 2) {
                    throw new IllegalArgumentException("limit must be supplied once with a value");
                }
                try {
                    limit = Integer.parseInt(decode(pair[1]));
                } catch (NumberFormatException failure) {
                    throw new IllegalArgumentException("limit must be an integer", failure);
                }
                if (limit < 1 || limit > 1_000) {
                    throw new IllegalArgumentException("limit must be between 1 and 1000");
                }
            }
        }
        return limit == null ? fallback : limit;
    }

    /** Optional exact request identity for a read-only reconciliation lookup. */
    private static String reconciliationRequestId(HttpExchange exchange) {
        String query = exchange.getRequestURI().getRawQuery();
        if (query == null) return null;
        String requestId = null;
        for (String part : query.split("&")) {
            String[] pair = part.split("=", 2);
            if (pair.length > 0 && "requestId".equals(decode(pair[0]))) {
                if (requestId != null || pair.length != 2) {
                    throw new IllegalArgumentException("requestId must be supplied once");
                }
                requestId = decode(pair[1]);
                if (requestId.isBlank() || requestId.codePointCount(0, requestId.length()) > 255) {
                    throw new IllegalArgumentException("requestId must contain between 1 and 255 characters");
                }
            }
        }
        return requestId;
    }

    static boolean matchesRequestIdentity(ProcessingJob job, String requestId) {
        return requestId == null || requestId.equals(job.requestId());
    }

    private static String requiredHeader(HttpExchange exchange, String name) {
        if ("X-Tenant-Id".equalsIgnoreCase(name)) return authenticatedPrincipal(exchange).tenantId();
        if ("X-Principal-Id".equalsIgnoreCase(name)) return authenticatedPrincipal(exchange).principalId();
        String value = exchange.getRequestHeaders().getFirst(name);
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " header is required");
        return value.trim();
    }

    private static MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticatedPrincipal(
            HttpExchange exchange) {
        MediaSourceAuthorizationContracts.AuthenticatedPrincipal principal =
                MediaSecurityFilter.authenticatedPrincipal(exchange);
        if (principal == null) throw new SecurityException("Authenticated Media identity is unavailable");
        return principal;
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
        error(exchange, status, code, message, Map.of());
    }

    private void admissionFailure(
            HttpExchange exchange, MediaCapabilityNotAdmittedException failure) throws IOException {
        int status;
        String code;
        String message;
        switch (failure.reason()) {
            case NOT_ADMITTED -> {
                status = 422;
                code = "MEDIA_CAPABILITY_NOT_ADMITTED";
                message = "The requested Media capability is not admitted";
            }
            case PROVIDER_UNAVAILABLE -> {
                status = 503;
                code = "MEDIA_PROVIDER_UNAVAILABLE";
                message = "The admitted Media capability is temporarily unavailable";
            }
            case POLICY_DENIED -> {
                status = 403;
                code = "MEDIA_POLICY_DENIED";
                message = "The Media request was denied by policy";
            }
            case SOURCE_VERSION_STALE -> {
                status = 409;
                code = "MEDIA_SOURCE_VERSION_STALE";
                message = "The Media source version is stale; select a current version";
            }
            default -> throw new IllegalStateException("Unhandled Media admission reason");
        }
        error(exchange, status, code, message, Map.of(
                "reason", failure.reason().name(),
                "modality", failure.modality()));
    }

    private void error(
            HttpExchange exchange, int status, String code, String message, Map<String, ?> details)
            throws IOException {
        String requestId = safeIdentity(exchange.getRequestHeaders().getFirst("X-Request-ID"));
        if (requestId == null) requestId = UUID.randomUUID().toString();
        String correlationId = safeIdentity(exchange.getRequestHeaders().getFirst("X-Correlation-ID"));
        if (correlationId == null) correlationId = requestId;
        exchange.getResponseHeaders().set("X-Request-ID", requestId);
        exchange.getResponseHeaders().set("X-Correlation-ID", correlationId);
        Map<String, Object> error = new java.util.LinkedHashMap<>();
        error.put("code", code);
        error.put("message", message);
        error.put("retryable", isRetryable(status));
        error.put("evidenceRefs", List.of());
        error.put("actionRefs", List.of());
        if (details != null && !details.isEmpty()) error.put("details", Map.copyOf(details));
        json(exchange, status, Map.of(
                "error", Map.copyOf(error),
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

    private static void operationStatusHeaders(HttpExchange exchange, String statusPath) {
        exchange.getResponseHeaders().set("Location", statusPath);
        exchange.getResponseHeaders().set("Retry-After", "1");
    }

    private static String decode(String value) { return URLDecoder.decode(value, StandardCharsets.UTF_8); }

    private static String decodePathSegment(String value) {
        String decoded = URLDecoder.decode(value.replace("+", "%2B"), StandardCharsets.UTF_8);
        if (decoded.indexOf('/') >= 0 || decoded.indexOf('\\') >= 0) {
            throw new IllegalArgumentException("Path identifier must not contain a separator");
        }
        return decoded;
    }
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

    private record StreamSessionRegistrationView(StreamSessionView session, String connectionToken) { }

    /** HTTP body for media.operation.caption-version-write; converted into the validated contract request. */
    private record CaptionRegistrationBody(
            String requestId,
            String requestFingerprint,
            String sourceArtifactId,
            String sourceArtifactVersionId,
            String parentVersionKind,
            String parentVersionId,
            String sourceClockId,
            long ticksPerSecond,
            long sourceDurationTicks,
            String languageDisposition,
            String languageTag,
            java.util.List<CaptionSegmentBody> captionSegments,
            String purpose) {
        com.ghatana.media.runtime.MediaCaptionContracts.RegistrationRequest toRequest() {
            java.util.List<com.ghatana.media.runtime.MediaCaptionContracts.CaptionSegment> segments =
                    new java.util.ArrayList<>();
            if (captionSegments != null) {
                for (CaptionSegmentBody segment : captionSegments) {
                    if (segment == null) throw new IllegalArgumentException("caption segment is required");
                    segments.add(new com.ghatana.media.runtime.MediaCaptionContracts.CaptionSegment(
                            segment.segmentId(), segment.text() == null ? "" : segment.text(),
                            segment.startTick(), segment.endTick(),
                            com.ghatana.media.runtime.MediaCaptionContracts.SegmentOrigin.valueOf(
                                    segment.origin() == null ? "" : segment.origin()),
                            segment.speakerLabel() == null ? java.util.Optional.empty()
                                    : java.util.Optional.of(segment.speakerLabel())));
                }
            }
            return new com.ghatana.media.runtime.MediaCaptionContracts.RegistrationRequest(
                    requestId, sourceArtifactId, sourceArtifactVersionId,
                    com.ghatana.media.runtime.MediaCaptionContracts.ParentVersionKind.valueOf(
                            parentVersionKind == null ? "" : parentVersionKind),
                    parentVersionId, sourceClockId, ticksPerSecond, sourceDurationTicks,
                    com.ghatana.media.runtime.MediaCaptionContracts.LanguageDisposition.valueOf(
                            languageDisposition == null ? "" : languageDisposition),
                    languageTag == null ? java.util.Optional.empty() : java.util.Optional.of(languageTag),
                    segments,
                    purpose == null ? java.util.Optional.empty() : java.util.Optional.of(purpose));
        }
    }

    private record CaptionSegmentBody(
            String segmentId, String text, long startTick, long endTick,
            String origin, String speakerLabel) { }

    /** HTTP projection that omits credential hashes and internal provider-attempt identifiers. */
    private record StreamSessionView(
            String tenantId,
            String sessionId,
            String principalId,
            StreamKind streamKind,
            String providerId,
            StreamState state,
            long lastSequence,
            long bufferedBytes,
            long maximumBufferedBytes,
            int reconnectCount,
            Instant leaseExpiresAt,
            Instant createdAt,
            Instant updatedAt,
            Instant closedAt,
            Map<String, Object> metadata,
            long version,
            long acknowledgementRevision,
            StreamFinality finality) { }
}
