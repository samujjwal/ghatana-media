/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolActionClass;
import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.agent.framework.tools.ToolExecutionStatus;
import com.ghatana.agent.framework.tools.ToolTransport;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.InvocationLedger;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.LogicalAction;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.LogicalOutcome;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import com.ghatana.tools.testing.EventloopTestBase;
import com.ghatana.toolruntime.ToolHandler;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Source-free J-25 boundary scenario; no owner mapping or provider effect is admitted here. */
class AgentOutcomeAdmissionScenarioTest extends EventloopTestBase {

    private record HandlerCase(String toolId, String unavailableCode, Map<String, Object> input,
            ToolHandler handler) { }

    private static final class Ledger implements InvocationLedger {
        private final Map<String, LogicalAction> actions = new HashMap<>();

        @Override public synchronized Optional<LogicalAction> find(String invocationId) {
            return Optional.ofNullable(actions.get(invocationId));
        }

        @Override public synchronized void record(LogicalAction action) {
            actions.put(action.invocationId(), action);
        }

        @Override public synchronized MediaToolExecutionBinder.ClaimResult claim(LogicalAction fence) {
            return actions.putIfAbsent(fence.invocationId(), fence) == null
                    ? MediaToolExecutionBinder.ClaimResult.CLAIMED
                    : MediaToolExecutionBinder.ClaimResult.ALREADY_CLAIMED;
        }

        @Override public synchronized boolean complete(LogicalAction terminal) {
            LogicalAction current = actions.get(terminal.invocationId());
            if (current == null || current.outcome() != LogicalOutcome.OUTCOME_UNKNOWN
                    || !current.requestIdentity().equals(terminal.requestIdentity())) return false;
            actions.put(terminal.invocationId(), terminal);
            return true;
        }
    }

    @Test
    void hostAuthorizationCannotChangeTheInputAfterItsOutcomeIdentityIsBound() {
        var nested = new java.util.ArrayList<>(java.util.List.of("original"));
        Map<String, Object> input = new HashMap<>();
        input.put("scope", nested);
        ToolExecutionEnvelope requested = new ToolExecutionEnvelope("invocation-j25-snapshot",
                SpeechToTextToolHandler.TOOL_ID, "1.0.0", "agent-j25", null, "tenant-j25",
                ToolActionClass.CALL_EXTERNAL, "1.0", input, Instant.now());
        Ledger ledger = new Ledger();
        AtomicBoolean delegateSawSnapshot = new AtomicBoolean();
        MediaToolExecutionBinder binder = new MediaToolExecutionBinder(ledger,
                (tenant, invocation) -> Optional.empty(), (principal, identity) -> {
                    nested.add("changed-after-identity");
                    input.put("added-after-identity", true);
                    return mapsToEnvelopeActor(principal, identity);
                });
        ToolHandler delegate = (envelope, contract) -> {
            Map<?, ?> boundInput = (Map<?, ?>) envelope.input();
            var boundScope = (java.util.List<?>) boundInput.get("scope");
            delegateSawSnapshot.set(boundScope.equals(java.util.List.of("original"))
                    && !boundInput.containsKey("added-after-identity"));
            return io.activej.promise.Promise.of(ToolExecutionResult.succeeded(
                    envelope.invocationId(), Map.of("bounded", true), Map.of(),
                    envelope.invocationId(), Instant.now(), java.time.Duration.ZERO));
        };

        ToolExecutionResult result = runPromise(() -> binder.execute(
                delegate, requested, contract(requested), authenticatedHostPrincipal(requested)));

        assertThat(result.status()).isEqualTo(ToolExecutionStatus.SUCCESS);
        assertThat(delegateSawSnapshot).isTrue();
        assertThat(ledger.find(requested.invocationId())).hasValueSatisfying(action -> {
            assertThat(action.requestIdentity().inputFingerprint())
                    .isEqualTo(MediaToolExecutionBinder.RequestIdentity.from(
                            new ToolExecutionEnvelope(requested.invocationId(), requested.toolId(),
                                    requested.toolVersion(), requested.callerAgentId(), requested.callerReleaseId(),
                                    requested.tenantId(), requested.actionClass(), requested.requestSchemaVersion(),
                                    Map.of("scope", java.util.List.of("original")), requested.requestedAt()))
                            .inputFingerprint());
        });
    }

