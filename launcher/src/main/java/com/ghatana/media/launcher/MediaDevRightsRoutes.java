package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRightsConsentAuthority.Code;
import com.ghatana.media.runtime.MediaRightsConsentAuthority.RightsConsentException;
import com.ghatana.media.runtime.MediaRightsConsentContracts.AttestationRecord;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.ghatana.media.runtime.MediaRightsConsentContracts.StatementKind;
import com.sun.net.httpserver.HttpExchange;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DEV_ONLY rights and consent routes. Kept out of the canonical manifest and OpenAPI. The acting principal is the
 * authenticated caller; no request body field names a principal as the actor.
 *
 * <ul>
 *   <li>{@code POST /dev/v1/rights/attestations} body {@code {artifactId, artifactVersionId, statementKind, scopes,
 *       basis, supportingDocumentArtifactRef?, requestedConfirmerPrincipalId?, expiresAt?}} (permissions
 *       {@code media:project:dev:write} and {@code media:artifact:read}): 201.</li>
 *   <li>{@code GET /dev/v1/rights/attestations/{attestationId}} (permission {@code media:project:dev:read}).</li>
 *   <li>{@code POST /dev/v1/rights/attestations/{attestationId}/confirm} body {@code {note?}}: a different principal.</li>
 *   <li>{@code POST /dev/v1/rights/attestations/{attestationId}/revoke} body {@code {reason}}: attester or confirmer.</li>
 *   <li>{@code GET /dev/v1/rights/artifacts/{artifactId}/versions/{versionId}/attestations}: owner-scoped list of the
 *       exact version's attestations plus the live verdict per scope.</li>
 * </ul>
 */
