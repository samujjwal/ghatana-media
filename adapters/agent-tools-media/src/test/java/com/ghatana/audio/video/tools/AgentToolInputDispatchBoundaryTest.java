/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolActionClass;
import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.agent.framework.tools.ToolTransport;
import com.ghatana.tools.testing.EventloopTestBase;
import io.activej.promise.Promise;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** AT-02/05: malformed local delegate boundaries remain exceptional and cannot appear successful. */
class AgentToolInputDispatchBoundaryTest extends EventloopTestBase {

    @Test
    void synchronousThrowNullPromiseAndForeignInvocationResultFailClosed() {
        ToolExecutionEnvelope envelope = ToolExecutionEnvelope.of(
                SpeechToTextToolHandler.TOOL_ID, "1.0.0", "fixture-agent", null,
                "fixture-tenant", ToolActionClass.CALL_EXTERNAL, "1.0", Map.of());
        ToolContract contract = new ToolContract(envelope.toolId(), envelope.toolVersion(), "fixture", "fixture",
                envelope.actionClass(), false, true, Map.of(), Map.of(), Set.of(),
                ToolTransport.IN_PROCESS, null, Map.of());

        var synchronousThrow = (com.ghatana.toolruntime.ToolHandler) (ignoredEnvelope, ignoredContract) -> {
            throw new IllegalStateException("local fixture dispatch failure");
        };
        assertThatThrownBy(() -> runPromise(() -> AgentToolInput.dispatch(synchronousThrow, envelope, contract)))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("local fixture dispatch failure");

        var nullPromise = (com.ghatana.toolruntime.ToolHandler) (ignoredEnvelope, ignoredContract) -> null;
        assertThatThrownBy(() -> runPromise(() -> AgentToolInput.dispatch(nullPromise, envelope, contract)))
                .isInstanceOf(NullPointerException.class)
                .hasMessage("delegate returned null promise");

        var foreignResult = (com.ghatana.toolruntime.ToolHandler) (ignoredEnvelope, ignoredContract) ->
                Promise.of(ToolExecutionResult.succeeded("foreign-invocation", Map.of(), Map.of(),
                        "foreign-invocation", Instant.now(), Duration.ZERO));
        assertThatThrownBy(() -> runPromise(() -> AgentToolInput.dispatch(foreignResult, envelope, contract)))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("DELEGATE_INVOCATION_IDENTITY_MISMATCH");
    }
}