    @Test
    void unadmittedToolCannotReachConfiguredProviderAcrossReplayAndAuthorityChanges() {
        Ledger ledger = new Ledger();
        AtomicBoolean replayAuthority = new AtomicBoolean(true);
        AtomicInteger providerCalls = new AtomicInteger();
        MediaToolExecutionBinder binder = new MediaToolExecutionBinder(ledger,
                (tenant, invocation) -> Optional.empty(), (principal, identity) -> replayAuthority.get()
                        && mapsToEnvelopeActor(principal, identity));
        ToolHandler configuredProvider = (envelope, contract) -> {
            providerCalls.incrementAndGet();
            return io.activej.promise.Promise.of(ToolExecutionResult.succeeded(
                    envelope.invocationId(), Map.of("transcript", "must-not-be-produced"), Map.of(),
                    envelope.invocationId(), Instant.now(), java.time.Duration.ZERO));
        };
        ToolHandler handlerWithoutAdmission = new SpeechToTextToolHandler(configuredProvider);
        ToolExecutionEnvelope original = envelope("tenant-agent", "agent-1");
        ToolContract contract = contract(original);
        AuthenticatedPrincipal authorized = authenticatedHostPrincipal(original);

        ToolExecutionResult notAdmitted = runPromise(() -> binder.execute(
                handlerWithoutAdmission, original, contract, authorized));
        assertThat(notAdmitted.status()).isEqualTo(ToolExecutionStatus.FAILED);
        assertThat(notAdmitted.failure().kind()).isEqualTo(
                com.ghatana.agent.framework.tools.ToolExecutionFailure.Kind.UNAVAILABLE);
        assertThat(notAdmitted.failure().stage()).isEqualTo(
                com.ghatana.agent.framework.tools.ToolExecutionFailure.Stage.ADMISSION);
        assertThat(notAdmitted.failure().code()).isEqualTo("STT_NOT_ADMITTED");
        assertThat(notAdmitted.output()).isNull();

        ToolExecutionResult replay = runPromise(() -> binder.execute(
                handlerWithoutAdmission, original, contract, authorized));
        assertThat(replay).isSameAs(notAdmitted);

        ToolExecutionEnvelope wrongTenant = sameInvocation(original, "other-tenant", original.callerAgentId());
        assertThatThrownBy(() -> runPromise(() -> binder.execute(
                handlerWithoutAdmission, wrongTenant, contract(wrongTenant), authenticatedHostPrincipal(wrongTenant))))
                .isInstanceOf(MediaToolExecutionBinder.InvocationIdentityConflictException.class);

        replayAuthority.set(false); // Host authorization was revoked after the recorded result.
        assertThatThrownBy(() -> runPromise(() -> binder.execute(
                handlerWithoutAdmission, original, contract, authorized)))
                .isInstanceOf(MediaToolExecutionBinder.InvocationReplayDeniedException.class);

        replayAuthority.set(true);
        ToolExecutionEnvelope unknown = envelope("tenant-agent", "agent-1");
        ledger.record(new LogicalAction(unknown.invocationId(),
                MediaToolExecutionBinder.RequestIdentity.from(unknown), LogicalOutcome.OUTCOME_UNKNOWN, null));
        assertThatThrownBy(() -> runPromise(() -> binder.execute(
                handlerWithoutAdmission, unknown, contract(unknown), authorized)))
                .isInstanceOf(MediaToolExecutionBinder.OutcomeUnknownException.class);

        assertThat(providerCalls).hasValue(0);
    }

