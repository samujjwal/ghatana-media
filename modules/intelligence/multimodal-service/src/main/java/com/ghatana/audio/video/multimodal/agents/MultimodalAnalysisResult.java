/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.multimodal.agents;

import java.util.List;
import java.util.Map;

/**
 * Composite output of {@link MultimodalAnalysisAgent}, aggregating results
 * from vision analysis and multimodal inference.
 *
 * @doc.type class
 * @doc.purpose Output record for MultimodalAnalysisAgent
 * @doc.layer product
 * @doc.pattern DTO
 */
public record MultimodalAnalysisResult(
        /** High-level summary from multimodal inference. */
        String summary,
        /** Confidence score from multimodal inference (0.0–1.0). */
        double confidence,
        /** Vision analysis results keyed by analysis type (objects, scenes, etc.). */
        Map<String, Object> visionResults,
        /** Audio transcription, present when {@code enableTranscription} was true. */
        String transcript,
        /** Timed segments from audio transcription. */
        List<Map<String, Object>> transcriptSegments,
        /** Raw processing metadata from the inference tool. */
        Map<String, Object> processingMetadata
) {
    @SuppressWarnings("unchecked")
    public static MultimodalAnalysisResult fromToolOutputs(
            Map<String, Object> inferenceOutput,
            Map<String, Object> visionOutput,
            AudioTranscriptionResult transcription) {

        String summary = (String) inferenceOutput.getOrDefault("summary", "");
        double confidence = inferenceOutput.containsKey("confidence")
                ? ((Number) inferenceOutput.get("confidence")).doubleValue() : 0.0;
        Map<String, Object> processingMeta = inferenceOutput.containsKey("processingMetadata")
                ? (Map<String, Object>) inferenceOutput.get("processingMetadata") : Map.of();

        String transcript = transcription != null ? transcription.transcript() : null;
        List<Map<String, Object>> segments = transcription != null ? transcription.segments() : List.of();

        return new MultimodalAnalysisResult(
                summary, confidence,
                visionOutput != null ? visionOutput : Map.of(),
                transcript, segments,
                processingMeta);
    }
}
