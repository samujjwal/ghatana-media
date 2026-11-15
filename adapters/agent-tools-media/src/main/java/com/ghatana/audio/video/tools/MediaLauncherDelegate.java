/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionFailure;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import io.activej.promise.Promise;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.function.Function;

/**
 * Delegates a Media agent tool call to a real Media launcher as the calling USER, under an explicit, scoped,
 * revocable {@link MediaDelegationGrant}. Nothing here is a service super-user or a provider bypass:
 *
 * <ul>
 *   <li>the call goes over the launcher's own HTTP routes with the user's own bearer credential, so the launcher's
 *       permission, tenant-isolation and rights/consent gates decide exactly as they would for the user;</li>
 *   <li>the grant is re-read on EVERY use (dispatch, replay and reconciliation), so a revoked or expired grant is
 *       denied before any request is sent;</li>
 *   <li>the launcher request id is derived from the durable invocation id, so the launcher's own request ledger makes
 *       a repeated dispatch of one invocation a single effect;</li>
 *   <li>an ambiguous dispatch (lost response, killed caller) is never re-sent blindly: {@link #reconcile} first asks the
 *       launcher's read-only request-outcome route what it actually did.</li>
 * </ul>
 *
 * <p>Anything outside the grant, or outside what the launcher can do for the tool's declared intent, stays a typed
 * refusal. The credential source is host-owned (this class never stores, caches or logs a token).
 *
 * @doc.type class
 * @doc.purpose grant-scoped launcher delegation for Media agent tools
 * @doc.layer product
 * @doc.pattern Adapter
 */
public final class MediaLauncherDelegate {

    /** Launcher operations a grant can name; each maps to exactly one DEV launcher route and request-ledger lane. */
    public enum Operation {
        SPEECH_TRANSCRIBE("speech.transcribe", "/dev/v1/speech/transcriptions"),
        SPEECH_SYNTHESIZE("speech.synthesize", "/dev/v1/speech/syntheses"),
        VISION_ANALYZE("vision.analyze", "/dev/v1/vision/analyses"),
        VISION_TRACK("vision.track", "/dev/v1/vision/tracks");

        private final String lane;
        private final String path;

        Operation(String lane, String path) { this.lane = lane; this.path = path; }

        /** The grant operation name and the launcher request-ledger lane. */
        public String lane() { return lane; }
        String path() { return path; }
    }

    /** One planned launcher call: validated, mapped, but not yet authorised or sent. */
    record Call(Operation operation, String sourceArtifactId, Map<String, Object> body,
                Function<JsonNode, Map<String, Object>> outputMapper) { }

    /** Host-owned source of the delegating user's bearer credential, consulted only after the grant is verified. */
    @FunctionalInterface
    public interface CredentialSource {
        String bearerToken(MediaDelegationGrant grant, AuthenticatedPrincipal principal) throws IOException;
    }

    public static final String GRANT_REQUIRED = "DELEGATION_GRANT_REQUIRED";
    public static final String GRANT_REVOKED = "DELEGATION_GRANT_REVOKED";
    public static final String GRANT_EXPIRED = "DELEGATION_GRANT_EXPIRED";
    public static final String OPERATION_NOT_GRANTED = "DELEGATION_OPERATION_NOT_GRANTED";
    public static final String SOURCE_NOT_GRANTED = "DELEGATION_SOURCE_NOT_GRANTED";
    public static final String CREDENTIAL_UNAVAILABLE = "DELEGATION_CREDENTIAL_UNAVAILABLE";
    public static final String PRINCIPAL_TENANT_MISMATCH = MediaToolJobBridge.PRINCIPAL_TENANT_MISMATCH;

    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final Executor BLOCKING = Executors.newCachedThreadPool(task -> {
        Thread thread = new Thread(task, "media-launcher-delegate");
        thread.setDaemon(true);
        return thread;
    });
    /** Refusals the launcher issues before any model/provider work: definite no-effect, not an ambiguous dispatch. */
    private static final Set<String> NO_EFFECT_UNAVAILABLE = Set.of("RIGHTS_AUTHORITY_UNAVAILABLE",
            "LOCAL_MODEL_NOT_ADMITTED", "LOCAL_VISION_UNAVAILABLE", "REQUEST_LEDGER_UNAVAILABLE",
            "LOCAL_SPEECH_UNAVAILABLE", "SPEECH_NOT_ADMITTED");