    @Test
    void allFourUnadmittedToolsKeepTypedUnavailableAcrossExactReplayAndTenantConflict() {
        Ledger ledger = new Ledger();
        AtomicInteger providerCalls = new AtomicInteger();
        AtomicBoolean replayAuthority = new AtomicBoolean(true);
        MediaToolExecutionBinder binder = new MediaToolExecutionBinder(ledger,
                (tenant, invocation) -> Optional.empty(), (principal, identity) -> replayAuthority.get()
                        && mapsToEnvelopeActor(principal, identity));
        ToolHandler configuredProvider = (envelope, contract) -> {
            providerCalls.incrementAndGet();
            return io.activej.promise.Promise.of(ToolExecutionResult.succeeded(
                    envelope.invocationId(), Map.of("fixtureOutput", "must-not-be-produced"), Map.of(),
                    envelope.invocationId(), Instant.now(), java.time.Duration.ZERO));
        };
        var cases = java.util.List.of(
                new HandlerCase(SpeechToTextToolHandler.TOOL_ID, "STT_NOT_ADMITTED",
                        Map.of("audioSource", Map.of("mediaArtifactId", "source-stt-v1"), "languageCode", "en-US"),
                        new SpeechToTextToolHandler(configuredProvider)),
                new HandlerCase(TextToSpeechToolHandler.TOOL_ID, "TTS_NOT_ADMITTED",
                        Map.of("text", "fixture speech", "voiceId", "en-US-default", "storeAsArtifact", true),
                        new TextToSpeechToolHandler(configuredProvider)),
                new HandlerCase(VisionAnalysisToolHandler.TOOL_ID, "VISION_NOT_ADMITTED",
                        Map.of("mediaSource", Map.of("mediaArtifactId", "source-vision-v1"),
                                "analysisTypes", java.util.List.of("OBJECT_DETECTION")),
                        new VisionAnalysisToolHandler(configuredProvider)),
                new HandlerCase(MultimodalInferenceToolHandler.TOOL_ID, "MULTIMODAL_NOT_ADMITTED",
                        Map.of("mediaArtifactId", "source-multimodal-v1", "inferenceMode", "SUMMARY",
                                "samplingRateMs", 1_000, "enableTranscription", true,
                                "enableVisionAnalysis", true, "languageCode", "en-US"),
                        new MultimodalInferenceToolHandler(configuredProvider)));

        for (HandlerCase tool : cases) {
            ToolExecutionEnvelope original = envelope(tool.toolId(), tool.input(), "tenant-j25", "agent-j25");
            ToolContract contract = contract(original);
            AuthenticatedPrincipal authenticated = authenticatedHostPrincipal(original);

            ToolExecutionResult notAdmitted = runPromise(() -> binder.execute(
                    tool.handler(), original, contract, authenticated));
            assertThat(notAdmitted.status()).as(tool.toolId()).isEqualTo(ToolExecutionStatus.FAILED);
            assertThat(notAdmitted.failure().kind()).as(tool.toolId()).isEqualTo(
                    com.ghatana.agent.framework.tools.ToolExecutionFailure.Kind.UNAVAILABLE);
            assertThat(notAdmitted.failure().stage()).as(tool.toolId()).isEqualTo(
                    com.ghatana.agent.framework.tools.ToolExecutionFailure.Stage.ADMISSION);
            assertThat(notAdmitted.failure().code()).as(tool.toolId()).isEqualTo(tool.unavailableCode());
            assertThat(notAdmitted.output()).as(tool.toolId()).isNull();

            ToolExecutionResult replay = runPromise(() -> binder.execute(
                    tool.handler(), original, contract, authenticated));
            assertThat(replay).as(tool.toolId()).isSameAs(notAdmitted);

            ToolExecutionEnvelope wrongTenant = sameInvocation(original, "tenant-other-j25", original.callerAgentId());
            assertThatThrownBy(() -> runPromise(() -> binder.execute(
                    tool.handler(), wrongTenant, contract(wrongTenant), authenticatedHostPrincipal(wrongTenant))))
                    .as(tool.toolId()).isInstanceOf(MediaToolExecutionBinder.InvocationIdentityConflictException.class);
        }

        assertThat(providerCalls).hasValue(0);
    }

