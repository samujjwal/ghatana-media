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
        String ledgerFailureReason = sanitizeLedgerFailure(failureReason);
        long now = System.currentTimeMillis();

        InputSnapshot inputs = new InputSnapshot(
            sanitizeLedgerParams(inputParams),
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
        if (mappedOutcome == ExecutionOutcome.SUCCEEDED || mappedOutcome == ExecutionOutcome.DEGRADED) {
            outputs = new OutputSnapshot(
                mappedOutcome == ExecutionOutcome.DEGRADED ? 206 : 200,
                null,
                Map.of(),
                (startedAtMs > 0 ? now - startedAtMs : 0),
                Map.of(),
                outputArtifactId
            );
        } else if (mappedOutcome == ExecutionOutcome.FAILED) {
            outputs = new OutputSnapshot(
                500,
                ledgerFailureReason,
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
        // Preserve the raw observed state so a coarse projection never drops
        // uncertainty, cancellation-requested or partial-finality information.
        attributes.put("jobState", jobState);
        if (mappedOutcome == null) {
            attributes.put("effectFinality", "UNRESOLVED");
        } else if (mappedOutcome == ExecutionOutcome.DEGRADED) {
            attributes.put("effectFinality", "PARTIAL");
        }
        if (providerName != null && !providerName.isBlank()) {
            attributes.put("provider", providerName);
        }
        if (providerJobId != null && !providerJobId.isBlank()) {
            // Provider job identifiers may embed tenant or account material —
            // keep only a bounded deterministic fingerprint for correlation.
            attributes.put("providerJobIdRef", ledgerFingerprint(providerJobId));
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
            ledgerFailureReason,
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
    private static final int MAX_LEDGER_KEY_CHARS = 64;
    private static final int MAX_LEDGER_VALUE_CHARS = 256;
    // Values are metadata, not free-form text. Reject URL/credential shaped values
    // even when supplied under an otherwise harmless whitelisted key.
    private static final java.util.regex.Pattern SENSITIVE_LEDGER_VALUE =
        java.util.regex.Pattern.compile(
            "(?i)(https?://|\\bbearer\\s|(?:api[_ -]?key|secret|token|password|credential)\\s*[:=]"
                + "|\\b(?:sk|pk|ghp|gho|glpat|akia)[-_][a-z0-9_-]{8,}\\b)");
    private static final java.util.regex.Pattern SENSITIVE_FAILURE_DETAIL =
        java.util.regex.Pattern.compile(
            "(?i)([a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}|\\b\\+?[0-9][0-9 ()-]{8,}[0-9]\\b)");
    private static final String REDACTED_FAILURE_DETAIL = "Failure details omitted by ledger safety filter";
    private static final String REDACTED_POLICY_DETAIL = "Policy detail omitted by ledger safety filter";
    private static final Set<String> ALLOWED_PARAMETER_KEYS = Set.of(
        "bitrate", "codec", "format", "language", "languageTag", "sampleRate",
        "channels", "fps", "resolution", "width", "height", "durationMs",
        "frameCount", "mimeType", "mediaType", "processingType", "classification",
        "rightsRef", "purpose",
        // Typed AV processing operation flags — bounded vocabulary, never secrets.
        "extract-text", "detect-faces", "detect-objects", "detect-scenes",
        "transcribe", "translate", "summarize", "redact", "targetLanguage",
        "quality", "profile", "preset", "outputFormat", "outputMimeType",
        "policyId", "policyAllowed", "policyReason",
        "policyConstraints", "policyDecision", "policyDecisionReason",
        "policyDecisionId", "policyCheckpointId", "policyTimestampMs", "allowed",
        "reason", "constraints", "providerPolicyId", "providerPolicyDecision",
        "providerPolicyReason", "providerPolicyEvaluatedAtMs");

    /**
     * LD-03: the serialized ledger keeps only a typed whitelist of bounded
     * parameter keys. Arbitrary request parameters can carry source tokens,
     * credential material, tenant content or provider internals — anything not
     * whitelisted is dropped with a visible count so the drop is auditable
     * rather than silent.
     */
    private static Map<String, String> sanitizeLedgerParams(Map<String, String> params) {
        if (params == null || params.isEmpty()) {
            return Map.of();
        }
        Map<String, String> clean = new java.util.LinkedHashMap<>();
        int dropped = 0;
        for (Map.Entry<String, String> entry : params.entrySet()) {
            String key = entry.getKey();
            if (key == null || key.length() > MAX_LEDGER_KEY_CHARS
                    || !ALLOWED_PARAMETER_KEYS.contains(key)) {
                dropped++;
                continue;
            }
            String value = entry.getValue() == null ? "" : entry.getValue();
            if (value.length() > MAX_LEDGER_VALUE_CHARS || containsSensitiveLedgerValue(value)
                    || isPolicyMetadataKey(key) && containsSensitiveLedgerText(value)) {
                dropped++;
                continue;
            }
            clean.put(key, value);
        }
        if (dropped > 0) {
            clean.put("sanitizedParamsDropped", String.valueOf(dropped));
        }
        return Map.copyOf(clean);
    }

    /**
     * Provider error messages are free-form and can contain source URLs,
     * credentials, contact details, or arbitrarily large payload fragments.
     * Preserve ordinary bounded diagnostics, but omit the whole detail when a
     * known disclosure pattern or length cap is hit.
     */
    private static String sanitizeLedgerFailure(String failureReason) {
        if (failureReason == null) {
            return null;
        }
        if (failureReason.length() > MAX_LEDGER_VALUE_CHARS
                || containsSensitiveLedgerText(failureReason)) {
            return REDACTED_FAILURE_DETAIL;
        }
        return failureReason;
    }

    /** Pattern-based safety filter; this is not a general-purpose DLP detector. */
    private static boolean containsSensitiveLedgerValue(String value) {
        return SENSITIVE_LEDGER_VALUE.matcher(value).find();
    }

    private static boolean containsSensitiveLedgerText(String value) {
        return containsSensitiveLedgerValue(value) || SENSITIVE_FAILURE_DETAIL.matcher(value).find();
    }

    private static boolean isPolicyMetadataKey(String key) {
        return key.equals("policyId") || key.equals("policyCheckpointId")
                || key.equals("policyDecisionId") || key.equals("providerPolicyId")
                || key.equals("policyReason") || key.equals("policyDecisionReason")
                || key.equals("providerPolicyReason") || key.equals("reason")
                || key.equals("policyConstraints") || key.equals("constraints")
                || key.equals("policyDecision");
    }

    /** Bounded deterministic reference for identifiers that must not be serialized raw. */
    private static String ledgerFingerprint(String value) {
        try {
            byte[] digest = java.security.MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder ref = new StringBuilder("sha256:");
            for (int i = 0; i < 6; i++) {
                ref.append(Character.forDigit((digest[i] >> 4) & 0xf, 16))
                        .append(Character.forDigit(digest[i] & 0xf, 16));
            }
            return ref.toString();
        } catch (java.security.NoSuchAlgorithmException failure) {
            throw new IllegalStateException("SHA-256 is unavailable", failure);
        }
    }

    private static JobExecutionState mapProcessingJobState(String jobState) {
        return switch (jobState.toUpperCase(Locale.ENGLISH)) {
            // Queued-but-not-started and retry-pending are waiting states, not execution.
            case "SUBMITTED", "QUEUED", "PREPARING", "RETRY_PENDING" -> JobExecutionState.PENDING;
            case "TRANSCODING", "PROCESSING", "ANALYZING", "STORING", "UPLOADING", "INDEXING",
                 "RUNNING" -> JobExecutionState.RUNNING;
            // An uncertain or reconciling outcome is nonterminal: the job ran
            // but finality is unresolved — honest "still open", never complete.
            case "OUTCOME_UNKNOWN", "RECONCILING" -> JobExecutionState.RUNNING;
            // A cancellation request is not confirmed cancellation.
            case "CANCELLING" -> JobExecutionState.RUNNING;
            case "COMPLETED", "SUCCEEDED", "STORED", "FAILED", "ERROR",
                 "PARTIALLY_SUCCEEDED" -> JobExecutionState.COMPLETED;
            case "CANCELLED", "ABORTED" -> JobExecutionState.CANCELLED;
            // An unrecognized state must never be projected as RUNNING or a
            // final outcome; fail closed so the caller must not fabricate.
            default -> throw new IllegalArgumentException(
                    "unmapped Media processing job state: " + jobState);
        };
    }

    private static ExecutionOutcome mapProcessingJobOutcome(String jobState) {
        return switch (jobState.toUpperCase(Locale.ENGLISH)) {
            case "COMPLETED", "SUCCEEDED", "STORED" -> ExecutionOutcome.SUCCEEDED;
            case "PARTIALLY_SUCCEEDED" -> ExecutionOutcome.DEGRADED;
            case "FAILED", "ERROR" -> ExecutionOutcome.FAILED;
            case "CANCELLED", "ABORTED" -> ExecutionOutcome.CANCELLED;
            // Uncertain/cancelling/queued states carry no outcome — the ledger
            // must not infer success or failure.
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
            Map.of("provider", providerName,
                   "providerJobIdRef", ledgerFingerprint(providerJobId)),
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
        attributes.put("providerJobIdRef", ledgerFingerprint(providerJobId));
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
        policyId = sanitizePolicyIdentifier(policyId);

        String decision = firstNonBlank(metadata, "providerPolicyDecision", "policyDecision", "policyAllowed", "allowed");
        Optional<Boolean> allowedDecision = parsePolicyDecision(decision);
        if (allowedDecision.isEmpty()) {
            return Optional.empty();
        }
        boolean allowed = allowedDecision.orElseThrow();
        String reason = sanitizePolicyDetail(firstNonBlank(
                metadata, "providerPolicyReason", "policyReason", "policyDecisionReason", "reason"));
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
            // Policy metadata may be supplied by a provider. Never copy an
            // unbounded value merely to trim or inspect it downstream.
            if (value != null && value.length() > MAX_LEDGER_VALUE_CHARS) {
                return value.substring(0, MAX_LEDGER_VALUE_CHARS + 1);
            }
            if (value != null && !value.isBlank()) {
                return value.trim();
            }
        }
        return null;
    }

    private static Optional<Boolean> parsePolicyDecision(String decision) {
        if (decision == null || decision.isBlank() || decision.length() > MAX_LEDGER_VALUE_CHARS) {
            return Optional.empty();
        }
        String normalized = decision.trim().toUpperCase(Locale.ENGLISH);
        return switch (normalized) {
            case "TRUE", "ALLOW", "ALLOWED", "APPROVE", "APPROVED" -> Optional.of(true);
            case "FALSE", "DENY", "DENIED" -> Optional.of(false);
            default -> Optional.empty();
        };
    }

    private static Set<String> parseConstraints(String rawConstraints) {
        if (rawConstraints == null || rawConstraints.isBlank()
                || rawConstraints.length() > MAX_LEDGER_VALUE_CHARS) {
            return Set.of();
        }

        Set<String> constraints = new LinkedHashSet<>();
        for (String constraint : rawConstraints.split(",")) {
            String normalized = constraint.trim();
            if (!normalized.isEmpty() && normalized.length() <= MAX_LEDGER_VALUE_CHARS
                    && !containsSensitiveLedgerText(normalized)) {
                constraints.add(normalized);
            }
        }
        return Set.copyOf(constraints);
    }

    private static String sanitizePolicyDetail(String detail) {
        return detail == null || detail.length() <= MAX_LEDGER_VALUE_CHARS
                && !containsSensitiveLedgerText(detail)
                ? detail : REDACTED_POLICY_DETAIL;
    }

    /** Preserve decision state while replacing an unsafe or unbounded policy ID with a safe ref. */
    private static String sanitizePolicyIdentifier(String policyId) {
        if (policyId.length() > MAX_LEDGER_VALUE_CHARS) {
            return "redacted:oversized";
        }
        if (policyId.length() > MAX_LEDGER_KEY_CHARS || containsSensitiveLedgerText(policyId)) {
            return "redacted:" + ledgerFingerprint(policyId);
        }
        return policyId;
    }

    private static Map<String, Number> numericMetrics(Map<String, String> metadata) {
        if (metadata == null || metadata.isEmpty()) {
            return Map.of();
        }
        Map<String, Number> metrics = new LinkedHashMap<>();
        metadata.forEach((key, value) -> {
            if (key == null || key.length() > MAX_LEDGER_KEY_CHARS
                    || value == null || value.isBlank()) {
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
        if (providerState == null || providerState.isBlank()) {
            throw new IllegalArgumentException(
                    "provider job state is absent; an unreported state is not RUNNING");
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
            // An unrecognized provider vocabulary must never be projected as
            // RUNNING; fail closed and let the caller normalize new spellings.
            default -> throw new IllegalArgumentException(
                    "unmapped provider job state: " + providerState);
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
