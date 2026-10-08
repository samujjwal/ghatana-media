/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.multimodal.agents;

import com.ghatana.agent.AgentDescriptor;
import com.ghatana.agent.AgentResult;
import com.ghatana.agent.AgentType;
import com.ghatana.agent.framework.api.AgentContext;
import com.ghatana.agent.runtime.turn.AbstractTypedAgent;
import com.ghatana.core.async.AsyncOperation;
import com.ghatana.agent.framework.tools.ToolActionClass;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionStatus;
import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolContractBuilder;
import com.ghatana.toolruntime.ToolExecutor;
import com.ghatana.audio.video.tools.MultimodalInferenceToolHandler;
import com.ghatana.audio.video.tools.SpeechToTextToolHandler;
import com.ghatana.audio.video.tools.VisionAnalysisToolHandler;
import io.activej.promise.Promise;
import org.jetbrains.annotations.NotNull;

import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;

/**
 * COMPOSITE agent that performs cross-modal analysis by fan-out to:
 * <ol>
 *   <li>Vision analysis (when analysis types are requested)</li>
 *   <li>Multimodal inference (always)</li>
 *   <li>Audio transcription (when {@code enableTranscription} is true)</li>
 * </ol>
 *
 * <p>Results from all three passes are aggregated into a single
 * {@link MultimodalAnalysisResult}. Processing is sequential (each tool call
 * is chained via promise composition) to avoid overwhelming downstream services.
 *
 * @doc.type class
 * @doc.purpose COMPOSITE typed agent for multimodal analysis via fan-out tool execution
 * @doc.layer product
 * @doc.pattern Agent
 */