    private final URI baseUri;
    private final MediaDelegationGrantStore grants;
    private final CredentialSource credentials;
    private final Clock clock;
    private final HttpClient http;
    private final Duration requestTimeout;

    public MediaLauncherDelegate(URI baseUri, MediaDelegationGrantStore grants, CredentialSource credentials,
                                 Clock clock, Duration requestTimeout) {
        this.baseUri = Objects.requireNonNull(baseUri, "baseUri");
        this.grants = Objects.requireNonNull(grants, "grants");
        this.credentials = Objects.requireNonNull(credentials, "credentials");
        this.clock = Objects.requireNonNull(clock, "clock");
        this.requestTimeout = Objects.requireNonNull(requestTimeout, "requestTimeout");
        this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    }

    /**
     * Replay authorisation for the binder: the host-authenticated principal may replay (or reconcile) a recorded
     * invocation only while a LIVE grant for exactly this tenant, user, agent and tool still exists. Revoking the
     * grant therefore also stops a recorded result from being replayed.
     */
    public MediaToolExecutionBinder.InvocationReplayAuthorizer replayAuthorizer() {
        return (principal, identity) -> {
            if (!principal.tenantId().equals(identity.tenantId())) return false;
            Optional<MediaDelegationGrant> grant = grants.findFor(identity.tenantId(), principal.principalId(),
                    identity.callerAgentId(), identity.toolId());
            return grant.isPresent() && liveFailure(grant.get()) == null;
        };
    }

    /** Typed validation result shared by the four handlers. */
    static ToolExecutionResult invalid(ToolExecutionEnvelope envelope, String code, Instant start) {
        return MediaToolJobBridge.validationFailure(envelope, code, start);
    }

    /** Typed refusal for anything outside what this delegation covers; never dispatches. */
    static ToolExecutionResult notAdmitted(ToolExecutionEnvelope envelope, String code, Instant start) {
        Instant end = Instant.now();
        return ToolExecutionResult.failed(envelope.invocationId(),
                new ToolExecutionFailure(ToolExecutionFailure.Kind.UNAVAILABLE, ToolExecutionFailure.Stage.ADMISSION,
                        code, false, end),
                envelope.invocationId(), end, Duration.between(start, end));
    }

    /** Deterministic launcher request id for an invocation. */
    static String requestId(ToolExecutionEnvelope envelope) {
        return MediaToolJobBridge.requestIdFor(envelope.invocationId());
    }

    Promise<ToolExecutionResult> execute(ToolExecutionEnvelope envelope, AuthenticatedPrincipal principal, Call call,
                                         Instant start) {
        ToolExecutionResult refusal = authorize(envelope, principal, call, start);
        if (refusal != null) return Promise.of(refusal);
        MediaDelegationGrant grant = grants.findFor(envelope.tenantId(), principal.principalId(),
                envelope.callerAgentId(), envelope.toolId()).orElseThrow();
        final String token;
        try {
            token = credentials.bearerToken(grant, principal);
        } catch (IOException | RuntimeException unavailable) {
            return Promise.of(notAdmitted(envelope, CREDENTIAL_UNAVAILABLE, start));
        }
        // Blocking HTTP: any IOException or timeout here is an AMBIGUOUS dispatch and stays on the error channel so the
        // binder keeps its durable UNKNOWN fence (and reconciles through the launcher on the next attempt).
        // ActiveJ treats an unchecked exception from a blocking task as a fatal programming error, so every failure of
        // the blocking call is surfaced as a checked exception (an ambiguous dispatch).
        return Promise.ofBlocking(BLOCKING, () -> {
            try {
                return dispatch(envelope, grant, token, call, start);
            } catch (RuntimeException unexpected) {
                throw new IOException("MEDIA_LAUNCHER_RESPONSE_UNUSABLE", unexpected);
            }
        });
    }

