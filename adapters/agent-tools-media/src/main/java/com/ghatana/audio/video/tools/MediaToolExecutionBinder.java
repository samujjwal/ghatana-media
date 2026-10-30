package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.agent.framework.tools.ToolExecutionStatus;
import com.ghatana.toolruntime.ToolHandler;
import io.activej.promise.Promise;

import java.util.Objects;
import java.util.Optional;

/**
 * AT-05: bind a Tools runtime execution envelope to exactly one logical Media
 * action with durable outcome readback.
 *
 * <p>Dispatch is an effect boundary: the delegate may have performed an
 * external effect even when the local call fails ambiguously. The binder
 * records the outcome per {@code invocationId} — a replay of the same
 * invocation returns the recorded result for SUCCESS/FAILED and, for
 * OUTCOME_UNKNOWN, surfaces the unknown outcome with the durable Media job
 * state (when the readback knows it) <em>without ever re-dispatching</em>.
 * A timeout after an unknown effect can therefore never trigger a blind
 * second provider call.
 *
 * <p>Error surfaces stay sanitized: exception messages carry the invocation
 * and durable state only — never envelope input, artifact bytes or tenant
 * detail beyond the correlation identity.
 *
 * @doc.type class
 * @doc.purpose One-logical-action binding between Tools envelopes and Media jobs
 * @doc.layer product
 * @doc.pattern Idempotent Binder
 */
public final class MediaToolExecutionBinder {

    /** What the ledger durably knows about one invocation. */
    public enum LogicalOutcome {
        /** The delegate returned a successful result. */
        SUCCESS,
        /** A terminal failed result — validation or delegate-declared failure. */
        FAILED,
        /** Dispatch outcome ambiguous — the effect may exist downstream. */
        OUTCOME_UNKNOWN
    }

    /** One recorded logical action — the single source of truth per invocation. */
    public record LogicalAction(
            String invocationId,
            String toolId,
            LogicalOutcome outcome,
            ToolExecutionResult result) {
        public LogicalAction {
            Objects.requireNonNull(invocationId, "invocationId");
            Objects.requireNonNull(toolId, "toolId");
            Objects.requireNonNull(outcome, "outcome");
            Objects.requireNonNull(result, "result");
        }
    }

    /** Durable invocation ledger; the shared run ledger owns the real binding. */
    public interface InvocationLedger {
        Optional<LogicalAction> find(String invocationId);
        void record(LogicalAction action);
    }

    /** Readback of the durable Media job state for one invocation. */
    @FunctionalInterface
    public interface MediaJobReadback {
        /** The durable job state for this invocation, when it exists. */
        Optional<String> durableJobState(String tenantId, String invocationId);
    }

    /**
     * Surfaced on the error channel whenever the true downstream outcome is
     * unknown — after an ambiguous dispatch or on replay of one. Carries the
     * invocation identity and the durable job state if the readback knows
     * it; never fabricated as SUCCESS or clean FAILED.
     */
    public static final class OutcomeUnknownException extends RuntimeException {
        private final String invocationId;
        private final String durableJobState;

        OutcomeUnknownException(String invocationId, String durableJobState) {
            super("tool invocation outcome is unknown: " + invocationId
                    + (durableJobState == null ? "" : " (durable job state: " + durableJobState + ")"));
            this.invocationId = invocationId;
            this.durableJobState = durableJobState;
        }

        public String invocationId() {
            return invocationId;
        }

        /** The durable Media job state, or null when the readback found none. */
        public String durableJobState() {
            return durableJobState;
        }
    }

    private final InvocationLedger ledger;
    private final MediaJobReadback jobReadback;

    public MediaToolExecutionBinder(InvocationLedger ledger, MediaJobReadback jobReadback) {
        this.ledger = Objects.requireNonNull(ledger, "ledger");
        this.jobReadback = Objects.requireNonNull(jobReadback, "jobReadback");
    }

    /**
     * Executes one envelope idempotently. A recorded prior outcome is
     * returned verbatim — the delegate is invoked at most once per
     * invocationId.
     */
    public Promise<ToolExecutionResult> execute(
            ToolHandler delegate,
            ToolExecutionEnvelope envelope,
            ToolContract contract) {
        Objects.requireNonNull(delegate, "delegate");
        Objects.requireNonNull(envelope, "envelope");
        Objects.requireNonNull(contract, "contract");

        Optional<LogicalAction> prior = ledger.find(envelope.invocationId());
        if (prior.isPresent()) {
            LogicalAction recorded = prior.get();
            if (recorded.outcome() == LogicalOutcome.OUTCOME_UNKNOWN) {
                // Readback only annotates the unknown outcome — never a retry.
                String durableState = jobReadback
                        .durableJobState(envelope.tenantId(), envelope.invocationId())
                        .orElse(null);
                return Promise.ofException(
                        new OutcomeUnknownException(envelope.invocationId(), durableState));
            }
            return Promise.of(recorded.result());
        }

        return AgentToolInput.dispatch(delegate, envelope, contract)
                .map(result -> {
                    LogicalOutcome outcome = result.status() == ToolExecutionStatus.SUCCESS
                            ? LogicalOutcome.SUCCESS
                            : LogicalOutcome.FAILED;
                    ledger.record(new LogicalAction(
                            envelope.invocationId(), envelope.toolId(), outcome, result));
                    return result;
                })
                .mapException(failure -> {
                    // An ambiguous dispatch stays on the error channel and is
                    // recorded UNKNOWN — the runtime reconciles via readback,
                    // never by re-invoking.
                    ledger.record(new LogicalAction(
                            envelope.invocationId(), envelope.toolId(),
                            LogicalOutcome.OUTCOME_UNKNOWN,
                            ToolExecutionResult.failed(
                                    envelope.invocationId(),
                                    "outcome unknown",
                                    envelope.invocationId(),
                                    java.time.Instant.now(),
                                    java.time.Duration.ZERO)));
                    return failure instanceof RuntimeException runtime
                            ? runtime
                            : new IllegalStateException("dispatch failed", failure);
                });
    }
}