public final class MultimodalAnalysisAgent
        extends AbstractTypedAgent<MultimodalAnalysisRequest, MultimodalAnalysisResult> {

    public static final String AGENT_ID = "av.multimodal-analysis";
    private static final String VERSION = "0.0.1";

    private final ToolExecutor toolExecutor;

    /** Creates an agent with governed tool executor. */
    public MultimodalAnalysisAgent(ToolExecutor toolExecutor) {
        this.toolExecutor = Objects.requireNonNull(toolExecutor, "toolExecutor must not be null");
    }

    @Override
    public AgentDescriptor descriptor() {
        return AgentDescriptor.builder()
                .agentId(AGENT_ID)
                .name("Multimodal Analysis Agent")
                .version(VERSION)
                .type(AgentType.COMPOSITE)
                .description("Fan-out cross-modal analysis: vision + inference + optional STT.")
                .build();
    }

    @Override
    protected AsyncOperation<AgentResult<MultimodalAnalysisResult>> doProcess(
            @NotNull AgentContext ctx,
            @NotNull MultimodalAnalysisRequest input) {

        Instant start = Instant.now();
        String tenantId = ctx.getTenantId();

        // Step 1 — run vision analysis if any types requested
        Promise<Map<String, Object>> visionPromise = runVision(input, tenantId);

        // Step 2 — chain: after vision, run multimodal inference
        Promise<AgentResult<MultimodalAnalysisResult>> resultPromise = visionPromise.then(visionOutput ->
                runInference(input, tenantId).then(inferenceOutput ->

                // Step 3 — optionally chain: audio transcription
                runTranscription(input, tenantId).map(transcription -> {
                    Duration elapsed = Duration.between(start, Instant.now());
                    MultimodalAnalysisResult result = MultimodalAnalysisResult.fromToolOutputs(
                            inferenceOutput, visionOutput, transcription);
                    return AgentResult.success(result, AGENT_ID, elapsed);
                })
        ));
        CompletableFuture<AgentResult<MultimodalAnalysisResult>> future = new CompletableFuture<>();
        resultPromise.whenComplete((value, error) -> {
            if (error == null) future.complete(value);
            else future.completeExceptionally(error);
        });
        return AsyncOperation.from(future);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Private helpers
    // ──────────────────────────────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    private Promise<Map<String, Object>> runVision(MultimodalAnalysisRequest input, String tenantId) {
        List<String> types = input.analysisTypes();
        if (types == null || types.isEmpty()) {
            return Promise.of(Map.of());
        }
        Map<String, Object> visionInput = new HashMap<>();
        visionInput.put("mediaSource", Map.of("mediaArtifactId", input.mediaArtifactId()));
        visionInput.put("analysisTypes", types);

        ToolExecutionEnvelope envelope = ToolExecutionEnvelope.of(
                VisionAnalysisToolHandler.TOOL_ID, "1.0.0", AGENT_ID, VERSION,
                tenantId, ToolActionClass.CALL_EXTERNAL, "1.0", visionInput);

        return toolExecutor.execute(envelope, visionContract()).map(res -> {
            if (res.status() == ToolExecutionStatus.SUCCESS) {
                return (Map<String, Object>) res.output();
            }
            log.warn("Vision pass failed: {}", res.errorMessage());
            return Map.of();
        });
    }

    @SuppressWarnings("unchecked")
    private Promise<Map<String, Object>> runInference(MultimodalAnalysisRequest input, String tenantId) {
        Map<String, Object> inferenceInput = new HashMap<>();
        inferenceInput.put("mediaArtifactId", input.mediaArtifactId());
        if (input.inferenceMode() != null) inferenceInput.put("inferenceMode", input.inferenceMode());
        if (input.languageCode() != null) inferenceInput.put("languageCode", input.languageCode());
        inferenceInput.put("enableTranscription", input.enableTranscription());

        ToolExecutionEnvelope envelope = ToolExecutionEnvelope.of(
                MultimodalInferenceToolHandler.TOOL_ID, "1.0.0", AGENT_ID, VERSION,
                tenantId, ToolActionClass.CALL_EXTERNAL, "1.0", inferenceInput);

        return toolExecutor.execute(envelope, inferenceContract()).map(res -> {
            if (res.status() == ToolExecutionStatus.SUCCESS) {
                return (Map<String, Object>) res.output();
            }
            log.warn("Multimodal inference failed: {}", res.errorMessage());
            return Map.of();
        });
    }

    private Promise<AudioTranscriptionResult> runTranscription(
            MultimodalAnalysisRequest input, String tenantId) {
        if (!input.enableTranscription()) {
            return Promise.of(null);
        }
        AudioTranscriptionRequest sttRequest = AudioTranscriptionRequest.fromSource(
                input.mediaArtifactId(), input.languageCode());

        ToolExecutionEnvelope envelope = ToolExecutionEnvelope.of(
                SpeechToTextToolHandler.TOOL_ID, "1.0.0", AGENT_ID, VERSION,
                tenantId, ToolActionClass.CALL_EXTERNAL, "1.0", sttRequest.toToolInput());

        return toolExecutor.execute(envelope, sttContract()).map(res -> {
            if (res.status() == ToolExecutionStatus.SUCCESS) {
                @SuppressWarnings("unchecked")
                var output = (Map<String, Object>) res.output();
                return AudioTranscriptionResult.fromToolOutput(output);
            }
            log.warn("Transcription pass failed: {}", res.errorMessage());
            return null;
        });
    }

    private static ToolContract visionContract() {
        return new ToolContractBuilder()
                .toolId(VisionAnalysisToolHandler.TOOL_ID)
                .toolVersion("1.0.0")
                .name("Vision Analysis")
                .actionClass(ToolActionClass.CALL_EXTERNAL)
                .build();
    }

    private static ToolContract inferenceContract() {
        return new ToolContractBuilder()
                .toolId(MultimodalInferenceToolHandler.TOOL_ID)
                .toolVersion("1.0.0")
                .name("Multimodal Inference")
                .actionClass(ToolActionClass.CALL_EXTERNAL)
                .build();
    }

    private static ToolContract sttContract() {
        return new ToolContractBuilder()
                .toolId(SpeechToTextToolHandler.TOOL_ID)
                .toolVersion("1.0.0")
                .name("Speech-to-Text")
                .actionClass(ToolActionClass.CALL_EXTERNAL)
                .build();
    }
}
