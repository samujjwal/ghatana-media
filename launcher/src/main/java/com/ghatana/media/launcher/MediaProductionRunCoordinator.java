package com.ghatana.media.launcher;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

/**
 * H-07: coordinate a compiled production plan into qualified outputs with
 * sealed provenance.
 *
 * <p>Every produced output carries its origin class
 * (REAL_CAPTURE / DECLARATIVE_ANIMATION / MODEL_SIMULATION), immutable
 * source/version plus the plan fingerprint, a verifiable SHA-256 checksum
 * and effective rights — provenance is sealed at production and cannot be
 * relabeled afterward.
 *
 * <p>A run is fenced to a single attempt: a crash or UNKNOWN dispatch does
 * not produce a duplicate external effect — the coordinator records the
 * step outcome and a replay reads the ledger, never re-executes.
 *
 * @doc.type class
 * @doc.purpose Sealed-provenance production run coordinator
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

    private final StepLedger ledger;

    public MediaProductionRunCoordinator(StepLedger ledger) {
        this.ledger = Objects.requireNonNull(ledger, "ledger");
    }

    /**
     * Executes one step of a run. Manual gates never auto-execute — they are
     * recorded SKIPPED and return immediately. An ambiguous dispatch records
     * OUTCOME_UNKNOWN; a replay of either terminal or UNKNOWN outcome returns
     * the record. At-most-once dispatch depends on the ledger implementing the
     * durable atomic claim contract; the default implementation refuses execution.
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

        Optional<StepRecord> prior = ledger.find(runId, step.stepId());
        if (prior.isPresent()) {
            StepRecord recorded = prior.get();
            if (!recorded.isBound()) {
                throw new StepConflictException("legacy step record is unbound; refusing replay");
            }
            if (!recorded.planFingerprint().equals(planFingerprint) || !recorded.step().equals(step)) {
                throw new StepConflictException("run/step identity was already bound to different plan inputs");
            }
            return new StepResult(recorded.stepId(), recorded.outcome(),
                    Optional.ofNullable(recorded.output()),
                    "recorded " + recorded.outcome());
        }

        StepRecord firstRecord = new StepRecord(step.stepId(), planFingerprint, step,
                step.manualGate() ? StepOutcome.SKIPPED_MANUAL_GATE : StepOutcome.OUTCOME_UNKNOWN, null);
        ClaimResult claim = ledger.claim(runId, firstRecord);
        if (claim != ClaimResult.CLAIMED && claim != ClaimResult.ALREADY_CLAIMED) {
            return new StepResult(step.stepId(), StepOutcome.NOT_ADMITTED,
                    Optional.empty(), "durable pre-effect claim unavailable");
        }
        if (claim == ClaimResult.ALREADY_CLAIMED) {
            Optional<StepRecord> raced = ledger.find(runId, step.stepId());
            if (raced.isEmpty()) {
                return new StepResult(step.stepId(), StepOutcome.NOT_ADMITTED,
                        Optional.empty(), "durable claim exists without readable fence");
            }
            StepRecord recorded = raced.get();
            if (!recorded.isBound() || !recorded.planFingerprint().equals(planFingerprint)
                    || !recorded.step().equals(step)) {
                throw new StepConflictException("run/step identity was already bound to different plan inputs");
            }
            return new StepResult(recorded.stepId(), recorded.outcome(),
                    Optional.ofNullable(recorded.output()), "recorded " + recorded.outcome());
        }

        // A CLAIMED response is only useful if the exact pre-effect fence is
        // durably readable under this run/step key. Do not trust an adapter
        // that acknowledges a claim without persisting its plan/source/rights
        // binding: dispatching in that case could permit a duplicate effect.
        Optional<StepRecord> persistedClaim = ledger.find(runId, step.stepId());
        if (persistedClaim.isEmpty() || !persistedClaim.get().equals(firstRecord)) {
            return new StepResult(step.stepId(), StepOutcome.NOT_ADMITTED,
                    Optional.empty(), "durable pre-effect claim could not be verified");
        }

        if (step.manualGate()) {
            return new StepResult(step.stepId(), StepOutcome.SKIPPED_MANUAL_GATE,
                    Optional.empty(), "manual gate not auto-executed");
        }

        byte[] bytes;
        try {
            bytes = executor.execute(step.stepId(), step);
        } catch (StepAmbiguousException ambiguous) {
            // The effect may exist downstream — UNKNOWN is recorded; a replay
            // reads it and never re-executes.
            return new StepResult(step.stepId(), StepOutcome.OUTCOME_UNKNOWN,
                    Optional.empty(), "ambiguous effect; outcome requires reconciliation");
        } catch (RuntimeException failure) {
            return new StepResult(step.stepId(), StepOutcome.OUTCOME_UNKNOWN,
                    Optional.empty(), "post-dispatch failure; outcome requires reconciliation");
        }

        if (bytes == null || bytes.length == 0) {
            return new StepResult(step.stepId(), StepOutcome.OUTCOME_UNKNOWN,
                    Optional.empty(), "executor returned no verifiable bytes after dispatch");
        }

        try {
            ProducedOutput output = new ProducedOutput(
                    step.stepId(), step.originClass(), step.sourceRevisionRef(),
                    planFingerprint, sha256(bytes), step.effectiveRightsRef(), bytes.length);
            ledger.record(runId, new StepRecord(step.stepId(), planFingerprint, step, StepOutcome.PRODUCED, output));
            return new StepResult(step.stepId(), StepOutcome.PRODUCED,
                    Optional.of(output), "produced");
        } catch (RuntimeException persistenceFailure) {
            return new StepResult(step.stepId(), StepOutcome.OUTCOME_UNKNOWN,
                    Optional.empty(), "post-dispatch persistence failure; outcome requires reconciliation");
        }
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
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
