/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audiovideo.adapter.ledger;

import com.ghatana.core.lifecycle.ExecutionOutcome;
import com.ghatana.core.lifecycle.JobExecutionState;
import com.ghatana.workflow.ledger.*;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Map;

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
        assertThat(ledger.attributes().get("providerJobId")).isEqualTo("azure-job-999");
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
    }

    @Test
    @DisplayName("Maps provider state vocabulary variants correctly")
    void testProviderStateVariants() {
        long now = System.currentTimeMillis();

        RunLedger pending = AudioVideoRunLedgerAdapter.fromProviderJobStatus(
            "j1", "a1", "provider", "p1", "PENDING", Map.of(), now, 0, "t", "c");
        RunLedger inProgress = AudioVideoRunLedgerAdapter.fromProviderJobStatus(
            "j2", "a2", "provider", "p2", "IN_PROGRESS", Map.of(), now, now, "t", "c");
        RunLedger finished = AudioVideoRunLedgerAdapter.fromProviderJobStatus(
            "j3", "a3", "provider", "p3", "FINISHED", Map.of(), now, now, "t", "c");
        RunLedger error = AudioVideoRunLedgerAdapter.fromProviderJobStatus(
            "j4", "a4", "provider", "p4", "ERROR", Map.of(), now, now, "t", "c");

        assertThat(pending.state()).isEqualTo(JobExecutionState.PENDING);
        assertThat(inProgress.state()).isEqualTo(JobExecutionState.RUNNING);
        assertThat(finished.state()).isEqualTo(JobExecutionState.COMPLETED);
        assertThat(error.state()).isEqualTo(JobExecutionState.COMPLETED);
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
            "ERROR",
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

        assertThat(ledger.state()).isEqualTo(JobExecutionState.COMPLETED);
        assertThat(ledger.outcome()).isEqualTo(ExecutionOutcome.FAILED);
        assertThat(ledger.outputs()).isNotNull();
        assertThat(ledger.policyCheckpointId()).isEqualTo("av-provider-tenant-policy");
        assertThat(ledger.policyDecision()).isPresent();
        assertThat(ledger.policyDecision().orElseThrow().allowed()).isFalse();
        assertThat(ledger.policyDecision().orElseThrow().reason())
            .isEqualTo("Provider disabled for tenant");
        assertThat(ledger.requiresBlockingAudit()).isFalse();
        assertThat(ledger.attributes()).containsEntry("policyAllowed", "false");
    }
}
