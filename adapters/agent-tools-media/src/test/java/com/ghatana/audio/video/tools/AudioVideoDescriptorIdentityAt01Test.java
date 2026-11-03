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

/** Guards AT-01 identity consistency between the local inventory and descriptors. */
class AudioVideoDescriptorIdentityAt01Test {

    private static final Map<String, String> HANDLER_DESCRIPTORS = Map.of(
            AudioVideoToolHandlerFactory.TOOL_ID_STT, "speech-to-text.yaml",
            AudioVideoToolHandlerFactory.TOOL_ID_TTS, "text-to-speech.yaml",
            AudioVideoToolHandlerFactory.TOOL_ID_VISION, "vision-analysis.yaml",
            AudioVideoToolHandlerFactory.TOOL_ID_MULTIMODAL, "multimodal-inference.yaml");

    @Test
    void eachSupportedInventoryIdMatchesItsDescriptorAndFactory() throws IOException {
        String inventory = resource("audio-video-common.yaml");
        assertThat(new AudioVideoToolHandlerFactory().toolIds())
                .containsExactlyInAnyOrderElementsOf(HANDLER_DESCRIPTORS.keySet());

        for (Map.Entry<String, String> descriptor : HANDLER_DESCRIPTORS.entrySet()) {
            String toolId = descriptor.getKey();
            String file = descriptor.getValue();
            String inventoryBlock = block(inventory, toolId);
            assertThat(inventoryBlock).contains("status: SUPPORTED", "admission: NOT_ADMITTED",
                    "descriptorPath: \"capabilities/" + file + "\"");
            assertThat(resource(file)).contains("toolId: \"" + toolId + "\"");
        }
    }

    @Test
    void dataCloudReadModelRemainsAnUnadmittedInventoryEntryWithoutHandlerDescriptor() throws IOException {
        String inventory = resource("audio-video-common.yaml");
        String entry = block(inventory, "datacloud.media.artifacts");

        assertThat(entry).contains("status: NOT_ADMITTED")
                .doesNotContain("handlerClass:", "descriptorPath:");
        assertThat(new AudioVideoToolHandlerFactory().toolIds())
                .doesNotContain("datacloud.media.artifacts");
    }

    private static String block(String inventory, String toolId) {
        String marker = "  - toolId: \"" + toolId + "\"";
        int start = inventory.indexOf(marker);
        if (start < 0) throw new AssertionError("Missing inventory entry: " + toolId);
        int end = inventory.indexOf("\n  - toolId: ", start + marker.length());
        return inventory.substring(start, end < 0 ? inventory.length() : end);
    }

    private static String resource(String name) throws IOException {
        String path = "capabilities/" + name;
        try (InputStream stream = AudioVideoDescriptorIdentityAt01Test.class.getClassLoader()
                .getResourceAsStream(path)) {
            if (stream == null) throw new AssertionError("Missing resource: " + path);
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
}
