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
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.ClaimResult;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.InvocationLedger;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.LogicalAction;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.LogicalOutcome;
import com.ghatana.tools.testing.EventloopTestBase;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Factory wiring coverage for AT-05; the in-memory ledger is test-only. */
class AudioVideoToolHandlerFactoryAt05Test extends EventloopTestBase {

    private static final class TestLedger implements InvocationLedger {
        private final Map<String, LogicalAction> actions = new HashMap<>();
        private final AtomicInteger claims = new AtomicInteger();

        @Override
        public synchronized Optional<LogicalAction> find(String invocationId) {
            return Optional.ofNullable(actions.get(invocationId));
        }

        @Override
        public synchronized void record(LogicalAction action) {
            actions.put(action.invocationId(), action);
        }

        @Override
        public synchronized ClaimResult claim(LogicalAction unknownFence) {
            claims.incrementAndGet();
            return actions.putIfAbsent(unknownFence.invocationId(), unknownFence) == null
                    ? ClaimResult.CLAIMED : ClaimResult.ALREADY_CLAIMED;
        }

        @Override
        public synchronized boolean complete(LogicalAction terminalAction) {
            LogicalAction current = actions.get(terminalAction.invocationId());
            if (current == null || current.outcome() != LogicalOutcome.OUTCOME_UNKNOWN
                    || !current.requestIdentity().equals(terminalAction.requestIdentity())) {
                return false;
            }
            actions.put(terminalAction.invocationId(), terminalAction);
            return true;
        }
    }

    @Test
    void injectedBinderWrapsFactoryHandlerAndRequiresAuthenticationForReplay() {
        TestLedger ledger = new TestLedger();
        MediaToolExecutionBinder binder = new MediaToolExecutionBinder(ledger, (tenant, invocation) -> Optional.empty());
        AudioVideoToolHandlerFactory factory = new AudioVideoToolHandlerFactory(binder);
        var handler = factory.create(AudioVideoToolHandlerFactory.TOOL_ID_STT);
        ToolExecutionEnvelope envelope = ToolExecutionEnvelope.of(
                AudioVideoToolHandlerFactory.TOOL_ID_STT,
                "1.0.0",
                "caller-agent",
                null,
                "tenant-at05",
                ToolActionClass.CALL_EXTERNAL,
                "1.0",
                Map.of(
                        "audioSource", Map.of("mediaArtifactId", "artifact-at05"),
                        "languageCode", "en-US"));
        ToolContract contract = new ToolContract(envelope.toolId(), envelope.toolVersion(), "STT", "test",
                envelope.actionClass(), false, true, Map.of("type", "object"), Map.of("type", "object"),
                Set.of(), ToolTransport.IN_PROCESS, null, Map.of());

        ToolExecutionResult first = runPromise(() -> handler.handle(envelope, contract));
        assertThatThrownBy(() -> runPromise(() -> handler.handle(envelope, contract)))
                .isInstanceOf(MediaToolExecutionBinder.InvocationReplayDeniedException.class);

        assertThat(first.status()).isEqualTo(ToolExecutionStatus.FAILED);
        assertThat(first.failure().kind()).isEqualTo(
                com.ghatana.agent.framework.tools.ToolExecutionFailure.Kind.UNAVAILABLE);
        assertThat(first.failure().stage()).isEqualTo(
                com.ghatana.agent.framework.tools.ToolExecutionFailure.Stage.ADMISSION);
        assertThat(first.failure().code()).isEqualTo("STT_NOT_ADMITTED");
        assertThat(first.invocationId()).isEqualTo(envelope.invocationId());
        assertThat(first.correlationId()).isEqualTo(envelope.invocationId());
        assertThat(ledger.claims).hasValue(2);
        assertThat(ledger.find(envelope.invocationId())).hasValueSatisfying(action -> {
            assertThat(action.outcome()).isEqualTo(LogicalOutcome.FAILED);
            assertThat(action.result()).isSameAs(first);
        });
    }

    @Test
    void absentOwnerLedgerPreventsAnyHandlerAdmission() {
        InvocationLedger unavailable = new InvocationLedger() {
            @Override public Optional<LogicalAction> find(String invocationId) { return Optional.empty(); }
            @Override public void record(LogicalAction action) { throw new AssertionError("must not record"); }
        };
        var binder = new MediaToolExecutionBinder(unavailable, (tenant, invocation) -> Optional.empty());
        var factory = new AudioVideoToolHandlerFactory(binder);
        ToolExecutionEnvelope envelope = ToolExecutionEnvelope.of(
                AudioVideoToolHandlerFactory.TOOL_ID_STT, "1.0.0", "caller-agent", null, "tenant-at05",
                ToolActionClass.CALL_EXTERNAL, "1.0", Map.of());
        ToolContract contract = new ToolContract(envelope.toolId(), envelope.toolVersion(), "STT", "test",
                envelope.actionClass(), false, true, Map.of(), Map.of(), Set.of(), ToolTransport.IN_PROCESS,
                null, Map.of());

        assertThatThrownBy(() -> runPromise(() -> factory.create(envelope.toolId()).handle(envelope, contract)))
                .isInstanceOf(MediaToolExecutionBinder.InvocationClaimUnavailableException.class);
    }
}
