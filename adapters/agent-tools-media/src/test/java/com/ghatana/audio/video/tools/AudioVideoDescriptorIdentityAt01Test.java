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

    @Test
    void multimodalDescriptorMatchesCanonicalCrossModalInputAndResultContract() throws IOException {
        String descriptor = resource("multimodal-inference.yaml");
        String rejectedBeforeDispatch = resultBranch(descriptor, "REJECTED_PRE_DISPATCH");
        String accepted = resultBranch(descriptor, "ACCEPTED");
        String unknown = resultBranch(descriptor, "OUTCOME_UNKNOWN");
        String failed = resultBranch(descriptor, "FAILED");
        String succeeded = resultBranch(descriptor, "SUCCEEDED");

        assertThat(descriptor)
                .contains("one exact immutable media artifact version",
                        "inputSchema:\n  $schema: https://json-schema.org/draft/2020-12/schema",
                        "required:\n    - input1\n    - input2",
                        "const: authorized-media-artifacts",
                        "format: opaque-version-id",
                        "const: analysis-request",
                        "required:\n            - dimensions\n            - criteria",
                        "required:\n                - subjectRefs\n                - analysisMethodRef\n                - profileRef\n                - configurationDigest\n                - purposeRef",
                        "configurationDigest:",
                        "pattern: ^sha256:[a-f0-9]{64}$",
                        "outputSchema:\n  $schema: https://json-schema.org/draft/2020-12/schema",
                        "const: media.operation.capability.media-multimodal-analyze-cross-modal",
                        "const: source-grounded-cross-modal-result-with-provenance-and-uncertainty")
                .doesNotContain("mediaArtifactId", "sourceArtifactVersion", "inferenceMode", "samplingRateMs",
                        "enableTranscription", "enableVisionAnalysis", "languageCode", "default:",
                        "summary:", "segments:", "confidence:");

        assertThat(rejectedBeforeDispatch).doesNotContain("outputs:", "canonicalResult:");
        assertThat(accepted).contains("requestId:", "requestFingerprint:", "statusQueryRef:")
                .doesNotContain("outputs:", "canonicalResult:");
        assertThat(unknown).contains("requestFingerprint:", "identityDisposition:")
                .doesNotContain("outputs:", "canonicalResult:");
        assertThat(failed).contains("const: REJECTED", "outputs:", "maxItems: 0");
        assertThat(succeeded).contains("minItems: 1", "maxItems: 1",
                "const: source-grounded-cross-modal-result-with-provenance-and-uncertainty", "provenance:");
    }

    private static String resultBranch(String descriptor, String outcome) {
        String resultSchema = descriptor.substring(descriptor.indexOf("outputSchema:\n"));
        String marker = "        outcome:\n          const: " + outcome;
        int start = resultSchema.indexOf(marker);
        if (start < 0) throw new AssertionError("Missing result outcome branch: " + outcome);
        int end = resultSchema.indexOf("\n    - type: object", start + marker.length());
        if (end < 0) end = resultSchema.indexOf("\npolicyTags:", start);
        return resultSchema.substring(start, end < 0 ? resultSchema.length() : end);
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
