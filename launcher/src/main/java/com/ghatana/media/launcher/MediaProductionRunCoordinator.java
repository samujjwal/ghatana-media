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

    /** Origin classes — an output's provenance class is fixed at sealing. */
    public enum OriginClass {
        REAL_CAPTURE, DECLARATIVE_ANIMATION, MODEL_SIMULATION
    }

    /** Step verdict: honest about what actually happened. */
    public enum StepOutcome {
        PRODUCED,
        SKIPPED_MANUAL_GATE,
        OUTCOME_UNKNOWN,
        FAILED
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
            Objects.requireNonNull(stepId, "stepId");
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
            Objects.requireNonNull(stepId, "stepId");
            Objects.requireNonNull(originClass, "originClass");
            Objects.requireNonNull(sourceRevisionRef, "sourceRevisionRef");
            Objects.requireNonNull(planFingerprint, "planFingerprint");
            Objects.requireNonNull(effectiveRightsRef, "effectiveRightsRef");
            if (!contentSha256.matches("[a-f0-9]{64}")) {
                throw new IllegalArgumentException("contentSha256 must be lowercase hex");
            }
        }
    }

    /** One durable ledger record — the fence against duplicate effects. */
    public record StepRecord(
            String stepId,
            StepOutcome outcome,
            ProducedOutput output) {
    }

    /** Durable step ledger; the canonical job/attempt store owns the binding. */
    public interface StepLedger {
        Optional<StepRecord> find(String runId, String stepId);
        void record(String runId, StepRecord record);
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
     * the record — the executor never runs twice for the same run+step.
     */
    public StepResult executeStep(
            String runId,
            String planFingerprint,
            ProductionStep step,
            StepExecutor executor) {
        Objects.requireNonNull(runId, "runId");
        Objects.requireNonNull(planFingerprint, "planFingerprint");
        Objects.requireNonNull(step, "step");
        Objects.requireNonNull(executor, "executor");

        Optional<StepRecord> prior = ledger.find(runId, step.stepId());
        if (prior.isPresent()) {
            StepRecord recorded = prior.get();
            return new StepResult(recorded.stepId(), recorded.outcome(),
                    Optional.ofNullable(recorded.output()),
                    "recorded " + recorded.outcome());
        }

        if (step.manualGate()) {
            StepRecord skipped = new StepRecord(step.stepId(), StepOutcome.SKIPPED_MANUAL_GATE, null);
            ledger.record(runId, skipped);
            return new StepResult(step.stepId(), StepOutcome.SKIPPED_MANUAL_GATE,
                    Optional.empty(), "manual gate not auto-executed");
        }

        byte[] bytes;
        try {
            bytes = executor.execute(step.stepId(), step);
        } catch (StepAmbiguousException ambiguous) {
            // The effect may exist downstream — UNKNOWN is recorded; a replay
            // reads it and never re-executes.
            StepRecord unknown = new StepRecord(step.stepId(), StepOutcome.OUTCOME_UNKNOWN, null);
            ledger.record(runId, unknown);
            return new StepResult(step.stepId(), StepOutcome.OUTCOME_UNKNOWN,
                    Optional.empty(), "ambiguous: " + ambiguous.getMessage());
        } catch (RuntimeException failure) {
            StepRecord failed = new StepRecord(step.stepId(), StepOutcome.FAILED, null);
            ledger.record(runId, failed);
            return new StepResult(step.stepId(), StepOutcome.FAILED,
                    Optional.empty(), "failed: " + failure.getClass().getSimpleName());
        }

        if (bytes == null || bytes.length == 0) {
            StepRecord failed = new StepRecord(step.stepId(), StepOutcome.FAILED, null);
            ledger.record(runId, failed);
            return new StepResult(step.stepId(), StepOutcome.FAILED,
                    Optional.empty(), "executor produced no bytes");
        }

        ProducedOutput output = new ProducedOutput(
                step.stepId(), step.originClass(), step.sourceRevisionRef(),
                planFingerprint, sha256(bytes), step.effectiveRightsRef(), bytes.length);
        ledger.record(runId, new StepRecord(step.stepId(), StepOutcome.PRODUCED, output));
        return new StepResult(step.stepId(), StepOutcome.PRODUCED,
                Optional.of(output), "produced");
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }
}
