/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audiovideo.adapter.ledger;

import com.ghatana.core.lifecycle.ExecutionOutcome;
import com.ghatana.core.lifecycle.JobExecutionState;
import com.ghatana.datacloud.delivery.ledger.*;
import com.ghatana.media.runtime.MediaLifecycleProjection.LogicalAttemptStatus;
import com.ghatana.media.runtime.MediaLifecycleProjection.LogicalJobStatus;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;

import static org.assertj.core.api.Assertions.*;

/**
 * @doc.type class
 * @doc.purpose Tests Audio-Video RunLedger adapter conversions
 * @doc.layer product
 * @doc.pattern Test
 */
@DisplayName("Audio-Video RunLedger Adapter Tests")
class AudioVideoRunLedgerAdapterTest {

    @Test
    @DisplayName("Converts completed ProcessingJob to RunLedger with correct state")
    void testFromProcessingJob_Completed() {
        // GIVEN: A completed transcoding job
        long now = System.currentTimeMillis();
        RunLedger ledger = AudioVideoRunLedgerAdapter.fromProcessingJob(
            "job-123",
            "VIDEO",
            "TRANSCODING",
            "collection-456",
            "artifact-source",
            Map.of("bitrate", "5000k", "codec", "h264"),
            "COMPLETED",
            now - 10000,
            now - 9000,
            "artifact-output-789",
            null,
            "aws-mediaconvert",
            "provider-job-999",
            "trace-id",
            "corr-id"
        );

        // THEN: State correctly mapped to SUCCEEDED
        assertThat(ledger.state()).isEqualTo(JobExecutionState.COMPLETED);
        assertThat(ledger.outcome()).isEqualTo(ExecutionOutcome.SUCCEEDED);
        assertThat(ledger.runType()).isEqualTo("AV_PROCESSING_JOB");
        assertThat(ledger.outputs()).isNotNull();
        assertThat(ledger.outputs().resultId()).isEqualTo("artifact-output-789");
        assertThat(ledger.attributes().get("provider")).isEqualTo("aws-mediaconvert");
        assertThat(ledger.traceId()).isEqualTo("trace-id");
        assertThat(ledger.correlationId()).isEqualTo("corr-id");
    }

    @Test
    @DisplayName("Converts STT job to RunLedger")
    void testFromProcessingJob_STT() {
        // GIVEN: A speech-to-text job
        long now = System.currentTimeMillis();
        RunLedger ledger = AudioVideoRunLedgerAdapter.fromProcessingJob(
            "job-stt-123",
            "AUDIO",
            "STT",
            "collection-456",
            "audio-artifact",
            Map.of("language", "en-US", "speaker-identification", "true"),
            "STORING",
            now - 5000,
            now - 4000,
            null,
            null,
            "deepgram",
            "dg-job-555",
            "trace-id",
            "corr-id"
        );

        // THEN: Processing type preserved
        assertThat(ledger.state()).isEqualTo(JobExecutionState.RUNNING);
        assertThat(ledger.attributes().get("processingType")).isEqualTo("STT");
        assertThat(ledger.attributes().get("mediaType")).isEqualTo("AUDIO");
    }

    @Test
    @DisplayName("Converts failed ProcessingJob with provider error")
    void testFromProcessingJob_Failed() {
        // GIVEN: A failed vision analysis job
        long now = System.currentTimeMillis();
        RunLedger ledger = AudioVideoRunLedgerAdapter.fromProcessingJob(
            "job-vision-123",
            "VIDEO",
            "VISION_ANALYSIS",
            "collection-456",
            "video-artifact",
            Map.of(),
            "FAILED",
            now - 10000,
            now - 9000,
            null,
            "OpenAI Vision API rate limit exceeded",
            "openai-vision",
            "oai-job-555",
            "trace-id",
            "corr-id"
        );

        // THEN: Failure recorded
        assertThat(ledger.state()).isEqualTo(JobExecutionState.COMPLETED);
        assertThat(ledger.outcome()).isEqualTo(ExecutionOutcome.FAILED);
        assertThat(ledger.failureReason()).contains("rate limit");
        assertThat(ledger.attributes().get("provider")).isEqualTo("openai-vision");
    }

    @Test
    @DisplayName("Maps various ProcessingJob states correctly")
    void testProcessingJobStateMapping() {
        long now = System.currentTimeMillis();

        RunLedger submitted = AudioVideoRunLedgerAdapter.fromProcessingJob(
            "j1", "VIDEO", "TRANSCODING", "coll", "src", Map.of(), "SUBMITTED", now, 0, null, null, "aws", "p1", "t", "c");
        RunLedger processing = AudioVideoRunLedgerAdapter.fromProcessingJob(
            "j2", "VIDEO", "TRANSCODING", "coll", "src", Map.of(), "TRANSCODING", now, now, null, null, "aws", "p2", "t", "c");
        RunLedger storing = AudioVideoRunLedgerAdapter.fromProcessingJob(
            "j3", "VIDEO", "TRANSCODING", "coll", "src", Map.of(), "STORING", now, now, null, null, "aws", "p3", "t", "c");
        RunLedger completed = AudioVideoRunLedgerAdapter.fromProcessingJob(
            "j4", "VIDEO", "TRANSCODING", "coll", "src", Map.of(), "COMPLETED", now, now, "out", null, "aws", "p4", "t", "c");
        RunLedger failed = AudioVideoRunLedgerAdapter.fromProcessingJob(
            "j5", "VIDEO", "TRANSCODING", "coll", "src", Map.of(), "FAILED", now, now, null, "error", "aws", "p5", "t", "c");

        assertThat(submitted.state()).isEqualTo(JobExecutionState.PENDING);
        assertThat(processing.state()).isEqualTo(JobExecutionState.RUNNING);
        assertThat(storing.state()).isEqualTo(JobExecutionState.RUNNING);
        assertThat(completed.state()).isEqualTo(JobExecutionState.COMPLETED);
        assertThat(failed.state()).isEqualTo(JobExecutionState.COMPLETED);
    }

