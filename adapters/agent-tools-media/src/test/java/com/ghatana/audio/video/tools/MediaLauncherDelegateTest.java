package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolActionClass;
import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.agent.framework.tools.ToolExecutionStatus;
import com.ghatana.agent.framework.tools.ToolTransport;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import com.ghatana.tools.testing.EventloopTestBase;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Delegation grant, status mapping, typed refusal and reconciliation rules. The HTTP server below is a TEST-ONLY
 * stand-in for the launcher's wire behaviour at the tool-host boundary; the real-launcher proofs are in
 * {@code MediaDevAgentDelegationIT}.
 */
class MediaLauncherDelegateTest extends EventloopTestBase {
    private static final String TENANT = "tenant-d";
    private static final String USER = "user-d";
    private static final String AGENT = "agent-d";
    private static final String VERSION = "sha256:" + "b".repeat(64);
    private static final Instant NOW = Instant.parse("2026-11-15T10:00:00Z");

    @TempDir Path dir;
    private HttpServer server;
    private final List<String> seen = new ArrayList<>();
    private final List<String> bodies = new ArrayList<>();
    private final List<String> auth = new ArrayList<>();
    private final AtomicReference<int[]> postStatus = new AtomicReference<>(new int[]{201});
    private final AtomicReference<String> postBody = new AtomicReference<>("{}");
    private final AtomicReference<String> outcome = new AtomicReference<>("{\"state\":\"ABSENT\"}");
    private FileMediaDelegationGrantStore grants;
    private MediaLauncherDelegate delegate;

