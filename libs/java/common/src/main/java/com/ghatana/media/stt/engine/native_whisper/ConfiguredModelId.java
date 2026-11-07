package com.ghatana.media.stt.engine.native_whisper;

/** Package-local validation for adapters whose configured model is already loaded. */
final class ConfiguredModelId {
    private ConfiguredModelId() { }

    static void require(String requestedId, String configuredId) {
        com.ghatana.media.common.ConfiguredModelId.require(requestedId, configuredId);
    }
}
