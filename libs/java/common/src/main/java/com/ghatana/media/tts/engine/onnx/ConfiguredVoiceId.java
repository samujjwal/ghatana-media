package com.ghatana.media.tts.engine.onnx;

/** Package-local validation for adapters whose configured voice is already loaded. */
final class ConfiguredVoiceId {
    private ConfiguredVoiceId() { }

    static void require(String requestedId, String configuredId) {
        if (requestedId == null || requestedId.isBlank()) {
            throw new IllegalArgumentException("voiceId must not be blank");
        }
        if (!requestedId.equals(configuredId)) {
            throw new IllegalArgumentException("Voice is not configured for this engine");
        }
    }
}