    /**
     * Establishes what the launcher did for an ambiguous invocation WITHOUT sending new work: it reads the request
     * outcome and only a launcher-recorded COMPLETED request is replayed (the launcher answers a completed request id
     * from its stored output, re-checking permissions and rights, and never runs the model again). Empty means "still
     * unknown": the grant is no longer live, the request is in flight or was never claimed, or the launcher cannot say.
     */
    Optional<ToolExecutionResult> reconcile(ToolExecutionEnvelope envelope, AuthenticatedPrincipal principal, Call call,
                                            Instant start) throws IOException, InterruptedException {
        if (authorize(envelope, principal, call, start) != null) return Optional.empty();
        MediaDelegationGrant grant = grants.findFor(envelope.tenantId(), principal.principalId(),
                envelope.callerAgentId(), envelope.toolId()).orElseThrow();
        final String token;
        try {
            token = credentials.bearerToken(grant, principal);
        } catch (IOException | RuntimeException unavailable) {
            return Optional.empty();
        }
        String requestId = requestId(envelope);
        HttpResponse<String> outcome = send(grant, token, "GET",
                "/dev/v1/request-outcomes/" + call.operation().lane() + "/" + requestId, null);
        if (outcome.statusCode() != 200) return Optional.empty();
        String state = JSON.readTree(outcome.body()).path("state").asString("");
        Instant end = Instant.now();
        switch (state) {
            case "COMPLETED":
                // The launcher holds exactly one registered output for this request id; fetch it by replay.
                return Optional.of(dispatch(envelope, grant, token, call, start));
            case "RELEASED":
                return Optional.of(ToolExecutionResult.failed(envelope.invocationId(),
                        new ToolExecutionFailure(ToolExecutionFailure.Kind.UNAVAILABLE,
                                ToolExecutionFailure.Stage.EXECUTION, "MEDIA_REQUEST_RELEASED_NO_EFFECT", false, end),
                        envelope.invocationId(), end, Duration.between(start, end)));
            case "ERASED":
                return Optional.of(ToolExecutionResult.failed(envelope.invocationId(),
                        new ToolExecutionFailure(ToolExecutionFailure.Kind.UNAVAILABLE,
                                ToolExecutionFailure.Stage.EXECUTION, "MEDIA_OUTPUT_ERASED", false, end),
                        envelope.invocationId(), end, Duration.between(start, end)));
            default:
                return Optional.empty();
        }
    }

    /** Pre-dispatch checks; null when the call may go ahead, otherwise a typed terminal refusal with no effect. */
    private ToolExecutionResult authorize(ToolExecutionEnvelope envelope, AuthenticatedPrincipal principal, Call call,
                                          Instant start) {
        if (principal == null) {
            return notAdmitted(envelope, MediaToolJobBridge.PRINCIPAL_REQUIRED, start);
        }
        if (!principal.tenantId().equals(envelope.tenantId())) {
            return ToolExecutionResult.denied(envelope.invocationId(), PRINCIPAL_TENANT_MISMATCH, Instant.now());
        }
        Optional<MediaDelegationGrant> found = grants.findFor(envelope.tenantId(), principal.principalId(),
                envelope.callerAgentId(), envelope.toolId());
        if (found.isEmpty()) {
            return ToolExecutionResult.denied(envelope.invocationId(), GRANT_REQUIRED, Instant.now());
        }
        MediaDelegationGrant grant = found.get();
        String failure = liveFailure(grant);
        if (failure != null) return ToolExecutionResult.denied(envelope.invocationId(), failure, Instant.now());
        if (!grant.operations().contains(call.operation().lane())) {
            return ToolExecutionResult.denied(envelope.invocationId(), OPERATION_NOT_GRANTED, Instant.now());
        }
        if (call.sourceArtifactId() != null && !grant.sourceArtifactIds().contains(call.sourceArtifactId())) {
            return ToolExecutionResult.denied(envelope.invocationId(), SOURCE_NOT_GRANTED, Instant.now());
        }
        return null;
    }