    @Test
    @DisplayName("Preserves Audio-Video-specific provider information")
    void testFromProcessingJob_PreservesProviderInfo() {
        // GIVEN: A processing job with provider details
        long now = System.currentTimeMillis();
        RunLedger ledger = AudioVideoRunLedgerAdapter.fromProcessingJob(
            "job-123",
            "AUDIO",
            "TTS",
            "collection-456",
            "text-artifact",
            Map.of("voice", "en-US-AriaNeural", "rate", "1.25"),
            "COMPLETED",
            now - 5000,
            now - 4000,
            "audio-out",
            null,
            "azure-tts",
            "azure-job-999",
            "trace-id",
            "corr-id"
        );

        // THEN: Provider information preserved in attributes
        assertThat(ledger.attributes().get("provider")).isEqualTo("azure-tts");
        assertThat(ledger.attributes().get("providerJobIdRef")).startsWith("sha256:");
        assertThat(ledger.attributes()).doesNotContainKey("providerJobId");
        assertThat(ledger.attributes().get("mediaType")).isEqualTo("AUDIO");
        assertThat(ledger.attributes().get("processingType")).isEqualTo("TTS");
    }

    @Test
    @DisplayName("Converts provider-only job status from external API")
    void testFromProviderJobStatus() {
        // GIVEN: Job status retrieved from provider API
        long now = System.currentTimeMillis();
        RunLedger ledger = AudioVideoRunLedgerAdapter.fromProviderJobStatus(
            "job-123",
            "artifact-source",
            "deepgram",
            "dg-job-555",
            "processing",  // Provider's state vocabulary
            Map.of("duration", "120", "words_processed", "5000"),
            now - 10000,
            now - 9000,
            "trace-id",
            "corr-id"
        );

        // THEN: Provider state correctly mapped
        assertThat(ledger.state()).isEqualTo(JobExecutionState.RUNNING);
        assertThat(ledger.outputs()).isNull();  // Still processing
        assertThat(ledger.attributes().get("provider")).isEqualTo("deepgram");
        assertThat(ledger.traceId()).isEqualTo("trace-id");
        assertThat(ledger.correlationId()).isEqualTo("corr-id");
    }

