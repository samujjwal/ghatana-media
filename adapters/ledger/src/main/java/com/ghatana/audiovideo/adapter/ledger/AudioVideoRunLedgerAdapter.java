/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audiovideo.adapter.ledger;

import com.ghatana.core.lifecycle.ExecutionOutcome;
import com.ghatana.core.lifecycle.JobExecutionState;
import com.ghatana.datacloud.delivery.ledger.InputSnapshot;
import com.ghatana.datacloud.delivery.ledger.OutputSnapshot;
import com.ghatana.datacloud.delivery.ledger.RunLedger;
import com.ghatana.datacloud.delivery.ledger.WorkflowPolicySnapshot;

import java.util.*;

/**
 * @doc.type class
 * @doc.purpose Adapts Audio-Video product-specific processing jobs to unified RunLedger format
 * @doc.layer product
 * @doc.pattern Adapter
 *
 * Maps:
 * - ProcessingJob → RunLedger (for audio/video transcoding, STT, TTS, analysis jobs)
 * Lifecycle: SUBMITTED → TRANSCODING → PROCESSING → STORING → COMPLETED/FAILED
 */
public final class AudioVideoRunLedgerAdapter {
    private AudioVideoRunLedgerAdapter() {}

    /**
     * Converts an Audio-Video ProcessingJob to RunLedger format
     * @param jobId Unique identifier for the processing job
     * @param mediaType Type of media being processed (AUDIO, VIDEO, MULTIMODAL)
     * @param processingType Type of processing (TRANSCODING, STT, TTS, VISION_ANALYSIS)
     * @param collectionId Collection that owns this media
     * @param mediaArtifactId Reference to the media artifact being processed
     * @param inputParams Processing parameters
     * @param jobState Current job state (SUBMITTED, TRANSCODING, PROCESSING, STORING, COMPLETED, FAILED)
     * @param createdAtMs When job was created
     * @param startedAtMs When processing began
     * @param outputArtifactId Result artifact ID (if completed)
     * @param failureReason Failure details if job failed
     * @param providerName Provider used for processing (e.g., "deepgram", "openai", "azure-vision")
     * @param providerJobId Provider's job tracking ID
     * @param traceId Distributed trace ID
     * @param correlationId Business correlation ID
     * @return RunLedger record in unified format
     */
    public static RunLedger fromProcessingJob(
        String jobId,
        String mediaType,
        String processingType,
        String collectionId,
        String mediaArtifactId,
        Map<String, String> inputParams,
        String jobState,
        long createdAtMs,
        long startedAtMs,
        String outputArtifactId,
        String failureReason,
        String providerName,
        String providerJobId,
        String traceId,
        String correlationId
    ) {
        Objects.requireNonNull(jobId, "jobId must not be null");
        Objects.requireNonNull(mediaType, "mediaType must not be null");
        Objects.requireNonNull(processingType, "processingType must not be null");
        Objects.requireNonNull(collectionId, "collectionId must not be null");
        Objects.requireNonNull(jobState, "jobState must not be null");

        JobExecutionState mappedState = mapProcessingJobState(jobState);
        ExecutionOutcome mappedOutcome = mapProcessingJobOutcome(jobState);
        long now = System.currentTimeMillis();

        InputSnapshot inputs = new InputSnapshot(
            inputParams != null ? inputParams : Map.of(),
            null,
            Map.of(
                "mediaType", mediaType,
                "processingType", processingType,
                "mediaArtifactId", mediaArtifactId
            ),
            "system",
            createdAtMs
        );

        OutputSnapshot outputs;
        if (mappedOutcome == ExecutionOutcome.SUCCEEDED) {
            outputs = new OutputSnapshot(
                200,
                null,
                Map.of(),
                (startedAtMs > 0 ? now - startedAtMs : 0),
                Map.of(),
                outputArtifactId
            );
        } else if (mappedOutcome == ExecutionOutcome.FAILED) {
            outputs = new OutputSnapshot(
                500,
                failureReason,
                Map.of(),
                (startedAtMs > 0 ? now - startedAtMs : 0),
                Map.of(),
                null
            );
        } else if (mappedState == JobExecutionState.CANCELLED) {
            outputs = new OutputSnapshot(
                499,
                null,
                Map.of(),
                (startedAtMs > 0 ? now - startedAtMs : 0),
                Map.of(),
                null
            );
        } else {
            outputs = null;
        }

        Map<String, String> attributes = new HashMap<>();
        attributes.put("mediaType", mediaType);
        attributes.put("processingType", processingType);
        attributes.put("collectionId", collectionId);
        attributes.put("mediaArtifactId", mediaArtifactId);
        if (providerName != null && !providerName.isBlank()) {
            attributes.put("provider", providerName);
        }
        if (providerJobId != null && !providerJobId.isBlank()) {
            attributes.put("providerJobId", providerJobId);
        }
        if (outputArtifactId != null) {
            attributes.put("outputArtifactId", outputArtifactId);
        }
        Optional<WorkflowPolicySnapshot> policyDecision = extractPolicyDecision(inputParams, createdAtMs);
        policyDecision.ifPresent(decision -> {
            attributes.put("policyId", decision.policyId());
            attributes.put("policyAllowed", String.valueOf(decision.allowed()));
            attributes.put("policyReason", decision.reason());
        });

        return new RunLedger(
            jobId,
            "AV_PROCESSING_JOB",
            collectionId,
            mappedState,
            mappedOutcome,
            createdAtMs,
            startedAtMs,
            isTerminal(mappedState) ? now : 0,
            inputs,
            outputs,
            failureReason,
            Optional.empty(),
            1,  // Audio-Video jobs don't retry internally (retry handled at collection level)
            0,
            "NONE",
            0,
            policyDecision.map(WorkflowPolicySnapshot::policyId).orElse(null),
            policyDecision,
            null,
            policyDecision.map(WorkflowPolicySnapshot::requiresBlockingAudit).orElse(false),
            traceId,
            correlationId,
            attributes
        );
    }

