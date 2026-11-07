package com.ghatana.media.stt.engine.onnx;

/** Package-local validation for adapters whose configured model is already loaded. */
final class ConfiguredModelId {
    private ConfiguredModelId() { }

    static void require(String requestedId, String configuredId) {
        if (requestedId == null || requestedId.isBlank()) {
            throw new IllegalArgumentException("modelId must not be blank");
        }
        if (!requestedId.equals(configuredId)) {
            throw new UnsupportedOperationException("Model switching is not supported by this configured engine");
        }
    }
}
