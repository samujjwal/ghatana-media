package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolActionClass;
import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.agent.framework.tools.ToolExecutionStatus;
import com.ghatana.agent.framework.tools.ToolTransport;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.LogicalAction;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.LogicalOutcome;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.OutcomeUnknownException;
import com.ghatana.tools.testing.EventloopTestBase;
import io.activej.promise.Promise;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * AT-05/06: one logical action per invocation — same-key replay preserves the
 * recorded outcome, ambiguous dispatch stays OUTCOME_UNKNOWN and is never
 * blindly retried, and every registered tool id resolves a real handler.
 */
class MediaToolExecutionBinderTest extends EventloopTestBase {

    private static final class InMemoryLedger implements MediaToolExecutionBinder.InvocationLedger {
        private final Map<String, LogicalAction> records = new HashMap<>();
        @Override public Optional<LogicalAction> find(String invocationId) {
            return Optional.ofNullable(records.get(invocationId));
        }
        @Override public void record(LogicalAction action) {
            records.put(action.invocationId(), action);
        }
    }

    private static ToolExecutionEnvelope envelope(String toolId) {
        return ToolExecutionEnvelope.of(
                toolId, "1.0.0", "caller-agent", null,
                "tenant-1", ToolActionClass.CALL_EXTERNAL, "1.0", Map.of());
    }

    private static ToolContract contractFor(ToolExecutionEnvelope envelope) {
        return new ToolContract(envelope.toolId(), envelope.toolVersion(), "Test", "d",
                envelope.actionClass(), false, true, Map.of(), Map.of(), java.util.Set.of(),
                ToolTransport.IN_PROCESS, null, Map.of());
    }

    private static MediaToolExecutionBinder binder(
            InMemoryLedger ledger, Map<String, String> durableJobs) {
        return new MediaToolExecutionBinder(ledger,
                (tenant, invocation) -> Optional.ofNullable(durableJobs.get(invocation)));
    }

    @Test
    void sameInvocationIdReturnsOneLogicalAction() {
        InMemoryLedger ledger = new InMemoryLedger();
        var binder = binder(ledger, Map.of());
        AtomicInteger dispatches = new AtomicInteger();
        ToolExecutionEnvelope envelope = envelope("av.speech-to-text");
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) -> {
            dispatches.incrementAndGet();
            return Promise.of(ToolExecutionResult.succeeded(
                    e.invocationId(), Map.of("transcript", "hello"), Map.of(),
                    e.invocationId(), Instant.now(), Duration.ZERO));
        };

        ToolExecutionResult first = runPromise(() -> binder.execute(delegate, envelope, contractFor(envelope)));
        assertThat(first.status()).isEqualTo(ToolExecutionStatus.SUCCESS);

        // Replay returns the recorded result — no second dispatch.
        ToolExecutionResult replay = runPromise(() -> binder.execute(delegate, envelope, contractFor(envelope)));
        assertThat(replay).isSameAs(first);
        assertThat(dispatches.get()).isEqualTo(1);
    }

    @Test
    void ambiguousDispatchStaysUnknownAndReplayNeverRedispatches() {
        InMemoryLedger ledger = new InMemoryLedger();
        var binder = binder(ledger, Map.of());
        AtomicInteger dispatches = new AtomicInteger();
        ToolExecutionEnvelope envelope = envelope("av.vision-analysis");
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) -> {
            dispatches.incrementAndGet();
            return Promise.ofException(new IllegalStateException("transport dropped after dispatch"));
        };

        assertThatThrownBy(() -> runPromise(() -> binder.execute(delegate, envelope, contractFor(envelope))))
                .isInstanceOf(IllegalStateException.class);
        assertThat(ledger.find(envelope.invocationId())).hasValueSatisfying(action ->
                assertThat(action.outcome()).isEqualTo(LogicalOutcome.OUTCOME_UNKNOWN));

        // A replay after the unknown effect must not invoke the delegate again.
        assertThatThrownBy(() -> runPromise(() -> binder.execute(delegate, envelope, contractFor(envelope))))
                .isInstanceOf(OutcomeUnknownException.class)
                .satisfies(thrown -> assertThat(((OutcomeUnknownException) thrown).invocationId())
                        .isEqualTo(envelope.invocationId()));
        assertThat(dispatches.get()).isEqualTo(1);
    }

    @Test
    void unknownReplayAnnotatesTheDurableJobStateWhenReadbackKnowsIt() {
        InMemoryLedger ledger = new InMemoryLedger();
        ToolExecutionEnvelope envelope = envelope("av.multimodal-inference");
        var binder = binder(ledger, Map.of(envelope.invocationId(), "RUNNING"));
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) ->
                Promise.ofException(new IllegalStateException("ambiguous"));

        assertThatThrownBy(() -> runPromise(() -> binder.execute(delegate, envelope, contractFor(envelope))));
        assertThatThrownBy(() -> runPromise(() -> binder.execute(delegate, envelope, contractFor(envelope))))
                .isInstanceOf(OutcomeUnknownException.class)
                .satisfies(thrown -> assertThat(((OutcomeUnknownException) thrown).durableJobState())
                        .isEqualTo("RUNNING"));
    }

    @Test
    void recordedFailedOutcomeReplaysAsFailedNotRedispatched() {
        InMemoryLedger ledger = new InMemoryLedger();
        var binder = binder(ledger, Map.of());
        AtomicInteger dispatches = new AtomicInteger();
        ToolExecutionEnvelope envelope = envelope("av.text-to-speech");
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) -> {
            dispatches.incrementAndGet();
            return Promise.of(ToolExecutionResult.failed(
                    e.invocationId(), "provider rejected", e.invocationId(),
                    Instant.now(), Duration.ZERO));
        };

        ToolExecutionResult first = runPromise(() -> binder.execute(delegate, envelope, contractFor(envelope)));
        assertThat(first.status()).isNotEqualTo(ToolExecutionStatus.SUCCESS);
        ToolExecutionResult replay = runPromise(() -> binder.execute(delegate, envelope, contractFor(envelope)));
        assertThat(replay).isSameAs(first);
        assertThat(dispatches.get()).isEqualTo(1);
    }

    @Test
    void everyRegisteredToolIdResolvesARealHandler() {
        AudioVideoToolHandlerFactory factory = new AudioVideoToolHandlerFactory();
        // AT-06: no registered-but-missing handler.
        for (String toolId : factory.toolIds()) {
            assertThat(factory.create(toolId)).isNotNull();
        }
        // Unknown ids fail closed — never a fabricated handler.
        assertThatThrownBy(() -> factory.create("av.nonexistent"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> factory.create("datacloud.media.artifacts"))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