    @Test
    @DisplayName("Maps provider progress variants but rejects provider-only terminal claims")
    void testProviderStateVariants() {
        long now = System.currentTimeMillis();

        RunLedger pending = AudioVideoRunLedgerAdapter.fromProviderJobStatus(
            "j1", "a1", "provider", "p1", "PENDING", Map.of(), now, 0, "t", "c");
        RunLedger inProgress = AudioVideoRunLedgerAdapter.fromProviderJobStatus(
            "j2", "a2", "provider", "p2", "IN_PROGRESS", Map.of(), now, now, "t", "c");

        assertThat(pending.state()).isEqualTo(JobExecutionState.PENDING);
        assertThat(inProgress.state()).isEqualTo(JobExecutionState.RUNNING);
        for (String providerTerminal : List.of(
                "FINISHED", "ERROR", "CANCELLED", "ABORTED", "SUCCESSFUL")) {
            assertThatThrownBy(() -> AudioVideoRunLedgerAdapter.fromProviderJobStatus(
                    "j-terminal", "a-terminal", "provider", "p-terminal", providerTerminal,
                    Map.of(), now, now, "t", "c"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("provider terminal state cannot establish Media job finality");
        }
    }

    @Test
    @DisplayName("Validates converted ProcessingJob has required fields")
    void testValidateConversion_Success() {
        long now = System.currentTimeMillis();
        RunLedger ledger = AudioVideoRunLedgerAdapter.fromProcessingJob(
            "j1", "VIDEO", "TRANSCODING", "coll", "src", Map.of(),
            "COMPLETED", now, now, "out", null, "provider", "p1", "t", "c");

        // THEN: Validation passes
        assertThatCode(() -> AudioVideoRunLedgerAdapter.validateConversion(ledger))
            .doesNotThrowAnyException();
    }

    @Test
    @DisplayName("Validates rejects invalid run type")
    void testValidateConversion_InvalidRunType() {
        // GIVEN: RunLedger with wrong run type
        RunLedger invalidLedger = new RunLedger(
            "job-123", "WRONG_TYPE", "context", JobExecutionState.COMPLETED, ExecutionOutcome.SUCCEEDED,
            System.currentTimeMillis(), 0, System.currentTimeMillis(),
            new InputSnapshot(Map.of(), null, Map.of(), "user", System.currentTimeMillis()),
            new OutputSnapshot(200, null, Map.of(), 0, Map.of(), null),
            null, java.util.Optional.empty(), 1, 0, "NONE", 0,
            null, java.util.Optional.empty(), null, false,
            "trace", "corr", Map.of()
        );

        // THEN: Validation fails
        assertThatThrownBy(() -> AudioVideoRunLedgerAdapter.validateConversion(invalidLedger))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("Invalid Audio-Video run type");
    }

    @Test
    @DisplayName("Validates rejects missing mediaType or processingType")
    void testValidateConversion_MissingFields() {
        // GIVEN: RunLedger missing required attributes
        RunLedger invalidLedger = new RunLedger(
            "j1", "AV_PROCESSING_JOB", "coll", JobExecutionState.COMPLETED, ExecutionOutcome.SUCCEEDED,
            System.currentTimeMillis(), 0, System.currentTimeMillis(),
            new InputSnapshot(Map.of(), null, Map.of(), "user", System.currentTimeMillis()),
            new OutputSnapshot(200, null, Map.of(), 0, Map.of(), null),
            null, java.util.Optional.empty(), 1, 0, "NONE", 0,
            null, java.util.Optional.empty(), null, false,
            "trace", "corr", Map.of("provider", "aws")  // Missing mediaType and processingType
        );

        // THEN: Validation fails
        assertThatThrownBy(() -> AudioVideoRunLedgerAdapter.validateConversion(invalidLedger))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("mediaType or processingType");
    }

    @Test
    @DisplayName("Multimodal processing jobs preserve all media types")
    void testFromProcessingJob_Multimodal() {
        // GIVEN: A multimodal analysis job
        long now = System.currentTimeMillis();
        RunLedger ledger = AudioVideoRunLedgerAdapter.fromProcessingJob(
            "job-mm-123",
            "MULTIMODAL",
            "VISION_ANALYSIS",
            "collection-456",
            "mixed-media-artifact",
            Map.of("extract-text", "true", "detect-faces", "true", "detect-objects", "true"),
            "COMPLETED",
            now - 15000,
            now - 12000,
            "analysis-output",
            null,
            "multimodal-ai",
            "mm-job-777",
            "trace-id",
            "corr-id"
        );

        // THEN: Multimodal media type preserved
        assertThat(ledger.attributes().get("mediaType")).isEqualTo("MULTIMODAL");
        assertThat(ledger.inputs().parameters().get("extract-text")).isEqualTo("true");
        assertThat(ledger.state()).isEqualTo(JobExecutionState.COMPLETED);
        assertThat(ledger.outcome()).isEqualTo(ExecutionOutcome.SUCCEEDED);
    }

    @Test
    @DisplayName("Captures processing job provider policy state in unified run ledger")
    void testFromProcessingJob_CapturesProviderPolicyDecision() {
        long now = System.currentTimeMillis();

        RunLedger ledger = AudioVideoRunLedgerAdapter.fromProcessingJob(
            "job-policy",
            "VIDEO",
            "VISION_ANALYSIS",
            "collection-456",
            "video-artifact",
            Map.of(
                "providerPolicyId", "av-provider-capability-policy",
                "providerPolicyDecision", "ALLOW",
                "providerPolicyReason", "Provider available and consent valid",
                "policyConstraints", "BLOCKING_AUDIT_REQUIRED,NO_CACHE",
                "providerPolicyEvaluatedAtMs", String.valueOf(now - 250)
            ),
            "PROCESSING",
            now - 1000,
            now - 500,
            null,
            null,
            "openai-vision",
            "oai-job-555",
            "trace-policy",
            "corr-policy"
        );

        assertThat(ledger.policyCheckpointId()).isEqualTo("av-provider-capability-policy");
        assertThat(ledger.policyDecision()).isPresent();
        assertThat(ledger.policyDecision().orElseThrow().allowed()).isTrue();
        assertThat(ledger.policyDecision().orElseThrow().reason())
            .isEqualTo("Provider available and consent valid");
        assertThat(ledger.policyDecision().orElseThrow().constraints())
            .containsExactlyInAnyOrder("BLOCKING_AUDIT_REQUIRED", "NO_CACHE");
        assertThat(ledger.requiresBlockingAudit()).isTrue();
        assertThat(ledger.attributes()).containsEntry("policyId", "av-provider-capability-policy");
    }

    @Test
    @DisplayName("Captures denied provider status policy state in unified run ledger")
    void testFromProviderJobStatus_CapturesDeniedPolicyDecision() {
        long now = System.currentTimeMillis();

        RunLedger ledger = AudioVideoRunLedgerAdapter.fromProviderJobStatus(
            "job-provider-policy",
            "artifact-source",
            "deepgram",
            "dg-job-555",
            "PROCESSING",
            Map.of(
                "policyCheckpointId", "av-provider-tenant-policy",
                "policyDecision", "DENY",
                "policyReason", "Provider disabled for tenant"
            ),
            now - 10000,
            now - 9000,
            "trace-provider-policy",
            "corr-provider-policy"
        );

        assertThat(ledger.state()).isEqualTo(JobExecutionState.RUNNING);
        assertThat(ledger.outcome()).isNull();
        assertThat(ledger.outputs()).isNull();
        assertThat(ledger.policyCheckpointId()).isEqualTo("av-provider-tenant-policy");
        assertThat(ledger.policyDecision()).isPresent();
        assertThat(ledger.policyDecision().orElseThrow().allowed()).isFalse();
        assertThat(ledger.policyDecision().orElseThrow().reason())
            .isEqualTo("Provider disabled for tenant");
        assertThat(ledger.requiresBlockingAudit()).isFalse();
        assertThat(ledger.attributes()).containsEntry("policyAllowed", "false");
    }

    @Test
    @DisplayName("Policy projection redacts unsafe free text while preserving decision and safe constraints")
    void testPolicyProjectionRedactsUnsafeDetails() {
        long now = System.currentTimeMillis();
        String email = "person@example.com";
        String signedUrl = "https://source.invalid/artifact?token=source-secret";
        String credential = "bearer sk-live-policy-secret";

        RunLedger ledger = AudioVideoRunLedgerAdapter.fromProviderJobStatus(
                "job-policy-private", "artifact-source", "provider", "provider-job",
                "PROCESSING", Map.of(
                        "policyCheckpointId", email,
                        "policyDecision", "DENY",
                        "policyReason", "Denied for " + email + " at " + signedUrl,
                        // Arbitrary free-text and uppercase PII-like values
                        // must fail the canonical constraint vocabulary.
                        "policyConstraints", "NO_CACHE, Alice Example, ALICE_EXAMPLE, "
                                + "voiceprint subject, VOICEPRINT_SUBJECT, " + credential),
                now - 1_000, now - 500, "trace", "correlation");

        assertThat(ledger.policyCheckpointId()).startsWith("redacted:sha256:");
        assertThat(ledger.policyDecision()).isPresent();
        assertThat(ledger.policyDecision().orElseThrow().allowed()).isFalse();
        assertThat(ledger.policyDecision().orElseThrow().reason())
                .isEqualTo("Policy detail omitted by ledger safety filter");
        assertThat(ledger.policyDecision().orElseThrow().constraints()).containsExactly("NO_CACHE");
        assertThat(ledger.attributes()).containsEntry(
                "policyReason", "Policy detail omitted by ledger safety filter");
        assertThat(ledger.toString()).doesNotContain(email, signedUrl, "source-secret", credential,
                "sk-live-policy-secret", "Alice Example", "ALICE_EXAMPLE",
                "voiceprint subject", "VOICEPRINT_SUBJECT");

        RunLedger oversizedConstraints = AudioVideoRunLedgerAdapter.fromProviderJobStatus(
                "job-policy-large", "artifact-source", "provider", "provider-job",
                "PROCESSING", Map.of(
                        "policyCheckpointId", "av-policy-checkpoint",
                        "policyDecision", "DENY",
                        "policyConstraints", "C".repeat(100_000)),
                now - 1_000, now - 500, "trace", "correlation");
        assertThat(oversizedConstraints.policyDecision()).isPresent();
        assertThat(oversizedConstraints.policyDecision().orElseThrow().allowed()).isFalse();
        assertThat(oversizedConstraints.policyDecision().orElseThrow().constraints()).isEmpty();
    }

    @Test
    @DisplayName("Missing or unknown policy decision is not projected as allow or deny")
    void testPolicyProjectionRequiresRecognizedDecision() {
        long now = System.currentTimeMillis();
        Map<String, String> missingDecision = Map.of(
                "policyCheckpointId", "av-policy-checkpoint",
                "policyReason", "No decision returned");
        Map<String, String> unknownDecision = Map.of(
                "policyCheckpointId", "av-policy-checkpoint",
                "policyDecision", "PENDING_REVIEW",
                "policyReason", "Decision vocabulary not recognized");

        RunLedger missing = AudioVideoRunLedgerAdapter.fromProviderJobStatus(
                "job-policy-missing", "artifact-source", "provider", "provider-job",
                "PROCESSING", missingDecision, now - 1_000, now, "trace", "correlation");
        RunLedger unknown = AudioVideoRunLedgerAdapter.fromProviderJobStatus(
                "job-policy-unknown", "artifact-source", "provider", "provider-job",
                "PROCESSING", unknownDecision, now - 1_000, now, "trace", "correlation");

        for (RunLedger ledger : List.of(missing, unknown)) {
            assertThat(ledger.policyDecision()).isEmpty();
            assertThat(ledger.policyCheckpointId()).isNull();
            assertThat(ledger.attributes()).doesNotContainKeys(
                    "policyId", "policyAllowed", "policyReason");
        }
    }

    @Test
    @DisplayName("Unmapped or absent job states fail closed and are never projected as RUNNING")
    void testUnmappedStatesFailClosed() {
        long now = System.currentTimeMillis();

        // An unrecognized provider vocabulary cannot be recorded as RUNNING.
        assertThatThrownBy(() -> AudioVideoRunLedgerAdapter.fromProviderJobStatus(
                "j1", "a1", "provider", "p1", "THROTTLED_BY_VENDOR",
                Map.of(), now, 0, "t", "c"))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("unmapped provider job state");

        // An absent provider state is not progress either.
        assertThatThrownBy(() -> AudioVideoRunLedgerAdapter.fromProviderJobStatus(
                "j2", "a2", "provider", "p2", null, Map.of(), now, 0, "t", "c"))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> AudioVideoRunLedgerAdapter.fromProviderJobStatus(
                "j3", "a3", "provider", "p3", "   ", Map.of(), now, 0, "t", "c"))
            .isInstanceOf(IllegalArgumentException.class);

        // The internal processing-state vocabulary is equally fail-closed.
        assertThatThrownBy(() -> AudioVideoRunLedgerAdapter.fromProcessingJob(
                "job-x", "AUDIO", "STT", "col-1", "artifact-src", Map.of(),
                "MYSTERY_STATE", now, now, null, null, null, null, "t", "c"))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("unmapped Media processing job state");

        // RunLedger has no typed UNKNOWN or cancellation-request state. Do not
        // collapse those canonical states into RUNNING and lose their meaning.
        for (String unrepresentable : List.of("OUTCOME_UNKNOWN", "RECONCILING", "CANCELLING")) {
            assertThatThrownBy(() -> AudioVideoRunLedgerAdapter.fromProcessingJob(
                    "job-unresolved", "AUDIO", "STT", "col-1", "artifact-src", Map.of(),
                    unrepresentable, now, now, null, null, null, null, "t", "c"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Media processing job state cannot be represented without loss");
        }

        // Mapped nonterminal states keep an honest null outcome.
        RunLedger running = AudioVideoRunLedgerAdapter.fromProviderJobStatus(
            "j4", "a4", "provider", "p4", "EXECUTING", Map.of(), now, 0, "t", "c");
        assertThat(running.state()).isEqualTo(JobExecutionState.RUNNING);
        assertThat(running.outcome()).isNull();
    }

    @Test
    @DisplayName("Invalid provider and Media state diagnostics are bounded and do not echo untrusted values")
    void testInvalidStateDiagnosticsDoNotDiscloseInput() {
        long now = System.currentTimeMillis();
        String privateUnknownState = "user@example.invalid bearer sk-live-secret " + "x".repeat(10_000);

        assertThatThrownBy(() -> AudioVideoRunLedgerAdapter.fromProviderJobStatus(
                "job-state-provider", "source", "provider", "provider-job", privateUnknownState,
                Map.of(), now, 0, "trace", "correlation"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("unmapped provider job state")
                .satisfies(failure -> assertThat(failure.getMessage().length()).isLessThanOrEqualTo(64));

        assertThatThrownBy(() -> AudioVideoRunLedgerAdapter.fromProcessingJob(
                "job-state-media", "AUDIO", "STT", "collection", "source", Map.of(),
                privateUnknownState, now, 0, null, null, null, null, "trace", "correlation"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("unmapped Media processing job state")
                .satisfies(failure -> assertThat(failure.getMessage().length()).isLessThanOrEqualTo(64));

        assertThatThrownBy(() -> AudioVideoRunLedgerAdapter.fromProviderJobStatus(
                "job-state-terminal", "source", "provider", "provider-job", "FAILED",
                Map.of(), now, 0, "trace", "correlation"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("provider terminal state cannot establish Media job finality");
    }

    @Test
    @DisplayName("Terminal, partial, retry, cancelled and uncertain outcomes project truthfully")
    void testCanonicalOutcomeProjections() {
        long now = System.currentTimeMillis();

        // Terminal success.
        RunLedger done = AudioVideoRunLedgerAdapter.fromProcessingJob(
                "j-ok", "AUDIO", "STT", "col", "src", Map.of(), "COMPLETED",
                now - 100, now - 90, "out-1", null, "whisper", "pj-1", "t", "c");
        assertThat(done.state()).isEqualTo(JobExecutionState.COMPLETED);
        assertThat(done.outcome()).isEqualTo(ExecutionOutcome.SUCCEEDED);
        assertThat(done.outputs().statusCode()).isEqualTo(200);
        assertThat(done.outputs().resultId()).isEqualTo("out-1");

        // Partial output — degraded completion, never a clean success claim.
        RunLedger partial = AudioVideoRunLedgerAdapter.fromProcessingJob(
                "j-part", "AUDIO", "STT", "col", "src", Map.of(), "PARTIALLY_SUCCEEDED",
                now - 100, now - 90, "out-2", null, "whisper", "pj-2", "t", "c");
        assertThat(partial.state()).isEqualTo(JobExecutionState.COMPLETED);
        assertThat(partial.outcome()).isEqualTo(ExecutionOutcome.DEGRADED);
        assertThat(partial.outputs().statusCode()).isEqualTo(206);
        assertThat(partial.attributes()).containsEntry("effectFinality", "PARTIAL");

        // Retry pending — waiting, not executing, no outcome.
        RunLedger retry = AudioVideoRunLedgerAdapter.fromProcessingJob(
                "j-retry", "AUDIO", "STT", "col", "src", Map.of(), "RETRY_PENDING",
                now - 100, now - 90, null, null, "whisper", "pj-3", "t", "c");
        assertThat(retry.state()).isEqualTo(JobExecutionState.PENDING);
        assertThat(retry.outcome()).isNull();
        assertThat(retry.attributes()).containsEntry("effectFinality", "UNRESOLVED");

        RunLedger cancelled = AudioVideoRunLedgerAdapter.fromProcessingJob(
                "j-cx", "AUDIO", "STT", "col", "src", Map.of(), "CANCELLED",
                now - 100, now - 90, null, null, "whisper", "pj-5", "t", "c");
        assertThat(cancelled.state()).isEqualTo(JobExecutionState.CANCELLED);
        assertThat(cancelled.outcome()).isEqualTo(ExecutionOutcome.CANCELLED);

        // UNKNOWN and RECONCILING must stay in the authoritative Media job
        // state machine; this coarse RunLedger cannot encode them losslessly.
        for (String unresolved : List.of("OUTCOME_UNKNOWN", "RECONCILING")) {
            assertThatThrownBy(() -> AudioVideoRunLedgerAdapter.fromProcessingJob(
                    "j-unresolved", "AUDIO", "STT", "col", "src", Map.of(), unresolved,
                    now - 100, now - 90, null, null, "whisper", "pj-unresolved", "t", "c"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Media processing job state cannot be represented without loss");
        }
    }

    @Test
    @DisplayName("Exhaustively maps canonical Media job states and rejects unresolved or attempt-only states")
    void testCanonicalMediaJobStateMappingMatrix() {
        record MappingCase(String mediaState, JobExecutionState ledgerState, ExecutionOutcome ledgerOutcome) { }

        // These nine values are MediaLifecycleProjection.LogicalJobStatus. RunLedger has no
        // UNKNOWN/RECONCILING state, so those two are tested as rejection cases below.
        List<MappingCase> representable = List.of(
                new MappingCase("QUEUED", JobExecutionState.PENDING, null),
                new MappingCase("RUNNING", JobExecutionState.RUNNING, null),
                new MappingCase("RETRY_PENDING", JobExecutionState.PENDING, null),
                new MappingCase("COMPLETED", JobExecutionState.COMPLETED, ExecutionOutcome.SUCCEEDED),
                new MappingCase("PARTIALLY_SUCCEEDED", JobExecutionState.COMPLETED, ExecutionOutcome.DEGRADED),
                new MappingCase("FAILED", JobExecutionState.COMPLETED, ExecutionOutcome.FAILED),
                new MappingCase("CANCELLED", JobExecutionState.CANCELLED, ExecutionOutcome.CANCELLED));
        long now = System.currentTimeMillis();

        for (MappingCase testCase : representable) {
            RunLedger ledger = AudioVideoRunLedgerAdapter.fromProcessingJob(
                    "matrix-" + testCase.mediaState(), "AUDIO", "STT", "collection", "source",
                    Map.of(), testCase.mediaState(), now, 0, null, null,
                    null, null, "trace", "correlation");
            assertThat(ledger.state()).as(testCase.mediaState()).isEqualTo(testCase.ledgerState());
            assertThat(ledger.outcome()).as(testCase.mediaState()).isEqualTo(testCase.ledgerOutcome());
        }

        // Legacy submission/processing phase labels retain only the equivalent coarse state.
        RunLedger submitted = AudioVideoRunLedgerAdapter.fromProcessingJob(
                "matrix-SUBMITTED", "AUDIO", "STT", "collection", "source",
                Map.of(), "SUBMITTED", now, 0, null, null,
                null, null, "trace", "correlation");
        assertThat(submitted.state()).isEqualTo(JobExecutionState.PENDING);
        assertThat(submitted.outcome()).isNull();
        for (String activePhase : List.of("TRANSCODING", "PROCESSING", "STORING")) {
            RunLedger ledger = AudioVideoRunLedgerAdapter.fromProcessingJob(
                    "matrix-" + activePhase, "AUDIO", "STT", "collection", "source",
                    Map.of(), activePhase, now, 0, null, null,
                    null, null, "trace", "correlation");
            assertThat(ledger.state()).as(activePhase).isEqualTo(JobExecutionState.RUNNING);
            assertThat(ledger.outcome()).as(activePhase).isNull();
        }

        // The remaining canonical job states, attempt-only states and noncanonical aliases
        // have no lossless RunLedger state. They must not become RUNNING or terminal.
        for (String unrepresentable : List.of(
                "OUTCOME_UNKNOWN", "RECONCILING", "CLAIMED", "DISPATCH_INTENT_RECORDED",
                "DISPATCHED", "CANCEL_REQUESTED", "CANCEL_CONFIRMED", "SUPERSEDED",
                "ABORTED", "SUCCEEDED", "STORED", "ERROR")) {
            assertThatThrownBy(() -> AudioVideoRunLedgerAdapter.fromProcessingJob(
                    "matrix-" + unrepresentable, "AUDIO", "STT", "collection", "source",
                    Map.of(), unrepresentable, now, 0, null, null,
                    null, null, "trace", "correlation"))
                .as(unrepresentable)
                .isInstanceOf(IllegalArgumentException.class);
        }

        // Keep the hand-maintained adapter matrix exhaustive when either Media
        // lifecycle enum grows. RUNNING, FAILED, and OUTCOME_UNKNOWN overlap
        // job and attempt vocabularies; the remaining attempt-only states must
        // never be accepted as a job state.
        Set<String> classifiedJobStates = new java.util.HashSet<>();
        representable.forEach(testCase -> classifiedJobStates.add(testCase.mediaState()));
        classifiedJobStates.addAll(List.of("OUTCOME_UNKNOWN", "RECONCILING"));
        assertThat(classifiedJobStates)
                .containsExactlyInAnyOrderElementsOf(Arrays.stream(LogicalJobStatus.values())
                        .map(Enum::name).toList());

        // Exhaust the other side of the projection too. The platform ledger has
        // additional lifecycle buckets, but Media's nine logical job states do
        // not define paused, rolled-back, or a standalone failed state. Do not
        // invent those projections: Media FAILED is COMPLETED + FAILED outcome,
        // and RETRY_PENDING is PENDING with no terminal outcome.
        Set<JobExecutionState> projectedLedgerStates = representable.stream()
                .map(MappingCase::ledgerState)
                .collect(java.util.stream.Collectors.toSet());
        assertThat(projectedLedgerStates).containsExactlyInAnyOrder(
                JobExecutionState.PENDING,
                JobExecutionState.RUNNING,
                JobExecutionState.COMPLETED,
                JobExecutionState.CANCELLED);
        assertThat(Arrays.stream(JobExecutionState.values()).map(Enum::name).toList())
                .containsExactlyInAnyOrder(
                        "PENDING", "RUNNING", "COMPLETED", "FAILED", "RETRY",
                        "PAUSED", "CANCELLED", "ROLLED_BACK");
        assertThat(Arrays.stream(ExecutionOutcome.values()).map(Enum::name).toList())
                .containsExactlyInAnyOrder("SUCCEEDED", "FAILED", "DEGRADED", "CANCELLED");
        assertThat(representable.stream().map(MappingCase::ledgerOutcome)
                .filter(java.util.Objects::nonNull).collect(java.util.stream.Collectors.toSet()))
                .containsExactlyInAnyOrder(ExecutionOutcome.SUCCEEDED, ExecutionOutcome.FAILED,
                        ExecutionOutcome.DEGRADED, ExecutionOutcome.CANCELLED);

        Set<String> jobVocabulary = Arrays.stream(LogicalJobStatus.values())
                .map(Enum::name).collect(java.util.stream.Collectors.toSet());
        for (LogicalAttemptStatus attemptStatus : LogicalAttemptStatus.values()) {
            if (jobVocabulary.contains(attemptStatus.name())) continue;
            assertThatThrownBy(() -> AudioVideoRunLedgerAdapter.fromProcessingJob(
                    "matrix-attempt-" + attemptStatus, "AUDIO", "STT", "collection", "source",
                    Map.of(), attemptStatus.name(), now, 0, null, null,
                    null, null, "trace", "correlation"))
                    .as(attemptStatus.name())
                    .isInstanceOf(IllegalArgumentException.class);
        }

        assertThatThrownBy(() -> AudioVideoRunLedgerAdapter.fromProcessingJob(
                "matrix-unknown", "AUDIO", "STT", "collection", "source",
                Map.of(), "UNRECOGNIZED_STATE", now, 0, null, null,
                null, null, "trace", "correlation"))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("unmapped Media processing job state");
    }

    @Test
    @DisplayName("Serialized ledger drops non-whitelisted params and never serializes provider job ids raw")
    void testLedgerDisclosureSanitization() {
        long now = System.currentTimeMillis();
        Map<String, String> params = new java.util.HashMap<>();
        params.put("apiKey", "sk-live-secret-token");
        params.put("sourceToken", "s3-signed-url-token");
        params.put("tenantSecret", "do-not-leak");
        params.put("bitrate", "5000k");
        params.put("codec", "h264");
        params.put("language", "en");
        params.put("rightsRef", "rights:consent-42");
        // Attackers can place credentials beneath a whitelisted key.
        params.put("purpose", "Bearer sk-live-credential-value");
        params.put("classification", "https://example.invalid/signed-source?token=secret");
        params.put("oversized", "x".repeat(300));

        RunLedger ledger = AudioVideoRunLedgerAdapter.fromProcessingJob(
                "j-sec", "VIDEO", "TRANSCODING", "col", "src", params, "PROCESSING",
                now, now, null, null, "aws-mediaconvert", "mco-tenant-secret-job-1", "t", "c");

        // Whitelisted typed params survive; secrets are dropped with an audit marker.
        assertThat(ledger.inputs().parameters())
                .containsEntry("bitrate", "5000k")
                .containsEntry("codec", "h264")
                .containsEntry("language", "en")
                .containsEntry("rightsRef", "rights:consent-42")
                .containsEntry("sanitizedParamsDropped", "6")
                .doesNotContainKey("purpose")
                .doesNotContainKey("classification")
                .doesNotContainKey("apiKey")
                .doesNotContainKey("sourceToken")
                .doesNotContainKey("tenantSecret")
                .doesNotContainKey("oversized");
        // The raw provider job id never serializes — only a bounded fingerprint.
        String serialized = ledger.toString();
        assertThat(serialized).doesNotContain("mco-tenant-secret-job-1",
                "sk-live-secret-token", "s3-signed-url-token", "do-not-leak",
                "sk-live-credential-value", "signed-source");
        assertThat(ledger.attributes().get("providerJobIdRef")).startsWith("sha256:");
    }

    @Test
    @DisplayName("Input policy constraints retain canonical values and count rejected parameter entries")
    void testInputPolicyConstraintsUseCanonicalVocabulary() {
        long now = System.currentTimeMillis();
        RunLedger ledger = AudioVideoRunLedgerAdapter.fromProcessingJob(
                "job-input-constraints", "VIDEO", "VISION_ANALYSIS", "collection", "source",
                Map.of("policyConstraints", "BLOCKING_AUDIT_REQUIRED,NO_CACHE,NO_STORE,"
                        + "ESCALATE_TO_ADMIN,ALICE_EXAMPLE,VOICEPRINT_SUBJECT,bearer sk-live-constraint-secret"),
                "PROCESSING", now, now, null, null, "provider", "provider-job", "trace", "correlation");

        assertThat(ledger.inputs().parameters())
                .containsEntry("policyConstraints",
                        "BLOCKING_AUDIT_REQUIRED,NO_CACHE,NO_STORE,ESCALATE_TO_ADMIN")
                .containsEntry("sanitizedParamsDropped", "1");
        assertThat(ledger.toString()).doesNotContain(
                "ALICE_EXAMPLE", "VOICEPRINT_SUBJECT", "sk-live-constraint-secret");

        RunLedger allUnknown = AudioVideoRunLedgerAdapter.fromProcessingJob(
                "job-input-constraints-unknown", "VIDEO", "VISION_ANALYSIS", "collection", "source",
                Map.of("constraints", "ALICE_EXAMPLE,VOICEPRINT_SUBJECT"),
                "PROCESSING", now, now, null, null, "provider", "provider-job", "trace", "correlation");
        assertThat(allUnknown.inputs().parameters())
                .containsEntry("sanitizedParamsDropped", "1")
                .doesNotContainKey("constraints");
        assertThat(allUnknown.toString()).doesNotContain("ALICE_EXAMPLE", "VOICEPRINT_SUBJECT");
    }

    @Test
    @DisplayName("Output artifact references use the same bounded safe projection as source references")
    void testOutputArtifactReferenceDisclosureSanitization() {
        long now = System.currentTimeMillis();
        String signedOutput = "https://private.invalid/output?token=output-secret";

        RunLedger ledger = AudioVideoRunLedgerAdapter.fromProcessingJob(
                "j-output-private", "VIDEO", "TRANSCODING", "col", "src", Map.of(), "COMPLETED",
                now, now, signedOutput, null, "provider", "provider-job", "t", "c");

        assertThat(ledger.outputs().resultId()).startsWith("redacted:sha256:");
        assertThat(ledger.attributes().get("outputArtifactId")).isEqualTo(ledger.outputs().resultId());
        assertThat(ledger.toString()).doesNotContain("private.invalid", "output-secret", signedOutput);
    }

    @Test
    @DisplayName("Provider failure details are bounded and redact personal or credential data")
    void testFailureDetailDisclosureSanitization() {
        long now = System.currentTimeMillis();
        String sensitiveFailure = "rate limit for user@example.com; bearer sk-live-secret-value; "
                + "https://source.invalid/signed?token=abc";

        RunLedger redacted = AudioVideoRunLedgerAdapter.fromProcessingJob(
                "j-error-private", "AUDIO", "STT", "col", "src", Map.of(), "FAILED",
                now, now, null, sensitiveFailure, "provider", "provider-job", "t", "c");

        assertThat(redacted.failureReason())
                .isEqualTo("Failure details omitted by ledger safety filter");
        assertThat(redacted.toString()).doesNotContain(
                "user@example.com", "sk-live-secret-value", "source.invalid", "token=abc");

        // The configured personal-data filter also treats phone-like values
        // and biometric identity terms as sensitive even without URL or token
        // syntax. Keep this boundary covered independently of the email case.
        String phoneFailure = "provider rejected call for +1 (415) 555-0198";
        RunLedger phoneRedacted = AudioVideoRunLedgerAdapter.fromProcessingJob(
                "j-error-phone", "AUDIO", "STT", "col", "src", Map.of(), "FAILED",
                now, now, null, phoneFailure, "provider", "provider-job", "t", "c");
        assertThat(phoneRedacted.failureReason())
                .isEqualTo("Failure details omitted by ledger safety filter");
        assertThat(phoneRedacted.toString()).doesNotContain(
                "+1 (415) 555-0198");

        String biometricFailure = "voiceprint mismatch for subject";
        RunLedger biometricRedacted = AudioVideoRunLedgerAdapter.fromProcessingJob(
                "j-error-biometric", "AUDIO", "STT", "col", "src", Map.of(), "FAILED",
                now, now, null, biometricFailure, "provider", "provider-job", "t", "c");
        assertThat(biometricRedacted.failureReason())
                .isEqualTo("Failure details omitted by ledger safety filter");
        assertThat(biometricRedacted.toString()).doesNotContain("voiceprint", "subject");

        RunLedger bounded = AudioVideoRunLedgerAdapter.fromProcessingJob(
                "j-error-long", "AUDIO", "STT", "col", "src", Map.of(), "FAILED",
                now, now, null, "provider detail " + "x".repeat(300), "provider", "provider-job", "t", "c");
        assertThat(bounded.failureReason())
                .isEqualTo("Failure details omitted by ledger safety filter");
        assertThat(bounded.failureReason().length()).isLessThanOrEqualTo(64);

        RunLedger ordinary = AudioVideoRunLedgerAdapter.fromProcessingJob(
                "j-error-safe", "AUDIO", "STT", "col", "src", Map.of(), "FAILED",
                now, now, null, "provider rate limit exceeded", "provider", "provider-job", "t", "c");
        assertThat(ordinary.failureReason()).isEqualTo("provider rate limit exceeded");
    }

    @Test
    @DisplayName("Typed ledger projection preserves rights classification and drops PII biometric and provider metadata")
    void testTypedLedgerProjectionDisclosureBoundary() {
        long now = System.currentTimeMillis();
        String sourceToken = "https://source.invalid/media?X-Amz-Credential=tenant-secret&token=source-secret";
        Map<String, String> params = new java.util.HashMap<>();
        params.put("classification", "BIOMETRIC");
        params.put("rightsRef", "rights:consent-42");
        params.put("purpose", "voiceprint of Alice Example");
        params.put("language", "person@example.com");
        params.put("format", "https://private.invalid/source?token=abc");
        params.put("frameCount", "999999999999999999999");

        RunLedger ledger = AudioVideoRunLedgerAdapter.fromProcessingJob(
                "job-typed", "VIDEO", "VISION_ANALYSIS", "collection-1", sourceToken,
                params, "PROCESSING", now, now, null, null, "provider@example.com",
                "provider-account-voiceprint-123", "trace", "correlation");

        assertThat(ledger.inputs().parameters())
                .containsEntry("classification", "BIOMETRIC")
                .containsEntry("rightsRef", "rights:consent-42")
                .containsEntry("sanitizedParamsDropped", "4")
                .doesNotContainKeys("purpose", "language", "format", "frameCount");
        assertThat(ledger.attributes()).doesNotContainKey("provider");
        assertThat(ledger.attributes().get("mediaArtifactId")).startsWith("redacted:sha256:");
        assertThat(ledger.toString()).doesNotContain(
                "Alice Example", "person@example.com", "private.invalid", "token=abc",
                "provider@example.com", "provider-account-voiceprint-123", sourceToken,
                "source.invalid", "tenant-secret", "source-secret");
        assertThat(ledger.attributes().get("providerJobIdRef")).startsWith("sha256:");

        String signedObjectUri = "s3://private-bucket/source?X-Amz-Signature=object-secret";
        RunLedger provider = AudioVideoRunLedgerAdapter.fromProviderJobStatus(
                "job-provider-typed", signedObjectUri, "provider-name", "provider-secret-id",
                "PROCESSING", Map.of(
                        "mediaType", "VIDEO", "processingType", "STT",
                        "duration", "120", "words_processed", "5000",
                        "biometric_confidence", "0.998", "face_embedding", "1234",
                        "person@example.com", "789"),
                now - 10_000, now - 9_000, "trace", "correlation");

        assertThat(provider.outputs()).isNull();
        assertThat(provider.attributes().get("mediaArtifactId")).startsWith("redacted:sha256:");
        assertThat(provider.toString()).doesNotContain(
                "provider-secret-id", "biometric_confidence", "face_embedding", "person@example.com",
                signedObjectUri, "private-bucket", "X-Amz-Signature", "object-secret");
    }

    @Test
    @DisplayName("Untrusted media type metadata is reduced to bounded typed tokens")
    void testMediaTypeMetadataDisclosureAndBounds() {
        long now = System.currentTimeMillis();
        String privateEmail = "subject@example.invalid";
        String privateCollection = "private-collection@example.invalid";
        String oversizedType = "VIDEO" + "x".repeat(300);

        RunLedger ledger = AudioVideoRunLedgerAdapter.fromProcessingJob(
                "job-safe-metadata", privateEmail, oversizedType, privateCollection, "source",
                Map.of("classification", "BIOMETRIC", "rightsRef", "rights:consent-42"),
                "PROCESSING", now, now, null, null, "provider", "provider-secret-id", "trace", "correlation");

        assertThat(ledger.inputs().headers())
                .containsEntry("mediaType", "UNKNOWN")
                .containsEntry("processingType", "UNKNOWN");
        assertThat(ledger.attributes())
                .containsEntry("mediaType", "UNKNOWN")
                .containsEntry("processingType", "UNKNOWN")
                .containsKey("providerJobIdRef");
        assertThat(ledger.attributes().get("collectionId")).startsWith("redacted:sha256:");
        assertThat(ledger.inputs().parameters())
                .containsEntry("classification", "BIOMETRIC")
                .containsEntry("rightsRef", "rights:consent-42");
        assertThat(ledger.attributes().get("providerJobIdRef"))
                .startsWith("sha256:")
                .hasSize(19);
        assertThat(ledger.toString()).doesNotContain(
                privateEmail, privateCollection, oversizedType, "provider-secret-id");
        assertThat(ledger.toString().length()).isLessThanOrEqualTo(4_096);
    }

    @Test
    @DisplayName("Oversized provider job identifiers are rejected before fingerprinting")
    void testOversizedProviderJobIdentifierIsBounded() {
        long now = System.currentTimeMillis();
        String privateProviderId = "provider-private-" + "x".repeat(10_000);

        RunLedger ledger = AudioVideoRunLedgerAdapter.fromProviderJobStatus(
                "job-provider-ref", "source-artifact", "provider", privateProviderId,
                "PROCESSING", Map.of(
                        "duration", "120",
                        "words_processed", "5000",
                        "biometric_confidence", "0.998",
                        "private_metric", "subject@example.invalid"),
                now, now, "trace", "correlation");

        assertThat(ledger.attributes()).containsEntry("providerJobIdRef", "redacted:oversized");
        assertThat(ledger.inputs().headers()).containsEntry("providerJobIdRef", "redacted:oversized");
        assertThat(ledger.outputs()).isNull();
        assertThat(ledger.toString()).doesNotContain(privateProviderId,
                "biometric_confidence", "private_metric", "subject@example.invalid");
        assertThat(ledger.toString().length()).isLessThanOrEqualTo(4_096);
    }

    @Test
    @DisplayName("Measures bounded seeded 10k adapter projections and keeps sensitive values out of ledger output")
    void testSeededTenThousandRecordProjectionMeasurement() {
        final int recordCount = 10_000;
        final long seed = 0x4c443035L;
        final long baseTimeMs = 1_700_000_000_000L;
        final String[] sourceStates = {"SUBMITTED", "PROCESSING", "COMPLETED", "FAILED"};
        final JobExecutionState[] expectedStates = {
                JobExecutionState.PENDING, JobExecutionState.RUNNING,
                JobExecutionState.COMPLETED, JobExecutionState.COMPLETED
        };
        final ExecutionOutcome[] expectedOutcomes = {
                null, null, ExecutionOutcome.SUCCEEDED, ExecutionOutcome.FAILED
        };
        Random seeded = new Random(seed);
        long[] elapsedNanos = new long[recordCount];
        int maxSerializedChars = 0;

        for (int i = 0; i < recordCount; i++) {
            int stateIndex = i % sourceStates.length;
            String sourceToken = "https://media.invalid/source?token=seeded-secret-" + i;
            String privateEmail = "person-" + i + "@example.invalid";
            String providerJobId = "provider-private-account-job-" + i;
            int bitrate = 64_000 + seeded.nextInt(128_001);
            long createdAtMs = baseTimeMs + i;
            String outputId = stateIndex >= 2 ? "output-" + i : null;

            long startedNanos = System.nanoTime();
            RunLedger ledger = AudioVideoRunLedgerAdapter.fromProcessingJob(
                    "ld05-job-" + i, "AUDIO", "STT", "ld05-collection", "ld05-source-" + i,
                    Map.of("bitrate", String.valueOf(bitrate), "codec", "aac",
                            "sourceToken", sourceToken, "purpose", privateEmail),
                    sourceStates[stateIndex], createdAtMs, createdAtMs + 1,
                    outputId, stateIndex == 3 ? "voiceprint subject@example.invalid" : null,
                    "whisper", providerJobId, "ld05-trace", "ld05-correlation");
            elapsedNanos[i] = System.nanoTime() - startedNanos;

            assertThat(ledger.state()).isEqualTo(expectedStates[stateIndex]);
            assertThat(ledger.outcome()).isEqualTo(expectedOutcomes[stateIndex]);
            assertThat(ledger.attributes()).containsEntry("jobState", sourceStates[stateIndex]);
            assertThat(ledger.inputs().parameters())
                    .containsEntry("bitrate", String.valueOf(bitrate))
                    .containsEntry("codec", "aac")
                    .containsEntry("sanitizedParamsDropped", "2")
                    .doesNotContainKeys("sourceToken", "purpose");
            assertThat(ledger.inputs().parameters()).hasSizeLessThanOrEqualTo(3);
            assertThat(ledger.attributes().size()).isLessThanOrEqualTo(10);
            assertThat(ledger.attributes().get("providerJobIdRef")).startsWith("sha256:");
            String serialized = ledger.toString();
            maxSerializedChars = Math.max(maxSerializedChars, serialized.length());
            assertThat(serialized).doesNotContain(sourceToken, privateEmail, providerJobId,
                    "voiceprint subject", "example.invalid");
            assertThat(serialized.length()).isLessThanOrEqualTo(4_096);
        }

        Arrays.sort(elapsedNanos);
        long p50Micros = elapsedNanos[(recordCount - 1) / 2] / 1_000;
        long p95Micros = elapsedNanos[(int) Math.ceil(recordCount * 0.95) - 1] / 1_000;
        System.out.printf("LD-05 seeded adapter projection: records=%d seed=%d p50=%d us p95=%d us maxSerializedChars=%d%n",
                recordCount, seed, p50Micros, p95Micros, maxSerializedChars);
    }
}
