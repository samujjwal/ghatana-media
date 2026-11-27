package com.ghatana.media.launcher;

import com.ghatana.launcher.config.RuntimeSecretReference;
import com.ghatana.media.runtime.MediaLifecycleEvent;
import com.ghatana.media.runtime.MediaLifecycleEventPublisher;
import com.ghatana.media.runtime.MediaLifecyclePublicationReceipt;
import com.ghatana.media.runtime.MediaLifecyclePublicationOutcomeUnknownException;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.InputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/** Typed Event Plane client for neutral Media lifecycle events. */
final class MediaLifecyclePublisher implements MediaLifecycleEventPublisher {
    private static final int MAX_EVENT_PLANE_IDENTIFIER_LENGTH = 255;
    private static final int MAX_APPEND_RECEIPT_BYTES = 8 * 1024;
    private static final int MAX_EVENT_READBACK_BYTES = 64 * 1024;
    private static final String ACCEPTED_JOB_EVENT_TYPE = "media.job.accepted";
    private static final Set<String> ACCEPTED_JOB_PAYLOAD_FIELDS =
            Set.of("jobId", "operationRef", "admissionState");

    private final ObjectMapper mapper = JsonMapper.builder().addModules(tools.jackson.databind.cfg.MapperBuilder.findModules()).build();
    private final HttpClient client;
    private final URI endpoint;
    private final URI readEndpoint;
    private final String streamId;
    private final String bearerToken;
    private final String readerBearerToken;
    private final Duration timeout;
    private final boolean relayEnabled;
    private final AtomicBoolean closed = new AtomicBoolean(false);

    private MediaLifecyclePublisher(
            URI endpoint, URI readEndpoint, String streamId, String bearerToken, String readerBearerToken,
            Duration timeout, boolean relayEnabled) {
        this.endpoint = endpoint;
        this.readEndpoint = readEndpoint;
        this.streamId = streamId;
        this.bearerToken = bearerToken;
        this.readerBearerToken = readerBearerToken;
        this.timeout = timeout;
        this.relayEnabled = relayEnabled;
        this.client = endpoint == null ? null : HttpClient.newBuilder()
                .connectTimeout(timeout).followRedirects(HttpClient.Redirect.NEVER).build();
    }

