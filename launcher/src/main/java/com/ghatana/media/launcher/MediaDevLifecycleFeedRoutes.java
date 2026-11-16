package com.ghatana.media.launcher;

import com.sun.net.httpserver.HttpExchange;
import com.ghatana.media.runtime.MediaDevLifecycleFeedContracts.Entry;
import com.ghatana.media.runtime.MediaDevLifecycleFeedContracts.Feed;
import com.ghatana.media.runtime.MediaDevLifecycleFeedContracts.Page;
import com.ghatana.media.runtime.MediaJobView;
import com.ghatana.media.runtime.MediaLifecycleIdentifierRedactor;
import com.ghatana.media.runtime.MediaPublicLifecycleEvent;

import java.io.IOException;
import java.io.InputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DEV_ONLY pull feed of the public lifecycle ABI (outside the canonical manifest/OpenAPI):
 * <ul>
 *   <li>{@code GET /dev/v1/lifecycle-events?after={cursor}&limit={n}}: this principal's entries of this tenant with a
 *       cursor greater than {@code after}, oldest first. The cursor is the consumer's only position: it is held by the
 *       consumer, so "acknowledging" is just asking from a later cursor; a lost acknowledgement means asking again from
 *       the old one. Delivery is at-least-once (a redelivery carries a higher {@code deliveryNo} and the same
 *       {@code eventRef}); order is monotonic per aggregate (version never decreases among first deliveries), not across
 *       aggregates.</li>
 *   <li>{@code GET /dev/v1/lifecycle-events/schema}: the published JSON Schema of the event payload.</li>
 *   <li>{@code GET /dev/v1/lifecycle-events/jobs/{aggregateRef}}: the authoritative job-store readback for a job
 *       reference taken from an event. An event is a NON_FINAL_APPEND; only this readback may be used to claim a job is
 *       terminal.</li>
 * </ul>
 * Reading requires {@code media:project:dev:read} and {@code media:job:read}. Every response is labelled DEV_ONLY.
 */
final class MediaDevLifecycleFeedRoutes {
    static final String EVENTS = "/dev/v1/lifecycle-events";
    static final String SCHEMA = EVENTS + "/schema";
    static final String FEED_SCHEMA = "media.lifecycle-feed.v1";
    static final String READBACK_SCHEMA = "media.lifecycle-job-readback.v1";
    private static final Pattern JOB = Pattern.compile("^/dev/v1/lifecycle-events/jobs/(r1_[0-9a-f]{64})$");
    private static final int DEFAULT_LIMIT = 50;
    private static final int MAX_SCAN_PAGES = 5;
    private static final String NOTE = "DEV_ONLY lifecycle feed; every entry is a NON_FINAL_APPEND notification. Job "
            + "state is established only by the job readback, never by an event or its consumption.";

    private final Feed feed;
    private final MediaLifecycleIdentifierRedactor redactor;
    private final MediaRuntime runtime;

    MediaDevLifecycleFeedRoutes(Feed feed, MediaLifecycleIdentifierRedactor redactor, MediaRuntime runtime) {
        this.feed = feed;
        this.redactor = redactor;
        this.runtime = runtime;
    }