    @BeforeEach
    void start() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            String request = exchange.getRequestMethod() + " " + exchange.getRequestURI().getPath();
            synchronized (seen) {
                seen.add(request);
                auth.add(exchange.getRequestHeaders().getFirst("Authorization"));
                bodies.add(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            }
            boolean get = "GET".equals(exchange.getRequestMethod());
            byte[] body = (get ? outcome.get() : postBody.get()).getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(get ? 200 : postStatus.get()[0], body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        grants = new FileMediaDelegationGrantStore(dir.resolve("grants"));
        delegate = new MediaLauncherDelegate(URI.create("http://127.0.0.1:" + server.getAddress().getPort()), grants,
                (grant, principal) -> "token-of-" + principal.principalId(), Clock.fixed(NOW, ZoneOffset.UTC),
                Duration.ofSeconds(10));
    }

    @AfterEach
    void stop() { server.stop(0); }

    private MediaDelegationGrant grant(String id, String tool, String operation, Set<String> sources) {
        MediaDelegationGrant grant = new MediaDelegationGrant(id, TENANT, USER, AGENT, tool, Set.of(operation), sources,
                NOW.minusSeconds(60), NOW.plusSeconds(3600), null);
        grants.issue(grant);
        return grant;
    }

    private static ToolExecutionEnvelope envelope(String tool, String id, Map<String, Object> input) {
        return new ToolExecutionEnvelope(id, tool, "1.0.0", AGENT, null, TENANT, ToolActionClass.CALL_EXTERNAL, "1.0",
                input, NOW);
    }

    private static ToolContract contract(ToolExecutionEnvelope e) {
        return new ToolContract(e.toolId(), e.toolVersion(), "t", "t", e.actionClass(), false, true, Map.of(), Map.of(),
                Set.of(), ToolTransport.IN_PROCESS, null, Map.of());
    }

    private static Map<String, Object> sttInput(String artifact) {
        return Map.of("audioSource", Map.of("mediaArtifactId", artifact), "languageCode", "en-US",
                "sourceArtifactVersion", VERSION);
    }

    private MediaToolExecutionBinder binder(InMemory ledger) {
        return new MediaToolExecutionBinder(ledger, (t, i) -> Optional.empty(), delegate.replayAuthorizer(),
                delegate.reconciler(), delegate.revalidator());
    }

    private ToolExecutionResult run(MediaToolExecutionBinder binder, ToolExecutionEnvelope e) {
        AudioVideoToolHandlerFactory factory = new AudioVideoToolHandlerFactory(binder, delegate);
        return runPromise(() -> factory.createAuthenticated(e.toolId())
                .handle(e, contract(e), new AuthenticatedPrincipal(TENANT, USER, NOW)));
    }

    private static final class InMemory implements MediaToolExecutionBinder.InvocationLedger {
        final Map<String, MediaToolExecutionBinder.LogicalAction> rows = new java.util.concurrent.ConcurrentHashMap<>();
        @Override public Optional<MediaToolExecutionBinder.LogicalAction> find(String id) { return Optional.ofNullable(rows.get(id)); }
        @Override public void record(MediaToolExecutionBinder.LogicalAction a) { rows.put(a.invocationId(), a); }
        @Override public MediaToolExecutionBinder.ClaimResult claim(MediaToolExecutionBinder.LogicalAction fence) {
            return rows.putIfAbsent(fence.invocationId(), fence) == null
                    ? MediaToolExecutionBinder.ClaimResult.CLAIMED : MediaToolExecutionBinder.ClaimResult.ALREADY_CLAIMED;
        }
        @Override public boolean complete(MediaToolExecutionBinder.LogicalAction t) { rows.put(t.invocationId(), t); return true; }
    }

    @Test
    void grantStoreIsDurableOwnerOnlyAndRevocationSticks() throws Exception {
        MediaDelegationGrant grant = grant("g-1", "av.speech-to-text", "speech.transcribe", Set.of("a1"));
        assertThatThrownBy(() -> grants.issue(grant)).isInstanceOf(IllegalStateException.class);
        assertThat(Files.getPosixFilePermissions(dir.resolve("grants")))
                .isEqualTo(PosixFilePermissions.fromString("rwx------"));
        FileMediaDelegationGrantStore reopened = new FileMediaDelegationGrantStore(dir.resolve("grants"));
        assertThat(reopened.findFor(TENANT, USER, AGENT, "av.speech-to-text")).hasValue(grant);
        assertThat(reopened.findFor("other-tenant", USER, AGENT, "av.speech-to-text")).isEmpty();
        assertThat(reopened.revoke("g-1", NOW)).isTrue();
        assertThat(reopened.revoke("g-1", NOW)).as("already revoked").isFalse();
        assertThat(new FileMediaDelegationGrantStore(dir.resolve("grants")).find("g-1").orElseThrow().isRevoked()).isTrue();
    }

    @Test
    void positiveCallSendsTheUsersCredentialAndAnInvocationDerivedRequestId() {
        grant("g-1", "av.speech-to-text", "speech.transcribe", Set.of("a1"));
        postBody.set("{\"text\":\"hello\",\"cueCount\":1,\"replayed\":false,\"transcript\":{\"artifact\":{\"artifactId\":\"t1\","
                + "\"artifactVersionId\":\"v1\"}},\"captions\":{\"artifact\":{\"artifactId\":\"c1\"}}}");
        ToolExecutionEnvelope e = envelope("av.speech-to-text", "inv-1", sttInput("a1"));
        ToolExecutionResult result = run(binder(new InMemory()), e);

        assertThat(result.status()).as(String.valueOf(result.failure())).isEqualTo(ToolExecutionStatus.SUCCESS);
        assertThat(seen).containsExactly("POST /dev/v1/speech/transcriptions");
        assertThat(auth).containsExactly("Bearer token-of-" + USER);
        assertThat(bodies.getFirst()).contains(MediaToolJobBridge.requestIdFor("inv-1"), "\"artifactId\":\"a1\"",
                VERSION, "\"language\":\"en\"");
    }

    @Test
    void duplicateInvocationRechecksTheLauncherAndReturnsTheRecordedResultOnlyWhileAdmitted() {
        grant("g-1", "av.speech-to-text", "speech.transcribe", Set.of("a1"));
        postBody.set("{\"text\":\"hello\",\"cueCount\":1}");
        InMemory ledger = new InMemory();
        ToolExecutionEnvelope e = envelope("av.speech-to-text", "inv-dup", sttInput("a1"));
        ToolExecutionResult first = run(binder(ledger), e);
        postStatus.set(new int[]{200});
        ToolExecutionResult second = run(binder(ledger), e);
        assertThat(second).isEqualTo(first);
        assertThat(seen).as("the replay is re-checked by the launcher's own replay of the same request id")
                .containsExactly("POST /dev/v1/speech/transcriptions", "POST /dev/v1/speech/transcriptions");

        // consent revoked at the launcher: the recorded SUCCESS is withheld and the ledger row is untouched
        postStatus.set(new int[]{403});
        postBody.set("{\"error\":{\"code\":\"RIGHTS_DECISION_DENIED\"}}");
        ToolExecutionResult denied = run(binder(ledger), e);
        assertThat(denied.status()).isEqualTo(ToolExecutionStatus.DENIED);
        assertThat(denied.failure().code()).isEqualTo("MEDIA_RIGHTS_DECISION_DENIED");
        assertThat(ledger.find("inv-dup").orElseThrow().outcome()).isEqualTo(MediaToolExecutionBinder.LogicalOutcome.SUCCESS);

        // an unreachable re-check withholds the result too (never a silent replay)
        postStatus.set(new int[]{500});
        assertThatThrownBy(() -> run(binder(ledger), e))
                .isInstanceOf(MediaToolExecutionBinder.InvocationClaimUnavailableException.class);
    }

    @Test
    void grantViolationsNeverReachTheLauncher() {
        // no grant at all, or a revoked/expired one: the binder's replay authorizer refuses before any claim
        ToolExecutionEnvelope e = envelope("av.speech-to-text", "inv-nogrant", sttInput("a1"));
        InMemory ledger = new InMemory();
        assertThatThrownBy(() -> run(binder(ledger), e)).isInstanceOf(MediaToolExecutionBinder.InvocationReplayDeniedException.class);
        assertThat(ledger.find("inv-nogrant")).isEmpty();

        grant("g-1", "av.speech-to-text", "speech.transcribe", Set.of("a1"));
        assertThat(run(binder(new InMemory()), envelope("av.speech-to-text", "inv-scope", sttInput("other")))
                .failure().code()).isEqualTo(MediaLauncherDelegate.SOURCE_NOT_GRANTED);

        grants.revoke("g-1", NOW);
        assertThatThrownBy(() -> run(binder(new InMemory()), envelope("av.speech-to-text", "inv-revoked", sttInput("a1"))))
                .isInstanceOf(MediaToolExecutionBinder.InvocationReplayDeniedException.class);
        assertThat(seen).isEmpty();
    }

    @Test
    void theDelegateItselfRechecksTheGrantAtDispatchTime() {
        // defense in depth for the window between the binder's authorization and the dispatch
        MediaDelegationGrant live = grant("g-1", "av.speech-to-text", "speech.transcribe", Set.of("a1"));
        ToolExecutionEnvelope e = envelope("av.speech-to-text", "inv-race", sttInput("a1"));
        MediaLauncherDelegate.Call call = MediaDelegatedPlans.plan(e, contract(e));
        grants.revoke(live.grantId(), NOW);
        ToolExecutionResult denied = runPromise(() -> delegate.execute(e, new AuthenticatedPrincipal(TENANT, USER, NOW), call, NOW));
        assertThat(denied.status()).isEqualTo(ToolExecutionStatus.DENIED);
        assertThat(denied.failure().code()).isEqualTo(MediaLauncherDelegate.GRANT_REVOKED);
        assertThat(seen).isEmpty();
    }

    @Test
    void operationAndExpiryAreEnforced() {
        grant("g-op", "av.text-to-speech", "speech.transcribe", Set.of());
        ToolExecutionEnvelope tts = envelope("av.text-to-speech", "inv-op", Map.of("text", "hi", "voiceId", "af_heart",
                "audioEncoding", "WAV", "storeAsArtifact", true));
        assertThat(run(binder(new InMemory()), tts).failure().code()).isEqualTo(MediaLauncherDelegate.OPERATION_NOT_GRANTED);

        grants.issue(new MediaDelegationGrant("g-old", TENANT, USER, AGENT, "av.vision-analysis", Set.of("vision.analyze"),
                Set.of("a1"), NOW.minusSeconds(7200), NOW.minusSeconds(3600), null));
        ToolExecutionEnvelope vision = envelope("av.vision-analysis", "inv-exp", Map.of("mediaSource",
                Map.of("mediaArtifactId", "a1"), "analysisTypes", List.of("OCR"), "sourceArtifactVersion", VERSION));
        assertThatThrownBy(() -> run(binder(new InMemory()), vision))
                .isInstanceOf(MediaToolExecutionBinder.InvocationReplayDeniedException.class);
        assertThat(seen).isEmpty();
    }

    @Test
    void launcherRefusalsMapToTypedOutcomesAndServerErrorsStayAmbiguous() {
        grant("g-1", "av.speech-to-text", "speech.transcribe", Set.of("a1"));
        postStatus.set(new int[]{403});
        postBody.set("{\"error\":{\"code\":\"RIGHTS_DECISION_DENIED\"}}");
        ToolExecutionResult denied = run(binder(new InMemory()), envelope("av.speech-to-text", "inv-403", sttInput("a1")));
        assertThat(denied.status()).isEqualTo(ToolExecutionStatus.DENIED);
        assertThat(denied.failure().code()).isEqualTo("MEDIA_RIGHTS_DECISION_DENIED");

        postStatus.set(new int[]{404});
        postBody.set("{\"error\":{\"code\":\"SOURCE_VERSION_NOT_FOUND\"}}");
        assertThat(run(binder(new InMemory()), envelope("av.speech-to-text", "inv-404", sttInput("a1"))).failure().code())
                .isEqualTo("MEDIA_SOURCE_VERSION_NOT_FOUND");

        postStatus.set(new int[]{503});
        postBody.set("{\"error\":{\"code\":\"RIGHTS_AUTHORITY_UNAVAILABLE\"}}");
        assertThat(run(binder(new InMemory()), envelope("av.speech-to-text", "inv-503a", sttInput("a1"))).failure().code())
                .isEqualTo("MEDIA_RIGHTS_AUTHORITY_UNAVAILABLE");

        postStatus.set(new int[]{500});
        postBody.set("{\"error\":{\"code\":\"INTERNAL\"}}");
        InMemory ledger = new InMemory();
        assertThatThrownBy(() -> run(binder(ledger), envelope("av.speech-to-text", "inv-500", sttInput("a1"))))
                .isInstanceOf(MediaToolExecutionBinder.OutcomeUnknownException.class);
        assertThat(ledger.find("inv-500").orElseThrow().outcome())
                .isEqualTo(MediaToolExecutionBinder.LogicalOutcome.OUTCOME_UNKNOWN);
    }

    @Test
    void ambiguousInvocationReconcilesOnlyFromTheLaunchersRecordedOutcomeAndNeverBlindlyRedispatches() {
        grant("g-1", "av.speech-to-text", "speech.transcribe", Set.of("a1"));
        InMemory ledger = new InMemory();
        ToolExecutionEnvelope e = envelope("av.speech-to-text", "inv-amb", sttInput("a1"));
        postStatus.set(new int[]{500});
        postBody.set("{}");
        assertThatThrownBy(() -> run(binder(ledger), e)).isInstanceOf(MediaToolExecutionBinder.OutcomeUnknownException.class);
        seen.clear();

        // still in flight or never claimed: stays unknown, and only the read-only outcome route is touched
        for (String state : List.of("IN_PROGRESS", "ABSENT")) {
            outcome.set("{\"state\":\"" + state + "\"}");
            assertThatThrownBy(() -> run(binder(ledger), e)).isInstanceOf(MediaToolExecutionBinder.OutcomeUnknownException.class);
        }
        assertThat(seen).allMatch(request -> request.startsWith("GET /dev/v1/request-outcomes/speech.transcribe/agtool-"));

        // completed: the single recorded outcome is fetched by replay and becomes the invocation's durable result
        outcome.set("{\"state\":\"COMPLETED\",\"outputs\":[{}]}");
        postStatus.set(new int[]{200});
        postBody.set("{\"text\":\"hello\",\"cueCount\":1,\"replayed\":true}");
        ToolExecutionResult reconciled = run(binder(ledger), e);
        assertThat(reconciled.status()).isEqualTo(ToolExecutionStatus.SUCCESS);
        assertThat(ledger.find("inv-amb").orElseThrow().outcome()).isEqualTo(MediaToolExecutionBinder.LogicalOutcome.SUCCESS);
        long posts = seen.stream().filter(r -> r.startsWith("POST")).count();
        assertThat(posts).as("exactly one replay fetch after the completed outcome").isEqualTo(1);
        seen.clear();
        assertThat(run(binder(ledger), e)).isEqualTo(reconciled);
        assertThat(seen).containsExactly("POST /dev/v1/speech/transcriptions");
    }

    @Test
    void releasedRequestReconcilesToATypedNoEffectFailure() {
        grant("g-1", "av.speech-to-text", "speech.transcribe", Set.of("a1"));
        InMemory ledger = new InMemory();
        ToolExecutionEnvelope e = envelope("av.speech-to-text", "inv-rel", sttInput("a1"));
        postStatus.set(new int[]{500});
        assertThatThrownBy(() -> run(binder(ledger), e)).isInstanceOf(MediaToolExecutionBinder.OutcomeUnknownException.class);
        outcome.set("{\"state\":\"RELEASED\"}");
        ToolExecutionResult result = run(binder(ledger), e);
        assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
        assertThat(result.failure().code()).isEqualTo("MEDIA_REQUEST_RELEASED_NO_EFFECT");
    }

    @Test
    void revokedGrantBlocksReconciliationAndReplay() {
        grant("g-1", "av.speech-to-text", "speech.transcribe", Set.of("a1"));
        InMemory ledger = new InMemory();
        ToolExecutionEnvelope e = envelope("av.speech-to-text", "inv-rev", sttInput("a1"));
        postStatus.set(new int[]{500});
        assertThatThrownBy(() -> run(binder(ledger), e)).isInstanceOf(MediaToolExecutionBinder.OutcomeUnknownException.class);
        grants.revoke("g-1", NOW);
        outcome.set("{\"state\":\"COMPLETED\"}");
        seen.clear();
        assertThatThrownBy(() -> run(binder(ledger), e)).isInstanceOf(MediaToolExecutionBinder.InvocationReplayDeniedException.class);
        assertThat(seen).isEmpty();
    }

    @Test
    void whatTheLauncherOperationCannotHonourStaysTypedNotAdmitted() {
        grant("g-1", "av.speech-to-text", "speech.transcribe", Set.of("a1"));
        grant("g-2", "av.text-to-speech", "speech.synthesize", Set.of());
        grant("g-3", "av.multimodal-inference", "vision.track", Set.of("a1"));
        grant("g-4", "av.vision-analysis", "vision.analyze", Set.of("a1"));
        Map<String, Object> diarization = Map.of("audioSource", Map.of("mediaArtifactId", "a1"),
                "enableDiarization", true, "sourceArtifactVersion", VERSION);
        assertThat(run(binder(new InMemory()), envelope("av.speech-to-text", "n-1", diarization)).failure().code())
                .isEqualTo("STT_DIARIZATION_NOT_ADMITTED");
        assertThat(run(binder(new InMemory()), envelope("av.text-to-speech", "n-2", Map.of("text", "x",
                "audioEncoding", "WAV", "storeAsArtifact", true, "pitch", 3.0))).failure().code())
                .isEqualTo("TTS_PITCH_NOT_ADMITTED");
        assertThat(run(binder(new InMemory()), envelope("av.text-to-speech", "n-3", Map.of("text", "x",
                "audioEncoding", "MP3", "storeAsArtifact", true))).failure().code())
                .isEqualTo("TTS_AUDIO_ENCODING_NOT_SUPPORTED");
        assertThat(run(binder(new InMemory()), envelope("av.multimodal-inference", "n-4", Map.of("mediaArtifactId", "a1",
                "sourceArtifactVersion", VERSION))).failure().code()).isEqualTo("MULTIMODAL_TRANSCRIPTION_NOT_ADMITTED");
        assertThat(run(binder(new InMemory()), envelope("av.vision-analysis", "n-5", Map.of("mediaSource",
                Map.of("mediaArtifactId", "a1"), "analysisTypes", List.of("FACE_DETECTION"),
                "sourceArtifactVersion", VERSION))).failure().code()).isEqualTo("VISION_ANALYSIS_TYPE_NOT_ADMITTED");
        assertThat(seen).isEmpty();
    }
}