    private String liveFailure(MediaDelegationGrant grant) {
        if (grant.isRevoked()) return GRANT_REVOKED;
        if (!clock.instant().isBefore(grant.expiresAt())) return GRANT_EXPIRED;
        return null;
    }

    private ToolExecutionResult dispatch(ToolExecutionEnvelope envelope, MediaDelegationGrant grant, String token,
                                         Call call, Instant start) throws IOException, InterruptedException {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId(envelope));
        body.putAll(call.body());
        HttpResponse<String> response = send(grant, token, "POST", call.operation().path(),
                JSON.writeValueAsString(body));
        int status = response.statusCode();
        Instant end = Instant.now();
        Duration took = Duration.between(start, end);
        String id = envelope.invocationId();
        if (status == 200 || status == 201) {
            JsonNode view = JSON.readTree(response.body());
            Map<String, Object> output = new LinkedHashMap<>(call.outputMapper().apply(view));
            output.put("operation", call.operation().lane());
            output.put("requestId", requestId(envelope));
            output.put("replayed", view.path("replayed").asBoolean(false));
            output.put("delegationGrantId", grant.grantId());
            return ToolExecutionResult.succeeded(id, Map.copyOf(output), Map.of("delegationGrantId", grant.grantId()),
                    id, end, took);
        }
        String code = errorCode(response.body());
        if (status == 403 || status == 404 || status == 401) {
            // Launcher permission, tenant-isolation or rights/consent refusal: nothing was dispatched or registered.
            return ToolExecutionResult.denied(id, "MEDIA_" + code, end);
        }
        if (status == 503 && NO_EFFECT_UNAVAILABLE.contains(code)) {
            return ToolExecutionResult.failed(id, new ToolExecutionFailure(ToolExecutionFailure.Kind.UNAVAILABLE,
                    ToolExecutionFailure.Stage.EXECUTION, "MEDIA_" + code, false, end), id, end, took);
        }
        if (status >= 400 && status < 500 && status != 408 && status != 429) {
            // Definite request-level refusal (validation, request-id reuse, unsupported source, output erased).
            return ToolExecutionResult.failed(id, new ToolExecutionFailure(ToolExecutionFailure.Kind.VALIDATION,
                    ToolExecutionFailure.Stage.EXECUTION, "MEDIA_" + code, false, end), id, end, took);
        }
        // 408/429/5xx and everything else: the launcher may or may not have done the work.
        throw new IOException("MEDIA_LAUNCHER_OUTCOME_AMBIGUOUS_" + status);
    }

    private HttpResponse<String> send(MediaDelegationGrant grant, String token, String method, String path,
                                      String body) throws IOException, InterruptedException {
        HttpRequest.Builder request = HttpRequest.newBuilder(baseUri.resolve(path)).timeout(requestTimeout)
                .header("Authorization", "Bearer " + token).header("X-Tenant-Id", grant.tenantId())
                .header("X-Media-Delegation-Grant", grant.grantId()).header("X-Media-Delegated-Agent", grant.agentId());
        if (body != null) request.header("Content-Type", "application/json");
        request.method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
        return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static String errorCode(String body) {
        try {
            String code = JSON.readTree(body).path("error").path("code").asString("");
            if (code.isEmpty()) code = JSON.readTree(body).path("code").asString("");
            String normalized = code.trim().toUpperCase(java.util.Locale.ROOT);
            return normalized.matches("^[A-Z][A-Z0-9_]{0,127}$") ? normalized : "LAUNCHER_REFUSED";
        } catch (RuntimeException unreadable) {
            return "LAUNCHER_REFUSED";
        }
    }

    /** Reconciler binding used by {@link MediaToolExecutionBinder}: plans the same call from the same envelope. */
    public MediaToolExecutionBinder.AmbiguousInvocationReconciler reconciler() {
        return (envelope, contract, principal) -> {
            Call call;
            try {
                call = MediaDelegatedPlans.plan(envelope, contract);
            } catch (RuntimeException invalid) {
                return Optional.empty();
            }
            if (call == null) return Optional.empty();
            return reconcile(envelope, principal, call, Instant.now());
        };
    }
}