    static boolean handles(String path) {
        return path.equals(EVENTS) || path.startsWith(EVENTS + "/");
    }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId, int maxBody,
                MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        if (!"GET".equals(method)) {
            exchange.getResponseHeaders().set("Allow", "GET");
            out.error(exchange, 405, "METHOD_NOT_ALLOWED", "Method not allowed", Map.of());
            return;
        }
        if (!MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:job:read")) {
            runtime.recordDeniedRequest();
            out.error(exchange, 403, "JOB_PERMISSION_REQUIRED", "DEV_ONLY job read permission is required", Map.of());
            return;
        }
        try {
            if (SCHEMA.equals(path)) { schema(exchange, out); return; }
            Matcher job = JOB.matcher(path);
            if (job.matches()) { readback(exchange, tenantId, principalId, job.group(1), out); return; }
            if (EVENTS.equals(path)) { page(exchange, tenantId, principalId, out); return; }
            out.error(exchange, 404, "NOT_FOUND", "Unknown DEV_ONLY lifecycle route", Map.of());
        } catch (IllegalArgumentException invalid) {
            out.error(exchange, 400, "INVALID_REQUEST", invalid.getMessage(), Map.of());
        } catch (IllegalStateException unavailable) {
            out.error(exchange, 503, "LIFECYCLE_FEED_UNAVAILABLE", "The DEV_ONLY lifecycle feed is unavailable", Map.of());
        }
    }

    private void page(HttpExchange exchange, String tenantId, String principalId,
                      MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        Map<String, String> query = query(exchange.getRequestURI().getRawQuery());
        long after = number(query, "after", 0, 0, Long.MAX_VALUE);
        int limit = (int) number(query, "limit", DEFAULT_LIMIT, 1, 200);
        String callerRef = redactor.redact("principal", principalId);
        List<Map<String, Object>> entries = new ArrayList<>();
        long cursor = after;
        for (int scanned = 0; scanned < MAX_SCAN_PAGES && entries.size() < limit; scanned++) {
            Page page = feed.read(tenantId, cursor, limit - entries.size());
            if (page.entries().isEmpty()) break;
            for (Entry entry : page.entries()) {
                cursor = entry.cursor();
                if (!callerRef.equals(entry.event().principalRef())) continue;
                Map<String, Object> view = new LinkedHashMap<>();
                view.put("cursor", entry.cursor());
                view.put("deliveryNo", entry.deliveryNo());
                view.put("event", entry.event().toPayload());
                entries.add(view);
            }
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("schema", FEED_SCHEMA);
        body.put("eventSchemaUri", MediaPublicLifecycleEvent.SCHEMA_URI);
        body.put("eventSchemaVersion", MediaPublicLifecycleEvent.SCHEMA_VERSION);
        body.put("scope", "DEV_ONLY");
        body.put("delivery", "AT_LEAST_ONCE");
        body.put("finality", "NON_FINAL_APPEND");
        body.put("entries", entries);
        body.put("nextCursor", cursor);
        body.put("note", NOTE);
        out.json(exchange, 200, body);
    }

    private void readback(HttpExchange exchange, String tenantId, String principalId, String aggregateRef,
                          MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        Optional<String> jobId = feed.resolveAggregateId(tenantId, "job", aggregateRef);
        Optional<MediaJobView> view = jobId.flatMap(id -> runtime.jobView(tenantId, principalId, id));
        if (view.isEmpty()) {
            out.error(exchange, 404, "JOB_NOT_FOUND", "The job is not available to this DEV_ONLY principal", Map.of());
            return;
        }
        MediaJobView job = view.get();
        boolean terminal = switch (job.status()) {
            case COMPLETED, FAILED, CANCELLED -> true;
            default -> false;
        };
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("schema", READBACK_SCHEMA);
        body.put("scope", "DEV_ONLY");
        body.put("authority", "JOB_STORE_READBACK");
        body.put("aggregateRef", aggregateRef);
        body.put("jobId", job.jobId());
        body.put("status", job.status().name());
        body.put("logicalStatus", job.logicalStatus().name());
        body.put("version", job.version());
        body.put("terminal", terminal);
        body.put("note", "Authoritative job-store state at read time; compare with an event's aggregateVersion, "
                + "an event never establishes it");
        out.json(exchange, 200, body);
    }

    private static void schema(HttpExchange exchange, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        try (InputStream input = MediaDevLifecycleFeedRoutes.class.getResourceAsStream(
                "/contracts/media-public-lifecycle-event-v1.schema.json")) {
            if (input == null) {
                out.error(exchange, 503, "SCHEMA_UNAVAILABLE", "The published schema is unavailable", Map.of());
                return;
            }
            byte[] bytes = input.readAllBytes();
            exchange.getResponseHeaders().set("Content-Type", "application/schema+json");
            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.getResponseBody().close();
        }
    }

    private static long number(Map<String, String> query, String name, long fallback, long min, long max) {
        String raw = query.get(name);
        if (raw == null) return fallback;
        try {
            long value = Long.parseLong(raw);
            if (value < min || value > max) throw new NumberFormatException();
            return value;
        } catch (NumberFormatException invalid) {
            throw new IllegalArgumentException(name + " must be an integer between " + min + " and " + max);
        }
    }

    private static Map<String, String> query(String raw) {
        Map<String, String> values = new LinkedHashMap<>();
        if (raw == null || raw.isBlank()) return values;
        for (String pair : raw.split("&")) {
            int eq = pair.indexOf('=');
            String key = URLDecoder.decode(eq < 0 ? pair : pair.substring(0, eq), StandardCharsets.UTF_8);
            String value = eq < 0 ? "" : URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8);
            if (!key.equals("after") && !key.equals("limit")) throw new IllegalArgumentException("unknown query parameter");
            if (values.put(key, value) != null) throw new IllegalArgumentException("duplicate query parameter");
        }
        return values;
    }
}
