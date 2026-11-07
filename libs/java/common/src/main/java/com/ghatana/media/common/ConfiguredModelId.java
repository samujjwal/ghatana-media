package com.ghatana.media.common;

/** Shared validation for adapters bound to one already-loaded model. */
public final class ConfiguredModelId {
    private ConfiguredModelId() { }

    /**
     * Require the requested model selector to match the model configured when
     * the engine was created. Adapters do not dynamically switch loaded models.
     */
    public static void require(String requestedId, String configuredId) {
        if (requestedId == null || requestedId.isBlank()) {
            throw new IllegalArgumentException("modelId must not be blank");
        }
        if (!requestedId.equals(configuredId)) {
            throw new UnsupportedOperationException("Model switching is not supported by this configured engine");
        }
    }
}
