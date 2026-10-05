/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.multimodal.agents;

import java.util.List;
import java.util.Map;

/**
 * Output of {@link AudioTranscriptionAgent}.
 *
 * @doc.type class
 * @doc.purpose Output record for AudioTranscriptionAgent
 * @doc.layer product
 * @doc.pattern DTO
 */
public record AudioTranscriptionResult(
        String transcript,
        List<Map<String, Object>> segments,
        double confidence,
        String languageDetected,
        String audioSource,
        boolean diarization
) {
    @SuppressWarnings("unchecked")
    public static AudioTranscriptionResult fromToolOutput(Map<String, Object> output) {
        String transcript = (String) output.getOrDefault("transcript", "");
        List<Map<String, Object>> segments = (List<Map<String, Object>>) output.getOrDefault("segments", List.of());
        double confidence = output.containsKey("confidence")
                ? ((Number) output.get("confidence")).doubleValue() : 0.0;
        String lang = (String) output.getOrDefault("languageDetected", "");
        String src = (String) output.getOrDefault("audioSource", "");
        boolean diarization = Boolean.TRUE.equals(output.get("diarization"));
        return new AudioTranscriptionResult(transcript, segments, confidence, lang, src, diarization);
    }
}
