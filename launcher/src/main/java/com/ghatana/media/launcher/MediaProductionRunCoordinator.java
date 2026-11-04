package com.ghatana.media.launcher;

import java.util.List;
import java.util.Objects;
import java.util.Optional;

/**
 * H-07: source-only production coordinator candidate with fail-closed
 * admission behavior.
 *
 * <p>{@link ProducedOutput} defines the immutable metadata shape expected of
 * a future qualified output. Constructing that value does not verify artifact
 * bytes, rights, provider qualification, or production admission.
 *
 * <p>This source-only candidate has no bound rights resolver or canonical
 * job/attempt ledger wired into it. It therefore refuses production steps
 * as NOT_ADMITTED. The ledger and executor interfaces describe the required
 * integration seam; a fixture implementation cannot authorize effects.
 *
 * @doc.type class
 * @doc.purpose Fail-closed production run coordinator candidate
 * @doc.layer product
 * @doc.pattern Coordinator
 */
public final class MediaProductionRunCoordinator {

    private static final java.util.regex.Pattern SAFE_ID =
            java.util.regex.Pattern.compile("[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}");
    private static final java.util.regex.Pattern SHA256_FINGERPRINT =
            java.util.regex.Pattern.compile("sha256:[a-f0-9]{64}");

    /** Origin classes — an output's provenance class is fixed at sealing. */
    public enum OriginClass {
        REAL_CAPTURE, DECLARATIVE_ANIMATION, MODEL_SIMULATION
    }

    /** Step verdict: honest about what actually happened. */
    public enum StepOutcome {
        PRODUCED,
        SKIPPED_MANUAL_GATE,
        NOT_ADMITTED,
        OUTCOME_UNKNOWN,
        FAILED
    }

    /** Atomic durable pre-effect claim result. */
    public enum ClaimResult {
        CLAIMED,
        ALREADY_CLAIMED,
        NOT_ADMITTED
    }

    /**
     * Executor for one production step — produces real bytes only. A thrown
     * exception is ambiguous: the effect may have occurred downstream.
     */
    @FunctionalInterface
    public interface StepExecutor {
        byte[] execute(String stepId, ProductionStep step) throws StepAmbiguousException;
    }

    /** The step effect may exist; no verifiable bytes returned. */
    public static final class StepAmbiguousException extends Exception {
        public StepAmbiguousException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    /** One step in the run — its inputs are exact version refs. */
    public record ProductionStep(
            String stepId,
            OriginClass originClass,
            String sourceRevisionRef,
            String effectiveRightsRef,
            boolean manualGate) {
        public ProductionStep {
            requireIdentity(stepId, "stepId");
            Objects.requireNonNull(originClass, "originClass");
            for (String field : List.of(sourceRevisionRef, effectiveRightsRef)) {
                if (field == null || field.isBlank() || field.length() > 384) {
                    throw new IllegalArgumentException("step field is required and bounded");
                }
            }
        }
    }

    /** A sealed produced output — immutable provenance + checksum. */
    public record ProducedOutput(
            String stepId,
            OriginClass originClass,
            String sourceRevisionRef,
            String planFingerprint,
            String contentSha256,
            String effectiveRightsRef,
            int byteCount) {
        public ProducedOutput {
            requireIdentity(stepId, "stepId");
            Objects.requireNonNull(originClass, "originClass");
            requireBoundedText(sourceRevisionRef, "sourceRevisionRef");
            requireFingerprint(planFingerprint);
            requireBoundedText(effectiveRightsRef, "effectiveRightsRef");
            if (!contentSha256.matches("[a-f0-9]{64}")) {
                throw new IllegalArgumentException("contentSha256 must be lowercase hex");
            }
            if (byteCount <= 0) throw new IllegalArgumentException("byteCount must be positive");
        }
    }

