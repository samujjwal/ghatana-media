/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.multimodal.agents;

import java.util.List;

/**
 * Input for {@link MultimodalAnalysisAgent}.
 *
 * @doc.type class
 * @doc.purpose Input record for MultimodalAnalysisAgent
 * @doc.layer product
 * @doc.pattern DTO
 */
public record MultimodalAnalysisRequest(
        /** ID of the media artifact stored in Data Cloud. Required. */
        String mediaArtifactId,
        /** Visual analysis types to run, e.g. "objects", "scenes". Null means no vision pass. */
        List<String> analysisTypes,
        /** Inference mode: "FULL", "SUMMARY", "HIGHLIGHTS". Null defaults to "FULL". */
        String inferenceMode,
        /** Whether to transcribe audio as part of analysis. */
        boolean enableTranscription,
        /** BCP-47 language code for STT. Null means auto-detect. */
        String languageCode,
        /** Optional correlation ID. */
        String correlationId
) {
    /** Minimal request: artifact ID only, full inference, no transcription. */
    public static MultimodalAnalysisRequest forArtifact(String mediaArtifactId) {
        return new MultimodalAnalysisRequest(mediaArtifactId, List.of(), "FULL", false, null, null);
    }
}