    /**
     * Maps Audio-Video processing job states to the canonical lifecycle state.
     */
    private static JobExecutionState mapProcessingJobState(String jobState) {
        return switch (jobState.toUpperCase(Locale.ENGLISH)) {
            case "SUBMITTED", "QUEUED", "PREPARING" -> JobExecutionState.PENDING;
            case "TRANSCODING", "PROCESSING", "ANALYZING", "STORING", "UPLOADING", "INDEXING" -> JobExecutionState.RUNNING;
            case "COMPLETED", "SUCCEEDED", "STORED", "FAILED", "ERROR" -> JobExecutionState.COMPLETED;
            case "CANCELLED", "ABORTED" -> JobExecutionState.CANCELLED;
            default -> JobExecutionState.RUNNING;
        };
    }

    private static ExecutionOutcome mapProcessingJobOutcome(String jobState) {
        return switch (jobState.toUpperCase(Locale.ENGLISH)) {
            case "COMPLETED", "SUCCEEDED", "STORED" -> ExecutionOutcome.SUCCEEDED;
            case "FAILED", "ERROR" -> ExecutionOutcome.FAILED;
            case "CANCELLED", "ABORTED" -> ExecutionOutcome.CANCELLED;
            default -> null;
        };
    }

    /**
     * Validates that a RunLedger converted from Audio-Video product-specific format
     * maintains consistency
     */
    public static void validateConversion(RunLedger ledger) {
        Objects.requireNonNull(ledger, "ledger must not be null");

        if (!ledger.runType().equals("AV_PROCESSING_JOB")) {
            throw new IllegalArgumentException(
                String.format("Invalid Audio-Video run type: %s (expected AV_PROCESSING_JOB)", ledger.runType())
            );
        }

        Map<String, String> attrs = ledger.attributes();
        if (!attrs.containsKey("mediaType") || !attrs.containsKey("processingType")) {
            throw new IllegalArgumentException(
                "Missing mediaType or processingType in attributes for AV_PROCESSING_JOB"
            );
        }
    }

