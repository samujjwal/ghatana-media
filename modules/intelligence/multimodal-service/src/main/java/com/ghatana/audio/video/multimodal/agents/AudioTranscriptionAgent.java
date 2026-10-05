/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.multimodal.agents;

import com.ghatana.agent.AgentDescriptor;
import com.ghatana.agent.AgentResult;
import com.ghatana.agent.AgentType;
import com.ghatana.agent.framework.api.AgentContext;
import com.ghatana.agent.framework.runtime.AbstractTypedAgent;
import com.ghatana.agent.framework.tools.ToolActionClass;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionStatus;
import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolContractBuilder;
import com.ghatana.toolruntime.ToolExecutor;
import com.ghatana.audio.video.tools.SpeechToTextToolHandler;
import io.activej.promise.Promise;
import org.jetbrains.annotations.NotNull;

import java.time.Duration;
import java.time.Instant;
import java.util.Objects;

/**
 * REACTIVE agent that transcribes audio content by delegating to the
 * {@value #AGENT_ID} speech-to-text tool.
 *
 * <p>This agent accepts either a media artifact identifier or raw audio bytes
 * as input and returns a structured {@link AudioTranscriptionResult}. It is
 * stateless and single-responsibility: it does no fusion, enrichment, or
 * orchestration — those concerns belong in {@link MultimodalAnalysisAgent}.
 *
 * @doc.type class
 * @doc.purpose REACTIVE typed agent for audio transcription via STT tool
 * @doc.layer product
 * @doc.pattern Agent
 */
public final class AudioTranscriptionAgent extends AbstractTypedAgent<AudioTranscriptionRequest, AudioTranscriptionResult> {

    public static final String AGENT_ID = "av.audio-transcription";
    private static final String VERSION = "0.0.1";

    private final ToolExecutor toolExecutor;

    /**
     * Creates an instance using the governed tool executor.
     */
    public AudioTranscriptionAgent(ToolExecutor toolExecutor) {
        this.toolExecutor = Objects.requireNonNull(toolExecutor, "toolExecutor must not be null");
    }

    /**
     * Creates an instance with the given tool executor (for testing).
     *
     * @param toolExecutor the governed tool executor; must not be null
     */

    @Override
    public AgentDescriptor descriptor() {
        return AgentDescriptor.builder()
                .agentId(AGENT_ID)
                .name("Audio Transcription Agent")
                .version(VERSION)
                .type(AgentType.REACTIVE)
                .description("Transcribes audio content using the STT platform tool.")
                .build();
    }

    @Override
    protected Promise<AgentResult<AudioTranscriptionResult>> doProcess(
            @NotNull AgentContext ctx,
            @NotNull AudioTranscriptionRequest input) {

        Instant start = Instant.now();

        ToolExecutionEnvelope envelope = ToolExecutionEnvelope.of(
                SpeechToTextToolHandler.TOOL_ID,
                "1.0.0",
                AGENT_ID,
                VERSION,
                ctx.getTenantId(),
                ToolActionClass.CALL_EXTERNAL,
                "1.0",
                input.toToolInput());

        return toolExecutor.execute(envelope, sttContract())
                .map(result -> {
                    Duration elapsed = Duration.between(start, Instant.now());
                    if (result.status() == ToolExecutionStatus.SUCCESS) {
                        @SuppressWarnings("unchecked")
                        var output = (java.util.Map<String, Object>) result.output();
                        AudioTranscriptionResult transcription = AudioTranscriptionResult.fromToolOutput(output);
                        return AgentResult.success(transcription, AGENT_ID, elapsed);
                    }
                    String errorMsg = result.errorMessage() != null ? result.errorMessage() : "STT tool returned no output";
                    log.warn("STT tool failed for agent [{}]: {}", AGENT_ID, errorMsg);
                    return AgentResult.failure(new RuntimeException(errorMsg), AGENT_ID, elapsed);
                });
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