final class MediaDevRightsRoutes {
    private static final org.slf4j.Logger LOG = org.slf4j.LoggerFactory.getLogger(MediaDevRightsRoutes.class);
    private static final String BASE = "/dev/v1/rights";
    private static final String ID_PATTERN = "([^/]+)";
    private static final Pattern CREATE = Pattern.compile("^/dev/v1/rights/attestations$");
    private static final Pattern ONE = Pattern.compile("^/dev/v1/rights/attestations/" + ID_PATTERN + "$");
    private static final Pattern CONFIRM = Pattern.compile("^/dev/v1/rights/attestations/" + ID_PATTERN + "/confirm$");
    private static final Pattern REVOKE = Pattern.compile("^/dev/v1/rights/attestations/" + ID_PATTERN + "/revoke$");
    private static final Pattern LIST = Pattern.compile(
            "^/dev/v1/rights/artifacts/" + ID_PATTERN + "/versions/" + ID_PATTERN + "/attestations$");
    private static final Pattern ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}");
    private static final Set<String> CREATE_FIELDS = Set.of("artifactId", "artifactVersionId", "statementKind", "scopes",
            "basis", "supportingDocumentArtifactRef", "requestedConfirmerPrincipalId", "expiresAt");

    private final ObjectMapper mapper = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();
    private final MediaRuntime runtime;
    private final MediaDevRightsRuntime rights;

    MediaDevRightsRoutes(MediaRuntime runtime, MediaDevRightsRuntime rights) {
        this.runtime = java.util.Objects.requireNonNull(runtime, "runtime");
        this.rights = java.util.Objects.requireNonNull(rights, "rights");
    }

    static boolean handles(String path) { return BASE.equals(path) || path.startsWith(BASE + "/"); }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId)
            throws IOException {
        try {
            if (CREATE.matcher(path).matches()) {
                if (!"POST".equals(method)) { methodNotAllowed(exchange, "POST"); return; }
                if (!MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")) {
                    runtime.recordDeniedRequest();
                    error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                            "DEV_ONLY artifact read permission is required to attest rights for an artifact version");
                    return;
                }
                Map<String, Object> body = body(exchange);
                if (!CREATE_FIELDS.containsAll(body.keySet())
                        || !body.keySet().containsAll(Set.of("artifactId", "artifactVersionId", "statementKind", "scopes", "basis"))) {
                    throw new IllegalArgumentException("attestation fields do not match their declared shape");
                }
                AttestationRecord created = rights.attest(tenantId, principalId, new MediaDevRightsRuntime.Statement(
                        text(body.get("artifactId"), "artifactId"), text(body.get("artifactVersionId"), "artifactVersionId"),
                        enumValue(StatementKind.class, body.get("statementKind"), "statementKind"),
                        scopes(body.get("scopes")), text(body.get("basis"), "basis", 2000),
                        optionalText(body.get("supportingDocumentArtifactRef"), "supportingDocumentArtifactRef"),
                        optionalText(body.get("requestedConfirmerPrincipalId"), "requestedConfirmerPrincipalId"),
                        instant(body.get("expiresAt"))));
                json(exchange, 201, view(created));
                return;
            }
            Matcher confirm = CONFIRM.matcher(path);
            if (confirm.matches()) {
                if (!"POST".equals(method)) { methodNotAllowed(exchange, "POST"); return; }
                Map<String, Object> body = body(exchange);
                if (!Set.of("note").containsAll(body.keySet())) throw new IllegalArgumentException("unknown field");
                json(exchange, 200, view(rights.confirm(tenantId, principalId, segment(confirm.group(1)),
                        optionalText(body.get("note"), "note"))));
                return;
            }
            Matcher revoke = REVOKE.matcher(path);
            if (revoke.matches()) {
                if (!"POST".equals(method)) { methodNotAllowed(exchange, "POST"); return; }
                Map<String, Object> body = body(exchange);
                if (!Set.of("reason").containsAll(body.keySet()) || !body.containsKey("reason")) {
                    throw new IllegalArgumentException("a revocation reason is required");
                }
                json(exchange, 200, view(rights.revoke(tenantId, principalId, segment(revoke.group(1)),
                        text(body.get("reason"), "reason", 2000))));
                return;
            }
            Matcher one = ONE.matcher(path);
            if (one.matches()) {
                if (!"GET".equals(method)) { methodNotAllowed(exchange, "GET"); return; }
                var found = rights.find(tenantId, principalId, segment(one.group(1)));
                if (found.isEmpty()) {
                    error(exchange, 404, "ATTESTATION_NOT_FOUND", "No attestation with this id is visible to this principal");
                    return;
                }
                json(exchange, 200, view(found.get()));
                return;
            }
            Matcher list = LIST.matcher(path);
            if (list.matches()) {
                if (!"GET".equals(method)) { methodNotAllowed(exchange, "GET"); return; }
                var found = rights.listForVersion(tenantId, principalId, segment(list.group(1)), segment(list.group(2)));
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("artifactId", segment(list.group(1)));
                out.put("artifactVersionId", segment(list.group(2)));
                List<Object> attestations = new ArrayList<>();
                for (AttestationRecord record : found.attestations()) attestations.add(view(record));
                out.put("attestations", attestations);
                Map<String, Object> admission = new LinkedHashMap<>();
                for (Scope scope : Scope.values()) admission.put(scope.name(), admission(found.admission().get(scope), scope));
                out.put("admission", admission);
                out.put("scope", "DEV_ONLY");
                out.put("establishesApproval", false);
                json(exchange, 200, out);
                return;
            }
            error(exchange, 404, "NOT_FOUND", "Rights route not found");
        } catch (MediaDevRightsRuntime.ArtifactVersionUnavailableException failure) {
            runtime.recordDeniedRequest();
            error(exchange, 404, "ARTIFACT_VERSION_NOT_FOUND",
                    "The exact artifact version is not available to this DEV_ONLY principal");
        } catch (RightsConsentException failure) {
            consentFailure(exchange, failure);
        } catch (IllegalArgumentException failure) {
            error(exchange, 400, "INVALID_REQUEST", "Rights request is invalid");
        } catch (IllegalStateException failure) {
            LOG.warn("DEV_ONLY rights state failure", failure);
            error(exchange, 503, "RIGHTS_STATE_UNAVAILABLE", "Rights state could not be read or updated");
        }
    }

    private void consentFailure(HttpExchange exchange, RightsConsentException failure) throws IOException {
        Code code = failure.code();
        switch (code) {
            case INVALID -> error(exchange, 422, "ATTESTATION_INVALID", failure.getMessage());
            case NOT_FOUND -> error(exchange, 404, "ATTESTATION_NOT_FOUND", failure.getMessage());
            case SELF_CONFIRMATION_REFUSED -> { runtime.recordDeniedRequest();
                error(exchange, 403, "SELF_CONFIRMATION_REFUSED", failure.getMessage()); }
            case NOT_DESIGNATED_CONFIRMER, NOT_PERMITTED_TO_REVOKE -> { runtime.recordDeniedRequest();
                error(exchange, 403, "ATTESTATION_" + code.name(), failure.getMessage()); }
            default -> error(exchange, 409, "ATTESTATION_" + code.name(), failure.getMessage());
        }
    }

    /** Public view of one attestation; the statement, the confirmation and the revocation are all attributed. */
    static Map<String, Object> view(AttestationRecord record) {
        var a = record.attestation();
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("attestationId", a.attestationId());
        view.put("artifactId", a.artifactId());
        view.put("artifactVersionId", a.artifactVersion());
        view.put("contentSha256", a.contentSha256());
        view.put("attestingPrincipalId", a.attestingPrincipalId());
        view.put("attestedAt", a.attestedAt().toString());
        view.put("statementKind", a.statementKind().name());
        List<String> scopes = new ArrayList<>();
        for (Scope scope : Scope.values()) if (a.scopes().contains(scope)) scopes.add(scope.name());
        view.put("scopes", scopes);
        view.put("basis", a.basis());
        view.put("supportingDocumentArtifactRef", a.supportingDocumentArtifactRef().isEmpty() ? null : a.supportingDocumentArtifactRef());
        view.put("requestedConfirmerPrincipalId", a.requestedConfirmerPrincipalId().isEmpty() ? null : a.requestedConfirmerPrincipalId());
        view.put("expiresAt", a.expiresAt() == null ? null : a.expiresAt().toString());
        view.put("requiresSecondPersonConfirmation", a.needsSecondPersonConfirmation());
        view.put("status", record.statusAt(Instant.now()).name());
        if (record.confirmation() == null) view.put("confirmation", null);
        else {
            Map<String, Object> confirmation = new LinkedHashMap<>();
            confirmation.put("confirmingPrincipalId", record.confirmation().confirmingPrincipalId());
            confirmation.put("confirmedAt", record.confirmation().confirmedAt().toString());
            confirmation.put("note", record.confirmation().note().isEmpty() ? null : record.confirmation().note());
            view.put("confirmation", confirmation);
        }
        if (record.revocation() == null) view.put("revocation", null);
        else {
            Map<String, Object> revocation = new LinkedHashMap<>();
            revocation.put("revokedByPrincipalId", record.revocation().revokedByPrincipalId());
            revocation.put("revokedAt", record.revocation().revokedAt().toString());
            revocation.put("reason", record.revocation().reason());
            view.put("revocation", revocation);
        }
        view.put("scope", "DEV_ONLY");
        view.put("establishesApproval", false);
        return view;
    }

    static Map<String, Object> admission(Resolution resolution, Scope scope) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("scope", scope.name());
        out.put("verdict", resolution.verdict().name());
        out.put("reasons", resolution.reasons().stream().map(Enum::name).sorted().toList());
        out.put("attestationIds", resolution.attestationIds());
        out.put("requiresSecondPersonConfirmation", scope.requiresSecondPersonConfirmation());
        return out;
    }

    private Map<String, Object> body(HttpExchange exchange) throws IOException {
        Map<String, Object> body = mapper.readValue(
                MediaHttpHandler.boundedBody(exchange, runtime.config().maximumBodyBytes(), false),
                new TypeReference<Map<String, Object>>() { });
        if (body == null) throw new IllegalArgumentException("a JSON object body is required");
        return body;
    }

    private static Set<Scope> scopes(Object value) {
        if (!(value instanceof List<?> list) || list.isEmpty() || list.size() > Scope.values().length) {
            throw new IllegalArgumentException("scopes must be a non-empty list");
        }
        Set<Scope> out = EnumSet.noneOf(Scope.class);
        for (Object item : list) {
            if (!out.add(enumValue(Scope.class, item, "scopes"))) throw new IllegalArgumentException("duplicate scope");
        }
        return out;
    }

    private static <E extends Enum<E>> E enumValue(Class<E> type, Object value, String name) {
        if (!(value instanceof String text)) throw new IllegalArgumentException(name + " must be a string");
        try { return Enum.valueOf(type, text); }
        catch (IllegalArgumentException failure) { throw new IllegalArgumentException(name + " is not recognised"); }
    }

    private static Instant instant(Object value) {
        if (value == null) return null;
        if (!(value instanceof String text)) throw new IllegalArgumentException("expiresAt must be an ISO-8601 instant");
        try { return Instant.parse(text); }
        catch (DateTimeParseException failure) { throw new IllegalArgumentException("expiresAt must be an ISO-8601 instant"); }
    }

    private static String text(Object value, String name) { return text(value, name, 384); }

    private static String text(Object value, String name, int max) {
        if (!(value instanceof String text) || text.isBlank() || !text.equals(text.strip()) || text.length() > max) {
            throw new IllegalArgumentException(name + " must be an exact non-blank string");
        }
        return text;
    }

    private static String optionalText(Object value, String name) {
        return value == null ? null : text(value, name, 2000);
    }

    private static String segment(String raw) {
        String decoded = URLDecoder.decode(raw.replace("+", "%2B"), StandardCharsets.UTF_8);
        if (decoded.indexOf('/') >= 0 || decoded.indexOf('\\') >= 0 || !ID.matcher(decoded).matches()) {
            throw new IllegalArgumentException("Path identifier is not a valid opaque id");
        }
        return decoded;
    }

    private void methodNotAllowed(HttpExchange exchange, String allow) throws IOException {
        exchange.getResponseHeaders().set("Allow", allow);
        error(exchange, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
    }

    private void error(HttpExchange exchange, int status, String code, String message) throws IOException {
        String requestId = exchange.getRequestHeaders().getFirst("X-Request-ID");
        if (requestId == null || !ID.matcher(requestId).matches()) requestId = UUID.randomUUID().toString();
        exchange.getResponseHeaders().set("X-Request-ID", requestId);
        json(exchange, status, Map.of(
                "error", Map.of("code", code, "message", message, "retryable", status == 503,
                        "evidenceRefs", List.of(), "actionRefs", List.of()),
                "meta", Map.of("requestId", requestId, "correlationId", requestId,
                        "timestamp", Instant.now().toString(), "apiVersion", "1.0.0")));
    }

    private void json(HttpExchange exchange, int status, Object body) throws IOException {
        byte[] bytes = mapper.writeValueAsBytes(body);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, bytes.length);
        try (var output = exchange.getResponseBody()) { output.write(bytes); }
    }
}