    static MediaLifecyclePublisher compose(Map<String, String> environment, boolean productionLike) {
        String profile = environment.getOrDefault(
                "MEDIA_RUNTIME_ENVIRONMENT", environment.getOrDefault("MEDIA_PROFILE", "local"))
                .trim().toLowerCase(java.util.Locale.ROOT);
        boolean devOnlyHost = !productionLike && "dev".equals(profile)
                && strictBoolean(environment, "MEDIA_DEV_IDENTITY_ENABLED", false);
        if (!productionLike && !devOnlyHost) return disabled();

        String base = environment.getOrDefault("MEDIA_EVENT_PLANE_URL", "").trim();
        if (base.isBlank()) {
            if (productionLike) {
                throw new IllegalStateException(
                        "MEDIA_EVENT_PLANE_URL is required for production Media lifecycle publication");
            }
            return disabled();
        }
        URI baseUri = URI.create(base.endsWith("/") ? base : base + "/");
        if (!baseUri.isAbsolute() || baseUri.getHost() == null
                || !("http".equalsIgnoreCase(baseUri.getScheme())
                || "https".equalsIgnoreCase(baseUri.getScheme()))) {
            throw new IllegalArgumentException("MEDIA_EVENT_PLANE_URL must be an absolute HTTP(S) URI");
        }
        if (productionLike && !"https".equalsIgnoreCase(baseUri.getScheme())) {
            throw new IllegalStateException("Production Media Event Plane publication requires HTTPS");
        }
        if (!productionLike && !"https".equalsIgnoreCase(baseUri.getScheme())
                && !isLoopbackHost(baseUri.getHost())) {
            throw new IllegalStateException(
                    "DEV_ONLY Media Event Plane publication requires HTTPS or a loopback destination");
        }
        String streamId = environment.getOrDefault(
                "MEDIA_EVENT_PLANE_STREAM_ID", "media-lifecycle").trim();
        if (streamId.isBlank() || streamId.length() > 255) {
            throw new IllegalArgumentException("MEDIA_EVENT_PLANE_STREAM_ID must be bounded and non-blank");
        }
        String appendTokenReference = environment.getOrDefault("MEDIA_EVENT_PLANE_TOKEN_REFERENCE", "").trim();
        String readTokenReference = environment.getOrDefault("MEDIA_EVENT_PLANE_READ_TOKEN_REFERENCE", "").trim();
        String token = RuntimeSecretReference.resolveOptionalEnvironment(
                environment,
                appendTokenReference,
                "Media Event Plane bearer token",
                devOnlyHost);
        String readerToken = RuntimeSecretReference.resolveOptionalEnvironment(
                environment,
                readTokenReference,
                "Media Event Plane read bearer token",
                devOnlyHost);
        if (devOnlyHost && readTokenReference.equals(appendTokenReference)) {
            throw new IllegalArgumentException(
                    "Media Event Plane append and exact-lookup authorities require separate secret references");
        }
        Duration timeout = Duration.ofMillis(longValue(
                environment, "MEDIA_EVENT_PLANE_TIMEOUT_MS", 5_000L, 100L, 60_000L));
        String streamPath = "api/v1/streams/"
                + URLEncoder.encode(streamId, StandardCharsets.UTF_8).replace("+", "%20")
                + "/events";
        URI endpoint = baseUri.resolve(streamPath);
        URI readEndpoint = baseUri.resolve(streamPath + "/");
        // Receipt persistence is owned by the V016 outbox source. Production remains disabled
        // until its separate consumer-effect and host admission gates are satisfied.
        return new MediaLifecyclePublisher(endpoint, readEndpoint, streamId, token, readerToken,
                timeout, devOnlyHost);
    }

    static MediaLifecyclePublisher disabled() {
        return new MediaLifecyclePublisher(null, null, null, "", "", Duration.ofSeconds(1), false);
    }

    @Override public String publisherId() {
        return !relayEnabled || endpoint == null ? "disabled" : "event-plane-http";
    }
    @Override public boolean ready() { return !closed.get() && relayEnabled && endpoint != null; }

    /** HTTPS and credentials protect transport; only the V016 source persists append evidence. */
    @Override public boolean productionEligible() { return false; }

    @Override
    public void publish(MediaLifecycleEvent event) {
        publishWithReceipt(event);
    }

    @Override
    public MediaLifecyclePublicationReceipt publishWithReceipt(MediaLifecycleEvent event) {
        return publishWithReceipt(event, false);
    }