    /** One ledger record; a durable atomic claim must fence external effects. */
    public record StepRecord(
            String stepId,
            String planFingerprint,
            ProductionStep step,
            StepOutcome outcome,
            ProducedOutput output) {
        public StepRecord {
            requireIdentity(stepId, "stepId");
            Objects.requireNonNull(outcome, "outcome");
            if ((outcome == StepOutcome.PRODUCED) != (output != null)) {
                throw new IllegalArgumentException("only a produced record carries output provenance");
            }
            if (planFingerprint == null && step == null) {
                // Legacy records preserve the old public constructor but carry no invented binding.
                if (output != null && !output.stepId().equals(stepId)) {
                    throw new IllegalArgumentException("legacy output step identity mismatch");
                }
            } else {
                requireFingerprint(planFingerprint);
                Objects.requireNonNull(step, "step");
                if (!stepId.equals(step.stepId())) {
                    throw new IllegalArgumentException("record step identity mismatch");
                }
                if (step.manualGate() != (outcome == StepOutcome.SKIPPED_MANUAL_GATE)) {
                    throw new IllegalArgumentException("manual-gate steps must remain skipped and non-manual steps cannot be skipped");
                }
                if (output != null && (!output.stepId().equals(step.stepId())
                        || output.originClass() != step.originClass()
                        || !output.sourceRevisionRef().equals(step.sourceRevisionRef())
                        || !output.planFingerprint().equals(planFingerprint)
                        || !output.effectiveRightsRef().equals(step.effectiveRightsRef()))) {
                    throw new IllegalArgumentException("output provenance does not match its step record");
                }
            }
        }

        /** Source/binary compatibility only; no plan or source evidence is inferred. */
        public StepRecord(String stepId, StepOutcome outcome, ProducedOutput output) {
            this(stepId, null, null, outcome, output);
        }

        public boolean isBound() {
            return planFingerprint != null && step != null;
        }
    }

    /** A run/step key cannot be rebound to changed plan or source/rights inputs. */
    public static final class StepConflictException extends IllegalStateException {
        public StepConflictException(String message) {
            super(message);
        }
    }

    /** Durable step ledger; the canonical job/attempt store owns the binding. */
    public interface StepLedger {
        Optional<StepRecord> find(String runId, String stepId);
        void record(String runId, StepRecord record);

        /**
         * Atomically persist the supplied first record iff the key is
         * unclaimed. Non-manual execution supplies an OUTCOME_UNKNOWN fence;
         * manual gates supply their terminal skip record. Existing
         * implementations fail closed until they provide a canonical durable
         * implementation.
         */
        default ClaimResult claim(String runId, StepRecord unknownFence) {
            return ClaimResult.NOT_ADMITTED;
        }
    }

    /** The result of one step attempt — replays echo the recorded outcome. */
    public record StepResult(
            String stepId,
            StepOutcome outcome,
            Optional<ProducedOutput> output,
            String detail) {
    }

    public MediaProductionRunCoordinator(StepLedger ledger) {
        Objects.requireNonNull(ledger, "ledger");
    }

    /**
     * Fails closed until source-bound rights and the canonical process-fenced
     * job/attempt ledger are integrated. Manual gates are effect-free and
     * always remain skipped. The source-only in-memory fixtures in this module
     * are not admission evidence.
     */
    public StepResult executeStep(
            String runId,
            String planFingerprint,
            ProductionStep step,
            StepExecutor executor) {
        requireIdentity(runId, "runId");
        requireFingerprint(planFingerprint);
        Objects.requireNonNull(step, "step");
        Objects.requireNonNull(executor, "executor");

        if (step.manualGate()) {
            return new StepResult(step.stepId(), StepOutcome.SKIPPED_MANUAL_GATE,
                    Optional.empty(), "manual gate not auto-executed");
        }
        return new StepResult(step.stepId(), StepOutcome.NOT_ADMITTED,
                Optional.empty(), "source-bound rights and canonical process-fenced production authority unavailable");
    }

    private static void requireIdentity(String value, String field) {
        if (value == null || !SAFE_ID.matcher(value).matches()) {
            throw new IllegalArgumentException(field + " must be a bounded canonical identity");
        }
    }

    private static void requireFingerprint(String value) {
        if (value == null || !SHA256_FINGERPRINT.matcher(value).matches()) {
            throw new IllegalArgumentException("planFingerprint must be sha256-prefixed lowercase hex");
        }
    }

    private static void requireBoundedText(String value, String field) {
        if (value == null || value.isBlank() || value.length() > 384 || !value.equals(value.trim())) {
            throw new IllegalArgumentException(field + " is required and bounded");
        }
    }
}