    /**
     * Helper to create a ProcessingJob that only tracks provider-side state
     * (for cases where Audio-Video job state is only available from provider API)
     */
    public static RunLedger fromProviderJobStatus(
        String jobId,
        String mediaArtifactId,
        String providerName,
        String providerJobId,
        String providerJobState,
        Map<String, String> providerMetadata,
        long createdAtMs,
        long startedAtMs,
        String traceId,
        String correlationId
    ) {
        JobExecutionState mappedState = mapProviderJobState(providerJobState);
        ExecutionOutcome mappedOutcome = mapProviderJobOutcome(providerJobState);

        InputSnapshot inputs = new InputSnapshot(
            Map.of("mediaArtifactId", mediaArtifactId),
            null,
            Map.of("provider", providerName, "providerJobId", providerJobId),
            "system",
            createdAtMs
        );

        OutputSnapshot outputs;
        Map<String, Number> providerMetrics = numericMetrics(providerMetadata);
        if (mappedOutcome == ExecutionOutcome.SUCCEEDED) {
            outputs = new OutputSnapshot(
                200,
                null,
                Map.of(),
                (startedAtMs > 0 ? System.currentTimeMillis() - startedAtMs : 0),
                providerMetrics,
                jobId
            );
        } else if (mappedOutcome == ExecutionOutcome.FAILED) {
            outputs = new OutputSnapshot(
                500,
                null,
                Map.of(),
                (startedAtMs > 0 ? System.currentTimeMillis() - startedAtMs : 0),
                providerMetrics,
                null
            );
        } else if (mappedState == JobExecutionState.CANCELLED) {
            outputs = new OutputSnapshot(
                499,
                null,
                Map.of(),
                (startedAtMs > 0 ? System.currentTimeMillis() - startedAtMs : 0),
                providerMetrics,
                null
            );
        } else {
            outputs = null;
        }

        Map<String, String> attributes = new HashMap<>();
        attributes.put("provider", providerName);
        attributes.put("providerJobId", providerJobId);
        attributes.put("mediaArtifactId", mediaArtifactId);
        attributes.put("mediaType", providerMetadata != null
            ? providerMetadata.getOrDefault("mediaType", "UNKNOWN")
            : "UNKNOWN");
        attributes.put("processingType", providerMetadata != null
            ? providerMetadata.getOrDefault("processingType", "PROVIDER_STATUS")
            : "PROVIDER_STATUS");
        Optional<WorkflowPolicySnapshot> policyDecision = extractPolicyDecision(providerMetadata, createdAtMs);
        policyDecision.ifPresent(decision -> {
            attributes.put("policyId", decision.policyId());
            attributes.put("policyAllowed", String.valueOf(decision.allowed()));
            attributes.put("policyReason", decision.reason());
        });

        return new RunLedger(
            jobId,
            "AV_PROCESSING_JOB",
            mediaArtifactId,
            mappedState,
            mappedOutcome,
            createdAtMs,
            startedAtMs,
            isTerminal(mappedState) ? System.currentTimeMillis() : 0,
            inputs,
            outputs,
            null,
            Optional.empty(),
            1,
            0,
            "NONE",
            0,
            policyDecision.map(WorkflowPolicySnapshot::policyId).orElse(null),
            policyDecision,
            null,
            policyDecision.map(WorkflowPolicySnapshot::requiresBlockingAudit).orElse(false),
            traceId,
            correlationId,
            attributes
        );
    }

    /**
     * Extracts provider capability policy state into the unified ledger checkpoint shape.
     */
    private static Optional<WorkflowPolicySnapshot> extractPolicyDecision(
        Map<String, String> metadata,
        long evaluatedAtFallbackMs
    ) {
        if (metadata == null || metadata.isEmpty()) {
            return Optional.empty();
        }

        String policyId = firstNonBlank(
            metadata,
            "providerPolicyId",
            "policyId",
            "policyCheckpointId",
            "policyDecisionId"
        );
        if (policyId == null) {
            return Optional.empty();
        }

        String decision = firstNonBlank(metadata, "providerPolicyDecision", "policyDecision", "policyAllowed", "allowed");
        boolean allowed = decision == null || isAllowedDecision(decision);
        String reason = firstNonBlank(metadata, "providerPolicyReason", "policyReason", "policyDecisionReason", "reason");
        Set<String> constraints = parseConstraints(firstNonBlank(metadata, "policyConstraints", "constraints"));
        long evaluatedAtMs = parsePositiveLong(
            firstNonBlank(metadata, "policyEvaluatedAtMs", "providerPolicyEvaluatedAtMs", "policyTimestampMs"),
            evaluatedAtFallbackMs
        );

        return Optional.of(new WorkflowPolicySnapshot(
            policyId,
            allowed,
            reason != null ? reason : (allowed ? "Policy allowed" : "Policy denied"),
            constraints,
            evaluatedAtMs
        ));
    }