    @Test
    void allFourUnadmittedToolsDenyRevokedReplayAndPreserveUnknownWithoutProviderDispatch() {
        Ledger ledger = new Ledger();
        AtomicBoolean replayAuthority = new AtomicBoolean(true);
        AtomicInteger providerCalls = new AtomicInteger();
        MediaToolExecutionBinder binder = new MediaToolExecutionBinder(ledger,
                (tenant, invocation) -> Optional.empty(), (principal, identity) -> replayAuthority.get()
                        && mapsToEnvelopeActor(principal, identity));
        ToolHandler configuredProvider = (envelope, contract) -> {
            providerCalls.incrementAndGet();
            return io.activej.promise.Promise.of(ToolExecutionResult.succeeded(
                    envelope.invocationId(), Map.of("fixtureOutput", "must-not-be-produced"), Map.of(),
                    envelope.invocationId(), Instant.now(), java.time.Duration.ZERO));
        };
        var cases = java.util.List.of(
                new HandlerCase(SpeechToTextToolHandler.TOOL_ID, "STT_NOT_ADMITTED",
                        Map.of("audioSource", Map.of("mediaArtifactId", "source-stt-unknown"), "languageCode", "en-US"),
                        new SpeechToTextToolHandler(configuredProvider)),
                new HandlerCase(TextToSpeechToolHandler.TOOL_ID, "TTS_NOT_ADMITTED",
                        Map.of("text", "private fixture text", "voiceId", "en-US-default", "storeAsArtifact", true),
                        new TextToSpeechToolHandler(configuredProvider)),
                new HandlerCase(VisionAnalysisToolHandler.TOOL_ID, "VISION_NOT_ADMITTED",
                        Map.of("mediaSource", Map.of("mediaArtifactId", "source-vision-unknown"),
                                "analysisTypes", java.util.List.of("OBJECT_DETECTION")),
                        new VisionAnalysisToolHandler(configuredProvider)),
                new HandlerCase(MultimodalInferenceToolHandler.TOOL_ID, "MULTIMODAL_NOT_ADMITTED",
                        Map.of("mediaArtifactId", "source-multimodal-unknown", "inferenceMode", "SUMMARY",
                                "samplingRateMs", 1_000, "enableTranscription", true,
                                "enableVisionAnalysis", true, "languageCode", "en-US"),
                        new MultimodalInferenceToolHandler(configuredProvider)));

        for (HandlerCase tool : cases) {
            ToolExecutionEnvelope envelope = envelope(tool.toolId(), tool.input(), "tenant-j25", "agent-j25");
            ToolContract contract = contract(envelope);
            AuthenticatedPrincipal authenticated = authenticatedHostPrincipal(envelope);

            ToolExecutionResult denied = runPromise(() -> binder.execute(
                    tool.handler(), envelope, contract, authenticated));
            replayAuthority.set(false);
            assertThatThrownBy(() -> runPromise(() -> binder.execute(
                    tool.handler(), envelope, contract, authenticated)))
                    .as(tool.toolId()).isInstanceOf(MediaToolExecutionBinder.InvocationReplayDeniedException.class);
            replayAuthority.set(true);
            assertThat(runPromise(() -> binder.execute(tool.handler(), envelope, contract, authenticated)))
                    .as(tool.toolId()).isSameAs(denied);

            ToolExecutionEnvelope unknown = envelope(tool.toolId(), tool.input(), "tenant-j25", "agent-j25");
            ledger.record(new LogicalAction(unknown.invocationId(),
                    MediaToolExecutionBinder.RequestIdentity.from(unknown), LogicalOutcome.OUTCOME_UNKNOWN, null));
            assertThatThrownBy(() -> runPromise(() -> binder.execute(
                    tool.handler(), unknown, contract(unknown), authenticated)))
                    .as(tool.toolId()).isInstanceOf(MediaToolExecutionBinder.OutcomeUnknownException.class);
        }

        assertThat(providerCalls).hasValue(0);
    }

