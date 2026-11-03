/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** Keeps the local source inventory separate from Action Plane admission authority. */
class AudioVideoCapabilityInventoryTest {

    private static final String DATACLOUD_TOOL_ID = "datacloud.media.artifacts";

    @Test
    void fourImplementedHandlersAreSupportedLocallyButRemainNotAdmitted() throws IOException {
        String inventory = loadInventory();
        AudioVideoToolHandlerFactory factory = new AudioVideoToolHandlerFactory();
        Map<String, String> handlers = Map.of(
                AudioVideoToolHandlerFactory.TOOL_ID_STT, SpeechToTextToolHandler.class.getName(),
                AudioVideoToolHandlerFactory.TOOL_ID_TTS, TextToSpeechToolHandler.class.getName(),
                AudioVideoToolHandlerFactory.TOOL_ID_VISION, VisionAnalysisToolHandler.class.getName(),
                AudioVideoToolHandlerFactory.TOOL_ID_MULTIMODAL, MultimodalInferenceToolHandler.class.getName());

        assertThat(factory.toolIds()).containsExactlyInAnyOrderElementsOf(handlers.keySet());
        assertThat(inventory).doesNotContain("enabled:", "dataCloudRoutes:", "permissions:");
        for (Map.Entry<String, String> entry : handlers.entrySet()) {
            String block = entryBlock(inventory, entry.getKey());
            assertThat(block)
                    .contains("handlerClass: \"" + entry.getValue() + "\"")
                    .contains("status: SUPPORTED")
                    .contains("admission: NOT_ADMITTED");
        }
    }

    @Test
    void datacloudInventoryEntryDoesNotClaimAnUnpublishedHandlerOrPermission() throws IOException {
        String inventory = loadInventory();
        String block = entryBlock(inventory, DATACLOUD_TOOL_ID);

        assertThat(new AudioVideoToolHandlerFactory().toolIds()).doesNotContain(DATACLOUD_TOOL_ID);
        assertThat(block)
                .contains("status: NOT_ADMITTED")
                .doesNotContain("handlerClass:", "descriptorPath:", "permissions:", "dataCloudRoutes:");
    }

    private static String entryBlock(String inventory, String toolId) {
        String marker = "  - toolId: \"" + toolId + "\"";
        int start = inventory.indexOf(marker);
        if (start < 0) throw new AssertionError("Missing local capability inventory entry for " + toolId);
        int end = inventory.indexOf("\n  - toolId: ", start + marker.length());
        return inventory.substring(start, end < 0 ? inventory.length() : end);
    }

    private static String loadInventory() throws IOException {
        try (InputStream stream = AudioVideoCapabilityInventoryTest.class.getClassLoader()
                .getResourceAsStream("capabilities/audio-video-common.yaml")) {
            if (stream == null) throw new AssertionError("Missing Media capability inventory resource");
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
}