    private static String firstNonBlank(Map<String, String> values, String... keys) {
        for (String key : keys) {
            String value = values.get(key);
            if (value != null && !value.isBlank()) {
                return value.trim();
            }
        }
        return null;
    }

    private static boolean isAllowedDecision(String decision) {
        String normalized = decision.trim().toUpperCase(Locale.ENGLISH);
        return normalized.equals("TRUE")
            || normalized.equals("ALLOW")
            || normalized.equals("ALLOWED")
            || normalized.equals("APPROVE")
            || normalized.equals("APPROVED");
    }

    private static Set<String> parseConstraints(String rawConstraints) {
        if (rawConstraints == null || rawConstraints.isBlank()) {
            return Set.of();
        }

        Set<String> constraints = new LinkedHashSet<>();
        for (String constraint : rawConstraints.split(",")) {
            String normalized = constraint.trim();
            if (!normalized.isEmpty()) {
                constraints.add(normalized);
            }
        }
        return Set.copyOf(constraints);
    }

    private static Map<String, Number> numericMetrics(Map<String, String> metadata) {
        if (metadata == null || metadata.isEmpty()) {
            return Map.of();
        }
        Map<String, Number> metrics = new LinkedHashMap<>();
        metadata.forEach((key, value) -> {
            if (key == null || value == null || value.isBlank()) {
                return;
            }
            try {
                metrics.put(key, value.contains(".")
                    ? Double.parseDouble(value)
                    : Long.parseLong(value));
            } catch (NumberFormatException ignored) {
                // Provider metadata remains in attributes; only numeric values are metrics.
            }
        });
        return Map.copyOf(metrics);
    }

    private static long parsePositiveLong(String rawValue, long fallback) {
        if (rawValue != null) {
            try {
                long parsed = Long.parseLong(rawValue);
                if (parsed > 0) {
                    return parsed;
                }
            } catch (NumberFormatException ignored) {
                // Fall through to the deterministic fallback below.
            }
        }
        return fallback > 0 ? fallback : System.currentTimeMillis();
    }

    private static boolean isTerminal(JobExecutionState state) {
        return state == JobExecutionState.COMPLETED || state == JobExecutionState.CANCELLED;
    }

    /**
     * Maps provider-generic job states to the canonical lifecycle state
     * (Useful for STT/TTS/Vision providers with varying state vocabularies)
     */
    private static JobExecutionState mapProviderJobState(String providerState) {
        if (providerState == null) {
            return JobExecutionState.RUNNING;
        }

        String upperState = providerState.toUpperCase(Locale.ENGLISH);
        return switch (upperState) {
            case "PENDING", "QUEUED", "SCHEDULED", "WAITING", "PREPARING", "SUBMITTED", "INITIALIZING" ->
                JobExecutionState.PENDING;
            case "PROCESSING", "IN_PROGRESS", "RUNNING", "EXECUTING", "ACTIVE", "WORKING", "ANALYZING",
                 "TRANSCODING", "ENCODING", "DECODING", "CONVERTING" ->
                JobExecutionState.RUNNING;
            case "COMPLETED", "DONE", "FINISHED", "SUCCESS", "OK", "SUCCEEDED", "SUCCESSFUL" ->
                JobExecutionState.COMPLETED;
            case "FAILED", "ERROR", "EXCEPTION", "FAULT" ->
                JobExecutionState.COMPLETED;
            case "CANCELLED", "ABORTED", "STOPPED", "TERMINATED", "INTERRUPTED" ->
                JobExecutionState.CANCELLED;
            default -> JobExecutionState.RUNNING;
        };
    }

    private static ExecutionOutcome mapProviderJobOutcome(String providerState) {
        if (providerState == null) {
            return null;
        }
        return switch (providerState.toUpperCase(Locale.ENGLISH)) {
            case "COMPLETED", "DONE", "FINISHED", "SUCCESS", "OK", "SUCCEEDED", "SUCCESSFUL" -> ExecutionOutcome.SUCCEEDED;
            case "FAILED", "ERROR", "EXCEPTION", "FAULT" -> ExecutionOutcome.FAILED;
            case "CANCELLED", "ABORTED", "STOPPED", "TERMINATED", "INTERRUPTED" -> ExecutionOutcome.CANCELLED;
            default -> null;
        };
    }
}