    @Test
    void allFourUnadmittedToolsDoNotClaimOrDispatchWhenHostAuthorizationIsUnavailable() {
        Ledger ledger = new Ledger();
        AtomicInteger providerCalls = new AtomicInteger();
        MediaToolExecutionBinder binder = new MediaToolExecutionBinder(ledger,
                (tenant, invocation) -> Optional.empty(), (principal, identity) -> {
                    throw new IllegalStateException("host replay authorization unavailable");
                });
        ToolHandler configuredProvider = (envelope, contract) -> {
            providerCalls.incrementAndGet();
            return io.activej.promise.Promise.of(ToolExecutionResult.succeeded(
                    envelope.invocationId(), Map.of("fixtureOutput", "must-not-be-produced"), Map.of(),
                    envelope.invocationId(), Instant.now(), java.time.Duration.ZERO));
        };
        var cases = java.util.List.of(
                new HandlerCase(SpeechToTextToolHandler.TOOL_ID, "STT_NOT_ADMITTED",
                        Map.of("audioSource", Map.of("mediaArtifactId", "source-stt-auth-unavailable"), "languageCode", "en-US"),
                        new SpeechToTextToolHandler(configuredProvider)),
                new HandlerCase(TextToSpeechToolHandler.TOOL_ID, "TTS_NOT_ADMITTED",
                        Map.of("text", "fixture speech", "voiceId", "en-US-default", "storeAsArtifact", true),
                        new TextToSpeechToolHandler(configuredProvider)),
                new HandlerCase(VisionAnalysisToolHandler.TOOL_ID, "VISION_NOT_ADMITTED",
                        Map.of("mediaSource", Map.of("mediaArtifactId", "source-vision-auth-unavailable"),
                                "analysisTypes", java.util.List.of("OBJECT_DETECTION")),
                        new VisionAnalysisToolHandler(configuredProvider)),
                new HandlerCase(MultimodalInferenceToolHandler.TOOL_ID, "MULTIMODAL_NOT_ADMITTED",
                        Map.of("mediaArtifactId", "source-multimodal-auth-unavailable", "inferenceMode", "SUMMARY",
                                "samplingRateMs", 1_000, "enableTranscription", true,
                                "enableVisionAnalysis", true, "languageCode", "en-US"),
                        new MultimodalInferenceToolHandler(configuredProvider)));

        for (HandlerCase tool : cases) {
            ToolExecutionEnvelope envelope = envelope(tool.toolId(), tool.input(), "tenant-j25", "agent-j25");
            ToolContract contract = contract(envelope);
            assertThatThrownBy(() -> runPromise(() -> binder.execute(
                    tool.handler(), envelope, contract, authenticatedHostPrincipal(envelope))))
                    .as(tool.toolId())
                    .isInstanceOf(MediaToolExecutionBinder.InvocationReplayDeniedException.class);
            assertThat(ledger.find(envelope.invocationId())).as(tool.toolId()).isEmpty();
        }

        assertThat(providerCalls).hasValue(0);
    }

    @Test
    void fileLedgerDirectorySyncFailurePreventsBinderDispatch(@TempDir Path parentDirectory) throws IOException {
        Path ledgerDirectory = parentDirectory.toRealPath().resolve("invocations");
        FileInvocationLedger ledger = new FileInvocationLedger(ledgerDirectory,
                new SecretKeySpec(new byte[32], "AES"), Duration.ofMinutes(5), Clock.systemUTC(), directory -> {
                    if (directory.equals(ledgerDirectory)) {
                        throw new IOException("injected invocation directory sync failure");
                    }
                });
        AtomicInteger providerCalls = new AtomicInteger();
        MediaToolExecutionBinder binder = new MediaToolExecutionBinder(ledger,
                (tenant, invocation) -> Optional.empty(), AgentOutcomeAdmissionScenarioTest::mapsToEnvelopeActor);
        ToolExecutionEnvelope envelope = envelope("tenant-j25", "agent-j25");
        ToolHandler delegate = (request, contract) -> {
            providerCalls.incrementAndGet();
            return io.activej.promise.Promise.of(ToolExecutionResult.succeeded(
                    request.invocationId(), Map.of("result", "must-not-run"), Map.of(),
                    request.invocationId(), Instant.now(), Duration.ZERO));
        };

        assertThatThrownBy(() -> runPromise(() -> binder.execute(
                delegate, envelope, contract(envelope), authenticatedHostPrincipal(envelope))))
                .isInstanceOf(MediaToolExecutionBinder.InvocationClaimUnavailableException.class);
        assertThat(providerCalls).hasValue(0);
        assertThat(ledger.find(envelope.invocationId())).hasValueSatisfying(action -> {
            assertThat(action.outcome()).isEqualTo(LogicalOutcome.OUTCOME_UNKNOWN);
            assertThat(action.result()).isNull();
        });
    }

