package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRequestLedgerContracts.Entry;
import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DEV_ONLY read-only request-outcome lookup (outside the canonical manifest/OpenAPI):
 * {@code GET /dev/v1/request-outcomes/{lane}/{requestId}}. It reports the durable request-ledger state of a request
 * the CALLING principal made in its own tenant: it never claims, runs, retries or changes anything, so a caller whose
 * dispatch outcome is ambiguous (for example a client that died after sending the request) can establish what the
 * launcher actually did before deciding anything, instead of re-sending blindly.
 *
 * <p>{@code ABSENT} means "no ledger row for this key", not "nothing is in flight": a request that has not yet been
 * claimed can still arrive. Only {@code COMPLETED} (registered output refs) and {@code RELEASED} (the run gave up and
 * registered nothing) are final.
 */
final class MediaDevRequestOutcomeRoutes {
    static final Set<String> LANES = Set.of("speech.transcribe", "speech.synthesize", "vision.analyze", "vision.ask",
            "vision.track", "vision.roi");
    static final String SCHEMA = "media.dev.request-outcome.v1";
    private static final Pattern PATH = Pattern.compile("^/dev/v1/request-outcomes/([a-z]+\\.[a-z]+)/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$");

    private final MediaDevRequestLedger ledger;
    private final MediaRuntime runtime;

    MediaDevRequestOutcomeRoutes(MediaDevRequestLedger ledger, MediaRuntime runtime) {
        this.ledger = ledger;
        this.runtime = runtime;
    }

    static boolean handles(String path) { return path.startsWith("/dev/v1/request-outcomes/"); }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        if (!"GET".equals(method)) {
            exchange.getResponseHeaders().set("Allow", "GET");
            out.error(exchange, 405, "METHOD_NOT_ALLOWED", "Method not allowed", Map.of());
            return;
        }
        if (!MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")) {
            runtime.recordDeniedRequest();
            out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                    "DEV_ONLY artifact read permission is required", Map.of());
            return;
        }
        Matcher matched = PATH.matcher(path);
        if (!matched.matches() || !LANES.contains(matched.group(1))) {
            out.error(exchange, 404, "NOT_FOUND", "Request-outcome route not found", Map.of());
            return;
        }
        String lane = matched.group(1);
        String requestId = matched.group(2);
        Optional<Entry> row;
        try {
            row = ledger.find(tenantId, principalId, lane, requestId);
        } catch (MediaDevRequestLedger.LedgerRefusedException unavailable) {
            out.error(exchange, unavailable.status(), unavailable.code(), unavailable.getMessage(), unavailable.details());
            return;
        }
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", SCHEMA);
        view.put("lane", lane);
        view.put("requestId", requestId);
        view.put("scope", "DEV_ONLY");
        if (row.isEmpty()) {
            view.put("state", "ABSENT");
            view.put("outputs", List.of());
        } else {
            Entry entry = row.get();
            view.put("state", entry.state().name());
            view.put("attempts", entry.attempts());
            view.put("outputs", entry.outputs().stream().map(ref -> Map.of("role", ref.role(),
                    "artifactId", ref.artifactId(), "versionId", ref.versionId())).toList());
            if (entry.lastFailureCode() != null) view.put("lastFailureCode", entry.lastFailureCode());
            if (entry.state() == com.ghatana.media.runtime.MediaRequestLedgerContracts.State.IN_PROGRESS) {
                view.put("ownerProcessGone", MediaDevRequestLedger.ownerProcessIsGone(entry.leaseOwner()));
                view.put("leaseExpiresAt", String.valueOf(entry.leaseExpiresAt()));
            }
        }
        out.json(exchange, 200, view);
    }
}
