/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.multimodal.agents;

import java.util.Map;

/**
 * Input for {@link AudioTranscriptionAgent}.
 *
 * <p>Callers must supply exactly one of {@code audioSource} (a storage URI or
 * {@code mediaArtifactId}) or raw {@code audioBytes}. If both are provided,
 * {@code audioSource} takes precedence.
 *
 * @doc.type class
 * @doc.purpose Input record for AudioTranscriptionAgent
 * @doc.layer product
 * @doc.pattern DTO
 */
public record AudioTranscriptionRequest(
        /** Storage URI, artifact ID, or base-64 encoded audio bytes key. Either this or audioBytes is required. */
        String audioSource,
        /** Raw audio bytes (used when audioSource is absent and encoded for the tool envelope). */
        byte[] audioBytes,
        /** BCP-47 language code, e.g. "en-US". Null to auto-detect. */
        String languageCode,
        /** Whether to enable speaker diarization. */
        boolean enableDiarization,
        /** STT model variant hint, e.g. "enhanced". Null for default. */
        String model,
        /** Optional correlation ID for trace-based lookup. */
        String correlationId
) {
    /** Constructs a request from a media artifact ID or URI. */
    public static AudioTranscriptionRequest fromSource(String audioSource, String languageCode) {
        return new AudioTranscriptionRequest(audioSource, null, languageCode, false, null, null);
    }

    /** Constructs a request from raw audio bytes. */
    public static AudioTranscriptionRequest fromBytes(byte[] audioBytes, String languageCode) {
        return new AudioTranscriptionRequest(null, audioBytes, languageCode, false, null, null);
    }

    /** Converts this request to the flat {@code Map<String,Object>} expected by {@link com.ghatana.audio.video.tools.SpeechToTextToolHandler}. */
    public Map<String, Object> toToolInput() {
        var map = new java.util.HashMap<String, Object>();
        if (audioSource != null) {
            map.put("audioSource", Map.of("mediaArtifactId", audioSource));
        } else if (audioBytes != null) {
            map.put("audioSource", Map.of(
                    "audioBytes", java.util.Base64.getEncoder().encodeToString(audioBytes)));
        }
        if (languageCode != null) map.put("languageCode", languageCode);
        map.put("enableDiarization", enableDiarization);
        if (model != null) map.put("model", model);
        return Map.copyOf(map);
    }
}
