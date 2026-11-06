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
    void unadmittedToolCannotReachConfiguredProviderAcrossReplayAndAuthorityChanges() {
        Ledger ledger = new Ledger();
        AtomicBoolean replayAuthority = new AtomicBoolean(true);
        AtomicInteger providerCalls = new AtomicInteger();
        MediaToolExecutionBinder binder = new MediaToolExecutionBinder(ledger,
                (tenant, invocation) -> Optional.empty(), (principal, identity) -> replayAuthority.get());
        ToolHandler configuredProvider = (envelope, contract) -> {
            providerCalls.incrementAndGet();
            return io.activej.promise.Promise.of(ToolExecutionResult.succeeded(
                    envelope.invocationId(), Map.of("transcript", "must-not-be-produced"), Map.of(),
                    envelope.invocationId(), Instant.now(), java.time.Duration.ZERO));
        };
        ToolHandler handlerWithoutAdmission = new SpeechToTextToolHandler(configuredProvider);
        ToolExecutionEnvelope original = envelope("tenant-agent", "agent-1");
        ToolContract contract = contract(original);

        ToolExecutionResult notAdmitted = runPromise(() -> binder.execute(handlerWithoutAdmission, original, contract));
        assertThat(notAdmitted.status()).isEqualTo(ToolExecutionStatus.FAILED);
        assertThat(notAdmitted.failure().kind()).isEqualTo(
                com.ghatana.agent.framework.tools.ToolExecutionFailure.Kind.UNAVAILABLE);
        assertThat(notAdmitted.failure().stage()).isEqualTo(
                com.ghatana.agent.framework.tools.ToolExecutionFailure.Stage.ADMISSION);
        assertThat(notAdmitted.failure().code()).isEqualTo("STT_NOT_ADMITTED");
        assertThat(notAdmitted.output()).isNull();

        AuthenticatedPrincipal authorized = new AuthenticatedPrincipal(
                original.tenantId(), original.callerAgentId(), Instant.now());
        ToolExecutionResult replay = runPromise(() -> binder.execute(
                handlerWithoutAdmission, original, contract, authorized));
        assertThat(replay).isSameAs(notAdmitted);

        ToolExecutionEnvelope wrongTenant = sameInvocation(original, "other-tenant", original.callerAgentId());
        assertThatThrownBy(() -> runPromise(() -> binder.execute(
                handlerWithoutAdmission, wrongTenant, contract(wrongTenant))))
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

    private static ToolExecutionEnvelope envelope(String tenantId, String callerAgentId) {
        return ToolExecutionEnvelope.of(SpeechToTextToolHandler.TOOL_ID, "1.0.0", callerAgentId, null,
                tenantId, ToolActionClass.CALL_EXTERNAL, "1.0",
                Map.of("audioSource", Map.of("mediaArtifactId", "source-v1"), "languageCode", "en-US"));
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