    @Test
    void terminalSyncFailureReturnsUnknownAndRestartedReplayDoesNotDispatchAgain(
            @TempDir Path parentDirectory) throws IOException {
        Path ledgerDirectory = parentDirectory.toRealPath().resolve("terminal-sync-ledger");
        AtomicInteger ledgerDirectorySyncs = new AtomicInteger();
        FileInvocationLedger ledger = new FileInvocationLedger(ledgerDirectory,
                new SecretKeySpec(new byte[32], "AES"), Duration.ofMinutes(5), Clock.systemUTC(), directory -> {
                    if (directory.equals(ledgerDirectory) && ledgerDirectorySyncs.incrementAndGet() == 3) {
                        throw new IOException("injected terminal directory sync failure");
                    }
                });
        ToolExecutionEnvelope envelope = envelope("tenant-j25", "agent-j25");
        ToolContract contract = contract(envelope);
        AuthenticatedPrincipal principal = authenticatedHostPrincipal(envelope);
        AtomicInteger delegateCalls = new AtomicInteger();
        ToolHandler delegate = (request, ignoredContract) -> {
            delegateCalls.incrementAndGet();
            ToolExecutionResult result = ToolExecutionResult.succeeded(
                    request.invocationId(), Map.of("result", "test-only-terminal"), Map.of(),
                    request.invocationId(), Instant.now(), Duration.ZERO);
            return io.activej.promise.Promise.of(result);
        };
        MediaToolExecutionBinder binder = new MediaToolExecutionBinder(ledger,
                (tenant, invocation) -> Optional.empty(), AgentOutcomeAdmissionScenarioTest::mapsToEnvelopeActor);

        assertThatThrownBy(() -> runPromise(() -> binder.execute(delegate, envelope, contract, principal)))
                .isInstanceOf(MediaToolExecutionBinder.OutcomeUnknownException.class)
                .hasFieldOrPropertyWithValue("invocationId", envelope.invocationId());
        assertThat(ledgerDirectorySyncs).hasValue(3);
        assertThat(delegateCalls).hasValue(1);

        FileInvocationLedger restartedLedger = new FileInvocationLedger(
                ledgerDirectory, new SecretKeySpec(new byte[32], "AES"), Duration.ofMinutes(5), Clock.systemUTC());
        MediaToolExecutionBinder restartedBinder = new MediaToolExecutionBinder(restartedLedger,
                (tenant, invocation) -> Optional.empty(), AgentOutcomeAdmissionScenarioTest::mapsToEnvelopeActor);
        assertThatThrownBy(() -> runPromise(
                () -> restartedBinder.execute(delegate, envelope, contract, principal)))
                .isInstanceOf(MediaToolExecutionBinder.OutcomeUnknownException.class)
                .hasFieldOrPropertyWithValue("invocationId", envelope.invocationId());
        assertThat(restartedLedger.find(envelope.invocationId())).hasValueSatisfying(action -> {
            assertThat(action.requestIdentity()).isEqualTo(MediaToolExecutionBinder.RequestIdentity.from(envelope));
            assertThat(action.outcome()).isEqualTo(LogicalOutcome.OUTCOME_UNKNOWN);
            assertThat(action.result()).isNull();
        });
        assertThat(delegateCalls).hasValue(1);
    }

    private static ToolExecutionEnvelope envelope(String tenantId, String callerAgentId) {
        return envelope(SpeechToTextToolHandler.TOOL_ID,
                Map.of("audioSource", Map.of("mediaArtifactId", "source-v1"), "languageCode", "en-US"),
                tenantId, callerAgentId);
    }

    /** Test-only host ingress identity; the separate authorizer still checks its exact actor mapping. */
    private static AuthenticatedPrincipal authenticatedHostPrincipal(ToolExecutionEnvelope envelope) {
        return new AuthenticatedPrincipal(envelope.tenantId(), envelope.callerAgentId(), Instant.now());
    }

    private static boolean mapsToEnvelopeActor(AuthenticatedPrincipal principal,
            MediaToolExecutionBinder.RequestIdentity identity) {
        return principal.tenantId().equals(identity.tenantId())
                && principal.principalId().equals(identity.callerAgentId());
    }

    private static ToolExecutionEnvelope envelope(
            String toolId, Map<String, Object> input, String tenantId, String callerAgentId) {
        return ToolExecutionEnvelope.of(toolId, "1.0.0", callerAgentId, null,
                tenantId, ToolActionClass.CALL_EXTERNAL, "1.0",
                input);
    }

    private static ToolExecutionEnvelope sameInvocation(
            ToolExecutionEnvelope original, String tenantId, String callerAgentId) {
        return new ToolExecutionEnvelope(original.invocationId(), original.toolId(), original.toolVersion(),
                callerAgentId, original.callerReleaseId(), tenantId, original.actionClass(),
                original.requestSchemaVersion(), original.input(), original.requestedAt());
    }

    private static ToolContract contract(ToolExecutionEnvelope envelope) {
        return new ToolContract(envelope.toolId(), envelope.toolVersion(), "STT", "J-25 source-free boundary",
                envelope.actionClass(), false, true, Map.of(), Map.of(), Set.<String>of(),
                ToolTransport.IN_PROCESS, null, Map.of());
    }
}