    @Override
    public MediaLifecyclePublicationReceipt publishWithReceipt(
            MediaLifecycleEvent event, boolean exactReadbackRequired) {
        if (!ready()) return null;
        java.util.Objects.requireNonNull(event, "event");
        boolean acceptedJobEvent = isAcceptedJobEvent(event);
        validateAcceptedJobEvent(event);
        requireEventPlaneText(event.eventId(), "eventId");
        requireEventPlaneText(event.eventType(), "eventType");
        requireEventPlaneText(event.tenantId(), "tenantId");
        if (!acceptedJobEvent) requireEventPlaneText(event.principalId(), "principalId");
        requireEventPlaneText(event.correlationId(), "correlationId");
        if (!event.causationId().isBlank()) requireEventPlaneText(event.causationId(), "causationId");
        byte[] requestBody;
        try {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("eventId", event.eventId());
            body.put("eventType", event.eventType());
            body.put("eventVersion", "1.0.0");
            body.put("timestamp", event.occurredAt().toString());
            body.put("correlationId", event.correlationId());
            if (!event.causationId().isBlank()) body.put("causationId", event.causationId());
            body.put("source", "media");
            if (!acceptedJobEvent) body.put("userId", event.principalId());
            body.put("contentType", "application/json");
            if (acceptedJobEvent) body.put("headers", mediaEventHeaders(event));
            body.put("payload", lifecyclePayload(event));
            requestBody = mapper.writeValueAsBytes(body);
        } catch (Exception failure) {
            if (failure instanceof RuntimeException runtime) throw runtime;
            throw new IllegalStateException("Unable to encode Media lifecycle event", failure);
        }
        String idempotencyKey = tenantScopedIdempotencyKey(event.tenantId(), event.eventId());
        if (exactReadbackRequired) {
            LookupResult priorOutcome;
            try {
                priorOutcome = lookup(event, idempotencyKey);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new MediaLifecyclePublicationOutcomeUnknownException(
                        "Media lifecycle exact lookup was interrupted", interrupted);
            } catch (Exception lookupFailure) {
                throw new MediaLifecyclePublicationOutcomeUnknownException(
                        "Media lifecycle exact lookup could not establish the prior append outcome", lookupFailure);
            }
            if (priorOutcome.receipt() != null) return priorOutcome.receipt();
            if (!priorOutcome.completeAbsence()) {
                throw new MediaLifecyclePublicationOutcomeUnknownException(
                        "Media lifecycle prior append remains unknown");
            }
        }
        // A prior claimed attempt makes this call's first POST the single permitted retry after
        // the preflight complete-absence read. A fresh call may make one initial POST plus one
        // exact-404-authorized replay. Never grant two retries in one invocation.
        int maximumAppendAttempts = exactReadbackRequired ? 1 : 2;
        for (int appendAttempt = 0; appendAttempt < maximumAppendAttempts; appendAttempt++) {
            boolean appendConflict = false;
            try {
                HttpRequest.Builder request = HttpRequest.newBuilder(endpoint)
                        .timeout(timeout)
                        .header("Content-Type", "application/json")
                        .header("Accept", "application/json")
                        .header("X-Tenant-Id", event.tenantId())
                        .header("Idempotency-Key", idempotencyKey);
                // Event Plane authentication derives this principal from the verified relay
                // workload credential. The submitting actor is event provenance, not authority.
                if (!acceptedJobEvent) {
                    request.header("X-Principal-Id", event.principalId());
                    request.header("X-Correlation-Id", event.correlationId());
                }
                request.POST(HttpRequest.BodyPublishers.ofByteArray(requestBody));
                if (!bearerToken.isBlank()) request.header("Authorization", "Bearer " + bearerToken);
                HttpResponse<InputStream> response = client.send(
                        request.build(), HttpResponse.BodyHandlers.ofInputStream());
                if (response.statusCode() >= 400 && response.statusCode() < 500
                        && response.statusCode() != 409) {
                    try {
                        response.body().close();
                    } catch (java.io.IOException ignored) {
                        // The HTTP status already proves this append was rejected.
                    }
                    throw new DefinitiveAppendRejectionException(
                            "Event Plane rejected Media lifecycle event with status " + response.statusCode());
                }
                appendConflict = response.statusCode() == 409;
                if (response.statusCode() != 201) {
                    response.body().close();
                } else {
                    String responseBody;
                    try (InputStream body = response.body()) {
                        byte[] bytes = body.readNBytes(MAX_APPEND_RECEIPT_BYTES + 1);
                        if (bytes.length > MAX_APPEND_RECEIPT_BYTES) {
                            responseBody = "";
                        } else {
                            responseBody = new String(bytes, StandardCharsets.UTF_8);
                        }
                    }
                    if (!responseBody.isEmpty()) {
                        try {
                            return validateAppendReceipt(responseBody, event, idempotencyKey);
                        } catch (Exception invalidReceipt) {
                            // Reconcile a possibly committed append with exact readback below.
                        }
                    }
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new MediaLifecyclePublicationOutcomeUnknownException(
                        "Media lifecycle append was interrupted before its outcome could be reconciled", interrupted);
            } catch (DefinitiveAppendRejectionException rejected) {
                throw rejected;
            } catch (Exception ambiguous) {
                // An I/O failure or invalid success receipt may follow a committed append.
            }

            LookupResult lookup;
            try {
                lookup = lookup(event, idempotencyKey);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new MediaLifecyclePublicationOutcomeUnknownException(
                        "Media lifecycle exact lookup was interrupted", interrupted);
            } catch (Exception lookupFailure) {
                throw new MediaLifecyclePublicationOutcomeUnknownException(
                        "Media lifecycle exact lookup could not establish the append outcome", lookupFailure);
            }
            if (lookup.receipt() != null) return lookup.receipt();
            if (!lookup.completeAbsence() || appendConflict
                    || appendAttempt + 1 >= maximumAppendAttempts) {
                throw new MediaLifecyclePublicationOutcomeUnknownException(
                        "Media lifecycle append remains unknown after exact lookup");
            }
        }
        throw new MediaLifecyclePublicationOutcomeUnknownException(
                "Media lifecycle append exceeded its bounded reconciliation attempts");
    }

    @Override public void close() { closed.set(true); }

    private static long longValue(
            Map<String, String> environment, String key, long fallback, long minimum, long maximum) {
        try {
            long value = Long.parseLong(environment.getOrDefault(key, Long.toString(fallback)).trim());
            if (value < minimum || value > maximum) {
                throw new IllegalArgumentException(key + " must be between " + minimum + " and " + maximum);
            }
            return value;
        } catch (NumberFormatException failure) {
            throw new IllegalArgumentException(key + " must be an integer", failure);
        }
    }

    private static boolean strictBoolean(Map<String, String> environment, String key, boolean fallback) {
        String value = environment.get(key);
        if (value == null || value.isBlank()) return fallback;
        if ("true".equalsIgnoreCase(value.trim())) return true;
        if ("false".equalsIgnoreCase(value.trim())) return false;
        throw new IllegalArgumentException(key + " must be true or false");
    }

    private static boolean isLoopbackHost(String host) {
        return host != null && ("localhost".equalsIgnoreCase(host)
                || "127.0.0.1".equals(host)
                || "::1".equals(host)
                || "[::1]".equals(host));
    }

    private MediaLifecyclePublicationReceipt validateAppendReceipt(
            String responseBody, MediaLifecycleEvent event, String idempotencyKey) throws Exception {
        Map<String, Object> receipt = mapper.readValue(responseBody,
                new TypeReference<Map<String, Object>>() { });
        String callerEventId = receiptText(receipt, "eventId");
        String storedEventId = receiptText(receipt, "storedEventId");
        String acceptedStreamId = receiptText(receipt, "streamId");
        String offset = receiptText(receipt, "offset");
        String acceptedIdempotencyKey = receiptText(receipt, "idempotencyKey");
        if (!event.eventId().equals(callerEventId)
                || !MediaLifecyclePublicationReceipt.stableStoredEventId(event.eventId()).equals(storedEventId)
                || !streamId.equals(acceptedStreamId)
                || !isNonNegativeOffset(offset)
                || !idempotencyKey.equals(acceptedIdempotencyKey)) {
            throw new IllegalStateException("Event Plane append receipt does not match the submitted event");
        }
        return new MediaLifecyclePublicationReceipt(callerEventId, storedEventId, acceptedStreamId, offset);
    }

    private LookupResult lookup(MediaLifecycleEvent event, String idempotencyKey) throws Exception {
        boolean acceptedJobEvent = isAcceptedJobEvent(event);
        URI lookupUri = URI.create(readEndpoint.toString()
                + URLEncoder.encode(event.eventId(), StandardCharsets.UTF_8).replace("+", "%20"));
        HttpRequest.Builder request = HttpRequest.newBuilder(lookupUri)
                .timeout(timeout)
                .header("Accept", "application/json")
                .header("X-Tenant-Id", event.tenantId());
        if (!acceptedJobEvent) {
            request.header("X-Principal-Id", event.principalId());
            request.header("X-Correlation-Id", event.correlationId());
        }
        request.GET();
        if (!readerBearerToken.isBlank()) request.header("Authorization", "Bearer " + readerBearerToken);
        HttpResponse<InputStream> response = client.send(request.build(), HttpResponse.BodyHandlers.ofInputStream());
        if (response.statusCode() == 404) {
            response.body().close();
            return new LookupResult(null, true);
        }
        if (response.statusCode() == 503 || response.statusCode() == 422) {
            response.body().close();
            throw new IllegalStateException("Event Plane exact lookup is indeterminate: " + response.statusCode());
        }
        if (response.statusCode() != 200) {
            response.body().close();
            throw new IllegalStateException("Event Plane exact lookup failed with status " + response.statusCode());
        }
        byte[] readback;
        try (InputStream body = response.body()) {
            readback = body.readNBytes(MAX_EVENT_READBACK_BYTES + 1);
        }
        if (readback.length > MAX_EVENT_READBACK_BYTES) {
            throw new IllegalStateException("Event Plane exact lookup exceeds its size limit");
        }
        Map<String, Object> record = mapper.readValue(readback,
                new TypeReference<Map<String, Object>>() { });
        MediaLifecyclePublicationReceipt receipt = validateReadback(record, event, idempotencyKey);
        return new LookupResult(receipt, false);
    }

    private MediaLifecyclePublicationReceipt validateReadback(
            Map<String, Object> record, MediaLifecycleEvent event, String idempotencyKey) throws Exception {
        String storedEventId = receiptText(record, "storedEventId");
        String storedAlias = receiptText(record, "eventId");
        String callerEventId = receiptText(record, "callerEventId");
        String acceptedStreamId = receiptText(record, "streamId");
        String offset = receiptText(record, "offset");
        String eventType = receiptText(record, "eventType");
        String eventVersion = receiptText(record, "eventVersion");
        String timestamp = receiptText(record, "timestamp");
        String contentType = receiptText(record, "contentType");
        String acceptedIdempotencyKey = receiptText(record, "idempotencyKey");
        Object rawHeaders = record.get("headers");
        if (!(rawHeaders instanceof Map<?, ?> headers)) {
            throw new IllegalStateException("Event Plane exact lookup is missing headers");
        }
        boolean acceptedJobEvent = isAcceptedJobEvent(event);
        Object storedPrincipal = headers.get("principalId");
        if (!(storedPrincipal instanceof String principalText) || principalText.isBlank()) {
            throw new IllegalStateException("Event Plane exact lookup is missing its authenticated principal");
        }
        Map<String, String> expectedHeaders = new LinkedHashMap<>(mediaEventHeaders(event));
        expectedHeaders.put("tenantId", event.tenantId());
        expectedHeaders.put("principalId", acceptedJobEvent ? principalText : event.principalId());
        expectedHeaders.put("callerEventId", event.eventId());
        expectedHeaders.put("streamId", streamId);
        expectedHeaders.put("correlationId", event.correlationId());
        Object rawCausationId = record.get("causationId");
        String causationId = rawCausationId instanceof String text ? text : "";
        Object rawPayload = record.get("payload");
        if (!(rawPayload instanceof String payloadText)) {
            throw new IllegalStateException("Event Plane exact lookup is missing payload");
        }
        Map<String, Object> expectedPayload = lifecyclePayload(event);
        tools.jackson.databind.JsonNode expectedPayloadNode = mapper.readTree(mapper.writeValueAsBytes(expectedPayload));
        tools.jackson.databind.JsonNode actualPayloadNode = mapper.readTree(payloadText);
        if (!expectedPayloadNode.equals(actualPayloadNode)
                || !MediaLifecyclePublicationReceipt.stableStoredEventId(event.eventId()).equals(storedEventId)
                || !storedEventId.equals(storedAlias)
                || !event.eventId().equals(callerEventId)
                || !streamId.equals(acceptedStreamId)
                || !event.eventType().equals(eventType)
                || !"1.0.0".equals(eventVersion)
                || !event.occurredAt().toString().equals(timestamp)
                || !"application/json".equals(contentType)
                || !idempotencyKey.equals(acceptedIdempotencyKey)
                || !isNonNegativeOffset(offset)
                || !expectedHeaders.equals(headers)
                || !"media".equals(record.get("source"))
                || (acceptedJobEvent
                        ? record.containsKey("userId")
                        : !event.principalId().equals(record.get("userId")))
                || !event.correlationId().equals(record.get("correlationId"))
                || !event.causationId().equals(causationId)) {
            throw new IllegalStateException("Event Plane exact lookup does not match the immutable Media event");
        }
        return new MediaLifecyclePublicationReceipt(callerEventId, storedEventId, acceptedStreamId, offset);
    }

    private Map<String, Object> lifecyclePayload(MediaLifecycleEvent event) {
        if (isAcceptedJobEvent(event)) {
            validateAcceptedJobEvent(event);
            return new LinkedHashMap<>(event.attributes());
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("aggregateType", event.aggregateType());
        payload.put("aggregateId", event.aggregateId());
        payload.put("aggregateVersion", event.aggregateVersion());
        payload.put("classification", event.classification());
        payload.put("attributes", event.attributes());
        return payload;
    }

    private Map<String, String> mediaEventHeaders(MediaLifecycleEvent event) {
        if (!isAcceptedJobEvent(event)) return Map.of();
        validateAcceptedJobEvent(event);
        return Map.of(
                "media.aggregateType", event.aggregateType(),
                "media.aggregateId", event.aggregateId(),
                "media.aggregateVersion", Long.toString(event.aggregateVersion()),
                "media.dataClassification", event.classification());
    }

    private static boolean isAcceptedJobEvent(MediaLifecycleEvent event) {
        return ACCEPTED_JOB_EVENT_TYPE.equals(event.eventType());
    }

    private static void validateAcceptedJobEvent(MediaLifecycleEvent event) {
        if (!isAcceptedJobEvent(event)) return;
        Map<String, Object> payload = event.attributes();
        Object rawJobId = payload.get("jobId");
        Object rawOperation = payload.get("operationRef");
        Object rawAdmissionState = payload.get("admissionState");
        String jobId = rawJobId instanceof String text ? text : "";
        if (!ACCEPTED_JOB_PAYLOAD_FIELDS.equals(payload.keySet())
                || !"processing-job".equals(event.aggregateType())
                || !event.aggregateId().equals(jobId)
                || !("media:" + ACCEPTED_JOB_EVENT_TYPE + ":" + jobId + ":" + event.aggregateVersion())
                        .equals(event.eventId())
                || !"media.operation-slice.submit-job".equals(rawOperation)
                || !"ACCEPTED".equals(rawAdmissionState)
                || !Set.of("INTERNAL", "CONFIDENTIAL", "RESTRICTED").contains(event.classification())) {
            throw new IllegalArgumentException(
                    "media.job.accepted does not match its canonical Media event contract");
        }
    }

    private static String tenantScopedIdempotencyKey(String tenantId, String eventId) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(tenantId.getBytes(StandardCharsets.UTF_8));
            digest.update((byte) 0);
            digest.update(eventId.getBytes(StandardCharsets.UTF_8));
            return "media-" + java.util.HexFormat.of().formatHex(digest.digest());
        } catch (Exception failure) {
            throw new IllegalStateException("Unable to derive Media Event Plane idempotency key", failure);
        }
    }

    private record LookupResult(MediaLifecyclePublicationReceipt receipt, boolean completeAbsence) { }

    private static final class DefinitiveAppendRejectionException extends IllegalStateException {
        private DefinitiveAppendRejectionException(String message) {
            super(message);
        }
    }

    private static String receiptText(Map<String, Object> receipt, String field) {
        Object value = receipt.get(field);
        if (!(value instanceof String text) || text.isBlank()) {
            throw new IllegalStateException("Event Plane append receipt is missing " + field);
        }
        return text;
    }

    private static boolean isNonNegativeOffset(String offset) {
        return !offset.isEmpty() && offset.chars().allMatch(value -> value >= '0' && value <= '9');
    }

    private static void requireEventPlaneText(String value, String field) {
        if (value.length() > MAX_EVENT_PLANE_IDENTIFIER_LENGTH) {
            throw new IllegalArgumentException(field + " exceeds Event Plane's 255-character limit");
        }
    }
}
